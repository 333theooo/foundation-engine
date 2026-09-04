import { z } from 'zod';
import { apiError, route } from '@/server/api';
import { prisma } from '@/server/db';
import { getProject, saveProjectModel } from '@/server/projects';
import { retrieveKnowledge } from '@/knowledge';
import { runTurn } from '@/ai/orchestrator';
import type { AiStreamEvent } from '@/ai/types';
import { serverEnv } from '@/server/env';
import type { ProjectModel } from '@/domain/project/schema';
import type { SessionUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The conversational modelling endpoint.
 *
 * Streams newline-delimited JSON. NDJSON rather than SSE because the client is
 * a `fetch` reader, not an `EventSource` — SSE's reconnection semantics buy
 * nothing here and its framing costs bytes on every event.
 *
 * Ordering guarantee the UI relies on: an `applied` event always precedes
 * `done`, and the model it carries is the model that was persisted. The save
 * happens before `done` is emitted, so a client that sees `done` knows the
 * change survived.
 *
 * Cancellation: the request's abort signal is threaded through to the provider,
 * so closing the tab or hitting Stop ends the upstream call rather than leaving
 * it running and billing.
 */

const schema = z.object({
  message: z.string().min(1).max(8_000),
  selectionIds: z.array(z.string().max(64)).max(200).default([]),
  /** Client's current revision, to detect a stale tab before spending tokens. */
  baseRevision: z.number().int().min(0).optional(),
});

function encodeEvent(event: AiStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export const POST = route<{ projectId: string }>(
  async ({ request, params, user, log }) => {
    const input = schema.parse(await request.json());
    const record = await getProject(user, params.projectId);

    if (input.baseRevision !== undefined && record.model.revision !== input.baseRevision) {
      return apiError(
        'This project changed since your last message. Reload to pick up the latest version before continuing.',
        409,
        { serverRevision: record.model.revision },
      );
    }

    const conversation = await ensureConversation(params.projectId);
    const history = await loadHistory(conversation.id);
    const knowledge = await retrieveKnowledge(user, input.message, {
      projectId: params.projectId,
      limit: 4,
    }).catch((error) => {
      log.warn({ err: String(error) }, 'knowledge retrieval failed; continuing without it');
      return [];
    });

    const userMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: input.message,
        metadata: { selectionIds: input.selectionIds },
      },
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const emit = (event: AiStreamEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encodeEvent(event));
          } catch {
            closed = true;
          }
        };

        try {
          const outcome = await runTurn(
            {
              model: record.model,
              message: input.message,
              history,
              selectionIds: input.selectionIds,
              knowledge,
              preferences: describePreferences(user, record.model),
              ...(request.signal ? { signal: request.signal } : {}),
            },
            emit,
          );

          // Persist before signalling completion, so a client that sees the
          // final event knows the change is durable.
          let operationId: string | null = null;
          if (outcome.status === 'applied') {
            await saveProjectModel(user, params.projectId, outcome.model, {
              versionLabel: outcome.summary.slice(0, 110) || 'AI operation',
              versionKind: 'AUTOSAVE',
            });
          }

          const assistantMessage = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: 'ASSISTANT',
              content: outcome.summary,
              metadata: {
                status: outcome.status,
                provider: outcome.provider,
                model: outcome.providerModel,
                usage: { ...outcome.usage },
                focusIds: outcome.sceneSummaryForLog.focusIds,
                citations: knowledge.map((citation) => ({
                  documentId: citation.documentId,
                  title: citation.title,
                  score: citation.score,
                })),
              },
            },
          });

          const operation = await prisma.operation.create({
            data: {
              projectId: params.projectId,
              messageId: assistantMessage.id,
              transactionId: outcome.transactionId ?? 'none',
              status:
                outcome.status === 'applied'
                  ? 'APPLIED'
                  : outcome.status === 'clarification'
                    ? 'CLARIFICATION'
                    : outcome.status === 'rejected'
                      ? 'REJECTED'
                      : 'ROLLED_BACK',
              request: input.message,
              sceneSummary: { ...outcome.sceneSummaryForLog },
              commands: outcome.commands as object,
              inverse: outcome.inverse as object,
              issues: outcome.issues as object,
              findings: outcome.findings as object,
              summary: outcome.summary.slice(0, 4_000),
              provider: outcome.provider,
              model: outcome.providerModel,
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              durationMs: outcome.durationMs,
            },
          });
          operationId = operation.id;

          emit({
            type: 'done',
            operationId,
            summary: outcome.summary,
            usage: outcome.usage,
            provider: outcome.provider,
            model: outcome.providerModel,
            durationMs: outcome.durationMs,
          });

          log.info(
            {
              projectId: params.projectId,
              status: outcome.status,
              provider: outcome.provider,
              commands: outcome.commands.length,
              durationMs: outcome.durationMs,
            },
            'ai turn complete',
          );
        } catch (error) {
          // The turn failed after the user message was written. Record that so
          // a refresh shows the attempt rather than a silent gap.
          const message =
            error instanceof Error ? error.message : 'The request could not be completed.';
          log.error({ err: message, messageId: userMessage.id }, 'chat stream failed');
          emit({ type: 'error', message, recoverable: true });
          emit({
            type: 'done',
            operationId: null,
            summary: message,
            usage: { inputTokens: 0, outputTokens: 0 },
            provider: 'unknown',
            model: '',
            durationMs: 0,
          });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by the client disconnecting.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  },
  { rateLimit: 'ai' },
);

async function ensureConversation(projectId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  return existing ?? prisma.conversation.create({ data: { projectId } });
}

async function loadHistory(conversationId: string) {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: { in: ['USER', 'ASSISTANT'] } },
    orderBy: { createdAt: 'desc' },
    take: 24,
    select: { role: true, content: true },
  });
  return rows
    .reverse()
    .map((row) => ({
      role: row.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }))
    .filter((turn) => turn.content.trim().length > 0);
}

/**
 * The stable preference block. Kept short and factual — it is prepended to
 * every turn, so anything vague here is a recurring tax on the context window.
 */
function describePreferences(user: SessionUser, model: ProjectModel): string {
  const settings = user.settings as {
    units?: string;
    defaults?: Record<string, unknown>;
    houseRules?: string;
  };
  const lines = [
    `Display units: ${settings.units ?? model.units}.`,
    `AI provider: ${serverEnv().AI_PROVIDER}.`,
  ];
  if (settings.defaults && Object.keys(settings.defaults).length > 0) {
    lines.push(`Preferred defaults: ${JSON.stringify(settings.defaults)}.`);
  }
  if (settings.houseRules) {
    lines.push(`House rules the user has set: ${String(settings.houseRules).slice(0, 600)}`);
  }
  return lines.join('\n');
}

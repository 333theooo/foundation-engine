import { parseCommands } from '@/domain/commands/errors';
import { applyTransaction } from '@/domain/commands/transaction';
import { MAX_ELEMENTS_PER_TURN } from '@/domain/project/limits';
import type { ProjectModel } from '@/domain/project/schema';
import { getCatalogItem, FURNITURE_CATALOG } from '@/domain/project/furnitureCatalog';
import { logger } from '@/server/logger';
import { resolvedAiProvider, serverEnv } from '@/server/env';
import { AnthropicProvider, createAnthropicProvider } from './anthropic';
import { MockProvider } from './mock';
import { buildRetryHint } from './prompt';
import {
  buildFocusDetail,
  buildProjectSummary,
  selectFocusElements,
  trimHistory,
} from './sceneSummary';
import {
  AiProviderError,
  type AiProvider,
  type AiStreamEvent,
  type Citation,
  type ConversationTurn,
  type TurnRequest,
  type TurnResult,
} from './types';

/**
 * The turn orchestrator.
 *
 * This is the whole interaction model in one function:
 *
 *   read project state → interpret → plan → generate commands → validate →
 *   apply transactionally → stream the result → summarise
 *
 * Everything the AI produces is treated as untrusted input. The provider hands
 * back `unknown[]`; `parseCommands` turns that into typed commands or into
 * structured errors; `applyTransaction` either applies all of them or none.
 * There is no path from a model response to a mutation that skips both.
 *
 * One retry is allowed. Malformed command payloads are usually a units mistake
 * or a stale id, and both are things a model corrects immediately when told
 * precisely what was wrong. A second failure is reported rather than retried
 * again — burning tokens on a model that is confused rarely helps.
 *
 * This function deliberately does **not** emit the terminal `done` event. Only
 * the caller knows when the result is durable and what operation id it was
 * recorded under, and a `done` that arrives before the save would be a lie.
 */

const MAX_RETRIES = 1;

export interface RunTurnInput {
  model: ProjectModel;
  message: string;
  history: ConversationTurn[];
  selectionIds: string[];
  knowledge: Citation[];
  preferences: string;
  signal?: AbortSignal;
  /** Overrides provider selection. Used by tests and by the `mock` setting. */
  providerOverride?: AiProvider;
}

export interface TurnOutcome {
  status: 'applied' | 'clarification' | 'no-change' | 'rejected' | 'failed';
  model: ProjectModel;
  summary: string;
  provider: string;
  providerModel: string;
  usage: TurnResult['usage'];
  transactionId: string | null;
  commands: unknown[];
  inverse: unknown[];
  issues: unknown[];
  findings: unknown[];
  durationMs: number;
  sceneSummaryForLog: {
    focusIds: string[];
    focusReasons: Record<string, string>;
    elementCount: number;
    revision: number;
  };
}

/**
 * Answers an `inspect_project` tool call. Bound to the current model so the
 * provider never holds a reference to it.
 */
function makeInspector(model: ProjectModel) {
  return (input: { elementIds?: string[]; include?: string[] }): string => {
    const sections: string[] = [];

    if (input.elementIds && input.elementIds.length > 0) {
      const found = input.elementIds
        .slice(0, 40)
        .map((id) => model.elements[id])
        .filter((element): element is NonNullable<typeof element> => Boolean(element));
      const missing = input.elementIds.filter((id) => !model.elements[id]);
      sections.push(`ELEMENTS:\n${JSON.stringify(found, null, 1)}`);
      if (missing.length > 0) {
        sections.push(`NOT FOUND (these ids do not exist): ${missing.join(', ')}`);
      }
    }

    for (const include of input.include ?? []) {
      switch (include) {
        case 'levels':
          sections.push(`LEVELS:\n${JSON.stringify(model.levels, null, 1)}`);
          break;
        case 'materials':
          sections.push(`MATERIALS:\n${JSON.stringify(model.materials, null, 1)}`);
          break;
        case 'environment':
          sections.push(`ENVIRONMENT:\n${JSON.stringify(model.environment, null, 1)}`);
          break;
        case 'constraints':
          sections.push(`CONSTRAINTS:\n${JSON.stringify(model.constraints, null, 1)}`);
          break;
        case 'catalogue':
          sections.push(
            `FURNITURE CATALOGUE:\n${FURNITURE_CATALOG.map((item) => `${item.id}: ${item.name}, ${item.width}x${item.depth}x${item.height} mm`).join('\n')}`,
          );
          break;
        default:
          break;
      }
    }

    return sections.length > 0 ? sections.join('\n\n') : 'Nothing requested.';
  };
}

function createProvider(model: ProjectModel, override?: AiProvider): AiProvider {
  if (override) return override;
  if (resolvedAiProvider() === 'anthropic') {
    return createAnthropicProvider(makeInspector(model));
  }
  return new MockProvider(model);
}

/**
 * Runs one conversational turn and streams events.
 *
 * `emit` is called synchronously as work happens; the returned promise resolves
 * once the turn is complete (or has failed). The caller owns persistence — this
 * function is pure with respect to the database so it can be unit tested.
 */
export async function runTurn(
  input: RunTurnInput,
  emit: (event: AiStreamEvent) => void,
): Promise<TurnOutcome> {
  const startedAt = Date.now();
  const provider = createProvider(input.model, input.providerOverride);

  const base: Omit<TurnOutcome, 'status' | 'summary'> = {
    model: input.model,
    provider: provider.name,
    providerModel: provider.model,
    usage: { inputTokens: 0, outputTokens: 0 },
    transactionId: null,
    commands: [],
    inverse: [],
    issues: [],
    findings: [],
    durationMs: 0,
    sceneSummaryForLog: {
      focusIds: [],
      focusReasons: {},
      elementCount: Object.keys(input.model.elements).length,
      revision: input.model.revision,
    },
  };

  emit({ type: 'status', phase: 'reading-project', message: 'Reading the project' });

  const focus = selectFocusElements(input.model, input.message, input.selectionIds);
  const request: TurnRequest = {
    message: input.message,
    projectSummary: buildProjectSummary(input.model, { focusIds: focus.ids }),
    focusElements: buildFocusDetail(input.model, focus.ids),
    history: trimHistory(input.history),
    knowledge: input.knowledge,
    preferences: input.preferences,
    selectionIds: input.selectionIds,
    ...(input.signal ? { signal: input.signal } : {}),
  };

  base.sceneSummaryForLog.focusIds = focus.ids;
  base.sceneSummaryForLog.focusReasons = focus.reasons;

  if (input.knowledge.length > 0) emit({ type: 'citations', citations: input.knowledge });

  let result: TurnResult;
  try {
    result = await provider.run(request, emit);
  } catch (error) {
    return failTurn(base, error, startedAt, emit);
  }

  base.usage = result.usage;
  base.providerModel = result.model;

  if (result.clarification) {
    return {
      ...base,
      status: 'clarification',
      summary: result.clarification.question,
      durationMs: Date.now() - startedAt,
    };
  }

  if (result.rawCommands.length === 0) {
    const summary = result.summary || result.text || 'No changes were made.';
    return { ...base, status: 'no-change', summary, durationMs: Date.now() - startedAt };
  }

  emit({ type: 'status', phase: 'validating', message: 'Validating the proposed operations' });

  let attempt = 0;
  let rawCommands = result.rawCommands;
  let lastIssues: unknown[] = [];

  while (attempt <= MAX_RETRIES) {
    const parsed = parseCommands(rawCommands, { allowInternal: false });

    if (parsed.commands.length > 0) {
      emit({ type: 'commands', commands: parsed.commands });
      emit({ type: 'status', phase: 'applying', message: 'Applying to the model' });

      const transaction = applyTransaction(input.model, parsed.commands, {
        source: 'ai',
        maxNewElements: MAX_ELEMENTS_PER_TURN,
      });

      const combinedIssues = [...parsed.issues, ...transaction.issues];
      if (combinedIssues.length > 0) emit({ type: 'issues', issues: combinedIssues });

      if (!transaction.rolledBack) {
        emit({
          type: 'applied',
          transactionId: transaction.transactionId,
          model: transaction.model,
          createdIds: transaction.createdIds,
          affectedIds: transaction.affectedIds,
          inverse: transaction.inverse,
          findings: transaction.findings,
          hostEffects: transaction.hostEffects,
          label: result.summary.slice(0, 80) || input.message.slice(0, 80),
        });
        return {
          ...base,
          status: 'applied',
          model: transaction.model,
          summary: result.summary,
          transactionId: transaction.transactionId,
          commands: parsed.commands,
          inverse: transaction.inverse,
          issues: combinedIssues,
          findings: transaction.findings,
          durationMs: Date.now() - startedAt,
        };
      }
      lastIssues = combinedIssues;
    } else {
      lastIssues = parsed.issues;
      if (parsed.issues.length > 0) emit({ type: 'issues', issues: parsed.issues });
    }

    attempt += 1;
    if (attempt > MAX_RETRIES || !(provider instanceof AnthropicProvider)) break;

    const problems = (lastIssues as Array<{ message?: string; path?: string; hint?: string }>).map(
      (i) => [i.path, i.message, i.hint].filter(Boolean).join(' — '),
    );
    logger().info({ attempt, problems: problems.slice(0, 5) }, 'retrying AI operation');
    emit({
      type: 'status',
      phase: 'planning',
      message: 'The first attempt did not validate; asking for a correction',
    });

    try {
      const retried = await provider.retry(request, rawCommands, buildRetryHint(problems), emit);
      rawCommands = retried.rawCommands;
      result = { ...retried, text: `${result.text}\n${retried.text}`.trim() };
      base.usage = {
        inputTokens: base.usage.inputTokens + retried.usage.inputTokens,
        outputTokens: base.usage.outputTokens + retried.usage.outputTokens,
      };
      if (rawCommands.length === 0) break;
    } catch (error) {
      return failTurn(base, error, startedAt, emit);
    }
  }

  const summary =
    'I could not apply those changes, so the project is unchanged. ' +
    ((lastIssues as Array<{ message?: string }>)[0]?.message ?? 'The operations did not validate.');

  emit({ type: 'error', message: summary, recoverable: true });

  return {
    ...base,
    status: 'rejected',
    summary,
    issues: lastIssues,
    durationMs: Date.now() - startedAt,
  };
}

function failTurn(
  base: Omit<TurnOutcome, 'status' | 'summary'>,
  error: unknown,
  startedAt: number,
  emit: (event: AiStreamEvent) => void,
): TurnOutcome {
  const providerError =
    error instanceof AiProviderError
      ? error
      : new AiProviderError('The AI service could not complete this request.', 'unknown', true);

  const message =
    providerError.kind === 'cancelled'
      ? 'Cancelled. The project is unchanged.'
      : `${providerError.message}${providerError.retryable ? ' You can try again.' : ''}`;

  if (providerError.kind !== 'cancelled') {
    logger().warn({ kind: providerError.kind }, 'ai turn failed');
  }

  emit({ type: 'error', message, recoverable: providerError.retryable });

  return {
    ...base,
    status: providerError.kind === 'cancelled' ? 'no-change' : 'failed',
    summary: message,
    durationMs: Date.now() - startedAt,
  };
}

/** Describes the active provider for the UI's status line. */
export function providerStatus(): { provider: 'anthropic' | 'mock'; model: string; note: string } {
  const provider = resolvedAiProvider();
  if (provider === 'anthropic') {
    return {
      provider,
      model: serverEnv().ANTHROPIC_MODEL,
      note: 'Connected to Claude for open-ended architectural reasoning.',
    };
  }
  return {
    provider: 'mock',
    model: 'local-interpreter-v1',
    note: 'Running the built-in local interpreter. It handles the documented modelling operations; set ANTHROPIC_API_KEY for open-ended design conversation.',
  };
}

export { getCatalogItem };

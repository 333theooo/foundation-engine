'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CommandIssue } from '@/domain/commands/errors';
import type { ValidationFinding } from '@/domain/commands/validation';
import type { AiStreamEvent, Citation, OperationPhase, PlanStep } from '@/ai/types';
import { useEditorStore } from './store';
import { flushPendingSave, markServerSaved } from './useAutosave';

/**
 * The conversation client.
 *
 * Reads the NDJSON stream from `/api/projects/:id/chat` and turns each event
 * into UI state. The important behaviours:
 *
 *   * **Text streams in.** Prose appears while the model is still deciding what
 *     to build, which is most of the perceived responsiveness.
 *   * **`applied` installs the model with its inverse commands**, so an AI
 *     change joins the same undo stack as a gizmo drag.
 *   * **Cancellation is real.** Stop aborts the fetch, the server sees the
 *     disconnect, and the upstream provider call is cancelled with it.
 *   * **A partial stream is never applied.** The model only changes on a
 *     complete `applied` event; a dropped connection leaves the project as it
 *     was.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status?: 'streaming' | 'complete' | 'error' | 'clarification';
  plan?: PlanStep[];
  assumptions?: string[];
  citations?: Citation[];
  issues?: CommandIssue[];
  findings?: ValidationFinding[];
  clarificationOptions?: string[];
  operationId?: string | null;
  provider?: string;
  model?: string;
  durationMs?: number;
  createdIds?: string[];
  feedback?: 1 | -1 | null;
}

export interface ChatState {
  messages: ChatMessage[];
  phase: OperationPhase;
  phaseMessage: string;
  busy: boolean;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function useChat(projectId: string | null, initialMessages: ChatMessage[] = []) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [phase, setPhase] = useState<OperationPhase>('done');
  const [phaseMessage, setPhaseMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patchLast = useCallback((patch: Partial<ChatMessage>) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const index = next.length - 1;
      next[index] = { ...next[index]!, ...patch };
      return next;
    });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setPhase('cancelled');
    setPhaseMessage('Cancelled');
    patchLast({ status: 'complete' });
  }, [patchLast]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !projectId || busy) return;

      const controller = new AbortController();
      abortRef.current = controller;

      setBusy(true);
      setPhase('queued');
      setPhaseMessage('Sending');
      setMessages((current) => [
        ...current,
        { id: nextId('user'), role: 'user', content: trimmed, createdAt: Date.now() },
        {
          id: nextId('assistant'),
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'streaming',
        },
      ]);

      try {
        // The server reasons about the *stored* model, so any local edit that
        // has not been written yet must be flushed first. Without this, a manual
        // change followed straight away by a chat message would either be
        // ignored or rejected as a stale-revision conflict.
        await flushPendingSave(projectId);

        const store = useEditorStore.getState();
        const response = await fetch(`/api/projects/${projectId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            selectionIds: store.selection,
            baseRevision: store.model.revision,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `The request failed (${response.status}).`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamedText = '';

        // NDJSON: events are newline-delimited, and a chunk can split one.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line) continue;

            let event: AiStreamEvent;
            try {
              event = JSON.parse(line) as AiStreamEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case 'status':
                setPhase(event.phase);
                setPhaseMessage(event.message);
                break;
              case 'text':
                streamedText += event.delta;
                patchLast({ content: streamedText });
                break;
              case 'plan':
                patchLast({ plan: event.steps });
                break;
              case 'assumptions':
                patchLast({ assumptions: event.assumptions });
                break;
              case 'citations':
                patchLast({ citations: event.citations });
                break;
              case 'clarification':
                patchLast({
                  status: 'clarification',
                  content: event.question,
                  clarificationOptions: event.options,
                });
                break;
              case 'issues':
                patchLast({ issues: event.issues });
                break;
              case 'applied': {
                useEditorStore.getState().replaceModel(event.model, {
                  label: event.label || 'AI change',
                  inverse: event.inverse,
                  source: 'ai',
                });
                // The server persisted this model before emitting the event, so
                // autosave must treat it as already stored rather than as a
                // local change racing whatever the server holds.
                markServerSaved(projectId, event.model.revision);
                useEditorStore.getState().setSaveStatus('saved');
                useEditorStore.getState().applyHostEffects(event.hostEffects);
                if (event.createdIds.length > 0) {
                  useEditorStore.getState().setSelection(event.createdIds);
                  useEditorStore.getState().requestCamera({ kind: 'frame', ids: event.createdIds });
                }
                patchLast({ findings: event.findings, createdIds: event.createdIds });
                break;
              }
              case 'error':
                patchLast({ status: 'error', content: event.message });
                break;
              case 'done': {
                const summary = event.summary || streamedText;
                // A clarification or an error keeps its own status; only a
                // still-streaming message is completed here.
                setMessages((current) => {
                  const next = [...current];
                  const index = next.length - 1;
                  const last = next[index];
                  if (!last) return current;
                  next[index] = {
                    ...last,
                    content: summary || last.content,
                    operationId: event.operationId,
                    provider: event.provider,
                    model: event.model,
                    durationMs: event.durationMs,
                    status: last.status === 'streaming' ? 'complete' : last.status,
                  };
                  return next;
                });
                setPhase('done');
                setPhaseMessage('');
                break;
              }
              default:
                break;
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          patchLast({ status: 'complete', content: 'Cancelled. The project is unchanged.' });
        } else {
          const message = error instanceof Error ? error.message : 'The request failed.';
          patchLast({ status: 'error', content: message });
          toast.error(message);
          setPhase('failed');
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [projectId, busy, patchLast],
  );

  const rate = useCallback(async (message: ChatMessage, rating: 1 | -1, reason = '') => {
    if (!message.operationId) return;
    setMessages((current) =>
      current.map((entry) => (entry.id === message.id ? { ...entry, feedback: rating } : entry)),
    );
    try {
      const response = await fetch(`/api/operations/${message.operationId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, reason }),
      });
      if (!response.ok) throw new Error('Feedback could not be recorded.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Feedback could not be recorded.');
      setMessages((current) =>
        current.map((entry) => (entry.id === message.id ? { ...entry, feedback: null } : entry)),
      );
    }
  }, []);

  return { messages, setMessages, phase, phaseMessage, busy, send, cancel, rate };
}

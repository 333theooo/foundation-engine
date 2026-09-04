'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { ProjectModel } from '@/domain/project/schema';
import { useEditorStore } from './store';

/**
 * Autosave and crash recovery.
 *
 * Three layers, because each fails in a different way:
 *
 *   1. **Debounced server save.** The durable one. 1.5 s after the last change,
 *      the model goes to `PUT /api/projects/:id/model`. Concurrent saves are
 *      coalesced — a save in flight when new edits arrive queues exactly one
 *      follow-up rather than a burst.
 *   2. **A local draft in `localStorage`.** Written on every change, cheap and
 *      synchronous. It covers the window between an edit and its save: a crash,
 *      a lost connection, or a closed laptop. On load, `recoverDraft` offers it
 *      back if it is newer than what the server returned.
 *   3. **A `sendBeacon` flush on unload.** Best effort, and the reason a tab
 *      closed mid-edit usually loses nothing at all.
 *
 * Saves carry `baseRevision`, so a second tab editing the same project gets a
 * clear conflict instead of silently overwriting the first.
 */

const DEBOUNCE_MS = 1_500;
const DRAFT_PREFIX = 'atrium.draft.';

interface Draft {
  projectId: string;
  savedAt: number;
  revision: number;
  model: ProjectModel;
}

function draftKey(projectId: string): string {
  return `${DRAFT_PREFIX}${projectId}`;
}

export function writeDraft(projectId: string, model: ProjectModel): void {
  try {
    const draft: Draft = { projectId, savedAt: Date.now(), revision: model.revision, model };
    localStorage.setItem(draftKey(projectId), JSON.stringify(draft));
  } catch {
    // Quota exceeded or storage disabled. The server save is the durable path;
    // losing the local draft degrades recovery, it does not lose work.
  }
}

export function readDraft(projectId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft;
    return parsed.projectId === projectId ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDraft(projectId: string): void {
  try {
    localStorage.removeItem(draftKey(projectId));
  } catch {
    // Nothing useful to do; the draft simply stays until it is overwritten.
  }
}

/**
 * Returns a draft worth offering the user: one that is strictly ahead of what
 * the server has. A draft at or behind the server revision is stale and is
 * cleared rather than offered.
 */
export function recoverDraft(projectId: string, serverModel: ProjectModel): Draft | null {
  const draft = readDraft(projectId);
  if (!draft) return null;
  if (draft.revision <= serverModel.revision) {
    clearDraft(projectId);
    return null;
  }
  // A draft older than a week is more likely to confuse than to help.
  if (Date.now() - draft.savedAt > 7 * 24 * 60 * 60 * 1000) {
    clearDraft(projectId);
    return null;
  }
  return draft;
}

/**
 * Module-level, not component-level, because two other things need to reach it:
 *
 *   * the chat client, which must flush pending edits before asking the AI to
 *     reason about the project — otherwise the server would read a stale model;
 *   * the AI stream, which persists on the server and must tell autosave what
 *     revision is already safely stored, or the next autosave would look like a
 *     conflicting write.
 */
const savedRevisions = new Map<string, number>();
const flushers = new Map<string, () => Promise<void>>();

/** Records a revision the server already holds (an AI turn, or a restore). */
export function markServerSaved(projectId: string, revision: number): void {
  savedRevisions.set(projectId, revision);
  clearDraft(projectId);
}

/** Saves immediately, bypassing the debounce, and resolves once it is stored. */
export async function flushPendingSave(projectId: string): Promise<void> {
  await flushers.get(projectId)?.();
}

export function useAutosave(projectId: string | null): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const queued = useRef(false);

  useEffect(() => {
    if (!projectId) return;

    const save = async () => {
      const state = useEditorStore.getState();
      if (!state.loaded || state.projectId !== projectId) return;
      const lastSaved = savedRevisions.get(projectId) ?? -1;
      if (state.model.revision === lastSaved) return;

      if (inFlight.current) {
        queued.current = true;
        return;
      }

      inFlight.current = true;
      const revision = state.model.revision;
      state.setSaveStatus('saving');

      try {
        const response = await fetch(`/api/projects/${projectId}/model`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: state.model,
            baseRevision: lastSaved >= 0 ? lastSaved : undefined,
          }),
        });

        if (response.status === 409) {
          const body = (await response.json()) as { error?: string };
          useEditorStore
            .getState()
            .setSaveStatus('error', body.error ?? 'This project changed elsewhere.');
          toast.error('This project changed in another session.', {
            description:
              'Reload to pick up the latest version. Your local changes are kept in this tab until you do.',
            duration: 12_000,
          });
          return;
        }

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'Save failed.');
        }

        savedRevisions.set(projectId, revision);
        clearDraft(projectId);
        useEditorStore.getState().setSaveStatus('saved');
      } catch (error) {
        useEditorStore
          .getState()
          .setSaveStatus('error', error instanceof Error ? error.message : 'Save failed.');
      } finally {
        inFlight.current = false;
        if (queued.current) {
          queued.current = false;
          void save();
        }
      }
    };

    // Register the flush hook for this project while the editor is mounted.
    flushers.set(projectId, async () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      await save();
    });

    const unsubscribe = useEditorStore.subscribe(
      (state) => state.modelVersion,
      () => {
        const state = useEditorStore.getState();
        if (!state.loaded || state.projectId !== projectId) return;

        writeDraft(projectId, state.model);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), DEBOUNCE_MS);
      },
    );

    // A tab closing mid-edit should not lose the last few seconds of work.
    const flushOnHide = () => {
      const state = useEditorStore.getState();
      if (state.saveStatus !== 'dirty' && state.saveStatus !== 'error') return;
      writeDraft(projectId, state.model);
      try {
        navigator.sendBeacon?.(
          `/api/projects/${projectId}/model`,
          new Blob([JSON.stringify({ model: state.model })], { type: 'application/json' }),
        );
      } catch {
        // sendBeacon is best-effort by design; the draft above is the fallback.
      }
    };

    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnHide();
    });

    return () => {
      unsubscribe();
      flushers.delete(projectId);
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('pagehide', flushOnHide);
    };
  }, [projectId]);
}

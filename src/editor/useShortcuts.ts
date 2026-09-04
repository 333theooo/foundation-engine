'use client';

import { useEffect } from 'react';
import { isEditableTarget } from '@/lib/utils';
import { useEditorStore } from './store';

/**
 * Keyboard shortcuts.
 *
 * Chosen to match what an architect already has in their fingers from other
 * modelling tools: Q/W/E/R for the gizmo modes, F to frame, H/I for hide and
 * isolate, 1–6 for standard views.
 *
 * Every handler stands down when focus is in a text field, so typing "Delete
 * the north wall" into the chat does not delete the selection.
 */

export interface ShortcutHandlers {
  onSave?: () => void;
  onExport?: () => void;
  onImport?: () => void;
  onFocusChat?: () => void;
  onToggleHelp?: () => void;
}

export const SHORTCUTS: Array<{ keys: string; description: string; group: string }> = [
  { keys: 'Q', description: 'Select tool', group: 'Tools' },
  { keys: 'W', description: 'Move tool', group: 'Tools' },
  { keys: 'E', description: 'Rotate tool', group: 'Tools' },
  { keys: 'R', description: 'Scale tool', group: 'Tools' },
  { keys: 'M', description: 'Measure distance', group: 'Tools' },
  { keys: 'F', description: 'Frame selection', group: 'View' },
  { keys: '1 – 6', description: 'Top, front, back, left, right, isometric', group: 'View' },
  { keys: 'O', description: 'Toggle orthographic', group: 'View' },
  { keys: 'G', description: 'Toggle grid', group: 'View' },
  { keys: 'H', description: 'Hide selection', group: 'Edit' },
  { keys: 'I', description: 'Isolate selection', group: 'Edit' },
  { keys: 'L', description: 'Lock or unlock selection', group: 'Edit' },
  { keys: 'D', description: 'Duplicate selection', group: 'Edit' },
  { keys: 'Delete', description: 'Delete selection', group: 'Edit' },
  { keys: 'Esc', description: 'Clear selection or cancel measuring', group: 'Edit' },
  { keys: 'Ctrl/⌘ Z', description: 'Undo', group: 'Edit' },
  { keys: 'Ctrl/⌘ ⇧ Z', description: 'Redo', group: 'Edit' },
  { keys: 'Ctrl/⌘ A', description: 'Select all', group: 'Edit' },
  { keys: 'Ctrl/⌘ S', description: 'Save a named version', group: 'Project' },
  { keys: 'Ctrl/⌘ K', description: 'Focus the chat', group: 'Project' },
  { keys: '?', description: 'Show this list', group: 'Project' },
];

export function useShortcuts(handlers: ShortcutHandlers = {}): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const store = useEditorStore.getState();
      const modifier = event.metaKey || event.ctrlKey;

      // Ctrl/Cmd+K reaches the chat even from a field, because that is the
      // point of it; everything else defers to whatever has focus.
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        handlers.onFocusChat?.();
        return;
      }
      if (isEditableTarget(event.target)) return;

      if (modifier) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) store.redo();
            else store.undo();
            return;
          case 'y':
            event.preventDefault();
            store.redo();
            return;
          case 'a':
            event.preventDefault();
            store.setSelection(
              store.model.elementOrder.filter((id) => store.model.elements[id]?.visible),
            );
            return;
          case 's':
            event.preventDefault();
            handlers.onSave?.();
            return;
          case 'e':
            event.preventDefault();
            handlers.onExport?.();
            return;
          case 'o':
            event.preventDefault();
            handlers.onImport?.();
            return;
          default:
            return;
        }
      }

      switch (event.key) {
        case 'q':
        case 'Q':
          store.setGizmoMode('select');
          break;
        case 'w':
        case 'W':
          store.setGizmoMode('translate');
          break;
        case 'e':
        case 'E':
          store.setGizmoMode('rotate');
          break;
        case 'r':
        case 'R':
          store.setGizmoMode('scale');
          break;
        case 'm':
        case 'M':
          store.startMeasurement('distance');
          break;
        case 'f':
        case 'F':
          store.requestCamera({ kind: 'frame', ids: store.selection });
          break;
        case 'g':
        case 'G':
          store.toggleDisplay('showGrid');
          break;
        case 'o':
        case 'O':
          store.setOrthographic(!store.orthographic);
          break;
        case '1':
          store.requestCamera({ kind: 'preset', preset: 'top' });
          break;
        case '2':
          store.requestCamera({ kind: 'preset', preset: 'front' });
          break;
        case '3':
          store.requestCamera({ kind: 'preset', preset: 'back' });
          break;
        case '4':
          store.requestCamera({ kind: 'preset', preset: 'left' });
          break;
        case '5':
          store.requestCamera({ kind: 'preset', preset: 'right' });
          break;
        case '6':
          store.requestCamera({ kind: 'preset', preset: 'iso' });
          break;
        case 'h':
        case 'H':
          if (store.selection.length > 0) {
            store.dispatch(
              [
                {
                  type: 'set_visibility',
                  description: 'Hide selection',
                  ids: store.selection,
                  visible: false,
                },
              ],
              { label: 'Hide selection' },
            );
          }
          break;
        case 'i':
        case 'I':
          store.isolate(store.isolatedIds ? null : store.selection);
          break;
        case 'l':
        case 'L':
          if (store.selection.length > 0) {
            const anyUnlocked = store.selection.some((id) => !store.model.elements[id]?.locked);
            store.dispatch(
              [
                {
                  type: 'set_lock',
                  description: 'Lock selection',
                  ids: store.selection,
                  locked: anyUnlocked,
                },
              ],
              { label: anyUnlocked ? 'Lock selection' : 'Unlock selection' },
            );
          }
          break;
        case 'd':
        case 'D':
          if (store.selection.length > 0) {
            store.dispatch(
              [
                {
                  type: 'duplicate_elements',
                  description: 'Duplicate selection',
                  ids: store.selection,
                  offset: { x: 1000, y: 0, z: 0 },
                },
              ],
              { label: 'Duplicate selection', focusResult: true },
            );
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (store.selection.length > 0) {
            event.preventDefault();
            store.dispatch(
              [{ type: 'delete_elements', description: 'Delete selection', ids: store.selection }],
              { label: 'Delete selection' },
            );
          }
          break;
        case 'Escape':
          if (store.measurement.active) store.cancelMeasurement();
          else if (store.isolatedIds) store.isolate(null);
          else store.clearSelection();
          break;
        case '?':
          handlers.onToggleHelp?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}

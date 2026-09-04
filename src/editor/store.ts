'use client';

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { CommandIssue } from '@/domain/commands/errors';
import { parseCommands } from '@/domain/commands/errors';
import type { HostEffect } from '@/domain/commands/executor';
import { applyTransaction } from '@/domain/commands/transaction';
import type { ModelingCommand } from '@/domain/commands/schema';
import { validateModel, type ValidationFinding } from '@/domain/commands/validation';
import { createEmptyProject } from '@/domain/project/factory';
import { modelBounds } from '@/domain/project/queries';
import type { ProjectModel } from '@/domain/project/schema';

/**
 * Editor state.
 *
 * The split that matters: **the project model is durable state, everything else
 * here is ephemeral.** Selection, hover, camera, gizmo mode, snapping and the
 * undo stack live only in the browser tab. The model is the single thing that
 * is saved, versioned, sent to the AI, and reloaded.
 *
 * Command dispatch is the only way the model changes, whether the change came
 * from a gizmo drag, a number typed into the inspector, or the AI. That is what
 * makes undo uniform and what keeps the AI's view of the project honest — a
 * manual edit lands in the same place an AI edit does.
 */

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
export type GizmoMode = 'select' | 'translate' | 'rotate' | 'scale';
export type CameraPreset = 'iso' | 'top' | 'front' | 'back' | 'left' | 'right';
export type RightPanelTab = 'chat' | 'properties' | 'issues';

export interface UndoEntry {
  id: string;
  label: string;
  /** Commands that undo the change. */
  inverse: ModelingCommand[];
  /** Commands that redo it. Filled in when the entry is undone. */
  redo: ModelingCommand[] | null;
  at: number;
  source: 'user' | 'ai' | 'import';
}

export interface OperationLogEntry {
  id: string;
  at: number;
  source: 'user' | 'ai' | 'import';
  label: string;
  commandCount: number;
  createdIds: string[];
  affectedIds: string[];
  issues: CommandIssue[];
  status: 'applied' | 'rejected';
}

export interface DispatchOptions {
  label?: string;
  source?: 'user' | 'ai' | 'import';
  /** Skip the undo stack. Used when replaying an undo. */
  transient?: boolean;
  /** Select and frame what the transaction created. */
  focusResult?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  issues: CommandIssue[];
  createdIds: string[];
  affectedIds: string[];
  hostEffects: HostEffect[];
}

export interface SnapSettings {
  grid: boolean;
  gridSizeMm: number;
  objects: boolean;
  angleDeg: number;
}

export interface ScenePerformance {
  fps: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
}

export interface MeasurementDraft {
  active: boolean;
  kind: 'distance' | 'area';
  points: Array<{ x: number; y: number; z: number }>;
}

/** Camera instruction consumed once by the viewport, then cleared. */
export interface CameraRequest {
  nonce: number;
  kind: 'frame' | 'preset' | 'view';
  ids?: string[];
  preset?: CameraPreset;
  position?: { x: number; y: number; z: number };
  target?: { x: number; y: number; z: number };
}

interface EditorState {
  projectId: string | null;
  model: ProjectModel;
  loaded: boolean;
  loadWarnings: string[];

  selection: string[];
  hovered: string | null;
  activeLevelId: string | null;
  isolatedIds: string[] | null;

  orthographic: boolean;
  sectionElevation: number | null;
  gizmoMode: GizmoMode;
  snap: SnapSettings;
  showGrid: boolean;
  showRooms: boolean;
  showFurniture: boolean;
  showShadows: boolean;
  wireframe: boolean;

  rightPanel: RightPanelTab;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomBarOpen: boolean;

  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  operations: OperationLogEntry[];
  findings: ValidationFinding[];

  saveStatus: SaveStatus;
  lastSavedAt: number | null;
  saveError: string | null;

  performance: ScenePerformance;
  measurement: MeasurementDraft;
  cameraRequest: CameraRequest | null;

  /** Bumped whenever the model changes, so effects can depend on it cheaply. */
  modelVersion: number;

  loadProject(projectId: string, model: ProjectModel, warnings?: string[]): void;
  replaceModel(
    model: ProjectModel,
    options?: { label?: string; inverse?: ModelingCommand[]; source?: 'ai' | 'user' | 'import' },
  ): void;
  dispatch(commands: readonly unknown[], options?: DispatchOptions): DispatchResult;
  undo(): boolean;
  redo(): boolean;

  setSelection(ids: string[]): void;
  toggleSelection(id: string, additive: boolean): void;
  clearSelection(): void;
  setHovered(id: string | null): void;
  isolate(ids: string[] | null): void;

  setActiveLevel(levelId: string | null): void;
  setOrthographic(value: boolean): void;
  setSectionElevation(value: number | null): void;
  setGizmoMode(mode: GizmoMode): void;
  setSnap(patch: Partial<SnapSettings>): void;
  toggleDisplay(
    key: 'showGrid' | 'showRooms' | 'showFurniture' | 'showShadows' | 'wireframe',
  ): void;

  setRightPanel(tab: RightPanelTab): void;
  togglePanel(panel: 'left' | 'right' | 'bottom'): void;

  setSaveStatus(status: SaveStatus, error?: string | null): void;
  setPerformance(next: ScenePerformance): void;

  startMeasurement(kind: 'distance' | 'area'): void;
  addMeasurementPoint(point: { x: number; y: number; z: number }): void;
  cancelMeasurement(): void;
  commitMeasurement(label?: string): void;

  requestCamera(request: Omit<CameraRequest, 'nonce'>): void;
  consumeCameraRequest(): void;

  applyHostEffects(effects: HostEffect[]): void;
}

const MAX_UNDO = 100;
const MAX_OPERATION_LOG = 200;

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useEditorStore = create<EditorState>()(
  subscribeWithSelector((set, get) => ({
    projectId: null,
    model: createEmptyProject({ name: 'Loading' }),
    loaded: false,
    loadWarnings: [],

    selection: [],
    hovered: null,
    activeLevelId: null,
    isolatedIds: null,

    orthographic: false,
    sectionElevation: null,
    gizmoMode: 'select',
    snap: { grid: true, gridSizeMm: 100, objects: true, angleDeg: 15 },
    showGrid: true,
    showRooms: true,
    showFurniture: true,
    showShadows: true,
    wireframe: false,

    rightPanel: 'chat',
    leftPanelOpen: true,
    rightPanelOpen: true,
    bottomBarOpen: true,

    undoStack: [],
    redoStack: [],
    operations: [],
    findings: [],

    saveStatus: 'idle',
    lastSavedAt: null,
    saveError: null,

    performance: { fps: 0, drawCalls: 0, triangles: 0, geometries: 0 },
    measurement: { active: false, kind: 'distance', points: [] },
    cameraRequest: null,
    modelVersion: 0,

    loadProject(projectId, model, warnings = []) {
      set({
        projectId,
        model,
        loaded: true,
        loadWarnings: warnings,
        selection: [],
        hovered: null,
        undoStack: [],
        redoStack: [],
        operations: [],
        findings: validateModel(model),
        saveStatus: 'idle',
        saveError: null,
        modelVersion: get().modelVersion + 1,
        activeLevelId: null,
        isolatedIds: null,
      });
    },

    /**
     * Installs a model produced elsewhere (the AI, a version restore, an
     * import). When inverse commands come with it the change joins the undo
     * stack, so an AI edit is undone exactly like a manual one.
     */
    replaceModel(model, options = {}) {
      const state = get();
      const entry: UndoEntry | null = options.inverse?.length
        ? {
            id: newId('undo'),
            label: options.label ?? 'AI change',
            inverse: options.inverse,
            redo: null,
            at: Date.now(),
            source: options.source ?? 'ai',
          }
        : null;

      set({
        model,
        findings: validateModel(model),
        modelVersion: state.modelVersion + 1,
        saveStatus: 'dirty',
        undoStack: entry ? [...state.undoStack, entry].slice(-MAX_UNDO) : state.undoStack,
        redoStack: entry ? [] : state.redoStack,
        selection: state.selection.filter((id) => model.elements[id]),
      });
    },

    dispatch(commands, options = {}) {
      const state = get();
      const parsed = parseCommands(commands, { allowInternal: options.transient === true });

      if (parsed.commands.length === 0) {
        const result: DispatchResult = {
          ok: false,
          issues: parsed.issues,
          createdIds: [],
          affectedIds: [],
          hostEffects: [],
        };
        if (parsed.issues.length > 0) {
          set({
            operations: [
              {
                id: newId('op'),
                at: Date.now(),
                source: options.source ?? 'user',
                label: options.label ?? 'Rejected operation',
                commandCount: 0,
                createdIds: [],
                affectedIds: [],
                issues: parsed.issues,
                status: 'rejected' as const,
              },
              ...state.operations,
            ].slice(0, MAX_OPERATION_LOG),
          });
        }
        return result;
      }

      const transaction = applyTransaction(state.model, parsed.commands, {
        source: options.source ?? 'user',
        allowLockedEdits: options.transient === true,
        skipReview: options.transient === true,
      });

      const issues = [...parsed.issues, ...transaction.issues];

      if (transaction.rolledBack) {
        set({
          operations: [
            {
              id: newId('op'),
              at: Date.now(),
              source: options.source ?? 'user',
              label: options.label ?? 'Rejected operation',
              commandCount: parsed.commands.length,
              createdIds: [],
              affectedIds: [],
              issues,
              status: 'rejected' as const,
            },
            ...state.operations,
          ].slice(0, MAX_OPERATION_LOG),
        });
        return { ok: false, issues, createdIds: [], affectedIds: [], hostEffects: [] };
      }

      const entry: UndoEntry | null =
        options.transient || transaction.inverse.length === 0
          ? null
          : {
              id: newId('undo'),
              label: options.label ?? describeCommands(parsed.commands),
              inverse: transaction.inverse,
              redo: null,
              at: Date.now(),
              source: options.source ?? 'user',
            };

      set({
        model: transaction.model,
        findings: options.transient ? validateModel(transaction.model) : transaction.findings,
        modelVersion: state.modelVersion + 1,
        saveStatus: 'dirty',
        undoStack: entry ? [...state.undoStack, entry].slice(-MAX_UNDO) : state.undoStack,
        redoStack: entry ? [] : state.redoStack,
        selection: state.selection.filter((id) => transaction.model.elements[id]),
        operations: options.transient
          ? state.operations
          : [
              {
                id: newId('op'),
                at: Date.now(),
                source: options.source ?? 'user',
                label: options.label ?? describeCommands(parsed.commands),
                commandCount: parsed.commands.length,
                createdIds: transaction.createdIds,
                affectedIds: transaction.affectedIds,
                issues,
                status: 'applied' as const,
              },
              ...state.operations,
            ].slice(0, MAX_OPERATION_LOG),
      });

      if (options.focusResult && transaction.createdIds.length > 0) {
        get().setSelection(transaction.createdIds);
        get().requestCamera({ kind: 'frame', ids: transaction.createdIds });
      }

      get().applyHostEffects(transaction.hostEffects);

      return {
        ok: true,
        issues,
        createdIds: transaction.createdIds,
        affectedIds: transaction.affectedIds,
        hostEffects: transaction.hostEffects,
      };
    },

    undo() {
      const state = get();
      const entry = state.undoStack[state.undoStack.length - 1];
      if (!entry) return false;

      const transaction = applyTransaction(state.model, entry.inverse, {
        source: 'user',
        allowLockedEdits: true,
        skipReview: true,
      });
      if (transaction.rolledBack) return false;

      set({
        model: transaction.model,
        findings: validateModel(transaction.model),
        modelVersion: state.modelVersion + 1,
        saveStatus: 'dirty',
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, { ...entry, redo: transaction.inverse }].slice(-MAX_UNDO),
        selection: state.selection.filter((id) => transaction.model.elements[id]),
      });
      return true;
    },

    redo() {
      const state = get();
      const entry = state.redoStack[state.redoStack.length - 1];
      if (!entry?.redo) return false;

      const transaction = applyTransaction(state.model, entry.redo, {
        source: 'user',
        allowLockedEdits: true,
        skipReview: true,
      });
      if (transaction.rolledBack) return false;

      set({
        model: transaction.model,
        findings: validateModel(transaction.model),
        modelVersion: state.modelVersion + 1,
        saveStatus: 'dirty',
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, { ...entry, inverse: transaction.inverse }].slice(
          -MAX_UNDO,
        ),
        selection: state.selection.filter((id) => transaction.model.elements[id]),
      });
      return true;
    },

    setSelection(ids) {
      const model = get().model;
      set({ selection: ids.filter((id) => model.elements[id]) });
    },

    toggleSelection(id, additive) {
      const state = get();
      if (!state.model.elements[id]) return;
      if (!additive) {
        set({ selection: state.selection.length === 1 && state.selection[0] === id ? [] : [id] });
        return;
      }
      set({
        selection: state.selection.includes(id)
          ? state.selection.filter((existing) => existing !== id)
          : [...state.selection, id],
      });
    },

    clearSelection() {
      set({ selection: [] });
    },

    setHovered(id) {
      if (get().hovered !== id) set({ hovered: id });
    },

    isolate(ids) {
      set({ isolatedIds: ids && ids.length > 0 ? ids : null });
    },

    setActiveLevel(levelId) {
      set({ activeLevelId: levelId });
    },

    setOrthographic(value) {
      set({ orthographic: value });
    },

    setSectionElevation(value) {
      set({ sectionElevation: value });
    },

    setGizmoMode(mode) {
      set({ gizmoMode: mode });
    },

    setSnap(patch) {
      set({ snap: { ...get().snap, ...patch } });
    },

    toggleDisplay(key) {
      set({ [key]: !get()[key] } as Partial<EditorState>);
    },

    setRightPanel(tab) {
      set({ rightPanel: tab, rightPanelOpen: true });
    },

    togglePanel(panel) {
      const state = get();
      if (panel === 'left') set({ leftPanelOpen: !state.leftPanelOpen });
      if (panel === 'right') set({ rightPanelOpen: !state.rightPanelOpen });
      if (panel === 'bottom') set({ bottomBarOpen: !state.bottomBarOpen });
    },

    setSaveStatus(status, error = null) {
      set({
        saveStatus: status,
        saveError: error,
        ...(status === 'saved' ? { lastSavedAt: Date.now() } : {}),
      });
    },

    setPerformance(next) {
      set({ performance: next });
    },

    startMeasurement(kind) {
      set({ measurement: { active: true, kind, points: [] }, gizmoMode: 'select' });
    },

    addMeasurementPoint(point) {
      const measurement = get().measurement;
      if (!measurement.active) return;
      set({ measurement: { ...measurement, points: [...measurement.points, point] } });
    },

    cancelMeasurement() {
      set({ measurement: { active: false, kind: 'distance', points: [] } });
    },

    commitMeasurement(label) {
      const measurement = get().measurement;
      const required = measurement.kind === 'distance' ? 2 : 3;
      if (measurement.points.length < required) return;
      get().dispatch(
        [
          {
            type: 'add_measurement',
            description: 'Add measurement',
            kind: measurement.kind,
            label: label ?? '',
            points: measurement.points,
          },
        ],
        { label: 'Add measurement' },
      );
      set({ measurement: { active: false, kind: measurement.kind, points: [] } });
    },

    requestCamera(request) {
      set({ cameraRequest: { ...request, nonce: Date.now() + Math.random() } });
    },

    consumeCameraRequest() {
      set({ cameraRequest: null });
    },

    /**
     * Performs the effects of host commands. These deliberately do not touch the
     * model — they move the camera, change the selection, or hand off to the
     * export flow.
     */
    applyHostEffects(effects) {
      for (const effect of effects) {
        switch (effect.type) {
          case 'select_elements': {
            const ids = Array.isArray(effect.payload.ids) ? (effect.payload.ids as string[]) : [];
            const mode = (effect.payload.mode as string) ?? 'replace';
            const current = get().selection;
            if (mode === 'add') get().setSelection([...new Set([...current, ...ids])]);
            else if (mode === 'remove')
              get().setSelection(current.filter((id) => !ids.includes(id)));
            else get().setSelection(ids);
            break;
          }
          case 'focus_elements': {
            const ids = Array.isArray(effect.payload.ids) ? (effect.payload.ids as string[]) : [];
            get().requestCamera({ kind: 'frame', ids });
            break;
          }
          case 'set_camera': {
            const preset = effect.payload.preset as CameraPreset | 'section' | undefined;
            if (effect.payload.mode) get().setOrthographic(effect.payload.mode === 'orthographic');
            if (typeof effect.payload.sectionElevation === 'number') {
              get().setSectionElevation(effect.payload.sectionElevation);
            }
            if (preset && preset !== 'section') {
              get().requestCamera({ kind: 'preset', preset });
            }
            break;
          }
          case 'restore_view': {
            const view = get().model.views.find((v) => v.id === effect.payload.viewId);
            if (view) {
              get().setOrthographic(view.mode === 'orthographic');
              get().setSectionElevation(view.sectionElevation);
              get().requestCamera({ kind: 'view', position: view.position, target: view.target });
            }
            break;
          }
          default:
            // export_project / create_snapshot / restore_snapshot are handled by
            // the components that own those flows, which have the network access.
            break;
        }
      }
    },
  })),
);

function describeCommands(commands: readonly ModelingCommand[]): string {
  if (commands.length === 0) return 'No change';
  const first = commands[0]!;
  if (first.description) return first.description;
  const label = first.type.replace(/_/g, ' ');
  return commands.length === 1 ? label : `${label} +${commands.length - 1} more`;
}

/** Elements currently rendered, after level filtering and isolation. */
export function visibleElementIds(state: {
  model: ProjectModel;
  activeLevelId: string | null;
  isolatedIds: string[] | null;
  showRooms: boolean;
  showFurniture: boolean;
}): string[] {
  const { model, activeLevelId, isolatedIds } = state;
  const isolated = isolatedIds ? new Set(isolatedIds) : null;

  return model.elementOrder.filter((id) => {
    const element = model.elements[id];
    if (!element || !element.visible) return false;
    if (isolated && !isolated.has(id)) return false;
    if (element.type === 'room' && !state.showRooms) return false;
    if (element.type === 'furniture' && !state.showFurniture) return false;

    if (activeLevelId) {
      if (element.type === 'opening') {
        const host = model.elements[element.hostId];
        return host && 'levelId' in host && host.levelId === activeLevelId;
      }
      if ('levelId' in element && element.levelId) return element.levelId === activeLevelId;
      return false;
    }

    if ('levelId' in element && element.levelId) {
      const level = model.levels.find((l) => l.id === element.levelId);
      if (level && !level.visible) return false;
    }
    return true;
  });
}

/** Scene-space bounds of the current selection, for camera framing. */
export function selectionBounds(model: ProjectModel, ids: readonly string[]) {
  return modelBounds(model, ids.length > 0 ? ids : undefined);
}

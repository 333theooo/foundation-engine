import { DEFAULT_MATERIAL_FOR } from '@/domain/project/materials';
import { createElementId, createId, uniqueId } from '@/domain/project/ids';
import { MAX_ELEMENTS, MAX_ELEMENTS_PER_TURN, MAX_LEVELS } from '@/domain/project/limits';
import {
  elementSchema,
  environmentSchema,
  levelSchema,
  materialSchema,
  type ArchElement,
  type Level,
  type Opening,
  type Point2,
  type ProjectModel,
  type Wall,
} from '@/domain/project/schema';
import {
  defaultLevelId,
  modelBounds,
  openingsForWall,
  rectangleOutline,
  wallLength,
} from '@/domain/project/queries';
import { degToRad } from '@/domain/units';
import { hasErrors, issue, warning, type CommandIssue } from './errors';
import { isHostEffectCommand, type ModelingCommand } from './schema';

/**
 * The command executor.
 *
 * Contract:
 *
 * * `applyCommand` mutates a **draft** model and returns the inverse commands
 *   needed to undo it. Callers never hand it the live model — `applyTransaction`
 *   clones first, so a failure leaves the caller's model untouched by
 *   construction rather than by careful bookkeeping.
 * * Errors are collected, not thrown. A command that cannot run reports issues
 *   and leaves the draft as it found it.
 * * Host-effect commands (export, snapshot, camera) produce no model change;
 *   they surface as `hostEffects` for the shell to perform.
 */

export interface HostEffect {
  commandId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface CommandOutcome {
  ok: boolean;
  issues: CommandIssue[];
  inverse: ModelingCommand[];
  createdIds: string[];
  affectedIds: string[];
  hostEffects: HostEffect[];
}

export interface ExecutionContext {
  /** Who authored the change; stamped onto created elements. */
  source: 'user' | 'ai' | 'import' | 'template';
  /** Cap on elements a single transaction may add. */
  maxNewElements?: number;
  /** When false, locked elements are skipped with a warning instead of edited. */
  allowLockedEdits?: boolean;
}

function emptyOutcome(): CommandOutcome {
  return { ok: true, issues: [], inverse: [], createdIds: [], affectedIds: [], hostEffects: [] };
}

/* ------------------------------------------------------------------ */
/* Draft helpers                                                       */
/* ------------------------------------------------------------------ */

function takenIds(draft: ProjectModel): Set<string> {
  return new Set([
    ...Object.keys(draft.elements),
    ...draft.levels.map((l) => l.id),
    ...Object.keys(draft.materials),
    ...draft.views.map((v) => v.id),
  ]);
}

function allocateElementId(
  draft: ProjectModel,
  requested: string | undefined,
  type: string,
): string {
  const taken = takenIds(draft);
  if (requested) return uniqueId(requested, taken);
  let candidate = createElementId(type);
  while (taken.has(candidate)) candidate = createElementId(type);
  return candidate;
}

function insertElement(draft: ProjectModel, element: ArchElement): void {
  draft.elements[element.id] = element;
  if (!draft.elementOrder.includes(element.id)) draft.elementOrder.push(element.id);
}

/**
 * Removes elements and everything that structurally depends on them.
 * Returns what was removed, in hierarchy order, so the inverse can restore it.
 */
function cascadeRemove(
  draft: ProjectModel,
  ids: readonly string[],
): { removed: ArchElement[]; orderHints: Array<{ id: string; index: number }> } {
  const doomed = new Set<string>();

  const visit = (id: string) => {
    if (doomed.has(id)) return;
    const element = draft.elements[id];
    if (!element) return;
    doomed.add(id);

    // Openings cannot outlive their host wall.
    if (element.type === 'wall') {
      for (const opening of openingsForWall(draft, id)) visit(opening.id);
    }
    // Deleting a group deletes its members: that is what a user means by
    // "delete this wing", and keeping orphans behind is never the intent.
    if (element.type === 'group') {
      for (const childId of element.childIds) visit(childId);
    }
  };

  for (const id of ids) visit(id);

  const orderHints: Array<{ id: string; index: number }> = [];
  const removed: ArchElement[] = [];
  draft.elementOrder.forEach((id, index) => {
    if (doomed.has(id)) {
      const element = draft.elements[id];
      if (element) {
        removed.push(structuredClone(element));
        orderHints.push({ id, index });
      }
    }
  });

  for (const id of doomed) delete draft.elements[id];
  draft.elementOrder = draft.elementOrder.filter((id) => !doomed.has(id));

  // Prune dangling references left behind in surviving groups.
  for (const element of Object.values(draft.elements)) {
    if (element.type === 'group') {
      element.childIds = element.childIds.filter((childId) => !doomed.has(childId));
    }
    if (element.parentId && doomed.has(element.parentId)) element.parentId = null;
  }

  return { removed, orderHints };
}

function resolveLevelId(
  draft: ProjectModel,
  requested: string | undefined | null,
  issues: CommandIssue[],
  commandId: string,
): string | null {
  if (!requested) return defaultLevelId(draft);
  if (draft.levels.some((l) => l.id === requested)) return requested;
  issues.push(
    issue('missing_reference', `Level "${requested}" does not exist.`, {
      path: 'levelId',
      commandId,
      hint: `Known levels: ${draft.levels.map((l) => l.id).join(', ') || 'none'}.`,
    }),
  );
  return null;
}

function resolveMaterialId(
  draft: ProjectModel,
  requested: string | undefined | null,
  elementType: string,
  issues: CommandIssue[],
  commandId: string,
): string {
  if (requested && draft.materials[requested]) return requested;
  if (requested) {
    issues.push(
      warning(
        'missing_reference',
        `Material "${requested}" does not exist; used the default instead.`,
        {
          path: 'materialId',
          commandId,
        },
      ),
    );
  }
  const fallback = DEFAULT_MATERIAL_FOR[elementType] ?? 'mat_generic';
  return draft.materials[fallback] ? fallback : (Object.keys(draft.materials)[0] ?? 'mat_generic');
}

function requireElement(
  draft: ProjectModel,
  id: string,
  issues: CommandIssue[],
  commandId: string,
  path = 'id',
): ArchElement | null {
  const element = draft.elements[id];
  if (!element) {
    issues.push(
      issue('missing_reference', `Element "${id}" does not exist.`, {
        path,
        commandId,
        hint: 'Read the scene summary again — ids change when elements are recreated.',
      }),
    );
    return null;
  }
  return element;
}

function editableTargets(
  draft: ProjectModel,
  ids: readonly string[],
  issues: CommandIssue[],
  commandId: string,
  context: ExecutionContext,
): ArchElement[] {
  const out: ArchElement[] = [];
  for (const id of ids) {
    const element = draft.elements[id];
    if (!element) {
      issues.push(
        issue('missing_reference', `Element "${id}" does not exist.`, { path: 'ids', commandId }),
      );
      continue;
    }
    if (element.locked && !context.allowLockedEdits) {
      issues.push(
        warning('locked', `"${element.name}" is locked and was left unchanged.`, {
          path: 'ids',
          commandId,
          hint: 'Unlock it first, or exclude it from the selection.',
        }),
      );
      continue;
    }
    out.push(element);
  }
  return out;
}

function checkElementBudget(
  draft: ProjectModel,
  adding: number,
  context: ExecutionContext,
  issues: CommandIssue[],
  commandId: string,
): boolean {
  const total = Object.keys(draft.elements).length + adding;
  if (total > MAX_ELEMENTS) {
    issues.push(
      issue(
        'limit_exceeded',
        `This would take the project to ${total} elements (limit ${MAX_ELEMENTS}).`,
        {
          commandId,
          hint: 'Simplify the model, or split the design across projects.',
        },
      ),
    );
    return false;
  }
  const turnCap = context.maxNewElements ?? MAX_ELEMENTS_PER_TURN;
  if (adding > turnCap) {
    issues.push(
      issue(
        'limit_exceeded',
        `A single operation may create at most ${turnCap} elements (asked for ${adding}).`,
        {
          commandId,
          hint: 'Break the request into smaller steps.',
        },
      ),
    );
    return false;
  }
  return true;
}

/** Validates a fully-formed element and inserts it, or reports why it could not. */
function createAndInsert(
  draft: ProjectModel,
  candidate: unknown,
  issues: CommandIssue[],
  commandId: string,
): ArchElement | null {
  const parsed = elementSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const zi of parsed.error.issues.slice(0, 6)) {
      issues.push(issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId }));
    }
    return null;
  }
  insertElement(draft, parsed.data);
  return parsed.data;
}

function rotatePoint(point: Point2, pivot: Point2, angleDeg: number): Point2 {
  const rad = degToRad(angleDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

function scalePoint(point: Point2, pivot: Point2, factor: number): Point2 {
  return { x: pivot.x + (point.x - pivot.x) * factor, y: pivot.y + (point.y - pivot.y) * factor };
}

/** Plan centroid of a set of elements, used as the default pivot. */
function selectionCentroid(model: ProjectModel, ids: readonly string[]): Point2 {
  const bounds = modelBounds(model, ids);
  return { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.z + bounds.max.z) / 2 };
}

/** Captures the geometric fields a transform touches, for exact inversion. */
function geometricSnapshot(element: ArchElement): Record<string, unknown> {
  const keys: Record<string, string[]> = {
    wall: ['start', 'end', 'height', 'thickness', 'baseOffset'],
    slab: ['outline', 'thickness', 'topOffset'],
    room: ['outline', 'ceilingHeight'],
    roof: ['outline', 'baseElevation', 'thickness', 'pitchDeg'],
    stair: ['position', 'rotationDeg', 'width', 'totalRise', 'treadDepth', 'landingDepth'],
    column: ['position', 'width', 'depth', 'height', 'rotationDeg'],
    beam: ['start', 'end', 'width', 'depth', 'baseOffset'],
    railing: ['path', 'height', 'postSpacing'],
    furniture: ['position', 'rotationDeg', 'scale'],
    opening: ['distanceAlongWall', 'width', 'height', 'sillHeight'],
    imported: ['position', 'rotationDeg', 'scale'],
    group: [],
  };
  const snapshot: Record<string, unknown> = {};
  for (const key of keys[element.type] ?? []) {
    snapshot[key] = structuredClone((element as unknown as Record<string, unknown>)[key]);
  }
  return snapshot;
}

function applyPatch(
  draft: ProjectModel,
  element: ArchElement,
  patch: Record<string, unknown>,
  issues: CommandIssue[],
  commandId: string,
): boolean {
  const next = { ...(element as unknown as Record<string, unknown>), ...patch };
  const parsed = elementSchema.safeParse(next);
  if (!parsed.success) {
    for (const zi of parsed.error.issues.slice(0, 6)) {
      issues.push(
        issue('invalid_geometry', `${element.name}: ${zi.message}`, {
          path: zi.path.join('.'),
          commandId,
        }),
      );
    }
    return false;
  }
  draft.elements[element.id] = parsed.data;
  return true;
}

const UNPATCHABLE_KEYS = new Set(['id', 'type', 'parentId']);

/* ------------------------------------------------------------------ */
/* The executor                                                        */
/* ------------------------------------------------------------------ */

export function applyCommand(
  draft: ProjectModel,
  command: ModelingCommand,
  context: ExecutionContext,
): CommandOutcome {
  const outcome = emptyOutcome();
  const issues = outcome.issues;
  const cid = command.id;

  const stamp = <T extends Record<string, unknown>>(fields: T) => ({
    origin: context.source,
    visible: true,
    locked: false,
    parentId: null,
    tags: [],
    notes: '',
    ...fields,
  });

  switch (command.type) {
    /* ---------------------------- creation ---------------------------- */

    case 'create_wall': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;

      const length = Math.hypot(command.end.x - command.start.x, command.end.y - command.start.y);
      if (length < 1) {
        issues.push(
          issue('invalid_geometry', 'Wall start and end points are the same.', {
            path: 'end',
            commandId: cid,
            hint: 'Give the wall a length of at least 1 mm.',
          }),
        );
        break;
      }

      const id = allocateElementId(draft, command.elementId, 'wall');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'wall',
          name: command.name ?? 'Wall',
          levelId,
          start: command.start,
          end: command.end,
          height: command.height ?? draft.levels.find((l) => l.id === levelId)?.height ?? 3000,
          thickness: command.thickness ?? 200,
          alignment: command.alignment ?? 'center',
          baseOffset: command.baseOffset ?? 0,
          materialId: resolveMaterialId(draft, command.materialId, 'wall', issues, cid),
          structural: command.structural ?? false,
          exterior: command.exterior ?? true,
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_rectangular_footprint': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, command.includeSlab ? 5 : 4, context, issues, cid)) break;

      const corners = rectangleOutline(
        command.centre,
        command.width,
        command.depth,
        command.rotationDeg,
      );
      const level = draft.levels.find((l) => l.id === levelId);
      const height = command.height ?? level?.height ?? 3000;
      const thickness = command.thickness ?? 250;
      const materialId = resolveMaterialId(draft, command.materialId, 'wall', issues, cid);
      const prefix = command.namePrefix ?? 'Wall';
      const sides = ['south', 'east', 'north', 'west'];

      for (let i = 0; i < 4; i += 1) {
        const start = corners[i]!;
        const end = corners[(i + 1) % 4]!;
        const id = allocateElementId(draft, undefined, 'wall');
        const created = createAndInsert(
          draft,
          stamp({
            id,
            type: 'wall',
            name: `${prefix} (${sides[i]})`,
            levelId,
            start,
            end,
            height,
            thickness,
            alignment: 'center',
            baseOffset: 0,
            materialId,
            structural: true,
            exterior: true,
            tags: [sides[i]!],
          }),
          issues,
          cid,
        );
        if (created) outcome.createdIds.push(created.id);
      }

      if (command.includeSlab) {
        const slabId = allocateElementId(draft, undefined, 'slab');
        const created = createAndInsert(
          draft,
          stamp({
            id: slabId,
            type: 'slab',
            name: 'Floor slab',
            levelId,
            outline: corners,
            thickness: 250,
            topOffset: 0,
            materialId: resolveMaterialId(draft, undefined, 'slab', issues, cid),
            role: 'floor',
          }),
          issues,
          cid,
        );
        if (created) outcome.createdIds.push(created.id);
      }

      if (outcome.createdIds.length > 0) {
        outcome.inverse.push(hardRemove(outcome.createdIds, 'Undo: remove footprint'));
      }
      break;
    }

    case 'create_slab': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const id = allocateElementId(draft, command.elementId, 'slab');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'slab',
          name: command.name ?? 'Slab',
          levelId,
          outline: command.outline,
          thickness: command.thickness ?? 250,
          topOffset: command.topOffset ?? 0,
          materialId: resolveMaterialId(draft, command.materialId, 'slab', issues, cid),
          role: command.role ?? 'floor',
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_room': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const id = allocateElementId(draft, command.elementId, 'room');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'room',
          name: command.name,
          levelId,
          outline: command.outline,
          ceilingHeight: command.ceilingHeight ?? null,
          programme: command.programme ?? 'other',
          floorMaterialId: command.floorMaterialId ?? null,
          occupancy: command.occupancy ?? 0,
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_opening': {
      const host = requireElement(draft, command.hostId, issues, cid, 'hostId');
      if (!host) break;
      if (host.type !== 'wall') {
        issues.push(
          issue(
            'invalid_geometry',
            `"${host.name}" is a ${host.type}; openings must be hosted by a wall.`,
            {
              path: 'hostId',
              commandId: cid,
            },
          ),
        );
        break;
      }
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;

      const fit = checkOpeningFit(host, command, openingsForWall(draft, host.id));
      issues.push(...fit.issues.map((i) => ({ ...i, commandId: cid })));
      if (hasErrors(fit.issues)) break;

      const id = allocateElementId(draft, command.elementId, 'opening');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'opening',
          name: command.name ?? (command.kind === 'door' ? 'Door' : 'Window'),
          kind: command.kind,
          openingType:
            command.openingType ?? (command.kind === 'door' ? 'single-door' : 'fixed-window'),
          hostId: host.id,
          distanceAlongWall: command.distanceAlongWall,
          width: command.width,
          height: command.height,
          sillHeight: command.sillHeight ?? (command.kind === 'door' ? 0 : 900),
          frameMaterialId: command.frameMaterialId ?? null,
          glazingMaterialId: command.glazingMaterialId ?? null,
          frameDepth: 60,
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.affectedIds.push(host.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'distribute_openings': {
      const host = requireElement(draft, command.hostId, issues, cid, 'hostId');
      if (!host) break;
      if (host.type !== 'wall') {
        issues.push(
          issue(
            'invalid_geometry',
            `"${host.name}" is a ${host.type}; openings must be hosted by a wall.`,
            {
              path: 'hostId',
              commandId: cid,
            },
          ),
        );
        break;
      }
      if (!checkElementBudget(draft, command.count, context, issues, cid)) break;

      const length = wallLength(host);
      const margin = command.edgeMargin ?? Math.min(600, length * 0.1);
      const usable = length - margin * 2;
      if (usable < command.width * command.count) {
        issues.push(
          issue(
            'constraint',
            `${command.count} openings of ${command.width} mm need ${command.width * command.count} mm, but only ${Math.round(usable)} mm of wall is available.`,
            {
              commandId: cid,
              hint: 'Reduce the count, narrow the openings, lengthen the wall, or reduce edgeMargin.',
            },
          ),
        );
        break;
      }

      const bay = usable / command.count;
      const prefix = command.namePrefix ?? (command.kind === 'door' ? 'Door' : 'Window');
      for (let i = 0; i < command.count; i += 1) {
        const centre = margin + bay * (i + 0.5);
        const id = allocateElementId(draft, undefined, 'opening');
        const created = createAndInsert(
          draft,
          stamp({
            id,
            type: 'opening',
            name: `${prefix} ${i + 1}`,
            kind: command.kind,
            openingType:
              command.openingType ?? (command.kind === 'door' ? 'single-door' : 'fixed-window'),
            hostId: host.id,
            distanceAlongWall: centre,
            width: command.width,
            height: command.height,
            sillHeight: command.sillHeight ?? (command.kind === 'door' ? 0 : 900),
            frameMaterialId: null,
            glazingMaterialId: null,
            frameDepth: 60,
          }),
          issues,
          cid,
        );
        if (created) outcome.createdIds.push(created.id);
      }
      outcome.affectedIds.push(host.id);
      if (outcome.createdIds.length > 0) {
        outcome.inverse.push(hardRemove(outcome.createdIds, 'Undo: remove distributed openings'));
      }
      break;
    }

    case 'create_roof': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;

      const outline = command.outline ?? deriveLevelOutline(draft, levelId);
      if (!outline) {
        issues.push(
          issue(
            'missing_reference',
            'No outline was given and the level has no walls to derive one from.',
            {
              path: 'outline',
              commandId: cid,
              hint: 'Create walls or a slab first, or pass an explicit outline.',
            },
          ),
        );
        break;
      }

      const level = draft.levels.find((l) => l.id === levelId);
      const wallTop =
        highestWallTop(draft, levelId) ?? (level ? level.elevation + level.height : 3000);
      const id = allocateElementId(draft, command.elementId, 'roof');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'roof',
          name: command.name ?? 'Roof',
          levelId,
          kind: command.kind,
          outline,
          baseElevation: command.baseElevation ?? wallTop,
          thickness: command.thickness ?? 300,
          pitchDeg: command.pitchDeg ?? (command.kind === 'flat' ? 0 : 25),
          ridgeAxis: command.ridgeAxis ?? 'x',
          overhang: command.overhang ?? 400,
          materialId: resolveMaterialId(draft, command.materialId, 'roof', issues, cid),
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_stair': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const level = draft.levels.find((l) => l.id === levelId);
      const totalRise = command.totalRise ?? level?.height ?? 3000;
      const steps = command.steps ?? Math.max(2, Math.round(totalRise / 175));
      const id = allocateElementId(draft, command.elementId, 'stair');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'stair',
          name: command.name ?? 'Stair',
          levelId,
          position: command.position,
          rotationDeg: command.rotationDeg ?? 0,
          width: command.width ?? 1000,
          totalRise,
          steps,
          treadDepth: command.treadDepth ?? 280,
          shape: command.shape ?? 'straight',
          landingDepth: command.landingDepth ?? 1000,
          materialId: resolveMaterialId(draft, command.materialId, 'stair', issues, cid),
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_column': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const level = draft.levels.find((l) => l.id === levelId);
      const id = allocateElementId(draft, command.elementId, 'column');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'column',
          name: command.name ?? 'Column',
          levelId,
          position: command.position,
          width: command.width ?? 300,
          depth: command.depth ?? command.width ?? 300,
          height: command.height ?? level?.height ?? 3000,
          shape: command.shape ?? 'rectangular',
          rotationDeg: command.rotationDeg ?? 0,
          materialId: resolveMaterialId(draft, command.materialId, 'column', issues, cid),
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_beam': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const id = allocateElementId(draft, command.elementId, 'beam');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'beam',
          name: command.name ?? 'Beam',
          levelId,
          start: command.start,
          end: command.end,
          width: command.width ?? 250,
          depth: command.depth ?? 400,
          baseOffset: command.baseOffset ?? 2400,
          materialId: resolveMaterialId(draft, command.materialId, 'beam', issues, cid),
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'create_railing': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const id = allocateElementId(draft, command.elementId, 'railing');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'railing',
          name: command.name ?? 'Railing',
          levelId,
          path: command.path,
          height: command.height ?? 1100,
          postSpacing: command.postSpacing ?? 1200,
          infill: command.infill ?? 'vertical-bars',
          materialId: resolveMaterialId(draft, command.materialId, 'railing', issues, cid),
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    case 'place_furniture': {
      const levelId = resolveLevelId(draft, command.levelId, issues, cid);
      if (!levelId) break;
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const id = allocateElementId(draft, command.elementId, 'furniture');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'furniture',
          name: command.name ?? command.catalogId,
          levelId,
          catalogId: command.catalogId,
          position: command.position,
          rotationDeg: command.rotationDeg ?? 0,
          scale: command.scale ?? 1,
          materialId: null,
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], `Undo: remove ${created.name}`));
      }
      break;
    }

    /* ---------------------------- editing ---------------------------- */

    case 'set_element_properties': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      const forbidden = Object.keys(command.patch).filter((key) => UNPATCHABLE_KEYS.has(key));
      if (forbidden.length > 0) {
        issues.push(
          issue('forbidden_command', `Cannot patch ${forbidden.join(', ')}.`, {
            path: 'patch',
            commandId: cid,
            hint: 'Element identity and class are immutable. Delete and recreate instead.',
          }),
        );
        break;
      }
      for (const element of targets) {
        const previous: Record<string, unknown> = {};
        for (const key of Object.keys(command.patch)) {
          previous[key] = structuredClone((element as unknown as Record<string, unknown>)[key]);
        }
        if (applyPatch(draft, element, command.patch, issues, cid)) {
          outcome.affectedIds.push(element.id);
          outcome.inverse.push({
            id: createId('cmd'),
            v: 1,
            type: 'set_element_properties',
            description: `Undo: restore ${element.name}`,
            ids: [element.id],
            patch: previous,
          });
          // A wall edit changes the geometry of everything it hosts.
          if (element.type === 'wall') {
            outcome.affectedIds.push(...openingsForWall(draft, element.id).map((o) => o.id));
          }
        }
      }
      break;
    }

    case 'move_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      for (const element of targets) {
        const before = geometricSnapshot(element);
        const moved = translateElement(element, command.delta, issues, cid);
        if (moved && applyPatch(draft, element, moved, issues, cid)) {
          outcome.affectedIds.push(element.id);
          outcome.inverse.push(restorePatch(element.id, before, `Undo: move ${element.name}`));
        }
      }
      break;
    }

    case 'rotate_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      const pivot =
        command.pivot ??
        selectionCentroid(
          draft,
          targets.map((t) => t.id),
        );
      for (const element of targets) {
        const before = geometricSnapshot(element);
        const patch = rotateElement(element, pivot, command.angleDeg);
        if (patch && applyPatch(draft, element, patch, issues, cid)) {
          outcome.affectedIds.push(element.id);
          outcome.inverse.push(restorePatch(element.id, before, `Undo: rotate ${element.name}`));
        }
      }
      break;
    }

    case 'scale_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      const pivot =
        command.pivot ??
        selectionCentroid(
          draft,
          targets.map((t) => t.id),
        );
      for (const element of targets) {
        const before = geometricSnapshot(element);
        const patch = scaleElement(element, pivot, command.factor, command.scaleVertical);
        if (patch && applyPatch(draft, element, patch, issues, cid)) {
          outcome.affectedIds.push(element.id);
          outcome.inverse.push(restorePatch(element.id, before, `Undo: scale ${element.name}`));
        }
      }
      break;
    }

    case 'delete_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      if (targets.length === 0) break;
      const { removed, orderHints } = cascadeRemove(
        draft,
        targets.map((t) => t.id),
      );
      outcome.affectedIds.push(...removed.map((r) => r.id));
      if (removed.length > 0) {
        outcome.inverse.push({
          id: createId('cmd'),
          v: 1,
          type: 'restore_elements',
          description: `Undo: restore ${removed.length} element(s)`,
          elements: removed,
          orderHints,
        });
      }
      break;
    }

    case 'duplicate_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, {
        ...context,
        allowLockedEdits: true,
      });
      if (!checkElementBudget(draft, targets.length, context, issues, cid)) break;
      const offset = command.offset ?? { x: 1000, y: 0, z: 0 };
      const idMap = new Map<string, string>();

      // Two passes so hosted openings can be re-pointed at the copied wall.
      for (const element of targets) {
        idMap.set(element.id, allocateElementId(draft, undefined, element.type));
      }
      for (const element of targets) {
        const copy = structuredClone(element) as unknown as Record<string, unknown>;
        copy.id = idMap.get(element.id)!;
        copy.name = `${element.name} copy`;
        copy.origin = context.source;
        copy.parentId = null;
        if (element.type === 'opening') {
          copy.hostId = idMap.get(element.hostId) ?? element.hostId;
        }
        if (element.type === 'group') {
          copy.childIds = element.childIds
            .map((c) => idMap.get(c) ?? c)
            .filter((c) => idMap.has(c) || draft.elements[c]);
        }
        const translated = translateElement(copy as unknown as ArchElement, offset, issues, cid);
        Object.assign(copy, translated ?? {});
        const created = createAndInsert(draft, copy, issues, cid);
        if (created) outcome.createdIds.push(created.id);
      }
      if (outcome.createdIds.length > 0) {
        outcome.inverse.push(hardRemove(outcome.createdIds, 'Undo: remove duplicates'));
      }
      break;
    }

    case 'array_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, {
        ...context,
        allowLockedEdits: true,
      });
      const copies = (command.count - 1) * targets.length;
      if (!checkElementBudget(draft, copies, context, issues, cid)) break;

      for (let n = 1; n < command.count; n += 1) {
        const idMap = new Map<string, string>();
        for (const element of targets) {
          idMap.set(element.id, allocateElementId(draft, undefined, element.type));
        }
        for (const element of targets) {
          const copy = structuredClone(element) as unknown as Record<string, unknown>;
          copy.id = idMap.get(element.id)!;
          copy.name = `${element.name} ${n + 1}`;
          copy.origin = context.source;
          copy.parentId = null;
          if (element.type === 'opening') copy.hostId = idMap.get(element.hostId) ?? element.hostId;
          const delta = {
            x: command.step.x * n,
            y: command.step.y * n,
            z: command.step.z * n,
          };
          Object.assign(
            copy,
            translateElement(copy as unknown as ArchElement, delta, issues, cid) ?? {},
          );
          const created = createAndInsert(draft, copy, issues, cid);
          if (created) outcome.createdIds.push(created.id);
        }
      }
      if (outcome.createdIds.length > 0) {
        outcome.inverse.push(hardRemove(outcome.createdIds, 'Undo: remove array'));
      }
      break;
    }

    case 'align_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      if (targets.length < 2) break;
      const axisKey = command.axis === 'x' ? 'x' : command.axis === 'y' ? 'z' : 'y';
      const spans = targets.map((element) => {
        const bounds = modelBounds(draft, [element.id]);
        return {
          element,
          min: bounds.min[axisKey],
          max: bounds.max[axisKey],
          centre: (bounds.min[axisKey] + bounds.max[axisKey]) / 2,
        };
      });
      const anchor =
        command.mode === 'min'
          ? Math.min(...spans.map((s) => s.min))
          : command.mode === 'max'
            ? Math.max(...spans.map((s) => s.max))
            : spans.reduce((sum, s) => sum + s.centre, 0) / spans.length;

      for (const span of spans) {
        const current =
          command.mode === 'min' ? span.min : command.mode === 'max' ? span.max : span.centre;
        const shift = anchor - current;
        if (Math.abs(shift) < 0.5) continue;
        const delta = {
          x: command.axis === 'x' ? shift : 0,
          y: command.axis === 'y' ? shift : 0,
          z: command.axis === 'z' ? shift : 0,
        };
        const before = geometricSnapshot(span.element);
        const patch = translateElement(span.element, delta, issues, cid);
        if (patch && applyPatch(draft, span.element, patch, issues, cid)) {
          outcome.affectedIds.push(span.element.id);
          outcome.inverse.push(
            restorePatch(span.element.id, before, `Undo: align ${span.element.name}`),
          );
        }
      }
      break;
    }

    case 'distribute_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      if (targets.length < 3) break;
      const axisKey = command.axis === 'x' ? 'x' : 'z';
      const spans = targets
        .map((element) => {
          const bounds = modelBounds(draft, [element.id]);
          return { element, centre: (bounds.min[axisKey] + bounds.max[axisKey]) / 2 };
        })
        .sort((a, b) => a.centre - b.centre);

      const first = spans[0]!.centre;
      const last = spans[spans.length - 1]!.centre;
      const step = command.spacing ?? (last - first) / (spans.length - 1);

      spans.forEach((span, index) => {
        const targetCentre = first + step * index;
        const shift = targetCentre - span.centre;
        if (Math.abs(shift) < 0.5) return;
        const delta = {
          x: command.axis === 'x' ? shift : 0,
          y: command.axis === 'y' ? shift : 0,
          z: 0,
        };
        const before = geometricSnapshot(span.element);
        const patch = translateElement(span.element, delta, issues, cid);
        if (patch && applyPatch(draft, span.element, patch, issues, cid)) {
          outcome.affectedIds.push(span.element.id);
          outcome.inverse.push(
            restorePatch(span.element.id, before, `Undo: distribute ${span.element.name}`),
          );
        }
      });
      break;
    }

    case 'set_visibility':
    case 'set_lock': {
      const key = command.type === 'set_visibility' ? 'visible' : 'locked';
      const value = command.type === 'set_visibility' ? command.visible : command.locked;
      for (const id of command.ids) {
        const element = requireElement(draft, id, issues, cid, 'ids');
        if (!element) continue;
        const previous = key === 'visible' ? element.visible : element.locked;
        if (previous === value) continue;
        if (applyPatch(draft, element, { [key]: value }, issues, cid)) {
          outcome.affectedIds.push(id);
          outcome.inverse.push({
            id: createId('cmd'),
            v: 1,
            type: 'set_element_properties',
            description: `Undo: restore ${key}`,
            ids: [id],
            patch: { [key]: previous },
          });
        }
      }
      break;
    }

    case 'rename_element': {
      const element = requireElement(draft, command.elementId, issues, cid, 'elementId');
      if (!element) break;
      const previous = element.name;
      if (applyPatch(draft, element, { name: command.name }, issues, cid)) {
        outcome.affectedIds.push(element.id);
        outcome.inverse.push({
          id: createId('cmd'),
          v: 1,
          type: 'rename_element',
          description: 'Undo: restore name',
          elementId: element.id,
          name: previous,
        });
      }
      break;
    }

    case 'group_elements': {
      const targets = editableTargets(draft, command.ids, issues, cid, context);
      if (targets.length < 2) {
        issues.push(
          issue('invalid_geometry', 'A group needs at least two members.', { commandId: cid }),
        );
        break;
      }
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const groupId = allocateElementId(draft, command.groupId, 'group');
      const created = createAndInsert(
        draft,
        stamp({
          id: groupId,
          type: 'group',
          name: command.name ?? 'Group',
          childIds: targets.map((t) => t.id),
        }),
        issues,
        cid,
      );
      if (!created) break;
      for (const element of targets) {
        draft.elements[element.id] = { ...element, parentId: groupId } as ArchElement;
      }
      outcome.createdIds.push(groupId);
      outcome.affectedIds.push(...targets.map((t) => t.id));
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'ungroup_elements',
        description: 'Undo: ungroup',
        groupId,
      });
      break;
    }

    case 'ungroup_elements': {
      const group = requireElement(draft, command.groupId, issues, cid, 'groupId');
      if (!group) break;
      if (group.type !== 'group') {
        issues.push(
          issue('invalid_geometry', `"${group.name}" is not a group.`, { commandId: cid }),
        );
        break;
      }
      const memberIds = [...group.childIds];
      for (const childId of memberIds) {
        const child = draft.elements[childId];
        if (child) draft.elements[childId] = { ...child, parentId: null } as ArchElement;
      }
      delete draft.elements[group.id];
      draft.elementOrder = draft.elementOrder.filter((id) => id !== group.id);
      outcome.affectedIds.push(...memberIds);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'group_elements',
        description: 'Undo: regroup',
        ids: memberIds,
        name: group.name,
        groupId: group.id,
      } as ModelingCommand);
      break;
    }

    case 'join_walls': {
      const levelId = command.levelId ?? null;
      const walls = Object.values(draft.elements).filter(
        (e): e is Wall =>
          e.type === 'wall' &&
          !e.locked &&
          (command.ids ? command.ids.includes(e.id) : true) &&
          (levelId ? e.levelId === levelId : true),
      );
      if (walls.length < 2) break;

      const before = new Map(walls.map((w) => [w.id, geometricSnapshot(w)]));
      const changed = joinWallEndpoints(walls, command.toleranceMm);
      for (const wallId of changed) {
        const wall = draft.elements[wallId];
        if (!wall) continue;
        outcome.affectedIds.push(wallId);
        outcome.inverse.push(
          restorePatch(wallId, before.get(wallId) ?? {}, `Undo: unjoin ${wall.name}`),
        );
      }
      if (changed.size === 0) {
        issues.push(
          warning('conflict', 'No wall endpoints were close enough to join.', {
            commandId: cid,
            hint: `Increase toleranceMm above ${command.toleranceMm}.`,
          }),
        );
      }
      break;
    }

    case 'split_wall': {
      const wall = requireElement(draft, command.elementId, issues, cid, 'elementId');
      if (!wall) break;
      if (wall.type !== 'wall') {
        issues.push(issue('invalid_geometry', `"${wall.name}" is not a wall.`, { commandId: cid }));
        break;
      }
      const length = wallLength(wall);
      if (command.distance <= 1 || command.distance >= length - 1) {
        issues.push(
          issue(
            'invalid_geometry',
            `Split distance must be between 1 and ${Math.round(length) - 1} mm.`,
            {
              path: 'distance',
              commandId: cid,
            },
          ),
        );
        break;
      }
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;

      const t = command.distance / length;
      const splitPoint: Point2 = {
        x: wall.start.x + (wall.end.x - wall.start.x) * t,
        y: wall.start.y + (wall.end.y - wall.start.y) * t,
      };
      const originalEnd = { ...wall.end };
      const before = geometricSnapshot(wall);

      const newId = allocateElementId(draft, undefined, 'wall');
      const created = createAndInsert(
        draft,
        {
          ...structuredClone(wall),
          id: newId,
          name: `${wall.name} (2)`,
          start: splitPoint,
          end: originalEnd,
        },
        issues,
        cid,
      );
      if (!created) break;

      applyPatch(draft, wall, { end: splitPoint }, issues, cid);

      // Openings past the split move to the new wall, keeping their position.
      const movedOpenings: Array<{ id: string; hostId: string; distanceAlongWall: number }> = [];
      for (const opening of openingsForWall(draft, wall.id)) {
        if (opening.distanceAlongWall > command.distance) {
          movedOpenings.push({
            id: opening.id,
            hostId: wall.id,
            distanceAlongWall: opening.distanceAlongWall,
          });
          draft.elements[opening.id] = {
            ...opening,
            hostId: newId,
            distanceAlongWall: opening.distanceAlongWall - command.distance,
          } satisfies Opening;
        }
      }

      outcome.createdIds.push(newId);
      outcome.affectedIds.push(wall.id, ...movedOpenings.map((m) => m.id));
      outcome.inverse.push(hardRemove([newId], 'Undo: remove split segment'));
      outcome.inverse.push(restorePatch(wall.id, before, `Undo: unsplit ${wall.name}`));
      for (const moved of movedOpenings) {
        outcome.inverse.push({
          id: createId('cmd'),
          v: 1,
          type: 'set_element_properties',
          description: 'Undo: rehost opening',
          ids: [moved.id],
          patch: { hostId: moved.hostId, distanceAlongWall: moved.distanceAlongWall },
        });
      }
      break;
    }

    /* ---------------------------- levels ---------------------------- */

    case 'create_level': {
      if (draft.levels.length >= MAX_LEVELS) {
        issues.push(
          issue('limit_exceeded', `A project may have at most ${MAX_LEVELS} levels.`, {
            commandId: cid,
          }),
        );
        break;
      }
      const previous = structuredClone(draft.levels);
      const highest = draft.levels.reduce(
        (max, l) => (l.index > max.index ? l : max),
        draft.levels[0]!,
      );
      const id = uniqueId(command.levelId ?? createId('lvl'), takenIds(draft));
      const parsed = levelSchema.safeParse({
        id,
        name: command.name,
        elevation: command.elevation ?? highest.elevation + highest.height,
        height: command.height ?? highest.height,
        index: command.index ?? highest.index + 1,
        visible: true,
      });
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      draft.levels.push(parsed.data);
      draft.levels.sort((a, b) => a.index - b.index);
      outcome.createdIds.push(id);
      outcome.inverse.push(replaceLevels(previous, 'Undo: remove level'));
      break;
    }

    case 'update_level': {
      const level = draft.levels.find((l) => l.id === command.levelId);
      if (!level) {
        issues.push(
          issue('missing_reference', `Level "${command.levelId}" does not exist.`, {
            path: 'levelId',
            commandId: cid,
          }),
        );
        break;
      }
      const previous = structuredClone(draft.levels);
      const heightDelta = command.height !== undefined ? command.height - level.height : 0;
      const elevationDelta =
        command.elevation !== undefined ? command.elevation - level.elevation : 0;

      const next: Level = {
        ...level,
        name: command.name ?? level.name,
        elevation: command.elevation ?? level.elevation,
        height: command.height ?? level.height,
        visible: command.visible ?? level.visible,
      };
      const parsed = levelSchema.safeParse(next);
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      Object.assign(level, parsed.data);

      if (command.cascade && (heightDelta !== 0 || elevationDelta !== 0)) {
        for (const other of draft.levels) {
          if (other.id === level.id) continue;
          if (other.index > level.index) other.elevation += heightDelta + elevationDelta;
        }
      }

      // Walls that ran full storey height follow the level height, which is what
      // "make the ground-floor ceiling 2.7 m" means in practice.
      if (heightDelta !== 0) {
        const previousHeight = level.height - heightDelta;
        for (const element of Object.values(draft.elements)) {
          if (element.type === 'wall' && element.levelId === level.id && !element.locked) {
            if (Math.abs(element.height - previousHeight) < 1) {
              element.height = level.height;
              outcome.affectedIds.push(element.id);
            }
          }
        }
      }

      outcome.affectedIds.push(level.id);
      outcome.inverse.push(replaceLevels(previous, `Undo: restore level ${level.name}`));
      if (heightDelta !== 0) {
        // Wall heights were changed as a side effect; capture them too.
        const wallPatches = Object.values(draft.elements).filter(
          (e): e is Wall => e.type === 'wall' && e.levelId === level.id,
        );
        for (const wall of wallPatches) {
          const original = (previous.find((l) => l.id === level.id)?.height ?? wall.height) - 0;
          if (Math.abs(wall.height - level.height) < 1) {
            outcome.inverse.push({
              id: createId('cmd'),
              v: 1,
              type: 'set_element_properties',
              description: 'Undo: restore wall height',
              ids: [wall.id],
              patch: { height: original },
            });
          }
        }
      }
      break;
    }

    case 'delete_level': {
      if (draft.levels.length <= 1) {
        issues.push(
          issue('constraint', 'A project must keep at least one level.', { commandId: cid }),
        );
        break;
      }
      const level = draft.levels.find((l) => l.id === command.levelId);
      if (!level) {
        issues.push(
          issue('missing_reference', `Level "${command.levelId}" does not exist.`, {
            path: 'levelId',
            commandId: cid,
          }),
        );
        break;
      }
      const previousLevels = structuredClone(draft.levels);
      const doomedIds = Object.values(draft.elements)
        .filter((e) => 'levelId' in e && e.levelId === level.id)
        .map((e) => e.id);
      const { removed, orderHints } = cascadeRemove(draft, doomedIds);
      draft.levels = draft.levels.filter((l) => l.id !== level.id);

      outcome.affectedIds.push(...removed.map((r) => r.id));
      if (removed.length > 0) {
        outcome.inverse.push({
          id: createId('cmd'),
          v: 1,
          type: 'restore_elements',
          description: 'Undo: restore level contents',
          elements: removed,
          orderHints,
        });
      }
      outcome.inverse.push(replaceLevels(previousLevels, `Undo: restore level ${level.name}`));
      break;
    }

    /* ---------------------------- materials ---------------------------- */

    case 'create_material': {
      const previous = structuredClone(draft.materials);
      const id = uniqueId(command.materialId ?? createId('mat'), takenIds(draft));
      const parsed = materialSchema.safeParse({
        id,
        name: command.name,
        category: command.category ?? 'generic',
        color: command.color,
        roughness: command.roughness ?? 0.8,
        metalness: command.metalness ?? 0,
        opacity: command.opacity ?? 1,
        textureRef: command.textureRef ?? null,
        textureScaleMm: command.textureScaleMm ?? 1000,
        emissiveIntensity: 0,
        description: command.description ?? '',
      });
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      draft.materials[id] = parsed.data;
      outcome.createdIds.push(id);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_materials',
        description: 'Undo: restore material library',
        materials: previous,
      });
      break;
    }

    case 'update_material': {
      const material = draft.materials[command.materialId];
      if (!material) {
        issues.push(
          issue('missing_reference', `Material "${command.materialId}" does not exist.`, {
            path: 'materialId',
            commandId: cid,
            hint: `Known materials: ${Object.keys(draft.materials).slice(0, 12).join(', ')}.`,
          }),
        );
        break;
      }
      const previous = structuredClone(draft.materials);
      const merged = {
        ...material,
        ...Object.fromEntries(
          Object.entries({
            name: command.name,
            category: command.category,
            color: command.color,
            roughness: command.roughness,
            metalness: command.metalness,
            opacity: command.opacity,
            textureRef: command.textureRef,
            textureScaleMm: command.textureScaleMm,
            emissiveIntensity: command.emissiveIntensity,
            description: command.description,
          }).filter(([, value]) => value !== undefined),
        ),
      };
      const parsed = materialSchema.safeParse(merged);
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      draft.materials[command.materialId] = parsed.data;
      outcome.affectedIds.push(
        ...Object.values(draft.elements)
          .filter((e) => 'materialId' in e && e.materialId === command.materialId)
          .map((e) => e.id),
      );
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_materials',
        description: 'Undo: restore material library',
        materials: previous,
      });
      break;
    }

    case 'assign_material': {
      if (!draft.materials[command.materialId]) {
        issues.push(
          issue('missing_reference', `Material "${command.materialId}" does not exist.`, {
            path: 'materialId',
            commandId: cid,
          }),
        );
        break;
      }
      const slotKey =
        command.slot === 'floor'
          ? 'floorMaterialId'
          : command.slot === 'frame'
            ? 'frameMaterialId'
            : command.slot === 'glazing'
              ? 'glazingMaterialId'
              : 'materialId';

      for (const element of editableTargets(draft, command.ids, issues, cid, context)) {
        if (!(slotKey in element)) {
          issues.push(
            warning(
              'unsupported',
              `${element.type} "${element.name}" has no ${command.slot} material slot.`,
              {
                commandId: cid,
              },
            ),
          );
          continue;
        }
        const previous = (element as unknown as Record<string, unknown>)[slotKey];
        if (applyPatch(draft, element, { [slotKey]: command.materialId }, issues, cid)) {
          outcome.affectedIds.push(element.id);
          outcome.inverse.push({
            id: createId('cmd'),
            v: 1,
            type: 'set_element_properties',
            description: `Undo: restore material on ${element.name}`,
            ids: [element.id],
            patch: { [slotKey]: previous },
          });
        }
      }
      break;
    }

    /* ---------------------------- environment ---------------------------- */

    case 'update_environment': {
      const previous = structuredClone(draft.environment);
      const patch = Object.fromEntries(
        Object.entries({
          preset: command.preset,
          sunAzimuthDeg: command.sunAzimuthDeg,
          sunAltitudeDeg: command.sunAltitudeDeg,
          sunIntensity: command.sunIntensity,
          ambientIntensity: command.ambientIntensity,
          skyEnabled: command.skyEnabled,
          backgroundColor: command.backgroundColor,
          groundColor: command.groundColor,
          shadowsEnabled: command.shadowsEnabled,
          exposure: command.exposure,
          weather: command.weather,
        }).filter(([, value]) => value !== undefined),
      );
      const withPreset = command.preset
        ? { ...applyEnvironmentPreset(command.preset), ...patch }
        : patch;
      const parsed = environmentSchema.safeParse({ ...draft.environment, ...withPreset });
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      draft.environment = parsed.data;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_environment',
        description: 'Undo: restore environment',
        environment: previous,
      });
      break;
    }

    case 'add_light': {
      const previous = structuredClone(draft.environment);
      const id = uniqueId(
        command.light.id ?? createId('light'),
        new Set(draft.environment.lights.map((l) => l.id)),
      );
      const parsed = environmentSchema.safeParse({
        ...draft.environment,
        lights: [...draft.environment.lights, { ...command.light, id }],
      });
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      draft.environment = parsed.data;
      outcome.createdIds.push(id);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_environment',
        description: 'Undo: remove light',
        environment: previous,
      });
      break;
    }

    case 'update_light':
    case 'remove_light': {
      const previous = structuredClone(draft.environment);
      const targetId = command.lightId;
      if (!draft.environment.lights.some((l) => l.id === targetId)) {
        issues.push(
          issue('missing_reference', `Light "${targetId}" does not exist.`, {
            path: 'lightId',
            commandId: cid,
          }),
        );
        break;
      }
      const lights =
        command.type === 'remove_light'
          ? draft.environment.lights.filter((l) => l.id !== targetId)
          : draft.environment.lights.map((l) =>
              l.id === targetId ? { ...l, ...command.patch } : l,
            );
      const parsed = environmentSchema.safeParse({ ...draft.environment, lights });
      if (!parsed.success) {
        for (const zi of parsed.error.issues) {
          issues.push(
            issue('invalid_geometry', zi.message, { path: zi.path.join('.'), commandId: cid }),
          );
        }
        break;
      }
      draft.environment = parsed.data;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_environment',
        description: 'Undo: restore lighting',
        environment: previous,
      });
      break;
    }

    /* ---------------------------- views & project ---------------------------- */

    case 'save_view': {
      const previous = structuredClone(draft.views);
      const id = uniqueId(
        command.viewId ?? createId('view'),
        new Set(draft.views.map((v) => v.id)),
      );
      draft.views = [
        ...draft.views.filter((v) => v.id !== id),
        {
          id,
          name: command.name,
          mode: command.mode,
          position: command.position,
          target: command.target,
          zoom: command.zoom,
          sectionElevation: command.sectionElevation ?? null,
        },
      ];
      outcome.createdIds.push(id);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_views',
        description: 'Undo: restore saved views',
        views: previous,
      });
      break;
    }

    case 'add_measurement': {
      const previous = structuredClone(draft.measurements);
      const id = uniqueId(
        command.measurementId ?? createId('meas'),
        new Set(draft.measurements.map((m) => m.id)),
      );
      const value =
        command.kind === 'distance' ? measureDistance(command.points) : measureArea(command.points);
      draft.measurements = [
        ...draft.measurements,
        { id, kind: command.kind, label: command.label ?? '', points: command.points, value },
      ];
      outcome.createdIds.push(id);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_measurements',
        description: 'Undo: remove measurement',
        measurements: previous,
      });
      break;
    }

    case 'remove_measurement': {
      const previous = structuredClone(draft.measurements);
      if (!previous.some((m) => m.id === command.measurementId)) {
        issues.push(
          issue('missing_reference', `Measurement "${command.measurementId}" does not exist.`, {
            commandId: cid,
          }),
        );
        break;
      }
      draft.measurements = draft.measurements.filter((m) => m.id !== command.measurementId);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_measurements',
        description: 'Undo: restore measurement',
        measurements: previous,
      });
      break;
    }

    case 'set_units':
    case 'set_project_info': {
      const previous = {
        name: draft.name,
        projectDescription: draft.description,
        units: draft.units,
        site: structuredClone(draft.site),
      };
      if (command.type === 'set_units') {
        draft.units = command.units;
      } else {
        if (command.name !== undefined) draft.name = command.name;
        if (command.projectDescription !== undefined)
          draft.description = command.projectDescription;
        if (command.locationLabel !== undefined) draft.site.locationLabel = command.locationLabel;
        if (command.latitude !== undefined) draft.site.latitude = command.latitude ?? null;
        if (command.longitude !== undefined) draft.site.longitude = command.longitude ?? null;
        if (command.northAngleDeg !== undefined) draft.site.northAngleDeg = command.northAngleDeg;
        if (command.standardsProfile !== undefined)
          draft.site.standardsProfile = command.standardsProfile;
        if (command.climateNotes !== undefined) draft.site.climateNotes = command.climateNotes;
      }
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_project_info',
        description: 'Undo: restore project information',
        ...previous,
      });
      break;
    }

    case 'add_constraint': {
      const previous = structuredClone(draft.constraints);
      const id = uniqueId(
        command.constraint.id ?? createId('cons'),
        new Set(draft.constraints.map((c) => c.id)),
      );
      draft.constraints = [
        ...draft.constraints,
        {
          id,
          kind: command.constraint.kind,
          description: command.constraint.description,
          targetIds: command.constraint.targetIds ?? [],
          value: command.constraint.value ?? null,
          active: command.constraint.active ?? true,
        },
      ];
      outcome.createdIds.push(id);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_constraints',
        description: 'Undo: remove constraint',
        constraints: previous,
      });
      break;
    }

    case 'remove_constraint': {
      const previous = structuredClone(draft.constraints);
      draft.constraints = draft.constraints.filter((c) => c.id !== command.constraintId);
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_constraints',
        description: 'Undo: restore constraint',
        constraints: previous,
      });
      break;
    }

    case 'import_file': {
      if (!checkElementBudget(draft, 1, context, issues, cid)) break;
      const id = allocateElementId(draft, undefined, 'imported');
      const created = createAndInsert(
        draft,
        stamp({
          id,
          type: 'imported',
          name: command.name ?? 'Imported model',
          origin: 'import',
          levelId: command.levelId ?? defaultLevelId(draft),
          assetRef: command.assetRef,
          sourceFormat: command.format === 'json' ? 'gltf' : command.format,
          position: command.position ?? { x: 0, y: 0, z: 0 },
          rotationDeg: command.rotationDeg ?? 0,
          scale: command.scale ?? 1,
          semanticTag: null,
          referenceOnly: true,
        }),
        issues,
        cid,
      );
      if (created) {
        outcome.createdIds.push(created.id);
        outcome.inverse.push(hardRemove([created.id], 'Undo: remove import'));
      }
      break;
    }

    /* ---------------------------- internal ---------------------------- */

    case 'restore_elements': {
      const sorted = [...command.orderHints].sort((a, b) => a.index - b.index);
      const restoredIds: string[] = [];
      for (const element of command.elements) {
        draft.elements[element.id] = element;
        restoredIds.push(element.id);
      }
      for (const hint of sorted) {
        if (!draft.elementOrder.includes(hint.id)) {
          draft.elementOrder.splice(Math.min(hint.index, draft.elementOrder.length), 0, hint.id);
        }
      }
      for (const element of command.elements) {
        if (!draft.elementOrder.includes(element.id)) draft.elementOrder.push(element.id);
        if (element.parentId) {
          const parent = draft.elements[element.parentId];
          if (parent?.type === 'group' && !parent.childIds.includes(element.id)) {
            parent.childIds.push(element.id);
          }
        }
      }
      outcome.affectedIds.push(...restoredIds);
      outcome.inverse.push(hardRemove(restoredIds, 'Redo: remove restored elements'));
      break;
    }

    case 'remove_elements_hard': {
      const previousOrder = draft.elementOrder;
      const removed: ArchElement[] = [];
      const orderHints: Array<{ id: string; index: number }> = [];
      previousOrder.forEach((id, index) => {
        if (command.ids.includes(id) && draft.elements[id]) {
          removed.push(structuredClone(draft.elements[id]!));
          orderHints.push({ id, index });
        }
      });
      for (const id of command.ids) delete draft.elements[id];
      draft.elementOrder = draft.elementOrder.filter((id) => !command.ids.includes(id));
      for (const element of Object.values(draft.elements)) {
        if (element.type === 'group') {
          element.childIds = element.childIds.filter((c) => !command.ids.includes(c));
        }
        if (element.parentId && command.ids.includes(element.parentId)) element.parentId = null;
      }
      outcome.affectedIds.push(...removed.map((r) => r.id));
      if (removed.length > 0) {
        outcome.inverse.push({
          id: createId('cmd'),
          v: 1,
          type: 'restore_elements',
          description: 'Redo: restore elements',
          elements: removed,
          orderHints,
        });
      }
      break;
    }

    case 'replace_levels': {
      const previous = structuredClone(draft.levels);
      draft.levels = command.levels;
      outcome.inverse.push(replaceLevels(previous, 'Redo: restore levels'));
      break;
    }

    case 'replace_materials': {
      const previous = structuredClone(draft.materials);
      draft.materials = command.materials;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_materials',
        description: 'Redo: restore materials',
        materials: previous,
      });
      break;
    }

    case 'replace_environment': {
      const previous = structuredClone(draft.environment);
      draft.environment = command.environment;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_environment',
        description: 'Redo: restore environment',
        environment: previous,
      });
      break;
    }

    case 'replace_views': {
      const previous = structuredClone(draft.views);
      draft.views = command.views;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_views',
        description: 'Redo: restore views',
        views: previous,
      });
      break;
    }

    case 'replace_constraints': {
      const previous = structuredClone(draft.constraints);
      draft.constraints = command.constraints;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_constraints',
        description: 'Redo: restore constraints',
        constraints: previous,
      });
      break;
    }

    case 'replace_measurements': {
      const previous = structuredClone(draft.measurements);
      draft.measurements = command.measurements;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_measurements',
        description: 'Redo: restore measurements',
        measurements: previous,
      });
      break;
    }

    case 'replace_project_info': {
      const previous = {
        name: draft.name,
        projectDescription: draft.description,
        units: draft.units,
        site: structuredClone(draft.site),
      };
      draft.name = command.name;
      draft.description = command.projectDescription;
      draft.units = command.units;
      draft.site = command.site;
      outcome.inverse.push({
        id: createId('cmd'),
        v: 1,
        type: 'replace_project_info',
        description: 'Redo: restore project information',
        ...previous,
      });
      break;
    }

    /* ---------------------------- host effects ---------------------------- */

    case 'export_project':
    case 'create_snapshot':
    case 'restore_snapshot':
    case 'set_camera':
    case 'restore_view':
    case 'focus_elements':
    case 'select_elements': {
      const { id: _id, v: _v, type, description: _description, ...payload } = command;
      outcome.hostEffects.push({
        commandId: cid,
        type,
        payload: payload as Record<string, unknown>,
      });
      if (command.type === 'focus_elements' || command.type === 'select_elements') {
        outcome.affectedIds.push(...command.ids);
      }
      break;
    }

    default: {
      const exhaustive: never = command;
      issues.push(
        issue('unknown_command', `Unhandled command type: ${JSON.stringify(exhaustive)}`, {
          commandId: cid,
        }),
      );
      break;
    }
  }

  outcome.ok = !hasErrors(outcome.issues);
  outcome.affectedIds = [...new Set([...outcome.affectedIds, ...outcome.createdIds])];
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Inverse-command constructors                                        */
/* ------------------------------------------------------------------ */

function hardRemove(ids: string[], description: string): ModelingCommand {
  return { id: createId('cmd'), v: 1, type: 'remove_elements_hard', description, ids };
}

function restorePatch(
  id: string,
  patch: Record<string, unknown>,
  description: string,
): ModelingCommand {
  return {
    id: createId('cmd'),
    v: 1,
    type: 'set_element_properties',
    description,
    ids: [id],
    patch,
  };
}

function replaceLevels(levels: Level[], description: string): ModelingCommand {
  return { id: createId('cmd'), v: 1, type: 'replace_levels', description, levels };
}

/* ------------------------------------------------------------------ */
/* Geometry helpers used by the executor                               */
/* ------------------------------------------------------------------ */

/**
 * Vertical movement is expressed differently per element type. Types with no
 * vertical parameter (columns, stairs, railings, furniture) sit on their level
 * by definition, so a Z move on them is reported rather than silently dropped.
 */
function translateElement(
  element: ArchElement,
  delta: { x: number; y: number; z: number },
  issues: CommandIssue[],
  commandId: string,
): Record<string, unknown> | null {
  const shift = (p: Point2): Point2 => ({ x: p.x + delta.x, y: p.y + delta.y });
  const patch: Record<string, unknown> = {};

  switch (element.type) {
    case 'wall':
      patch.start = shift(element.start);
      patch.end = shift(element.end);
      if (delta.z !== 0) patch.baseOffset = element.baseOffset + delta.z;
      break;
    case 'beam':
      patch.start = shift(element.start);
      patch.end = shift(element.end);
      if (delta.z !== 0) patch.baseOffset = element.baseOffset + delta.z;
      break;
    case 'slab':
      patch.outline = element.outline.map(shift);
      if (delta.z !== 0) patch.topOffset = element.topOffset + delta.z;
      break;
    case 'room':
      patch.outline = element.outline.map(shift);
      break;
    case 'roof':
      patch.outline = element.outline.map(shift);
      if (delta.z !== 0) patch.baseElevation = element.baseElevation + delta.z;
      break;
    case 'railing':
      patch.path = element.path.map(shift);
      break;
    case 'stair':
    case 'column':
    case 'furniture':
      patch.position = shift(element.position);
      break;
    case 'imported':
      patch.position = {
        x: element.position.x + delta.x,
        y: element.position.y + delta.y,
        z: element.position.z + delta.z,
      };
      break;
    case 'opening':
      // An opening moves along its host wall, not through space.
      patch.distanceAlongWall = Math.max(0, element.distanceAlongWall + delta.x);
      if (delta.z !== 0) patch.sillHeight = Math.max(0, element.sillHeight + delta.z);
      break;
    case 'group':
      return {};
    default:
      return {};
  }

  if (
    delta.z !== 0 &&
    (element.type === 'stair' ||
      element.type === 'column' ||
      element.type === 'furniture' ||
      element.type === 'room' ||
      element.type === 'railing')
  ) {
    issues.push(
      warning(
        'unsupported',
        `${element.type} "${element.name}" sits on its level and cannot move vertically.`,
        {
          commandId,
          hint: 'Change the element’s level, or adjust the level elevation instead.',
        },
      ),
    );
  }

  return patch;
}

function rotateElement(
  element: ArchElement,
  pivot: Point2,
  angleDeg: number,
): Record<string, unknown> | null {
  const rot = (p: Point2) => rotatePoint(p, pivot, angleDeg);
  switch (element.type) {
    case 'wall':
    case 'beam':
      return { start: rot(element.start), end: rot(element.end) };
    case 'slab':
    case 'room':
    case 'roof':
      return { outline: element.outline.map(rot) };
    case 'railing':
      return { path: element.path.map(rot) };
    case 'stair':
    case 'column':
    case 'furniture':
      return { position: rot(element.position), rotationDeg: element.rotationDeg + angleDeg };
    case 'imported':
      return {
        position: { ...element.position, ...rot({ x: element.position.x, y: element.position.y }) },
        rotationDeg: element.rotationDeg + angleDeg,
      };
    default:
      return null;
  }
}

function scaleElement(
  element: ArchElement,
  pivot: Point2,
  factor: number,
  scaleVertical: boolean,
): Record<string, unknown> | null {
  const sc = (p: Point2) => scalePoint(p, pivot, factor);
  switch (element.type) {
    case 'wall':
      return {
        start: sc(element.start),
        end: sc(element.end),
        ...(scaleVertical ? { height: element.height * factor } : {}),
      };
    case 'beam':
      return {
        start: sc(element.start),
        end: sc(element.end),
        ...(scaleVertical ? { depth: element.depth * factor, width: element.width * factor } : {}),
      };
    case 'slab':
    case 'room':
      return { outline: element.outline.map(sc) };
    case 'roof':
      return { outline: element.outline.map(sc) };
    case 'railing':
      return { path: element.path.map(sc) };
    case 'stair':
      return {
        position: sc(element.position),
        width: element.width * factor,
        treadDepth: element.treadDepth * factor,
        ...(scaleVertical ? { totalRise: element.totalRise * factor } : {}),
      };
    case 'column':
      return {
        position: sc(element.position),
        width: element.width * factor,
        depth: element.depth * factor,
        ...(scaleVertical ? { height: element.height * factor } : {}),
      };
    case 'furniture':
      return { position: sc(element.position), scale: element.scale * factor };
    default:
      return null;
  }
}

/**
 * Welds wall endpoints that are within `tolerance` of one another, moving both
 * to the true intersection of the two centrelines when they are not parallel.
 * Mutates the wall objects in place and returns the ids that changed.
 */
export function joinWallEndpoints(walls: Wall[], tolerance: number): Set<string> {
  const changed = new Set<string>();

  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      const a = walls[i]!;
      const b = walls[j]!;
      for (const aKey of ['start', 'end'] as const) {
        for (const bKey of ['start', 'end'] as const) {
          const pa = a[aKey];
          const pb = b[bKey];
          const distance = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (distance < 0.5 || distance > tolerance) continue;

          const meet = intersectLines(a.start, a.end, b.start, b.end) ?? {
            x: (pa.x + pb.x) / 2,
            y: (pa.y + pb.y) / 2,
          };
          // Reject an intersection that is far from both endpoints: near-parallel
          // walls produce a mathematically valid but useless meeting point.
          const meetDistance = Math.min(
            Math.hypot(meet.x - pa.x, meet.y - pa.y),
            Math.hypot(meet.x - pb.x, meet.y - pb.y),
          );
          const target =
            meetDistance > tolerance * 2 ? { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } : meet;

          a[aKey] = { ...target };
          b[bKey] = { ...target };
          changed.add(a.id);
          changed.add(b.id);
        }
      }
    }
  }
  return changed;
}

function intersectLines(a1: Point2, a2: Point2, b1: Point2, b2: Point2): Point2 | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denominator;
  return { x: a1.x + d1x * t, y: a1.y + d1y * t };
}

/** Bounding rectangle of the level's walls and slabs, used for implicit roofs. */
function deriveLevelOutline(model: ProjectModel, levelId: string): Point2[] | null {
  const points: Point2[] = [];
  for (const element of Object.values(model.elements)) {
    if (!('levelId' in element) || element.levelId !== levelId) continue;
    if (element.type === 'wall') points.push(element.start, element.end);
    if (element.type === 'slab') points.push(...element.outline);
  }
  if (points.length < 2) return null;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  if (maxX - minX < 1 || maxY - minY < 1) return null;
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function highestWallTop(model: ProjectModel, levelId: string): number | null {
  let top: number | null = null;
  const level = model.levels.find((l) => l.id === levelId);
  const base = level?.elevation ?? 0;
  for (const element of Object.values(model.elements)) {
    if (element.type === 'wall' && element.levelId === levelId) {
      const candidate = base + element.baseOffset + element.height;
      top = top === null ? candidate : Math.max(top, candidate);
    }
  }
  return top;
}

export interface OpeningFitInput {
  distanceAlongWall: number;
  width: number;
  height: number;
  sillHeight?: number | undefined;
  elementId?: string | undefined;
}

/**
 * Checks that an opening fits its host: inside the wall's length, inside its
 * height, and not overlapping another opening. Returns issues rather than
 * throwing, so a batch of openings reports every problem at once.
 */
export function checkOpeningFit(
  wall: Wall,
  candidate: OpeningFitInput,
  existing: readonly Opening[],
): { issues: CommandIssue[] } {
  const issues: CommandIssue[] = [];
  const length = wallLength(wall);
  const half = candidate.width / 2;
  const u0 = candidate.distanceAlongWall - half;
  const u1 = candidate.distanceAlongWall + half;
  const sill = candidate.sillHeight ?? 0;
  const head = sill + candidate.height;

  if (u0 < -1) {
    issues.push(
      issue(
        'constraint',
        `Opening starts ${Math.round(-u0)} mm before the wall begins. The wall is ${Math.round(length)} mm long.`,
        { path: 'distanceAlongWall', hint: `Use a distance of at least ${Math.round(half)} mm.` },
      ),
    );
  }
  if (u1 > length + 1) {
    issues.push(
      issue(
        'constraint',
        `Opening extends ${Math.round(u1 - length)} mm past the end of a ${Math.round(length)} mm wall.`,
        {
          path: 'distanceAlongWall',
          hint: `Use a distance of at most ${Math.round(length - half)} mm, or reduce the width.`,
        },
      ),
    );
  }
  if (head > wall.height + 1) {
    issues.push(
      issue(
        'constraint',
        `Opening head is at ${Math.round(head)} mm but the wall is only ${Math.round(wall.height)} mm high.`,
        {
          path: 'height',
          hint: 'Lower the sill height, reduce the opening height, or raise the wall.',
        },
      ),
    );
  }

  for (const other of existing) {
    if (other.id === candidate.elementId) continue;
    const otherHalf = other.width / 2;
    const o0 = other.distanceAlongWall - otherHalf;
    const o1 = other.distanceAlongWall + otherHalf;
    const otherSill = other.sillHeight;
    const otherHead = other.sillHeight + other.height;
    const horizontalOverlap = u0 < o1 - 1 && u1 > o0 + 1;
    const verticalOverlap = sill < otherHead - 1 && head > otherSill + 1;
    if (horizontalOverlap && verticalOverlap) {
      issues.push(
        issue('conflict', `Opening overlaps "${other.name}" on the same wall.`, {
          path: 'distanceAlongWall',
          hint: `"${other.name}" occupies ${Math.round(o0)}–${Math.round(o1)} mm along the wall.`,
        }),
      );
    }
  }

  return { issues };
}

function measureDistance(points: readonly { x: number; y: number; z: number }[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/**
 * Measurement points are project-space `{ x: east, y: north, z: elevation }`.
 * Area is the shoelace area of the plan projection, in mm².
 */
function measureArea(points: readonly { x: number; y: number; z: number }[]): number {
  const shoelace = points.reduce((sum, current, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + (current.x * next.y - next.x * current.y);
  }, 0);
  return Math.abs(shoelace / 2);
}

/** Sun and sky settings for each named environment preset. */
export function applyEnvironmentPreset(preset: string): Record<string, unknown> {
  switch (preset) {
    case 'overcast':
      return {
        sunAltitudeDeg: 35,
        sunIntensity: 0.9,
        ambientIntensity: 1.5,
        weather: 'overcast',
        skyEnabled: true,
        exposure: 1,
        backgroundColor: '#161a1f',
      };
    case 'golden-hour':
      return {
        sunAltitudeDeg: 12,
        sunAzimuthDeg: 250,
        sunIntensity: 3.2,
        ambientIntensity: 0.4,
        weather: 'sunset',
        exposure: 1.1,
        backgroundColor: '#1a1410',
      };
    case 'dusk':
      return {
        sunAltitudeDeg: 2,
        sunAzimuthDeg: 265,
        sunIntensity: 1.2,
        ambientIntensity: 0.5,
        weather: 'sunset',
        exposure: 1.2,
        backgroundColor: '#12131b',
      };
    case 'night':
      return {
        sunAltitudeDeg: -8,
        sunIntensity: 0.05,
        ambientIntensity: 0.18,
        weather: 'night',
        skyEnabled: false,
        exposure: 1.3,
        backgroundColor: '#07080b',
      };
    case 'interior':
      return { sunIntensity: 1.4, ambientIntensity: 1.1, shadowsEnabled: true, exposure: 1 };
    case 'studio':
      return {
        sunAltitudeDeg: 60,
        sunIntensity: 1.8,
        ambientIntensity: 1.2,
        skyEnabled: false,
        weather: 'clear',
        backgroundColor: '#0e1013',
      };
    case 'clear-day':
    default:
      return {
        sunAltitudeDeg: 48,
        sunIntensity: 2.6,
        ambientIntensity: 0.55,
        weather: 'clear',
        skyEnabled: true,
        exposure: 1,
        backgroundColor: '#0b0d10',
      };
  }
}

export { isHostEffectCommand };

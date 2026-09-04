import { describe, expect, it } from 'vitest';
import { applyInverse, applyTransaction, parseCommands } from '@/domain/commands';
import { createEmptyProject } from '@/domain/project/factory';
import {
  elementsOfType,
  listElements,
  openingsForWall,
  wallLength,
} from '@/domain/project/queries';
import type { ProjectModel } from '@/domain/project/schema';

function build(commands: unknown[], model: ProjectModel = createEmptyProject()) {
  const parsed = parseCommands(commands);
  expect(parsed.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  return applyTransaction(model, parsed.commands, { source: 'user' });
}

const RECTANGLE = [
  { x: -5000, y: -4000 },
  { x: 5000, y: -4000 },
  { x: 5000, y: 4000 },
  { x: -5000, y: 4000 },
];

describe('transactions', () => {
  it('applies a set of commands and bumps the revision', () => {
    const result = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      { type: 'create_slab', outline: RECTANGLE },
    ]);
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.createdIds).toHaveLength(2);
    expect(result.model.revision).toBe(1);
  });

  it('never mutates the input model', () => {
    const model = createEmptyProject();
    const before = JSON.stringify(model);
    build([{ type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } }], model);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('rolls the whole set back when an essential command fails', () => {
    const model = createEmptyProject();
    const parsed = parseCommands([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      // Hosted by an element that does not exist: the set cannot be applied.
      {
        type: 'create_opening',
        hostId: 'wall_missing',
        kind: 'window',
        distanceAlongWall: 1000,
        width: 1200,
        height: 1400,
      },
      { type: 'create_slab', outline: RECTANGLE },
    ]);
    const result = applyTransaction(model, parsed.commands, { source: 'ai' });

    expect(result.rolledBack).toBe(true);
    expect(result.ok).toBe(false);
    // The returned model is the input by reference — nothing was applied.
    expect(result.model).toBe(model);
    expect(Object.keys(result.model.elements)).toHaveLength(0);
    expect(result.issues.some((issue) => issue.code === 'conflict')).toBe(true);
  });

  it('does not roll back for a command marked optional', () => {
    const model = createEmptyProject();
    const parsed = parseCommands([
      { id: 'cmd_wall', type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      { id: 'cmd_optional', type: 'focus_elements', ids: ['does_not_exist'] },
    ]);
    const result = applyTransaction(model, parsed.commands, {
      source: 'ai',
      optionalCommandIds: ['cmd_optional'],
    });
    expect(result.rolledBack).toBe(false);
    expect(result.createdIds).toHaveLength(1);
  });

  it('reports an empty command list as a no-op', () => {
    const model = createEmptyProject();
    const result = applyTransaction(model, [], { source: 'user' });
    expect(result.ok).toBe(true);
    expect(result.model).toBe(model);
  });

  it('surfaces host effects without changing the model', () => {
    const result = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      { type: 'export_project', format: 'glb' },
    ]);
    expect(result.hostEffects).toHaveLength(1);
    expect(result.hostEffects[0]?.type).toBe('export_project');
    expect(Object.keys(result.model.elements)).toHaveLength(1);
  });
});

describe('command inversion', () => {
  it('undoes a creation exactly', () => {
    const model = createEmptyProject();
    const applied = build(
      [{ type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, height: 2700 }],
      model,
    );
    const undone = applyInverse(applied.model, applied.inverse);
    expect(undone.rolledBack).toBe(false);
    expect(Object.keys(undone.model.elements)).toHaveLength(0);
    expect(undone.model.elementOrder).toHaveLength(0);
  });

  it('undoes a deletion, restoring hosted openings and hierarchy order', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 8000, y: 0 } },
      {
        type: 'create_wall',
        elementId: 'wall_b',
        start: { x: 8000, y: 0 },
        end: { x: 8000, y: 6000 },
      },
      {
        type: 'create_opening',
        elementId: 'open_a',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 2000,
        width: 1200,
        height: 1400,
      },
    ]);
    const before = created.model.elementOrder.map((id) =>
      JSON.stringify(created.model.elements[id]),
    );
    const beforeOrder = [...created.model.elementOrder];

    const deleted = build([{ type: 'delete_elements', ids: ['wall_a'] }], created.model);
    // Deleting the wall takes its opening with it.
    expect(deleted.model.elements.wall_a).toBeUndefined();
    expect(deleted.model.elements.open_a).toBeUndefined();
    expect(deleted.model.elements.wall_b).toBeDefined();

    const restored = applyInverse(deleted.model, deleted.inverse);
    // `elementOrder` is the authoritative hierarchy; the element map is keyed,
    // so its own insertion order carries no meaning.
    expect(restored.model.elementOrder).toEqual(beforeOrder);
    expect(
      restored.model.elementOrder.map((id) => JSON.stringify(restored.model.elements[id])),
    ).toEqual(before);
  });

  it('undoes a property change back to the exact previous values', () => {
    const created = build([
      {
        type: 'create_wall',
        elementId: 'wall_a',
        start: { x: 0, y: 0 },
        end: { x: 8000, y: 0 },
        height: 2700,
        thickness: 300,
      },
    ]);
    const edited = build(
      [
        {
          type: 'set_element_properties',
          ids: ['wall_a'],
          patch: { height: 3600, thickness: 450 },
        },
      ],
      created.model,
    );
    expect(edited.model.elements.wall_a).toMatchObject({ height: 3600, thickness: 450 });

    const undone = applyInverse(edited.model, edited.inverse);
    expect(undone.model.elements.wall_a).toMatchObject({ height: 2700, thickness: 300 });
  });

  it('undoes a move exactly, including hosted geometry', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 8000, y: 0 } },
    ]);
    const moved = build(
      [{ type: 'move_elements', ids: ['wall_a'], delta: { x: 800, y: -1200, z: 0 } }],
      created.model,
    );
    const wall = moved.model.elements.wall_a;
    expect(wall).toMatchObject({ start: { x: 800, y: -1200 } });

    const undone = applyInverse(moved.model, moved.inverse);
    expect(undone.model.elements.wall_a).toMatchObject({
      start: { x: 0, y: 0 },
      end: { x: 8000, y: 0 },
    });
  });

  it('undoes a level height change and the walls it cascaded to', () => {
    const created = build([
      {
        type: 'create_wall',
        elementId: 'wall_a',
        start: { x: 0, y: 0 },
        end: { x: 8000, y: 0 },
        height: 3000,
      },
      {
        type: 'create_level',
        levelId: 'lvl_first',
        name: 'First floor',
        elevation: 3000,
        height: 3000,
        index: 1,
      },
    ]);

    const raised = build(
      [{ type: 'update_level', levelId: 'lvl_ground', height: 2700, cascade: true }],
      created.model,
    );
    expect(raised.model.levels.find((l) => l.id === 'lvl_first')?.elevation).toBe(2700);
    expect(raised.model.elements.wall_a).toMatchObject({ height: 2700 });

    const undone = applyInverse(raised.model, raised.inverse);
    expect(undone.model.levels.find((l) => l.id === 'lvl_ground')?.height).toBe(3000);
    expect(undone.model.levels.find((l) => l.id === 'lvl_first')?.elevation).toBe(3000);
    expect(undone.model.elements.wall_a).toMatchObject({ height: 3000 });
  });

  it('round-trips a full footprint through undo and redo', () => {
    const model = createEmptyProject();
    const applied = build(
      [{ type: 'create_rectangular_footprint', width: 12_000, depth: 8_000, includeSlab: true }],
      model,
    );
    expect(elementsOfType(applied.model, 'wall')).toHaveLength(4);

    const undone = applyInverse(applied.model, applied.inverse);
    expect(listElements(undone.model)).toHaveLength(0);

    // The inverse of the inverse is the redo.
    const redone = applyInverse(undone.model, undone.inverse);
    expect(elementsOfType(redone.model, 'wall')).toHaveLength(4);
    expect(elementsOfType(redone.model, 'slab')).toHaveLength(1);
  });

  it('undoes a split wall, including the openings it rehosted', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 10_000, y: 0 } },
      {
        type: 'create_opening',
        elementId: 'open_near',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 2000,
        width: 1000,
        height: 1200,
      },
      {
        type: 'create_opening',
        elementId: 'open_far',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 8000,
        width: 1000,
        height: 1200,
      },
    ]);

    const split = build(
      [{ type: 'split_wall', elementId: 'wall_a', distance: 5000 }],
      created.model,
    );
    expect(wallLength(split.model.elements.wall_a as never)).toBeCloseTo(5000, 6);
    expect(openingsForWall(split.model, 'wall_a')).toHaveLength(1);
    const newWall = split.createdIds[0]!;
    expect(openingsForWall(split.model, newWall)).toHaveLength(1);
    expect(split.model.elements.open_far).toMatchObject({ distanceAlongWall: 3000 });

    const undone = applyInverse(split.model, split.inverse);
    expect(wallLength(undone.model.elements.wall_a as never)).toBeCloseTo(10_000, 6);
    expect(openingsForWall(undone.model, 'wall_a')).toHaveLength(2);
    expect(undone.model.elements.open_far).toMatchObject({
      distanceAlongWall: 8000,
      hostId: 'wall_a',
    });
  });

  it('undoes material library changes', () => {
    const created = build([
      { type: 'create_material', materialId: 'mat_custom', name: 'Bronze', color: '#8c6a3f' },
    ]);
    expect(created.model.materials.mat_custom).toBeDefined();
    const undone = applyInverse(created.model, created.inverse);
    expect(undone.model.materials.mat_custom).toBeUndefined();
  });

  it('undoes grouping without losing the members', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } },
      {
        type: 'create_wall',
        elementId: 'wall_b',
        start: { x: 4000, y: 0 },
        end: { x: 4000, y: 4000 },
      },
    ]);
    const grouped = build(
      [{ type: 'group_elements', ids: ['wall_a', 'wall_b'], name: 'Wing' }],
      created.model,
    );
    const groupId = grouped.createdIds[0]!;
    expect(grouped.model.elements[groupId]).toMatchObject({ type: 'group' });
    expect(grouped.model.elements.wall_a).toMatchObject({ parentId: groupId });

    const undone = applyInverse(grouped.model, grouped.inverse);
    expect(undone.model.elements[groupId]).toBeUndefined();
    expect(undone.model.elements.wall_a).toMatchObject({ parentId: null });
    expect(undone.model.elements.wall_b).toBeDefined();
  });
});

describe('element budget', () => {
  it('refuses an array that would exceed the per-turn cap', () => {
    const created = build([
      { type: 'create_column', elementId: 'col_a', position: { x: 0, y: 0 } },
    ]);
    const parsed = parseCommands([
      { type: 'array_elements', ids: ['col_a'], count: 200, step: { x: 1000, y: 0, z: 0 } },
    ]);
    const result = applyTransaction(created.model, parsed.commands, {
      source: 'ai',
      maxNewElements: 10,
    });
    expect(result.rolledBack).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'limit_exceeded')).toBe(true);
  });

  it('allows an array within the cap and places copies at the right step', () => {
    const created = build([
      { type: 'create_column', elementId: 'col_a', position: { x: 0, y: 0 } },
    ]);
    const arrayed = build(
      [{ type: 'array_elements', ids: ['col_a'], count: 4, step: { x: 3000, y: 0, z: 0 } }],
      created.model,
    );
    const columns = elementsOfType(arrayed.model, 'column');
    expect(columns).toHaveLength(4);
    expect(columns.map((c) => c.position.x).sort((a, b) => a - b)).toEqual([0, 3000, 6000, 9000]);
  });
});

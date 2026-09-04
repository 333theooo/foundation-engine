import { describe, expect, it } from 'vitest';
import { applyTransaction, checkOpeningFit, parseCommands } from '@/domain/commands';
import { createEmptyProject } from '@/domain/project/factory';
import { openingsForWall } from '@/domain/project/queries';
import type { Opening, ProjectModel, Wall } from '@/domain/project/schema';

function build(commands: unknown[], model: ProjectModel = createEmptyProject()) {
  const parsed = parseCommands(commands);
  return { parsed, result: applyTransaction(model, parsed.commands, { source: 'user' }) };
}

const HOST: Wall = {
  id: 'wall_a',
  type: 'wall',
  name: 'South wall',
  visible: true,
  locked: false,
  origin: 'user',
  parentId: null,
  tags: [],
  notes: '',
  levelId: 'lvl_ground',
  start: { x: 0, y: 0 },
  end: { x: 6000, y: 0 },
  height: 2700,
  thickness: 300,
  alignment: 'center',
  baseOffset: 0,
  materialId: 'mat_plaster_white',
  structural: false,
  exterior: true,
};

function existing(overrides: Partial<Opening>): Opening {
  return {
    id: 'open_existing',
    type: 'opening',
    name: 'Existing window',
    visible: true,
    locked: false,
    origin: 'user',
    parentId: null,
    tags: [],
    notes: '',
    kind: 'window',
    openingType: 'fixed-window',
    hostId: 'wall_a',
    distanceAlongWall: 2000,
    width: 1200,
    height: 1400,
    sillHeight: 900,
    frameMaterialId: null,
    glazingMaterialId: null,
    frameDepth: 60,
    ...overrides,
  };
}

describe('opening fit validation', () => {
  it('accepts an opening that fits', () => {
    const { issues } = checkOpeningFit(
      HOST,
      { distanceAlongWall: 3000, width: 1200, height: 1400, sillHeight: 900 },
      [],
    );
    expect(issues).toEqual([]);
  });

  it('rejects an opening that runs past the end of the wall', () => {
    const { issues } = checkOpeningFit(
      HOST,
      { distanceAlongWall: 5800, width: 1200, height: 1400, sillHeight: 900 },
      [],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('constraint');
    expect(issues[0]?.hint).toMatch(/at most/);
  });

  it('rejects an opening that starts before the wall does', () => {
    const { issues } = checkOpeningFit(
      HOST,
      { distanceAlongWall: 200, width: 1200, height: 1400, sillHeight: 900 },
      [],
    );
    expect(issues.some((issue) => issue.message.includes('before the wall begins'))).toBe(true);
  });

  it('rejects an opening taller than its wall', () => {
    const { issues } = checkOpeningFit(
      HOST,
      { distanceAlongWall: 3000, width: 1200, height: 2400, sillHeight: 900 },
      [],
    );
    expect(issues.some((issue) => issue.message.includes('only'))).toBe(true);
  });

  it('detects an overlap with another opening', () => {
    const { issues } = checkOpeningFit(
      HOST,
      { distanceAlongWall: 2500, width: 1200, height: 1400, sillHeight: 900 },
      [existing({})],
    );
    expect(issues.some((issue) => issue.code === 'conflict')).toBe(true);
  });

  it('allows openings that overlap horizontally but not vertically', () => {
    const { issues } = checkOpeningFit(
      HOST,
      // A clerestory above an existing window at the same plan position.
      { distanceAlongWall: 2000, width: 1200, height: 400, sillHeight: 2300 },
      [existing({})],
    );
    expect(issues).toEqual([]);
  });

  it('ignores the opening being edited when checking overlap', () => {
    const { issues } = checkOpeningFit(
      HOST,
      {
        distanceAlongWall: 2000,
        width: 1200,
        height: 1400,
        sillHeight: 900,
        elementId: 'open_existing',
      },
      [existing({})],
    );
    expect(issues).toEqual([]);
  });
});

describe('hosted opening lifecycle', () => {
  it('refuses an opening with no host', () => {
    const { result } = build([
      {
        type: 'create_opening',
        hostId: 'nope',
        kind: 'window',
        distanceAlongWall: 1000,
        width: 1200,
        height: 1400,
      },
    ]);
    expect(result.rolledBack).toBe(true);
  });

  it('refuses an opening hosted by something that is not a wall', () => {
    const created = build([
      {
        type: 'create_slab',
        elementId: 'slab_a',
        outline: [
          { x: 0, y: 0 },
          { x: 5000, y: 0 },
          { x: 5000, y: 5000 },
          { x: 0, y: 5000 },
        ],
      },
    ]).result;
    const { result } = build(
      [
        {
          type: 'create_opening',
          hostId: 'slab_a',
          kind: 'door',
          distanceAlongWall: 1000,
          width: 900,
          height: 2100,
        },
      ],
      created.model,
    );
    expect(result.rolledBack).toBe(true);
    expect(result.issues.some((issue) => issue.message.includes('hosted by a wall'))).toBe(true);
  });

  it('distributes openings evenly along the host wall', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 12_000, y: 0 } },
    ]).result;
    const { result } = build(
      [
        {
          type: 'distribute_openings',
          hostId: 'wall_a',
          count: 3,
          kind: 'window',
          width: 1600,
          height: 1400,
          edgeMargin: 1200,
        },
      ],
      created.model,
    );
    expect(result.rolledBack).toBe(false);
    const openings = openingsForWall(result.model, 'wall_a');
    expect(openings).toHaveLength(3);

    // Usable run is 12000 − 2×1200 = 9600, so bays are 3200 and centres sit at
    // 1200 + 1600, 1200 + 4800, 1200 + 8000.
    expect(openings.map((o) => o.distanceAlongWall)).toEqual([2800, 6000, 9200]);

    // Even spacing, and none overruns the wall.
    const gaps = openings
      .slice(1)
      .map((o, i) => o.distanceAlongWall - openings[i]!.distanceAlongWall);
    expect(new Set(gaps).size).toBe(1);
  });

  it('refuses to distribute more openings than the wall can hold', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } },
    ]).result;
    const { result } = build(
      [
        {
          type: 'distribute_openings',
          hostId: 'wall_a',
          count: 4,
          kind: 'window',
          width: 1600,
          height: 1400,
        },
      ],
      created.model,
    );
    expect(result.rolledBack).toBe(true);
    expect(result.issues[0]?.hint).toMatch(/Reduce the count/);
  });

  it('keeps an opening hosted when the wall moves', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      {
        type: 'create_opening',
        elementId: 'open_a',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 3000,
        width: 1200,
        height: 1400,
      },
    ]).result;

    const moved = build(
      [{ type: 'move_elements', ids: ['wall_a'], delta: { x: 0, y: 800, z: 0 } }],
      created.model,
    ).result;

    const opening = moved.model.elements.open_a;
    expect(opening).toMatchObject({ hostId: 'wall_a', distanceAlongWall: 3000 });
    expect(moved.model.elements.wall_a).toMatchObject({ start: { x: 0, y: 800 } });
  });

  it('reports an opening left oversized by a shortened wall', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      {
        type: 'create_opening',
        elementId: 'open_a',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 5000,
        width: 1200,
        height: 1400,
      },
    ]).result;

    const shortened = build(
      [{ type: 'set_element_properties', ids: ['wall_a'], patch: { end: { x: 3000, y: 0 } } }],
      created.model,
    ).result;

    expect(shortened.rolledBack).toBe(false);
    // The edit is allowed, but the review flags the opening as out of bounds.
    expect(
      shortened.findings.some(
        (finding) => finding.elementId === 'open_a' && finding.severity === 'error',
      ),
    ).toBe(true);
  });
});

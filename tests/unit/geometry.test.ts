import { describe, expect, it } from 'vitest';
import {
  buildOpeningMesh,
  buildPrism,
  buildRoofMesh,
  buildStairMesh,
  buildWallMesh,
  decomposeWallPanels,
  meshBounds,
  openingRects,
  triangleCount,
  wallLengthMm,
} from '@/domain/geometry';
import {
  cleanOutline,
  ensureCounterClockwise,
  offsetPolygon,
  perimeter,
  pointInPolygon,
  signedArea,
  triangulate,
} from '@/domain/geometry/polygon';
import { MM_TO_SCENE } from '@/domain/units';
import type { Opening, Wall } from '@/domain/project/schema';

function wall(overrides: Partial<Wall> = {}): Wall {
  return {
    id: 'wall_a',
    type: 'wall',
    name: 'Wall',
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
    ...overrides,
  };
}

function opening(overrides: Partial<Opening> = {}): Opening {
  return {
    id: 'open_a',
    type: 'opening',
    name: 'Window',
    visible: true,
    locked: false,
    origin: 'user',
    parentId: null,
    tags: [],
    notes: '',
    kind: 'window',
    openingType: 'fixed-window',
    hostId: 'wall_a',
    distanceAlongWall: 3000,
    width: 1200,
    height: 1400,
    sillHeight: 900,
    frameMaterialId: null,
    glazingMaterialId: null,
    frameDepth: 60,
    ...overrides,
  };
}

describe('wall panel decomposition', () => {
  it('produces one panel for a wall with no openings', () => {
    const panels = decomposeWallPanels(6000, 2700, []);
    expect(panels).toEqual([{ u0: 0, u1: 6000, v0: 0, v1: 2700 }]);
  });

  it('produces four panels around a single window', () => {
    // Window from 2400 to 3600 along, 900 to 2300 up.
    const panels = decomposeWallPanels(6000, 2700, [
      { id: 'o', u0: 2400, u1: 3600, v0: 900, v1: 2300 },
    ]);
    expect(panels).toHaveLength(4);

    // No panel overlaps the hole.
    for (const panel of panels) {
      const overlapsU = panel.u0 < 3600 && panel.u1 > 2400;
      const overlapsV = panel.v0 < 2300 && panel.v1 > 900;
      expect(overlapsU && overlapsV).toBe(false);
    }

    // The panels exactly tile the wall minus the hole.
    const panelArea = panels.reduce((sum, p) => sum + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
    expect(panelArea).toBeCloseTo(6000 * 2700 - 1200 * 1400, 6);
  });

  it('produces three panels for a door that reaches the floor', () => {
    const panels = decomposeWallPanels(6000, 2700, [
      { id: 'd', u0: 2500, u1: 3400, v0: 0, v1: 2100 },
    ]);
    expect(panels).toHaveLength(3);
    const panelArea = panels.reduce((sum, p) => sum + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
    expect(panelArea).toBeCloseTo(6000 * 2700 - 900 * 2100, 6);
  });

  it('handles several openings and still tiles exactly', () => {
    const holes = [
      { id: 'a', u0: 800, u1: 2000, v0: 900, v1: 2300 },
      { id: 'b', u0: 3000, u1: 4200, v0: 900, v1: 2300 },
      { id: 'c', u0: 5000, u1: 6200, v0: 900, v1: 2300 },
    ];
    const panels = decomposeWallPanels(8000, 2700, holes);
    const panelArea = panels.reduce((sum, p) => sum + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
    const holeArea = holes.reduce((sum, h) => sum + (h.u1 - h.u0) * (h.v1 - h.v0), 0);
    expect(panelArea).toBeCloseTo(8000 * 2700 - holeArea, 6);
  });

  it('produces no panels for a degenerate wall', () => {
    expect(decomposeWallPanels(0, 2700, [])).toEqual([]);
    expect(decomposeWallPanels(6000, 0, [])).toEqual([]);
  });

  it('merges panels vertically where the spans align', () => {
    // A single full-height opening splits the wall into exactly two panels.
    const panels = decomposeWallPanels(6000, 2700, [
      { id: 'o', u0: 2000, u1: 4000, v0: 0, v1: 2700 },
    ]);
    expect(panels).toHaveLength(2);
  });
});

describe('hosted openings', () => {
  it('clamps an opening that overruns the wall rather than producing NaN geometry', () => {
    const rects = openingRects(wall({ end: { x: 3000, y: 0 } }), [
      opening({ distanceAlongWall: 2800, width: 1200 }),
    ]);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.u1).toBeLessThanOrEqual(3000);
    expect(rects[0]!.u0).toBeGreaterThanOrEqual(0);
  });

  it('drops an opening entirely outside the wall', () => {
    const rects = openingRects(wall(), [opening({ distanceAlongWall: 20_000 })]);
    expect(rects).toHaveLength(0);
  });

  it('ignores hidden openings', () => {
    const rects = openingRects(wall(), [opening({ visible: false })]);
    expect(rects).toHaveLength(0);
  });

  it('rebuilds the wall solid when the opening moves', () => {
    const host = wall();
    const a = buildWallMesh(host, [opening({ distanceAlongWall: 1500 })], { levelElevation: 0 });
    const b = buildWallMesh(host, [opening({ distanceAlongWall: 4500 })], { levelElevation: 0 });
    expect(a.positions.length).toBeGreaterThan(0);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('keeps the wall solid the same size when the opening changes but the wall does not', () => {
    const host = wall();
    const solid = buildWallMesh(host, [], { levelElevation: 0 });
    const bounds = meshBounds(solid)!;
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(6000 * MM_TO_SCENE, 6);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(2700 * MM_TO_SCENE, 6);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(300 * MM_TO_SCENE, 6);
  });

  it('places the wall at the hosting level elevation', () => {
    const solid = buildWallMesh(wall(), [], { levelElevation: 3000 });
    const bounds = meshBounds(solid)!;
    expect(bounds.min.y).toBeCloseTo(3000 * MM_TO_SCENE, 6);
    expect(bounds.max.y).toBeCloseTo(5700 * MM_TO_SCENE, 6);
  });

  it('offsets the wall body for left and right alignment', () => {
    const centred = meshBounds(
      buildWallMesh(wall({ alignment: 'center' }), [], { levelElevation: 0 }),
    )!;
    const left = meshBounds(buildWallMesh(wall({ alignment: 'left' }), [], { levelElevation: 0 }))!;
    expect(left.min.z).not.toBeCloseTo(centred.min.z, 6);
    expect(left.max.z - left.min.z).toBeCloseTo(centred.max.z - centred.min.z, 6);
  });

  it('builds a frame and a glazed panel for a window', () => {
    const { frame, panel } = buildOpeningMesh(wall(), opening(), { levelElevation: 0 });
    expect(triangleCount(frame)).toBeGreaterThan(0);
    expect(triangleCount(panel)).toBeGreaterThan(0);
  });

  it('builds no infill panel for a plain opening', () => {
    const { panel } = buildOpeningMesh(wall(), opening({ openingType: 'opening' }), {
      levelElevation: 0,
    });
    expect(triangleCount(panel)).toBe(0);
  });

  it('measures wall length from its endpoints', () => {
    expect(wallLengthMm(wall({ end: { x: 3000, y: 4000 } }))).toBeCloseTo(5000, 9);
  });
});

describe('polygons', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
    { x: 0, y: 1000 },
  ];

  it('computes signed area and winding', () => {
    expect(signedArea(square)).toBe(1_000_000);
    expect(signedArea([...square].reverse())).toBe(-1_000_000);
    expect(signedArea(ensureCounterClockwise([...square].reverse()))).toBe(1_000_000);
  });

  it('computes perimeter', () => {
    expect(perimeter(square)).toBe(4000);
  });

  it('triangulates a convex polygon into n − 2 triangles', () => {
    const { triangles } = triangulate(square);
    expect(triangles).toHaveLength(2);
  });

  it('triangulates a concave L-shape correctly', () => {
    const shape = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 1000 },
      { x: 1000, y: 1000 },
      { x: 1000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    const { outline, triangles } = triangulate(shape);
    expect(outline).toHaveLength(6);
    expect(triangles).toHaveLength(4);
  });

  it('removes duplicate and collinear vertices', () => {
    const messy = [
      { x: 0, y: 0 },
      { x: 500, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    expect(cleanOutline(messy)).toHaveLength(4);
  });

  it('tests point containment', () => {
    expect(pointInPolygon({ x: 500, y: 500 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1500, y: 500 }, square)).toBe(false);
  });

  it('offsets a convex outline outward by the given distance', () => {
    const offset = offsetPolygon(square, 100);
    expect(signedArea(offset)).toBeGreaterThan(signedArea(square));
    expect(offset[0]!.x).toBeCloseTo(-100, 6);
    expect(offset[2]!.x).toBeCloseTo(1100, 6);
  });
});

describe('solids', () => {
  const outline = [
    { x: -5000, y: -4000 },
    { x: 5000, y: -4000 },
    { x: 5000, y: 4000 },
    { x: -5000, y: 4000 },
  ];

  it('extrudes a prism between two elevations', () => {
    const mesh = buildPrism(outline, 0, 300);
    const bounds = meshBounds(mesh)!;
    expect(bounds.min.y).toBeCloseTo(0, 6);
    expect(bounds.max.y).toBeCloseTo(0.3, 6);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(10, 6);
  });

  it('builds a flat roof at the right elevation', () => {
    const mesh = buildRoofMesh({
      id: 'roof_a',
      type: 'roof',
      name: 'Roof',
      visible: true,
      locked: false,
      origin: 'user',
      parentId: null,
      tags: [],
      notes: '',
      levelId: 'lvl_ground',
      kind: 'flat',
      outline,
      baseElevation: 2700,
      thickness: 300,
      pitchDeg: 0,
      ridgeAxis: 'x',
      overhang: 0,
      materialId: 'mat_roof_membrane',
    });
    const bounds = meshBounds(mesh)!;
    expect(bounds.min.y).toBeCloseTo(2.7, 6);
    expect(bounds.max.y).toBeCloseTo(3.0, 6);
  });

  it('raises the ridge of a gable roof by span/2 × tan(pitch)', () => {
    const mesh = buildRoofMesh({
      id: 'roof_a',
      type: 'roof',
      name: 'Roof',
      visible: true,
      locked: false,
      origin: 'user',
      parentId: null,
      tags: [],
      notes: '',
      levelId: 'lvl_ground',
      kind: 'gable',
      outline,
      baseElevation: 0,
      thickness: 200,
      pitchDeg: 30,
      ridgeAxis: 'x',
      overhang: 0,
      materialId: 'mat_roof_zinc',
    });
    const bounds = meshBounds(mesh)!;
    // Span across the ridge is 8 m, so the ridge rises 4 × tan(30°) ≈ 2.309 m.
    const expected = 4 * Math.tan(Math.PI / 6) + 0.2;
    expect(bounds.max.y).toBeCloseTo(expected, 3);
  });

  it('builds a stair whose top matches the total rise', () => {
    const mesh = buildStairMesh(
      {
        id: 'stair_a',
        type: 'stair',
        name: 'Stair',
        visible: true,
        locked: false,
        origin: 'user',
        parentId: null,
        tags: [],
        notes: '',
        levelId: 'lvl_ground',
        position: { x: 0, y: 0 },
        rotationDeg: 0,
        width: 1000,
        totalRise: 2700,
        steps: 15,
        treadDepth: 270,
        shape: 'straight',
        landingDepth: 1000,
        materialId: 'mat_concrete_fair',
      },
      0,
    );
    const bounds = meshBounds(mesh)!;
    expect(bounds.max.y).toBeCloseTo(2.7, 6);
    // 15 treads of 270 mm = 4.05 m of run.
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(4.05, 6);
  });
});

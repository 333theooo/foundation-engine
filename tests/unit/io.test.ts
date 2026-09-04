import { describe, expect, it } from 'vitest';
import { importDxf, type DxfParserLike } from '@/io/dxf';
import { importIfc, type IfcApiLike } from '@/io/ifc';
import { buildProjectSummaryDocument } from '@/io/exporters';
import { buildSampleProject } from '@/domain/project/sample';
import { applyTransaction, parseCommands } from '@/domain/commands';
import { createEmptyProject } from '@/domain/project/factory';
import { elementsOfType, openingsForWall } from '@/domain/project/queries';

/* ------------------------------------------------------------------ */
/* IFC                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A stand-in for web-ifc.
 *
 * The real library is a WASM module; testing against it would test the library,
 * not our conversion. This stub implements the same surface with hand-built
 * geometry, which is what actually exercises the semantic recovery: which
 * shapes become walls, which fall back to reference geometry, and how openings
 * are hosted.
 */
interface StubElement {
  expressID: number;
  type: string;
  /** Axis-aligned box in metres, IFC Z-up. */
  box: [number, number, number, number, number, number];
  line?: Record<string, unknown>;
}

function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Float32Array {
  const corners: number[] = [];
  for (const [x, y, z] of [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ] as const) {
    corners.push(x, y, z, 0, 0, 1);
  }
  return new Float32Array(corners);
}

const CUBE_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4,
  3, 4, 0,
]);

function makeStubApi(elements: StubElement[], extraLines: StubElement[] = []): IfcApiLike {
  const all = [...elements, ...extraLines];
  return {
    OpenModel: () => 1,
    CloseModel: () => undefined,
    GetAllLines: () => ({ size: () => all.length, get: (index) => all[index]!.expressID }),
    GetLine: (_model, expressID) => all.find((e) => e.expressID === expressID)?.line ?? {},
    GetLineType: (_model, expressID) => expressID,
    GetNameFromTypeCode: (code) => all.find((e) => e.expressID === code)?.type ?? `IFCTYPE_${code}`,
    LoadAllGeometry: () => ({
      size: () => elements.length,
      get: (index) => ({
        expressID: elements[index]!.expressID,
        geometries: {
          size: () => 1,
          get: () => ({
            geometryExpressID: elements[index]!.expressID,
            color: { x: 0.7, y: 0.7, z: 0.7, w: 1 },
            flatTransformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          }),
        },
      }),
    }),
    GetGeometry: (_model, expressID) => {
      return {
        GetVertexData: () => expressID,
        GetVertexDataSize: () => 48,
        GetIndexData: () => expressID,
        GetIndexDataSize: () => CUBE_INDICES.length,
      };
    },
    GetVertexArray: (pointer) => {
      const element = elements.find((e) => e.expressID === pointer)!;
      return box(...element.box);
    },
    GetIndexArray: () => CUBE_INDICES,
  };
}

describe('IFC import', () => {
  it('converts storeys into real levels', () => {
    const api = makeStubApi(
      [],
      [
        {
          expressID: 10,
          type: 'IFCBUILDINGSTOREY',
          box: [0, 0, 0, 0, 0, 0],
          line: { Name: { value: 'Ground' }, Elevation: { value: 0 } },
        },
        {
          expressID: 11,
          type: 'IFCBUILDINGSTOREY',
          box: [0, 0, 0, 0, 0, 0],
          line: { Name: { value: 'First' }, Elevation: { value: 3 } },
        },
      ],
    );
    const report = importIfc(api, new Uint8Array([1]));
    const levels = report.commands.filter((c) => (c as { type: string }).type === 'create_level');
    expect(levels).toHaveLength(2);
    expect(levels[0]).toMatchObject({ name: 'Ground', elevation: 0 });
    expect(levels[1]).toMatchObject({ name: 'First', elevation: 3000 });
    expect(report.converted.levels).toBe(2);
  });

  it('recovers a straight wall as an editable element', () => {
    const api = makeStubApi([
      // 6 m long, 300 mm thick, 2.7 m high.
      { expressID: 20, type: 'IFCWALLSTANDARDCASE', box: [0, 0, 0, 6, 0.3, 2.7] },
    ]);
    const report = importIfc(api, new Uint8Array([1]));
    const walls = report.commands.filter((c) => (c as { type: string }).type === 'create_wall');
    expect(walls).toHaveLength(1);
    expect(walls[0]).toMatchObject({
      start: { x: 0, y: 150 },
      end: { x: 6000, y: 150 },
      height: 2700,
      thickness: 300,
    });
    expect(report.converted.walls).toBe(1);
  });

  it('reports a wall it cannot convert rather than mangling it', () => {
    const api = makeStubApi([
      // Nearly square in plan: no centreline can be recovered from this.
      { expressID: 21, type: 'IFCWALL', box: [0, 0, 0, 3, 2.8, 2.7] },
    ]);
    const report = importIfc(api, new Uint8Array([1]));
    expect(
      report.commands.filter((c) => (c as { type: string }).type === 'create_wall'),
    ).toHaveLength(0);
    expect(report.unsupported.some((u) => u.category === 'IfcWall')).toBe(true);
    // The geometry is not lost — it comes in as reference.
    expect(report.meshes.some((mesh) => mesh.semanticTag === 'IFCWALL')).toBe(true);
  });

  it('converts spaces into rooms', () => {
    const api = makeStubApi([
      {
        expressID: 30,
        type: 'IFCSPACE',
        box: [0, 0, 0, 4, 5, 2.7],
        line: { LongName: { value: 'Kitchen' } },
      },
    ]);
    const report = importIfc(api, new Uint8Array([1]));
    const rooms = report.commands.filter((c) => (c as { type: string }).type === 'create_room');
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ name: 'Kitchen' });
  });

  it('hosts a door onto the wall it sits in', () => {
    const api = makeStubApi([
      { expressID: 20, type: 'IFCWALLSTANDARDCASE', box: [0, 0, 0, 6, 0.3, 2.7] },
      { expressID: 40, type: 'IFCDOOR', box: [2, 0.05, 0, 2.9, 0.25, 2.1] },
    ]);
    const report = importIfc(api, new Uint8Array([1]));
    const openings = report.commands.filter(
      (c) => (c as { type: string }).type === 'create_opening',
    );
    expect(openings).toHaveLength(1);
    expect(openings[0]).toMatchObject({ hostId: 'wall_ifc_20', kind: 'door', height: 2100 });
  });

  it('reports an opening it could not host', () => {
    const api = makeStubApi([
      { expressID: 20, type: 'IFCWALLSTANDARDCASE', box: [0, 0, 0, 6, 0.3, 2.7] },
      // 40 m away from any wall.
      { expressID: 41, type: 'IFCWINDOW', box: [40, 40, 0.9, 41.2, 40.2, 2.3] },
    ]);
    const report = importIfc(api, new Uint8Array([1]));
    expect(
      report.commands.filter((c) => (c as { type: string }).type === 'create_opening'),
    ).toHaveLength(0);
    expect(report.unsupported.some((u) => u.category.includes('IfcDoor'))).toBe(true);
  });

  it('groups unconverted geometry by IFC type', () => {
    const api = makeStubApi([
      { expressID: 50, type: 'IFCFURNISHINGELEMENT', box: [0, 0, 0, 1, 1, 1] },
      { expressID: 51, type: 'IFCFURNISHINGELEMENT', box: [2, 0, 0, 3, 1, 1] },
      { expressID: 52, type: 'IFCFLOWTERMINAL', box: [5, 0, 0, 5.5, 0.5, 0.5] },
    ]);
    const report = importIfc(api, new Uint8Array([1]));
    expect(report.meshes).toHaveLength(2);
    expect(report.meshes.map((m) => m.semanticTag).sort()).toEqual([
      'IFCFLOWTERMINAL',
      'IFCFURNISHINGELEMENT',
    ]);
  });

  it('reports a file it cannot open as an error, not a crash', () => {
    const broken: IfcApiLike = {
      ...makeStubApi([]),
      OpenModel: () => {
        throw new Error('not an IFC file');
      },
    };
    const report = importIfc(broken, new Uint8Array([1]));
    expect(report.errors[0]).toMatch(/could not be opened/);
    expect(report.commands).toHaveLength(0);
  });

  it('produces commands that pass validation and apply cleanly', () => {
    const api = makeStubApi(
      [
        { expressID: 20, type: 'IFCWALLSTANDARDCASE', box: [0, 0, 0, 6, 0.3, 2.7] },
        { expressID: 21, type: 'IFCWALLSTANDARDCASE', box: [0, 0, 0, 0.3, 5, 2.7] },
        { expressID: 40, type: 'IFCDOOR', box: [2, 0.05, 0, 2.9, 0.25, 2.1] },
        {
          expressID: 30,
          type: 'IFCSPACE',
          box: [0.3, 0.3, 0, 5.7, 4.7, 2.7],
          line: { LongName: { value: 'Studio' } },
        },
      ],
      [
        {
          expressID: 10,
          type: 'IFCBUILDINGSTOREY',
          box: [0, 0, 0, 0, 0, 0],
          line: { Name: { value: 'Ground' }, Elevation: { value: 0 } },
        },
      ],
    );
    const report = importIfc(api, new Uint8Array([1]));
    const parsed = parseCommands(report.commands);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const applied = applyTransaction(createEmptyProject(), parsed.commands, { source: 'import' });
    expect(applied.rolledBack).toBe(false);
    expect(elementsOfType(applied.model, 'wall')).toHaveLength(2);
    expect(elementsOfType(applied.model, 'room')).toHaveLength(1);
    expect(openingsForWall(applied.model, 'wall_ifc_20')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* DXF                                                                 */
/* ------------------------------------------------------------------ */

function makeDxfParser(entities: unknown[]): DxfParserLike {
  return { parseSync: () => ({ entities: entities as never }) };
}

describe('DXF import', () => {
  it('converts straight lines on a wall layer into real walls', () => {
    const parser = makeDxfParser([
      { type: 'LINE', layer: 'A-WALL', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      { type: 'LINE', layer: 'A-WALL', start: { x: 6000, y: 0 }, end: { x: 6000, y: 4000 } },
    ]);
    const report = importDxf(parser, '', { scaleToMm: 1, wallHeight: 2700, wallThickness: 150 });
    expect(report.converted.walls).toBe(2);
    expect(report.commands[0]).toMatchObject({ height: 2700, thickness: 150 });
    // Never silent about the fact that height and thickness were invented.
    expect(report.warnings.some((w) => w.includes('assumptions you should check'))).toBe(true);
  });

  it('brings other layers in as reference lines', () => {
    const parser = makeDxfParser([
      { type: 'LINE', layer: 'DIMENSIONS', start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
      {
        type: 'LWPOLYLINE',
        layer: 'SITE',
        vertices: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ],
      },
    ]);
    const report = importDxf(parser, '');
    expect(report.commands).toHaveLength(0);
    expect(report.meshes.map((m) => m.semanticTag).sort()).toEqual(['DXF:DIMENSIONS', 'DXF:SITE']);
  });

  it('reports curved and block entities as unconverted', () => {
    const parser = makeDxfParser([
      { type: 'ARC', layer: '0', center: { x: 0, y: 0 }, radius: 500 },
      { type: 'INSERT', layer: '0' },
      { type: 'SPLINE', layer: '0' },
    ]);
    const report = importDxf(parser, '');
    const categories = report.unsupported.map((u) => u.category).sort();
    expect(categories).toEqual(['ARC', 'INSERT', 'SPLINE']);
    expect(report.unsupported.find((u) => u.category === 'INSERT')?.reason).toMatch(
      /Explode blocks/,
    );
  });

  it('respects the drawing scale', () => {
    const parser = makeDxfParser([
      { type: 'LINE', layer: 'WALL', start: { x: 0, y: 0 }, end: { x: 6, y: 0 } },
    ]);
    const report = importDxf(parser, '', { scaleToMm: 1000 });
    expect(report.commands[0]).toMatchObject({ end: { x: 6000, y: 0 } });
  });

  it('can be told not to convert wall layers at all', () => {
    const parser = makeDxfParser([
      { type: 'LINE', layer: 'WALL', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
    ]);
    const report = importDxf(parser, '', { convertWallLayers: false });
    expect(report.commands).toHaveLength(0);
    expect(report.meshes).toHaveLength(1);
  });

  it('reports a parse failure as an error', () => {
    const parser: DxfParserLike = {
      parseSync: () => {
        throw new Error('bad DXF');
      },
    };
    const report = importDxf(parser, 'garbage');
    expect(report.errors[0]).toMatch(/could not be parsed/);
  });

  it('produces commands that apply cleanly', () => {
    const parser = makeDxfParser([
      { type: 'LINE', layer: 'A-WALL', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      { type: 'LINE', layer: 'A-WALL', start: { x: 6000, y: 0 }, end: { x: 6000, y: 4000 } },
    ]);
    const report = importDxf(parser, '');
    const parsed = parseCommands(report.commands);
    expect(parsed.issues).toEqual([]);
    const applied = applyTransaction(createEmptyProject(), parsed.commands, { source: 'import' });
    expect(applied.rolledBack).toBe(false);
    expect(elementsOfType(applied.model, 'wall')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

describe('project summary export', () => {
  const summary = buildProjectSummaryDocument(buildSampleProject());

  it('includes the schedules an architect would expect', () => {
    expect(summary).toContain('## Schedule of spaces');
    expect(summary).toContain('## Schedule of openings');
    expect(summary).toContain('## Levels');
    expect(summary).toContain('## Stairs');
  });

  it('reports real quantities', () => {
    expect(summary).toMatch(/Gross floor area \| [\d.]+ m²/);
    expect(summary).toContain('Kitchen / living');
    expect(summary).toContain('Entrance door');
  });

  it('states the limits of the review, every time', () => {
    expect(summary).toContain('not a code check');
    expect(summary).toContain('not for construction');
    expect(summary).toContain('suitably qualified professional');
  });

  it('reports stair proportions including 2R + G', () => {
    expect(summary).toContain('2R + G');
  });
});

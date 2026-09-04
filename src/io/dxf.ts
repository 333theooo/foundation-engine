import type { ImportReport, ImportedMeshPayload } from './types';
import { emptyReport } from './types';

/**
 * DXF import.
 *
 * DXF is a drawing exchange format, not a building model: it carries lines,
 * polylines, arcs and text on layers, with no notion of a wall. Pretending
 * otherwise would produce confident nonsense, so the default is honest —
 * **reference geometry you can trace over** — with one narrowly-scoped
 * conversion that is genuinely reliable:
 *
 *   * Layers whose names look like wall layers (`WALL`, `A-WALL`, `MUR`,
 *     `WAND`) and whose entities are straight LINE segments become real walls
 *     at a stated default height and thickness. The user sets those in the
 *     import dialog because the drawing does not contain them.
 *
 * Everything else becomes flat reference lines at the drawing's elevation.
 * Arcs, splines, hatches, blocks and text are reported as unconverted rather
 * than approximated.
 */

interface DxfPoint {
  x?: number;
  y?: number;
  z?: number;
}

interface DxfEntity {
  type?: string;
  layer?: string;
  vertices?: DxfPoint[];
  start?: DxfPoint;
  end?: DxfPoint;
  center?: DxfPoint;
  radius?: number;
  shape?: boolean;
}

interface DxfDocument {
  entities?: DxfEntity[];
  tables?: { layer?: { layers?: Record<string, { name?: string; color?: number }> } };
  header?: Record<string, unknown>;
}

/** Minimal shape of the `dxf-parser` default export we depend on. */
export interface DxfParserLike {
  parseSync(text: string): DxfDocument | null;
}

const WALL_LAYER = /(^|[-_ ])(wall|walls|mur|murs|wand|w[aä]nde|a-wall)([-_ ]|$)/i;

export interface DxfImportOptions {
  /** Scale from drawing units to millimetres. DXF has no reliable unit header. */
  scaleToMm?: number;
  /** Height given to walls recovered from wall layers, in mm. */
  wallHeight?: number;
  wallThickness?: number;
  /** When false, wall layers are imported as reference lines like everything else. */
  convertWallLayers?: boolean;
  maxEntities?: number;
}

export function importDxf(
  parser: DxfParserLike,
  text: string,
  options: DxfImportOptions = {},
): ImportReport {
  const startedAt = Date.now();
  const scale = options.scaleToMm ?? 1;
  const wallHeight = options.wallHeight ?? 2_700;
  const wallThickness = options.wallThickness ?? 150;
  const convertWalls = options.convertWallLayers ?? true;
  const maxEntities = options.maxEntities ?? 40_000;

  const report = emptyReport('dxf', text.length);

  let document: DxfDocument | null;
  try {
    document = parser.parseSync(text);
  } catch (error) {
    report.errors.push(
      `The DXF could not be parsed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return report;
  }

  const entities = document?.entities ?? [];
  if (entities.length === 0) {
    report.errors.push('The DXF contained no entities.');
    return report;
  }
  if (entities.length > maxEntities) {
    report.warnings.push(
      `The drawing has ${entities.length} entities; the first ${maxEntities} were imported.`,
    );
  }

  const unsupportedCounts = new Map<string, number>();
  const linesByLayer = new Map<string, number[]>();
  let wallCount = 0;

  const pushSegment = (layer: string, a: DxfPoint, b: DxfPoint) => {
    const bucket = linesByLayer.get(layer) ?? [];
    // Reference lines go to Three.js in metres: DXF is XY-plan, Z-up.
    bucket.push(
      ((a.x ?? 0) * scale) / 1000,
      ((a.z ?? 0) * scale) / 1000,
      -((a.y ?? 0) * scale) / 1000,
      ((b.x ?? 0) * scale) / 1000,
      ((b.z ?? 0) * scale) / 1000,
      -((b.y ?? 0) * scale) / 1000,
    );
    linesByLayer.set(layer, bucket);
  };

  for (const entity of entities.slice(0, maxEntities)) {
    const layer = entity.layer ?? '0';
    const type = (entity.type ?? 'UNKNOWN').toUpperCase();
    const isWallLayer = convertWalls && WALL_LAYER.test(layer);

    if (type === 'LINE' && entity.start && entity.end) {
      if (isWallLayer) {
        const start = { x: (entity.start.x ?? 0) * scale, y: (entity.start.y ?? 0) * scale };
        const end = { x: (entity.end.x ?? 0) * scale, y: (entity.end.y ?? 0) * scale };
        if (Math.hypot(end.x - start.x, end.y - start.y) >= 200) {
          report.commands.push({
            type: 'create_wall',
            description: `Wall from DXF layer ${layer}`,
            name: `Wall (${layer})`,
            start: { x: Math.round(start.x), y: Math.round(start.y) },
            end: { x: Math.round(end.x), y: Math.round(end.y) },
            height: wallHeight,
            thickness: wallThickness,
            materialId: 'mat_plaster_white',
          });
          wallCount += 1;
          continue;
        }
      }
      pushSegment(layer, entity.start, entity.end);
      continue;
    }

    if ((type === 'LWPOLYLINE' || type === 'POLYLINE') && Array.isArray(entity.vertices)) {
      const vertices = entity.vertices;
      for (let i = 0; i + 1 < vertices.length; i += 1) {
        const a = vertices[i]!;
        const b = vertices[i + 1]!;
        if (isWallLayer) {
          const start = { x: (a.x ?? 0) * scale, y: (a.y ?? 0) * scale };
          const end = { x: (b.x ?? 0) * scale, y: (b.y ?? 0) * scale };
          if (Math.hypot(end.x - start.x, end.y - start.y) >= 200) {
            report.commands.push({
              type: 'create_wall',
              description: `Wall from DXF layer ${layer}`,
              name: `Wall (${layer})`,
              start: { x: Math.round(start.x), y: Math.round(start.y) },
              end: { x: Math.round(end.x), y: Math.round(end.y) },
              height: wallHeight,
              thickness: wallThickness,
              materialId: 'mat_plaster_white',
            });
            wallCount += 1;
            continue;
          }
        }
        pushSegment(layer, a, b);
      }
      if (entity.shape && vertices.length > 2) {
        pushSegment(layer, vertices[vertices.length - 1]!, vertices[0]!);
      }
      continue;
    }

    unsupportedCounts.set(type, (unsupportedCounts.get(type) ?? 0) + 1);
  }

  if (wallCount > 0) {
    report.converted.walls = wallCount;
    report.warnings.push(
      `${wallCount} wall(s) were recovered from wall-named layers at ${wallHeight} mm high and ${wallThickness} mm thick. A DXF carries neither value, so both are assumptions you should check.`,
    );
  }

  for (const [layer, coordinates] of linesByLayer) {
    if (coordinates.length === 0) continue;
    const payload: ImportedMeshPayload = {
      name: `DXF layer ${layer}`,
      positions: new Float32Array(coordinates),
      normals: null,
      indices: null,
      color: '#7f8b96',
      semanticTag: `DXF:${layer}`,
    };
    report.meshes.push(payload);
    report.converted.referenceLayers = (report.converted.referenceLayers ?? 0) + 1;
  }

  for (const [type, count] of unsupportedCounts) {
    report.unsupported.push({
      category: type,
      count,
      reason:
        type === 'ARC' || type === 'CIRCLE' || type === 'ELLIPSE' || type === 'SPLINE'
          ? 'Curved entities are not imported; only straight segments are converted to reference lines.'
          : type === 'INSERT'
            ? 'Block references are not expanded in this build. Explode blocks in your CAD application before exporting.'
            : 'This entity type is not imported.',
    });
  }

  report.stats.durationMs = Date.now() - startedAt;
  report.stats.vertices = report.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  return report;
}

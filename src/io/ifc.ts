import type { ImportReport, ImportedMeshPayload } from './types';
import { emptyReport } from './types';

/**
 * IFC import with semantic recovery.
 *
 * What this actually does, so nobody is surprised:
 *
 *   * **IfcBuildingStorey → levels.** Elevations come straight out of the file.
 *     This is a faithful conversion.
 *   * **IfcWall / IfcWallStandardCase → walls**, when the element's geometry is
 *     a straight, roughly axis-consistent extruded box. We take the plan
 *     bounding box, read the long axis as the centreline and the short axis as
 *     the thickness, and the vertical extent as the height. That covers the
 *     overwhelming majority of walls in practice. Curved walls, walls with
 *     large clipped openings and multi-segment walls fail the test and go to
 *     reference geometry instead — reported, not silently mangled.
 *   * **IfcSpace → rooms**, from the plan bounding box.
 *   * **IfcDoor / IfcWindow → openings**, hosted onto the nearest converted
 *     wall within tolerance. If no host is found the opening is reported as
 *     unconverted rather than left floating.
 *   * **Everything else → reference geometry**, tagged with its IFC type.
 *
 * This module is pure: it takes an already-initialised web-ifc API object. That
 * keeps it runnable in a worker (where it normally runs) and testable in Node.
 */

/** The subset of the web-ifc API this module uses. */
export interface IfcApiLike {
  OpenModel(data: Uint8Array, settings?: Record<string, unknown>): number;
  CloseModel(modelID: number): void;
  GetAllLines(modelID: number): { size(): number; get(index: number): number };
  GetLine(modelID: number, expressID: number, flatten?: boolean): Record<string, unknown>;
  GetLineType(modelID: number, expressID: number): number;
  LoadAllGeometry(modelID: number): { size(): number; get(index: number): FlatMeshLike };
  GetGeometry(modelID: number, geometryExpressID: number): GeometryLike;
  GetVertexArray(pointer: number, size: number): Float32Array;
  GetIndexArray(pointer: number, size: number): Uint32Array;
  GetNameFromTypeCode?(type: number): string;
}

interface FlatMeshLike {
  expressID: number;
  geometries: { size(): number; get(index: number): PlacedGeometryLike };
}

interface PlacedGeometryLike {
  geometryExpressID: number;
  color: { x: number; y: number; z: number; w: number };
  flatTransformation: number[];
}

interface GeometryLike {
  GetVertexData(): number;
  GetVertexDataSize(): number;
  GetIndexData(): number;
  GetIndexDataSize(): number;
  delete?(): void;
}

interface Accumulated {
  expressID: number;
  type: string;
  /** World-space vertices in millimetres. */
  positions: number[];
  indices: number[];
  color: string;
  min: [number, number, number];
  max: [number, number, number];
}

/** Wall-shaped check: long, thin in plan, and tall enough to be a wall. */
const MIN_WALL_LENGTH_MM = 300;
const MAX_WALL_THICKNESS_MM = 1_200;
const MIN_WALL_ASPECT = 2.5;

function typeName(api: IfcApiLike, typeCode: number): string {
  try {
    return api.GetNameFromTypeCode?.(typeCode) ?? `IFCTYPE_${typeCode}`;
  } catch {
    return `IFCTYPE_${typeCode}`;
  }
}

function toHex(color: { x: number; y: number; z: number }): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.x)}${channel(color.y)}${channel(color.z)}`;
}

function applyMatrix(matrix: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    (matrix[0] ?? 1) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 1) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 1) * z + (matrix[14] ?? 0),
  ];
}

function readString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'string') return inner;
    if (typeof inner === 'number') return String(inner);
  }
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  return null;
}

export interface IfcImportOptions {
  /**
   * Multiplier from the file's geometry units to millimetres. web-ifc
   * normalises to metres, so 1000 is correct for a conformant file; the import
   * dialog exposes it because real files are not always conformant.
   */
  scaleToMm?: number;
  /** Cap on reference meshes, to keep a huge federated model importable. */
  maxMeshes?: number;
}

export function importIfc(
  api: IfcApiLike,
  data: Uint8Array,
  options: IfcImportOptions = {},
): ImportReport {
  const startedAt = Date.now();
  const scale = options.scaleToMm ?? 1000;
  const maxMeshes = options.maxMeshes ?? 4_000;
  const report = emptyReport('ifc', data.byteLength);

  let modelID: number;
  try {
    modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
  } catch (error) {
    report.errors.push(
      `The IFC file could not be opened: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return report;
  }

  try {
    const elements = new Map<number, Accumulated>();
    const flatMeshes = api.LoadAllGeometry(modelID);

    for (let i = 0; i < flatMeshes.size() && elements.size < maxMeshes; i += 1) {
      const flat = flatMeshes.get(i);
      const expressID = flat.expressID;
      const type = typeName(api, api.GetLineType(modelID, expressID));

      const accumulated: Accumulated = elements.get(expressID) ?? {
        expressID,
        type,
        positions: [],
        indices: [],
        color: '#b8b8b8',
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      };

      for (let g = 0; g < flat.geometries.size(); g += 1) {
        const placed = flat.geometries.get(g);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

        const base = accumulated.positions.length / 3;
        // web-ifc packs [px, py, pz, nx, ny, nz] per vertex.
        for (let v = 0; v < vertices.length; v += 6) {
          const [x, y, z] = applyMatrix(
            placed.flatTransformation,
            vertices[v] ?? 0,
            vertices[v + 1] ?? 0,
            vertices[v + 2] ?? 0,
          );
          // IFC is Z-up; the project model is Y-up with north on +y.
          const mx = x * scale;
          const my = y * scale;
          const mz = z * scale;
          accumulated.positions.push(mx, my, mz);
          accumulated.min = [
            Math.min(accumulated.min[0], mx),
            Math.min(accumulated.min[1], my),
            Math.min(accumulated.min[2], mz),
          ];
          accumulated.max = [
            Math.max(accumulated.max[0], mx),
            Math.max(accumulated.max[1], my),
            Math.max(accumulated.max[2], mz),
          ];
        }
        for (const index of indices) accumulated.indices.push(base + index);
        accumulated.color = toHex(placed.color);
        geometry.delete?.();
      }

      elements.set(expressID, accumulated);
    }

    if (flatMeshes.size() > maxMeshes) {
      report.warnings.push(
        `The file contains ${flatMeshes.size()} geometric elements; the first ${maxMeshes} were imported. Split the model or import a filtered export for the rest.`,
      );
    }

    const converted = convertSemantics(api, modelID, elements, report, scale);
    buildReferenceMeshes(elements, converted.consumed, report);

    report.stats.durationMs = Date.now() - startedAt;
    for (const mesh of report.meshes) {
      report.stats.vertices += mesh.positions.length / 3;
      report.stats.triangles += (mesh.indices?.length ?? 0) / 3;
    }
    return report;
  } finally {
    try {
      api.CloseModel(modelID);
    } catch {
      // Closing a model that failed to open is not an error worth surfacing.
    }
  }
}

interface ConvertedWall {
  elementId: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  thickness: number;
  base: number;
  height: number;
}

function convertSemantics(
  api: IfcApiLike,
  modelID: number,
  elements: Map<number, Accumulated>,
  report: ImportReport,
  scale: number,
): { consumed: Set<number> } {
  const consumed = new Set<number>();
  const bump = (key: string) => {
    report.converted[key] = (report.converted[key] ?? 0) + 1;
  };

  /* -------------------------- Levels -------------------------- */

  const storeys: Array<{ id: string; name: string; elevation: number }> = [];
  try {
    const lines = api.GetAllLines(modelID);
    for (let i = 0; i < lines.size(); i += 1) {
      const expressID = lines.get(i);
      const type = typeName(api, api.GetLineType(modelID, expressID));
      if (type !== 'IFCBUILDINGSTOREY') continue;
      const line = api.GetLine(modelID, expressID);
      const name = readString(line.Name) ?? `Level ${storeys.length + 1}`;
      const elevation = (readNumber(line.Elevation) ?? 0) * scale;
      storeys.push({ id: `lvl_ifc_${expressID}`, name, elevation });
    }
  } catch (error) {
    report.warnings.push(
      `Storey information could not be read (${error instanceof Error ? error.message : 'unknown error'}); imported elements were assigned to the ground level.`,
    );
  }

  storeys.sort((a, b) => a.elevation - b.elevation);
  storeys.forEach((storey, index) => {
    const next = storeys[index + 1];
    report.commands.push({
      type: 'create_level',
      description: `Level from IFC: ${storey.name}`,
      levelId: storey.id,
      name: storey.name,
      elevation: Math.round(storey.elevation),
      height: Math.round(next ? Math.max(next.elevation - storey.elevation, 1_200) : 3_000),
      index,
    });
    bump('levels');
  });

  const levelFor = (elevation: number): string | undefined => {
    let best: { id: string; distance: number } | null = null;
    for (const storey of storeys) {
      const distance = Math.abs(storey.elevation - elevation);
      if (!best || distance < best.distance) best = { id: storey.id, distance };
    }
    return best && best.distance < 2_500 ? best.id : storeys[0]?.id;
  };

  /* -------------------------- Walls --------------------------- */

  const walls: ConvertedWall[] = [];
  let wallsRejected = 0;

  for (const element of elements.values()) {
    if (!/^IFCWALL/.test(element.type)) continue;
    const width = element.max[0] - element.min[0];
    const depth = element.max[1] - element.min[1];
    const height = element.max[2] - element.min[2];

    const longSide = Math.max(width, depth);
    const shortSide = Math.min(width, depth);

    const wallShaped =
      longSide >= MIN_WALL_LENGTH_MM &&
      shortSide > 0 &&
      shortSide <= MAX_WALL_THICKNESS_MM &&
      longSide / shortSide >= MIN_WALL_ASPECT &&
      height >= 300;

    if (!wallShaped) {
      wallsRejected += 1;
      continue;
    }

    const alongX = width >= depth;
    const midY = (element.min[1] + element.max[1]) / 2;
    const midX = (element.min[0] + element.max[0]) / 2;
    const elementId = `wall_ifc_${element.expressID}`;

    const wall: ConvertedWall = {
      elementId,
      start: alongX ? { x: element.min[0], y: midY } : { x: midX, y: element.min[1] },
      end: alongX ? { x: element.max[0], y: midY } : { x: midX, y: element.max[1] },
      thickness: Math.max(shortSide, 1),
      base: element.min[2],
      height: Math.max(height, 1),
    };
    walls.push(wall);
    consumed.add(element.expressID);

    report.commands.push({
      type: 'create_wall',
      description: `Wall from IFC #${element.expressID}`,
      elementId,
      name: `Wall ${element.expressID}`,
      ...(levelFor(wall.base) ? { levelId: levelFor(wall.base) } : {}),
      start: { x: Math.round(wall.start.x), y: Math.round(wall.start.y) },
      end: { x: Math.round(wall.end.x), y: Math.round(wall.end.y) },
      height: Math.round(wall.height),
      thickness: Math.round(wall.thickness),
      materialId: 'mat_plaster_white',
    });
    bump('walls');
  }

  if (wallsRejected > 0) {
    report.unsupported.push({
      category: 'IfcWall',
      count: wallsRejected,
      reason:
        'These walls are curved, multi-segment, or not a straight extruded solid, so a centreline could not be recovered reliably. They were kept as reference geometry.',
    });
  }

  /* -------------------------- Spaces -------------------------- */

  for (const element of elements.values()) {
    if (element.type !== 'IFCSPACE') continue;
    const width = element.max[0] - element.min[0];
    const depth = element.max[1] - element.min[1];
    if (width < 500 || depth < 500) continue;

    let name = `Space ${element.expressID}`;
    try {
      name = readString(api.GetLine(modelID, element.expressID).LongName) ?? name;
    } catch {
      // Falling back to a generated name is fine; the geometry is what matters.
    }

    report.commands.push({
      type: 'create_room',
      description: `Space from IFC #${element.expressID}`,
      name,
      ...(levelFor(element.min[2]) ? { levelId: levelFor(element.min[2]) } : {}),
      outline: [
        { x: Math.round(element.min[0]), y: Math.round(element.min[1]) },
        { x: Math.round(element.max[0]), y: Math.round(element.min[1]) },
        { x: Math.round(element.max[0]), y: Math.round(element.max[1]) },
        { x: Math.round(element.min[0]), y: Math.round(element.max[1]) },
      ],
      programme: 'other',
    });
    consumed.add(element.expressID);
    bump('rooms');
  }

  /* ---------------------- Doors and windows -------------------- */

  let openingsUnhosted = 0;
  for (const element of elements.values()) {
    const isDoor = element.type === 'IFCDOOR';
    const isWindow = element.type === 'IFCWINDOW';
    if (!isDoor && !isWindow) continue;

    const centre = {
      x: (element.min[0] + element.max[0]) / 2,
      y: (element.min[1] + element.max[1]) / 2,
    };
    const host = nearestWall(walls, centre, 900);
    if (!host) {
      openingsUnhosted += 1;
      continue;
    }

    const wallVector = { x: host.end.x - host.start.x, y: host.end.y - host.start.y };
    const wallLength = Math.hypot(wallVector.x, wallVector.y) || 1;
    const along =
      ((centre.x - host.start.x) * wallVector.x + (centre.y - host.start.y) * wallVector.y) /
      wallLength;

    const width = Math.max(
      Math.max(element.max[0] - element.min[0], element.max[1] - element.min[1]),
      100,
    );
    const height = Math.max(element.max[2] - element.min[2], 100);
    const sill = Math.max(0, element.min[2] - host.base);

    if (
      along - width / 2 < -50 ||
      along + width / 2 > wallLength + 50 ||
      sill + height > host.height + 50
    ) {
      openingsUnhosted += 1;
      continue;
    }

    report.commands.push({
      type: 'create_opening',
      description: `${isDoor ? 'Door' : 'Window'} from IFC #${element.expressID}`,
      name: `${isDoor ? 'Door' : 'Window'} ${element.expressID}`,
      hostId: host.elementId,
      kind: isDoor ? 'door' : 'window',
      openingType: isDoor ? 'single-door' : 'fixed-window',
      distanceAlongWall: Math.max(0, Math.round(along)),
      width: Math.round(width),
      height: Math.round(height),
      sillHeight: Math.round(sill),
    });
    consumed.add(element.expressID);
    bump(isDoor ? 'doors' : 'windows');
  }

  if (openingsUnhosted > 0) {
    report.unsupported.push({
      category: 'IfcDoor / IfcWindow',
      count: openingsUnhosted,
      reason:
        'No converted wall was close enough to host these openings, or they did not fit within one. They were kept as reference geometry.',
    });
  }

  return { consumed };
}

function nearestWall(
  walls: readonly ConvertedWall[],
  point: { x: number; y: number },
  tolerance: number,
): ConvertedWall | null {
  let best: { wall: ConvertedWall; distance: number } | null = null;
  for (const wall of walls) {
    const distance = distanceToSegment(point, wall.start, wall.end);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { wall, distance };
  }
  return best?.wall ?? null;
}

function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Turns everything that was not converted into reference meshes, grouped by IFC
 * type so the user can see (and delete) categories rather than thousands of
 * individual objects.
 */
function buildReferenceMeshes(
  elements: Map<number, Accumulated>,
  consumed: Set<number>,
  report: ImportReport,
): void {
  const byType = new Map<string, Accumulated[]>();
  for (const element of elements.values()) {
    if (consumed.has(element.expressID)) continue;
    if (element.positions.length === 0) continue;
    const bucket = byType.get(element.type) ?? [];
    bucket.push(element);
    byType.set(element.type, bucket);
  }

  for (const [type, group] of byType) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const element of group) {
      const base = positions.length / 3;
      // Reference meshes are handed to Three.js, which works in metres, and IFC
      // is Z-up while the scene is Y-up with north on -Z.
      for (let i = 0; i < element.positions.length; i += 3) {
        positions.push(
          (element.positions[i] ?? 0) / 1000,
          (element.positions[i + 2] ?? 0) / 1000,
          -(element.positions[i + 1] ?? 0) / 1000,
        );
      }
      for (const index of element.indices) indices.push(base + index);
    }

    const payload: ImportedMeshPayload = {
      name: type.replace(/^IFC/, '').toLowerCase(),
      positions: new Float32Array(positions),
      normals: null,
      indices: new Uint32Array(indices),
      color: group[0]?.color ?? '#9aa0a6',
      semanticTag: type,
    };
    report.meshes.push(payload);
  }
}

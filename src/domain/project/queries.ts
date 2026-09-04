import { MM_TO_SCENE } from '@/domain/units';
import type { ArchElement, Level, Opening, Point2, ProjectModel, Wall } from './schema';

/**
 * Read-only helpers over the project model.
 *
 * Everything here is pure and cheap; anything that needs to build geometry
 * lives in `src/domain/geometry`.
 */

export function getElement(model: ProjectModel, id: string): ArchElement | undefined {
  return model.elements[id];
}

export function listElements(model: ProjectModel): ArchElement[] {
  return model.elementOrder
    .map((id) => model.elements[id])
    .filter((e): e is ArchElement => Boolean(e));
}

export function elementsOfType<T extends ArchElement['type']>(
  model: ProjectModel,
  type: T,
): Extract<ArchElement, { type: T }>[] {
  return listElements(model).filter((e): e is Extract<ArchElement, { type: T }> => e.type === type);
}

export function getLevel(model: ProjectModel, id: string): Level | undefined {
  return model.levels.find((l) => l.id === id);
}

export function defaultLevelId(model: ProjectModel): string {
  const ground = model.levels.find((l) => l.index === 0) ?? model.levels[0];
  return ground?.id ?? 'lvl_ground';
}

export function levelElevation(model: ProjectModel, levelId: string | null): number {
  if (!levelId) return 0;
  return getLevel(model, levelId)?.elevation ?? 0;
}

/** Openings hosted by a wall, ordered along the wall for stable geometry. */
export function openingsForWall(model: ProjectModel, wallId: string): Opening[] {
  return listElements(model)
    .filter((e): e is Opening => e.type === 'opening' && e.hostId === wallId)
    .sort((a, b) => a.distanceAlongWall - b.distanceAlongWall);
}

export function wallLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}

/** Wall direction in degrees anticlockwise from east (+x). */
export function wallAngleDeg(wall: Wall): number {
  return (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
}

/**
 * Compass label for a wall, derived from its outward normal.
 * The AI and the UI both use this so "the southern wall" resolves the same way.
 */
export function wallOrientation(
  wall: Wall,
  northAngleDeg = 0,
): 'north' | 'south' | 'east' | 'west' {
  // Outward normal of a wall drawn start -> end is the right-hand side.
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const nx = dy;
  const ny = -dx;
  const angle = Math.atan2(ny, nx) * (180 / Math.PI) - northAngleDeg;
  const normalised = ((angle % 360) + 360) % 360;
  if (normalised >= 45 && normalised < 135) return 'north';
  if (normalised >= 135 && normalised < 225) return 'west';
  if (normalised >= 225 && normalised < 315) return 'south';
  return 'east';
}

export function polygonArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function polygonCentroid(points: readonly Point2[]): Point2 {
  let cx = 0;
  let cy = 0;
  let signedArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = a.x * b.y - b.x * a.y;
    signedArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(signedArea) < 1e-9) {
    const n = points.length || 1;
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      y: points.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  signedArea *= 0.5;
  return { x: cx / (6 * signedArea), y: cy / (6 * signedArea) };
}

export function polygonBounds(points: readonly Point2[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  depth: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, depth: maxY - minY };
}

export function rectangleOutline(
  centre: Point2,
  width: number,
  depth: number,
  rotationDeg = 0,
): Point2[] {
  const hw = width / 2;
  const hd = depth / 2;
  const corners: Point2[] = [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return corners.map((c) => ({
    x: centre.x + c.x * cos - c.y * sin,
    y: centre.y + c.x * sin + c.y * cos,
  }));
}

export interface ModelBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  /** Centre in scene (metre) coordinates, ready for the camera controller. */
  sceneCenter: [number, number, number];
  sceneRadius: number;
  isEmpty: boolean;
}

/**
 * Axis-aligned bounds of the whole model (or a subset), in project mm plus a
 * ready-to-use scene-space centre and radius for camera framing.
 */
export function modelBounds(model: ProjectModel, ids?: readonly string[]): ModelBounds {
  const elements = ids
    ? ids.map((id) => model.elements[id]).filter((e): e is ArchElement => Boolean(e))
    : listElements(model);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let seen = false;

  const include = (x: number, yUp: number, z: number) => {
    seen = true;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, yUp);
    maxY = Math.max(maxY, yUp);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };

  for (const element of elements) {
    const base = levelElevation(model, 'levelId' in element ? element.levelId : null);
    switch (element.type) {
      case 'wall': {
        const half = element.thickness / 2;
        for (const p of [element.start, element.end]) {
          include(p.x - half, base + element.baseOffset, p.y - half);
          include(p.x + half, base + element.baseOffset + element.height, p.y + half);
        }
        break;
      }
      case 'slab':
      case 'room':
      case 'roof': {
        const height =
          element.type === 'slab'
            ? element.thickness
            : element.type === 'roof'
              ? element.thickness + (element.kind === 'flat' ? 0 : 4000)
              : (element.ceilingHeight ?? 3000);
        const bottom = element.type === 'roof' ? element.baseElevation : base;
        for (const p of element.outline) {
          include(p.x, bottom, p.y);
          include(p.x, bottom + height, p.y);
        }
        break;
      }
      case 'stair': {
        const run = element.treadDepth * element.steps;
        include(element.position.x - element.width, base, element.position.y - run);
        include(
          element.position.x + element.width,
          base + element.totalRise,
          element.position.y + run,
        );
        break;
      }
      case 'column': {
        include(
          element.position.x - element.width / 2,
          base,
          element.position.y - element.depth / 2,
        );
        include(
          element.position.x + element.width / 2,
          base + element.height,
          element.position.y + element.depth / 2,
        );
        break;
      }
      case 'beam': {
        for (const p of [element.start, element.end]) {
          include(p.x - element.width, base + element.baseOffset, p.y - element.width);
          include(
            p.x + element.width,
            base + element.baseOffset + element.depth,
            p.y + element.width,
          );
        }
        break;
      }
      case 'railing': {
        for (const p of element.path) {
          include(p.x, base, p.y);
          include(p.x, base + element.height, p.y);
        }
        break;
      }
      case 'furniture': {
        include(element.position.x - 1500, base, element.position.y - 1500);
        include(element.position.x + 1500, base + 2000, element.position.y + 1500);
        break;
      }
      case 'imported': {
        include(element.position.x - 5000, element.position.y - 5000, element.position.z - 5000);
        include(element.position.x + 5000, element.position.y + 5000, element.position.z + 5000);
        break;
      }
      default:
        break;
    }
  }

  if (!seen) {
    return {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
      sceneCenter: [0, 1.5, 0],
      sceneRadius: 12,
      isEmpty: true,
    };
  }

  const cx = ((minX + maxX) / 2) * MM_TO_SCENE;
  const cy = ((minY + maxY) / 2) * MM_TO_SCENE;
  // Project +y (north) maps to scene -z.
  const cz = -((minZ + maxZ) / 2) * MM_TO_SCENE;
  const radius =
    Math.max(maxX - minX, maxY - minY, maxZ - minZ, 2000) * MM_TO_SCENE * 0.5 * Math.SQRT2;

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    sceneCenter: [cx, cy, cz],
    sceneRadius: radius,
    isEmpty: false,
  };
}

/** Total floor area across every slab with role `floor`, in mm². */
export function grossFloorArea(model: ProjectModel): number {
  return elementsOfType(model, 'slab')
    .filter((s) => s.role === 'floor')
    .reduce((sum, s) => sum + polygonArea(s.outline), 0);
}

export function countElementsByType(model: ProjectModel): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const element of listElements(model)) {
    counts[element.type] = (counts[element.type] ?? 0) + 1;
  }
  return counts;
}

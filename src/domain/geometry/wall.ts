import { MM_TO_SCENE } from '@/domain/units';
import type { Opening, Wall } from '@/domain/project/schema';
import { addOrientedBox, createBuilder, finishMesh, type MeshData } from './mesh';

/**
 * Wall geometry with hosted openings.
 *
 * The wall is treated as a rectangular elevation in local (u, v) coordinates —
 * u along the wall from `start`, v up from the wall base — punched with
 * axis-aligned rectangular holes for its openings. Rather than reaching for a
 * CSG library (fragile, slow, and a nightmare when a boolean silently fails),
 * we decompose the punched elevation into a small set of solid rectangles:
 *
 *   1. Collect every hole edge as a u-cut and a v-cut.
 *   2. The cuts define a grid; a cell is solid iff its centre is outside every
 *      hole.
 *   3. Merge solid cells horizontally, then merge equal-width columns
 *      vertically.
 *
 * The result is exact (holes are axis-aligned by construction), watertight,
 * cheap, and produces geometry a human can reason about: a wall with one window
 * becomes four panels — under, over, and either side.
 *
 * Everything in and out of the panel functions is millimetres; only
 * `buildWallMesh` converts to scene metres.
 */

export interface WallPanel {
  /** Distance along the wall from `start`, in mm. */
  u0: number;
  u1: number;
  /** Height above the wall base, in mm. */
  v0: number;
  v1: number;
}

export interface WallOpeningRect {
  id: string;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export function wallLengthMm(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}

/** Unit vector along the wall in plan space. */
export function wallDirection(wall: Wall): { x: number; y: number } {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

/**
 * Converts hosted openings into wall-local rectangles, clamped to the wall.
 *
 * Clamping rather than rejecting is deliberate: when a user shortens a wall the
 * openings should stay valid geometry while validation separately reports that
 * they no longer fit, instead of the viewport filling with NaNs.
 */
export function openingRects(wall: Wall, openings: readonly Opening[]): WallOpeningRect[] {
  const length = wallLengthMm(wall);
  const rects: WallOpeningRect[] = [];

  for (const opening of openings) {
    if (!opening.visible) continue;
    const halfWidth = opening.width / 2;
    let u0 = opening.distanceAlongWall - halfWidth;
    let u1 = opening.distanceAlongWall + halfWidth;
    let v0 = opening.sillHeight;
    let v1 = opening.sillHeight + opening.height;

    u0 = Math.max(0, Math.min(u0, length));
    u1 = Math.max(0, Math.min(u1, length));
    v0 = Math.max(0, Math.min(v0, wall.height));
    v1 = Math.max(0, Math.min(v1, wall.height));

    if (u1 - u0 < 1 || v1 - v0 < 1) continue;
    rects.push({ id: opening.id, u0, u1, v0, v1 });
  }
  return rects;
}

function uniqueSorted(values: number[], epsilon = 0.5): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || value - last > epsilon) out.push(value);
  }
  return out;
}

/**
 * Decomposes the punched wall elevation into solid rectangles.
 * Exported so unit tests can assert the panel layout directly, which is far
 * more diagnostic than comparing vertex buffers.
 */
export function decomposeWallPanels(
  lengthMm: number,
  heightMm: number,
  holes: readonly WallOpeningRect[],
): WallPanel[] {
  if (lengthMm <= 0 || heightMm <= 0) return [];
  if (holes.length === 0) return [{ u0: 0, u1: lengthMm, v0: 0, v1: heightMm }];

  const uCuts = uniqueSorted([0, lengthMm, ...holes.flatMap((h) => [h.u0, h.u1])]).filter(
    (u) => u >= -0.5 && u <= lengthMm + 0.5,
  );
  const vCuts = uniqueSorted([0, heightMm, ...holes.flatMap((h) => [h.v0, h.v1])]).filter(
    (v) => v >= -0.5 && v <= heightMm + 0.5,
  );

  const cols = uCuts.length - 1;
  const rows = vCuts.length - 1;
  if (cols < 1 || rows < 1) return [];

  // solid[row][col]
  const solid: boolean[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const rowCells: boolean[] = [];
    const vc = ((vCuts[r] ?? 0) + (vCuts[r + 1] ?? 0)) / 2;
    for (let c = 0; c < cols; c += 1) {
      const uc = ((uCuts[c] ?? 0) + (uCuts[c + 1] ?? 0)) / 2;
      const inHole = holes.some((h) => uc > h.u0 && uc < h.u1 && vc > h.v0 && vc < h.v1);
      rowCells.push(!inHole);
    }
    solid.push(rowCells);
  }

  // Horizontal merge: for each row, collapse runs of solid cells into spans.
  interface Span {
    u0: number;
    u1: number;
  }
  const rowSpans: Span[][] = solid.map((rowCells) => {
    const spans: Span[] = [];
    let startCol = -1;
    for (let c = 0; c <= cols; c += 1) {
      const isSolid = c < cols && rowCells[c] === true;
      if (isSolid && startCol === -1) startCol = c;
      if (!isSolid && startCol !== -1) {
        spans.push({ u0: uCuts[startCol] ?? 0, u1: uCuts[c] ?? 0 });
        startCol = -1;
      }
    }
    return spans;
  });

  // Vertical merge: a span that repeats identically in the row above extends up.
  const panels: WallPanel[] = [];
  const consumed = rowSpans.map((spans) => spans.map(() => false));

  for (let r = 0; r < rows; r += 1) {
    const spans = rowSpans[r] ?? [];
    for (let s = 0; s < spans.length; s += 1) {
      if (consumed[r]?.[s]) continue;
      const span = spans[s]!;
      let topRow = r;
      for (let r2 = r + 1; r2 < rows; r2 += 1) {
        const match = (rowSpans[r2] ?? []).findIndex(
          (candidate, idx) =>
            !consumed[r2]?.[idx] &&
            Math.abs(candidate.u0 - span.u0) < 0.5 &&
            Math.abs(candidate.u1 - span.u1) < 0.5,
        );
        if (match === -1) break;
        const row = consumed[r2];
        if (row) row[match] = true;
        topRow = r2;
      }
      panels.push({
        u0: span.u0,
        u1: span.u1,
        v0: vCuts[r] ?? 0,
        v1: vCuts[topRow + 1] ?? heightMm,
      });
      const row = consumed[r];
      if (row) row[s] = true;
    }
  }

  return panels.filter((p) => p.u1 - p.u0 > 0.5 && p.v1 - p.v0 > 0.5);
}

/**
 * Lateral offset of the wall body from its baseline, in mm.
 * `center` straddles the line; `left`/`right` place the body entirely on one
 * side, which is what you want when a wall is drawn along a grid or a boundary.
 */
export function wallSideOffset(wall: Wall): number {
  switch (wall.alignment) {
    case 'left':
      return wall.thickness / 2;
    case 'right':
      return -wall.thickness / 2;
    default:
      return 0;
  }
}

export interface BuildWallOptions {
  /** Elevation of the hosting level's finished floor, in mm. */
  levelElevation: number;
  /** Texture tile size in mm; matches the assigned material. */
  textureScaleMm?: number;
}

/** Builds the wall solid, punched with its openings, in scene metres. */
export function buildWallMesh(
  wall: Wall,
  openings: readonly Opening[],
  options: BuildWallOptions,
): MeshData {
  const length = wallLengthMm(wall);
  const panels = decomposeWallPanels(length, wall.height, openingRects(wall, openings));
  const builder = createBuilder();

  const dir = wallDirection(wall);
  const sideOffset = wallSideOffset(wall);
  // Plan normal to the wall direction, used to apply the alignment offset.
  const normal = { x: dir.y, y: -dir.x };

  const originXMm = wall.start.x + normal.x * sideOffset;
  const originYMm = wall.start.y + normal.y * sideOffset;
  const baseElevation = options.levelElevation + wall.baseOffset;
  const uvScale = (options.textureScaleMm ?? 1000) * MM_TO_SCENE;

  // Scene space: +x east, +y up, -z north.
  const right = { x: dir.x, z: -dir.y };

  for (const panel of panels) {
    const origin = {
      x: (originXMm + dir.x * panel.u0) * MM_TO_SCENE,
      y: (baseElevation + panel.v0) * MM_TO_SCENE,
      z: -(originYMm + dir.y * panel.u0) * MM_TO_SCENE,
    };
    addOrientedBox(
      builder,
      origin,
      right,
      (panel.u1 - panel.u0) * MM_TO_SCENE,
      (panel.v1 - panel.v0) * MM_TO_SCENE,
      wall.thickness * MM_TO_SCENE,
      uvScale,
    );
  }

  return finishMesh(builder);
}

/**
 * Frame and glazing geometry for one opening, in scene metres.
 *
 * Kept separate from the wall so frames can take a different material and so a
 * wall rebuild does not have to rebuild every opening.
 */
export function buildOpeningMesh(
  wall: Wall,
  opening: Opening,
  options: BuildWallOptions,
): { frame: MeshData; panel: MeshData } {
  const length = wallLengthMm(wall);
  const dir = wallDirection(wall);
  const normal = { x: dir.y, y: -dir.x };
  const sideOffset = wallSideOffset(wall);
  const baseElevation = options.levelElevation + wall.baseOffset;
  const right = { x: dir.x, z: -dir.y };

  const halfWidth = opening.width / 2;
  const u0 = Math.max(0, Math.min(opening.distanceAlongWall - halfWidth, length));
  const u1 = Math.max(0, Math.min(opening.distanceAlongWall + halfWidth, length));
  const v0 = Math.max(0, Math.min(opening.sillHeight, wall.height));
  const v1 = Math.max(0, Math.min(opening.sillHeight + opening.height, wall.height));

  const frameBuilder = createBuilder();
  const panelBuilder = createBuilder();

  if (u1 - u0 < 1 || v1 - v0 < 1) {
    return { frame: finishMesh(frameBuilder), panel: finishMesh(panelBuilder) };
  }

  const originXMm = wall.start.x + normal.x * sideOffset;
  const originYMm = wall.start.y + normal.y * sideOffset;
  const frameThickness = Math.min(wall.thickness, Math.max(40, opening.frameDepth));
  const jamb = 60; // mm of visible frame around the opening

  const place = (
    builder: ReturnType<typeof createBuilder>,
    fromU: number,
    toU: number,
    fromV: number,
    toV: number,
    depthMm: number,
  ) => {
    if (toU - fromU < 1 || toV - fromV < 1) return;
    addOrientedBox(
      builder,
      {
        x: (originXMm + dir.x * fromU) * MM_TO_SCENE,
        y: (baseElevation + fromV) * MM_TO_SCENE,
        z: -(originYMm + dir.y * fromU) * MM_TO_SCENE,
      },
      right,
      (toU - fromU) * MM_TO_SCENE,
      (toV - fromV) * MM_TO_SCENE,
      depthMm * MM_TO_SCENE,
      1,
    );
  };

  // Frame: sill, head, two jambs.
  place(frameBuilder, u0, u1, v0, v0 + jamb, frameThickness);
  place(frameBuilder, u0, u1, v1 - jamb, v1, frameThickness);
  place(frameBuilder, u0, u0 + jamb, v0 + jamb, v1 - jamb, frameThickness);
  place(frameBuilder, u1 - jamb, u1, v0 + jamb, v1 - jamb, frameThickness);

  // Infill: glass for windows and glazed doors, a leaf for solid doors.
  const isGlazed = opening.kind === 'window' || opening.openingType === 'sliding-door';
  const isVoid = opening.openingType === 'opening';
  if (!isVoid) {
    const leafDepth = isGlazed ? 24 : 45;
    place(panelBuilder, u0 + jamb, u1 - jamb, v0 + jamb, v1 - jamb, leafDepth);
  }

  return { frame: finishMesh(frameBuilder), panel: finishMesh(panelBuilder) };
}

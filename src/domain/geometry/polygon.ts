import type { Point2 } from '@/domain/project/schema';

/**
 * Planar polygon utilities.
 *
 * Slabs, rooms and roofs are all "a polygon given a thickness", so triangulation
 * is the single dependency they share. We implement ear clipping rather than
 * pulling in a CSG or tessellation library: architectural outlines are small
 * (tens of points), ear clipping is O(n²) but exact and dependency-free, and
 * having the algorithm in-repo means a degenerate outline produces a diagnosable
 * failure instead of a mystery crash inside a black box.
 */

export function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function isCounterClockwise(points: readonly Point2[]): boolean {
  return signedArea(points) > 0;
}

/** Returns the outline wound counter-clockwise, without mutating the input. */
export function ensureCounterClockwise(points: readonly Point2[]): Point2[] {
  return isCounterClockwise(points) ? [...points] : [...points].reverse();
}

/**
 * Removes duplicate and collinear vertices. Importers and freehand AI outlines
 * both produce these, and ear clipping cannot make progress on a zero-area ear.
 */
export function cleanOutline(points: readonly Point2[], epsilon = 0.5): Point2[] {
  const deduped: Point2[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > epsilon) deduped.push({ ...p });
  }
  while (
    deduped.length > 1 &&
    Math.hypot(
      deduped[0]!.x - deduped[deduped.length - 1]!.x,
      deduped[0]!.y - deduped[deduped.length - 1]!.y,
    ) <= epsilon
  ) {
    deduped.pop();
  }
  if (deduped.length < 3) return deduped;

  const result: Point2[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const prev = deduped[(i - 1 + deduped.length) % deduped.length]!;
    const curr = deduped[i]!;
    const next = deduped[(i + 1) % deduped.length]!;
    const cross = (curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x);
    // Cross product is twice the triangle area; scale-aware collinearity test.
    if (Math.abs(cross) > epsilon * epsilon) result.push(curr);
  }
  return result.length >= 3 ? result : deduped;
}

function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon.
 *
 * Returns index triples into the *cleaned, counter-clockwise* outline that
 * `triangulate` also returns, so callers must use the returned `outline` rather
 * than the outline they passed in.
 */
export function triangulate(points: readonly Point2[]): {
  outline: Point2[];
  triangles: Array<[number, number, number]>;
} {
  const outline = ensureCounterClockwise(cleanOutline(points));
  const triangles: Array<[number, number, number]> = [];
  if (outline.length < 3) return { outline, triangles };

  const indices = outline.map((_, i) => i);
  let guard = indices.length * indices.length + 16;

  while (indices.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < indices.length; i += 1) {
      const iPrev = indices[(i - 1 + indices.length) % indices.length]!;
      const iCurr = indices[i]!;
      const iNext = indices[(i + 1) % indices.length]!;
      const a = outline[iPrev]!;
      const b = outline[iCurr]!;
      const c = outline[iNext]!;

      // Convex test in CCW winding.
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 0) continue;

      // No other vertex may fall inside the candidate ear.
      let contains = false;
      for (const other of indices) {
        if (other === iPrev || other === iCurr || other === iNext) continue;
        if (pointInTriangle(outline[other]!, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      triangles.push([iPrev, iCurr, iNext]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Self-intersecting or otherwise non-simple outline: fall back to a fan so
      // the user still sees something, and let validation report the problem.
      break;
    }
  }

  if (indices.length === 3) {
    triangles.push([indices[0]!, indices[1]!, indices[2]!]);
  } else if (indices.length > 3) {
    for (let i = 1; i < indices.length - 1; i += 1) {
      triangles.push([indices[0]!, indices[i]!, indices[i + 1]!]);
    }
  }

  return { outline, triangles };
}

export function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Miter offset of a closed outline by `distance` mm (positive = outward).
 *
 * Used for roof overhangs and wall-line derived outlines. Miter offsetting is
 * exact for convex outlines and correct for gentle concavity; sharp reflex
 * corners are clamped to a 4× miter limit rather than shooting off to infinity.
 * Self-intersections at large offsets are *not* resolved — that would need a
 * full straight-skeleton implementation, which is not worth the maintenance
 * burden here. Callers keep offsets small (overhang is capped at 5 m).
 */
export function offsetPolygon(points: readonly Point2[], distance: number): Point2[] {
  const outline = ensureCounterClockwise(cleanOutline(points));
  if (outline.length < 3 || Math.abs(distance) < 1e-6) return outline;

  const result: Point2[] = [];
  const miterLimit = 4;

  for (let i = 0; i < outline.length; i += 1) {
    const prev = outline[(i - 1 + outline.length) % outline.length]!;
    const curr = outline[i]!;
    const next = outline[(i + 1) % outline.length]!;

    const e1 = normalise2({ x: curr.x - prev.x, y: curr.y - prev.y });
    const e2 = normalise2({ x: next.x - curr.x, y: next.y - curr.y });

    // Outward normal for CCW winding is (dy, -dx).
    const n1 = { x: e1.y, y: -e1.x };
    const n2 = { x: e2.y, y: -e2.x };

    const bisector = normalise2({ x: n1.x + n2.x, y: n1.y + n2.y });
    const cosHalf = bisector.x * n1.x + bisector.y * n1.y;
    const scale = Math.abs(cosHalf) < 1e-6 ? miterLimit : Math.min(1 / cosHalf, miterLimit);

    result.push({
      x: curr.x + bisector.x * distance * scale,
      y: curr.y + bisector.y * distance * scale,
    });
  }
  return result;
}

function normalise2(v: Point2): Point2 {
  const length = Math.hypot(v.x, v.y);
  if (length < 1e-12) return { x: 0, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

/** Perimeter length of a closed outline, in the same units as the input. */
export function perimeter(points: readonly Point2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

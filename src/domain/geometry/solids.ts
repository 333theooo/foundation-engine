import { MM_TO_SCENE, degToRad } from '@/domain/units';
import type { Beam, Column, Point2, Railing, Roof, Slab, Stair } from '@/domain/project/schema';
import { getCatalogItem } from '@/domain/project/furnitureCatalog';
import {
  addBox,
  addOrientedBox,
  addQuad,
  addTriangle,
  createBuilder,
  finishMesh,
  type MeshBuilder,
  type MeshData,
  type Vec3,
} from './mesh';
import { cleanOutline, ensureCounterClockwise, offsetPolygon, triangulate } from './polygon';

/**
 * Solid generators for every non-wall architectural element.
 *
 * Same contract as `wall.ts`: millimetres in, scene metres out, no Three.js.
 */

/** Extrudes a plan polygon vertically into a closed prism. */
export function buildPrism(
  outline: readonly Point2[],
  bottomMm: number,
  topMm: number,
  uvScaleMm = 1000,
): MeshData {
  const builder = createBuilder();
  addPrism(builder, outline, bottomMm, topMm, uvScaleMm);
  return finishMesh(builder);
}

function addPrism(
  builder: MeshBuilder,
  outline: readonly Point2[],
  bottomMm: number,
  topMm: number,
  uvScaleMm: number,
): void {
  const { outline: clean, triangles } = triangulate(outline);
  if (clean.length < 3 || topMm <= bottomMm) return;

  const uv = uvScaleMm * MM_TO_SCENE;
  const bottom = bottomMm * MM_TO_SCENE;
  const top = topMm * MM_TO_SCENE;
  const toVec = (p: Point2, y: number): Vec3 => ({
    x: p.x * MM_TO_SCENE,
    y,
    z: -p.y * MM_TO_SCENE,
  });

  // Top face (CCW in plan reads clockwise looking down in a -Z north frame,
  // so the winding is reversed to point the normal up).
  for (const [a, b, c] of triangles) {
    addTriangle(builder, toVec(clean[a]!, top), toVec(clean[c]!, top), toVec(clean[b]!, top), uv);
  }
  // Bottom face.
  for (const [a, b, c] of triangles) {
    addTriangle(
      builder,
      toVec(clean[a]!, bottom),
      toVec(clean[b]!, bottom),
      toVec(clean[c]!, bottom),
      uv,
    );
  }
  // Sides.
  for (let i = 0; i < clean.length; i += 1) {
    const p0 = clean[i]!;
    const p1 = clean[(i + 1) % clean.length]!;
    addQuad(builder, toVec(p0, bottom), toVec(p1, bottom), toVec(p1, top), toVec(p0, top), uv);
  }
}

export function buildSlabMesh(slab: Slab, levelElevationMm: number, uvScaleMm = 1000): MeshData {
  const top = levelElevationMm + slab.topOffset;
  return buildPrism(slab.outline, top - slab.thickness, top, uvScaleMm);
}

/**
 * Roof geometry.
 *
 * Flat roofs are a prism. Shed and gable roofs are built by lifting the roof
 * plane: every outline vertex gets an elevation from a linear height function,
 * then top and bottom surfaces are triangulated with matching topology and
 * stitched at the edges. That keeps a gable watertight for arbitrary outlines
 * rather than only for rectangles.
 */
export function buildRoofMesh(roof: Roof, uvScaleMm = 1000): MeshData {
  const outline = ensureCounterClockwise(cleanOutline(offsetPolygon(roof.outline, roof.overhang)));
  if (outline.length < 3) {
    return buildPrism(roof.outline, roof.baseElevation, roof.baseElevation + roof.thickness);
  }

  if (roof.kind === 'flat') {
    return buildPrism(outline, roof.baseElevation, roof.baseElevation + roof.thickness, uvScaleMm);
  }

  // The axis the roof falls along: for a ridge running east-west, height varies
  // with north-south position, and vice versa.
  const axisOf = (p: Point2) => (roof.ridgeAxis === 'x' ? p.y : p.x);
  const axisValues = outline.map(axisOf);
  const min = Math.min(...axisValues);
  const max = Math.max(...axisValues);
  const span = Math.max(max - min, 1);
  const slope = Math.tan(degToRad(roof.pitchDeg));
  const ridge = (min + max) / 2;

  /** Height above `baseElevation` at a given plan point, in mm. */
  const heightAt = (p: Point2): number => {
    const t = axisOf(p);
    if (roof.kind === 'shed') return (t - min) * slope;
    return (span / 2 - Math.abs(t - ridge)) * slope;
  };

  const builder = createBuilder();
  const uv = uvScaleMm * MM_TO_SCENE;
  const toVec = (p: Point2, extraMm: number): Vec3 => ({
    x: p.x * MM_TO_SCENE,
    y: (roof.baseElevation + heightAt(p) + extraMm) * MM_TO_SCENE,
    z: -p.y * MM_TO_SCENE,
  });

  /**
   * A gable folds along the ridge, so the surface cannot be triangulated as one
   * polygon: an ear spanning both slopes would cut straight through the fold.
   * Each slope is therefore clipped out and triangulated on its own. A shed roof
   * is a single plane and needs no split.
   */
  const faces: Point2[][] =
    roof.kind === 'gable'
      ? [
          clipHalfPlane(outline, axisOf, ridge, 'below'),
          clipHalfPlane(outline, axisOf, ridge, 'above'),
        ].filter((face) => face.length >= 3)
      : [outline];

  for (const face of faces) {
    const { outline: clean, triangles } = triangulate(face);
    if (clean.length < 3) continue;
    for (const [a, b, c] of triangles) {
      // Top surface; winding reversed because plan CCW reads clockwise from
      // above in a right-handed Y-up frame with north on -Z.
      addTriangle(
        builder,
        toVec(clean[a]!, roof.thickness),
        toVec(clean[c]!, roof.thickness),
        toVec(clean[b]!, roof.thickness),
        uv,
      );
      addTriangle(builder, toVec(clean[a]!, 0), toVec(clean[b]!, 0), toVec(clean[c]!, 0), uv);
    }
  }

  // Fascia around the perimeter. Edges that cross the ridge are subdivided at
  // the crossing so the fascia follows the fold instead of cutting the corner.
  for (let i = 0; i < outline.length; i += 1) {
    const p0 = outline[i]!;
    const p1 = outline[(i + 1) % outline.length]!;
    const segments =
      roof.kind === 'gable' ? splitAtRidge(p0, p1, axisOf, ridge) : [[p0, p1] as const];
    for (const [a, b] of segments) {
      addQuad(
        builder,
        toVec(a, 0),
        toVec(b, 0),
        toVec(b, roof.thickness),
        toVec(a, roof.thickness),
        uv,
      );
    }
  }

  return finishMesh(builder);
}

/**
 * Sutherland-Hodgman clip of a plan polygon against a half-plane on one axis.
 * Exact for convex outlines; a deeply concave outline can produce a face with a
 * zero-width bridge, which triangulates harmlessly.
 */
function clipHalfPlane(
  points: readonly Point2[],
  axisOf: (p: Point2) => number,
  value: number,
  keep: 'below' | 'above',
): Point2[] {
  const inside = (p: Point2) => (keep === 'below' ? axisOf(p) <= value : axisOf(p) >= value);
  const result: Point2[] = [];

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const currentIn = inside(current);
    const nextIn = inside(next);

    if (currentIn) result.push(current);
    if (currentIn !== nextIn) {
      const crossing = intersectAtAxis(current, next, axisOf, value);
      if (crossing) result.push(crossing);
    }
  }
  return cleanOutline(result);
}

function splitAtRidge(
  a: Point2,
  b: Point2,
  axisOf: (p: Point2) => number,
  value: number,
): Array<readonly [Point2, Point2]> {
  const ta = axisOf(a);
  const tb = axisOf(b);
  if ((ta - value) * (tb - value) >= 0) return [[a, b]];
  const crossing = intersectAtAxis(a, b, axisOf, value);
  return crossing
    ? [
        [a, crossing],
        [crossing, b],
      ]
    : [[a, b]];
}

function intersectAtAxis(
  a: Point2,
  b: Point2,
  axisOf: (p: Point2) => number,
  value: number,
): Point2 | null {
  const ta = axisOf(a);
  const tb = axisOf(b);
  const denominator = tb - ta;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = (value - ta) / denominator;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Straight, L-shaped and U-shaped stairs as stacked tread/riser boxes.
 *
 * `steps` is the number of risers; a flight of N risers has N − 1 treads plus
 * the upper floor. Building from boxes means the stair reads correctly in
 * section and can be measured, which matters more at schematic stage than a
 * smooth stringer would.
 */
export function buildStairMesh(stair: Stair, levelElevationMm: number): MeshData {
  const builder = createBuilder();
  const riserHeight = stair.totalRise / stair.steps;
  const rad = degToRad(stair.rotationDeg);
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const perp = { x: -dir.y, y: dir.x };

  const flights =
    stair.shape === 'straight'
      ? [{ from: 0, to: stair.steps, dir, origin: { ...stair.position } }]
      : buildTurnedFlights(stair, dir, perp);

  for (const flight of flights) {
    let cursor = { ...flight.origin };
    for (let i = flight.from; i < flight.to; i += 1) {
      const stepTop = levelElevationMm + (i + 1) * riserHeight;
      const centre = {
        x: cursor.x + flight.dir.x * (stair.treadDepth / 2),
        y: cursor.y + flight.dir.y * (stair.treadDepth / 2),
      };
      // A solid block from the floor to the tread keeps the stair readable in
      // section and avoids floating treads at schematic level of detail.
      addOrientedBox(
        builder,
        {
          x: (centre.x - flight.dir.x * (stair.treadDepth / 2)) * MM_TO_SCENE,
          y: levelElevationMm * MM_TO_SCENE,
          z: -(centre.y - flight.dir.y * (stair.treadDepth / 2)) * MM_TO_SCENE,
        },
        { x: flight.dir.x, z: -flight.dir.y },
        stair.treadDepth * MM_TO_SCENE,
        (stepTop - levelElevationMm) * MM_TO_SCENE,
        stair.width * MM_TO_SCENE,
        1,
      );
      cursor = {
        x: cursor.x + flight.dir.x * stair.treadDepth,
        y: cursor.y + flight.dir.y * stair.treadDepth,
      };
    }
  }

  return finishMesh(builder);
}

function buildTurnedFlights(
  stair: Stair,
  dir: { x: number; y: number },
  perp: { x: number; y: number },
): Array<{ from: number; to: number; dir: { x: number; y: number }; origin: Point2 }> {
  const half = Math.floor(stair.steps / 2);
  const firstRun = half * stair.treadDepth;
  const landingOrigin = {
    x: stair.position.x + dir.x * (firstRun + stair.landingDepth),
    y: stair.position.y + dir.y * (firstRun + stair.landingDepth),
  };

  // L-shaped turns 90°, U-shaped turns 180° and returns alongside the lower flight.
  const secondDir =
    stair.shape === 'l-shaped' ? { x: perp.x, y: perp.y } : { x: -dir.x, y: -dir.y };
  const secondOrigin =
    stair.shape === 'l-shaped'
      ? landingOrigin
      : {
          x: landingOrigin.x + perp.x * stair.width,
          y: landingOrigin.y + perp.y * stair.width,
        };

  return [
    { from: 0, to: half, dir, origin: { ...stair.position } },
    { from: half, to: stair.steps, dir: secondDir, origin: secondOrigin },
  ];
}

export function buildColumnMesh(column: Column, levelElevationMm: number): MeshData {
  const builder = createBuilder();
  const centre: Vec3 = {
    x: column.position.x * MM_TO_SCENE,
    y: (levelElevationMm + column.height / 2) * MM_TO_SCENE,
    z: -column.position.y * MM_TO_SCENE,
  };

  if (column.shape === 'round') {
    addCylinder(builder, centre, (column.width / 2) * MM_TO_SCENE, column.height * MM_TO_SCENE, 20);
  } else if (Math.abs(column.rotationDeg % 360) < 0.01) {
    addBox(builder, centre, {
      x: column.width * MM_TO_SCENE,
      y: column.height * MM_TO_SCENE,
      z: column.depth * MM_TO_SCENE,
    });
  } else {
    const rad = degToRad(column.rotationDeg);
    const dir = { x: Math.cos(rad), z: -Math.sin(rad) };
    addOrientedBox(
      builder,
      {
        x: centre.x - (dir.x * column.width * MM_TO_SCENE) / 2,
        y: levelElevationMm * MM_TO_SCENE,
        z: centre.z - (dir.z * column.width * MM_TO_SCENE) / 2,
      },
      dir,
      column.width * MM_TO_SCENE,
      column.height * MM_TO_SCENE,
      column.depth * MM_TO_SCENE,
    );
  }
  return finishMesh(builder);
}

export function buildBeamMesh(beam: Beam, levelElevationMm: number): MeshData {
  const builder = createBuilder();
  const dx = beam.end.x - beam.start.x;
  const dy = beam.end.y - beam.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return finishMesh(builder);

  addOrientedBox(
    builder,
    {
      x: beam.start.x * MM_TO_SCENE,
      y: (levelElevationMm + beam.baseOffset) * MM_TO_SCENE,
      z: -beam.start.y * MM_TO_SCENE,
    },
    { x: dx / length, z: -dy / length },
    length * MM_TO_SCENE,
    beam.depth * MM_TO_SCENE,
    beam.width * MM_TO_SCENE,
  );
  return finishMesh(builder);
}

export function buildRailingMesh(railing: Railing, levelElevationMm: number): MeshData {
  const builder = createBuilder();
  const base = levelElevationMm * MM_TO_SCENE;
  const top = (levelElevationMm + railing.height) * MM_TO_SCENE;
  const railDepth = 50 * MM_TO_SCENE;

  for (let i = 0; i < railing.path.length - 1; i += 1) {
    const a = railing.path[i]!;
    const b = railing.path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const dir = { x: dx / length, z: -dy / length };

    // Handrail.
    addOrientedBox(
      builder,
      { x: a.x * MM_TO_SCENE, y: top - railDepth, z: -a.y * MM_TO_SCENE },
      dir,
      length * MM_TO_SCENE,
      railDepth,
      railDepth,
    );

    if (railing.infill === 'glass' || railing.infill === 'solid') {
      const thickness = (railing.infill === 'glass' ? 15 : 100) * MM_TO_SCENE;
      addOrientedBox(
        builder,
        { x: a.x * MM_TO_SCENE, y: base + 0.05, z: -a.y * MM_TO_SCENE },
        dir,
        length * MM_TO_SCENE,
        top - base - railDepth - 0.05,
        thickness,
      );
    } else if (railing.infill === 'vertical-bars') {
      const count = Math.max(2, Math.ceil(length / Math.max(railing.postSpacing, 80)));
      const barSize = 30 * MM_TO_SCENE;
      for (let s = 0; s <= count; s += 1) {
        const t = s / count;
        const px = (a.x + dx * t) * MM_TO_SCENE;
        const pz = -(a.y + dy * t) * MM_TO_SCENE;
        addBox(
          builder,
          { x: px, y: (base + top) / 2, z: pz },
          { x: barSize, y: top - base, z: barSize },
        );
      }
    }
  }
  return finishMesh(builder);
}

/**
 * Catalogue geometry in **local space**, centred on its own footprint origin.
 *
 * Separate from `buildFurnitureMesh` because instanced rendering needs one
 * geometry shared by every copy, with placement carried in a per-instance
 * matrix. Twenty identical chairs then cost one draw call instead of twenty.
 */
export function buildCatalogItemMesh(catalogId: string, scale = 1): MeshData {
  const item = getCatalogItem(catalogId);
  const builder = createBuilder();
  if (!item) return finishMesh(builder);

  for (const part of item.parts) {
    addBox(
      builder,
      {
        x: part.cx * scale * MM_TO_SCENE,
        y: part.cy * scale * MM_TO_SCENE,
        z: part.cz * scale * MM_TO_SCENE,
      },
      {
        x: part.w * scale * MM_TO_SCENE,
        y: part.h * scale * MM_TO_SCENE,
        z: part.d * scale * MM_TO_SCENE,
      },
    );
  }
  return finishMesh(builder);
}

/**
 * Furniture from the internal catalogue: each item is a fixed set of boxes, so
 * a model response can never construct arbitrary geometry through this path.
 * Returns per-part colour overrides alongside the mesh so the adapter can split
 * a single item into a couple of materials without a second catalogue lookup.
 */
export function buildFurnitureMesh(
  catalogId: string,
  positionMm: Point2,
  rotationDeg: number,
  scale: number,
  levelElevationMm: number,
): { mesh: MeshData; accents: Array<{ mesh: MeshData; color: string }> } {
  const item = getCatalogItem(catalogId);
  const builder = createBuilder();
  const accentBuilders = new Map<string, MeshBuilder>();
  if (!item) return { mesh: finishMesh(builder), accents: [] };

  const rad = degToRad(rotationDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (const part of item.parts) {
    // Local part space: +x right, +y up, +z "depth". Rotate about the item origin.
    const lx = part.cx * scale;
    const lz = part.cz * scale;
    const wx = positionMm.x + lx * cos - lz * sin;
    const wy = positionMm.y + lx * sin + lz * cos;

    const target = part.color
      ? (accentBuilders.get(part.color) ??
        (() => {
          const b = createBuilder();
          accentBuilders.set(part.color!, b);
          return b;
        })())
      : builder;

    // Rotation in plan means the box is oriented; use the oriented helper.
    addOrientedBox(
      target,
      {
        x: (wx - (cos * part.w * scale) / 2) * MM_TO_SCENE,
        y: (levelElevationMm + (part.cy - part.h / 2) * scale) * MM_TO_SCENE,
        z: -(wy - (sin * part.w * scale) / 2) * MM_TO_SCENE,
      },
      { x: cos, z: -sin },
      part.w * scale * MM_TO_SCENE,
      part.h * scale * MM_TO_SCENE,
      part.d * scale * MM_TO_SCENE,
    );
  }

  return {
    mesh: finishMesh(builder),
    accents: [...accentBuilders.entries()].map(([color, b]) => ({ mesh: finishMesh(b), color })),
  };
}

function addCylinder(
  builder: MeshBuilder,
  centre: Vec3,
  radius: number,
  height: number,
  segments: number,
): void {
  const half = height / 2;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = centre.x + Math.cos(a0) * radius;
    const z0 = centre.z + Math.sin(a0) * radius;
    const x1 = centre.x + Math.cos(a1) * radius;
    const z1 = centre.z + Math.sin(a1) * radius;

    addQuad(
      builder,
      { x: x0, y: centre.y - half, z: z0 },
      { x: x1, y: centre.y - half, z: z1 },
      { x: x1, y: centre.y + half, z: z1 },
      { x: x0, y: centre.y + half, z: z0 },
    );
    addTriangle(
      builder,
      { x: centre.x, y: centre.y + half, z: centre.z },
      { x: x0, y: centre.y + half, z: z0 },
      { x: x1, y: centre.y + half, z: z1 },
    );
    addTriangle(
      builder,
      { x: centre.x, y: centre.y - half, z: centre.z },
      { x: x1, y: centre.y - half, z: z1 },
      { x: x0, y: centre.y - half, z: z0 },
    );
  }
}

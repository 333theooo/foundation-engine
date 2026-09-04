import { MM_TO_SCENE } from '@/domain/units';

/**
 * Geometry primitives.
 *
 * Two deliberate choices govern this whole directory:
 *
 * 1. **No Three.js import.** Generators are pure numeric functions, so they run
 *    unchanged in Vitest under Node, in a Web Worker, and on the server for
 *    export. `src/three` is the only place that knows about BufferGeometry.
 *
 * 2. **Generators take millimetres and emit metres.** Every public function
 *    here accepts model units (mm) and returns scene units (m), converting once
 *    at the boundary. Three.js lights, shadow bias and camera near/far planes
 *    all assume metres, so the scene stays idiomatic while the model stays
 *    exact.
 *
 * Project coordinates are `{ x: east, y: north }` with elevation up. Scene
 * coordinates are right-handed Y-up, so north maps to −Z.
 */

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface MeshBuilder {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export function createBuilder(): MeshBuilder {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

export function finishMesh(builder: MeshBuilder): MeshData {
  return {
    positions: new Float32Array(builder.positions),
    normals: new Float32Array(builder.normals),
    uvs: new Float32Array(builder.uvs),
    indices: new Uint32Array(builder.indices),
  };
}

export const EMPTY_MESH: MeshData = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  indices: new Uint32Array(0),
};

/** Converts a plan point plus an elevation (all mm) into scene metres. */
export function toScene(xMm: number, elevationMm: number, yMm: number): [number, number, number] {
  return [xMm * MM_TO_SCENE, elevationMm * MM_TO_SCENE, -yMm * MM_TO_SCENE];
}

export function mm(value: number): number {
  return value * MM_TO_SCENE;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-12) return { x: 0, y: 1, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * Appends a planar quad (a → b → c → d, counter-clockwise when viewed from the
 * front face) with a flat normal and UVs derived from the quad's own extent, so
 * textures tile at a real-world scale instead of stretching with the face.
 */
export function addQuad(
  builder: MeshBuilder,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  uvScale = 1,
): void {
  const n = normalise(cross(sub(b, a), sub(d, a)));
  const base = builder.positions.length / 3;

  const width = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const height = Math.hypot(d.x - a.x, d.y - a.y, d.z - a.z);
  const u = width / uvScale;
  const v = height / uvScale;

  const corners: Array<[Vec3, number, number]> = [
    [a, 0, 0],
    [b, u, 0],
    [c, u, v],
    [d, 0, v],
  ];
  for (const [p, tu, tv] of corners) {
    builder.positions.push(p.x, p.y, p.z);
    builder.normals.push(n.x, n.y, n.z);
    builder.uvs.push(tu, tv);
  }
  builder.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

export function addTriangle(builder: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, uvScale = 1): void {
  const n = normalise(cross(sub(b, a), sub(c, a)));
  const base = builder.positions.length / 3;
  for (const p of [a, b, c]) {
    builder.positions.push(p.x, p.y, p.z);
    builder.normals.push(n.x, n.y, n.z);
    // Planar UV projection onto the dominant axis pair keeps tiling sane.
    const absN = { x: Math.abs(n.x), y: Math.abs(n.y), z: Math.abs(n.z) };
    if (absN.y >= absN.x && absN.y >= absN.z) builder.uvs.push(p.x / uvScale, p.z / uvScale);
    else if (absN.x >= absN.z) builder.uvs.push(p.z / uvScale, p.y / uvScale);
    else builder.uvs.push(p.x / uvScale, p.y / uvScale);
  }
  builder.indices.push(base, base + 1, base + 2);
}

/**
 * Adds an axis-aligned box given its centre and full extents, all in scene
 * metres. Boxes are the workhorse of this geometry layer: walls, stairs,
 * columns, beams and furniture all decompose into them, which keeps the code
 * predictable and the geometry watertight.
 */
export function addBox(builder: MeshBuilder, centre: Vec3, size: Vec3, uvScale = 1): void {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  const { x, y, z } = centre;

  const p = (dx: number, dy: number, dz: number): Vec3 => ({
    x: x + dx * hx,
    y: y + dy * hy,
    z: z + dz * hz,
  });

  // +X, -X, +Y, -Y, +Z, -Z
  addQuad(builder, p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), uvScale);
  addQuad(builder, p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1), uvScale);
  addQuad(builder, p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1), uvScale);
  addQuad(builder, p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), uvScale);
  addQuad(builder, p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), uvScale);
  addQuad(builder, p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), uvScale);
}

/**
 * Adds a box expressed in a rotated local frame. `right` and `forward` are unit
 * vectors in the XZ plane; used for walls and beams, which are boxes aligned to
 * an arbitrary plan direction.
 */
export function addOrientedBox(
  builder: MeshBuilder,
  origin: Vec3,
  right: { x: number; z: number },
  length: number,
  height: number,
  thickness: number,
  uvScale = 1,
): void {
  const nx = -right.z;
  const nz = right.x;
  const ht = thickness / 2;

  const corner = (along: number, up: number, side: number): Vec3 => ({
    x: origin.x + right.x * along + nx * side * ht,
    y: origin.y + up,
    z: origin.z + right.z * along + nz * side * ht,
  });

  const a0 = corner(0, 0, 1);
  const a1 = corner(length, 0, 1);
  const a2 = corner(length, height, 1);
  const a3 = corner(0, height, 1);
  const b0 = corner(0, 0, -1);
  const b1 = corner(length, 0, -1);
  const b2 = corner(length, height, -1);
  const b3 = corner(0, height, -1);

  addQuad(builder, a0, a1, a2, a3, uvScale); // front face
  addQuad(builder, b1, b0, b3, b2, uvScale); // back face
  addQuad(builder, a3, a2, b2, b3, uvScale); // top
  addQuad(builder, b0, b1, a1, a0, uvScale); // bottom
  addQuad(builder, b0, a0, a3, b3, uvScale); // start cap
  addQuad(builder, a1, b1, b2, a2, uvScale); // end cap
}

/** Concatenates several meshes into one buffer, re-basing indices. */
export function mergeMeshes(meshes: readonly MeshData[]): MeshData {
  let positionCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    positionCount += m.positions.length;
    indexCount += m.indices.length;
  }
  const positions = new Float32Array(positionCount);
  const normals = new Float32Array(positionCount);
  const uvs = new Float32Array((positionCount / 3) * 2);
  const indices = new Uint32Array(indexCount);

  let po = 0;
  let uo = 0;
  let io = 0;
  let vertexOffset = 0;
  for (const m of meshes) {
    positions.set(m.positions, po);
    normals.set(m.normals, po);
    uvs.set(m.uvs, uo);
    for (let i = 0; i < m.indices.length; i += 1) {
      indices[io + i] = (m.indices[i] ?? 0) + vertexOffset;
    }
    vertexOffset += m.positions.length / 3;
    po += m.positions.length;
    uo += m.uvs.length;
    io += m.indices.length;
  }
  return { positions, normals, uvs, indices };
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

/** Axis-aligned bounds of a mesh in scene metres. Used for framing and tests. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 } | null {
  if (mesh.positions.length === 0) return null;
  const min = vec(Infinity, Infinity, Infinity);
  const max = vec(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0;
    const y = mesh.positions[i + 1] ?? 0;
    const z = mesh.positions[i + 2] ?? 0;
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  return { min, max };
}

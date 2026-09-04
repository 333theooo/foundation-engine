/**
 * Import and export contracts.
 *
 * The honest position on import, stated once here and repeated in the UI:
 *
 * Not every file can become editable native geometry. A glTF mesh has no idea
 * what a wall is. An IFC file does, but its walls can be swept solids, curved,
 * or built from clipping operations that no reasonable heuristic recovers as a
 * centreline. A DXF is lines on layers.
 *
 * So an import produces two things, and always reports which is which:
 *
 *   * **Converted elements** — real, parametric, editable walls, levels, rooms
 *     and openings, recovered where the source carries enough semantics and the
 *     geometry fits the pattern.
 *   * **Reference geometry** — everything else, brought in as a single
 *     non-editable element you can trace over, measure against, and delete.
 *
 * `ImportReport` exists so the user sees that split rather than discovering it
 * later when a wall will not move.
 */

export type ImportFormat = 'json' | 'gltf' | 'glb' | 'obj' | 'stl' | 'ifc' | 'dxf';

export interface ImportedMeshPayload {
  name: string;
  /** Interleaved XYZ positions in scene metres. */
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  color: string;
  /** IFC type or DXF layer, when the source carried one. */
  semanticTag: string | null;
}

export interface ImportReport {
  format: ImportFormat;
  /** Commands that create real, editable elements. */
  commands: unknown[];
  /** Geometry that could not be converted, kept as reference. */
  meshes: ImportedMeshPayload[];
  /** Counts by source category, so the user can see what came in. */
  converted: Record<string, number>;
  /** Categories present in the file that this build does not convert. */
  unsupported: Array<{ category: string; count: number; reason: string }>;
  warnings: string[];
  errors: string[];
  stats: {
    bytes: number;
    durationMs: number;
    vertices: number;
    triangles: number;
  };
}

export function emptyReport(format: ImportFormat, bytes: number): ImportReport {
  return {
    format,
    commands: [],
    meshes: [],
    converted: {},
    unsupported: [],
    warnings: [],
    errors: [],
    stats: { bytes, durationMs: 0, vertices: 0, triangles: 0 },
  };
}

export type ExportFormat = 'json' | 'glb' | 'gltf' | 'obj' | 'stl' | 'screenshot' | 'summary';

export interface ExportOptions {
  format: ExportFormat;
  /** Restrict the export to these elements. Empty means the whole project. */
  elementIds?: string[];
  filename?: string;
}

export interface ExportResult {
  filename: string;
  mimeType: string;
  blob: Blob;
}

/** Messages exchanged with the parse worker. */
export type WorkerRequest =
  | { id: string; kind: 'ifc'; buffer: ArrayBuffer; wasmPath: string; scaleToMm: number }
  | { id: string; kind: 'dxf'; text: string; scaleToMm: number }
  | { id: string; kind: 'obj'; text: string; scaleToMm: number }
  | { id: string; kind: 'stl'; buffer: ArrayBuffer; scaleToMm: number };

export type WorkerResponse =
  | { id: string; ok: true; report: ImportReport }
  | { id: string; ok: false; error: string };

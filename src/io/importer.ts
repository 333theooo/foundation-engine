'use client';

import { MAX_UPLOAD_BYTES } from '@/domain/project/limits';
import { deserializeProject } from '@/domain/project/migrations';
import type { ProjectModel } from '@/domain/project/schema';
import {
  emptyReport,
  type ImportFormat,
  type ImportReport,
  type WorkerRequest,
  type WorkerResponse,
} from './types';

/**
 * Client-side import orchestration.
 *
 * Format routing:
 *
 *   * `json` — a native project. Parsed and migrated on the main thread; it is
 *     small, and the migration chain has to run in the same module the editor
 *     uses so a version mismatch surfaces immediately.
 *   * `ifc`, `dxf`, `obj`, `stl` — the parse worker.
 *   * `gltf`, `glb` — the main thread, because `GLTFLoader` needs the DOM for
 *     its texture path. The loader itself is imported lazily so the three.js
 *     example code is not in the initial bundle.
 */

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<
  string,
  { resolve: (report: ImportReport) => void; reject: (error: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker/parse.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.report);
    else entry.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(event.message || 'The import worker failed.'));
    }
    pending.clear();
  };
  return worker;
}

/**
 * `Omit` collapses a union into its common keys, so it has to be distributed
 * over the request variants explicitly for each one to keep its own fields.
 */
type WorkerRequestBody = WorkerRequest extends infer T
  ? T extends WorkerRequest
    ? Omit<T, 'id'>
    : never
  : never;

function callWorker(
  request: WorkerRequestBody,
  transfers: Transferable[] = [],
): Promise<ImportReport> {
  const id = `req-${(nextRequestId += 1)}`;
  const full = { ...request, id } as WorkerRequest;
  return new Promise<ImportReport>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(full, transfers);
    // A parse that never returns would leave the UI in a loading state forever.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('The import timed out. The file may be too large or malformed.'));
      }
    }, 180_000);
  });
}

export function detectFormat(filename: string): ImportFormat | null {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim())?.[1]?.toLowerCase();
  switch (extension) {
    case 'json':
      return 'json';
    case 'gltf':
      return 'gltf';
    case 'glb':
      return 'glb';
    case 'obj':
      return 'obj';
    case 'stl':
      return 'stl';
    case 'ifc':
      return 'ifc';
    case 'dxf':
      return 'dxf';
    default:
      return null;
  }
}

export interface ImportOptions {
  /** Scale from the file's units to millimetres. */
  scaleToMm?: number;
  onProgress?: (message: string) => void;
}

export interface NativeImportResult {
  kind: 'native';
  model: ProjectModel;
  warnings: string[];
}

export interface GeometryImportResult {
  kind: 'geometry';
  report: ImportReport;
}

export type ImportOutcome = NativeImportResult | GeometryImportResult;

export async function importFile(file: File, options: ImportOptions = {}): Promise<ImportOutcome> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Imports are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB. "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
    );
  }

  const format = detectFormat(file.name);
  if (!format) {
    throw new Error(
      `"${file.name}" is not a format this build can import. Supported: native JSON, glTF, GLB, OBJ, STL, IFC and DXF.`,
    );
  }

  const scaleToMm = options.scaleToMm ?? (format === 'dxf' ? 1 : 1000);

  if (format === 'json') {
    options.onProgress?.('Reading project file');
    const { model, warnings } = deserializeProject(await file.text());
    return { kind: 'native', model, warnings };
  }

  if (format === 'gltf' || format === 'glb') {
    options.onProgress?.('Parsing glTF');
    return { kind: 'geometry', report: await importGltf(file, scaleToMm) };
  }

  options.onProgress?.(`Parsing ${format.toUpperCase()} in a background worker`);

  if (format === 'ifc') {
    const buffer = await file.arrayBuffer();
    return {
      kind: 'geometry',
      report: await callWorker({ kind: 'ifc', buffer, wasmPath: '/wasm/', scaleToMm }, [buffer]),
    };
  }
  if (format === 'dxf') {
    return {
      kind: 'geometry',
      report: await callWorker({ kind: 'dxf', text: await file.text(), scaleToMm }),
    };
  }
  if (format === 'obj') {
    return {
      kind: 'geometry',
      report: await callWorker({ kind: 'obj', text: await file.text(), scaleToMm }),
    };
  }

  const buffer = await file.arrayBuffer();
  return {
    kind: 'geometry',
    report: await callWorker({ kind: 'stl', buffer, scaleToMm }, [buffer]),
  };
}

/**
 * glTF import on the main thread.
 *
 * Meshes are flattened into world space and merged per material-ish group, and
 * brought in as reference geometry. A glTF carries no architectural semantics,
 * so no attempt is made to invent walls from it — that would be exactly the
 * kind of confident nonsense this product should not produce.
 */
async function importGltf(file: File, scaleToMm: number): Promise<ImportReport> {
  const startedAt = Date.now();
  const report = emptyReport(file.name.toLowerCase().endsWith('.glb') ? 'glb' : 'gltf', file.size);

  const [{ GLTFLoader }, THREE] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three'),
  ]);

  const loader = new GLTFLoader();
  const buffer = await file.arrayBuffer();

  const gltf = await new Promise<{ scene: import('three').Group }>((resolve, reject) => {
    loader.parse(buffer, '', resolve as never, (error) =>
      reject(new Error(error instanceof Error ? error.message : 'The glTF could not be parsed.')),
    );
  });

  const scale = scaleToMm / 1000;
  gltf.scene.updateMatrixWorld(true);

  let vertices = 0;
  let triangles = 0;

  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as import('three').BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position) return;

    const world = new Float32Array(position.count * 3);
    const vector = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      vector
        .fromBufferAttribute(position, i)
        .applyMatrix4(object.matrixWorld)
        .multiplyScalar(scale);
      world[i * 3] = vector.x;
      world[i * 3 + 1] = vector.y;
      world[i * 3 + 2] = vector.z;
    }

    const normalAttribute = geometry.getAttribute('normal');
    const indexAttribute = geometry.getIndex();
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    const colour =
      material && 'color' in material && material.color instanceof THREE.Color
        ? `#${material.color.getHexString()}`
        : '#9aa0a6';

    report.meshes.push({
      name: object.name || 'Imported mesh',
      positions: world,
      normals: normalAttribute
        ? new Float32Array(normalAttribute.array as ArrayLike<number>)
        : null,
      indices: indexAttribute ? new Uint32Array(Array.from(indexAttribute.array)) : null,
      color: colour,
      semanticTag: null,
    });

    vertices += position.count;
    triangles += (indexAttribute?.count ?? position.count) / 3;
  });

  if (report.meshes.length === 0) {
    report.errors.push('The glTF contained no meshes.');
  } else {
    report.converted.referenceMeshes = report.meshes.length;
    report.warnings.push(
      'glTF carries no architectural semantics, so this came in as reference geometry. Trace over it, or use it as context.',
    );
  }

  report.stats = { bytes: file.size, durationMs: Date.now() - startedAt, vertices, triangles };
  return report;
}

export function disposeImportWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}

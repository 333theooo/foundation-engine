/// <reference lib="webworker" />

import * as WebIFC from 'web-ifc';
import DxfParser from 'dxf-parser';
import { importIfc, type IfcApiLike } from '../ifc';
import { importDxf, type DxfParserLike } from '../dxf';
import { emptyReport, type ImportReport, type WorkerRequest, type WorkerResponse } from '../types';

/**
 * The parse worker.
 *
 * IFC and DXF parsing are the two genuinely expensive imports: a mid-size IFC
 * is tens of megabytes and takes seconds. Running them here keeps the viewport
 * at frame rate while a file loads, which is the difference between "the app
 * froze" and "the import is running".
 *
 * OBJ and STL are parsed here too — they are simple enough to implement
 * directly, which avoids pulling a DOM-dependent loader into a worker. glTF
 * stays on the main thread because `GLTFLoader` needs `createImageBitmap` and
 * the DOM for its texture path.
 *
 * Typed arrays are transferred rather than copied on the way back.
 */

declare const self: DedicatedWorkerGlobalScope;

let ifcApi: WebIFC.IfcAPI | null = null;

async function getIfcApi(wasmPath: string): Promise<IfcApiLike> {
  if (!ifcApi) {
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(wasmPath, true);
    await api.Init();
    ifcApi = api;
  }
  return ifcApi as unknown as IfcApiLike;
}

/** Parses a Wavefront OBJ into a single reference mesh. */
function parseObj(text: string, scaleToMm: number): ImportReport {
  const startedAt = Date.now();
  const report = emptyReport('obj', text.length);

  const rawVertices: number[] = [];
  const positions: number[] = [];
  const unsupported = new Map<string, number>();
  let currentName = 'Imported mesh';

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0];

    if (keyword === 'v') {
      rawVertices.push(
        Number(parts[1] ?? 0) * scaleToMm,
        Number(parts[2] ?? 0) * scaleToMm,
        Number(parts[3] ?? 0) * scaleToMm,
      );
    } else if (keyword === 'f') {
      // Triangulate the face fan; OBJ faces may be n-gons.
      const indices = parts.slice(1).map((token) => {
        const index = Number(token.split('/')[0]);
        return index < 0 ? rawVertices.length / 3 + index : index - 1;
      });
      for (let i = 1; i + 1 < indices.length; i += 1) {
        for (const index of [indices[0]!, indices[i]!, indices[i + 1]!]) {
          positions.push(
            (rawVertices[index * 3] ?? 0) / 1000,
            (rawVertices[index * 3 + 1] ?? 0) / 1000,
            (rawVertices[index * 3 + 2] ?? 0) / 1000,
          );
        }
      }
    } else if (keyword === 'o' || keyword === 'g') {
      currentName = parts.slice(1).join(' ') || currentName;
    } else if (keyword === 'usemtl' || keyword === 'mtllib') {
      unsupported.set('materials', (unsupported.get('materials') ?? 0) + 1);
    }
  }

  if (positions.length === 0) {
    report.errors.push('The OBJ contained no faces.');
    return report;
  }

  report.meshes.push({
    name: currentName,
    positions: new Float32Array(positions),
    normals: null,
    indices: null,
    color: '#9aa0a6',
    semanticTag: null,
  });
  if (unsupported.has('materials')) {
    report.unsupported.push({
      category: 'MTL materials',
      count: unsupported.get('materials') ?? 0,
      reason:
        'External material libraries are not imported; the mesh comes in with a neutral material.',
    });
  }
  report.converted.referenceMeshes = 1;
  report.stats.durationMs = Date.now() - startedAt;
  report.stats.vertices = positions.length / 3;
  report.stats.triangles = positions.length / 9;
  return report;
}

/** Parses binary or ASCII STL into a single reference mesh. */
function parseStl(buffer: ArrayBuffer, scaleToMm: number): ImportReport {
  const startedAt = Date.now();
  const report = emptyReport('stl', buffer.byteLength);
  const view = new DataView(buffer);

  // An ASCII STL starts with "solid" — but so do some binary files, so the
  // authoritative test is whether the binary triangle count matches the length.
  const isBinary = (() => {
    if (buffer.byteLength < 84) return false;
    const triangles = view.getUint32(80, true);
    return 84 + triangles * 50 === buffer.byteLength;
  })();

  const positions: number[] = [];
  const normals: number[] = [];

  if (isBinary) {
    const triangles = view.getUint32(80, true);
    let offset = 84;
    for (let i = 0; i < triangles; i += 1) {
      const nx = view.getFloat32(offset, true);
      const ny = view.getFloat32(offset + 4, true);
      const nz = view.getFloat32(offset + 8, true);
      offset += 12;
      for (let v = 0; v < 3; v += 1) {
        positions.push(
          (view.getFloat32(offset, true) * scaleToMm) / 1000,
          (view.getFloat32(offset + 4, true) * scaleToMm) / 1000,
          (view.getFloat32(offset + 8, true) * scaleToMm) / 1000,
        );
        normals.push(nx, ny, nz);
        offset += 12;
      }
      offset += 2; // attribute byte count
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const vertexPattern = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let match: RegExpExecArray | null;
    while ((match = vertexPattern.exec(text)) !== null) {
      positions.push(
        (Number(match[1]) * scaleToMm) / 1000,
        (Number(match[2]) * scaleToMm) / 1000,
        (Number(match[3]) * scaleToMm) / 1000,
      );
    }
  }

  if (positions.length === 0) {
    report.errors.push('The STL contained no triangles.');
    return report;
  }

  report.meshes.push({
    name: 'Imported STL',
    positions: new Float32Array(positions),
    normals: normals.length === positions.length ? new Float32Array(normals) : null,
    indices: null,
    color: '#9aa0a6',
    semanticTag: null,
  });
  report.converted.referenceMeshes = 1;
  report.stats.durationMs = Date.now() - startedAt;
  report.stats.vertices = positions.length / 3;
  report.stats.triangles = positions.length / 9;
  return report;
}

function transferablesOf(report: ImportReport): Transferable[] {
  const transfers: Transferable[] = [];
  for (const mesh of report.meshes) {
    transfers.push(mesh.positions.buffer);
    if (mesh.normals) transfers.push(mesh.normals.buffer);
    if (mesh.indices) transfers.push(mesh.indices.buffer);
  }
  return transfers;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const reply = (response: WorkerResponse, transfers: Transferable[] = []) => {
    self.postMessage(response, transfers);
  };

  try {
    let report: ImportReport;
    switch (request.kind) {
      case 'ifc': {
        const api = await getIfcApi(request.wasmPath);
        report = importIfc(api, new Uint8Array(request.buffer), { scaleToMm: request.scaleToMm });
        break;
      }
      case 'dxf': {
        const parser = new DxfParser() as unknown as DxfParserLike;
        report = importDxf(parser, request.text, { scaleToMm: request.scaleToMm });
        break;
      }
      case 'obj':
        report = parseObj(request.text, request.scaleToMm);
        break;
      case 'stl':
        report = parseStl(request.buffer, request.scaleToMm);
        break;
      default:
        reply({ id: (request as WorkerRequest).id, ok: false, error: 'Unsupported format.' });
        return;
    }
    reply({ id: request.id, ok: true, report }, transferablesOf(report));
  } catch (error) {
    reply({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'The file could not be parsed.',
    });
  }
};

export {};

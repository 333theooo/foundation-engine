'use client';

import { formatArea, formatLength } from '@/domain/units';
import { buildElementGeometry } from '@/domain/geometry';
import { serializeProject } from '@/domain/project/migrations';
import {
  countElementsByType,
  elementsOfType,
  grossFloorArea,
  listElements,
  modelBounds,
  polygonArea,
  wallLength,
  wallOrientation,
} from '@/domain/project/queries';
import { validateModel } from '@/domain/commands/validation';
import type { ProjectModel } from '@/domain/project/schema';
import type { ExportFormat, ExportResult } from './types';

/**
 * Export.
 *
 * Native JSON is the only lossless format: it round-trips the parametric model
 * exactly, and re-importing it gives back the same building with the same ids.
 * Everything else is a mesh export and loses the semantics — that is inherent
 * to the formats, and the UI says so at the point of export rather than leaving
 * the user to discover it.
 *
 * The three.js exporters are imported lazily. They are only needed when the
 * user actually exports, and keeping them out of the initial bundle is worth
 * more than the few hundred milliseconds of first-export latency.
 */

export async function exportProject(
  model: ProjectModel,
  format: ExportFormat,
  options: { elementIds?: string[]; canvas?: HTMLCanvasElement | null } = {},
): Promise<ExportResult> {
  const base = safeFilename(model.name);
  const ids = options.elementIds?.length ? options.elementIds : undefined;

  switch (format) {
    case 'json':
      return {
        filename: `${base}.atrium.json`,
        mimeType: 'application/json',
        blob: new Blob([serializeProject(model)], { type: 'application/json' }),
      };

    case 'summary':
      return {
        filename: `${base}-summary.md`,
        mimeType: 'text/markdown',
        blob: new Blob([buildProjectSummaryDocument(model)], { type: 'text/markdown' }),
      };

    case 'screenshot': {
      if (!options.canvas) throw new Error('The viewport is not ready for a screenshot yet.');
      const blob = await new Promise<Blob | null>((resolve) =>
        options.canvas!.toBlob((result) => resolve(result), 'image/png'),
      );
      if (!blob) throw new Error('The screenshot could not be captured.');
      return { filename: `${base}.png`, mimeType: 'image/png', blob };
    }

    case 'obj':
    case 'stl':
    case 'glb':
    case 'gltf':
      return exportMesh(model, format, base, ids);

    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

/** Builds a Three.js scene from the model, purely so an exporter can walk it. */
async function buildExportScene(model: ProjectModel, ids?: string[]) {
  const THREE = await import('three');
  const scene = new THREE.Scene();
  scene.name = model.name;

  const elementIds = ids ?? model.elementOrder;
  for (const elementId of elementIds) {
    const element = model.elements[elementId];
    if (!element || !element.visible) continue;

    const geometry = buildElementGeometry(model, element);
    for (const part of geometry.parts) {
      if (part.mesh.positions.length === 0) continue;
      const buffer = new THREE.BufferGeometry();
      buffer.setAttribute('position', new THREE.BufferAttribute(part.mesh.positions, 3));
      buffer.setAttribute('normal', new THREE.BufferAttribute(part.mesh.normals, 3));
      buffer.setAttribute('uv', new THREE.BufferAttribute(part.mesh.uvs, 2));
      buffer.setIndex(new THREE.BufferAttribute(part.mesh.indices, 1));

      const definition = part.materialId ? model.materials[part.materialId] : undefined;
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(part.colorOverride ?? definition?.color ?? '#b0b0b0'),
        roughness: definition?.roughness ?? 0.8,
        metalness: definition?.metalness ?? 0,
        transparent: (definition?.opacity ?? 1) < 1,
        opacity: definition?.opacity ?? 1,
        name: definition?.name ?? 'Material',
      });

      const mesh = new THREE.Mesh(buffer, material);
      // Names carry the semantics as far as the format allows: a downstream
      // tool at least sees "wall_ab12 · South wall · body".
      mesh.name = `${element.id}·${element.name}·${part.key}`;
      mesh.userData = { elementId: element.id, elementType: element.type };
      scene.add(mesh);
    }
  }
  return { scene, THREE };
}

async function exportMesh(
  model: ProjectModel,
  format: 'obj' | 'stl' | 'glb' | 'gltf',
  base: string,
  ids?: string[],
): Promise<ExportResult> {
  const { scene } = await buildExportScene(model, ids);
  if (scene.children.length === 0) {
    throw new Error('There is no visible geometry to export.');
  }

  if (format === 'obj') {
    const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
    const text = new OBJExporter().parse(scene);
    return {
      filename: `${base}.obj`,
      mimeType: 'model/obj',
      blob: new Blob([text], { type: 'model/obj' }),
    };
  }

  if (format === 'stl') {
    const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
    const result = new STLExporter().parse(scene, { binary: true });
    return {
      filename: `${base}.stl`,
      mimeType: 'model/stl',
      blob: new Blob([result as unknown as ArrayBuffer], { type: 'model/stl' }),
    };
  }

  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();
  const binary = format === 'glb';

  const result = await new Promise<ArrayBuffer | Record<string, unknown>>((resolve, reject) => {
    exporter.parse(
      scene,
      (output) => resolve(output as ArrayBuffer | Record<string, unknown>),
      (error) =>
        reject(new Error(error instanceof Error ? error.message : 'The glTF export failed.')),
      { binary, onlyVisible: true },
    );
  });

  return binary
    ? {
        filename: `${base}.glb`,
        mimeType: 'model/gltf-binary',
        blob: new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }),
      }
    : {
        filename: `${base}.gltf`,
        mimeType: 'model/gltf+json',
        blob: new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' }),
      };
}

/**
 * A structured Markdown summary of the project.
 *
 * Written for a design review: schedules of areas and openings, the
 * assumptions recorded in the model, and every outstanding review finding —
 * including the explicit statement that none of it is a compliance check.
 */
export function buildProjectSummaryDocument(model: ProjectModel): string {
  const units = model.units;
  const L = (mm: number) => formatLength(mm, units);
  const bounds = modelBounds(model);
  const counts = countElementsByType(model);
  const findings = validateModel(model);

  const lines: string[] = [
    `# ${model.name}`,
    '',
    model.description || '_No project description recorded._',
    '',
    `_Exported from Atrium Studio on ${new Date().toLocaleString()}. Concept and schematic design information only — not for construction, and not checked against any building standard._`,
    '',
    '## Overview',
    '',
    `| | |`,
    `| --- | --- |`,
    `| Display units | ${units} |`,
    `| Levels | ${model.levels.length} |`,
    `| Gross floor area | ${formatArea(grossFloorArea(model), units)} |`,
    `| Overall extent | ${bounds.isEmpty ? '—' : `${L(bounds.max.x - bounds.min.x)} × ${L(bounds.max.z - bounds.min.z)} × ${L(bounds.max.y - bounds.min.y)} high`} |`,
    `| Elements | ${
      Object.entries(counts)
        .map(([type, n]) => `${n} ${type}`)
        .join(', ') || 'none'
    } |`,
    `| Revision | ${model.revision} |`,
  ];

  if (model.site.locationLabel || model.site.standardsProfile) {
    lines.push('', '## Site and context', '');
    if (model.site.locationLabel) lines.push(`- Location: ${model.site.locationLabel}`);
    if (model.site.northAngleDeg)
      lines.push(`- Project north rotated ${model.site.northAngleDeg}° from +Y`);
    if (model.site.standardsProfile) {
      lines.push(
        `- Standards profile recorded by the user: **${model.site.standardsProfile}** (recorded only — the model has not been checked against it)`,
      );
    }
    if (model.site.climateNotes) lines.push(`- Climate notes: ${model.site.climateNotes}`);
  }

  lines.push('', '## Levels', '', '| Level | Elevation | Floor to floor |', '| --- | --- | --- |');
  for (const level of [...model.levels].sort((a, b) => a.index - b.index)) {
    lines.push(`| ${level.name} | ${L(level.elevation)} | ${L(level.height)} |`);
  }

  const rooms = elementsOfType(model, 'room');
  if (rooms.length > 0) {
    lines.push(
      '',
      '## Schedule of spaces',
      '',
      '| Room | Level | Programme | Area | Ceiling |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const room of rooms) {
      const level = model.levels.find((l) => l.id === room.levelId);
      lines.push(
        `| ${room.name} | ${level?.name ?? '—'} | ${room.programme} | ${formatArea(polygonArea(room.outline), units)} | ${room.ceilingHeight ? L(room.ceilingHeight) : L(level?.height ?? 0)} |`,
      );
    }
    lines.push(
      '',
      `**Total enclosed room area:** ${formatArea(
        rooms.reduce((sum, room) => sum + polygonArea(room.outline), 0),
        units,
      )}`,
    );
  }

  const openings = elementsOfType(model, 'opening');
  if (openings.length > 0) {
    lines.push(
      '',
      '## Schedule of openings',
      '',
      '| Reference | Type | Size | Sill | Wall | Faces |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const opening of openings) {
      const host = model.elements[opening.hostId];
      const facing =
        host && host.type === 'wall' ? wallOrientation(host, model.site.northAngleDeg) : '—';
      lines.push(
        `| ${opening.name} | ${opening.openingType} | ${L(opening.width)} × ${L(opening.height)} | ${L(opening.sillHeight)} | ${host?.name ?? '—'} | ${facing} |`,
      );
    }
  }

  const walls = elementsOfType(model, 'wall');
  if (walls.length > 0) {
    const external = walls.filter((wall) => wall.exterior);
    lines.push(
      '',
      '## Construction',
      '',
      `- ${walls.length} walls (${external.length} external), total run ${L(walls.reduce((sum, wall) => sum + wallLength(wall), 0))}`,
      `- Wall thicknesses in use: ${[...new Set(walls.map((wall) => L(wall.thickness)))].join(', ')}`,
      `- Openings per wall: ${walls.length > 0 ? (openings.length / walls.length).toFixed(1) : '0'} average`,
    );
    const materials = new Set(
      walls.map((wall) => model.materials[wall.materialId]?.name ?? wall.materialId),
    );
    lines.push(`- Wall materials: ${[...materials].join(', ')}`);
  }

  const stairs = elementsOfType(model, 'stair');
  if (stairs.length > 0) {
    lines.push(
      '',
      '## Stairs',
      '',
      '| Stair | Rise | Risers | Riser height | Going | 2R + G |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const stair of stairs) {
      const riser = stair.totalRise / stair.steps;
      lines.push(
        `| ${stair.name} | ${L(stair.totalRise)} | ${stair.steps} | ${L(riser)} | ${L(stair.treadDepth)} | ${Math.round(2 * riser + stair.treadDepth)} mm |`,
      );
    }
  }

  if (model.constraints.length > 0) {
    lines.push('', '## Recorded constraints', '');
    for (const constraint of model.constraints) {
      lines.push(
        `- **${constraint.kind}**${constraint.active ? '' : ' (inactive)'}: ${constraint.description}`,
      );
    }
  }

  lines.push('', '## Design review', '');
  if (findings.length === 0) {
    lines.push('No outstanding findings from the built-in geometric and proportional checks.');
  } else {
    for (const finding of findings) {
      const element = finding.elementId ? model.elements[finding.elementId] : undefined;
      lines.push(
        `- **${finding.severity.toUpperCase()}** — ${finding.title}${element ? ` (${element.name})` : ''}: ${finding.detail}${finding.suggestion ? ` _${finding.suggestion}_` : ''}${finding.conventionSource ? ` [${finding.conventionSource}]` : ''}`,
      );
    }
  }

  lines.push(
    '',
    '---',
    '',
    '**Scope of this document.** These are the results of geometric checks and widely-used proportioning conventions built into Atrium Studio. They are not a code check, an accessibility audit, a fire strategy or a structural assessment. Building regulations vary by jurisdiction and change over time; verifying this design against the standards that apply to it is work for a suitably qualified professional.',
  );

  return lines.join('\n');
}

function safeFilename(name: string): string {
  return (
    name
      .trim()
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .toLowerCase() || 'project'
  );
}

/** Triggers a browser download. */
export function downloadResult(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Element count and area, for the export dialog's "what you'll get" line. */
export function describeExportScope(model: ProjectModel, ids?: string[]): string {
  const elements = ids?.length
    ? ids.map((id) => model.elements[id]).filter(Boolean)
    : listElements(model);
  return `${elements.length} element${elements.length === 1 ? '' : 's'}`;
}

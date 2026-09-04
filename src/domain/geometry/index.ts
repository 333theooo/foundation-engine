import type { ArchElement, ProjectModel } from '@/domain/project/schema';
import { levelElevation, openingsForWall } from '@/domain/project/queries';
import { EMPTY_MESH, type MeshData } from './mesh';
import { buildOpeningMesh, buildWallMesh } from './wall';
import {
  buildBeamMesh,
  buildColumnMesh,
  buildFurnitureMesh,
  buildPrism,
  buildRailingMesh,
  buildRoofMesh,
  buildSlabMesh,
  buildStairMesh,
} from './solids';

export * from './mesh';
export * from './polygon';
export * from './wall';
export * from './solids';

/**
 * One element's renderable output.
 *
 * An element can produce several meshes with different materials (a window is a
 * frame plus glazing; a sofa is a body plus cushions), so the adapter consumes a
 * list of parts rather than a single mesh.
 */
export interface GeometryPart {
  key: string;
  mesh: MeshData;
  /** Material id from the project library, or null to use `colorOverride`. */
  materialId: string | null;
  colorOverride?: string;
  /** Rendering hint: glazing is transparent and should not cast hard shadows. */
  transparent?: boolean;
}

export interface ElementGeometry {
  elementId: string;
  parts: GeometryPart[];
}

/**
 * Builds every mesh for one element.
 *
 * This is the single dispatch point between the semantic model and geometry.
 * Adding an element type means adding a case here and a generator — the scene
 * adapter, the exporters and the workers all inherit it for free.
 */
export function buildElementGeometry(model: ProjectModel, element: ArchElement): ElementGeometry {
  const parts: GeometryPart[] = [];
  const materialScale = (id: string | null | undefined): number =>
    (id && model.materials[id]?.textureScaleMm) || 1000;

  switch (element.type) {
    case 'wall': {
      const base = levelElevation(model, element.levelId);
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildWallMesh(element, openingsForWall(model, element.id), {
          levelElevation: base,
          textureScaleMm: materialScale(element.materialId),
        }),
      });
      break;
    }

    case 'opening': {
      const host = model.elements[element.hostId];
      if (!host || host.type !== 'wall') break;
      const base = levelElevation(model, host.levelId);
      const { frame, panel } = buildOpeningMesh(host, element, { levelElevation: base });
      parts.push({
        key: 'frame',
        materialId: element.frameMaterialId ?? 'mat_metal_dark',
        mesh: frame,
      });
      if (panel.positions.length > 0) {
        const glazed = element.kind === 'window' || element.openingType === 'sliding-door';
        parts.push({
          key: 'panel',
          materialId: element.glazingMaterialId ?? (glazed ? 'mat_glass_clear' : 'mat_timber_oak'),
          mesh: panel,
          transparent: glazed,
        });
      }
      break;
    }

    case 'slab': {
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildSlabMesh(
          element,
          levelElevation(model, element.levelId),
          materialScale(element.materialId),
        ),
      });
      break;
    }

    case 'room': {
      // Rooms are spatial, not solid: they render as a thin translucent floor
      // plate so the user can see and select the space without it reading as
      // built fabric.
      const base = levelElevation(model, element.levelId);
      parts.push({
        key: 'floor',
        materialId: element.floorMaterialId,
        colorOverride: element.floorMaterialId ? undefined : '#5b8dd9',
        transparent: !element.floorMaterialId,
        mesh: buildPrism(element.outline, base + 2, base + 12, 1000),
      });
      break;
    }

    case 'roof': {
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildRoofMesh(element, materialScale(element.materialId)),
      });
      break;
    }

    case 'stair': {
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildStairMesh(element, levelElevation(model, element.levelId)),
      });
      break;
    }

    case 'column': {
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildColumnMesh(element, levelElevation(model, element.levelId)),
      });
      break;
    }

    case 'beam': {
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildBeamMesh(element, levelElevation(model, element.levelId)),
      });
      break;
    }

    case 'railing': {
      parts.push({
        key: 'body',
        materialId: element.materialId,
        mesh: buildRailingMesh(element, levelElevation(model, element.levelId)),
        transparent: element.infill === 'glass',
      });
      break;
    }

    case 'furniture': {
      const { mesh, accents } = buildFurnitureMesh(
        element.catalogId,
        element.position,
        element.rotationDeg,
        element.scale,
        levelElevation(model, element.levelId),
      );
      parts.push({ key: 'body', materialId: element.materialId, mesh });
      accents.forEach((accent, index) => {
        parts.push({
          key: `accent-${index}`,
          materialId: null,
          colorOverride: accent.color,
          mesh: accent.mesh,
        });
      });
      break;
    }

    case 'group':
    case 'imported':
      // Groups are organisational only. Imported meshes are streamed by the
      // loader in `src/three/ImportedModel.tsx`, not generated here.
      break;

    default:
      break;
  }

  return {
    elementId: element.id,
    parts: parts.filter((part) => part.mesh.positions.length > 0),
  };
}

export function emptyGeometry(elementId: string): ElementGeometry {
  return { elementId, parts: [{ key: 'body', materialId: null, mesh: EMPTY_MESH }] };
}

/**
 * Cheap structural fingerprint of an element.
 *
 * The scene adapter memoises geometry on this key: two elements with the same
 * key produce identical meshes, so moving the camera, renaming an element or
 * selecting it never triggers a rebuild. Walls include their openings' geometry
 * because a hosted opening changes the wall solid.
 */
export function geometryKey(model: ProjectModel, element: ArchElement): string {
  const level = 'levelId' in element ? levelElevation(model, element.levelId) : 0;
  const material =
    'materialId' in element && typeof element.materialId === 'string'
      ? (model.materials[element.materialId]?.textureScaleMm ?? 0)
      : 0;

  if (element.type === 'wall') {
    const openings = openingsForWall(model, element.id)
      .map(
        (o) => `${o.id}:${o.distanceAlongWall}:${o.width}:${o.height}:${o.sillHeight}:${o.visible}`,
      )
      .join('|');
    return [
      element.id,
      level,
      material,
      element.start.x,
      element.start.y,
      element.end.x,
      element.end.y,
      element.height,
      element.thickness,
      element.alignment,
      element.baseOffset,
      openings,
    ].join(',');
  }

  if (element.type === 'opening') {
    const host = model.elements[element.hostId];
    const hostKey =
      host && host.type === 'wall'
        ? `${host.start.x},${host.start.y},${host.end.x},${host.end.y},${host.thickness},${host.height},${host.alignment},${host.baseOffset}`
        : 'none';
    return [
      element.id,
      level,
      hostKey,
      element.distanceAlongWall,
      element.width,
      element.height,
      element.sillHeight,
      element.kind,
      element.openingType,
      element.frameDepth,
    ].join(',');
  }

  // Everything else: hash the element's own geometric fields.
  const geometric = JSON.stringify(element, (key, value) =>
    key === 'name' || key === 'notes' || key === 'tags' || key === 'locked' ? undefined : value,
  );
  return `${element.id},${level},${material},${geometric}`;
}

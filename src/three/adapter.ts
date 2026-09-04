import * as THREE from 'three';
import { MM_TO_SCENE } from '@/domain/units';
import {
  buildElementGeometry,
  geometryKey,
  type ElementGeometry,
  type MeshData,
} from '@/domain/geometry';
import type { MaterialDefinition, ProjectModel } from '@/domain/project/schema';
import { getProceduralTexture } from './textures';

/**
 * The scene adapter.
 *
 * This is the one place that turns the project model into Three.js objects. It
 * is a cache, not a scene graph: React owns the graph, this owns the expensive
 * resources (BufferGeometry, Material, Texture) and their lifetimes.
 *
 * The caching contract is what keeps the viewport smooth:
 *
 *   * Geometry is keyed by `geometryKey(model, element)` — a fingerprint of
 *     exactly the fields that affect vertices. Renaming an element, selecting
 *     it, or orbiting the camera therefore rebuilds nothing.
 *   * Materials are keyed by their definition plus the flags that change the
 *     Three material (transparency, wireframe, colour override).
 *   * `collectGarbage` disposes anything that survived a frame without being
 *     touched. Three.js does not reference-count GPU resources, so without this
 *     an hour of editing leaks every intermediate wall.
 */

export interface SceneMeshPart {
  key: string;
  geometry: THREE.BufferGeometry;
  materialId: string | null;
  colorOverride?: string | undefined;
  transparent: boolean;
  triangles: number;
}

export interface SceneElement {
  elementId: string;
  elementType: string;
  name: string;
  locked: boolean;
  parts: SceneMeshPart[];
}

function toBufferGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

interface GeometryCacheEntry {
  key: string;
  element: SceneElement;
  lastTouched: number;
}

export class SceneAdapter {
  private geometryCache = new Map<string, GeometryCacheEntry>();
  private materialCache = new Map<string, THREE.Material>();
  private generation = 0;

  /** Builds (or reuses) the renderable parts for one element. */
  element(model: ProjectModel, elementId: string): SceneElement | null {
    const element = model.elements[elementId];
    if (!element) return null;

    const key = geometryKey(model, element);
    const cached = this.geometryCache.get(elementId);

    if (cached && cached.key === key) {
      cached.lastTouched = this.generation;
      // Cheap fields that do not affect geometry are refreshed in place.
      cached.element.name = element.name;
      cached.element.locked = element.locked;
      return cached.element;
    }

    if (cached) disposeSceneElement(cached.element);

    const built: ElementGeometry = buildElementGeometry(model, element);
    const scene: SceneElement = {
      elementId,
      elementType: element.type,
      name: element.name,
      locked: element.locked,
      parts: built.parts.map((part) => ({
        key: part.key,
        geometry: toBufferGeometry(part.mesh),
        materialId: part.materialId,
        colorOverride: part.colorOverride,
        transparent: part.transparent ?? false,
        triangles: part.mesh.indices.length / 3,
      })),
    };

    this.geometryCache.set(elementId, { key, element: scene, lastTouched: this.generation });
    return scene;
  }

  /**
   * Resolves a material definition to a Three material.
   * Materials are shared across every element that uses them, which is what
   * keeps draw calls low on a building with two hundred walls.
   */
  material(
    definition: MaterialDefinition | null,
    options: {
      colorOverride?: string | undefined;
      transparent?: boolean;
      wireframe?: boolean;
    } = {},
  ): THREE.Material {
    const color = options.colorOverride ?? definition?.color ?? '#b0b0b0';
    const transparent = options.transparent || (definition ? definition.opacity < 1 : false);
    const key = [
      definition?.id ?? 'none',
      color,
      transparent ? 't' : 'o',
      options.wireframe ? 'w' : 's',
      definition?.textureRef ?? '',
      definition?.textureScaleMm ?? 0,
      definition?.roughness ?? 0,
      definition?.metalness ?? 0,
      definition?.opacity ?? 1,
    ].join('|');

    const cached = this.materialCache.get(key);
    if (cached) return cached;

    const texture = definition?.textureRef ? getProceduralTexture(definition.textureRef) : null;
    if (texture) {
      // UVs are already in scene metres, so repeat is 1 per tile.
      texture.repeat.set(1, 1);
    }

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: definition?.roughness ?? 0.8,
      metalness: definition?.metalness ?? 0,
      transparent,
      opacity: options.colorOverride && options.transparent ? 0.35 : (definition?.opacity ?? 1),
      side: THREE.DoubleSide,
      wireframe: options.wireframe ?? false,
      ...(texture ? { map: texture } : {}),
      ...(definition?.emissiveIntensity
        ? { emissive: new THREE.Color(color), emissiveIntensity: definition.emissiveIntensity }
        : {}),
    });
    material.name = definition?.id ?? 'override';

    this.materialCache.set(key, material);
    return material;
  }

  /** Marks the start of a render pass. Call once per model version. */
  beginPass(): void {
    this.generation += 1;
  }

  /** Disposes geometry for elements that were not touched in the last pass. */
  collectGarbage(liveIds: ReadonlySet<string>): number {
    let disposed = 0;
    for (const [elementId, entry] of this.geometryCache) {
      if (!liveIds.has(elementId)) {
        disposeSceneElement(entry.element);
        this.geometryCache.delete(elementId);
        disposed += 1;
      }
    }
    return disposed;
  }

  stats(): { geometries: number; materials: number; triangles: number } {
    let triangles = 0;
    for (const entry of this.geometryCache.values()) {
      for (const part of entry.element.parts) triangles += part.triangles;
    }
    return {
      geometries: this.geometryCache.size,
      materials: this.materialCache.size,
      triangles,
    };
  }

  dispose(): void {
    for (const entry of this.geometryCache.values()) disposeSceneElement(entry.element);
    this.geometryCache.clear();
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
  }
}

function disposeSceneElement(element: SceneElement): void {
  for (const part of element.parts) part.geometry.dispose();
}

/** Scene-space position for a plan point at a given elevation, all in mm. */
export function scenePosition(xMm: number, elevationMm: number, yMm: number): THREE.Vector3 {
  return new THREE.Vector3(xMm * MM_TO_SCENE, elevationMm * MM_TO_SCENE, -yMm * MM_TO_SCENE);
}

/** Converts a scene-space point back into project millimetres. */
export function toProjectPoint(vector: THREE.Vector3): { x: number; y: number; z: number } {
  return {
    x: vector.x / MM_TO_SCENE,
    y: -vector.z / MM_TO_SCENE,
    z: vector.y / MM_TO_SCENE,
  };
}

/**
 * Sun direction from azimuth (degrees clockwise from north) and altitude.
 * Returned in scene space at the given distance, ready for a directional light.
 */
export function sunPosition(azimuthDeg: number, altitudeDeg: number, distance = 60): THREE.Vector3 {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const altitude = (Math.max(altitudeDeg, -5) * Math.PI) / 180;
  // North is -Z; azimuth increases clockwise, so east (+X) is 90 degrees.
  const horizontal = Math.cos(altitude) * distance;
  return new THREE.Vector3(
    Math.sin(azimuth) * horizontal,
    Math.sin(altitude) * distance,
    -Math.cos(azimuth) * horizontal,
  );
}

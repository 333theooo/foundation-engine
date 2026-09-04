'use client';

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Outlines } from '@react-three/drei';
import { MM_TO_SCENE, degToRad } from '@/domain/units';
import type { ImportedElement, ProjectModel } from '@/domain/project/schema';
import type { ImportedMeshPayload } from '@/io/types';
import { useEditorStore } from '@/editor/store';
import { SELECTION_COLOUR } from './ElementNodes';

/**
 * Reference geometry from imported files.
 *
 * Imported meshes are not stored in the project model — they can be tens of
 * megabytes, and the model is a JSON document that has to load quickly and diff
 * cleanly. Instead the model stores an `assetRef`, and this component fetches
 * and re-parses the original when the project is opened.
 *
 * That is a real trade-off, stated plainly: a project with a large IFC import
 * takes a few seconds longer to become complete on reload, and the import is
 * re-parsed rather than cached as geometry. In exchange the project document
 * stays small, the source of truth stays authoritative, and a user can always
 * see exactly which file their reference geometry came from.
 *
 * The parsed result is cached per session, so switching levels or undoing does
 * not re-parse anything.
 */

interface CacheEntry {
  status: 'loading' | 'ready' | 'error';
  meshes: ImportedMeshPayload[];
  error?: string;
  promise?: Promise<void>;
}

const cache = new Map<string, CacheEntry>();

/** Clears the session cache. Used when a project is closed. */
export function clearImportedGeometryCache(): void {
  cache.clear();
}

async function loadAsset(
  projectId: string,
  element: ImportedElement,
  onChange: () => void,
): Promise<void> {
  const key = `${projectId}:${element.assetRef}`;
  const existing = cache.get(key);
  if (existing) return existing.promise ?? Promise.resolve();

  const entry: CacheEntry = { status: 'loading', meshes: [] };
  const promise = (async () => {
    try {
      // The asset endpoint is scoped to the owner, so a stale or foreign ref
      // simply 404s rather than leaking anything.
      const response = await fetch(
        `/api/projects/${projectId}/assets/by-key?key=${encodeURIComponent(element.assetRef)}`,
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'The source file for this import is no longer available.'
            : `The source file could not be loaded (${response.status}).`,
        );
      }
      const blob = await response.blob();
      const file = new File([blob], `${element.name}.${element.sourceFormat}`, { type: blob.type });

      const { importFile } = await import('@/io/importer');
      const outcome = await importFile(file, { scaleToMm: element.scale * 1000 });
      if (outcome.kind !== 'geometry') {
        throw new Error('That asset is a native project file, not reference geometry.');
      }
      entry.meshes = outcome.report.meshes;
      entry.status = 'ready';
    } catch (error) {
      entry.status = 'error';
      entry.error = error instanceof Error ? error.message : 'The import could not be reloaded.';
    } finally {
      onChange();
    }
  })();

  entry.promise = promise;
  cache.set(key, entry);
  return promise;
}

export function ImportedModels({
  model,
  projectId,
  elementIds,
}: {
  model: ProjectModel;
  projectId: string;
  elementIds: string[];
}) {
  const [, forceRender] = useState(0);
  const { invalidate } = useThree();
  const selection = useEditorStore((state) => state.selection);
  const toggleSelection = useEditorStore((state) => state.toggleSelection);
  const setHovered = useEditorStore((state) => state.setHovered);

  const imported = useMemo(
    () =>
      elementIds
        .map((id) => model.elements[id])
        .filter((element): element is ImportedElement => element?.type === 'imported'),
    [elementIds, model],
  );

  useEffect(() => {
    for (const element of imported) {
      void loadAsset(projectId, element, () => {
        forceRender((value) => value + 1);
        invalidate();
      });
    }
  }, [imported, projectId, invalidate]);

  return (
    <group name="imported-models">
      {imported.map((element) => {
        const entry = cache.get(`${projectId}:${element.assetRef}`);
        if (!entry || entry.status !== 'ready') return null;
        const selected = selection.includes(element.id);

        return (
          <group
            key={element.id}
            position={[
              element.position.x * MM_TO_SCENE,
              element.position.z * MM_TO_SCENE,
              -element.position.y * MM_TO_SCENE,
            ]}
            rotation={[0, degToRad(element.rotationDeg), 0]}
            userData={{ elementId: element.id }}
          >
            {entry.meshes.map((mesh, index) => (
              <ImportedMesh
                key={index}
                payload={mesh}
                selected={selected}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  toggleSelection(element.id, event.shiftKey || event.metaKey || event.ctrlKey);
                }}
                onPointerOver={() => setHovered(element.id)}
                onPointerOut={() => setHovered(null)}
              />
            ))}
          </group>
        );
      })}
    </group>
  );
}

function ImportedMesh({
  payload,
  selected,
  onPointerDown,
  onPointerOver,
  onPointerOut,
}: {
  payload: ImportedMeshPayload;
  selected: boolean;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOver: () => void;
  onPointerOut: () => void;
}) {
  const geometry = useMemo(() => {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3));
    if (payload.normals && payload.normals.length === payload.positions.length) {
      buffer.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3));
    }
    if (payload.indices) buffer.setIndex(new THREE.BufferAttribute(payload.indices, 1));
    if (!buffer.getAttribute('normal')) buffer.computeVertexNormals();
    buffer.computeBoundingSphere();
    return buffer;
  }, [payload]);

  // Three.js does not reference-count GPU buffers, so the geometry has to be
  // released explicitly when this mesh unmounts.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // DXF layers arrive as line segments rather than triangles.
  const isLines = payload.indices === null && payload.semanticTag?.startsWith('DXF:');

  if (isLines) {
    return (
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={selected ? SELECTION_COLOUR : payload.color} />
      </lineSegments>
    );
  }

  return (
    <mesh
      geometry={geometry}
      castShadow
      receiveShadow
      onPointerDown={onPointerDown}
      onPointerOver={(event) => {
        event.stopPropagation();
        onPointerOver();
      }}
      onPointerOut={onPointerOut}
    >
      <meshStandardMaterial
        color={payload.color}
        roughness={0.85}
        metalness={0}
        side={THREE.DoubleSide}
        // Reference geometry reads as reference: slightly translucent, so it is
        // never mistaken for modelled fabric.
        transparent
        opacity={0.85}
      />
      {selected ? <Outlines thickness={2} color={SELECTION_COLOUR} /> : null}
    </mesh>
  );
}

/** Load status for the status bar and the inspector. */
export function importedGeometryStatus(
  projectId: string,
  assetRef: string,
): 'loading' | 'ready' | 'error' | 'unknown' {
  return cache.get(`${projectId}:${assetRef}`)?.status ?? 'unknown';
}

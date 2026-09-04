'use client';

import { memo, useMemo } from 'react';
import * as THREE from 'three';
import { Outlines } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { MM_TO_SCENE, degToRad } from '@/domain/units';
import { buildCatalogItemMesh } from '@/domain/geometry/solids';
import { levelElevation } from '@/domain/project/queries';
import type { Furniture, ProjectModel } from '@/domain/project/schema';
import type { SceneAdapter } from './adapter';

/**
 * Element rendering.
 *
 * Two paths, for a reason:
 *
 *   * **Generated elements** (walls, slabs, roofs, stairs …) each get their own
 *     mesh, because each has unique geometry. The adapter's cache means the
 *     BufferGeometry is only rebuilt when the element's dimensions change.
 *   * **Furniture** is drawn with `InstancedMesh`, grouped by catalogue item and
 *     scale. Twenty identical dining chairs are one draw call. A selected or
 *     hovered piece is drawn individually so it can carry an outline, which is
 *     the only case where the instanced path is not used.
 */

export const SELECTION_COLOUR = '#5aa9ff';
export const HOVER_COLOUR = '#9fb0c4';

export interface ElementNodesProps {
  adapter: SceneAdapter;
  model: ProjectModel;
  elementIds: string[];
  selection: string[];
  hovered: string | null;
  wireframe: boolean;
  onPointerDown: (elementId: string, event: ThreeEvent<PointerEvent>) => void;
  onPointerOver: (elementId: string) => void;
  onPointerOut: (elementId: string) => void;
}

function ElementNodeImpl({
  adapter,
  model,
  elementId,
  selected,
  hovered,
  wireframe,
  onPointerDown,
  onPointerOver,
  onPointerOut,
}: {
  adapter: SceneAdapter;
  model: ProjectModel;
  elementId: string;
  selected: boolean;
  hovered: boolean;
  wireframe: boolean;
  onPointerDown: ElementNodesProps['onPointerDown'];
  onPointerOver: ElementNodesProps['onPointerOver'];
  onPointerOut: ElementNodesProps['onPointerOut'];
}) {
  const scene = adapter.element(model, elementId);
  if (!scene) return null;

  return (
    <group name={elementId} userData={{ elementId }}>
      {scene.parts.map((part) => {
        const definition = part.materialId ? (model.materials[part.materialId] ?? null) : null;
        const material = adapter.material(definition, {
          colorOverride: part.colorOverride,
          transparent: part.transparent,
          wireframe,
        });
        return (
          <mesh
            key={part.key}
            geometry={part.geometry}
            material={material}
            castShadow={!part.transparent}
            receiveShadow
            userData={{ elementId }}
            onPointerDown={(event) => onPointerDown(elementId, event)}
            onPointerOver={(event) => {
              event.stopPropagation();
              onPointerOver(elementId);
            }}
            onPointerOut={() => onPointerOut(elementId)}
          >
            {selected ? (
              <Outlines thickness={2.5} color={SELECTION_COLOUR} transparent opacity={0.95} />
            ) : hovered ? (
              <Outlines thickness={1.5} color={HOVER_COLOUR} transparent opacity={0.7} />
            ) : null}
          </mesh>
        );
      })}
    </group>
  );
}

const ElementNode = memo(ElementNodeImpl);

interface FurnitureGroup {
  key: string;
  catalogId: string;
  scale: number;
  items: Furniture[];
}

function InstancedFurniture({
  group,
  model,
  adapter,
  onPointerDown,
  onPointerOver,
  onPointerOut,
}: {
  group: FurnitureGroup;
  model: ProjectModel;
  adapter: SceneAdapter;
  onPointerDown: ElementNodesProps['onPointerDown'];
  onPointerOver: ElementNodesProps['onPointerOver'];
  onPointerOut: ElementNodesProps['onPointerOut'];
}) {
  const geometry = useMemo(() => {
    const mesh = buildCatalogItemMesh(group.catalogId, group.scale);
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    buffer.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    buffer.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    buffer.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    buffer.computeBoundingSphere();
    return buffer;
  }, [group.catalogId, group.scale]);

  const matrices = useMemo(() => {
    const dummy = new THREE.Object3D();
    return group.items.map((item) => {
      const base = levelElevation(model, item.levelId);
      dummy.position.set(
        item.position.x * MM_TO_SCENE,
        base * MM_TO_SCENE,
        -item.position.y * MM_TO_SCENE,
      );
      dummy.rotation.set(0, degToRad(item.rotationDeg), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      return dummy.matrix.clone();
    });
    // Recomputed whenever any member moves; `items` is rebuilt on model change.
  }, [group.items, model]);

  const material = adapter.material(model.materials.mat_generic ?? null, {});

  return (
    <instancedMesh
      key={group.key}
      args={[geometry, material, group.items.length]}
      castShadow
      receiveShadow
      count={group.items.length}
      onUpdate={(mesh: THREE.InstancedMesh) => {
        matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }}
      onPointerDown={(event) => {
        const index = event.instanceId ?? 0;
        const item = group.items[index];
        if (item) onPointerDown(item.id, event);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        const item = group.items[event.instanceId ?? 0];
        if (item) onPointerOver(item.id);
      }}
      onPointerOut={(event) => {
        const item = group.items[event.instanceId ?? 0];
        if (item) onPointerOut(item.id);
      }}
    />
  );
}

export function ElementNodes({
  adapter,
  model,
  elementIds,
  selection,
  hovered,
  wireframe,
  onPointerDown,
  onPointerOver,
  onPointerOut,
}: ElementNodesProps) {
  const selectedSet = useMemo(() => new Set(selection), [selection]);

  // Split furniture out for instancing, but keep anything highlighted on the
  // individual path so it can carry a selection outline.
  const { instancedGroups, individualIds } = useMemo(() => {
    const groups = new Map<string, FurnitureGroup>();
    const individual: string[] = [];

    for (const id of elementIds) {
      const element = model.elements[id];
      if (!element) continue;
      if (element.type === 'furniture' && !selectedSet.has(id) && hovered !== id) {
        const key = `${element.catalogId}@${element.scale}`;
        const group = groups.get(key) ?? {
          key,
          catalogId: element.catalogId,
          scale: element.scale,
          items: [],
        };
        group.items.push(element);
        groups.set(key, group);
      } else {
        individual.push(id);
      }
    }
    return { instancedGroups: [...groups.values()], individualIds: individual };
  }, [elementIds, model, selectedSet, hovered]);

  return (
    <group name="model-root">
      {individualIds.map((id) => (
        <ElementNode
          key={id}
          adapter={adapter}
          model={model}
          elementId={id}
          selected={selectedSet.has(id)}
          hovered={hovered === id}
          wireframe={wireframe}
          onPointerDown={onPointerDown}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        />
      ))}
      {instancedGroups.map((group) => (
        <InstancedFurniture
          key={group.key}
          group={group}
          model={model}
          adapter={adapter}
          onPointerDown={onPointerDown}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        />
      ))}
    </group>
  );
}

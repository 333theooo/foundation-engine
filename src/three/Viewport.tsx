'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  GizmoHelper,
  GizmoViewport,
  Grid,
  Line,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
  Sky,
  TransformControls,
} from '@react-three/drei';
import { MM_TO_SCENE, degToRad, formatArea, formatLength, radToDeg } from '@/domain/units';
import { modelBounds } from '@/domain/project/queries';
import type { ProjectModel } from '@/domain/project/schema';
import { useEditorStore, visibleElementIds, type CameraPreset } from '@/editor/store';
import { SceneAdapter, sunPosition, toProjectPoint } from './adapter';
import { ElementNodes } from './ElementNodes';
import { ImportedModels } from './ImportedModels';

/**
 * The 3D viewport.
 *
 * Performance rules this file follows, because they are what keep the thing
 * usable rather than merely correct:
 *
 *   * **No React state updates per frame.** The FPS counter samples at 2 Hz and
 *     writes to the store then; everything else is driven by refs.
 *   * **Geometry is cached by fingerprint** in `SceneAdapter`, so orbiting,
 *     selecting or renaming rebuilds nothing.
 *   * **Unused GPU resources are disposed** after every model change. Three.js
 *     will not do it for you.
 *   * **The transform gizmo previews on the GPU**, moving a wrapper group, and
 *     only dispatches a command on release. Dragging a wall therefore does not
 *     run the command engine sixty times a second.
 */

const UP = new THREE.Vector3(0, 1, 0);

export interface ViewportProps {
  className?: string;
}

export function Viewport({ className }: ViewportProps) {
  const orthographic = useEditorStore((state) => state.orthographic);
  const showShadows = useEditorStore((state) => state.showShadows);

  return (
    <div className={className} data-testid="viewport">
      <Canvas
        shadows={showShadows}
        dpr={[1, 2]}
        gl={{
          antialias: true,
          localClippingEnabled: true,
          preserveDrawingBuffer: true, // required for screenshot export
          powerPreference: 'high-performance',
        }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
        }}
        frameloop="demand"
      >
        <Suspense fallback={null}>
          <SceneContents orthographic={orthographic} />
        </Suspense>
      </Canvas>
    </div>
  );
}

function SceneContents({ orthographic }: { orthographic: boolean }) {
  const model = useEditorStore((state) => state.model);
  const projectId = useEditorStore((state) => state.projectId) ?? '';
  const modelVersion = useEditorStore((state) => state.modelVersion);
  const selection = useEditorStore((state) => state.selection);
  const hovered = useEditorStore((state) => state.hovered);
  const wireframe = useEditorStore((state) => state.wireframe);
  const showGrid = useEditorStore((state) => state.showGrid);
  const showShadows = useEditorStore((state) => state.showShadows);
  const activeLevelId = useEditorStore((state) => state.activeLevelId);
  const isolatedIds = useEditorStore((state) => state.isolatedIds);
  const showRooms = useEditorStore((state) => state.showRooms);
  const showFurniture = useEditorStore((state) => state.showFurniture);
  const gizmoMode = useEditorStore((state) => state.gizmoMode);
  const measurement = useEditorStore((state) => state.measurement);
  const sectionElevation = useEditorStore((state) => state.sectionElevation);

  const toggleSelection = useEditorStore((state) => state.toggleSelection);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const setHovered = useEditorStore((state) => state.setHovered);
  const addMeasurementPoint = useEditorStore((state) => state.addMeasurementPoint);

  const adapter = useMemo(() => new SceneAdapter(), []);
  const invalidate = useThree((state) => state.invalidate);

  const elementIds = useMemo(
    () => visibleElementIds({ model, activeLevelId, isolatedIds, showRooms, showFurniture }),
    [model, activeLevelId, isolatedIds, showRooms, showFurniture],
  );

  // Rebuild pass: touch everything visible, then dispose whatever went away.
  useEffect(() => {
    adapter.beginPass();
    for (const id of elementIds) adapter.element(model, id);
    adapter.collectGarbage(new Set(elementIds));
    invalidate();
  }, [adapter, elementIds, model, modelVersion, invalidate]);

  useEffect(() => () => adapter.dispose(), [adapter]);

  // Any state that changes what is drawn must ask for a frame, because the
  // renderer runs on demand rather than continuously.
  useEffect(() => {
    invalidate();
  }, [
    invalidate,
    selection,
    hovered,
    wireframe,
    showGrid,
    showShadows,
    sectionElevation,
    gizmoMode,
    orthographic,
    measurement,
  ]);

  const handlePointerDown = useCallback(
    (elementId: string, event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      if (measurement.active) {
        if (event.point) addMeasurementPoint(toProjectPoint(event.point));
        return;
      }
      toggleSelection(elementId, event.shiftKey || event.metaKey || event.ctrlKey);
    },
    [measurement.active, addMeasurementPoint, toggleSelection],
  );

  const handleMissed = useCallback(() => {
    if (!measurement.active) clearSelection();
  }, [measurement.active, clearSelection]);

  return (
    <>
      <CameraRig orthographic={orthographic} model={model} />
      <Lighting model={model} shadows={showShadows} />
      <SectionPlane elevationMm={sectionElevation} />

      {showGrid ? (
        <Grid
          args={[200, 200]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="#2a2f36"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#3a424c"
          fadeDistance={140}
          fadeStrength={1.4}
          followCamera={false}
          infiniteGrid
          position={[0, -0.002, 0]}
        />
      ) : null}

      <group onPointerMissed={handleMissed}>
        <ElementNodes
          adapter={adapter}
          model={model}
          elementIds={elementIds}
          selection={selection}
          hovered={hovered}
          wireframe={wireframe}
          onPointerDown={handlePointerDown}
          onPointerOver={setHovered}
          onPointerOut={() => setHovered(null)}
        />
      </group>

      <ImportedModels model={model} projectId={projectId} elementIds={elementIds} />
      <MeasurementLayer model={model} />
      <SelectionGizmo model={model} />

      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport axisColors={['#d97757', '#7cc47f', '#5aa9ff']} labelColor="#e6e8ea" />
      </GizmoHelper>

      <PerformanceProbe adapter={adapter} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

function presetDirection(preset: CameraPreset): THREE.Vector3 {
  switch (preset) {
    case 'top':
      return new THREE.Vector3(0, 1, 0.0001);
    case 'front':
      return new THREE.Vector3(0, 0.05, 1);
    case 'back':
      return new THREE.Vector3(0, 0.05, -1);
    case 'left':
      return new THREE.Vector3(-1, 0.05, 0);
    case 'right':
      return new THREE.Vector3(1, 0.05, 0);
    default:
      return new THREE.Vector3(1, 0.75, 1);
  }
}

function CameraRig({ orthographic, model }: { orthographic: boolean; model: ProjectModel }) {
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls> | null>(null);
  const cameraRequest = useEditorStore((state) => state.cameraRequest);
  const consumeCameraRequest = useEditorStore((state) => state.consumeCameraRequest);
  const { camera, invalidate } = useThree();
  // A ref, not state: framing the project once is a side effect on the camera,
  // and re-rendering because it happened would serve no purpose.
  const initialised = useRef(false);

  const frame = useCallback(
    (ids: string[] | undefined, direction?: THREE.Vector3) => {
      const bounds = modelBounds(model, ids && ids.length > 0 ? ids : undefined);
      const target = new THREE.Vector3(...bounds.sceneCenter);
      const radius = Math.max(bounds.sceneRadius, 2);
      const dir = (direction ?? camera.position.clone().sub(target)).normalize();
      if (dir.lengthSq() < 1e-6) dir.set(1, 0.75, 1).normalize();

      const distance = radius * (orthographic ? 3.2 : 2.9);
      camera.position.copy(target.clone().add(dir.multiplyScalar(distance)));

      if (camera instanceof THREE.OrthographicCamera) {
        camera.zoom = Math.max(1, 240 / Math.max(radius, 0.5));
        camera.updateProjectionMatrix();
      }
      camera.lookAt(target);

      const controls = controlsRef.current;
      if (controls) {
        controls.target.copy(target);
        controls.update();
      }
      invalidate();
    },
    [camera, model, orthographic, invalidate],
  );

  // Frame the project once, when it first has content.
  useEffect(() => {
    if (initialised.current) return;
    const bounds = modelBounds(model);
    if (bounds.isEmpty && Object.keys(model.elements).length === 0) return;
    initialised.current = true;
    frame(undefined, new THREE.Vector3(1, 0.75, 1));
  }, [model, frame]);

  useEffect(() => {
    if (!cameraRequest) return;
    if (cameraRequest.kind === 'frame') frame(cameraRequest.ids);
    if (cameraRequest.kind === 'preset' && cameraRequest.preset) {
      frame(undefined, presetDirection(cameraRequest.preset));
    }
    if (cameraRequest.kind === 'view' && cameraRequest.position && cameraRequest.target) {
      camera.position.set(
        cameraRequest.position.x * MM_TO_SCENE,
        cameraRequest.position.y * MM_TO_SCENE,
        cameraRequest.position.z * MM_TO_SCENE,
      );
      const target = new THREE.Vector3(
        cameraRequest.target.x * MM_TO_SCENE,
        cameraRequest.target.y * MM_TO_SCENE,
        cameraRequest.target.z * MM_TO_SCENE,
      );
      camera.lookAt(target);
      const controls = controlsRef.current;
      if (controls) {
        controls.target.copy(target);
        controls.update();
      }
      invalidate();
    }
    consumeCameraRequest();
  }, [cameraRequest, frame, camera, consumeCameraRequest, invalidate]);

  return (
    <>
      {orthographic ? (
        <OrthographicCamera
          makeDefault
          position={[24, 20, 24]}
          near={-2000}
          far={4000}
          zoom={22}
          up={UP}
        />
      ) : (
        <PerspectiveCamera
          makeDefault
          fov={45}
          near={0.05}
          far={4000}
          position={[24, 18, 24]}
          up={UP}
        />
      )}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        maxPolarAngle={Math.PI * 0.499}
        minDistance={0.5}
        maxDistance={1500}
        target={[0, 1.2, 0]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Lighting                                                            */
/* ------------------------------------------------------------------ */

function Lighting({ model, shadows }: { model: ProjectModel; shadows: boolean }) {
  const environment = model.environment;
  const bounds = useMemo(() => modelBounds(model), [model]);
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const { invalidate } = useThree();

  const sun = useMemo(
    () =>
      sunPosition(
        environment.sunAzimuthDeg,
        environment.sunAltitudeDeg,
        Math.max(bounds.sceneRadius * 3, 40),
      ),
    [environment.sunAzimuthDeg, environment.sunAltitudeDeg, bounds.sceneRadius],
  );

  // The shadow frustum is fitted to the model so shadows stay crisp on a small
  // building without going soft on a large one.
  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    const extent = Math.max(bounds.sceneRadius * 1.6, 12);
    const shadowCamera = light.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 0.5;
    shadowCamera.far = extent * 8;
    shadowCamera.updateProjectionMatrix();
    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.03;
    invalidate();
  }, [bounds.sceneRadius, invalidate]);

  const overcast = environment.weather === 'overcast';

  return (
    <>
      <color attach="background" args={[environment.backgroundColor]} />
      <fog
        attach="fog"
        args={[environment.backgroundColor, bounds.sceneRadius * 6, bounds.sceneRadius * 26]}
      />

      {environment.skyEnabled && environment.sunAltitudeDeg > 0 ? (
        <Sky
          distance={450000}
          sunPosition={[sun.x, sun.y, sun.z]}
          turbidity={overcast ? 14 : 6}
          rayleigh={overcast ? 0.6 : 2}
          mieCoefficient={overcast ? 0.02 : 0.005}
          mieDirectionalG={0.8}
        />
      ) : null}

      <hemisphereLight
        args={[
          overcast ? '#c8d4e0' : '#bcd7ff',
          environment.groundColor,
          environment.ambientIntensity * (overcast ? 1.6 : 1),
        ]}
      />
      <ambientLight intensity={environment.ambientIntensity * 0.35} />
      <directionalLight
        ref={lightRef}
        position={[sun.x, Math.max(sun.y, 1), sun.z]}
        intensity={environment.sunIntensity}
        castShadow={shadows && environment.shadowsEnabled}
        shadow-mapSize={[2048, 2048]}
        color={overcast ? '#e8eef5' : '#fff4e2'}
      />

      {model.environment.lights.map((light) =>
        light.kind === 'spot' ? (
          <spotLight
            key={light.id}
            position={[
              light.position.x * MM_TO_SCENE,
              light.position.z * MM_TO_SCENE,
              -light.position.y * MM_TO_SCENE,
            ]}
            intensity={light.intensity}
            color={light.color}
            angle={degToRad(light.angleDeg)}
            distance={light.distance * MM_TO_SCENE}
            castShadow={light.castShadow}
          />
        ) : (
          <pointLight
            key={light.id}
            position={[
              light.position.x * MM_TO_SCENE,
              light.position.z * MM_TO_SCENE,
              -light.position.y * MM_TO_SCENE,
            ]}
            intensity={light.intensity}
            color={light.color}
            distance={light.distance * MM_TO_SCENE}
            castShadow={light.castShadow}
          />
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Section cut                                                         */
/* ------------------------------------------------------------------ */

function SectionPlane({ elevationMm }: { elevationMm: number | null }) {
  const { gl, invalidate } = useThree();

  useEffect(() => {
    gl.clippingPlanes =
      elevationMm === null
        ? []
        : [new THREE.Plane(new THREE.Vector3(0, -1, 0), elevationMm * MM_TO_SCENE)];
    invalidate();
    return () => {
      gl.clippingPlanes = [];
    };
  }, [gl, elevationMm, invalidate]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Transform gizmo                                                     */
/* ------------------------------------------------------------------ */

function SelectionGizmo({ model }: { model: ProjectModel }) {
  const selection = useEditorStore((state) => state.selection);
  const gizmoMode = useEditorStore((state) => state.gizmoMode);
  const snap = useEditorStore((state) => state.snap);
  const dispatch = useEditorStore((state) => state.dispatch);

  // A callback ref rather than useRef: TransformControls needs the object as a
  // prop, and a ref read during render is both a React violation and a real bug
  // (the gizmo would not attach until something else forced a re-render).
  const [proxy, setProxy] = useState<THREE.Group | null>(null);
  const start = useRef<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null>(null);
  const { invalidate } = useThree();

  const centre = useMemo(() => {
    const bounds = modelBounds(model, selection);
    return new THREE.Vector3(...bounds.sceneCenter);
  }, [model, selection]);

  const editable = useMemo(
    () => selection.filter((id) => model.elements[id] && !model.elements[id]!.locked),
    [selection, model],
  );

  useEffect(() => {
    if (!proxy) return;
    proxy.position.copy(centre);
    proxy.rotation.set(0, 0, 0);
    proxy.scale.set(1, 1, 1);
    invalidate();
  }, [proxy, centre, gizmoMode, invalidate]);

  const handleDown = useCallback(() => {
    const group = proxy;
    if (!group) return;
    start.current = {
      position: group.position.clone(),
      rotation: group.rotation.clone(),
      scale: group.scale.clone(),
    };
  }, [proxy]);

  /**
   * Turns the gizmo's final transform into a command. This runs once, on
   * release — the drag itself is pure GPU work on the proxy group.
   */
  const handleUp = useCallback(() => {
    const group = proxy;
    const from = start.current;
    start.current = null;
    if (!group || !from || editable.length === 0) return;

    const pivot = { x: from.position.x / MM_TO_SCENE, y: -from.position.z / MM_TO_SCENE };

    if (gizmoMode === 'translate') {
      const delta = group.position.clone().sub(from.position);
      const command = {
        type: 'move_elements',
        description: 'Move selection',
        ids: editable,
        delta: {
          x: Math.round(delta.x / MM_TO_SCENE),
          y: Math.round(-delta.z / MM_TO_SCENE),
          z: Math.round(delta.y / MM_TO_SCENE),
        },
      };
      if (command.delta.x || command.delta.y || command.delta.z) {
        dispatch([command], { label: 'Move selection' });
      }
    } else if (gizmoMode === 'rotate') {
      // Only rotation about the vertical axis maps to a plan rotation.
      const angle = -radToDeg(group.rotation.y - from.rotation.y);
      if (Math.abs(angle) > 0.01) {
        dispatch(
          [
            {
              type: 'rotate_elements',
              description: 'Rotate selection',
              ids: editable,
              angleDeg: Number(angle.toFixed(3)),
              pivot,
            },
          ],
          { label: 'Rotate selection' },
        );
      }
    } else if (gizmoMode === 'scale') {
      const factor = group.scale.x / (from.scale.x || 1);
      if (Math.abs(factor - 1) > 0.001) {
        dispatch(
          [
            {
              type: 'scale_elements',
              description: 'Scale selection',
              ids: editable,
              factor: Number(factor.toFixed(4)),
              pivot,
              scaleVertical: true,
            },
          ],
          { label: 'Scale selection' },
        );
      }
    }

    group.position.copy(centre);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
    invalidate();
  }, [proxy, gizmoMode, editable, dispatch, centre, invalidate]);

  return (
    <>
      <group ref={setProxy} position={centre} />
      {proxy && gizmoMode !== 'select' && editable.length > 0 ? (
        <TransformControls
          object={proxy}
          mode={gizmoMode}
          size={0.9}
          translationSnap={snap.grid ? snap.gridSizeMm * MM_TO_SCENE : null}
          rotationSnap={snap.grid ? degToRad(snap.angleDeg) : null}
          scaleSnap={snap.grid ? 0.05 : null}
          onMouseDown={handleDown}
          onMouseUp={handleUp}
          onObjectChange={() => invalidate()}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Measurements                                                        */
/* ------------------------------------------------------------------ */

function MeasurementLayer({ model }: { model: ProjectModel }) {
  const measurement = useEditorStore((state) => state.measurement);

  const toScene = (point: { x: number; y: number; z: number }): [number, number, number] => [
    point.x * MM_TO_SCENE,
    point.z * MM_TO_SCENE,
    -point.y * MM_TO_SCENE,
  ];

  return (
    <group name="measurements">
      {model.measurements.map((entry) => (
        <group key={entry.id}>
          <Line
            points={
              entry.kind === 'area' && entry.points[0]
                ? [...entry.points.map(toScene), toScene(entry.points[0])]
                : entry.points.map(toScene)
            }
            color="#f0b429"
            lineWidth={2}
            dashed={false}
          />
          {entry.points.map((point, index) => (
            <mesh key={index} position={toScene(point)}>
              <sphereGeometry args={[0.04, 8, 8]} />
              <meshBasicMaterial color="#f0b429" />
            </mesh>
          ))}
        </group>
      ))}

      {measurement.active && measurement.points.length > 1 ? (
        <Line points={measurement.points.map(toScene)} color="#ffd166" lineWidth={2} dashed />
      ) : null}
      {measurement.active
        ? measurement.points.map((point, index) => (
            <mesh key={`draft-${index}`} position={toScene(point)}>
              <sphereGeometry args={[0.05, 8, 8]} />
              <meshBasicMaterial color="#ffd166" />
            </mesh>
          ))
        : null}
    </group>
  );
}

/** Formats a measurement for the status bar. Exported so the UI can reuse it. */
export function formatMeasurement(
  kind: 'distance' | 'area',
  value: number,
  units: 'metric' | 'imperial',
): string {
  return kind === 'distance' ? formatLength(value, units) : formatArea(value, units);
}

/* ------------------------------------------------------------------ */
/* Performance probe                                                   */
/* ------------------------------------------------------------------ */

/**
 * Samples renderer statistics twice a second.
 *
 * Deliberately not once per frame: writing React state every frame is the
 * classic way to turn a 60 fps scene into a 20 fps one, and the number would be
 * unreadable anyway.
 */
function PerformanceProbe({ adapter }: { adapter: SceneAdapter }) {
  const setPerformance = useEditorStore((state) => state.setPerformance);
  const accumulator = useRef({ frames: 0, elapsed: 0 });

  useFrame((state, delta) => {
    const acc = accumulator.current;
    acc.frames += 1;
    acc.elapsed += delta;
    if (acc.elapsed < 0.5) return;

    const info = state.gl.info;
    setPerformance({
      fps: Math.round(acc.frames / acc.elapsed),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: adapter.stats().geometries,
    });
    acc.frames = 0;
    acc.elapsed = 0;
  });

  return null;
}

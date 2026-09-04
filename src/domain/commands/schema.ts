import { z } from 'zod';
import {
  ELEMENT_TYPES,
  ENVIRONMENT_PRESETS,
  MATERIAL_CATEGORIES,
  OPENING_KINDS,
  OPENING_TYPES,
  ROOF_KINDS,
  WALL_ALIGNMENTS,
  artificialLightSchema,
  constraintSchema,
  elementSchema,
  environmentSchema,
  hexColorSchema,
  idSchema,
  materialSchema,
  measurementSchema,
  nameSchema,
  outlineSchema,
  point2Schema,
  point3Schema,
  savedViewSchema,
  siteSchema,
} from '@/domain/project/schema';
import { MAX_ARRAY_COUNT, MAX_LEVEL_HEIGHT_MM, MIN_LEVEL_HEIGHT_MM } from '@/domain/project/limits';
import { DISPLAY_UNIT_SYSTEMS } from '@/domain/units';
import { catalogIds } from '@/domain/project/furnitureCatalog';
import { createId } from '@/domain/project/ids';

/**
 * The modeling command language.
 *
 * This is the *only* channel through which the AI can change a project. There
 * is no code path anywhere in this repository that executes model-authored
 * JavaScript, and there never will be: a language model response is data, it is
 * parsed by the schema below, and anything that does not parse is rejected with
 * a structured error the model can read and retry against.
 *
 * ### Conventions every command obeys
 *
 * * **All lengths are millimetres.** No unit field, no ambiguity. The system
 *   prompt states this, the validator enforces it, and the interpreter converts
 *   before it ever builds a command.
 * * **All angles are degrees.** Plan rotations are anticlockwise from east.
 * * **Plan coordinates are `{ x: east, y: north }`.** Elevation is separate.
 * * **Every command is individually invertible.** The executor returns the
 *   inverse alongside the new state; undo replays inverses in reverse order.
 *
 * Commands marked internal (`INTERNAL_COMMAND_TYPES`) exist only so the engine
 * can express an inverse. They are stripped from the AI tool definition and
 * rejected if they arrive from a model response.
 */

export const COMMAND_PROTOCOL_VERSION = 1;

const commandBase = {
  /** Stable id, used to correlate validation errors and undo entries. */
  id: z
    .string()
    .min(1)
    .max(64)
    .default(() => createId('cmd')),
  /** Protocol version. Bumped only for breaking argument changes. */
  v: z.literal(COMMAND_PROTOCOL_VERSION).default(COMMAND_PROTOCOL_VERSION),
  /** One line of plain English, shown in the operation log and undo history. */
  description: z.string().max(300).default(''),
};

const idList = z.array(idSchema).min(1).max(2000);
const lengthMm = z.number().finite().positive().max(1_000_000);
const offsetMm = z.number().finite().min(-10_000_000).max(10_000_000);

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export const createWallCommand = z.object({
  ...commandBase,
  type: z.literal('create_wall'),
  /** Optional explicit id, so a later command in the same turn can reference it. */
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  start: point2Schema,
  end: point2Schema,
  height: lengthMm.optional(),
  thickness: lengthMm.optional(),
  alignment: z.enum(WALL_ALIGNMENTS).optional(),
  baseOffset: offsetMm.optional(),
  materialId: idSchema.optional(),
  structural: z.boolean().optional(),
  exterior: z.boolean().optional(),
});

export const createRectangularFootprintCommand = z.object({
  ...commandBase,
  type: z.literal('create_rectangular_footprint'),
  /**
   * Four walls plus, optionally, a floor slab — the single most common opening
   * move in a schematic session, and the reason a "12 by 8 metre house" request
   * does not need five separate commands.
   */
  levelId: idSchema.optional(),
  centre: point2Schema.default({ x: 0, y: 0 }),
  width: lengthMm,
  depth: lengthMm,
  height: lengthMm.optional(),
  thickness: lengthMm.optional(),
  rotationDeg: z.number().finite().min(-360).max(360).default(0),
  includeSlab: z.boolean().default(true),
  materialId: idSchema.optional(),
  namePrefix: z.string().max(60).optional(),
});

export const createSlabCommand = z.object({
  ...commandBase,
  type: z.literal('create_slab'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  outline: outlineSchema,
  thickness: lengthMm.optional(),
  topOffset: offsetMm.optional(),
  materialId: idSchema.optional(),
  role: z.enum(['floor', 'ceiling', 'terrace', 'foundation']).optional(),
});

export const createRoomCommand = z.object({
  ...commandBase,
  type: z.literal('create_room'),
  elementId: idSchema.optional(),
  name: nameSchema,
  levelId: idSchema.optional(),
  outline: outlineSchema,
  ceilingHeight: lengthMm.nullish(),
  programme: z
    .enum([
      'living',
      'kitchen',
      'dining',
      'bedroom',
      'bathroom',
      'wc',
      'circulation',
      'storage',
      'study',
      'utility',
      'studio',
      'office',
      'retail',
      'outdoor',
      'technical',
      'other',
    ])
    .optional(),
  floorMaterialId: idSchema.nullish(),
  occupancy: z.number().int().min(0).max(10_000).optional(),
});

export const createOpeningCommand = z.object({
  ...commandBase,
  type: z.literal('create_opening'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  /** The wall that will host the opening. Required — openings are never free. */
  hostId: idSchema,
  kind: z.enum(OPENING_KINDS),
  openingType: z.enum(OPENING_TYPES).optional(),
  /** Centre of the opening measured from the host wall's start point, in mm. */
  distanceAlongWall: z.number().finite().min(0).max(1_000_000),
  width: lengthMm,
  height: lengthMm,
  sillHeight: z.number().finite().min(0).max(MAX_LEVEL_HEIGHT_MM).optional(),
  frameMaterialId: idSchema.nullish(),
  glazingMaterialId: idSchema.nullish(),
});

export const distributeOpeningsCommand = z.object({
  ...commandBase,
  type: z.literal('distribute_openings'),
  /**
   * Evenly spaces `count` identical openings along a wall. Exists because
   * "three evenly spaced windows on the west façade" is one architectural
   * intention, and expressing it as one command means the spacing is computed
   * from the wall's true length rather than guessed by the model.
   */
  hostId: idSchema,
  count: z.number().int().min(1).max(50),
  kind: z.enum(OPENING_KINDS),
  openingType: z.enum(OPENING_TYPES).optional(),
  width: lengthMm,
  height: lengthMm,
  sillHeight: z.number().finite().min(0).max(MAX_LEVEL_HEIGHT_MM).optional(),
  /** Clear distance kept at each end of the wall, in mm. */
  edgeMargin: z.number().finite().min(0).max(100_000).optional(),
  namePrefix: z.string().max(60).optional(),
});

export const createRoofCommand = z.object({
  ...commandBase,
  type: z.literal('create_roof'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  kind: z.enum(ROOF_KINDS),
  /** Omit to derive the outline from the level's walls. */
  outline: outlineSchema.optional(),
  baseElevation: offsetMm.optional(),
  thickness: lengthMm.optional(),
  pitchDeg: z.number().finite().min(0).max(75).optional(),
  ridgeAxis: z.enum(['x', 'y']).optional(),
  overhang: z.number().finite().min(0).max(5_000).optional(),
  materialId: idSchema.optional(),
});

export const createStairCommand = z.object({
  ...commandBase,
  type: z.literal('create_stair'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  position: point2Schema,
  rotationDeg: z.number().finite().min(-360).max(360).optional(),
  width: lengthMm.optional(),
  /** Floor-to-floor rise. Omit to use the level's height. */
  totalRise: lengthMm.optional(),
  steps: z.number().int().min(2).max(60).optional(),
  treadDepth: lengthMm.optional(),
  shape: z.enum(['straight', 'l-shaped', 'u-shaped']).optional(),
  landingDepth: lengthMm.optional(),
  materialId: idSchema.optional(),
});

export const createColumnCommand = z.object({
  ...commandBase,
  type: z.literal('create_column'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  position: point2Schema,
  width: lengthMm.optional(),
  depth: lengthMm.optional(),
  height: lengthMm.optional(),
  shape: z.enum(['rectangular', 'round']).optional(),
  rotationDeg: z.number().finite().min(-360).max(360).optional(),
  materialId: idSchema.optional(),
});

export const createBeamCommand = z.object({
  ...commandBase,
  type: z.literal('create_beam'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  start: point2Schema,
  end: point2Schema,
  width: lengthMm.optional(),
  depth: lengthMm.optional(),
  baseOffset: offsetMm.optional(),
  materialId: idSchema.optional(),
});

export const createRailingCommand = z.object({
  ...commandBase,
  type: z.literal('create_railing'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  path: z.array(point2Schema).min(2).max(200),
  height: lengthMm.optional(),
  postSpacing: lengthMm.optional(),
  infill: z.enum(['vertical-bars', 'glass', 'solid', 'none']).optional(),
  materialId: idSchema.optional(),
});

export const placeFurnitureCommand = z.object({
  ...commandBase,
  type: z.literal('place_furniture'),
  elementId: idSchema.optional(),
  name: nameSchema.optional(),
  levelId: idSchema.optional(),
  /** Must be a member of the internal catalogue; arbitrary ids are rejected. */
  catalogId: z.string().refine((value) => catalogIds().includes(value), {
    message: 'Unknown catalogue item. Use list_catalogue to see the available items.',
  }),
  position: point2Schema,
  rotationDeg: z.number().finite().min(-360).max(360).optional(),
  scale: z.number().min(0.1).max(10).optional(),
});

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

export const setElementPropertiesCommand = z.object({
  ...commandBase,
  type: z.literal('set_element_properties'),
  ids: idList,
  /**
   * A shallow patch applied to each target and then re-validated against the
   * element schema. `id`, `type` and `parentId` may never be patched — changing
   * an element's identity or class is a create/delete, not an edit.
   */
  patch: z.record(z.string(), z.unknown()),
});

export const moveElementsCommand = z.object({
  ...commandBase,
  type: z.literal('move_elements'),
  ids: idList,
  /** Translation in mm. `z` moves the element up in elevation. */
  delta: z.object({ x: offsetMm.default(0), y: offsetMm.default(0), z: offsetMm.default(0) }),
});

export const rotateElementsCommand = z.object({
  ...commandBase,
  type: z.literal('rotate_elements'),
  ids: idList,
  angleDeg: z.number().finite().min(-3600).max(3600),
  /** Rotation centre in plan. Omit to use the selection's centroid. */
  pivot: point2Schema.optional(),
});

export const scaleElementsCommand = z.object({
  ...commandBase,
  type: z.literal('scale_elements'),
  ids: idList,
  factor: z.number().finite().min(0.01).max(100),
  pivot: point2Schema.optional(),
  /** When false, heights and thicknesses are preserved (plan-only scaling). */
  scaleVertical: z.boolean().default(true),
});

export const deleteElementsCommand = z.object({
  ...commandBase,
  type: z.literal('delete_elements'),
  ids: idList,
});

export const duplicateElementsCommand = z.object({
  ...commandBase,
  type: z.literal('duplicate_elements'),
  ids: idList,
  offset: z
    .object({ x: offsetMm.default(0), y: offsetMm.default(0), z: offsetMm.default(0) })
    .optional(),
});

export const arrayElementsCommand = z.object({
  ...commandBase,
  type: z.literal('array_elements'),
  ids: idList,
  count: z.number().int().min(2).max(MAX_ARRAY_COUNT),
  /** Step between successive copies, in mm. */
  step: z.object({ x: offsetMm.default(0), y: offsetMm.default(0), z: offsetMm.default(0) }),
});

export const alignElementsCommand = z.object({
  ...commandBase,
  type: z.literal('align_elements'),
  ids: z.array(idSchema).min(2).max(500),
  axis: z.enum(['x', 'y', 'z']),
  mode: z.enum(['min', 'centre', 'max']),
});

export const distributeElementsCommand = z.object({
  ...commandBase,
  type: z.literal('distribute_elements'),
  ids: z.array(idSchema).min(3).max(500),
  axis: z.enum(['x', 'y']),
  /** Fixed centre-to-centre spacing in mm. Omit to space evenly between ends. */
  spacing: lengthMm.optional(),
});

export const setVisibilityCommand = z.object({
  ...commandBase,
  type: z.literal('set_visibility'),
  ids: idList,
  visible: z.boolean(),
});

export const setLockCommand = z.object({
  ...commandBase,
  type: z.literal('set_lock'),
  ids: idList,
  locked: z.boolean(),
});

export const renameElementCommand = z.object({
  ...commandBase,
  type: z.literal('rename_element'),
  /** The element to rename. Named `elementId` because `id` is the command's own. */
  elementId: idSchema,
  name: nameSchema,
});

export const groupElementsCommand = z.object({
  ...commandBase,
  type: z.literal('group_elements'),
  ids: z.array(idSchema).min(2).max(2000),
  name: nameSchema.optional(),
  groupId: idSchema.optional(),
});

export const ungroupElementsCommand = z.object({
  ...commandBase,
  type: z.literal('ungroup_elements'),
  groupId: idSchema,
});

export const joinWallsCommand = z.object({
  ...commandBase,
  type: z.literal('join_walls'),
  /** Omit to join every wall on the level. */
  ids: z.array(idSchema).max(2000).optional(),
  levelId: idSchema.optional(),
  /** Endpoints closer than this are welded together, in mm. */
  toleranceMm: z.number().finite().min(1).max(5000).default(600),
});

export const splitWallCommand = z.object({
  ...commandBase,
  type: z.literal('split_wall'),
  /** The wall to split. Named `elementId` because `id` is the command's own. */
  elementId: idSchema,
  /** Distance from the wall start at which to split, in mm. */
  distance: lengthMm,
});

/* ------------------------------------------------------------------ */
/* Levels, materials, environment                                      */
/* ------------------------------------------------------------------ */

export const createLevelCommand = z.object({
  ...commandBase,
  type: z.literal('create_level'),
  levelId: idSchema.optional(),
  name: nameSchema,
  elevation: offsetMm.optional(),
  height: z.number().finite().min(MIN_LEVEL_HEIGHT_MM).max(MAX_LEVEL_HEIGHT_MM).optional(),
  index: z.number().int().min(-20).max(200).optional(),
});

export const updateLevelCommand = z.object({
  ...commandBase,
  type: z.literal('update_level'),
  levelId: idSchema,
  name: nameSchema.optional(),
  elevation: offsetMm.optional(),
  height: z.number().finite().min(MIN_LEVEL_HEIGHT_MM).max(MAX_LEVEL_HEIGHT_MM).optional(),
  visible: z.boolean().optional(),
  /**
   * When true, levels above this one shift by the same amount as its height
   * change, so raising a ground-floor ceiling lifts the storeys above it rather
   * than burying them.
   */
  cascade: z.boolean().default(true),
});

export const deleteLevelCommand = z.object({
  ...commandBase,
  type: z.literal('delete_level'),
  levelId: idSchema,
});

export const createMaterialCommand = z.object({
  ...commandBase,
  type: z.literal('create_material'),
  materialId: idSchema.optional(),
  name: nameSchema,
  category: z.enum(MATERIAL_CATEGORIES).optional(),
  color: hexColorSchema,
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0.02).max(1).optional(),
  textureRef: z.string().max(200).nullish(),
  textureScaleMm: z.number().positive().max(100_000).optional(),
  description: z.string().max(400).optional(),
});

export const updateMaterialCommand = z.object({
  ...commandBase,
  type: z.literal('update_material'),
  materialId: idSchema,
  name: nameSchema.optional(),
  category: z.enum(MATERIAL_CATEGORIES).optional(),
  color: hexColorSchema.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0.02).max(1).optional(),
  textureRef: z.string().max(200).nullish(),
  textureScaleMm: z.number().positive().max(100_000).optional(),
  emissiveIntensity: z.number().min(0).max(10).optional(),
  description: z.string().max(400).optional(),
});

export const assignMaterialCommand = z.object({
  ...commandBase,
  type: z.literal('assign_material'),
  ids: idList,
  materialId: idSchema,
  /** Which slot to target on elements that have more than one. */
  slot: z.enum(['primary', 'floor', 'frame', 'glazing']).default('primary'),
});

export const updateEnvironmentCommand = z.object({
  ...commandBase,
  type: z.literal('update_environment'),
  preset: z.enum(ENVIRONMENT_PRESETS).optional(),
  sunAzimuthDeg: z.number().finite().min(0).max(360).optional(),
  sunAltitudeDeg: z.number().finite().min(-10).max(90).optional(),
  sunIntensity: z.number().min(0).max(20).optional(),
  ambientIntensity: z.number().min(0).max(20).optional(),
  skyEnabled: z.boolean().optional(),
  backgroundColor: hexColorSchema.optional(),
  groundColor: hexColorSchema.optional(),
  shadowsEnabled: z.boolean().optional(),
  exposure: z.number().min(0.1).max(4).optional(),
  weather: z.enum(['clear', 'overcast', 'sunset', 'night']).optional(),
});

export const addLightCommand = z.object({
  ...commandBase,
  type: z.literal('add_light'),
  light: artificialLightSchema
    .partial({ id: true })
    .required({ name: true, kind: true, position: true }),
});

export const updateLightCommand = z.object({
  ...commandBase,
  type: z.literal('update_light'),
  lightId: idSchema,
  patch: artificialLightSchema.partial().omit({ id: true }),
});

export const removeLightCommand = z.object({
  ...commandBase,
  type: z.literal('remove_light'),
  lightId: idSchema,
});

/* ------------------------------------------------------------------ */
/* Views, measurement, project                                         */
/* ------------------------------------------------------------------ */

export const setCameraCommand = z.object({
  ...commandBase,
  type: z.literal('set_camera'),
  mode: z.enum(['perspective', 'orthographic']).optional(),
  preset: z.enum(['top', 'front', 'back', 'left', 'right', 'iso', 'section']).optional(),
  position: point3Schema.optional(),
  target: point3Schema.optional(),
  sectionElevation: z.number().finite().nullish(),
});

export const saveViewCommand = z.object({
  ...commandBase,
  type: z.literal('save_view'),
  viewId: idSchema.optional(),
  name: nameSchema,
  mode: z.enum(['perspective', 'orthographic']).default('perspective'),
  position: point3Schema,
  target: point3Schema,
  zoom: z.number().min(0.001).max(1000).default(1),
  sectionElevation: z.number().finite().nullish(),
});

export const restoreViewCommand = z.object({
  ...commandBase,
  type: z.literal('restore_view'),
  viewId: idSchema,
});

export const focusElementsCommand = z.object({
  ...commandBase,
  type: z.literal('focus_elements'),
  ids: z.array(idSchema).max(2000),
});

export const selectElementsCommand = z.object({
  ...commandBase,
  type: z.literal('select_elements'),
  ids: z.array(idSchema).max(2000),
  mode: z.enum(['replace', 'add', 'remove']).default('replace'),
});

export const addMeasurementCommand = z.object({
  ...commandBase,
  type: z.literal('add_measurement'),
  measurementId: idSchema.optional(),
  kind: z.enum(['distance', 'area']),
  label: z.string().max(120).optional(),
  points: z.array(point3Schema).min(2).max(200),
});

export const removeMeasurementCommand = z.object({
  ...commandBase,
  type: z.literal('remove_measurement'),
  measurementId: idSchema,
});

export const setUnitsCommand = z.object({
  ...commandBase,
  type: z.literal('set_units'),
  units: z.enum(DISPLAY_UNIT_SYSTEMS),
});

export const setProjectInfoCommand = z.object({
  ...commandBase,
  type: z.literal('set_project_info'),
  name: nameSchema.optional(),
  projectDescription: z.string().max(2000).optional(),
  locationLabel: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  northAngleDeg: z.number().finite().min(-360).max(360).optional(),
  standardsProfile: z.string().max(200).optional(),
  climateNotes: z.string().max(1000).optional(),
});

export const addConstraintCommand = z.object({
  ...commandBase,
  type: z.literal('add_constraint'),
  constraint: constraintSchema.partial({ id: true, targetIds: true, value: true, active: true }),
});

export const removeConstraintCommand = z.object({
  ...commandBase,
  type: z.literal('remove_constraint'),
  constraintId: idSchema,
});

/* ------------------------------------------------------------------ */
/* Host-effect commands                                                */
/* ------------------------------------------------------------------ */

/**
 * These do not change the project model. They ask the application shell to do
 * something (write a file, take a snapshot) and are recorded in the operation
 * log so the transcript stays a complete account of the session.
 */
export const exportProjectCommand = z.object({
  ...commandBase,
  type: z.literal('export_project'),
  format: z.enum(['json', 'glb', 'gltf', 'obj', 'stl', 'screenshot', 'summary']),
  /** Restrict the export to a selection. Omit for the whole project. */
  ids: z.array(idSchema).max(2000).optional(),
});

export const createSnapshotCommand = z.object({
  ...commandBase,
  type: z.literal('create_snapshot'),
  label: z.string().min(1).max(120),
});

export const restoreSnapshotCommand = z.object({
  ...commandBase,
  type: z.literal('restore_snapshot'),
  snapshotId: z.string().min(1).max(64),
});

export const importFileCommand = z.object({
  ...commandBase,
  type: z.literal('import_file'),
  /** Storage key of a file the user has already uploaded. */
  assetRef: z.string().min(1).max(400),
  format: z.enum(['gltf', 'glb', 'obj', 'stl', 'ifc', 'dxf', 'json']),
  name: nameSchema.optional(),
  levelId: idSchema.nullish(),
  position: point3Schema.optional(),
  rotationDeg: z.number().finite().min(-360).max(360).optional(),
  scale: z.number().min(0.0001).max(10_000).optional(),
});

/* ------------------------------------------------------------------ */
/* Internal commands                                                   */
/* ------------------------------------------------------------------ */

/**
 * `restore_elements` is how deletion is undone: the executor captures the full
 * serialized elements and emits this as the inverse. It is not part of the AI
 * surface — a model has no reason to hand us raw element documents, and
 * accepting them would widen the trust boundary for no benefit.
 */
export const restoreElementsCommand = z.object({
  ...commandBase,
  type: z.literal('restore_elements'),
  elements: z.array(elementSchema).min(1).max(2000),
  /** Positions to reinsert at, so undo restores hierarchy order exactly. */
  orderHints: z
    .array(z.object({ id: idSchema, index: z.number().int().min(0) }))
    .max(2000)
    .default([]),
});

export const replaceLevelsCommand = z.object({
  ...commandBase,
  type: z.literal('replace_levels'),
  levels: z.array(
    z.object({
      id: idSchema,
      name: nameSchema,
      elevation: offsetMm,
      height: z.number().finite().min(MIN_LEVEL_HEIGHT_MM).max(MAX_LEVEL_HEIGHT_MM),
      index: z.number().int().min(-20).max(200),
      visible: z.boolean(),
    }),
  ),
});

export const removeElementsHardCommand = z.object({
  ...commandBase,
  type: z.literal('remove_elements_hard'),
  ids: idList,
});

export const replaceMaterialsCommand = z.object({
  ...commandBase,
  type: z.literal('replace_materials'),
  materials: z.record(idSchema, materialSchema),
});

export const replaceEnvironmentCommand = z.object({
  ...commandBase,
  type: z.literal('replace_environment'),
  environment: environmentSchema,
});

export const replaceViewsCommand = z.object({
  ...commandBase,
  type: z.literal('replace_views'),
  views: z.array(savedViewSchema).max(50),
});

export const replaceConstraintsCommand = z.object({
  ...commandBase,
  type: z.literal('replace_constraints'),
  constraints: z.array(constraintSchema).max(200),
});

export const replaceMeasurementsCommand = z.object({
  ...commandBase,
  type: z.literal('replace_measurements'),
  measurements: z.array(measurementSchema).max(200),
});

export const replaceProjectInfoCommand = z.object({
  ...commandBase,
  type: z.literal('replace_project_info'),
  name: nameSchema,
  projectDescription: z.string().max(2000),
  units: z.enum(DISPLAY_UNIT_SYSTEMS),
  site: siteSchema,
});

/* ------------------------------------------------------------------ */
/* Union                                                               */
/* ------------------------------------------------------------------ */

export const modelingCommandSchema = z.discriminatedUnion('type', [
  createWallCommand,
  createRectangularFootprintCommand,
  createSlabCommand,
  createRoomCommand,
  createOpeningCommand,
  distributeOpeningsCommand,
  createRoofCommand,
  createStairCommand,
  createColumnCommand,
  createBeamCommand,
  createRailingCommand,
  placeFurnitureCommand,
  setElementPropertiesCommand,
  moveElementsCommand,
  rotateElementsCommand,
  scaleElementsCommand,
  deleteElementsCommand,
  duplicateElementsCommand,
  arrayElementsCommand,
  alignElementsCommand,
  distributeElementsCommand,
  setVisibilityCommand,
  setLockCommand,
  renameElementCommand,
  groupElementsCommand,
  ungroupElementsCommand,
  joinWallsCommand,
  splitWallCommand,
  createLevelCommand,
  updateLevelCommand,
  deleteLevelCommand,
  createMaterialCommand,
  updateMaterialCommand,
  assignMaterialCommand,
  updateEnvironmentCommand,
  addLightCommand,
  updateLightCommand,
  removeLightCommand,
  setCameraCommand,
  saveViewCommand,
  restoreViewCommand,
  focusElementsCommand,
  selectElementsCommand,
  addMeasurementCommand,
  removeMeasurementCommand,
  setUnitsCommand,
  setProjectInfoCommand,
  addConstraintCommand,
  removeConstraintCommand,
  exportProjectCommand,
  createSnapshotCommand,
  restoreSnapshotCommand,
  importFileCommand,
  restoreElementsCommand,
  replaceLevelsCommand,
  removeElementsHardCommand,
  replaceMaterialsCommand,
  replaceEnvironmentCommand,
  replaceViewsCommand,
  replaceConstraintsCommand,
  replaceMeasurementsCommand,
  replaceProjectInfoCommand,
]);

export type ModelingCommand = z.infer<typeof modelingCommandSchema>;
export type CommandType = ModelingCommand['type'];

/** Commands the engine emits for undo but never accepts from a model. */
export const INTERNAL_COMMAND_TYPES = [
  'restore_elements',
  'replace_levels',
  'remove_elements_hard',
  'replace_materials',
  'replace_environment',
  'replace_views',
  'replace_constraints',
  'replace_measurements',
  'replace_project_info',
] as const satisfies readonly CommandType[];

const INTERNAL_SET = new Set<string>(INTERNAL_COMMAND_TYPES);

/** Commands that never change the model — the shell performs the effect. */
export const HOST_EFFECT_COMMAND_TYPES = [
  'export_project',
  'create_snapshot',
  'restore_snapshot',
  'set_camera',
  'restore_view',
  'focus_elements',
  'select_elements',
] as const satisfies readonly CommandType[];

export const ALL_COMMAND_TYPES = modelingCommandSchema.options.map(
  (option) => option.shape.type.value,
) as CommandType[];

/** The allowlist the AI layer is permitted to emit. */
export const AI_COMMAND_TYPES: CommandType[] = ALL_COMMAND_TYPES.filter(
  (type) => !INTERNAL_SET.has(type),
);

export function isInternalCommand(type: string): boolean {
  return INTERNAL_SET.has(type);
}

export function isHostEffectCommand(type: string): boolean {
  return (HOST_EFFECT_COMMAND_TYPES as readonly string[]).includes(type);
}

export const ELEMENT_TYPE_VALUES = ELEMENT_TYPES;

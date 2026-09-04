import { z } from 'zod';
import { DISPLAY_UNIT_SYSTEMS } from '@/domain/units';
import {
  MAX_COORDINATE_MM,
  MAX_DIMENSION_MM,
  MAX_LEVEL_HEIGHT_MM,
  MAX_OUTLINE_POINTS,
  MAX_STAIR_STEPS,
  MAX_THICKNESS_MM,
  MIN_LEVEL_HEIGHT_MM,
  MIN_THICKNESS_MM,
} from './limits';

/**
 * The durable project model.
 *
 * This — not the Three.js scene graph — is the source of truth. The scene is a
 * pure function of this object. Anything the renderer knows that this file does
 * not describe is, by definition, not part of the design.
 *
 * All lengths are millimetres, all angles are degrees, plan coordinates are
 * `{ x: east, y: north }`, and elevations are measured from project datum.
 */

export const PROJECT_SCHEMA_VERSION = 3;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    'Identifiers may contain letters, digits, hyphens and underscores only',
  );

const coordinate = z.number().finite().min(-MAX_COORDINATE_MM).max(MAX_COORDINATE_MM);

const dimension = z.number().finite().positive().max(MAX_DIMENSION_MM);

const nonNegative = z.number().finite().nonnegative().max(MAX_DIMENSION_MM);

const thickness = z.number().finite().min(MIN_THICKNESS_MM).max(MAX_THICKNESS_MM);

const angleDeg = z.number().finite().min(-3600).max(3600);

export const point2Schema = z.object({ x: coordinate, y: coordinate });
export type Point2 = z.infer<typeof point2Schema>;

export const point3Schema = z.object({ x: coordinate, y: coordinate, z: coordinate });
export type Point3 = z.infer<typeof point3Schema>;

export const outlineSchema = z.array(point2Schema).min(3).max(MAX_OUTLINE_POINTS);

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a #rrggbb hex string');

export const nameSchema = z.string().min(1).max(120);

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

export const levelSchema = z.object({
  id: idSchema,
  name: nameSchema,
  /** Finished floor level, measured from project datum, in mm. */
  elevation: coordinate,
  /** Floor-to-floor height in mm. */
  height: z.number().finite().min(MIN_LEVEL_HEIGHT_MM).max(MAX_LEVEL_HEIGHT_MM),
  /** Storey ordering: 0 is ground, negative is basement. */
  index: z.number().int().min(-20).max(200),
  visible: z.boolean().default(true),
});
export type Level = z.infer<typeof levelSchema>;

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

export const MATERIAL_CATEGORIES = [
  'wall',
  'floor',
  'ceiling',
  'roof',
  'glazing',
  'metal',
  'timber',
  'masonry',
  'concrete',
  'fabric',
  'site',
  'generic',
] as const;

export const materialSchema = z.object({
  id: idSchema,
  name: nameSchema,
  category: z.enum(MATERIAL_CATEGORIES).default('generic'),
  color: hexColorSchema,
  roughness: z.number().min(0).max(1).default(0.8),
  metalness: z.number().min(0).max(1).default(0),
  opacity: z.number().min(0.02).max(1).default(1),
  /** Key into the built-in procedural texture catalogue, or an uploaded asset id. */
  textureRef: z.string().max(200).nullable().default(null),
  /** Texture repeat in millimetres per tile. */
  textureScaleMm: z.number().positive().max(100_000).default(1000),
  emissiveIntensity: z.number().min(0).max(10).default(0),
  description: z.string().max(400).default(''),
});
export type MaterialDefinition = z.infer<typeof materialSchema>;

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

export const ELEMENT_TYPES = [
  'wall',
  'slab',
  'room',
  'opening',
  'roof',
  'stair',
  'column',
  'beam',
  'railing',
  'furniture',
  'group',
  'imported',
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

const elementBase = {
  id: idSchema,
  name: nameSchema,
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  /** Provenance, so the inspector can show what the AI authored. */
  origin: z.enum(['user', 'ai', 'import', 'template']).default('user'),
  /** Optional group membership. */
  parentId: idSchema.nullable().default(null),
  tags: z.array(z.string().max(40)).max(20).default([]),
  notes: z.string().max(1000).default(''),
};

export const WALL_ALIGNMENTS = ['center', 'left', 'right'] as const;

export const wallSchema = z.object({
  ...elementBase,
  type: z.literal('wall'),
  levelId: idSchema,
  start: point2Schema,
  end: point2Schema,
  height: dimension,
  thickness,
  /** Which side of the baseline the wall body sits on. */
  alignment: z.enum(WALL_ALIGNMENTS).default('center'),
  /** Vertical offset from the level's finished floor, in mm. */
  baseOffset: z.number().finite().min(-MAX_LEVEL_HEIGHT_MM).max(MAX_LEVEL_HEIGHT_MM).default(0),
  materialId: idSchema,
  /** True when the wall carries load; used for structural plausibility hints. */
  structural: z.boolean().default(false),
  exterior: z.boolean().default(true),
});
export type Wall = z.infer<typeof wallSchema>;

export const slabSchema = z.object({
  ...elementBase,
  type: z.literal('slab'),
  levelId: idSchema,
  outline: outlineSchema,
  thickness,
  /** Offset of the slab top from the level elevation, in mm (usually 0). */
  topOffset: z.number().finite().min(-10_000).max(10_000).default(0),
  materialId: idSchema,
  role: z.enum(['floor', 'ceiling', 'terrace', 'foundation']).default('floor'),
});
export type Slab = z.infer<typeof slabSchema>;

export const roomSchema = z.object({
  ...elementBase,
  type: z.literal('room'),
  levelId: idSchema,
  outline: outlineSchema,
  /** Clear ceiling height in mm; falls back to the level height when null. */
  ceilingHeight: dimension.nullable().default(null),
  /** Programme classification, used by the AI for adjacency reasoning. */
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
    .default('other'),
  floorMaterialId: idSchema.nullable().default(null),
  occupancy: z.number().int().min(0).max(10_000).default(0),
});
export type Room = z.infer<typeof roomSchema>;

export const OPENING_KINDS = ['door', 'window'] as const;
export const OPENING_TYPES = [
  'single-door',
  'double-door',
  'sliding-door',
  'entrance-door',
  'fixed-window',
  'casement-window',
  'sliding-window',
  'floor-to-ceiling',
  'rooflight',
  'opening',
] as const;

export const openingSchema = z.object({
  ...elementBase,
  type: z.literal('opening'),
  kind: z.enum(OPENING_KINDS),
  openingType: z.enum(OPENING_TYPES).default('fixed-window'),
  /** The wall that hosts this opening. Openings never exist standalone. */
  hostId: idSchema,
  /** Distance from the host wall's start point to the opening centre, in mm. */
  distanceAlongWall: nonNegative,
  width: dimension,
  height: dimension,
  /** Height of the opening's underside above the wall base, in mm. */
  sillHeight: z.number().finite().min(0).max(MAX_LEVEL_HEIGHT_MM).default(900),
  frameMaterialId: idSchema.nullable().default(null),
  glazingMaterialId: idSchema.nullable().default(null),
  /** Reveal depth used when drawing the frame, in mm. */
  frameDepth: z.number().finite().min(0).max(400).default(60),
});
export type Opening = z.infer<typeof openingSchema>;

export const ROOF_KINDS = ['flat', 'shed', 'gable'] as const;

export const roofSchema = z.object({
  ...elementBase,
  type: z.literal('roof'),
  levelId: idSchema,
  kind: z.enum(ROOF_KINDS),
  outline: outlineSchema,
  /** Elevation of the roof's lowest bearing point above datum, in mm. */
  baseElevation: coordinate,
  thickness,
  /** Pitch in degrees. Ignored for flat roofs. */
  pitchDeg: z.number().finite().min(0).max(75).default(20),
  /** Axis the ridge runs along for gable roofs, or the fall direction for sheds. */
  ridgeAxis: z.enum(['x', 'y']).default('x'),
  /** Eaves overhang beyond the outline, in mm. */
  overhang: z.number().finite().min(0).max(5_000).default(400),
  materialId: idSchema,
});
export type Roof = z.infer<typeof roofSchema>;

export const stairSchema = z.object({
  ...elementBase,
  type: z.literal('stair'),
  levelId: idSchema,
  /** Position of the bottom-centre of the first riser. */
  position: point2Schema,
  /** Direction of travel, measured anticlockwise from east. */
  rotationDeg: angleDeg.default(0),
  width: dimension,
  /** Total floor-to-floor rise the stair must climb, in mm. */
  totalRise: dimension,
  /** Number of risers. Treads = risers - 1 for a straight flight. */
  steps: z.number().int().min(2).max(MAX_STAIR_STEPS),
  treadDepth: dimension,
  shape: z.enum(['straight', 'l-shaped', 'u-shaped']).default('straight'),
  /** Landing depth for L and U shapes, in mm. */
  landingDepth: dimension.default(1000),
  materialId: idSchema,
});
export type Stair = z.infer<typeof stairSchema>;

export const columnSchema = z.object({
  ...elementBase,
  type: z.literal('column'),
  levelId: idSchema,
  position: point2Schema,
  width: dimension,
  depth: dimension,
  height: dimension,
  shape: z.enum(['rectangular', 'round']).default('rectangular'),
  rotationDeg: angleDeg.default(0),
  materialId: idSchema,
});
export type Column = z.infer<typeof columnSchema>;

export const beamSchema = z.object({
  ...elementBase,
  type: z.literal('beam'),
  levelId: idSchema,
  start: point2Schema,
  end: point2Schema,
  width: dimension,
  depth: dimension,
  /** Elevation of the beam soffit above the level, in mm. */
  baseOffset: z.number().finite().min(-MAX_LEVEL_HEIGHT_MM).max(MAX_LEVEL_HEIGHT_MM).default(2400),
  materialId: idSchema,
});
export type Beam = z.infer<typeof beamSchema>;

export const railingSchema = z.object({
  ...elementBase,
  type: z.literal('railing'),
  levelId: idSchema,
  path: z.array(point2Schema).min(2).max(MAX_OUTLINE_POINTS),
  height: dimension,
  postSpacing: dimension.default(1200),
  infill: z.enum(['vertical-bars', 'glass', 'solid', 'none']).default('vertical-bars'),
  materialId: idSchema,
});
export type Railing = z.infer<typeof railingSchema>;

export const furnitureSchema = z.object({
  ...elementBase,
  type: z.literal('furniture'),
  levelId: idSchema,
  /** Key into the internal catalogue. Arbitrary meshes are never generated here. */
  catalogId: z.string().min(1).max(60),
  position: point2Schema,
  rotationDeg: angleDeg.default(0),
  /** Uniform scale factor; catalogue items carry real-world default sizes. */
  scale: z.number().min(0.1).max(10).default(1),
  materialId: idSchema.nullable().default(null),
});
export type Furniture = z.infer<typeof furnitureSchema>;

export const groupSchema = z.object({
  ...elementBase,
  type: z.literal('group'),
  childIds: z.array(idSchema).max(2000).default([]),
});
export type Group = z.infer<typeof groupSchema>;

export const importedSchema = z.object({
  ...elementBase,
  type: z.literal('imported'),
  levelId: idSchema.nullable().default(null),
  /** Storage key of the uploaded source file. */
  assetRef: z.string().min(1).max(400),
  sourceFormat: z.enum(['gltf', 'glb', 'obj', 'stl', 'ifc', 'dxf']),
  position: point3Schema.default({ x: 0, y: 0, z: 0 }),
  rotationDeg: angleDeg.default(0),
  scale: z.number().min(0.0001).max(10_000).default(1),
  /** Semantic hint preserved from the source (e.g. IfcWall), when available. */
  semanticTag: z.string().max(120).nullable().default(null),
  /** True when the import is reference-only geometry, not editable elements. */
  referenceOnly: z.boolean().default(true),
});
export type ImportedElement = z.infer<typeof importedSchema>;

export const elementSchema = z.discriminatedUnion('type', [
  wallSchema,
  slabSchema,
  roomSchema,
  openingSchema,
  roofSchema,
  stairSchema,
  columnSchema,
  beamSchema,
  railingSchema,
  furnitureSchema,
  groupSchema,
  importedSchema,
]);
export type ArchElement = z.infer<typeof elementSchema>;

/* ------------------------------------------------------------------ */
/* Environment, views, constraints                                     */
/* ------------------------------------------------------------------ */

export const ENVIRONMENT_PRESETS = [
  'studio',
  'clear-day',
  'overcast',
  'golden-hour',
  'dusk',
  'night',
  'interior',
] as const;

export const artificialLightSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(['point', 'spot', 'rect']),
  position: point3Schema,
  intensity: z.number().min(0).max(100).default(5),
  color: hexColorSchema.default('#ffe7c4'),
  /** Cone angle in degrees, spot lights only. */
  angleDeg: z.number().min(1).max(90).default(45),
  distance: z.number().min(0).max(MAX_DIMENSION_MM).default(0),
  castShadow: z.boolean().default(false),
});
export type ArtificialLight = z.infer<typeof artificialLightSchema>;

export const environmentSchema = z.object({
  preset: z.enum(ENVIRONMENT_PRESETS).default('clear-day'),
  /** Solar azimuth in degrees clockwise from north. */
  sunAzimuthDeg: z.number().finite().min(0).max(360).default(150),
  /** Solar altitude in degrees above the horizon. */
  sunAltitudeDeg: z.number().finite().min(-10).max(90).default(45),
  sunIntensity: z.number().min(0).max(20).default(2.6),
  ambientIntensity: z.number().min(0).max(20).default(0.55),
  skyEnabled: z.boolean().default(true),
  backgroundColor: hexColorSchema.default('#0b0d10'),
  groundColor: hexColorSchema.default('#191c20'),
  shadowsEnabled: z.boolean().default(true),
  exposure: z.number().min(0.1).max(4).default(1),
  weather: z.enum(['clear', 'overcast', 'sunset', 'night']).default('clear'),
  lights: z.array(artificialLightSchema).max(64).default([]),
});
export type EnvironmentSettings = z.infer<typeof environmentSchema>;

export const savedViewSchema = z.object({
  id: idSchema,
  name: nameSchema,
  mode: z.enum(['perspective', 'orthographic']),
  /** Camera position in millimetres. */
  position: point3Schema,
  target: point3Schema,
  zoom: z.number().min(0.001).max(1000).default(1),
  /** Section cut plane elevation, in mm. Null disables sectioning. */
  sectionElevation: z.number().finite().nullable().default(null),
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const constraintSchema = z.object({
  id: idSchema,
  kind: z.enum([
    'preserve-total-height',
    'min-clear-width',
    'max-footprint-area',
    'fixed-dimension',
    'alignment',
    'custom',
  ]),
  description: z.string().min(1).max(400),
  targetIds: z.array(idSchema).max(200).default([]),
  /** Numeric parameter, in millimetres or square millimetres per `kind`. */
  value: z.number().finite().nullable().default(null),
  active: z.boolean().default(true),
});
export type Constraint = z.infer<typeof constraintSchema>;

export const measurementSchema = z.object({
  id: idSchema,
  kind: z.enum(['distance', 'area']),
  label: z.string().max(120).default(''),
  points: z.array(point3Schema).min(2).max(MAX_OUTLINE_POINTS),
  /** Result in mm (distance) or mm² (area). */
  value: z.number().finite(),
});
export type Measurement = z.infer<typeof measurementSchema>;

export const siteSchema = z.object({
  locationLabel: z.string().max(200).default(''),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  /** Rotation of project north from world +Y, in degrees. */
  northAngleDeg: angleDeg.default(0),
  /**
   * Free-text label such as "UK Building Regs Part M". Stored so the AI can
   * name the standard it is reasoning against — never as a compliance claim.
   */
  standardsProfile: z.string().max(200).default(''),
  climateNotes: z.string().max(1000).default(''),
});
export type SiteInfo = z.infer<typeof siteSchema>;

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

export const projectModelSchema = z.object({
  schemaVersion: z.number().int().min(1).max(PROJECT_SCHEMA_VERSION),
  id: idSchema,
  name: nameSchema,
  description: z.string().max(2000).default(''),
  units: z.enum(DISPLAY_UNIT_SYSTEMS).default('metric'),
  site: siteSchema,
  levels: z.array(levelSchema).min(1),
  /** Elements keyed by id. The map is the store; `elementOrder` is the outline. */
  elements: z.record(idSchema, elementSchema),
  /** Stable display order for the hierarchy panel. */
  elementOrder: z.array(idSchema),
  materials: z.record(idSchema, materialSchema),
  environment: environmentSchema,
  views: z.array(savedViewSchema).max(50).default([]),
  constraints: z.array(constraintSchema).max(200).default([]),
  measurements: z.array(measurementSchema).max(200).default([]),
  /** Monotonic counter bumped by every applied transaction. */
  revision: z.number().int().min(0).default(0),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export type ProjectModel = z.infer<typeof projectModelSchema>;

/** Narrowing helpers used throughout the geometry and command layers. */
export function isWall(element: ArchElement | undefined): element is Wall {
  return element?.type === 'wall';
}
export function isOpening(element: ArchElement | undefined): element is Opening {
  return element?.type === 'opening';
}
export function isRoom(element: ArchElement | undefined): element is Room {
  return element?.type === 'room';
}
export function isSlab(element: ArchElement | undefined): element is Slab {
  return element?.type === 'slab';
}

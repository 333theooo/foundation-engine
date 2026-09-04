import { applyTransaction } from '@/domain/commands/transaction';
import { parseCommands } from '@/domain/commands/errors';
import { createEmptyProject } from './factory';
import type { ProjectModel } from './schema';

/**
 * The sample project.
 *
 * Built by running real commands through the real engine rather than by
 * hand-writing a model document. That means the sample can never drift out of
 * sync with the schema, and it doubles as an executable specification of the
 * command language — if `npm run db:seed` produces a valid building, the
 * pipeline works end to end.
 *
 * The design: a 12 × 8 m two-storey house with a gable roof, a glazed south
 * façade, a straight stair, and a furnished ground floor.
 */

const W = 12_000;
const D = 8_000;
const GROUND_HEIGHT = 2_700;
const UPPER_HEIGHT = 2_500;

function commandList(): unknown[] {
  const halfW = W / 2;
  const halfD = D / 2;

  return [
    {
      type: 'set_project_info',
      description: 'Describe the project',
      projectDescription:
        'A two-storey timber-clad house of 12 x 8 metres, arranged around a south-facing living space with bedrooms above.',
      locationLabel: 'Temperate northern European climate (illustrative)',
      northAngleDeg: 0,
      climateNotes:
        'Cool temperate. South elevation glazed for winter solar gain; north elevation kept closed.',
    },
    {
      type: 'update_level',
      description: 'Set the ground floor to 2.7 m',
      levelId: 'lvl_ground',
      name: 'Ground floor',
      height: GROUND_HEIGHT,
      cascade: true,
    },
    {
      type: 'create_level',
      description: 'Add the first floor',
      levelId: 'lvl_first',
      name: 'First floor',
      elevation: GROUND_HEIGHT,
      height: UPPER_HEIGHT,
      index: 1,
    },

    // Ground floor envelope. Walls run anticlockwise from the south-west corner,
    // so each wall's outward normal faces the compass direction in its name.
    {
      type: 'create_wall',
      description: 'South wall',
      elementId: 'wall_g_south',
      name: 'South wall',
      levelId: 'lvl_ground',
      start: { x: -halfW, y: -halfD },
      end: { x: halfW, y: -halfD },
      height: GROUND_HEIGHT,
      thickness: 300,
      materialId: 'mat_timber_dark',
      structural: true,
    },
    {
      type: 'create_wall',
      description: 'East wall',
      elementId: 'wall_g_east',
      name: 'East wall',
      levelId: 'lvl_ground',
      start: { x: halfW, y: -halfD },
      end: { x: halfW, y: halfD },
      height: GROUND_HEIGHT,
      thickness: 300,
      materialId: 'mat_timber_dark',
      structural: true,
    },
    {
      type: 'create_wall',
      description: 'North wall',
      elementId: 'wall_g_north',
      name: 'North wall',
      levelId: 'lvl_ground',
      start: { x: halfW, y: halfD },
      end: { x: -halfW, y: halfD },
      height: GROUND_HEIGHT,
      thickness: 300,
      materialId: 'mat_timber_dark',
      structural: true,
    },
    {
      type: 'create_wall',
      description: 'West wall',
      elementId: 'wall_g_west',
      name: 'West wall',
      levelId: 'lvl_ground',
      start: { x: -halfW, y: halfD },
      end: { x: -halfW, y: -halfD },
      height: GROUND_HEIGHT,
      thickness: 300,
      materialId: 'mat_timber_dark',
      structural: true,
    },
    {
      type: 'create_slab',
      description: 'Ground floor slab',
      elementId: 'slab_ground',
      name: 'Ground floor slab',
      levelId: 'lvl_ground',
      outline: [
        { x: -halfW, y: -halfD },
        { x: halfW, y: -halfD },
        { x: halfW, y: halfD },
        { x: -halfW, y: halfD },
      ],
      thickness: 300,
      materialId: 'mat_screed_grey',
      role: 'floor',
    },

    // Openings.
    {
      type: 'create_opening',
      description: 'Entrance door on the south elevation',
      elementId: 'door_entrance',
      name: 'Entrance door',
      hostId: 'wall_g_south',
      kind: 'door',
      openingType: 'entrance-door',
      distanceAlongWall: 9_800,
      width: 1_100,
      height: 2_200,
      sillHeight: 0,
      frameMaterialId: 'mat_metal_dark',
    },
    {
      type: 'distribute_openings',
      description: 'Three tall windows to the living space',
      hostId: 'wall_g_south',
      count: 3,
      kind: 'window',
      openingType: 'floor-to-ceiling',
      width: 1_600,
      height: 2_300,
      sillHeight: 200,
      edgeMargin: 2_400,
      namePrefix: 'Living window',
    },
    {
      type: 'create_opening',
      description: 'Kitchen window facing west',
      name: 'Kitchen window',
      hostId: 'wall_g_west',
      kind: 'window',
      openingType: 'casement-window',
      distanceAlongWall: 2_600,
      width: 1_400,
      height: 1_300,
      sillHeight: 950,
    },
    {
      type: 'create_opening',
      description: 'Small north window to the utility area',
      name: 'Utility window',
      hostId: 'wall_g_north',
      kind: 'window',
      openingType: 'fixed-window',
      distanceAlongWall: 9_200,
      width: 900,
      height: 900,
      sillHeight: 1_400,
    },

    // Rooms.
    {
      type: 'create_room',
      description: 'Open-plan kitchen and living space',
      elementId: 'room_living',
      name: 'Kitchen / living',
      levelId: 'lvl_ground',
      outline: [
        { x: -halfW + 300, y: -halfD + 300 },
        { x: 2_000, y: -halfD + 300 },
        { x: 2_000, y: halfD - 300 },
        { x: -halfW + 300, y: halfD - 300 },
      ],
      programme: 'living',
      ceilingHeight: GROUND_HEIGHT,
      occupancy: 6,
    },
    {
      type: 'create_room',
      description: 'Entrance hall and stair',
      name: 'Hall',
      levelId: 'lvl_ground',
      outline: [
        { x: 2_000, y: -halfD + 300 },
        { x: halfW - 300, y: -halfD + 300 },
        { x: halfW - 300, y: 1_000 },
        { x: 2_000, y: 1_000 },
      ],
      programme: 'circulation',
      ceilingHeight: GROUND_HEIGHT,
    },
    {
      type: 'create_room',
      description: 'Ground floor shower room',
      name: 'Shower room',
      levelId: 'lvl_ground',
      outline: [
        { x: 2_000, y: 1_000 },
        { x: halfW - 300, y: 1_000 },
        { x: halfW - 300, y: halfD - 300 },
        { x: 2_000, y: halfD - 300 },
      ],
      programme: 'bathroom',
      ceilingHeight: GROUND_HEIGHT,
    },

    // Stair to the first floor.
    {
      type: 'create_stair',
      description: 'Straight stair to the first floor',
      elementId: 'stair_main',
      name: 'Main stair',
      levelId: 'lvl_ground',
      position: { x: 2_600, y: -3_300 },
      rotationDeg: 90,
      width: 1_000,
      totalRise: GROUND_HEIGHT,
      steps: 15,
      treadDepth: 270,
      materialId: 'mat_timber_oak',
    },

    // First floor.
    {
      type: 'create_slab',
      description: 'First floor slab',
      name: 'First floor slab',
      levelId: 'lvl_first',
      outline: [
        { x: -halfW, y: -halfD },
        { x: halfW, y: -halfD },
        { x: halfW, y: halfD },
        { x: -halfW, y: halfD },
      ],
      thickness: 250,
      materialId: 'mat_timber_oak',
      role: 'floor',
    },
    {
      type: 'create_rectangular_footprint',
      description: 'First floor envelope',
      levelId: 'lvl_first',
      centre: { x: 0, y: 0 },
      width: W,
      depth: D,
      height: UPPER_HEIGHT,
      thickness: 300,
      includeSlab: false,
      materialId: 'mat_timber_dark',
      namePrefix: 'First floor wall',
    },
    {
      type: 'create_room',
      description: 'Principal bedroom',
      name: 'Principal bedroom',
      levelId: 'lvl_first',
      outline: [
        { x: -halfW + 300, y: -halfD + 300 },
        { x: -1_500, y: -halfD + 300 },
        { x: -1_500, y: halfD - 300 },
        { x: -halfW + 300, y: halfD - 300 },
      ],
      programme: 'bedroom',
      ceilingHeight: UPPER_HEIGHT,
      occupancy: 2,
    },
    {
      type: 'create_room',
      description: 'Second bedroom',
      name: 'Bedroom 2',
      levelId: 'lvl_first',
      outline: [
        { x: 1_500, y: -halfD + 300 },
        { x: halfW - 300, y: -halfD + 300 },
        { x: halfW - 300, y: 1_200 },
        { x: 1_500, y: 1_200 },
      ],
      programme: 'bedroom',
      ceilingHeight: UPPER_HEIGHT,
      occupancy: 1,
    },
    {
      type: 'create_room',
      description: 'Bathroom',
      name: 'Bathroom',
      levelId: 'lvl_first',
      outline: [
        { x: 1_500, y: 1_200 },
        { x: halfW - 300, y: 1_200 },
        { x: halfW - 300, y: halfD - 300 },
        { x: 1_500, y: halfD - 300 },
      ],
      programme: 'bathroom',
      ceilingHeight: UPPER_HEIGHT,
    },

    // Roof.
    {
      type: 'create_roof',
      description: 'Gable roof over the whole footprint',
      name: 'Gable roof',
      levelId: 'lvl_first',
      kind: 'gable',
      outline: [
        { x: -halfW, y: -halfD },
        { x: halfW, y: -halfD },
        { x: halfW, y: halfD },
        { x: -halfW, y: halfD },
      ],
      baseElevation: GROUND_HEIGHT + UPPER_HEIGHT,
      thickness: 300,
      pitchDeg: 32,
      ridgeAxis: 'x',
      overhang: 500,
      materialId: 'mat_roof_zinc',
    },

    // Furniture and context, so the sample reads at human scale.
    {
      type: 'place_furniture',
      description: 'Sofa',
      catalogId: 'sofa-3seat',
      levelId: 'lvl_ground',
      position: { x: -3_600, y: -1_400 },
      rotationDeg: 0,
    },
    {
      type: 'place_furniture',
      description: 'Coffee table',
      catalogId: 'coffee-table',
      levelId: 'lvl_ground',
      position: { x: -3_600, y: 200 },
      rotationDeg: 0,
    },
    {
      type: 'place_furniture',
      description: 'Dining table',
      catalogId: 'dining-table',
      levelId: 'lvl_ground',
      position: { x: -1_000, y: 2_200 },
      rotationDeg: 0,
    },
    {
      type: 'place_furniture',
      description: 'Kitchen run',
      catalogId: 'kitchen-run',
      levelId: 'lvl_ground',
      position: { x: -4_200, y: 3_300 },
      rotationDeg: 0,
    },
    {
      type: 'place_furniture',
      description: 'Scale figure',
      catalogId: 'person',
      levelId: 'lvl_ground',
      position: { x: 800, y: -2_000 },
      rotationDeg: 0,
    },
    {
      type: 'place_furniture',
      description: 'Bed',
      catalogId: 'bed-double',
      levelId: 'lvl_first',
      position: { x: -4_000, y: 0 },
      rotationDeg: 90,
    },
    {
      type: 'place_furniture',
      description: 'Tree to the south-west',
      catalogId: 'tree-medium',
      levelId: 'lvl_ground',
      position: { x: -9_000, y: -7_000 },
      rotationDeg: 0,
    },

    {
      type: 'add_constraint',
      description: 'Record the brief constraint',
      constraint: {
        kind: 'max-footprint-area',
        description: 'Planning permission caps the footprint at 100 m².',
        value: 100_000_000,
      },
    },
    {
      type: 'update_environment',
      description: 'Set an overcast afternoon',
      preset: 'overcast',
      sunAzimuthDeg: 215,
    },
    {
      type: 'save_view',
      description: 'Save the south-west approach view',
      viewId: 'view_approach',
      name: 'South-west approach',
      mode: 'perspective',
      position: { x: -22_000, y: 9_000, z: -20_000 },
      target: { x: 0, y: 2_500, z: 0 },
      zoom: 1,
    },
  ];
}

export class SampleProjectError extends Error {}

/**
 * Builds the sample project. Throws if any command fails — a broken sample is a
 * bug in the engine, and failing loudly at seed time is how we find out.
 */
export function buildSampleProject(options: { name?: string } = {}): ProjectModel {
  const base = createEmptyProject({
    name: options.name ?? 'Lakeside Studio',
    description: 'Sample project: a two-storey house of 12 x 8 metres.',
  });

  const { commands, issues } = parseCommands(commandList(), { maxCommands: 200 });
  if (issues.length > 0) {
    throw new SampleProjectError(
      `Sample project commands failed validation: ${issues.map((i) => `${i.path ?? ''} ${i.message}`).join('; ')}`,
    );
  }

  const result = applyTransaction(base, commands, { source: 'template', maxNewElements: 300 });
  if (!result.ok) {
    throw new SampleProjectError(
      `Sample project could not be built: ${result.issues.map((i) => i.message).join('; ')}`,
    );
  }

  return { ...result.model, revision: 0 };
}

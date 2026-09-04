/**
 * Hard numeric limits for the project model.
 *
 * These are not style preferences — they are the guard rails that stop a
 * malformed AI response, a corrupt import, or a fat-fingered inspector value
 * from producing NaN geometry, a 40 GB buffer, or coordinates so large that
 * float32 precision in the GPU pipeline collapses.
 */

/** Furthest a point may sit from the project origin: 10 km in millimetres. */
export const MAX_COORDINATE_MM = 10_000_000;

/** Longest single dimension (wall length, slab side): 1 km. */
export const MAX_DIMENSION_MM = 1_000_000;

/** Thinnest meaningful element. Below this the geometry is z-fighting noise. */
export const MIN_THICKNESS_MM = 1;

/** Thickest element we will generate. */
export const MAX_THICKNESS_MM = 5_000;

/** Storey height bounds — 1.2 m crawlspace to a 30 m atrium. */
export const MIN_LEVEL_HEIGHT_MM = 1_200;
export const MAX_LEVEL_HEIGHT_MM = 30_000;

/** Elements per project. Beyond this the viewport stops being interactive. */
export const MAX_ELEMENTS = 5_000;

/** Elements a single AI turn may add. Stops runaway generation loops. */
export const MAX_ELEMENTS_PER_TURN = 400;

/** Commands a single transaction may contain. */
export const MAX_COMMANDS_PER_TRANSACTION = 300;

/** Vertices in a slab/room/roof outline. */
export const MAX_OUTLINE_POINTS = 200;

/** Steps in one stair flight. */
export const MAX_STAIR_STEPS = 60;

/** Array/duplicate command instance cap. */
export const MAX_ARRAY_COUNT = 200;

/** Upload ceiling for imported models, in bytes. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Upload ceiling for knowledge documents, in bytes. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Levels per project. */
export const MAX_LEVELS = 60;

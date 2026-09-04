import { z } from 'zod';
import { defaultEnvironment, defaultViews } from './factory';
import { defaultMaterialMap } from './materials';
import { PROJECT_SCHEMA_VERSION, projectModelSchema, type ProjectModel } from './schema';

/**
 * Forward-only project migrations.
 *
 * A saved project must always reload into exactly the geometry it was saved
 * with, including projects written by an older build. Each step upgrades by
 * one version and is individually unit-tested; `migrateProject` chains them.
 *
 * Rules for adding a step:
 *   1. Bump PROJECT_SCHEMA_VERSION in schema.ts.
 *   2. Add a `MIGRATIONS[n]` that takes version n and returns version n + 1.
 *   3. Never mutate the input. Never delete data you cannot reconstruct.
 */

type UnknownRecord = Record<string, unknown>;

const MIGRATIONS: Record<number, (input: UnknownRecord) => UnknownRecord> = {
  /** v1 -> v2: site metadata and constraints became first-class. */
  1: (input) => ({
    ...input,
    schemaVersion: 2,
    site: (input.site as UnknownRecord | undefined) ?? {
      locationLabel: '',
      latitude: null,
      longitude: null,
      northAngleDeg: 0,
      standardsProfile: '',
      climateNotes: '',
    },
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    measurements: Array.isArray(input.measurements) ? input.measurements : [],
  }),

  /**
   * v2 -> v3: `views` moved from a keyed record to an ordered array, and
   * environment gained explicit artificial lights.
   */
  2: (input) => {
    const rawViews = input.views;
    const views = Array.isArray(rawViews)
      ? rawViews
      : rawViews && typeof rawViews === 'object'
        ? Object.values(rawViews as UnknownRecord)
        : defaultViews();
    const env = (input.environment as UnknownRecord | undefined) ?? {};
    return {
      ...input,
      schemaVersion: 3,
      views,
      environment: {
        ...defaultEnvironment(),
        ...env,
        lights: Array.isArray(env.lights) ? env.lights : [],
      },
    };
  },
};

export class ProjectMigrationError extends Error {
  constructor(
    message: string,
    readonly issues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ProjectMigrationError';
  }
}

export interface MigrationResult {
  model: ProjectModel;
  /** Versions the document passed through, e.g. `[1, 2, 3]`. */
  path: number[];
  /** Non-fatal repairs applied while loading. */
  warnings: string[];
}

/**
 * Loads an arbitrary persisted document into a validated current-version model.
 * Throws `ProjectMigrationError` if the document cannot be repaired — callers
 * surface that as "this project file could not be opened", never as a crash.
 */
export function migrateProject(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectMigrationError('Project document is not an object.');
  }

  let doc = { ...(raw as UnknownRecord) };
  const warnings: string[] = [];
  const path: number[] = [];

  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
  if (typeof doc.schemaVersion !== 'number') {
    warnings.push('Document had no schemaVersion; assumed version 1.');
    doc.schemaVersion = 1;
  }
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectMigrationError(
      `Project was written by a newer version of the application (schema ${version}, this build supports ${PROJECT_SCHEMA_VERSION}).`,
    );
  }

  path.push(version);
  while (version < PROJECT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new ProjectMigrationError(`No migration registered from schema version ${version}.`);
    }
    doc = step(doc);
    version += 1;
    path.push(version);
  }

  // Backfill anything a very old or hand-edited document may be missing before
  // strict validation, so a recoverable file is recovered rather than rejected.
  if (!doc.materials || typeof doc.materials !== 'object') {
    doc.materials = defaultMaterialMap();
    warnings.push('Material library was missing; restored the default library.');
  }
  if (!Array.isArray(doc.views) || doc.views.length === 0) {
    doc.views = defaultViews();
  }
  if (!doc.environment) doc.environment = defaultEnvironment();
  if (!Array.isArray(doc.elementOrder)) {
    doc.elementOrder = Object.keys((doc.elements as UnknownRecord) ?? {});
    warnings.push('Element order was missing; rebuilt from the element map.');
  }

  const parsed = projectModelSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ProjectMigrationError(
      `Project failed validation after migration: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      parsed.error.issues,
    );
  }

  const model = parsed.data;

  // Repair referential integrity that the schema alone cannot express.
  const known = new Set(Object.keys(model.elements));
  const orderSet = new Set(model.elementOrder);
  const missingFromOrder = [...known].filter((id) => !orderSet.has(id));
  if (missingFromOrder.length > 0) {
    model.elementOrder = [...model.elementOrder, ...missingFromOrder];
    warnings.push(`${missingFromOrder.length} element(s) were missing from the hierarchy order.`);
  }
  const staleOrder = model.elementOrder.filter((id) => !known.has(id));
  if (staleOrder.length > 0) {
    model.elementOrder = model.elementOrder.filter((id) => known.has(id));
    warnings.push(`${staleOrder.length} stale hierarchy entr(ies) were removed.`);
  }

  // Orphaned openings would render as floating frames; drop them loudly.
  const orphanOpenings = Object.values(model.elements).filter(
    (element) => element.type === 'opening' && !known.has(element.hostId),
  );
  for (const orphan of orphanOpenings) {
    delete model.elements[orphan.id];
    model.elementOrder = model.elementOrder.filter((id) => id !== orphan.id);
    warnings.push(`Opening "${orphan.name}" lost its host wall and was removed.`);
  }

  return { model, path, warnings };
}

/** Serializes a model to the canonical on-disk / on-wire JSON shape. */
export function serializeProject(model: ProjectModel): string {
  return JSON.stringify({ ...model, schemaVersion: PROJECT_SCHEMA_VERSION }, null, 2);
}

export function deserializeProject(json: string): MigrationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ProjectMigrationError(
      `Project file is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  return migrateProject(parsed);
}

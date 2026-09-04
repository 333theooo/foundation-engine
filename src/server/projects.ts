import { prisma } from '@/server/db';
import { logger } from '@/server/logger';
import type { SessionUser } from '@/server/auth/session';
import {
  PROJECT_SCHEMA_VERSION,
  createEmptyProject,
  migrateProject,
  projectModelSchema,
  type ProjectModel,
} from '@/domain/project';
import { buildSampleProject } from '@/domain/project/sample';

/**
 * Project persistence.
 *
 * Every function here takes the *session user*, never a caller-supplied owner
 * id, and every read is scoped by `ownerId`. There is no "get project by id"
 * that skips the ownership predicate, because the moment such a function exists
 * somebody eventually calls it from a route handler.
 */

export class ProjectAccessError extends Error {
  constructor(
    message: string,
    readonly status: number = 404,
  ) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  elementCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord extends ProjectSummary {
  model: ProjectModel;
  /** Non-fatal repairs applied while loading, surfaced in the UI. */
  loadWarnings: string[];
}

function summarise(row: {
  id: string;
  name: string;
  description: string;
  elementCount: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    elementCount: row.elementCount,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProjects(
  user: SessionUser,
  options: { includeArchived?: boolean } = {},
): Promise<ProjectSummary[]> {
  const rows = await prisma.project.findMany({
    where: {
      ownerId: user.id,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      elementCount: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map(summarise);
}

export type ProjectTemplate = 'empty' | 'sample';

export async function createProject(
  user: SessionUser,
  input: { name?: string; description?: string; template?: ProjectTemplate } = {},
): Promise<ProjectRecord> {
  const template = input.template ?? 'empty';
  const model =
    template === 'sample'
      ? buildSampleProject({ name: input.name ?? 'Lakeside Studio' })
      : createEmptyProject({ name: input.name ?? 'Untitled project' });

  if (input.description) model.description = input.description;

  const row = await prisma.project.create({
    data: {
      ownerId: user.id,
      name: model.name,
      description: model.description,
      model: model as unknown as object,
      elementCount: Object.keys(model.elements).length,
      schemaVersion: PROJECT_SCHEMA_VERSION,
    },
  });

  await prisma.conversation.create({ data: { projectId: row.id } });
  await prisma.projectVersion.create({
    data: {
      projectId: row.id,
      label: template === 'sample' ? 'Sample project' : 'Created',
      kind: 'MANUAL',
      model: model as unknown as object,
      revision: model.revision,
    },
  });

  logger().info({ projectId: row.id, userId: user.id, template }, 'project created');
  return { ...summarise(row), model, loadWarnings: [] };
}

/** Loads a project the user owns, migrating the stored document if needed. */
export async function getProject(user: SessionUser, projectId: string): Promise<ProjectRecord> {
  const row = await prisma.project.findFirst({
    where: { id: projectId, ownerId: user.id },
  });
  if (!row) throw new ProjectAccessError('Project not found.', 404);

  const { model, warnings } = migrateProject(row.model);

  // Persist the migration so the next load is cheap and the DB reflects reality.
  if (row.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    await prisma.project
      .update({
        where: { id: row.id },
        data: { model: model as unknown as object, schemaVersion: PROJECT_SCHEMA_VERSION },
      })
      .catch((error) => logger().warn({ err: error, projectId }, 'failed to persist migration'));
  }

  return { ...summarise(row), model, loadWarnings: warnings };
}

export interface SaveOptions {
  /** Records a named restore point alongside the save. */
  versionLabel?: string;
  versionKind?: 'AUTOSAVE' | 'MANUAL' | 'SNAPSHOT' | 'IMPORT' | 'RESTORE_POINT';
}

/**
 * Writes a new model.
 *
 * Validates before writing: an autosave must never be able to persist a
 * document that will not load again. Autosave versions are capped so the table
 * does not grow without bound.
 */
export async function saveProjectModel(
  user: SessionUser,
  projectId: string,
  model: ProjectModel,
  options: SaveOptions = {},
): Promise<ProjectSummary> {
  const parsed = projectModelSchema.safeParse(model);
  if (!parsed.success) {
    throw new ProjectAccessError(
      `Refusing to save an invalid project: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
      400,
    );
  }
  const valid = parsed.data;

  const existing = await prisma.project.findFirst({
    where: { id: projectId, ownerId: user.id },
    select: { id: true },
  });
  if (!existing) throw new ProjectAccessError('Project not found.', 404);

  const row = await prisma.project.update({
    where: { id: projectId },
    data: {
      name: valid.name,
      description: valid.description,
      model: valid as unknown as object,
      elementCount: Object.keys(valid.elements).length,
      schemaVersion: PROJECT_SCHEMA_VERSION,
    },
  });

  if (options.versionLabel) {
    await prisma.projectVersion.create({
      data: {
        projectId,
        label: options.versionLabel.slice(0, 120),
        kind: options.versionKind ?? 'MANUAL',
        model: valid as unknown as object,
        revision: valid.revision,
      },
    });
    if ((options.versionKind ?? 'MANUAL') === 'AUTOSAVE') await pruneAutosaves(projectId);
  }

  return summarise(row);
}

/** Keeps the most recent 20 autosaves; named versions are never pruned. */
async function pruneAutosaves(projectId: string): Promise<void> {
  const keep = await prisma.projectVersion.findMany({
    where: { projectId, kind: 'AUTOSAVE' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true },
  });
  await prisma.projectVersion.deleteMany({
    where: { projectId, kind: 'AUTOSAVE', id: { notIn: keep.map((k) => k.id) } },
  });
}

export async function renameProject(
  user: SessionUser,
  projectId: string,
  name: string,
): Promise<ProjectSummary> {
  const record = await getProject(user, projectId);
  const model = { ...record.model, name: name.slice(0, 120) };
  await saveProjectModel(user, projectId, model);
  const row = await prisma.project.update({ where: { id: projectId }, data: { name: model.name } });
  return summarise(row);
}

export async function duplicateProject(
  user: SessionUser,
  projectId: string,
): Promise<ProjectSummary> {
  const record = await getProject(user, projectId);
  const copy: ProjectModel = {
    ...structuredClone(record.model),
    name: `${record.name} copy`,
    revision: 0,
  };
  const row = await prisma.project.create({
    data: {
      ownerId: user.id,
      name: copy.name,
      description: copy.description,
      model: copy as unknown as object,
      elementCount: Object.keys(copy.elements).length,
      schemaVersion: PROJECT_SCHEMA_VERSION,
    },
  });
  await prisma.conversation.create({ data: { projectId: row.id } });
  return summarise(row);
}

export async function setArchived(
  user: SessionUser,
  projectId: string,
  archived: boolean,
): Promise<ProjectSummary> {
  const owned = await prisma.project.findFirst({
    where: { id: projectId, ownerId: user.id },
    select: { id: true },
  });
  if (!owned) throw new ProjectAccessError('Project not found.', 404);
  const row = await prisma.project.update({
    where: { id: projectId },
    data: { archivedAt: archived ? new Date() : null },
  });
  return summarise(row);
}

export async function deleteProject(user: SessionUser, projectId: string): Promise<void> {
  const result = await prisma.project.deleteMany({ where: { id: projectId, ownerId: user.id } });
  if (result.count === 0) throw new ProjectAccessError('Project not found.', 404);
  logger().info({ projectId, userId: user.id }, 'project deleted');
}

export interface VersionSummary {
  id: string;
  label: string;
  kind: string;
  revision: number;
  createdAt: string;
}

export async function listVersions(
  user: SessionUser,
  projectId: string,
): Promise<VersionSummary[]> {
  const owned = await prisma.project.findFirst({
    where: { id: projectId, ownerId: user.id },
    select: { id: true },
  });
  if (!owned) throw new ProjectAccessError('Project not found.', 404);

  const rows = await prisma.projectVersion.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, label: true, kind: true, revision: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createVersion(
  user: SessionUser,
  projectId: string,
  label: string,
  kind: SaveOptions['versionKind'] = 'MANUAL',
): Promise<VersionSummary> {
  const record = await getProject(user, projectId);
  const row = await prisma.projectVersion.create({
    data: {
      projectId,
      label: label.slice(0, 120),
      kind: kind ?? 'MANUAL',
      model: record.model as unknown as object,
      revision: record.model.revision,
    },
  });
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Restores a version. The current state is snapshotted first, so restoring is
 * itself undoable — a restore that turns out to be wrong is not a dead end.
 */
export async function restoreVersion(
  user: SessionUser,
  projectId: string,
  versionId: string,
): Promise<ProjectRecord> {
  const owned = await prisma.project.findFirst({
    where: { id: projectId, ownerId: user.id },
    select: { id: true },
  });
  if (!owned) throw new ProjectAccessError('Project not found.', 404);

  const version = await prisma.projectVersion.findFirst({ where: { id: versionId, projectId } });
  if (!version) throw new ProjectAccessError('Version not found.', 404);

  await createVersion(user, projectId, `Before restoring "${version.label}"`, 'RESTORE_POINT');

  const { model, warnings } = migrateProject(version.model);
  const restored: ProjectModel = { ...model, revision: model.revision + 1 };
  const summary = await saveProjectModel(user, projectId, restored);

  logger().info({ projectId, versionId }, 'project version restored');
  return { ...summary, model: restored, loadWarnings: warnings };
}

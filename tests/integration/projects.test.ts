import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProjectAccessError,
  createProject,
  createVersion,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  listVersions,
  renameProject,
  restoreVersion,
  saveProjectModel,
  setArchived,
} from '@/server/projects';
import { applyTransaction, parseCommands } from '@/domain/commands';
import { elementsOfType } from '@/domain/project/queries';
import type { SessionUser } from '@/server/auth/session';
import type { ProjectModel } from '@/domain/project/schema';
import { disconnectTestDb, makeUser, removeUser, testDb } from './helpers';

let alice: SessionUser;
let mallory: SessionUser;

beforeAll(async () => {
  alice = await makeUser('alice');
  mallory = await makeUser('mallory');
});

afterAll(async () => {
  await removeUser(alice);
  await removeUser(mallory);
  await disconnectTestDb();
});

function edit(model: ProjectModel, commands: unknown[]): ProjectModel {
  const parsed = parseCommands(commands);
  expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const result = applyTransaction(model, parsed.commands, { source: 'user' });
  expect(result.rolledBack).toBe(false);
  return result.model;
}

describe('project lifecycle', () => {
  it('creates an empty project with a conversation and an initial version', async () => {
    const project = await createProject(alice, { name: 'Empty test' });
    expect(project.model.levels).toHaveLength(1);
    expect(project.elementCount).toBe(0);

    const conversation = await testDb().conversation.findFirst({
      where: { projectId: project.id },
    });
    expect(conversation).not.toBeNull();

    const versions = await listVersions(alice, project.id);
    expect(versions).toHaveLength(1);
  });

  it('creates the sample project with real geometry', async () => {
    const project = await createProject(alice, { template: 'sample' });
    expect(project.elementCount).toBeGreaterThan(20);
    expect(elementsOfType(project.model, 'wall').length).toBeGreaterThan(4);
    expect(elementsOfType(project.model, 'roof')).toHaveLength(1);
  });

  it('saves and reloads a model without losing geometry', async () => {
    const project = await createProject(alice, { name: 'Save test' });
    const edited = edit(project.model, [
      { type: 'create_rectangular_footprint', width: 12_000, depth: 8_000 },
      {
        type: 'create_wall',
        elementId: 'wall_internal',
        start: { x: 0, y: -4000 },
        end: { x: 0, y: 4000 },
        thickness: 120,
      },
    ]);

    await saveProjectModel(alice, project.id, edited);
    const reloaded = await getProject(alice, project.id);

    expect(reloaded.model.elementOrder).toEqual(edited.elementOrder);
    for (const id of edited.elementOrder) {
      expect(reloaded.model.elements[id]).toEqual(edited.elements[id]);
    }
    expect(reloaded.elementCount).toBe(Object.keys(edited.elements).length);
    expect(reloaded.loadWarnings).toEqual([]);
  });

  it('refuses to save a model that would not load again', async () => {
    const project = await createProject(alice, { name: 'Invalid save' });
    const broken = { ...project.model, levels: [] } as unknown as ProjectModel;
    await expect(saveProjectModel(alice, project.id, broken)).rejects.toThrow(ProjectAccessError);

    // The stored project is untouched.
    const reloaded = await getProject(alice, project.id);
    expect(reloaded.model.levels).toHaveLength(1);
  });

  it('renames, duplicates, archives and deletes', async () => {
    const project = await createProject(alice, { name: 'Lifecycle' });

    await renameProject(alice, project.id, 'Renamed');
    expect((await getProject(alice, project.id)).name).toBe('Renamed');
    // The rename lands in the model too, so an export carries it.
    expect((await getProject(alice, project.id)).model.name).toBe('Renamed');

    const copy = await duplicateProject(alice, project.id);
    expect(copy.name).toBe('Renamed copy');
    expect(copy.id).not.toBe(project.id);

    await setArchived(alice, project.id, true);
    const active = await listProjects(alice);
    expect(active.map((p) => p.id)).not.toContain(project.id);
    const all = await listProjects(alice, { includeArchived: true });
    expect(all.map((p) => p.id)).toContain(project.id);

    await setArchived(alice, project.id, false);
    expect((await listProjects(alice)).map((p) => p.id)).toContain(project.id);

    await deleteProject(alice, project.id);
    await expect(getProject(alice, project.id)).rejects.toThrow(ProjectAccessError);
  });

  it('cascades deletes to versions and conversations', async () => {
    const project = await createProject(alice, { name: 'Cascade' });
    await createVersion(alice, project.id, 'A version');
    await deleteProject(alice, project.id);

    expect(await testDb().projectVersion.count({ where: { projectId: project.id } })).toBe(0);
    expect(await testDb().conversation.count({ where: { projectId: project.id } })).toBe(0);
  });
});

describe('ownership boundaries', () => {
  it('hides one user’s projects from another', async () => {
    const project = await createProject(alice, { name: 'Private' });
    const malloryProjects = await listProjects(mallory);
    expect(malloryProjects.map((p) => p.id)).not.toContain(project.id);
  });

  it('refuses a read by a non-owner, with the same error as a missing project', async () => {
    const project = await createProject(alice, { name: 'Private read' });
    await expect(getProject(mallory, project.id)).rejects.toThrow(ProjectAccessError);
    await expect(getProject(mallory, 'does-not-exist')).rejects.toThrow(ProjectAccessError);

    // Both are 404, so the endpoint is not an existence oracle.
    const owned = await getProject(mallory, project.id).catch((error) => error);
    const missing = await getProject(mallory, 'does-not-exist').catch((error) => error);
    expect((owned as ProjectAccessError).status).toBe((missing as ProjectAccessError).status);
  });

  it('refuses a write by a non-owner and leaves the project unchanged', async () => {
    const project = await createProject(alice, { name: 'Private write' });
    const tampered = edit(project.model, [
      { type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 5000, y: 0 } },
    ]);

    await expect(saveProjectModel(mallory, project.id, tampered)).rejects.toThrow(
      ProjectAccessError,
    );
    const reloaded = await getProject(alice, project.id);
    expect(Object.keys(reloaded.model.elements)).toHaveLength(0);
  });

  it('refuses rename, duplicate, archive and delete by a non-owner', async () => {
    const project = await createProject(alice, { name: 'Guarded' });
    await expect(renameProject(mallory, project.id, 'Hijacked')).rejects.toThrow(
      ProjectAccessError,
    );
    await expect(duplicateProject(mallory, project.id)).rejects.toThrow(ProjectAccessError);
    await expect(setArchived(mallory, project.id, true)).rejects.toThrow(ProjectAccessError);
    await expect(deleteProject(mallory, project.id)).rejects.toThrow(ProjectAccessError);

    expect((await getProject(alice, project.id)).name).toBe('Guarded');
  });

  it('refuses version listing and restore by a non-owner', async () => {
    const project = await createProject(alice, { name: 'Versioned' });
    const version = await createVersion(alice, project.id, 'Checkpoint');
    await expect(listVersions(mallory, project.id)).rejects.toThrow(ProjectAccessError);
    await expect(restoreVersion(mallory, project.id, version.id)).rejects.toThrow(
      ProjectAccessError,
    );
  });

  it('deletes everything a user owns when the account goes', async () => {
    const temporary = await makeUser('temporary');
    const project = await createProject(temporary, { template: 'sample' });
    await createVersion(temporary, project.id, 'Checkpoint');

    await removeUser(temporary);

    expect(await testDb().project.count({ where: { id: project.id } })).toBe(0);
    expect(await testDb().projectVersion.count({ where: { projectId: project.id } })).toBe(0);
  });
});

describe('versions', () => {
  it('restores a previous state and keeps the restore itself reversible', async () => {
    const project = await createProject(alice, { name: 'Restore test' });

    const withWalls = edit(project.model, [
      { type: 'create_rectangular_footprint', width: 10_000, depth: 8_000 },
    ]);
    await saveProjectModel(alice, project.id, withWalls);
    const checkpoint = await createVersion(alice, project.id, 'Four walls');

    const withMore = edit(withWalls, [
      { type: 'create_column', position: { x: 0, y: 0 } },
      { type: 'create_column', position: { x: 2000, y: 0 } },
    ]);
    await saveProjectModel(alice, project.id, withMore);
    expect(elementsOfType((await getProject(alice, project.id)).model, 'column')).toHaveLength(2);

    const restored = await restoreVersion(alice, project.id, checkpoint.id);
    expect(elementsOfType(restored.model, 'column')).toHaveLength(0);
    expect(elementsOfType(restored.model, 'wall')).toHaveLength(4);

    // A restore point was written first, so the restore can itself be undone.
    const versions = await listVersions(alice, project.id);
    const restorePoint = versions.find((version) => version.kind === 'RESTORE_POINT');
    expect(restorePoint).toBeDefined();

    const back = await restoreVersion(alice, project.id, restorePoint!.id);
    expect(elementsOfType(back.model, 'column')).toHaveLength(2);
  });

  it('caps autosave versions but keeps named ones', async () => {
    const project = await createProject(alice, { name: 'Autosave cap' });
    let model = project.model;

    for (let i = 0; i < 25; i += 1) {
      model = edit(model, [
        { type: 'create_column', position: { x: i * 1000, y: 0 }, name: `Column ${i}` },
      ]);
      await saveProjectModel(alice, project.id, model, {
        versionLabel: `Autosave ${i}`,
        versionKind: 'AUTOSAVE',
      });
    }
    await createVersion(alice, project.id, 'Keep me forever');

    const versions = await listVersions(alice, project.id);
    const autosaves = versions.filter((version) => version.kind === 'AUTOSAVE');
    expect(autosaves.length).toBeLessThanOrEqual(20);
    expect(versions.some((version) => version.label === 'Keep me forever')).toBe(true);
  });

  it('refuses to restore a version from another project', async () => {
    const one = await createProject(alice, { name: 'Project one' });
    const two = await createProject(alice, { name: 'Project two' });
    const version = await createVersion(alice, one.id, 'One checkpoint');
    await expect(restoreVersion(alice, two.id, version.id)).rejects.toThrow(ProjectAccessError);
  });
});

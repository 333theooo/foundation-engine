import { describe, expect, it } from 'vitest';
import {
  PROJECT_SCHEMA_VERSION,
  ProjectMigrationError,
  createEmptyProject,
  deserializeProject,
  migrateProject,
  serializeProject,
} from '@/domain/project';
import { buildSampleProject } from '@/domain/project/sample';
import { applyTransaction, parseCommands } from '@/domain/commands';

describe('serialization', () => {
  it('round-trips an empty project unchanged', () => {
    const model = createEmptyProject({ name: 'Round trip' });
    const { model: restored, warnings } = deserializeProject(serializeProject(model));
    expect(warnings).toEqual([]);
    expect(restored).toEqual(model);
  });

  it('round-trips the sample project with identical geometry inputs', () => {
    const model = buildSampleProject();
    const { model: restored } = deserializeProject(serializeProject(model));
    expect(restored.elementOrder).toEqual(model.elementOrder);
    for (const id of model.elementOrder) {
      expect(restored.elements[id]).toEqual(model.elements[id]);
    }
    expect(restored.levels).toEqual(model.levels);
    expect(restored.materials).toEqual(model.materials);
    expect(restored.environment).toEqual(model.environment);
  });

  it('survives a save-edit-save cycle', () => {
    const model = buildSampleProject();
    const parsed = parseCommands([
      { type: 'update_level', levelId: 'lvl_ground', height: 3000, cascade: true },
    ]);
    const edited = applyTransaction(model, parsed.commands, { source: 'user' });
    const { model: restored } = deserializeProject(serializeProject(edited.model));
    expect(restored.levels.find((level) => level.id === 'lvl_ground')?.height).toBe(3000);
    expect(restored.revision).toBe(edited.model.revision);
  });

  it('rejects text that is not JSON', () => {
    expect(() => deserializeProject('{ not json')).toThrow(ProjectMigrationError);
  });

  it('rejects a document that is not an object', () => {
    expect(() => migrateProject([1, 2, 3])).toThrow(ProjectMigrationError);
    expect(() => migrateProject(null)).toThrow(ProjectMigrationError);
  });

  it('refuses a project written by a newer build', () => {
    const model = createEmptyProject();
    const future = { ...model, schemaVersion: PROJECT_SCHEMA_VERSION + 5 };
    expect(() => migrateProject(future)).toThrow(/newer version/);
  });
});

describe('migrations', () => {
  /** A minimal version-1 document, as an early build would have written it. */
  function legacyV1() {
    return {
      schemaVersion: 1,
      id: 'proj_legacy',
      name: 'Legacy project',
      description: '',
      units: 'metric',
      levels: [
        {
          id: 'lvl_ground',
          name: 'Ground floor',
          elevation: 0,
          height: 3000,
          index: 0,
          visible: true,
        },
      ],
      elements: {
        wall_a: {
          id: 'wall_a',
          type: 'wall',
          name: 'Wall',
          visible: true,
          locked: false,
          origin: 'user',
          parentId: null,
          tags: [],
          notes: '',
          levelId: 'lvl_ground',
          start: { x: 0, y: 0 },
          end: { x: 6000, y: 0 },
          height: 2700,
          thickness: 300,
          alignment: 'center',
          baseOffset: 0,
          materialId: 'mat_plaster_white',
          structural: false,
          exterior: true,
        },
      },
      elementOrder: ['wall_a'],
      materials: {
        mat_plaster_white: {
          id: 'mat_plaster_white',
          name: 'White plaster',
          category: 'wall',
          color: '#eceae5',
          roughness: 0.9,
          metalness: 0,
          opacity: 1,
          textureRef: null,
          textureScaleMm: 1000,
          emissiveIntensity: 0,
          description: '',
        },
      },
      environment: {
        preset: 'clear-day',
        sunAzimuthDeg: 150,
        sunAltitudeDeg: 45,
        sunIntensity: 2.6,
        ambientIntensity: 0.5,
        skyEnabled: true,
        backgroundColor: '#0b0d10',
        groundColor: '#191c20',
        shadowsEnabled: true,
        exposure: 1,
        weather: 'clear',
      },
      // v1 stored views as a keyed record.
      views: {
        view_default: {
          id: 'view_default',
          name: 'Default',
          mode: 'perspective',
          position: { x: 10_000, y: 8_000, z: 10_000 },
          target: { x: 0, y: 0, z: 0 },
          zoom: 1,
          sectionElevation: null,
        },
      },
      revision: 4,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('migrates a version-1 document to the current schema', () => {
    const { model, path, warnings } = migrateProject(legacyV1());
    expect(path[0]).toBe(1);
    expect(path[path.length - 1]).toBe(PROJECT_SCHEMA_VERSION);
    expect(model.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warnings).toEqual([]);
  });

  it('preserves geometry exactly through migration', () => {
    const { model } = migrateProject(legacyV1());
    expect(model.elements.wall_a).toMatchObject({
      start: { x: 0, y: 0 },
      end: { x: 6000, y: 0 },
      height: 2700,
      thickness: 300,
    });
    expect(model.revision).toBe(4);
  });

  it('converts the v2 views record into an ordered array', () => {
    const { model } = migrateProject(legacyV1());
    expect(Array.isArray(model.views)).toBe(true);
    expect(model.views[0]?.id).toBe('view_default');
  });

  it('backfills site metadata and constraints introduced in v2', () => {
    const { model } = migrateProject(legacyV1());
    expect(model.site).toMatchObject({ northAngleDeg: 0, standardsProfile: '' });
    expect(model.constraints).toEqual([]);
    expect(model.measurements).toEqual([]);
  });

  it('backfills lights introduced in v3', () => {
    const { model } = migrateProject(legacyV1());
    expect(model.environment.lights).toEqual([]);
  });

  it('assumes version 1 when the document has no schemaVersion', () => {
    const document = legacyV1() as Record<string, unknown>;
    delete document.schemaVersion;
    const { model, warnings } = migrateProject(document);
    expect(model.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warnings.some((warning) => warning.includes('no schemaVersion'))).toBe(true);
  });
});

describe('repair on load', () => {
  it('rebuilds a missing element order', () => {
    const model = createEmptyProject();
    model.elements.wall_a = {
      id: 'wall_a',
      type: 'wall',
      name: 'Wall',
      visible: true,
      locked: false,
      origin: 'user',
      parentId: null,
      tags: [],
      notes: '',
      levelId: 'lvl_ground',
      start: { x: 0, y: 0 },
      end: { x: 6000, y: 0 },
      height: 2700,
      thickness: 300,
      alignment: 'center',
      baseOffset: 0,
      materialId: 'mat_plaster_white',
      structural: false,
      exterior: true,
    };
    const document = { ...model, elementOrder: undefined } as unknown;
    const { model: repaired, warnings } = migrateProject(document);
    expect(repaired.elementOrder).toContain('wall_a');
    expect(warnings.some((warning) => warning.includes('order'))).toBe(true);
  });

  it('drops stale hierarchy entries', () => {
    const model = createEmptyProject();
    const { model: repaired, warnings } = migrateProject({
      ...model,
      elementOrder: ['ghost_element'],
    });
    expect(repaired.elementOrder).toEqual([]);
    expect(warnings.some((warning) => warning.includes('stale'))).toBe(true);
  });

  it('removes an opening whose host has gone, rather than rendering it floating', () => {
    const model = createEmptyProject();
    const orphan = {
      id: 'open_orphan',
      type: 'opening' as const,
      name: 'Orphan window',
      visible: true,
      locked: false,
      origin: 'user' as const,
      parentId: null,
      tags: [],
      notes: '',
      kind: 'window' as const,
      openingType: 'fixed-window' as const,
      hostId: 'wall_gone',
      distanceAlongWall: 1000,
      width: 1200,
      height: 1400,
      sillHeight: 900,
      frameMaterialId: null,
      glazingMaterialId: null,
      frameDepth: 60,
    };
    const { model: repaired, warnings } = migrateProject({
      ...model,
      elements: { open_orphan: orphan },
      elementOrder: ['open_orphan'],
    });
    expect(repaired.elements.open_orphan).toBeUndefined();
    expect(warnings.some((warning) => warning.includes('lost its host wall'))).toBe(true);
  });

  it('restores a missing material library', () => {
    const model = createEmptyProject();
    const { model: repaired, warnings } = migrateProject({ ...model, materials: undefined });
    expect(Object.keys(repaired.materials).length).toBeGreaterThan(5);
    expect(warnings.some((warning) => warning.includes('Material library'))).toBe(true);
  });

  it('reports a document that cannot be repaired', () => {
    const model = createEmptyProject();
    expect(() => migrateProject({ ...model, levels: [] })).toThrow(/failed validation/);
  });
});

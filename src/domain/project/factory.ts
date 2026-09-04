import type { DisplayUnitSystem } from '@/domain/units';
import { createId } from './ids';
import { defaultMaterialMap } from './materials';
import {
  PROJECT_SCHEMA_VERSION,
  type EnvironmentSettings,
  type Level,
  type ProjectModel,
  type SavedView,
} from './schema';

/** Environment defaults: a bright but neutral overcast-leaning daylight. */
export function defaultEnvironment(): EnvironmentSettings {
  return {
    preset: 'clear-day',
    sunAzimuthDeg: 150,
    sunAltitudeDeg: 48,
    sunIntensity: 2.6,
    ambientIntensity: 0.55,
    skyEnabled: true,
    backgroundColor: '#0b0d10',
    groundColor: '#191c20',
    shadowsEnabled: true,
    exposure: 1,
    weather: 'clear',
    lights: [],
  };
}

export function defaultViews(): SavedView[] {
  return [
    {
      id: 'view_default',
      name: 'Default perspective',
      mode: 'perspective',
      position: { x: 18_000, y: 12_000, z: 18_000 },
      target: { x: 0, y: 1_500, z: 0 },
      zoom: 1,
      sectionElevation: null,
    },
  ];
}

export function groundLevel(): Level {
  return {
    id: 'lvl_ground',
    name: 'Ground floor',
    elevation: 0,
    height: 3000,
    index: 0,
    visible: true,
  };
}

export interface CreateProjectOptions {
  id?: string;
  name?: string;
  description?: string;
  units?: DisplayUnitSystem;
}

/**
 * A brand-new, valid, empty project: one level, the standard material library,
 * default environment and one saved view. Never returns a partially formed
 * model — every consumer can assume `levels[0]` exists.
 */
export function createEmptyProject(options: CreateProjectOptions = {}): ProjectModel {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: options.id ?? createId('proj'),
    name: options.name ?? 'Untitled project',
    description: options.description ?? '',
    units: options.units ?? 'metric',
    site: {
      locationLabel: '',
      latitude: null,
      longitude: null,
      northAngleDeg: 0,
      standardsProfile: '',
      climateNotes: '',
    },
    levels: [groundLevel()],
    elements: {},
    elementOrder: [],
    materials: defaultMaterialMap(),
    environment: defaultEnvironment(),
    views: defaultViews(),
    constraints: [],
    measurements: [],
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
}

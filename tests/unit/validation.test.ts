import { describe, expect, it } from 'vitest';
import { applyTransaction, countFindings, parseCommands, validateModel } from '@/domain/commands';
import { createEmptyProject } from '@/domain/project/factory';
import { buildSampleProject } from '@/domain/project/sample';
import type { ProjectModel } from '@/domain/project/schema';

function build(commands: unknown[], model: ProjectModel = createEmptyProject()) {
  const parsed = parseCommands(commands);
  expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return applyTransaction(model, parsed.commands, { source: 'user' });
}

describe('architectural review', () => {
  it('finds nothing wrong with the sample project', () => {
    expect(validateModel(buildSampleProject())).toEqual([]);
  });

  it('flags a stair with steep risers and suggests a riser count', () => {
    const result = build([
      {
        type: 'create_stair',
        elementId: 'stair_a',
        name: 'Steep stair',
        position: { x: 0, y: 0 },
        totalRise: 3000,
        steps: 10,
        treadDepth: 260,
      },
    ]);
    const findings = validateModel(result.model);
    const steep = findings.find((f) => f.title.includes('risers are steep'));
    expect(steep).toBeDefined();
    expect(steep?.severity).toBe('warning');
    expect(steep?.suggestion).toMatch(/Add risers/);
    // Always labelled as a convention, never as a code check.
    expect(steep?.conventionSource).toBeTruthy();
  });

  it('flags a shallow going', () => {
    const result = build([
      {
        type: 'create_stair',
        elementId: 'stair_a',
        position: { x: 0, y: 0 },
        totalRise: 2700,
        steps: 16,
        treadDepth: 180,
      },
    ]);
    const findings = validateModel(result.model);
    expect(findings.some((f) => f.title.includes('going is shallow'))).toBe(true);
  });

  it('accepts a stair inside the comfortable Blondel range', () => {
    const result = build([
      {
        type: 'create_stair',
        elementId: 'stair_a',
        position: { x: 0, y: 0 },
        totalRise: 2700,
        steps: 15,
        treadDepth: 270,
        width: 1000,
      },
    ]);
    expect(validateModel(result.model)).toEqual([]);
  });

  it('flags a wall that is too slender', () => {
    const result = build([
      {
        type: 'create_wall',
        elementId: 'wall_a',
        start: { x: 0, y: 0 },
        end: { x: 6000, y: 0 },
        height: 6000,
        thickness: 100,
      },
    ]);
    const finding = validateModel(result.model).find((f) => f.title.includes('slender'));
    expect(finding).toBeDefined();
    expect(finding?.conventionSource).toMatch(/not a structural calculation/);
  });

  it('flags an opening that extends beyond its wall as an error', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      {
        type: 'create_opening',
        elementId: 'open_a',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 3000,
        width: 1200,
        height: 1400,
      },
    ]);
    const shortened = build(
      [{ type: 'set_element_properties', ids: ['wall_a'], patch: { end: { x: 2000, y: 0 } } }],
      created.model,
    );
    const findings = validateModel(shortened.model);
    expect(findings.some((f) => f.severity === 'error' && f.elementId === 'open_a')).toBe(true);
  });

  it('notes a narrow door as guidance, not as a failure', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      {
        type: 'create_opening',
        elementId: 'door_a',
        hostId: 'wall_a',
        kind: 'door',
        distanceAlongWall: 3000,
        width: 700,
        height: 2100,
        sillHeight: 0,
      },
    ]);
    const finding = validateModel(created.model).find((f) => f.elementId === 'door_a');
    expect(finding?.severity).toBe('info');
    expect(finding?.conventionSource).toMatch(/vary by jurisdiction/i);
  });

  it('flags a façade that is almost entirely opening', () => {
    const created = build([
      { type: 'create_wall', elementId: 'wall_a', start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } },
      {
        type: 'create_opening',
        elementId: 'open_a',
        hostId: 'wall_a',
        kind: 'window',
        distanceAlongWall: 2000,
        width: 3800,
        height: 1400,
      },
    ]);
    expect(validateModel(created.model).some((f) => f.title.includes('little wall left'))).toBe(
      true,
    );
  });

  it('flags levels that share an elevation', () => {
    const result = build([
      {
        type: 'create_level',
        levelId: 'lvl_a',
        name: 'Mezzanine',
        elevation: 0,
        height: 2400,
        index: 1,
      },
    ]);
    expect(validateModel(result.model).some((f) => f.title.includes('share an elevation'))).toBe(
      true,
    );
  });

  it('flags a footprint that breaches a recorded constraint', () => {
    const result = build([
      {
        type: 'create_slab',
        outline: [
          { x: -10_000, y: -10_000 },
          { x: 10_000, y: -10_000 },
          { x: 10_000, y: 10_000 },
          { x: -10_000, y: 10_000 },
        ],
      },
      {
        type: 'add_constraint',
        constraint: {
          kind: 'max-footprint-area',
          description: 'Planning caps the footprint at 100 m².',
          value: 100_000_000,
        },
      },
    ]);
    const finding = validateModel(result.model).find((f) =>
      f.title.includes('exceeds a project constraint'),
    );
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain('400.0 m²');
  });

  it('does not double-count upper storeys as footprint', () => {
    const square = [
      { x: -5000, y: -5000 },
      { x: 5000, y: -5000 },
      { x: 5000, y: 5000 },
      { x: -5000, y: 5000 },
    ];
    const result = build([
      { type: 'create_slab', outline: square, levelId: 'lvl_ground' },
      {
        type: 'create_level',
        levelId: 'lvl_first',
        name: 'First',
        elevation: 3000,
        height: 3000,
        index: 1,
      },
      { type: 'create_slab', outline: square, levelId: 'lvl_first' },
      {
        type: 'add_constraint',
        constraint: {
          kind: 'max-footprint-area',
          description: 'Footprint limit 150 m².',
          value: 150_000_000,
        },
      },
    ]);
    // 100 m² footprint, 200 m² GFA — the constraint is on footprint, so it passes.
    expect(
      validateModel(result.model).some((f) => f.title.includes('exceeds a project constraint')),
    ).toBe(false);
  });

  it('counts findings by severity', () => {
    const result = build([
      {
        type: 'create_stair',
        position: { x: 0, y: 0 },
        totalRise: 3000,
        steps: 10,
        treadDepth: 180,
        width: 700,
      },
    ]);
    const counts = countFindings(validateModel(result.model));
    expect(counts.warning + counts.info).toBeGreaterThan(0);
    expect(counts.error).toBe(0);
  });
});

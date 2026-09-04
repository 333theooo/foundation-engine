import { describe, expect, it } from 'vitest';
import {
  AI_COMMAND_TYPES,
  ALL_COMMAND_TYPES,
  INTERNAL_COMMAND_TYPES,
  isInternalCommand,
  modelingCommandSchema,
  parseCommand,
  parseCommands,
} from '@/domain/commands';
import { MAX_COMMANDS_PER_TRANSACTION } from '@/domain/project/limits';

describe('command schema', () => {
  it('accepts a well-formed command and fills in defaults', () => {
    const command = parseCommand({
      type: 'create_wall',
      start: { x: 0, y: 0 },
      end: { x: 5000, y: 0 },
    });
    expect(command.type).toBe('create_wall');
    expect(command.v).toBe(1);
    expect(command.id).toMatch(/^cmd_/);
  });

  it('rejects a command with a missing required argument', () => {
    const result = parseCommands([{ type: 'create_wall', start: { x: 0, y: 0 } }]);
    expect(result.commands).toHaveLength(0);
    expect(result.issues.some((issue) => issue.path?.includes('end'))).toBe(true);
  });

  it('rejects an unknown command type', () => {
    const result = parseCommands([{ type: 'demolish_everything', ids: ['a'] }]);
    expect(result.commands).toHaveLength(0);
    expect(result.issues[0]?.code).toBe('schema');
  });

  it('rejects out-of-range dimensions with a units hint', () => {
    const result = parseCommands([
      { type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, height: 99_000_000 },
    ]);
    expect(result.commands).toHaveLength(0);
    expect(result.issues.some((issue) => issue.hint?.includes('millimetres'))).toBe(true);
  });

  it('rejects negative and zero dimensions', () => {
    for (const height of [0, -100]) {
      const result = parseCommands([
        { type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, height },
      ]);
      expect(result.commands).toHaveLength(0);
    }
  });

  it('rejects coordinates beyond the safe range', () => {
    const result = parseCommands([
      { type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 999_999_999, y: 0 } },
    ]);
    expect(result.commands).toHaveLength(0);
  });

  it('rejects NaN and Infinity', () => {
    const result = parseCommands([
      { type: 'move_elements', ids: ['wall_a'], delta: { x: Number.NaN, y: 0, z: 0 } },
      {
        type: 'move_elements',
        ids: ['wall_a'],
        delta: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
      },
    ]);
    expect(result.commands).toHaveLength(0);
    expect(result.rejectedIndices).toEqual([0, 1]);
  });

  it('rejects catalogue items that are not in the allowlist', () => {
    const result = parseCommands([
      { type: 'place_furniture', catalogId: 'nuclear-reactor', position: { x: 0, y: 0 } },
    ]);
    expect(result.commands).toHaveLength(0);
    expect(result.issues[0]?.message).toMatch(/catalogue/i);
  });

  it('accepts catalogue items that are', () => {
    const result = parseCommands([
      { type: 'place_furniture', catalogId: 'sofa-3seat', position: { x: 0, y: 0 } },
    ]);
    expect(result.commands).toHaveLength(1);
  });
});

describe('command allowlist', () => {
  it('excludes every internal command from the AI surface', () => {
    for (const type of INTERNAL_COMMAND_TYPES) {
      expect(AI_COMMAND_TYPES).not.toContain(type);
      expect(isInternalCommand(type)).toBe(true);
    }
  });

  it('refuses internal commands from an untrusted source', () => {
    const result = parseCommands([
      { type: 'remove_elements_hard', ids: ['wall_a'] },
      { type: 'restore_elements', elements: [] },
    ]);
    expect(result.commands).toHaveLength(0);
    expect(result.issues.every((issue) => issue.code === 'forbidden_command')).toBe(true);
  });

  it('accepts internal commands when the undo system asks', () => {
    const result = parseCommands([{ type: 'remove_elements_hard', ids: ['wall_a'] }], {
      allowInternal: true,
    });
    expect(result.commands).toHaveLength(1);
  });

  it('covers every schema variant in ALL_COMMAND_TYPES', () => {
    expect(ALL_COMMAND_TYPES).toHaveLength(modelingCommandSchema.options.length);
    expect(new Set(ALL_COMMAND_TYPES).size).toBe(ALL_COMMAND_TYPES.length);
  });
});

describe('batch limits', () => {
  it('refuses a batch larger than the transaction cap', () => {
    const commands = Array.from({ length: MAX_COMMANDS_PER_TRANSACTION + 1 }, () => ({
      type: 'create_wall',
      start: { x: 0, y: 0 },
      end: { x: 1000, y: 0 },
    }));
    const result = parseCommands(commands);
    expect(result.commands).toHaveLength(0);
    expect(result.issues[0]?.code).toBe('limit_exceeded');
  });

  it('rejects a non-array payload with an actionable message', () => {
    const result = parseCommands({ type: 'create_wall' });
    expect(result.issues[0]?.hint).toMatch(/array/i);
  });

  it('keeps the valid commands from a partially invalid batch', () => {
    const result = parseCommands([
      { type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
      { type: 'create_wall', start: { x: 0, y: 0 } },
      { type: 'set_units', units: 'imperial' },
    ]);
    expect(result.commands).toHaveLength(2);
    expect(result.rejectedIndices).toEqual([1]);
  });
});

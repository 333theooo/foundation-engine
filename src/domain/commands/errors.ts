import { z } from 'zod';
import {
  INTERNAL_COMMAND_TYPES,
  isInternalCommand,
  modelingCommandSchema,
  type ModelingCommand,
} from './schema';

/**
 * Structured command errors.
 *
 * Errors are data, not strings, for two reasons: the UI renders them as
 * actionable rows in the operation log, and the AI orchestrator feeds them back
 * to the model on retry. A message that only reads well to a human is a wasted
 * retry.
 */

export type CommandIssueCode =
  | 'schema'
  | 'unknown_command'
  | 'forbidden_command'
  | 'missing_reference'
  | 'invalid_geometry'
  | 'constraint'
  | 'limit_exceeded'
  | 'locked'
  | 'unsupported'
  | 'conflict';

export interface CommandIssue {
  code: CommandIssueCode;
  /** Dotted path into the command arguments, when the fault is a specific field. */
  path?: string;
  message: string;
  /** Concrete next step. Written for a model to act on, and useful to a human. */
  hint?: string;
  /** Command id this issue belongs to, when known. */
  commandId?: string;
  severity: 'error' | 'warning';
}

export function issue(
  code: CommandIssueCode,
  message: string,
  extra: Partial<Omit<CommandIssue, 'code' | 'message'>> = {},
): CommandIssue {
  return { code, message, severity: 'error', ...extra };
}

export function warning(
  code: CommandIssueCode,
  message: string,
  extra: Partial<Omit<CommandIssue, 'code' | 'message' | 'severity'>> = {},
): CommandIssue {
  return { code, message, severity: 'warning', ...extra };
}

export function hasErrors(issues: readonly CommandIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

function zodIssuesToCommandIssues(error: z.ZodError, commandId?: string): CommandIssue[] {
  return error.issues.slice(0, 12).map((zi) => ({
    code: 'schema' as const,
    path: zi.path.join('.') || undefined,
    message: zi.message,
    hint: describeZodIssue(zi),
    commandId,
    severity: 'error' as const,
  }));
}

function describeZodIssue(zi: z.core.$ZodIssue): string | undefined {
  if (zi.code === 'invalid_type') {
    return `Expected ${zi.expected} at "${zi.path.join('.')}".`;
  }
  if (zi.code === 'too_small') {
    return `Value at "${zi.path.join('.')}" is below the allowed minimum (${String(zi.minimum)}). Remember: all lengths are millimetres.`;
  }
  if (zi.code === 'too_big') {
    return `Value at "${zi.path.join('.')}" exceeds the allowed maximum (${String(zi.maximum)}). Remember: all lengths are millimetres.`;
  }
  if (zi.code === 'invalid_union') {
    return 'The "type" field did not match any known command. Use only the command types listed in the tool schema.';
  }
  return undefined;
}

export interface ParseCommandsResult {
  commands: ModelingCommand[];
  issues: CommandIssue[];
  /** Index of every input entry that failed, so callers can report positionally. */
  rejectedIndices: number[];
}

export interface ParseOptions {
  /**
   * Internal commands (`restore_elements`, `replace_levels`, …) exist so the
   * engine can express an inverse. Only the undo stack may submit them.
   */
  allowInternal?: boolean;
  maxCommands?: number;
}

/**
 * Validates raw command data — typically straight out of a model tool call —
 * into typed commands. Nothing downstream of this function ever sees unparsed
 * input.
 */
export function parseCommands(raw: unknown, options: ParseOptions = {}): ParseCommandsResult {
  const { allowInternal = false, maxCommands = 300 } = options;
  const issues: CommandIssue[] = [];
  const commands: ModelingCommand[] = [];
  const rejectedIndices: number[] = [];

  if (!Array.isArray(raw)) {
    return {
      commands: [],
      issues: [
        issue('schema', 'Expected an array of commands.', {
          hint: 'The "commands" argument must be a JSON array, even for a single operation.',
        }),
      ],
      rejectedIndices: [],
    };
  }

  if (raw.length > maxCommands) {
    issues.push(
      issue(
        'limit_exceeded',
        `Too many commands in one operation (${raw.length} > ${maxCommands}).`,
        {
          hint: 'Split the work across several turns, or use array/footprint commands that express repetition in one call.',
        },
      ),
    );
    return { commands: [], issues, rejectedIndices: [] };
  }

  raw.forEach((entry, index) => {
    const typeValue =
      entry && typeof entry === 'object' && 'type' in entry
        ? String((entry as { type: unknown }).type)
        : undefined;

    if (!allowInternal && typeValue && isInternalCommand(typeValue)) {
      issues.push(
        issue(
          'forbidden_command',
          `Command type "${typeValue}" is internal and cannot be requested.`,
          {
            path: `[${index}].type`,
            hint: `Internal types (${INTERNAL_COMMAND_TYPES.join(', ')}) are produced by the undo system only.`,
          },
        ),
      );
      rejectedIndices.push(index);
      return;
    }

    const parsed = modelingCommandSchema.safeParse(entry);
    if (!parsed.success) {
      const commandId =
        entry && typeof entry === 'object' && 'id' in entry
          ? String((entry as { id: unknown }).id)
          : undefined;
      for (const converted of zodIssuesToCommandIssues(parsed.error, commandId)) {
        issues.push({
          ...converted,
          path: `[${index}]${converted.path ? `.${converted.path}` : ''}`,
        });
      }
      rejectedIndices.push(index);
      return;
    }
    commands.push(parsed.data);
  });

  return { commands, issues, rejectedIndices };
}

/** Parses exactly one command; convenience for tests and the editor. */
export function parseCommand(raw: unknown, options: ParseOptions = {}): ModelingCommand {
  const result = parseCommands([raw], options);
  const command = result.commands[0];
  if (!command) {
    throw new Error(
      `Invalid command: ${result.issues.map((i) => `${i.path ?? ''} ${i.message}`).join('; ')}`,
    );
  }
  return command;
}

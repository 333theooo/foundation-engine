import { MAX_COMMANDS_PER_TRANSACTION } from '@/domain/project/limits';
import type { ProjectModel } from '@/domain/project/schema';
import { createId } from '@/domain/project/ids';
import {
  applyCommand,
  type CommandOutcome,
  type ExecutionContext,
  type HostEffect,
} from './executor';
import { hasErrors, issue, type CommandIssue } from './errors';
import { validateModel, type ValidationFinding } from './validation';
import type { ModelingCommand } from './schema';

/**
 * Transactions.
 *
 * The rule the whole product depends on: **the scene is never left half-built.**
 * A turn's commands either all apply or none do. We get that by cloning the
 * model up front and only publishing the draft once every essential command has
 * succeeded — there is no partial-write path to get wrong.
 *
 * "Essential" is per-command. A `set_camera` that fails should not roll back a
 * successful wall; a `create_wall` that fails must. `optional` marks the former.
 */

export interface TransactionStep {
  command: ModelingCommand;
  outcome: CommandOutcome;
}

export interface TransactionResult {
  ok: boolean;
  /** The new model on success; the untouched input model on failure. */
  model: ProjectModel;
  /** Inverse commands in the order they must be replayed to undo the whole set. */
  inverse: ModelingCommand[];
  steps: TransactionStep[];
  issues: CommandIssue[];
  createdIds: string[];
  affectedIds: string[];
  hostEffects: HostEffect[];
  /** Non-blocking architectural findings on the resulting model. */
  findings: ValidationFinding[];
  transactionId: string;
  rolledBack: boolean;
}

export interface TransactionOptions extends ExecutionContext {
  /** Command ids that may fail without rolling the transaction back. */
  optionalCommandIds?: readonly string[];
  /** Skip the post-apply architectural review (used by undo/redo replays). */
  skipReview?: boolean;
  /** Label recorded in the undo stack. */
  label?: string;
}

/**
 * Applies a list of commands atomically.
 *
 * Never mutates `model`. On failure the returned model is the input by
 * reference, so a caller can compare identity to detect a no-op.
 */
export function applyTransaction(
  model: ProjectModel,
  commands: readonly ModelingCommand[],
  options: TransactionOptions,
): TransactionResult {
  const transactionId = createId('txn');
  const base: TransactionResult = {
    ok: true,
    model,
    inverse: [],
    steps: [],
    issues: [],
    createdIds: [],
    affectedIds: [],
    hostEffects: [],
    findings: [],
    transactionId,
    rolledBack: false,
  };

  if (commands.length === 0) return base;

  if (commands.length > MAX_COMMANDS_PER_TRANSACTION) {
    return {
      ...base,
      ok: false,
      rolledBack: true,
      issues: [
        issue(
          'limit_exceeded',
          `A transaction may contain at most ${MAX_COMMANDS_PER_TRANSACTION} commands (received ${commands.length}).`,
        ),
      ],
    };
  }

  const optional = new Set(options.optionalCommandIds ?? []);
  const draft = structuredClone(model) as ProjectModel;

  const steps: TransactionStep[] = [];
  const inverse: ModelingCommand[] = [];
  const issues: CommandIssue[] = [];
  const createdIds: string[] = [];
  const affectedIds: string[] = [];
  const hostEffects: HostEffect[] = [];

  for (const command of commands) {
    const outcome = applyCommand(draft, command, options);
    steps.push({ command, outcome });
    issues.push(...outcome.issues);
    hostEffects.push(...outcome.hostEffects);

    if (!outcome.ok && !optional.has(command.id)) {
      return {
        ...base,
        ok: false,
        rolledBack: true,
        steps,
        issues: [
          ...issues,
          issue(
            'conflict',
            `Rolled back ${commands.length} command(s): "${command.description || command.type}" could not be applied.`,
            { commandId: command.id, hint: 'No change was made to the project.' },
          ),
        ],
        hostEffects: [],
      };
    }

    if (outcome.ok) {
      // Inverses accumulate in reverse order: undoing replays them last-first.
      inverse.unshift(...outcome.inverse);
      createdIds.push(...outcome.createdIds);
      affectedIds.push(...outcome.affectedIds);
    }
  }

  draft.revision = model.revision + 1;
  draft.updatedAt = new Date().toISOString();

  const findings = options.skipReview ? [] : validateModel(draft);

  return {
    ok: !hasErrors(issues),
    model: draft,
    inverse,
    steps,
    issues,
    createdIds: [...new Set(createdIds)],
    affectedIds: [...new Set(affectedIds)],
    hostEffects,
    findings,
    transactionId,
    rolledBack: false,
  };
}

/**
 * Replays an inverse list. Used by undo and redo, which is why internal
 * commands are permitted here and nowhere else.
 */
export function applyInverse(
  model: ProjectModel,
  inverse: readonly ModelingCommand[],
  source: ExecutionContext['source'] = 'user',
): TransactionResult {
  return applyTransaction(model, inverse, {
    source,
    allowLockedEdits: true,
    skipReview: true,
    label: 'undo',
  });
}

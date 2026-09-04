import type { CommandIssue } from '@/domain/commands/errors';
import type { ModelingCommand } from '@/domain/commands/schema';
import type { ValidationFinding } from '@/domain/commands/validation';
import type { HostEffect } from '@/domain/commands/executor';
import type { ProjectModel } from '@/domain/project/schema';

/**
 * The AI boundary.
 *
 * Everything the application knows about "the AI" is expressed here. A provider
 * takes a turn request and yields events; it never touches the project model,
 * never applies anything, and never returns code. Swapping Claude for another
 * model means implementing `AiProvider` and nothing else.
 */

export type OperationPhase =
  | 'queued'
  | 'reading-project'
  | 'thinking'
  | 'planning'
  | 'validating'
  | 'applying'
  | 'summarising'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Citation {
  documentId: string;
  title: string;
  source: string;
  /** The passage that informed the answer, trimmed for display. */
  snippet: string;
  score: number;
}

/** A single step in the model's stated plan, shown live in the chat panel. */
export interface PlanStep {
  title: string;
  detail?: string;
}

export type AiStreamEvent =
  | { type: 'status'; phase: OperationPhase; message: string }
  | { type: 'text'; delta: string }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'assumptions'; assumptions: string[] }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'clarification'; question: string; options: string[] }
  | { type: 'commands'; commands: ModelingCommand[] }
  | { type: 'issues'; issues: CommandIssue[] }
  | {
      type: 'applied';
      transactionId: string;
      model: ProjectModel;
      createdIds: string[];
      affectedIds: string[];
      inverse: ModelingCommand[];
      findings: ValidationFinding[];
      hostEffects: HostEffect[];
      label: string;
    }
  | { type: 'error'; message: string; recoverable: boolean }
  | {
      type: 'done';
      operationId: string | null;
      summary: string;
      usage: TokenUsage;
      provider: string;
      model: string;
      durationMs: number;
    };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What the provider is given. Deliberately small: never the whole raw model. */
export interface TurnRequest {
  /** The user's message, verbatim. */
  message: string;
  /** Compact, token-bounded description of the current project. */
  projectSummary: string;
  /** Detailed JSON for the elements the request is most likely to concern. */
  focusElements: string;
  /** Recent conversation, already trimmed to a token budget. */
  history: ConversationTurn[];
  /** Retrieved knowledge passages, with their citations. */
  knowledge: Citation[];
  /** Stable user preferences (units, defaults, house rules). */
  preferences: string;
  /** Ids the user currently has selected, if any. */
  selectionIds: string[];
  signal?: AbortSignal;
}

/** What a provider produces once it has finished reasoning. */
export interface TurnResult {
  /** Prose for the chat panel. */
  text: string;
  plan: PlanStep[];
  assumptions: string[];
  /** Raw, unvalidated command data. The orchestrator validates it. */
  rawCommands: unknown[];
  clarification: { question: string; options: string[] } | null;
  usage: TokenUsage;
  model: string;
  /** Structured summary the model wrote of what it changed. */
  summary: string;
}

export interface AiProvider {
  readonly name: 'anthropic' | 'mock';
  readonly model: string;
  /**
   * Runs one turn. Implementations should emit `text` and `status` events as
   * they stream, and resolve with the final structured result.
   */
  run(request: TurnRequest, emit: (event: AiStreamEvent) => void): Promise<TurnResult>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'auth'
      | 'rate_limit'
      | 'timeout'
      | 'cancelled'
      | 'overloaded'
      | 'invalid'
      | 'unknown',
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

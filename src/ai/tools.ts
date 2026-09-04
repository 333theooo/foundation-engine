import { z } from 'zod';
import {
  AI_COMMAND_TYPES,
  isInternalCommand,
  modelingCommandSchema,
} from '@/domain/commands/schema';
import { FURNITURE_CATALOG } from '@/domain/project/furnitureCatalog';

/**
 * Tool definitions handed to the model.
 *
 * The command schema is generated from the same Zod definitions the executor
 * validates against, so the tool contract and the runtime check can never drift
 * apart. Internal commands are filtered out here — the model is not shown them,
 * and `parseCommands` rejects them if one arrives anyway. Two independent
 * layers, because a tool schema is a hint and a validator is a guarantee.
 */

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

/** JSON Schema for the union of every command the AI may emit. */
function buildCommandSchema(): JsonSchema {
  const options = modelingCommandSchema.options.filter(
    (option) => !isInternalCommand(option.shape.type.value),
  );

  const variants = options.map((option) => {
    const schema = z.toJSONSchema(option, {
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as JsonSchema;
    // The command id and protocol version are filled in by the parser; asking
    // the model for them wastes tokens and invites collisions.
    const properties = { ...((schema.properties as JsonSchema | undefined) ?? {}) };
    delete properties.id;
    delete properties.v;
    const required = Array.isArray(schema.required)
      ? (schema.required as string[]).filter((key) => key !== 'id' && key !== 'v')
      : undefined;
    return {
      ...schema,
      properties,
      ...(required ? { required } : {}),
      additionalProperties: false,
    };
  });

  return { anyOf: variants };
}

let cachedCommandSchema: JsonSchema | null = null;

export function commandJsonSchema(): JsonSchema {
  cachedCommandSchema ??= buildCommandSchema();
  return cachedCommandSchema;
}

export const APPLY_OPERATIONS_TOOL = 'apply_operations';
export const ASK_CLARIFICATION_TOOL = 'ask_clarification';
export const INSPECT_PROJECT_TOOL = 'inspect_project';

export function buildTools(): AnthropicToolDefinition[] {
  return [
    {
      name: APPLY_OPERATIONS_TOOL,
      description: [
        'Apply a set of validated modelling operations to the project.',
        '',
        'This is the only way to change the model. Commands are applied as one',
        'transaction: if any of them fails validation the whole set is rejected',
        'and the project is left untouched, so prefer a complete, self-consistent',
        'set over a partial one.',
        '',
        'All lengths are millimetres. All angles are degrees. Plan coordinates are',
        '{ x: east, y: north }; elevation is separate and measured from project datum.',
        `Available command types: ${AI_COMMAND_TYPES.join(', ')}.`,
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          plan: {
            type: 'array',
            description:
              'The operation plan in architectural order, one short line per step. Written before the commands and shown to the user while the work applies.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', maxLength: 120 },
                detail: { type: 'string', maxLength: 300 },
              },
              required: ['title'],
              additionalProperties: false,
            },
            maxItems: 20,
          },
          commands: {
            type: 'array',
            description: 'The modelling commands, in the order they must be applied.',
            items: commandJsonSchema(),
            maxItems: 200,
          },
          assumptions: {
            type: 'array',
            description:
              'Anything you decided on the user’s behalf: dimensions they did not give, conventions you applied, standards you assumed. Be specific and use real numbers.',
            items: { type: 'string', maxLength: 300 },
            maxItems: 12,
          },
          summary: {
            type: 'string',
            description:
              'One or two sentences telling the user what changed, including the important dimensions. Written for an architect, not a developer.',
            maxLength: 800,
          },
        },
        required: ['commands', 'summary'],
        additionalProperties: false,
      },
    },
    {
      name: ASK_CLARIFICATION_TOOL,
      description: [
        'Ask the user one focused question, and make no change to the model.',
        '',
        'Use this only when the ambiguity would materially change the design and',
        'you cannot resolve it with a stated assumption — for example when the',
        'user asks to "make the roof shallower but keep the height" and both the',
        'eaves and the ridge could move. Do not use it for details you can',
        'reasonably assume and state.',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', maxLength: 400 },
          options: {
            type: 'array',
            description: 'Two to four concrete answers the user can pick from.',
            items: { type: 'string', maxLength: 120 },
            maxItems: 4,
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
    {
      name: INSPECT_PROJECT_TOOL,
      description: [
        'Read the full properties of specific elements before deciding what to do.',
        '',
        'The project summary you are given is abbreviated. When you need exact',
        'coordinates, dimensions or hosted openings for particular elements, ask',
        'for them by id rather than guessing.',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          elementIds: {
            type: 'array',
            items: { type: 'string', maxLength: 64 },
            maxItems: 40,
          },
          include: {
            type: 'array',
            description: 'Categories of project data to include.',
            items: {
              type: 'string',
              enum: ['levels', 'materials', 'environment', 'constraints', 'catalogue'],
            },
            maxItems: 5,
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

/** The furniture catalogue, rendered for the system prompt. */
export function catalogueReference(): string {
  return FURNITURE_CATALOG.map(
    (item) => `- ${item.id} — ${item.name} (${item.width}x${item.depth}x${item.height} mm)`,
  ).join('\n');
}

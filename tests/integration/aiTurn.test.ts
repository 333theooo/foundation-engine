import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTurn } from '@/ai/orchestrator';
import { MockProvider } from '@/ai/mock';
import type { AiProvider, AiStreamEvent, TurnRequest, TurnResult } from '@/ai/types';
import { AiProviderError } from '@/ai/types';
import { createProject, getProject, saveProjectModel } from '@/server/projects';
import { elementsOfType, openingsForWall } from '@/domain/project/queries';
import { buildSampleProject } from '@/domain/project/sample';
import { createEmptyProject } from '@/domain/project/factory';
import { INTERNAL_COMMAND_TYPES } from '@/domain/commands/schema';
import type { SessionUser } from '@/server/auth/session';
import { disconnectTestDb, makeUser, removeUser } from './helpers';

let user: SessionUser;

beforeAll(async () => {
  user = await makeUser('turn');
});

afterAll(async () => {
  await removeUser(user);
  await disconnectTestDb();
});

function collect() {
  const events: AiStreamEvent[] = [];
  return { events, emit: (event: AiStreamEvent) => events.push(event) };
}

/** A provider that returns whatever the test tells it to. */
function scriptedProvider(result: Partial<TurnResult>): AiProvider {
  return {
    name: 'mock',
    model: 'scripted',
    async run(_request: TurnRequest, emit) {
      emit({ type: 'status', phase: 'thinking', message: 'scripted' });
      return {
        text: '',
        plan: [],
        assumptions: [],
        rawCommands: [],
        clarification: null,
        usage: { inputTokens: 10, outputTokens: 20 },
        model: 'scripted',
        summary: 'Scripted result.',
        ...result,
      };
    },
  };
}

describe('the AI turn, end to end', () => {
  it('turns a request into validated commands, applies them, and streams the result', async () => {
    const model = createEmptyProject({ name: 'Turn test' });
    const { events, emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'Create a 10 m x 14 m single-storey pavilion.',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: new MockProvider(model),
      },
      emit,
    );

    expect(outcome.status).toBe('applied');
    expect(outcome.transactionId).toBeTruthy();
    expect(elementsOfType(outcome.model, 'wall')).toHaveLength(4);
    expect(elementsOfType(outcome.model, 'slab')).toHaveLength(1);
    expect(elementsOfType(outcome.model, 'roof')).toHaveLength(1);

    // The event sequence the UI depends on.
    const types = events.map((event) => event.type);
    expect(types).toContain('status');
    expect(types).toContain('commands');
    expect(types).toContain('applied');
    expect(types.indexOf('commands')).toBeLessThan(types.indexOf('applied'));
    // The terminal `done` belongs to the caller, which emits it after
    // persisting; the orchestrator must not pre-empt it.
    expect(types).not.toContain('done');

    const applied = events.find((event) => event.type === 'applied');
    expect(applied).toBeDefined();
    if (applied?.type === 'applied') {
      expect(applied.model.revision).toBe(model.revision + 1);
      expect(applied.inverse.length).toBeGreaterThan(0);
      expect(applied.createdIds.length).toBeGreaterThan(0);
    }
  });

  it('leaves the model untouched when the commands do not validate', async () => {
    const model = buildSampleProject();
    const { events, emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'anything',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: scriptedProvider({
          // Millimetres are the rule; 12 metres expressed as "12" is a real
          // mistake a model makes, and it must not silently produce a 12 mm wall.
          rawCommands: [{ type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }],
          summary: 'Tried to build a zero-length wall.',
        }),
      },
      emit,
    );

    expect(outcome.status).toBe('rejected');
    expect(outcome.model).toBe(model);
    expect(events.some((event) => event.type === 'issues')).toBe(true);
    expect(events.some((event) => event.type === 'applied')).toBe(false);
  });

  it('refuses internal commands even if a provider emits them', async () => {
    const model = buildSampleProject();
    const { events, emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'anything',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: scriptedProvider({
          rawCommands: [
            { type: 'remove_elements_hard', ids: ['wall_g_south'] },
            {
              type: 'replace_project_info',
              name: 'Hijacked',
              projectDescription: '',
              units: 'metric',
              site: {},
            },
          ],
        }),
      },
      emit,
    );

    expect(outcome.status).toBe('rejected');
    expect(outcome.model.elements.wall_g_south).toBeDefined();
    const issues = events.find((event) => event.type === 'issues');
    if (issues?.type === 'issues') {
      expect(issues.issues.every((issue) => issue.code === 'forbidden_command')).toBe(true);
    }
  });

  it('rolls back a partially valid batch rather than applying half of it', async () => {
    const model = buildSampleProject();
    const before = Object.keys(model.elements).length;
    const { emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'anything',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: scriptedProvider({
          rawCommands: [
            { type: 'create_wall', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
            {
              type: 'create_opening',
              hostId: 'wall_that_does_not_exist',
              kind: 'window',
              distanceAlongWall: 1000,
              width: 1200,
              height: 1400,
            },
          ],
        }),
      },
      emit,
    );

    expect(outcome.status).toBe('rejected');
    expect(Object.keys(outcome.model.elements)).toHaveLength(before);
  });

  it('stops at a clarification without changing anything', async () => {
    const model = buildSampleProject();
    const { events, emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'Make the roof shallower but preserve the total building height.',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: new MockProvider(model),
      },
      emit,
    );

    expect(outcome.status).toBe('clarification');
    expect(outcome.model).toBe(model);
    const clarification = events.find((event) => event.type === 'clarification');
    expect(clarification).toBeDefined();
  });

  it('reports a provider failure without corrupting the project', async () => {
    const model = buildSampleProject();
    const { events, emit } = collect();

    const failing: AiProvider = {
      name: 'mock',
      model: 'failing',
      async run() {
        throw new AiProviderError('The AI service is overloaded.', 'overloaded', true);
      },
    };

    const outcome = await runTurn(
      {
        model,
        message: 'anything',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: failing,
      },
      emit,
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.model).toBe(model);
    const error = events.find((event) => event.type === 'error');
    expect(error).toBeDefined();
    if (error?.type === 'error') expect(error.recoverable).toBe(true);
  });

  it('treats a cancellation as a no-change, not a failure', async () => {
    const model = buildSampleProject();
    const { emit } = collect();

    const cancelled: AiProvider = {
      name: 'mock',
      model: 'cancelled',
      async run() {
        throw new AiProviderError('Cancelled.', 'cancelled', false);
      },
    };

    const outcome = await runTurn(
      {
        model,
        message: 'anything',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: cancelled,
      },
      emit,
    );

    expect(outcome.status).toBe('no-change');
    expect(outcome.model).toBe(model);
  });

  it('answers a question without changing the model', async () => {
    const model = buildSampleProject();
    const { emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'What is the gross floor area?',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: scriptedProvider({
          rawCommands: [],
          summary: 'The gross floor area is 192 m².',
        }),
      },
      emit,
    );

    expect(outcome.status).toBe('no-change');
    expect(outcome.summary).toContain('192');
  });

  it('records which elements it read, for the operation log', async () => {
    const model = buildSampleProject();
    const { emit } = collect();

    const outcome = await runTurn(
      {
        model,
        message: 'Add three windows to the west façade.',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: new MockProvider(model),
      },
      emit,
    );

    expect(outcome.sceneSummaryForLog.focusIds.length).toBeGreaterThan(0);
    expect(Object.values(outcome.sceneSummaryForLog.focusReasons).join(' ')).toMatch(/west|wall/);
    expect(outcome.sceneSummaryForLog.elementCount).toBe(Object.keys(model.elements).length);
  });
});

describe('AI changes and persistence together', () => {
  it('saves an AI change and reloads it identically', async () => {
    const project = await createProject(user, { name: 'AI persistence' });
    const { emit } = collect();

    const outcome = await runTurn(
      {
        model: project.model,
        message: 'Create a 12 by 8 metre house.',
        history: [],
        selectionIds: [],
        knowledge: [],
        preferences: '',
        providerOverride: new MockProvider(project.model),
      },
      emit,
    );
    expect(outcome.status).toBe('applied');

    await saveProjectModel(user, project.id, outcome.model, {
      versionLabel: outcome.summary.slice(0, 100),
      versionKind: 'AUTOSAVE',
    });

    const reloaded = await getProject(user, project.id);
    expect(reloaded.model.elementOrder).toEqual(outcome.model.elementOrder);
    for (const id of outcome.model.elementOrder) {
      expect(reloaded.model.elements[id]).toEqual(outcome.model.elements[id]);
    }
  });

  it('supports several AI turns in sequence, each building on the last', async () => {
    const project = await createProject(user, { name: 'AI sequence' });
    let model = project.model;

    for (const message of [
      'Create a 12 by 8 metre pavilion.',
      'Add three evenly spaced windows to the south façade.',
      'Change the façade to dark timber.',
    ]) {
      const { emit } = collect();
      const outcome = await runTurn(
        {
          model,
          message,
          history: [],
          selectionIds: [],
          knowledge: [],
          preferences: '',
          providerOverride: new MockProvider(model),
        },
        emit,
      );
      expect(outcome.status).toBe('applied');
      model = outcome.model;
      await saveProjectModel(user, project.id, model);
    }

    const final = await getProject(user, project.id);
    expect(elementsOfType(final.model, 'wall')).toHaveLength(4);
    const southWall = elementsOfType(final.model, 'wall').find((wall) =>
      wall.tags.includes('south'),
    );
    expect(southWall).toBeDefined();
    expect(openingsForWall(final.model, southWall!.id)).toHaveLength(3);
    expect(
      elementsOfType(final.model, 'wall').every((wall) => wall.materialId === 'mat_timber_dark'),
    ).toBe(true);
    expect(final.model.revision).toBe(3);
  });

  it('never lets the mock interpreter emit an internal command', async () => {
    const model = buildSampleProject();
    for (const message of [
      'Create a 10 by 8 metre house.',
      'Move the southern wall 500 mm outward.',
      'Delete everything.',
    ]) {
      const { emit } = collect();
      const outcome = await runTurn(
        {
          model,
          message,
          history: [],
          selectionIds: [],
          knowledge: [],
          preferences: '',
          providerOverride: new MockProvider(model),
        },
        emit,
      );
      for (const command of outcome.commands as Array<{ type?: string }>) {
        expect(INTERNAL_COMMAND_TYPES).not.toContain(command.type);
      }
    }
  });
});

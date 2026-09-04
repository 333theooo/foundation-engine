import { createEmptyProject } from '@/domain/project/factory';
import { buildSampleProject } from '@/domain/project/sample';
import { interpret } from '@/ai/mock';
import { parseCommands } from '@/domain/commands/errors';
import { applyTransaction } from '@/domain/commands/transaction';
import type { ProjectModel } from '@/domain/project/schema';

const prompts = [
  'Create a two-storey Scandinavian house, 12 by 8 metres.',
  'Make the ground-floor ceiling 2.7 metres high.',
  'Move the southern wall 800 millimetres outward.',
  'Add three evenly spaced windows to the west façade.',
  'Use oak flooring, white plaster walls, and dark metal window frames.',
  'Show the building during an overcast afternoon.',
  'Make the roof shallower but preserve the total building height.',
  'Create a 10 m x 14 m single-storey pavilion.',
  'Add a 3 m-high perimeter wall with an entrance on the south side.',
  'Divide the floor into a studio, storage room, and accessible bathroom.',
  'Add north-facing roof lights.',
  'Change the façade to dark timber.',
  'Add a straight stair.',
  'Switch to imperial units.',
  'What is the airspeed velocity of an unladen swallow?',
];

let model: ProjectModel = createEmptyProject({ name: 'Interpreter check' });
let failures = 0;

for (const prompt of prompts) {
  const result = interpret(model, prompt, []);
  const { commands, issues } = parseCommands(result.commands);
  let status = 'no-op';
  if (result.clarification) status = 'CLARIFY';
  else if (issues.length > 0) {
    status = 'PARSE-FAIL';
    failures += 1;
  } else if (commands.length > 0) {
    const txn = applyTransaction(model, commands, { source: 'ai' });
    if (txn.rolledBack) {
      status = 'ROLLBACK';
      failures += 1;
      console.log('    !!', txn.issues.map((i) => i.message).join(' | '));
    } else {
      model = txn.model;
      status = `applied ${commands.length} cmd, +${txn.createdIds.length} el`;
    }
  }
  console.log(`- "${prompt}"\n    ${status}`);
  if (issues.length)
    console.log('    issues:', issues.map((i) => `${i.path ?? ''} ${i.message}`).join(' | '));
  if (result.summary && status.startsWith('applied'))
    console.log(`    -> ${result.summary.slice(0, 140)}`);
}

console.log('\nfinal element count:', Object.keys(model.elements).length);

// Second pass against the sample project, where named elements exist.
const sample = buildSampleProject();
for (const prompt of [
  'Move the southern wall 800 millimetres outward.',
  'Make the roof shallower but preserve the total building height.',
  'Turn this room into an open-plan kitchen and living space.',
]) {
  const selection = prompt.includes('this room') ? ['room_living'] : [];
  const result = interpret(sample, prompt, selection);
  const { commands, issues } = parseCommands(result.commands);
  const txn = commands.length ? applyTransaction(sample, commands, { source: 'ai' }) : null;
  console.log(`\n[sample] "${prompt}"`);
  console.log(
    '   clarify:',
    Boolean(result.clarification),
    'cmds:',
    commands.length,
    'issues:',
    issues.length,
    'rolledBack:',
    txn?.rolledBack ?? '-',
  );
  if (issues.length) {
    failures += 1;
    console.log('   ', issues.map((i) => i.message).join(' | '));
  }
  if (txn?.rolledBack) {
    failures += 1;
    console.log('   ', txn.issues.map((i) => i.message).join(' | '));
  }
  if (result.summary) console.log('   ->', result.summary.slice(0, 160));
}

console.log('\nFAILURES:', failures);
process.exit(failures > 0 ? 1 : 0);

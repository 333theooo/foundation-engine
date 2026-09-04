import { buildSampleProject } from '@/domain/project/sample';
import { validateModel } from '@/domain/commands/validation';
import { countElementsByType, grossFloorArea } from '@/domain/project/queries';

const model = buildSampleProject();
console.log('elements:', Object.keys(model.elements).length);
console.log('by type:', countElementsByType(model));
console.log(
  'levels:',
  model.levels.map((l) => `${l.name}@${l.elevation}(h${l.height})`).join(', '),
);
console.log('GFA m2:', (grossFloorArea(model) / 1e6).toFixed(1));
const findings = validateModel(model);
console.log('findings:', findings.length);
for (const f of findings) console.log(` - [${f.severity}] ${f.title}: ${f.detail}`);

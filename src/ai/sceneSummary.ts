import { formatArea, formatLength } from '@/domain/units';
import {
  countElementsByType,
  grossFloorArea,
  listElements,
  modelBounds,
  openingsForWall,
  polygonArea,
  polygonBounds,
  wallLength,
  wallOrientation,
} from '@/domain/project/queries';
import type { ArchElement, ProjectModel } from '@/domain/project/schema';

/**
 * Project state summarisation.
 *
 * Sending the whole model every turn would be wasteful and, on a large project,
 * impossible. It would also be counterproductive: a model reasons better about
 * fifty well-described elements than about four thousand lines of JSON.
 *
 * So each turn gets two things:
 *
 *   1. A **summary** — every element, one line each, with the dimensions that
 *      matter and the relationships the model needs (which wall hosts what,
 *      which way a façade faces). Bounded by a line budget; large projects
 *      degrade to per-level counts rather than truncating mid-list.
 *   2. A **focus set** — full JSON for the handful of elements the request is
 *      actually about, chosen from the user's selection and from words in their
 *      message.
 *
 * The estimator is a character-count heuristic, not a tokeniser. It is used to
 * stay inside a budget with margin, never to bill anyone, and being roughly
 * right is worth more than the dependency an exact count would cost.
 */

/** Rough token estimate. English prose and JSON both land near 3.6 chars/token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export interface SummaryOptions {
  /** Maximum element lines before the summary switches to aggregate mode. */
  maxElementLines?: number;
  units?: 'metric' | 'imperial';
}

function describeElement(model: ProjectModel, element: ArchElement): string {
  const units = model.units;
  const L = (mm: number) => formatLength(mm, units);
  const flags = [
    element.visible ? null : 'hidden',
    element.locked ? 'locked' : null,
    element.origin === 'ai' ? 'ai-made' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const suffix = flags ? ` [${flags}]` : '';

  switch (element.type) {
    case 'wall': {
      const openings = openingsForWall(model, element.id);
      const facing = wallOrientation(element, model.site.northAngleDeg);
      const openingText =
        openings.length > 0
          ? `; hosts ${openings.map((o) => `${o.id}(${o.kind} ${L(o.width)}x${L(o.height)} @${L(o.distanceAlongWall)})`).join(', ')}`
          : '';
      return `wall ${element.id} "${element.name}" level=${element.levelId} faces=${facing} from(${Math.round(element.start.x)},${Math.round(element.start.y)}) to(${Math.round(element.end.x)},${Math.round(element.end.y)}) length=${L(wallLength(element))} height=${L(element.height)} thickness=${L(element.thickness)} material=${element.materialId}${element.structural ? ' structural' : ''}${openingText}${suffix}`;
    }
    case 'opening':
      return `${element.kind} ${element.id} "${element.name}" host=${element.hostId} type=${element.openingType} at=${L(element.distanceAlongWall)} width=${L(element.width)} height=${L(element.height)} sill=${L(element.sillHeight)}${suffix}`;
    case 'slab': {
      const bounds = polygonBounds(element.outline);
      return `slab ${element.id} "${element.name}" level=${element.levelId} role=${element.role} extent=${L(bounds.width)}x${L(bounds.depth)} area=${formatArea(polygonArea(element.outline), units)} thickness=${L(element.thickness)} material=${element.materialId}${suffix}`;
    }
    case 'room': {
      const bounds = polygonBounds(element.outline);
      return `room ${element.id} "${element.name}" level=${element.levelId} programme=${element.programme} extent=${L(bounds.width)}x${L(bounds.depth)} area=${formatArea(polygonArea(element.outline), units)}${element.ceilingHeight ? ` ceiling=${L(element.ceilingHeight)}` : ''}${suffix}`;
    }
    case 'roof': {
      const bounds = polygonBounds(element.outline);
      return `roof ${element.id} "${element.name}" kind=${element.kind} base=${L(element.baseElevation)} pitch=${element.pitchDeg}deg ridgeAxis=${element.ridgeAxis} extent=${L(bounds.width)}x${L(bounds.depth)} overhang=${L(element.overhang)} material=${element.materialId}${suffix}`;
    }
    case 'stair': {
      const riser = element.totalRise / element.steps;
      return `stair ${element.id} "${element.name}" level=${element.levelId} at(${Math.round(element.position.x)},${Math.round(element.position.y)}) rot=${element.rotationDeg}deg width=${L(element.width)} rise=${L(element.totalRise)} steps=${element.steps} riser=${L(riser)} tread=${L(element.treadDepth)} shape=${element.shape}${suffix}`;
    }
    case 'column':
      return `column ${element.id} "${element.name}" level=${element.levelId} at(${Math.round(element.position.x)},${Math.round(element.position.y)}) ${L(element.width)}x${L(element.depth)} height=${L(element.height)} ${element.shape}${suffix}`;
    case 'beam':
      return `beam ${element.id} "${element.name}" level=${element.levelId} from(${Math.round(element.start.x)},${Math.round(element.start.y)}) to(${Math.round(element.end.x)},${Math.round(element.end.y)}) ${L(element.width)}x${L(element.depth)} soffit=${L(element.baseOffset)}${suffix}`;
    case 'railing':
      return `railing ${element.id} "${element.name}" level=${element.levelId} points=${element.path.length} height=${L(element.height)} infill=${element.infill}${suffix}`;
    case 'furniture':
      return `furniture ${element.id} "${element.name}" catalogue=${element.catalogId} level=${element.levelId} at(${Math.round(element.position.x)},${Math.round(element.position.y)}) rot=${element.rotationDeg}deg${suffix}`;
    case 'group':
      return `group ${element.id} "${element.name}" members=${element.childIds.length}${suffix}`;
    case 'imported':
      return `imported ${element.id} "${element.name}" format=${element.sourceFormat}${element.semanticTag ? ` tag=${element.semanticTag}` : ''} referenceOnly=${element.referenceOnly}${suffix}`;
    default:
      return `element ${(element as ArchElement).id}`;
  }
}

/**
 * Builds the summary the model reads each turn.
 *
 * Above `maxElementLines` the per-element listing is replaced by per-level
 * counts plus the elements nearest the user's focus, because a truncated list
 * is worse than an honest aggregate — the model would silently assume the
 * missing elements do not exist.
 */
export function buildProjectSummary(
  model: ProjectModel,
  options: SummaryOptions & { focusIds?: readonly string[] } = {},
): string {
  const maxLines = options.maxElementLines ?? 220;
  const units = model.units;
  const L = (mm: number) => formatLength(mm, units);
  const bounds = modelBounds(model);
  const elements = listElements(model);
  const counts = countElementsByType(model);

  const header = [
    `PROJECT: "${model.name}" (id ${model.id}, revision ${model.revision})`,
    model.description ? `BRIEF: ${model.description}` : null,
    `UNITS: ${units} display; every value in commands is millimetres.`,
    `SITE: ${model.site.locationLabel || 'not specified'}${model.site.latitude !== null ? ` lat ${model.site.latitude}, lon ${model.site.longitude}` : ''}; project north is rotated ${model.site.northAngleDeg}deg from +y.`,
    model.site.standardsProfile
      ? `STANDARDS PROFILE (recorded by the user, not verified): ${model.site.standardsProfile}`
      : null,
    model.site.climateNotes ? `CLIMATE NOTES: ${model.site.climateNotes}` : null,
    '',
    `EXTENT: ${bounds.isEmpty ? 'empty project' : `${L(bounds.max.x - bounds.min.x)} east-west x ${L(bounds.max.z - bounds.min.z)} north-south x ${L(bounds.max.y - bounds.min.y)} tall`}`,
    `GROSS FLOOR AREA: ${formatArea(grossFloorArea(model), units)}`,
    `ELEMENT COUNTS: ${
      Object.entries(counts)
        .map(([type, n]) => `${type}=${n}`)
        .join(', ') || 'none'
    }`,
    '',
    'LEVELS:',
    ...model.levels
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(
        (level) =>
          `- ${level.id} "${level.name}" index=${level.index} elevation=${L(level.elevation)} height=${L(level.height)}${level.visible ? '' : ' [hidden]'}`,
      ),
    '',
    'MATERIALS:',
    ...Object.values(model.materials).map(
      (material) =>
        `- ${material.id} "${material.name}" ${material.category} ${material.color} roughness=${material.roughness} metalness=${material.metalness}${material.opacity < 1 ? ` opacity=${material.opacity}` : ''}`,
    ),
    '',
    `ENVIRONMENT: preset=${model.environment.preset} weather=${model.environment.weather} sun azimuth=${model.environment.sunAzimuthDeg}deg altitude=${model.environment.sunAltitudeDeg}deg shadows=${model.environment.shadowsEnabled} lights=${model.environment.lights.length}`,
  ].filter((line): line is string => line !== null);

  const constraintLines =
    model.constraints.length > 0
      ? [
          '',
          'CONSTRAINTS:',
          ...model.constraints.map(
            (c) =>
              `- ${c.id} ${c.kind}${c.active ? '' : ' (inactive)'}: ${c.description}${c.value !== null ? ` value=${c.value}` : ''}`,
          ),
        ]
      : [];

  const viewLines =
    model.views.length > 0
      ? ['', 'SAVED VIEWS:', ...model.views.map((v) => `- ${v.id} "${v.name}" (${v.mode})`)]
      : [];

  let elementLines: string[];
  if (elements.length <= maxLines) {
    elementLines = [
      '',
      'ELEMENTS:',
      ...elements.map((element) => `- ${describeElement(model, element)}`),
    ];
  } else {
    const focus = new Set(options.focusIds ?? []);
    const focused = elements.filter((element) => focus.has(element.id));
    const perLevel = new Map<string, Record<string, number>>();
    for (const element of elements) {
      const levelId = 'levelId' in element && element.levelId ? element.levelId : 'unassigned';
      const bucket = perLevel.get(levelId) ?? {};
      bucket[element.type] = (bucket[element.type] ?? 0) + 1;
      perLevel.set(levelId, bucket);
    }
    elementLines = [
      '',
      `ELEMENTS: ${elements.length} in total — too many to list individually. Per-level counts follow; use inspect_project to read any element in full.`,
      ...[...perLevel.entries()].map(
        ([levelId, bucket]) =>
          `- ${levelId}: ${Object.entries(bucket)
            .map(([type, n]) => `${type}=${n}`)
            .join(', ')}`,
      ),
      ...(focused.length > 0
        ? [
            '',
            'ELEMENTS RELEVANT TO THIS REQUEST:',
            ...focused.map((e) => `- ${describeElement(model, e)}`),
          ]
        : []),
    ];
  }

  return [...header, ...constraintLines, ...viewLines, ...elementLines].join('\n');
}

/** Words that suggest a request concerns a particular element type. */
const TYPE_KEYWORDS: Array<[RegExp, ArchElement['type']]> = [
  [/\bwalls?\b|fa[cç]ade|elevation|partition/i, 'wall'],
  [/\bwindows?\b|glaz|rooflight|skylight/i, 'opening'],
  [/\bdoors?\b|entrance|opening/i, 'opening'],
  [/\bslabs?\b|floor plate|deck/i, 'slab'],
  [/\brooms?\b|space|kitchen|bedroom|bathroom|living|studio|office|hall|wc|store/i, 'room'],
  [/\broofs?\b|ridge|eaves|gable|pitch/i, 'roof'],
  [/\bstairs?\b|staircase|steps?\b|flight/i, 'stair'],
  [/\bcolumns?\b|pillar|post/i, 'column'],
  [/\bbeams?\b|lintel|joist/i, 'beam'],
  [/\brailings?\b|balustrade|handrail/i, 'railing'],
  [/\bfurniture\b|sofa|table|bed|chair|desk|kitchen unit/i, 'furniture'],
];

const DIRECTION_KEYWORDS: Array<[RegExp, 'north' | 'south' | 'east' | 'west']> = [
  [/\bnorth(ern)?\b/i, 'north'],
  [/\bsouth(ern)?\b/i, 'south'],
  [/\beast(ern)?\b/i, 'east'],
  [/\bwest(ern)?\b/i, 'west'],
];

export interface FocusSelection {
  ids: string[];
  /** Why each element was chosen, for the operation log and for debugging. */
  reasons: Record<string, string>;
}

/**
 * Chooses the elements to describe in full.
 *
 * Priority order: what the user has selected, elements whose name appears in the
 * message, elements whose type or compass direction the message names, then
 * recently created elements. Walls drag their hosted openings in with them,
 * because you cannot reason about one without the other.
 */
export function selectFocusElements(
  model: ProjectModel,
  message: string,
  selectionIds: readonly string[],
  limit = 30,
): FocusSelection {
  const reasons: Record<string, string> = {};
  const ordered: string[] = [];

  const add = (id: string, reason: string) => {
    if (!model.elements[id] || reasons[id]) return;
    reasons[id] = reason;
    ordered.push(id);
  };

  for (const id of selectionIds) add(id, 'currently selected');

  const elements = listElements(model);
  const lower = message.toLowerCase();

  // Explicit id mentions are unambiguous, so they come next.
  for (const element of elements) {
    if (lower.includes(element.id.toLowerCase())) add(element.id, 'id named in the request');
  }

  // Name matches, longest first so "living room" beats "room".
  const byNameLength = [...elements].sort((a, b) => b.name.length - a.name.length);
  for (const element of byNameLength) {
    const name = element.name.toLowerCase();
    if (name.length >= 4 && lower.includes(name)) add(element.id, 'name named in the request');
  }

  const wantedTypes = new Set(
    TYPE_KEYWORDS.filter(([pattern]) => pattern.test(message)).map(([, type]) => type),
  );
  const wantedDirections = DIRECTION_KEYWORDS.filter(([pattern]) => pattern.test(message)).map(
    ([, direction]) => direction,
  );

  if (wantedDirections.length > 0) {
    for (const element of elements) {
      if (element.type !== 'wall') continue;
      const facing = wallOrientation(element, model.site.northAngleDeg);
      if (wantedDirections.includes(facing)) add(element.id, `${facing}-facing wall`);
    }
  }

  if (wantedTypes.size > 0) {
    for (const element of elements) {
      if (wantedTypes.has(element.type))
        add(element.id, `${element.type} mentioned in the request`);
    }
  }

  // Openings cannot be reasoned about without their host, and vice versa.
  for (const id of [...ordered]) {
    const element = model.elements[id];
    if (element?.type === 'wall') {
      for (const opening of openingsForWall(model, id)) add(opening.id, `hosted by ${id}`);
    }
    if (element?.type === 'opening') add(element.hostId, `hosts ${id}`);
    if (element?.type === 'group') {
      for (const childId of element.childIds) add(childId, `member of ${id}`);
    }
  }

  // Fall back to the most recently added elements — usually what "it" means.
  if (ordered.length === 0) {
    for (const id of model.elementOrder.slice(-8).reverse()) add(id, 'recently created');
  }

  return { ids: ordered.slice(0, limit), reasons };
}

/** Full JSON for the focus set, bounded so one huge element cannot blow the budget. */
export function buildFocusDetail(
  model: ProjectModel,
  focusIds: readonly string[],
  maxCharacters = 12_000,
): string {
  if (focusIds.length === 0) return 'No elements singled out for this request.';

  const parts: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const id of focusIds) {
    const element = model.elements[id];
    if (!element) continue;
    const json = JSON.stringify(element, null, 1);
    if (used + json.length > maxCharacters) {
      omitted += 1;
      continue;
    }
    used += json.length;
    parts.push(json);
  }

  const suffix =
    omitted > 0
      ? `\n\n(${omitted} further relevant element(s) omitted for length — call inspect_project for them.)`
      : '';
  return `[\n${parts.join(',\n')}\n]${suffix}`;
}

/**
 * Trims conversation history to a token budget, keeping the most recent turns.
 * The first user message is always kept: it usually carries the brief.
 */
export function trimHistory(
  history: readonly { role: 'user' | 'assistant'; content: string }[],
  budgetTokens = 3_000,
): { role: 'user' | 'assistant'; content: string }[] {
  const kept: { role: 'user' | 'assistant'; content: string }[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    const cost = estimateTokens(turn.content);
    if (used + cost > budgetTokens && kept.length > 0) break;
    kept.unshift(turn);
    used += cost;
  }

  const first = history[0];
  if (first && kept[0] !== first && first.role === 'user') {
    kept.unshift({
      role: 'user',
      content: `[earlier in this conversation] ${first.content.slice(0, 600)}`,
    });
  }
  return kept;
}

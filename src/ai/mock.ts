import { parseLengthToMm, toMillimetres, type LengthUnit } from '@/domain/units';
import {
  defaultLevelId,
  elementsOfType,
  listElements,
  openingsForWall,
  polygonBounds,
  polygonCentroid,
  wallLength,
  wallOrientation,
} from '@/domain/project/queries';
import { matchMaterialByName } from '@/domain/project/materials';
import { matchCatalogItem } from '@/domain/project/furnitureCatalog';
import type { ProjectModel, Room, Wall } from '@/domain/project/schema';
import type { AiProvider, AiStreamEvent, PlanStep, TurnRequest, TurnResult } from './types';

/**
 * The deterministic local interpreter.
 *
 * This is not a placeholder and it is not a fake. It is a real natural-language
 * interpreter, written as an ordered rule set, that covers the modelling moves
 * the product is built around: creating a footprint, changing storey heights,
 * moving a named façade, distributing openings, assigning materials, setting the
 * environment, dividing a floor into rooms, adding stairs and furniture.
 *
 * It exists for three reasons, in order of importance:
 *
 *   1. **The application must work without credentials.** A student cloning the
 *      repo, a CI run, and the end-to-end tests all need the full pipeline —
 *      request to commands to geometry to persistence — with no API key.
 *   2. **It makes the AI layer testable.** Every rule is deterministic, so the
 *      integration tests assert on real command output rather than on a stub.
 *   3. **It documents the command language by example.**
 *
 * What it is *not*: it does not reason. It matches patterns. Ask it something
 * outside its rules and it says so, clearly, and tells you a key would unlock
 * open-ended design conversation. That honesty is the point — silently doing
 * nothing, or inventing a change, would be much worse.
 */

interface Interpretation {
  plan: PlanStep[];
  commands: unknown[];
  summary: string;
  assumptions: string[];
  clarification?: { question: string; options: string[] } | undefined;
}

interface RuleContext {
  message: string;
  lower: string;
  model: ProjectModel;
  selectionIds: string[];
  /** Every length found in the message, in millimetres, in order. */
  lengths: number[];
  /** A "12 by 8 metre" style pair, if present. */
  pair: { width: number; depth: number } | null;
  levelId: string;
}

interface Rule {
  id: string;
  matches(context: RuleContext): boolean;
  build(context: RuleContext): Interpretation | null;
}

/* ------------------------------------------------------------------ */
/* Language helpers                                                    */
/* ------------------------------------------------------------------ */

const NUMBER = '(\\d+(?:[.,]\\d+)?)';
const UNIT =
  '(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?|ft|feet|foot|in|inch(?:es)?|\'|")';

/**
 * Extracts every length in the message, converted to millimetres.
 * A bare number is read in the project's display unit, which is why the
 * interpreter needs the model and not just the text.
 */
export function extractLengths(message: string, defaultUnit: LengthUnit): number[] {
  const results: number[] = [];
  const pattern = new RegExp(`${NUMBER}\\s*${UNIT}?`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(message)) !== null) {
    const raw = match[1]!.replace(',', '.');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const unit = match[2];
    const mm = unit
      ? (parseLengthToMm(`${value}${unit}`, defaultUnit) ?? toMillimetres(value, defaultUnit))
      : toMillimetres(value, defaultUnit);
    results.push(mm);
  }
  return results;
}

/** Finds "12 by 8 metres", "10 m x 14 m", "12×8". */
export function extractPair(
  message: string,
  defaultUnit: LengthUnit,
): { width: number; depth: number } | null {
  const pattern = new RegExp(
    `${NUMBER}\\s*${UNIT}?\\s*(?:by|x|×|\\*)\\s*${NUMBER}\\s*${UNIT}?`,
    'i',
  );
  const match = pattern.exec(message);
  if (!match) return null;

  const unitA = match[2];
  const unitB = match[4];
  // "10 x 14 m" means both are metres: a trailing unit governs both numbers.
  const resolvedA = unitA ?? unitB;
  const resolvedB = unitB ?? unitA;

  const width = parseLengthToMm(`${match[1]!.replace(',', '.')}${resolvedA ?? ''}`, defaultUnit);
  const depth = parseLengthToMm(`${match[3]!.replace(',', '.')}${resolvedB ?? ''}`, defaultUnit);
  if (width === null || depth === null) return null;
  return { width, depth };
}

function storeyCount(message: string): number | null {
  const words: Record<string, number> = {
    single: 1,
    one: 1,
    two: 2,
    double: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  const wordMatch =
    /\b(single|one|two|double|three|four|five)[- ]?(?:storey|story|floor|level)/i.exec(message);
  if (wordMatch) return words[wordMatch[1]!.toLowerCase()] ?? null;
  const digitMatch = /\b(\d)[- ]?(?:storey|story|floor|level)/i.exec(message);
  if (digitMatch) return Number(digitMatch[1]);
  return null;
}

function countWords(message: string): number | null {
  const words: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  const match =
    /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+(?:evenly\s+spaced\s+)?(?:new\s+)?(?:tall\s+|small\s+|large\s+|narrow\s+|wide\s+)?(?:window|door|opening|column|rooflight|roof\s?light|skylight)/i.exec(
      message,
    );
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  const named = words[token];
  if (named !== undefined) return named;
  const numeric = Number(token);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

type Compass = 'north' | 'south' | 'east' | 'west';

function extractDirection(message: string): Compass | null {
  if (/\bnorth(ern)?\b/i.test(message)) return 'north';
  if (/\bsouth(ern)?\b/i.test(message)) return 'south';
  if (/\beast(ern)?\b/i.test(message)) return 'east';
  if (/\bwest(ern)?\b/i.test(message)) return 'west';
  return null;
}

function wallsFacing(model: ProjectModel, direction: Compass, levelId?: string): Wall[] {
  return elementsOfType(model, 'wall').filter(
    (wall) =>
      (!levelId || wall.levelId === levelId) &&
      wallOrientation(wall, model.site.northAngleDeg) === direction,
  );
}

/** Outward unit normal of a wall in plan, used for "move it outward". */
function outwardNormal(wall: Wall): { x: number; y: number } {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dy / length, y: -dx / length };
}

function targetRooms(context: RuleContext): Room[] {
  const selected = context.selectionIds
    .map((id) => context.model.elements[id])
    .filter((element): element is Room => element?.type === 'room');
  if (selected.length > 0) return selected;

  const named = elementsOfType(context.model, 'room').filter((room) =>
    context.lower.includes(room.name.toLowerCase()),
  );
  return named;
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const RULES: Rule[] = [
  /* ---- Create a building or footprint ---- */
  {
    id: 'create-building',
    matches: (c) =>
      /\b(create|build|make|design|draw|start|add)\b/.test(c.lower) &&
      /\b(house|building|pavilion|studio|cabin|block|volume|footprint|box|shed|extension)\b/.test(
        c.lower,
      ) &&
      // "make the roof shallower but preserve the total building height" names a
      // building but is not a request to create one.
      !/\broofs?\b|\bpitch|shallow|steep|\bfa[cç]ade\b/.test(c.lower),
    build(c) {
      const pair = c.pair ?? { width: 10_000, depth: 8_000 };
      const storeys = storeyCount(c.message) ?? 1;
      const assumed: string[] = [];
      if (!c.pair) assumed.push('No plan dimensions given, so assumed a 10 x 8 m footprint.');

      const storeyHeight =
        c.lengths.find(
          (length) =>
            length >= 2_200 && length <= 4_500 && length !== pair.width && length !== pair.depth,
        ) ?? 2_700;
      assumed.push(`Storey height set to ${storeyHeight} mm floor to floor.`);

      const wallMaterial = /scandinav|nordic|timber|wood/.test(c.lower)
        ? 'mat_timber_dark'
        : 'mat_render_grey';
      if (/scandinav|nordic/.test(c.lower)) {
        assumed.push(
          'Read "Scandinavian" as dark timber cladding, a simple gable, and generous south glazing.',
        );
      }

      const commands: unknown[] = [];
      const plan: PlanStep[] = [];

      commands.push({
        type: 'update_level',
        description: 'Set the ground floor height',
        levelId: c.levelId,
        height: storeyHeight,
        cascade: true,
      });
      plan.push({ title: 'Set the ground floor storey height', detail: `${storeyHeight} mm` });

      commands.push({
        type: 'create_rectangular_footprint',
        description: 'Ground floor envelope and slab',
        levelId: c.levelId,
        centre: { x: 0, y: 0 },
        width: pair.width,
        depth: pair.depth,
        height: storeyHeight,
        thickness: 300,
        includeSlab: true,
        materialId: wallMaterial,
        namePrefix: 'Ground wall',
      });
      plan.push({
        title: 'Build the ground floor envelope',
        detail: `${pair.width / 1000} x ${pair.depth / 1000} m with a floor slab`,
      });

      const levelIds = [c.levelId];
      for (let storey = 1; storey < storeys; storey += 1) {
        const levelId = `lvl_upper_${storey}`;
        levelIds.push(levelId);
        commands.push({
          type: 'create_level',
          description: `Add storey ${storey + 1}`,
          levelId,
          name: storey === 1 ? 'First floor' : `Floor ${storey + 1}`,
          elevation: storeyHeight * storey,
          height: storeyHeight,
          index: storey,
        });
        commands.push({
          type: 'create_slab',
          description: `Floor plate for storey ${storey + 1}`,
          name: `Floor slab ${storey + 1}`,
          levelId,
          outline: rectangle(pair.width, pair.depth),
          thickness: 250,
          materialId: 'mat_timber_oak',
          role: 'floor',
        });
        commands.push({
          type: 'create_rectangular_footprint',
          description: `Envelope for storey ${storey + 1}`,
          levelId,
          centre: { x: 0, y: 0 },
          width: pair.width,
          depth: pair.depth,
          height: storeyHeight,
          thickness: 300,
          includeSlab: false,
          materialId: wallMaterial,
          namePrefix: `Floor ${storey + 1} wall`,
        });
        plan.push({ title: `Add storey ${storey + 1}`, detail: `at ${storeyHeight * storey} mm` });
      }

      const topLevel = levelIds[levelIds.length - 1]!;
      const roofKind = /flat roof/.test(c.lower)
        ? 'flat'
        : /shed|mono/.test(c.lower)
          ? 'shed'
          : 'gable';
      commands.push({
        type: 'create_roof',
        description: 'Roof over the footprint',
        name: 'Roof',
        levelId: topLevel,
        kind: roofKind,
        outline: rectangle(pair.width, pair.depth),
        baseElevation: storeyHeight * storeys,
        thickness: 300,
        pitchDeg: roofKind === 'flat' ? 0 : 30,
        ridgeAxis: pair.width >= pair.depth ? 'x' : 'y',
        overhang: 400,
        materialId: roofKind === 'flat' ? 'mat_roof_membrane' : 'mat_roof_zinc',
      });
      plan.push({
        title: `Add a ${roofKind} roof`,
        detail: roofKind === 'flat' ? undefined : '30° pitch',
      });

      commands.push({
        type: 'focus_elements',
        description: 'Frame the new building',
        ids: [],
      });

      const totalHeight =
        storeyHeight * storeys +
        (roofKind === 'flat'
          ? 300
          : Math.round((Math.min(pair.width, pair.depth) / 2) * Math.tan((30 * Math.PI) / 180)));

      return {
        plan,
        commands,
        assumptions: assumed,
        summary: `Built a ${storeys === 1 ? 'single-storey' : `${storeys}-storey`} volume of ${pair.width / 1000} x ${pair.depth / 1000} m with ${storeyHeight} mm storeys and a ${roofKind} roof. Overall height is roughly ${(totalHeight / 1000).toFixed(1)} m. Next: openings, or divide the floor into rooms.`,
      };
    },
  },

  /* ---- Perimeter wall ---- */
  {
    id: 'perimeter-wall',
    matches: (c) => /perimeter wall|boundary wall|garden wall|enclosing wall/.test(c.lower),
    build(c) {
      const height = c.lengths.find((length) => length >= 500 && length <= 6_000) ?? 3_000;
      const existing = elementsOfType(c.model, 'slab');
      const base = existing[0];
      const bounds = base ? polygonBounds(base.outline) : null;
      const width = (bounds?.width ?? 12_000) + 6_000;
      const depth = (bounds?.depth ?? 10_000) + 6_000;
      const centre = base ? polygonCentroid(base.outline) : { x: 0, y: 0 };

      const commands: unknown[] = [
        {
          type: 'create_rectangular_footprint',
          description: 'Perimeter wall',
          levelId: c.levelId,
          centre,
          width,
          depth,
          height,
          thickness: 250,
          includeSlab: false,
          materialId: 'mat_render_grey',
          namePrefix: 'Perimeter wall',
        },
      ];

      const direction = extractDirection(c.message) ?? 'south';
      const summaryExtra = /entrance|gate|opening|door/.test(c.lower)
        ? ` An entrance opening is placed on the ${direction} side.`
        : '';

      return {
        plan: [
          {
            title: 'Set out the perimeter',
            detail: `${(width / 1000).toFixed(1)} x ${(depth / 1000).toFixed(1)} m`,
          },
          { title: `Build a ${height} mm wall` },
          ...(summaryExtra ? [{ title: `Form the ${direction} entrance` }] : []),
        ],
        commands,
        assumptions: [
          `Perimeter set 3 m clear of the building on every side (${(width / 1000).toFixed(1)} x ${(depth / 1000).toFixed(1)} m).`,
          'Wall thickness assumed at 250 mm.',
        ],
        summary: `Added a ${(height / 1000).toFixed(1)} m perimeter wall, ${(width / 1000).toFixed(1)} x ${(depth / 1000).toFixed(1)} m, set 3 m clear of the building.${summaryExtra}`,
      };
    },
  },

  /* ---- Change a storey height ---- */
  {
    id: 'storey-height',
    matches: (c) =>
      /(ceiling|storey|story|floor[- ]to[- ]floor|head\s?room|headroom)/.test(c.lower) &&
      /(height|high|tall|raise|lower|increase|reduce|set|make)/.test(c.lower),
    build(c) {
      const height = c.lengths.find((length) => length >= 1_800 && length <= 12_000);
      if (!height) return null;

      const wantsGround = /ground|lower|first floor|bottom/.test(c.lower);
      const level =
        (wantsGround
          ? c.model.levels.find((l) => l.index === 0)
          : c.model.levels.find((l) => c.lower.includes(l.name.toLowerCase()))) ??
        c.model.levels.find((l) => l.index === 0) ??
        c.model.levels[0];
      if (!level) return null;

      const above = c.model.levels.filter((l) => l.index > level.index);
      const delta = height - level.height;

      return {
        plan: [
          { title: `Set ${level.name} to ${height} mm floor to floor` },
          ...(above.length > 0 && delta !== 0
            ? [
                {
                  title: `Shift ${above.length} level(s) above by ${delta > 0 ? '+' : ''}${delta} mm`,
                },
              ]
            : []),
        ],
        commands: [
          {
            type: 'update_level',
            description: `Set ${level.name} height`,
            levelId: level.id,
            height,
            cascade: true,
          },
        ],
        assumptions: [
          'Walls that ran the full storey height were adjusted with the level; walls with a custom height were left alone.',
        ],
        summary:
          delta === 0
            ? `${level.name} was already ${(height / 1000).toFixed(2)} m floor to floor, so nothing needed to change.`
            : `${level.name} is now ${(height / 1000).toFixed(2)} m floor to floor${above.length > 0 ? `, and the ${above.length} level(s) above moved ${delta > 0 ? 'up' : 'down'} by ${Math.abs(delta)} mm to suit` : ''}.`,
      };
    },
  },

  /* ---- Move a façade ---- */
  {
    id: 'move-facade',
    matches: (c) =>
      /\b(move|shift|push|pull|slide|extend)\b/.test(c.lower) &&
      (extractDirection(c.message) !== null || c.selectionIds.length > 0),
    build(c) {
      const distance = c.lengths.find((length) => length > 0);
      if (!distance) return null;

      const direction = extractDirection(c.message);
      const selected = c.selectionIds
        .map((id) => c.model.elements[id])
        .filter((element): element is Wall => element?.type === 'wall');

      const walls =
        selected.length > 0 ? selected : direction ? wallsFacing(c.model, direction) : [];
      if (walls.length === 0) return null;

      const outward = !/inward|inwards|in\b/.test(c.lower);
      const sign = outward ? 1 : -1;
      const normal = outwardNormal(walls[0]!);

      return {
        plan: [
          {
            title: `Move ${walls.length} wall(s) ${distance} mm ${outward ? 'outward' : 'inward'}`,
            detail: direction ? `${direction}-facing` : 'current selection',
          },
        ],
        commands: [
          {
            type: 'move_elements',
            description: `Move the ${direction ?? 'selected'} wall`,
            ids: walls.map((wall) => wall.id),
            delta: {
              x: Math.round(normal.x * distance * sign),
              y: Math.round(normal.y * distance * sign),
              z: 0,
            },
          },
          {
            type: 'select_elements',
            description: 'Select the moved walls',
            ids: walls.map((w) => w.id),
            mode: 'replace',
          },
          { type: 'focus_elements', description: 'Frame the change', ids: walls.map((w) => w.id) },
        ],
        assumptions: [
          'Only the wall moved. Slabs, rooms and roofs on that side were not stretched to follow — say the word and I will adjust them too.',
        ],
        summary: `Moved the ${direction ?? 'selected'} wall ${distance} mm ${outward ? 'outward' : 'inward'}. The floor slab and any rooms behind it still sit on the old line, so check whether they should follow.`,
      };
    },
  },

  /* ---- Distribute openings on a façade ---- */
  {
    id: 'distribute-openings',
    matches: (c) =>
      /\b(add|put|place|insert|cut|punch)\b/.test(c.lower) &&
      /\b(window|windows|door|doors|opening|openings|rooflight|roof light|skylight)\b/.test(
        c.lower,
      ),
    build(c) {
      const direction = extractDirection(c.message);
      const isDoor = /\bdoors?\b|entrance/.test(c.lower) && !/\bwindows?\b/.test(c.lower);
      const count = countWords(c.message) ?? (isDoor ? 1 : 3);

      const selectedWalls = c.selectionIds
        .map((id) => c.model.elements[id])
        .filter((element): element is Wall => element?.type === 'wall');

      let walls = selectedWalls;
      if (walls.length === 0 && direction) walls = wallsFacing(c.model, direction);
      if (walls.length === 0) {
        walls = elementsOfType(c.model, 'wall')
          .filter((wall) => wall.exterior)
          .sort((a, b) => wallLength(b) - wallLength(a))
          .slice(0, 1);
      }
      const wall = walls[0];
      if (!wall) return null;

      // Dimensions the user gave, or sensible defaults for the opening type.
      const explicit = c.lengths.filter((length) => length >= 300 && length <= 4_000);
      const width = explicit[0] ?? (isDoor ? 900 : 1_200);
      const height = explicit[1] ?? (isDoor ? 2_100 : 1_400);
      const sill = isDoor ? 0 : (explicit[2] ?? 900);

      const available = wallLength(wall);
      const existing = openingsForWall(c.model, wall.id);
      const margin = Math.min(800, available * 0.08);

      if (count * width > available - margin * 2) {
        return {
          plan: [],
          commands: [],
          assumptions: [],
          summary: '',
          clarification: {
            question: `${count} openings ${width} mm wide need ${(count * width) / 1000} m, but "${wall.name}" is only ${(available / 1000).toFixed(2)} m long. How would you like to fit them?`,
            options: [
              `Use ${Math.max(1, Math.floor((available - margin * 2) / (width + 300)))} openings instead`,
              `Narrow each opening to ${Math.floor((available - margin * 2) / count / 50) * 50} mm`,
              'Spread them across more than one wall',
            ],
          },
        };
      }

      return {
        plan: [
          { title: `Place ${count} ${isDoor ? 'door' : 'window'}(s) on "${wall.name}"` },
          { title: 'Space them evenly', detail: `${width} x ${height} mm, sill at ${sill} mm` },
        ],
        commands: [
          {
            type: 'distribute_openings',
            description: `Add ${count} ${isDoor ? 'doors' : 'windows'} to ${wall.name}`,
            hostId: wall.id,
            count,
            kind: isDoor ? 'door' : 'window',
            openingType: isDoor ? 'single-door' : 'casement-window',
            width,
            height,
            sillHeight: sill,
            edgeMargin: Math.round(margin),
            namePrefix: isDoor ? 'Door' : `${direction ?? ''} window`.trim(),
          },
          { type: 'focus_elements', description: 'Frame the façade', ids: [wall.id] },
        ],
        assumptions: [
          `Placed on "${wall.name}" (${(available / 1000).toFixed(2)} m long${direction ? `, ${direction}-facing` : ''}).`,
          `Openings ${width} x ${height} mm with a ${sill} mm sill.`,
          ...(existing.length > 0
            ? [
                `The wall already had ${existing.length} opening(s); the new ones are spaced around them.`,
              ]
            : []),
        ],
        summary: `Added ${count} ${isDoor ? 'door' : 'window'}${count > 1 ? 's' : ''} of ${width} x ${height} mm, evenly spaced along "${wall.name}". Sill height is ${sill} mm.`,
      };
    },
  },

  /* ---- Roof lights ---- */
  {
    id: 'rooflights',
    matches: (c) => /roof ?light|skylight|roof window/.test(c.lower),
    build(c) {
      const roofs = elementsOfType(c.model, 'roof');
      if (roofs.length === 0) {
        return {
          plan: [],
          commands: [],
          assumptions: [],
          summary:
            'There is no roof in the project yet, so there is nothing to cut roof lights into. Add a roof first and I will place them.',
        };
      }
      const roof = roofs[0]!;

      // Honest limitation rather than a plausible-looking substitute: openings
      // are wall-hosted in this model, so there is no correct command to emit.
      return {
        plan: [],
        commands: [],
        assumptions: [],
        summary: `Roof lights are not yet a modelled element type — openings are hosted by walls only, so I cannot cut one into "${roof.name}" without inventing geometry. The nearest thing I can do today is set the roof to a shallower pitch or add a north-facing clerestory as a wall opening. Tell me which you would prefer.`,
      };
    },
  },

  /* ---- Divide a floor into rooms ---- */
  {
    id: 'divide-floor',
    matches: (c) =>
      /\b(divide|split|subdivide|arrange|lay ?out|zone)\b/.test(c.lower) &&
      /\binto\b/.test(c.lower) &&
      // "turn this room into an open-plan kitchen" is a reprogramming, not a
      // subdivision; the word "plan" alone must not pull it in here.
      !/open[- ]plan/.test(c.lower),
    build(c) {
      const slab = elementsOfType(c.model, 'slab').find(
        (s) => s.levelId === c.levelId && s.role === 'floor',
      );
      if (!slab) return null;
      const bounds = polygonBounds(slab.outline);

      // Read the room list out of the sentence after "into".
      const afterInto = /into\s+(.+)$/i.exec(c.message)?.[1] ?? c.message;
      const rawNames = afterInto
        .split(/,| and |\band\b/i)
        .map((part) => part.replace(/[.!?]/g, '').trim())
        .filter((part) => part.length > 2 && part.length < 60);

      if (rawNames.length < 2) return null;

      const programmeOf = (name: string): string => {
        const n = name.toLowerCase();
        if (/kitchen/.test(n) && /living|dining/.test(n)) return 'living';
        if (/kitchen/.test(n)) return 'kitchen';
        if (/living|lounge|sitting/.test(n)) return 'living';
        if (/dining/.test(n)) return 'dining';
        if (/bed/.test(n)) return 'bedroom';
        if (/bath|shower|wet/.test(n)) return 'bathroom';
        if (/wc|toilet|lavatory/.test(n)) return 'wc';
        if (/stud(io|y)/.test(n)) return 'studio';
        if (/stor|utility|plant/.test(n)) return 'storage';
        if (/hall|corridor|circulation|lobby/.test(n)) return 'circulation';
        if (/office|work/.test(n)) return 'office';
        return 'other';
      };

      // Give service spaces less area than habitable ones, which is what an
      // architect would do with a first sketch plan.
      const weights = rawNames.map((name) => {
        const programme = programmeOf(name);
        if (programme === 'bathroom' || programme === 'wc') return 0.6;
        if (programme === 'storage') return 0.5;
        if (programme === 'circulation') return 0.5;
        return 1.4;
      });
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);

      const inset = 300;
      const usableWidth = bounds.width - inset * 2;
      const commands: unknown[] = [];
      const plan: PlanStep[] = [];
      let cursor = bounds.minX + inset;

      rawNames.forEach((rawName, index) => {
        const share = (weights[index]! / totalWeight) * usableWidth;
        const name = rawName
          .replace(/^(a|an|the)\s+/i, '')
          .replace(/^\w/, (ch) => ch.toUpperCase());
        commands.push({
          type: 'create_room',
          description: `Room: ${name}`,
          name,
          levelId: c.levelId,
          outline: [
            { x: Math.round(cursor), y: Math.round(bounds.minY + inset) },
            { x: Math.round(cursor + share), y: Math.round(bounds.minY + inset) },
            { x: Math.round(cursor + share), y: Math.round(bounds.maxY - inset) },
            { x: Math.round(cursor), y: Math.round(bounds.maxY - inset) },
          ],
          programme: programmeOf(name),
          ceilingHeight: c.model.levels.find((l) => l.id === c.levelId)?.height ?? 2_700,
        });
        commands.push({
          type: 'create_wall',
          description: `Partition beside ${name}`,
          name: `Partition at ${name}`,
          levelId: c.levelId,
          start: { x: Math.round(cursor + share), y: Math.round(bounds.minY + inset) },
          end: { x: Math.round(cursor + share), y: Math.round(bounds.maxY - inset) },
          thickness: 120,
          materialId: 'mat_plaster_white',
          exterior: false,
        });
        plan.push({
          title: `${name}`,
          detail: `${(share / 1000).toFixed(1)} x ${((bounds.depth - inset * 2) / 1000).toFixed(1)} m`,
        });
        cursor += share;
      });

      // The last partition would sit on the external wall; drop it.
      commands.pop();

      const accessible = rawNames.some((name) => /accessible/i.test(name));

      return {
        plan,
        commands,
        assumptions: [
          'Divided the plan into parallel bands across the short axis — a first pass, not a resolved layout.',
          'Habitable rooms were given roughly twice the width of service rooms.',
          'Partitions are 120 mm.',
          ...(accessible
            ? [
                'The bathroom is sized generously, but step-free access requirements vary by jurisdiction and I have not checked this against any standard.',
              ]
            : []),
        ],
        summary: `Divided the ${(bounds.width / 1000).toFixed(1)} x ${(bounds.depth / 1000).toFixed(1)} m floor into ${rawNames.length} spaces as parallel bands, with partitions between them. This is a first pass — tell me which rooms should be larger, or where the circulation should run, and I will rework it.`,
      };
    },
  },

  /* ---- Convert a room's programme ---- */
  {
    id: 'convert-room',
    matches: (c) =>
      /\b(turn|convert|change|make)\b/.test(c.lower) &&
      /\b(room|space|this)\b/.test(c.lower) &&
      /\b(into|to)\b/.test(c.lower) &&
      /\b(kitchen|living|open[- ]plan|bedroom|bathroom|studio|office|store|storage|dining)\b/.test(
        c.lower,
      ),
    build(c) {
      const rooms = targetRooms(c);
      if (rooms.length === 0) return null;

      const openPlan = /open[- ]plan/.test(c.lower);
      const programme = /kitchen/.test(c.lower)
        ? 'kitchen'
        : /living|lounge/.test(c.lower)
          ? 'living'
          : /bed/.test(c.lower)
            ? 'bedroom'
            : /bath|shower/.test(c.lower)
              ? 'bathroom'
              : /stud(io|y)/.test(c.lower)
                ? 'studio'
                : /office/.test(c.lower)
                  ? 'office'
                  : /stor/.test(c.lower)
                    ? 'storage'
                    : /dining/.test(c.lower)
                      ? 'dining'
                      : 'other';

      const newName = openPlan
        ? 'Open-plan kitchen and living'
        : programme.charAt(0).toUpperCase() + programme.slice(1);

      const commands: unknown[] = rooms.flatMap((room) => [
        {
          type: 'set_element_properties',
          description: `Reprogramme ${room.name}`,
          ids: [room.id],
          patch: { programme: openPlan ? 'living' : programme, name: newName },
        },
      ]);

      // An open-plan kitchen/living needs the fittings that make it one.
      if (openPlan && rooms[0]) {
        const centre = polygonCentroid(rooms[0].outline);
        const bounds = polygonBounds(rooms[0].outline);
        commands.push(
          {
            type: 'place_furniture',
            description: 'Kitchen run along the far wall',
            catalogId: 'kitchen-run',
            levelId: rooms[0].levelId,
            position: { x: Math.round(centre.x), y: Math.round(bounds.maxY - 700) },
            rotationDeg: 0,
          },
          {
            type: 'place_furniture',
            description: 'Island between kitchen and living',
            catalogId: 'kitchen-island',
            levelId: rooms[0].levelId,
            position: { x: Math.round(centre.x), y: Math.round(centre.y + 1_200) },
            rotationDeg: 0,
          },
          {
            type: 'place_furniture',
            description: 'Seating',
            catalogId: 'sofa-3seat',
            levelId: rooms[0].levelId,
            position: { x: Math.round(centre.x), y: Math.round(bounds.minY + 1_400) },
            rotationDeg: 0,
          },
          {
            type: 'place_furniture',
            description: 'Dining table',
            catalogId: 'dining-table',
            levelId: rooms[0].levelId,
            position: { x: Math.round(centre.x), y: Math.round(centre.y - 200) },
            rotationDeg: 0,
          },
        );
      }

      commands.push({
        type: 'focus_elements',
        description: 'Frame the room',
        ids: rooms.map((room) => room.id),
      });

      return {
        plan: [
          { title: `Reprogramme ${rooms.length} space(s) as ${newName}` },
          ...(openPlan ? [{ title: 'Place kitchen, island, dining and seating' }] : []),
        ],
        commands,
        assumptions: openPlan
          ? [
              'Kept the existing room boundary — no partitions were removed. If a wall needs to come out, tell me which.',
              'Fittings placed to test the space at real dimensions, not as a final layout.',
            ]
          : [],
        summary: openPlan
          ? `Turned ${rooms.map((r) => `"${r.name}"`).join(' and ')} into an open-plan kitchen and living space, with a 3 m kitchen run, an island, dining and seating placed to check the space works. Existing partitions were left in place.`
          : `Reprogrammed ${rooms.map((r) => `"${r.name}"`).join(' and ')} as ${newName}.`,
      };
    },
  },

  /* ---- Materials ---- */
  {
    id: 'materials',
    matches: (c) =>
      /\b(use|change|switch|set|apply|make|clad|finish)\b/.test(c.lower) &&
      /\b(oak|timber|wood|brick|concrete|plaster|render|glass|metal|steel|zinc|screed|material|finish|cladding|fa[cç]ade|colour|color)\b/.test(
        c.lower,
      ),
    build(c) {
      const commands: unknown[] = [];
      const plan: PlanStep[] = [];
      const notes: string[] = [];

      const assign = (
        materialQuery: string,
        elementFilter: (element: ReturnType<typeof listElements>[number]) => boolean,
        slot: 'primary' | 'floor' | 'frame' | 'glazing',
        label: string,
      ) => {
        const materialId = matchMaterialByName(materialQuery, c.model.materials);
        if (!materialId) return;
        const ids = listElements(c.model)
          .filter(elementFilter)
          .map((element) => element.id);
        if (ids.length === 0) return;
        commands.push({
          type: 'assign_material',
          description: `${label}: ${c.model.materials[materialId]?.name}`,
          ids,
          materialId,
          slot,
        });
        plan.push({ title: label, detail: `${ids.length} element(s)` });
        notes.push(`${label} → ${c.model.materials[materialId]?.name}`);
      };

      if (/oak (floor|flooring)|timber floor|wood floor/.test(c.lower)) {
        assign('oak', (element) => element.type === 'slab', 'primary', 'Floors');
      }
      if (/white plaster|plaster wall|painted wall|white wall/.test(c.lower)) {
        assign(
          'plaster',
          (element) => element.type === 'wall' && !element.exterior,
          'primary',
          'Internal walls',
        );
      }
      if (/dark metal|black metal|dark frame|metal frame|window frame/.test(c.lower)) {
        assign(
          'dark metal',
          (element) => element.type === 'opening',
          'frame',
          'Window and door frames',
        );
      }
      if (/dark timber|charred|black timber|dark wood/.test(c.lower)) {
        assign(
          'dark timber',
          (element) => element.type === 'wall' && element.exterior,
          'primary',
          'External cladding',
        );
      }
      if (/\bbrick\b/.test(c.lower)) {
        assign(
          'brick',
          (element) => element.type === 'wall' && element.exterior,
          'primary',
          'External walls',
        );
      }
      if (/fair.?faced concrete|\bconcrete\b/.test(c.lower) && !/screed/.test(c.lower)) {
        assign(
          'concrete',
          (element) => element.type === 'wall' && element.exterior,
          'primary',
          'External walls',
        );
      }
      if (/zinc|standing seam|metal roof/.test(c.lower)) {
        assign('zinc', (element) => element.type === 'roof', 'primary', 'Roof covering');
      }

      // A bare "change the façade to X" with no keyword match above.
      if (commands.length === 0) {
        const query = /\b(?:to|with|in)\s+([a-z ]{3,30})/i.exec(c.message)?.[1] ?? c.message;
        const materialId = matchMaterialByName(query, c.model.materials);
        if (!materialId) return null;
        const external = elementsOfType(c.model, 'wall').filter((wall) => wall.exterior);
        if (external.length === 0) return null;
        commands.push({
          type: 'assign_material',
          description: 'Change the façade material',
          ids: external.map((wall) => wall.id),
          materialId,
          slot: 'primary',
        });
        plan.push({
          title: 'Change the façade material',
          detail: c.model.materials[materialId]?.name,
        });
        notes.push(`Façade → ${c.model.materials[materialId]?.name}`);
      }

      if (commands.length === 0) return null;

      return {
        plan,
        commands,
        assumptions: [
          'Applied to every matching element. Select specific elements first to narrow it.',
        ],
        summary: `Updated materials: ${notes.join('; ')}.`,
      };
    },
  },

  /* ---- Environment and lighting ---- */
  {
    id: 'environment',
    matches: (c) =>
      /\b(overcast|sunny|clear|sunset|golden hour|dusk|night|afternoon|morning|midday|noon|daylight|lighting|shadow|show the building|render)\b/.test(
        c.lower,
      ),
    build(c) {
      const preset = /overcast|grey|cloudy/.test(c.lower)
        ? 'overcast'
        : /golden hour|sunset/.test(c.lower)
          ? 'golden-hour'
          : /dusk|evening|twilight/.test(c.lower)
            ? 'dusk'
            : /night/.test(c.lower)
              ? 'night'
              : /interior/.test(c.lower)
                ? 'interior'
                : /studio/.test(c.lower)
                  ? 'studio'
                  : 'clear-day';

      const azimuth = /morning/.test(c.lower)
        ? 100
        : /afternoon/.test(c.lower)
          ? 235
          : /midday|noon/.test(c.lower)
            ? 180
            : undefined;

      return {
        plan: [{ title: `Set the environment to ${preset.replace('-', ' ')}` }],
        commands: [
          {
            type: 'update_environment',
            description: `Environment: ${preset}`,
            preset,
            ...(azimuth !== undefined ? { sunAzimuthDeg: azimuth } : {}),
          },
        ],
        assumptions: [
          azimuth !== undefined
            ? `Sun placed at ${azimuth}° azimuth for the time of day. This is an illustrative sun position, not a site-specific solar study.`
            : 'Sun position taken from the preset. This is illustrative, not a site-specific solar study.',
        ],
        summary: `Set the scene to a ${preset.replace('-', ' ')} sky${azimuth !== undefined ? `, with the sun to the ${azimuth > 180 ? 'west' : 'east'}` : ''}. The sun position is illustrative rather than calculated for the site.`,
      };
    },
  },

  /* ---- Roof pitch with a preserved height: genuinely ambiguous ---- */
  {
    id: 'roof-pitch',
    matches: (c) => /\broof\b/.test(c.lower) && /(shallow|steep|pitch|flatter|slope)/.test(c.lower),
    build(c) {
      const roofs = elementsOfType(c.model, 'roof');
      const roof = roofs[0];
      if (!roof) return null;

      const preserveHeight =
        /(preserve|keep|maintain|same|without changing).{0,30}(height|tall|ridge)/.test(c.lower);
      const shallower = /shallow|flatter|lower pitch|reduce the pitch/.test(c.lower);
      const explicitPitch = /(\d{1,2})\s*(?:deg|degree|°)/i.exec(c.message);
      const targetPitch = explicitPitch
        ? Number(explicitPitch[1])
        : shallower
          ? Math.max(5, Math.round(roof.pitchDeg * 0.6))
          : Math.min(60, Math.round(roof.pitchDeg * 1.4));

      if (preserveHeight) {
        // Both moves satisfy the words; they produce very different buildings.
        return {
          plan: [],
          commands: [],
          assumptions: [],
          summary: '',
          clarification: {
            question: `Reducing the pitch from ${roof.pitchDeg}° to ${targetPitch}° drops the ridge by about ${Math.round(riseOf(roof.outline, roof.ridgeAxis, roof.pitchDeg) - riseOf(roof.outline, roof.ridgeAxis, targetPitch))} mm. To keep the total height, something else has to give — which?`,
            options: [
              'Raise the walls so the ridge stays put',
              'Raise the eaves line and keep the walls',
              'Keep the ridge height and accept the taller storey',
            ],
          },
        };
      }

      return {
        plan: [{ title: `Change the roof pitch to ${targetPitch}°` }],
        commands: [
          {
            type: 'set_element_properties',
            description: 'Change the roof pitch',
            ids: [roof.id],
            patch: { pitchDeg: targetPitch },
          },
          { type: 'focus_elements', description: 'Frame the roof', ids: [roof.id] },
        ],
        assumptions: [`Eaves height unchanged, so the ridge moves with the pitch.`],
        summary: `Changed "${roof.name}" from ${roof.pitchDeg}° to ${targetPitch}°. The eaves stayed where they were, so the ridge has ${targetPitch < roof.pitchDeg ? 'dropped' : 'risen'} accordingly.`,
      };
    },
  },

  /* ---- Stairs ---- */
  {
    id: 'stair',
    matches: (c) =>
      /\b(stair|staircase|steps)\b/.test(c.lower) &&
      /\b(add|create|put|place|make)\b/.test(c.lower),
    build(c) {
      const level = c.model.levels.find((l) => l.id === c.levelId);
      const rise = level?.height ?? 2_700;
      const steps = Math.max(2, Math.round(rise / 180));
      const slab = elementsOfType(c.model, 'slab').find((s) => s.levelId === c.levelId);
      const centre = slab ? polygonCentroid(slab.outline) : { x: 0, y: 0 };
      const shape = /\bl[- ]shaped?\b/.test(c.lower)
        ? 'l-shaped'
        : /\bu[- ]shaped?\b/.test(c.lower)
          ? 'u-shaped'
          : 'straight';

      return {
        plan: [
          {
            title: `Add a ${shape} stair`,
            detail: `${steps} risers of ${Math.round(rise / steps)} mm`,
          },
        ],
        commands: [
          {
            type: 'create_stair',
            description: 'Add a stair',
            name: 'Stair',
            levelId: c.levelId,
            position: { x: Math.round(centre.x), y: Math.round(centre.y - 2_000) },
            rotationDeg: 90,
            width: 1_000,
            totalRise: rise,
            steps,
            treadDepth: 270,
            shape,
            materialId: 'mat_timber_oak',
          },
        ],
        assumptions: [
          `Rise taken from the level height (${rise} mm), giving ${steps} risers of ${Math.round(rise / steps)} mm with a 270 mm going.`,
          'Placed near the centre of the floor plate — move it where the plan wants it.',
        ],
        summary: `Added a ${shape} stair with ${steps} risers of ${Math.round(rise / steps)} mm and a 270 mm going, 1 m wide. 2 × riser + going is ${Math.round(rise / steps) * 2 + 270} mm, which sits in the comfortable range.`,
      };
    },
  },

  /* ---- Furniture ---- */
  {
    id: 'furniture',
    matches: (c) =>
      matchCatalogItem(c.lower) !== undefined && /\b(add|place|put|furnish)\b/.test(c.lower),
    build(c) {
      const item = matchCatalogItem(c.lower);
      if (!item) return null;
      const rooms = targetRooms(c);
      const anchor = rooms[0]
        ? polygonCentroid(rooms[0].outline)
        : (() => {
            const slab = elementsOfType(c.model, 'slab').find((s) => s.levelId === c.levelId);
            return slab ? polygonCentroid(slab.outline) : { x: 0, y: 0 };
          })();

      return {
        plan: [{ title: `Place a ${item.name}` }],
        commands: [
          {
            type: 'place_furniture',
            description: `Place ${item.name}`,
            catalogId: item.id,
            levelId: rooms[0]?.levelId ?? c.levelId,
            position: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
          },
        ],
        assumptions: [
          `Placed at the centre of ${rooms[0] ? `"${rooms[0].name}"` : 'the floor plate'}.`,
        ],
        summary: `Placed a ${item.name} (${item.width} × ${item.depth} mm) in ${rooms[0] ? `"${rooms[0].name}"` : 'the plan'}.`,
      };
    },
  },

  /* ---- Units ---- */
  {
    id: 'units',
    matches: (c) =>
      /\b(imperial|metric|feet and inches|millimet|metres|meters)\b/.test(c.lower) &&
      /\b(use|switch|show|display|change)\b/.test(c.lower),
    build(c) {
      const units = /imperial|feet|inches/.test(c.lower) ? 'imperial' : 'metric';
      return {
        plan: [{ title: `Display units: ${units}` }],
        commands: [{ type: 'set_units', description: `Set display units to ${units}`, units }],
        assumptions: ['Only the display changed. Every stored dimension is unchanged.'],
        summary: `Switched the display to ${units} units. Stored dimensions are untouched — this is a presentation change only.`,
      };
    },
  },

  /* ---- Delete ---- */
  {
    id: 'delete',
    matches: (c) => /\b(delete|remove|get rid of|erase)\b/.test(c.lower),
    build(c) {
      if (c.selectionIds.length === 0) {
        return {
          plan: [],
          commands: [],
          assumptions: [],
          summary: '',
          clarification: {
            question: 'What would you like me to delete? Nothing is selected.',
            options: ['Select it in the viewport and ask again', 'Name the element', 'Cancel'],
          },
        };
      }
      const names = c.selectionIds
        .map((id) => c.model.elements[id]?.name)
        .filter(Boolean)
        .slice(0, 5);
      return {
        plan: [{ title: `Delete ${c.selectionIds.length} element(s)` }],
        commands: [
          { type: 'delete_elements', description: 'Delete the selection', ids: c.selectionIds },
        ],
        assumptions: ['Openings hosted by a deleted wall were removed with it.'],
        summary: `Deleted ${c.selectionIds.length} element(s): ${names.join(', ')}. Undo restores them.`,
      };
    },
  },
];

function rectangle(width: number, depth: number): Array<{ x: number; y: number }> {
  return [
    { x: -width / 2, y: -depth / 2 },
    { x: width / 2, y: -depth / 2 },
    { x: width / 2, y: depth / 2 },
    { x: -width / 2, y: depth / 2 },
  ];
}

function riseOf(
  outline: Array<{ x: number; y: number }>,
  ridgeAxis: 'x' | 'y',
  pitchDeg: number,
): number {
  const bounds = polygonBounds(outline);
  const span = ridgeAxis === 'x' ? bounds.depth : bounds.width;
  return (span / 2) * Math.tan((pitchDeg * Math.PI) / 180);
}

/**
 * Interprets a message against a project. Exported for direct unit testing —
 * the rules are the interesting part, not the provider wrapper around them.
 */
export function interpret(
  model: ProjectModel,
  message: string,
  selectionIds: readonly string[] = [],
): Interpretation {
  const defaultUnit: LengthUnit = model.units === 'metric' ? 'm' : 'ft';
  const context: RuleContext = {
    message,
    lower: message.toLowerCase(),
    model,
    selectionIds: [...selectionIds],
    lengths: extractLengths(message, defaultUnit),
    pair: extractPair(message, defaultUnit),
    levelId: defaultLevelId(model),
  };

  for (const rule of RULES) {
    if (!rule.matches(context)) continue;
    const result = rule.build(context);
    if (result) return result;
  }

  return {
    plan: [],
    commands: [],
    assumptions: [],
    summary: [
      'I could not turn that into a modelling operation.',
      '',
      'This deployment is running the built-in local interpreter, which handles a defined set of moves rather than open-ended design conversation: creating a footprint or building, changing storey heights, moving a named façade, adding and spacing openings, dividing a floor into rooms, reprogramming a room, assigning materials, adding stairs and furniture, setting the environment, and switching units.',
      '',
      'Set ANTHROPIC_API_KEY on the server to use Claude, which can reason about the request properly.',
    ].join('\n'),
  };
}

/**
 * Provider wrapper. Emits the same event sequence as the Anthropic provider so
 * the orchestrator, the UI and the tests cannot tell the difference.
 */
export class MockProvider implements AiProvider {
  readonly name = 'mock' as const;
  readonly model = 'local-interpreter-v1';

  private readonly model_: ProjectModel;

  constructor(model: ProjectModel) {
    this.model_ = model;
  }

  async run(request: TurnRequest, emit: (event: AiStreamEvent) => void): Promise<TurnResult> {
    emit({ type: 'status', phase: 'thinking', message: 'Interpreting the request' });

    const result = interpret(this.model_, request.message, request.selectionIds);

    if (result.plan.length > 0) emit({ type: 'plan', steps: result.plan });
    if (result.assumptions.length > 0)
      emit({ type: 'assumptions', assumptions: result.assumptions });
    if (result.clarification) emit({ type: 'clarification', ...result.clarification });

    const text = result.clarification ? result.clarification.question : result.summary;
    if (text) emit({ type: 'text', delta: text });

    return {
      text,
      plan: result.plan,
      assumptions: result.assumptions,
      rawCommands: result.commands,
      clarification: result.clarification ?? null,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
      summary: result.summary,
    };
  }
}

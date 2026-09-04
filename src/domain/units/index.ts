/**
 * Units.
 *
 * The single most important invariant in this codebase:
 *
 *   **Every length stored in the project model is in millimetres (mm).**
 *
 * Millimetres are the unit architects detail in, they keep typical building
 * dimensions comfortably inside IEEE-754 exact-integer range, and they avoid
 * the accumulating float drift you get from storing metres. Areas are stored in
 * square millimetres, angles in degrees, and everything is converted at the
 * boundary: on input (AI commands, form fields, importers) and on output
 * (inspector labels, exporters, the Three.js scene, which uses metres).
 *
 * `DisplayUnitSystem` only ever affects presentation. Switching a project from
 * metric to imperial does not touch a single stored number.
 */

export const LENGTH_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

export const DISPLAY_UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type DisplayUnitSystem = (typeof DISPLAY_UNIT_SYSTEMS)[number];

/** Millimetres per one unit of the given length unit. Exact by definition. */
const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** Three.js works in metres; this is the scale factor from stored mm. */
export const MM_TO_SCENE = 0.001;

export function toMillimetres(value: number, unit: LengthUnit): number {
  return value * MM_PER_UNIT[unit];
}

export function fromMillimetres(mm: number, unit: LengthUnit): number {
  return mm / MM_PER_UNIT[unit];
}

export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  if (from === to) return value;
  return fromMillimetres(toMillimetres(value, from), to);
}

/** Square millimetres to square metres. */
export function mm2ToM2(mm2: number): number {
  return mm2 / 1_000_000;
}

/** Square millimetres to square feet. */
export function mm2ToFt2(mm2: number): number {
  return mm2 / (304.8 * 304.8);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Formats a stored millimetre value for display.
 *
 * Metric picks mm below one metre and metres above, because that is how
 * drawings are annotated. Imperial renders feet-and-inches with a
 * sixteenth-of-an-inch fraction, which is what a US set would show.
 */
export function formatLength(
  mm: number,
  system: DisplayUnitSystem,
  options: { precision?: number; forceUnit?: LengthUnit } = {},
): string {
  if (!Number.isFinite(mm)) return '—';
  const sign = mm < 0 ? '-' : '';
  const abs = Math.abs(mm);

  if (options.forceUnit) {
    const unit = options.forceUnit;
    const precision = options.precision ?? (unit === 'mm' ? 0 : 3);
    return `${sign}${round(fromMillimetres(abs, unit), precision)} ${unit}`;
  }

  if (system === 'metric') {
    if (abs < 1000) return `${sign}${round(abs, options.precision ?? 0)} mm`;
    return `${sign}${round(abs / 1000, options.precision ?? 3)} m`;
  }

  return `${sign}${formatFeetInches(abs)}`;
}

/** Renders millimetres as `12' 6 1/2"`, rounded to the nearest 1/16". */
export function formatFeetInches(mm: number): string {
  const totalInches = mm / 25.4;
  const sixteenths = Math.round(totalInches * 16);
  const feet = Math.floor(sixteenths / (12 * 16));
  const remainder = sixteenths - feet * 12 * 16;
  const inches = Math.floor(remainder / 16);
  let numerator = remainder - inches * 16;
  let denominator = 16;
  while (numerator > 0 && numerator % 2 === 0) {
    numerator /= 2;
    denominator /= 2;
  }
  const fraction = numerator > 0 ? ` ${numerator}/${denominator}` : '';
  if (feet === 0) return `${inches}${fraction}"`;
  if (inches === 0 && numerator === 0) return `${feet}'`;
  return `${feet}' ${inches}${fraction}"`;
}

export function formatArea(mm2: number, system: DisplayUnitSystem, precision = 2): string {
  if (!Number.isFinite(mm2)) return '—';
  return system === 'metric'
    ? `${round(mm2ToM2(mm2), precision)} m²`
    : `${round(mm2ToFt2(mm2), precision)} sq ft`;
}

/** Angles are always stored in degrees; radians only exist inside geometry code. */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Parses human dimension input into millimetres.
 *
 * Accepts `2400`, `2400mm`, `2.4m`, `2,4 m`, `8ft`, `8'`, `8' 6"`, `96in`,
 * `96"`. Bare numbers use `defaultUnit`, which callers set from the project's
 * display system so a student typing `12` into a metric project gets 12 m and
 * not 12 mm. Returns `null` when the text is not a dimension at all — callers
 * decide whether that is an error or simply "leave unchanged".
 */
export function parseLengthToMm(input: string, defaultUnit: LengthUnit = 'm'): number | null {
  const text = input.trim().toLowerCase().replace(/,/g, '.');
  if (!text) return null;

  // Feet and inches: 8' 6", 8'6, 8 ft 6 in
  const feetInches = text.match(
    /^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)?)?$/,
  );
  if (feetInches) {
    const feet = Number(feetInches[1]);
    const inches = feetInches[2] ? Number(feetInches[2]) : 0;
    const sign = feet < 0 ? -1 : 1;
    return sign * (Math.abs(feet) * 304.8 + inches * 25.4);
  }

  const single = text.match(
    /^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|ft|"|millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|inch(?:es)?|feet|foot)?$/,
  );
  if (!single) return null;
  const value = Number(single[1]);
  if (!Number.isFinite(value)) return null;

  const raw = single[2];
  if (!raw) return toMillimetres(value, defaultUnit);

  const unit = normaliseUnitWord(raw);
  return unit ? toMillimetres(value, unit) : null;
}

export function normaliseUnitWord(word: string): LengthUnit | null {
  switch (word.toLowerCase()) {
    case 'mm':
    case 'millimeter':
    case 'millimeters':
    case 'millimetre':
    case 'millimetres':
      return 'mm';
    case 'cm':
    case 'centimeter':
    case 'centimeters':
    case 'centimetre':
    case 'centimetres':
      return 'cm';
    case 'm':
    case 'meter':
    case 'meters':
    case 'metre':
    case 'metres':
      return 'm';
    case 'in':
    case '"':
    case 'inch':
    case 'inches':
      return 'in';
    case 'ft':
    case "'":
    case 'foot':
    case 'feet':
      return 'ft';
    default:
      return null;
  }
}

/** The unit a bare number should be read as, given the project's display system. */
export function defaultInputUnit(system: DisplayUnitSystem): LengthUnit {
  return system === 'metric' ? 'm' : 'ft';
}

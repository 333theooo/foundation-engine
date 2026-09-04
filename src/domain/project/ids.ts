/**
 * Identifier generation.
 *
 * Element ids must be stable across save/load, readable enough that an AI
 * transcript or a validation error is intelligible, and collision-free without
 * a round trip to the server. We use a short human prefix plus a 12-character
 * base36 random suffix drawn from the platform CSPRNG (~62 bits), which is
 * ample for the few thousand elements a project can hold.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
    return bytes;
  }
  // Non-browser fallback (older Node without global crypto).
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function randomSuffix(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

export type IdPrefix =
  | 'wall'
  | 'slab'
  | 'room'
  | 'open'
  | 'roof'
  | 'stair'
  | 'col'
  | 'beam'
  | 'rail'
  | 'furn'
  | 'grp'
  | 'imp'
  | 'lvl'
  | 'mat'
  | 'view'
  | 'cons'
  | 'meas'
  | 'light'
  | 'cmd'
  | 'txn'
  | 'proj';

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomSuffix()}`;
}

const ELEMENT_PREFIX: Record<string, IdPrefix> = {
  wall: 'wall',
  slab: 'slab',
  room: 'room',
  opening: 'open',
  roof: 'roof',
  stair: 'stair',
  column: 'col',
  beam: 'beam',
  railing: 'rail',
  furniture: 'furn',
  group: 'grp',
  imported: 'imp',
};

export function createElementId(elementType: string): string {
  return createId(ELEMENT_PREFIX[elementType] ?? 'grp');
}

/**
 * Makes `candidate` unique within `taken` by appending `-2`, `-3`, … .
 * Used when duplicating elements and when an importer supplies its own ids.
 */
export function uniqueId(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 10_000; n += 1) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${randomSuffix(6)}`;
}

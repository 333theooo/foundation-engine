import type { MaterialDefinition } from './schema';

/**
 * The starter material library.
 *
 * Every project begins with these so the AI never has to invent a material id
 * before it can build a wall, and so a new project looks like architecture
 * rather than untextured grey boxes. Users and the AI can add more, edit these,
 * or ignore them entirely.
 *
 * `textureRef` points at a procedural texture generated on the client (see
 * `src/three/textures.ts`) — no binary assets ship in the repo.
 */

export const DEFAULT_MATERIALS: MaterialDefinition[] = [
  {
    id: 'mat_plaster_white',
    name: 'White plaster',
    category: 'wall',
    color: '#eceae5',
    roughness: 0.92,
    metalness: 0,
    opacity: 1,
    textureRef: 'plaster',
    textureScaleMm: 2000,
    emissiveIntensity: 0,
    description: 'Smooth painted internal plaster finish.',
  },
  {
    id: 'mat_render_grey',
    name: 'Grey render',
    category: 'wall',
    color: '#9a9a95',
    roughness: 0.95,
    metalness: 0,
    opacity: 1,
    textureRef: 'plaster',
    textureScaleMm: 2500,
    emissiveIntensity: 0,
    description: 'External cementitious render.',
  },
  {
    id: 'mat_brick_red',
    name: 'Red brick',
    category: 'masonry',
    color: '#8d4a3a',
    roughness: 0.95,
    metalness: 0,
    opacity: 1,
    textureRef: 'brick',
    textureScaleMm: 1200,
    emissiveIntensity: 0,
    description: 'Stretcher-bond facing brickwork.',
  },
  {
    id: 'mat_concrete_fair',
    name: 'Fair-faced concrete',
    category: 'concrete',
    color: '#a8a49d',
    roughness: 0.85,
    metalness: 0,
    opacity: 1,
    textureRef: 'concrete',
    textureScaleMm: 3000,
    emissiveIntensity: 0,
    description: 'Board-marked in-situ concrete.',
  },
  {
    id: 'mat_timber_oak',
    name: 'Oak',
    category: 'timber',
    color: '#b6885a',
    roughness: 0.6,
    metalness: 0,
    opacity: 1,
    textureRef: 'timber',
    textureScaleMm: 1500,
    emissiveIntensity: 0,
    description: 'Light oak boards, suitable for flooring and joinery.',
  },
  {
    id: 'mat_timber_dark',
    name: 'Dark stained timber',
    category: 'timber',
    color: '#4a3728',
    roughness: 0.7,
    metalness: 0,
    opacity: 1,
    textureRef: 'timber',
    textureScaleMm: 1500,
    emissiveIntensity: 0,
    description: 'Charred or dark-stained timber cladding.',
  },
  {
    id: 'mat_glass_clear',
    name: 'Clear glazing',
    category: 'glazing',
    color: '#bfe0ea',
    roughness: 0.05,
    metalness: 0,
    opacity: 0.28,
    textureRef: null,
    textureScaleMm: 1000,
    emissiveIntensity: 0,
    description: 'Double-glazed clear unit.',
  },
  {
    id: 'mat_metal_dark',
    name: 'Dark metal',
    category: 'metal',
    color: '#2f3237',
    roughness: 0.4,
    metalness: 0.85,
    opacity: 1,
    textureRef: null,
    textureScaleMm: 1000,
    emissiveIntensity: 0,
    description: 'Powder-coated aluminium, typical of window frames.',
  },
  {
    id: 'mat_screed_grey',
    name: 'Polished screed',
    category: 'floor',
    color: '#8f9195',
    roughness: 0.35,
    metalness: 0,
    opacity: 1,
    textureRef: 'concrete',
    textureScaleMm: 4000,
    emissiveIntensity: 0,
    description: 'Power-floated screed floor finish.',
  },
  {
    id: 'mat_roof_membrane',
    name: 'Roof membrane',
    category: 'roof',
    color: '#3a3d41',
    roughness: 0.9,
    metalness: 0,
    opacity: 1,
    textureRef: null,
    textureScaleMm: 2000,
    emissiveIntensity: 0,
    description: 'Single-ply flat roof membrane.',
  },
  {
    id: 'mat_roof_zinc',
    name: 'Standing seam zinc',
    category: 'roof',
    color: '#6e7278',
    roughness: 0.45,
    metalness: 0.6,
    opacity: 1,
    textureRef: 'seam',
    textureScaleMm: 600,
    emissiveIntensity: 0,
    description: 'Standing-seam metal roof covering.',
  },
  {
    id: 'mat_generic',
    name: 'Working grey',
    category: 'generic',
    color: '#b7b7b7',
    roughness: 0.8,
    metalness: 0,
    opacity: 1,
    textureRef: null,
    textureScaleMm: 1000,
    emissiveIntensity: 0,
    description: 'Neutral placeholder material.',
  },
];

/** Sensible default per element type so commands can omit `materialId`. */
export const DEFAULT_MATERIAL_FOR: Record<string, string> = {
  wall: 'mat_plaster_white',
  slab: 'mat_screed_grey',
  roof: 'mat_roof_membrane',
  stair: 'mat_concrete_fair',
  column: 'mat_concrete_fair',
  beam: 'mat_concrete_fair',
  railing: 'mat_metal_dark',
  furniture: 'mat_generic',
  room: 'mat_screed_grey',
};

export function defaultMaterialMap(): Record<string, MaterialDefinition> {
  return Object.fromEntries(DEFAULT_MATERIALS.map((m) => [m.id, { ...m }]));
}

/**
 * Resolves a natural-language material description to a library id.
 * Used by the deterministic interpreter and as a fallback when the AI names a
 * material that does not exist yet.
 */
export function matchMaterialByName(
  query: string,
  materials: Record<string, MaterialDefinition>,
): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const entries = Object.values(materials);

  const exact = entries.find((m) => m.name.toLowerCase() === q || m.id === query);
  if (exact) return exact.id;

  const partial = entries.find(
    (m) => m.name.toLowerCase().includes(q) || q.includes(m.name.toLowerCase()),
  );
  if (partial) return partial.id;

  const keywords: Array<[RegExp, string]> = [
    [/oak|light\s*timber|light\s*wood/, 'mat_timber_oak'],
    [/dark\s*(timber|wood)|charred|char|shou\s*sugi/, 'mat_timber_dark'],
    [/brick/, 'mat_brick_red'],
    [/concrete|beton/, 'mat_concrete_fair'],
    [/glass|glaz/, 'mat_glass_clear'],
    [/metal|steel|aluminium|aluminum|zinc/, 'mat_metal_dark'],
    [/plaster|white\s*wall|painted/, 'mat_plaster_white'],
    [/render|stucco/, 'mat_render_grey'],
    [/screed|polished/, 'mat_screed_grey'],
    [/membrane|felt/, 'mat_roof_membrane'],
  ];
  for (const [pattern, id] of keywords) {
    if (pattern.test(q) && materials[id]) return id;
  }
  return null;
}

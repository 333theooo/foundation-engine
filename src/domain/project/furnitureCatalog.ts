/**
 * Furniture and context catalogue.
 *
 * The AI may only place items that exist here. That is the point: an
 * allowlisted catalogue means a model response can never cause arbitrary
 * geometry to be constructed, and every item carries real-world dimensions so
 * a placed sofa is a check on room size rather than decoration.
 *
 * Sizes are millimetres. `parts` are axis-aligned boxes in local space, with
 * the item's origin at the centre of its footprint on the floor.
 */

export interface CatalogPart {
  /** Centre of the box in local mm, y measured up from the floor. */
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
  color?: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  category:
    | 'seating'
    | 'table'
    | 'storage'
    | 'bed'
    | 'sanitary'
    | 'kitchen'
    | 'context'
    | 'planting';
  width: number;
  depth: number;
  height: number;
  color: string;
  parts: CatalogPart[];
  /** Short description shown in the palette and used for AI matching. */
  keywords: string[];
}

function box(
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  color?: string,
): CatalogPart {
  return color === undefined ? { cx, cy, cz, w, h, d } : { cx, cy, cz, w, h, d, color };
}

export const FURNITURE_CATALOG: CatalogItem[] = [
  {
    id: 'sofa-3seat',
    name: 'Three-seat sofa',
    category: 'seating',
    width: 2100,
    depth: 900,
    height: 800,
    color: '#6a6f78',
    keywords: ['sofa', 'couch', 'settee', 'lounge'],
    parts: [
      box(0, 200, 0, 2100, 400, 900),
      box(0, 550, -350, 2100, 300, 200),
      box(-975, 500, 0, 150, 200, 900),
      box(975, 500, 0, 150, 200, 900),
    ],
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'seating',
    width: 800,
    depth: 800,
    height: 780,
    color: '#7a6a5c',
    keywords: ['armchair', 'chair', 'easy chair'],
    parts: [box(0, 200, 0, 800, 400, 800), box(0, 550, -300, 800, 300, 200)],
  },
  {
    id: 'dining-chair',
    name: 'Dining chair',
    category: 'seating',
    width: 450,
    depth: 500,
    height: 850,
    color: '#8a7350',
    keywords: ['chair', 'dining chair', 'seat'],
    parts: [box(0, 440, 0, 450, 60, 500), box(0, 650, -220, 450, 420, 50)],
  },
  {
    id: 'dining-table',
    name: 'Dining table',
    category: 'table',
    width: 1800,
    depth: 900,
    height: 750,
    color: '#a8834f',
    keywords: ['table', 'dining table'],
    parts: [
      box(0, 725, 0, 1800, 50, 900),
      box(-800, 350, -380, 80, 700, 80),
      box(800, 350, -380, 80, 700, 80),
      box(-800, 350, 380, 80, 700, 80),
      box(800, 350, 380, 80, 700, 80),
    ],
  },
  {
    id: 'desk',
    name: 'Desk',
    category: 'table',
    width: 1600,
    depth: 700,
    height: 740,
    color: '#9d9d9d',
    keywords: ['desk', 'workstation', 'study table'],
    parts: [
      box(0, 715, 0, 1600, 50, 700),
      box(-760, 350, 0, 60, 690, 700),
      box(760, 350, 0, 60, 690, 700),
    ],
  },
  {
    id: 'coffee-table',
    name: 'Coffee table',
    category: 'table',
    width: 1100,
    depth: 600,
    height: 400,
    color: '#8a7350',
    keywords: ['coffee table', 'low table'],
    parts: [box(0, 380, 0, 1100, 40, 600), box(0, 180, 0, 900, 360, 450)],
  },
  {
    id: 'bed-double',
    name: 'Double bed',
    category: 'bed',
    width: 1500,
    depth: 2000,
    height: 600,
    color: '#c6c1b6',
    keywords: ['bed', 'double bed', 'queen'],
    parts: [box(0, 250, 0, 1500, 500, 2000), box(0, 500, -980, 1500, 500, 60, '#7a6a5c')],
  },
  {
    id: 'bed-single',
    name: 'Single bed',
    category: 'bed',
    width: 900,
    depth: 2000,
    height: 600,
    color: '#c6c1b6',
    keywords: ['single bed', 'bed'],
    parts: [box(0, 250, 0, 900, 500, 2000), box(0, 500, -980, 900, 500, 60, '#7a6a5c')],
  },
  {
    id: 'wardrobe',
    name: 'Wardrobe',
    category: 'storage',
    width: 1200,
    depth: 600,
    height: 2100,
    color: '#8f8a80',
    keywords: ['wardrobe', 'closet', 'cupboard'],
    parts: [box(0, 1050, 0, 1200, 2100, 600)],
  },
  {
    id: 'shelving',
    name: 'Shelving unit',
    category: 'storage',
    width: 900,
    depth: 350,
    height: 1800,
    color: '#a8834f',
    keywords: ['shelf', 'shelving', 'bookcase'],
    parts: [
      box(-430, 900, 0, 40, 1800, 350),
      box(430, 900, 0, 40, 1800, 350),
      box(0, 450, 0, 900, 30, 350),
      box(0, 900, 0, 900, 30, 350),
      box(0, 1350, 0, 900, 30, 350),
      box(0, 1780, 0, 900, 40, 350),
    ],
  },
  {
    id: 'kitchen-run',
    name: 'Kitchen counter run',
    category: 'kitchen',
    width: 3000,
    depth: 650,
    height: 900,
    color: '#7f8489',
    keywords: ['kitchen', 'counter', 'worktop', 'cabinets'],
    parts: [box(0, 440, 0, 3000, 880, 650), box(0, 900, 0, 3040, 40, 670, '#3d4045')],
  },
  {
    id: 'kitchen-island',
    name: 'Kitchen island',
    category: 'kitchen',
    width: 2000,
    depth: 1000,
    height: 900,
    color: '#7f8489',
    keywords: ['island', 'kitchen island'],
    parts: [box(0, 440, 0, 2000, 880, 1000), box(0, 900, 0, 2100, 40, 1080, '#3d4045')],
  },
  {
    id: 'wc',
    name: 'WC',
    category: 'sanitary',
    width: 400,
    depth: 700,
    height: 800,
    color: '#f2f2f0',
    keywords: ['wc', 'toilet', 'lavatory'],
    parts: [box(0, 200, 50, 380, 400, 600), box(0, 550, -280, 400, 700, 180)],
  },
  {
    id: 'washbasin',
    name: 'Wash basin',
    category: 'sanitary',
    width: 600,
    depth: 450,
    height: 850,
    color: '#f2f2f0',
    keywords: ['basin', 'sink', 'washbasin', 'lavatory'],
    parts: [box(0, 800, 0, 600, 150, 450), box(0, 500, -180, 200, 450, 120)],
  },
  {
    id: 'shower',
    name: 'Shower tray',
    category: 'sanitary',
    width: 900,
    depth: 900,
    height: 2000,
    color: '#cfd8dc',
    keywords: ['shower', 'shower tray'],
    parts: [box(0, 60, 0, 900, 120, 900), box(0, 1060, 440, 900, 1880, 20, '#bfe0ea')],
  },
  {
    id: 'tree-medium',
    name: 'Tree',
    category: 'planting',
    width: 4000,
    depth: 4000,
    height: 6000,
    color: '#3f6b46',
    keywords: ['tree', 'planting', 'landscape'],
    parts: [box(0, 1200, 0, 300, 2400, 300, '#5a4632'), box(0, 4000, 0, 3600, 3600, 3600)],
  },
  {
    id: 'car',
    name: 'Car',
    category: 'context',
    width: 1800,
    depth: 4400,
    height: 1450,
    color: '#5a6068',
    keywords: ['car', 'vehicle', 'parking'],
    parts: [box(0, 500, 0, 1800, 700, 4400), box(0, 1120, 200, 1600, 540, 2200, '#2c3238')],
  },
  {
    id: 'person',
    name: 'Person (scale figure)',
    category: 'context',
    width: 500,
    depth: 350,
    height: 1750,
    color: '#8892a0',
    keywords: ['person', 'figure', 'scale figure', 'human'],
    parts: [
      box(0, 450, 0, 400, 900, 250),
      box(0, 1200, 0, 450, 600, 280),
      box(0, 1620, 0, 220, 240, 220),
    ],
  },
];

const BY_ID = new Map(FURNITURE_CATALOG.map((item) => [item.id, item]));

export function getCatalogItem(id: string): CatalogItem | undefined {
  return BY_ID.get(id);
}

export function catalogIds(): string[] {
  return FURNITURE_CATALOG.map((item) => item.id);
}

/** Loose keyword match, used by the deterministic interpreter. */
export function matchCatalogItem(query: string): CatalogItem | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    BY_ID.get(q) ??
    FURNITURE_CATALOG.find((item) => item.name.toLowerCase() === q) ??
    FURNITURE_CATALOG.find((item) => item.keywords.some((k) => q.includes(k)))
  );
}

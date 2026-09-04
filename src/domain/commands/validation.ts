import { formatLength } from '@/domain/units';
import {
  elementsOfType,
  listElements,
  openingsForWall,
  polygonArea,
  wallLength,
} from '@/domain/project/queries';
import type { ProjectModel } from '@/domain/project/schema';
import { signedArea } from '@/domain/geometry/polygon';

/**
 * Architectural review.
 *
 * This is deliberately *not* code compliance. Building regulations are
 * jurisdictional, they change, and a schematic model does not carry the
 * information a real check needs. What this does is catch the things that make a
 * concept model wrong on its own terms — a stair nobody could climb, an opening
 * wider than its wall, a room with no area — and flag conventions that are
 * near-universal so a student learns them, always labelled as guidance.
 *
 * Findings never block a transaction. They are advice, surfaced in the
 * inspector and handed to the AI as context.
 */

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface ValidationFinding {
  id: string;
  severity: FindingSeverity;
  /** The element the finding is about, when it has one. */
  elementId?: string;
  title: string;
  detail: string;
  /** What to do about it, phrased as an action. */
  suggestion?: string;
  /**
   * Set when the finding restates a widely-used rule of thumb rather than a
   * geometric fact. The UI shows these with an explicit "not a code check" note.
   */
  conventionSource?: string;
}

/** Rules of thumb used below. Every one is a convention, not a regulation. */
export const DESIGN_GUIDANCE = {
  /** 2 × riser + going ≈ 600–640 mm (Blondel's rule). */
  stairComfortMin: 550,
  stairComfortMax: 700,
  maxComfortableRiser: 190,
  minComfortableGoing: 240,
  minStairWidth: 800,
  minCorridorWidth: 900,
  minAccessibleDoorClearWidth: 800,
  minCeilingHeight: 2300,
  minHabitableRoomArea: 6_500_000, // 6.5 m² in mm²
  maxWallSlendernessRatio: 40,
  minWindowHeadClearance: 100,
} as const;

let counter = 0;
function finding(
  severity: FindingSeverity,
  title: string,
  detail: string,
  extra: Partial<ValidationFinding> = {},
): ValidationFinding {
  counter += 1;
  return { id: `find_${counter}`, severity, title, detail, ...extra };
}

/**
 * Reviews a whole model. Runs after every transaction, so it must stay linear
 * in element count — no pairwise geometry across the whole project.
 */
export function validateModel(model: ProjectModel): ValidationFinding[] {
  counter = 0;
  const findings: ValidationFinding[] = [];
  const units = model.units;

  const levelIds = new Set(model.levels.map((l) => l.id));

  for (const element of listElements(model)) {
    if ('levelId' in element && element.levelId && !levelIds.has(element.levelId)) {
      findings.push(
        finding(
          'error',
          'Element references a missing level',
          `"${element.name}" points at level "${element.levelId}", which no longer exists.`,
          {
            elementId: element.id,
            suggestion: 'Reassign the element to an existing level, or recreate the level.',
          },
        ),
      );
    }

    switch (element.type) {
      case 'wall': {
        const length = wallLength(element);
        if (length < 50) {
          findings.push(
            finding(
              'error',
              'Wall has almost no length',
              `"${element.name}" is ${formatLength(length, units)} long.`,
              {
                elementId: element.id,
                suggestion: 'Move one of its endpoints, or delete it.',
              },
            ),
          );
        }
        if (element.height / element.thickness > DESIGN_GUIDANCE.maxWallSlendernessRatio) {
          findings.push(
            finding(
              'warning',
              'Wall is very slender',
              `"${element.name}" is ${formatLength(element.height, units)} tall and only ${formatLength(element.thickness, units)} thick (ratio ${Math.round(element.height / element.thickness)}:1).`,
              {
                elementId: element.id,
                suggestion: 'Thicken the wall, add intermediate structure, or reduce the height.',
                conventionSource:
                  'Rule of thumb for unrestrained masonry and stud walls; not a structural calculation.',
              },
            ),
          );
        }

        const openings = openingsForWall(model, element.id);
        const totalOpeningWidth = openings.reduce((sum, o) => sum + o.width, 0);
        if (openings.length > 0 && totalOpeningWidth > length * 0.85) {
          findings.push(
            finding(
              'warning',
              'Very little wall left between openings',
              `Openings take up ${Math.round((totalOpeningWidth / length) * 100)}% of "${element.name}".`,
              {
                elementId: element.id,
                suggestion:
                  'Reduce the opening widths, or express the façade as a glazed screen instead of a wall.',
                conventionSource: 'Buildability guidance, not a code limit.',
              },
            ),
          );
        }
        break;
      }

      case 'opening': {
        const host = model.elements[element.hostId];
        if (!host || host.type !== 'wall') {
          findings.push(
            finding(
              'error',
              'Opening has no host wall',
              `"${element.name}" references "${element.hostId}", which is not a wall.`,
              {
                elementId: element.id,
                suggestion: 'Delete the opening, or rehost it on a wall.',
              },
            ),
          );
          break;
        }
        const length = wallLength(host);
        const half = element.width / 2;
        if (
          element.distanceAlongWall - half < -1 ||
          element.distanceAlongWall + half > length + 1
        ) {
          findings.push(
            finding(
              'error',
              'Opening extends beyond its wall',
              `"${element.name}" spans ${formatLength(element.distanceAlongWall - half, units)}–${formatLength(element.distanceAlongWall + half, units)} on a ${formatLength(length, units)} wall.`,
              {
                elementId: element.id,
                suggestion: `Move it to between ${formatLength(half, units)} and ${formatLength(length - half, units)} along the wall.`,
              },
            ),
          );
        }
        if (element.sillHeight + element.height > host.height + 1) {
          findings.push(
            finding(
              'error',
              'Opening is taller than its wall',
              `"${element.name}" reaches ${formatLength(element.sillHeight + element.height, units)} in a ${formatLength(host.height, units)} wall.`,
              {
                elementId: element.id,
                suggestion: 'Lower the sill, shorten the opening, or raise the wall.',
              },
            ),
          );
        }
        if (
          element.kind === 'door' &&
          element.width < DESIGN_GUIDANCE.minAccessibleDoorClearWidth &&
          element.openingType !== 'opening'
        ) {
          findings.push(
            finding(
              'info',
              'Door may be too narrow for step-free access',
              `"${element.name}" is ${formatLength(element.width, units)} wide.`,
              {
                elementId: element.id,
                suggestion: `Widen to at least ${formatLength(DESIGN_GUIDANCE.minAccessibleDoorClearWidth, units)} if this is an accessible route.`,
                conventionSource:
                  'Common accessible clear-width guidance. Requirements vary by jurisdiction — verify against the standard that applies to your project.',
              },
            ),
          );
        }
        break;
      }

      case 'stair': {
        const riser = element.totalRise / element.steps;
        const going = element.treadDepth;
        const blondel = 2 * riser + going;
        if (riser > DESIGN_GUIDANCE.maxComfortableRiser) {
          findings.push(
            finding(
              'warning',
              'Stair risers are steep',
              `"${element.name}" has ${element.steps} risers of ${formatLength(riser, units)}.`,
              {
                elementId: element.id,
                suggestion: `Add risers: ${Math.ceil(element.totalRise / DESIGN_GUIDANCE.maxComfortableRiser)} would give ${formatLength(element.totalRise / Math.ceil(element.totalRise / DESIGN_GUIDANCE.maxComfortableRiser), units)} each.`,
                conventionSource:
                  'Common domestic stair guidance; the limit differs by jurisdiction and building type.',
              },
            ),
          );
        }
        if (going < DESIGN_GUIDANCE.minComfortableGoing) {
          findings.push(
            finding(
              'warning',
              'Stair going is shallow',
              `"${element.name}" has a ${formatLength(going, units)} tread.`,
              {
                elementId: element.id,
                suggestion: `Increase the tread depth to at least ${formatLength(DESIGN_GUIDANCE.minComfortableGoing, units)}.`,
                conventionSource: 'Common stair comfort guidance, not a code check.',
              },
            ),
          );
        }
        if (
          blondel < DESIGN_GUIDANCE.stairComfortMin ||
          blondel > DESIGN_GUIDANCE.stairComfortMax
        ) {
          findings.push(
            finding(
              'info',
              'Stair proportion is outside the comfortable range',
              `2 × riser + going = ${Math.round(blondel)} mm; comfortable stairs usually fall between ${DESIGN_GUIDANCE.stairComfortMin} and ${DESIGN_GUIDANCE.stairComfortMax} mm.`,
              {
                elementId: element.id,
                suggestion: 'Adjust the number of risers or the tread depth.',
                conventionSource: "Blondel's rule — a proportioning convention, not a regulation.",
              },
            ),
          );
        }
        if (element.width < DESIGN_GUIDANCE.minStairWidth) {
          findings.push(
            finding(
              'info',
              'Stair is narrow',
              `"${element.name}" is ${formatLength(element.width, units)} wide.`,
              {
                elementId: element.id,
                conventionSource:
                  'Typical minimum for a domestic private stair; check your local standard.',
              },
            ),
          );
        }
        break;
      }

      case 'room': {
        const area = polygonArea(element.outline);
        if (area < 1_000_000) {
          findings.push(
            finding(
              'warning',
              'Room has almost no area',
              `"${element.name}" encloses ${(area / 1e6).toFixed(2)} m².`,
              {
                elementId: element.id,
                suggestion:
                  'Check the outline — the points may be duplicated or in the wrong units.',
              },
            ),
          );
        }
        if (Math.abs(signedArea(element.outline)) < 1) {
          findings.push(
            finding(
              'error',
              'Room outline is degenerate',
              `"${element.name}" has a self-cancelling outline.`,
              {
                elementId: element.id,
                suggestion: 'Redraw the room boundary.',
              },
            ),
          );
        }
        const ceiling =
          element.ceilingHeight ?? model.levels.find((l) => l.id === element.levelId)?.height ?? 0;
        if (ceiling > 0 && ceiling < DESIGN_GUIDANCE.minCeilingHeight) {
          findings.push(
            finding(
              'info',
              'Low ceiling height',
              `"${element.name}" has ${formatLength(ceiling, units)} clear height.`,
              {
                elementId: element.id,
                conventionSource:
                  'Many jurisdictions set a minimum habitable ceiling height around 2.3–2.4 m. Verify against your local standard.',
              },
            ),
          );
        }
        break;
      }

      case 'slab':
      case 'roof': {
        if (Math.abs(signedArea(element.outline)) < 1) {
          findings.push(
            finding(
              'error',
              `${element.type === 'slab' ? 'Slab' : 'Roof'} outline is degenerate`,
              `"${element.name}" has no enclosed area.`,
              {
                elementId: element.id,
                suggestion:
                  'Redraw the outline with at least three distinct, non-collinear points.',
              },
            ),
          );
        }
        break;
      }

      case 'column': {
        const slenderness = element.height / Math.min(element.width, element.depth);
        if (slenderness > 30) {
          findings.push(
            finding(
              'warning',
              'Column is very slender',
              `"${element.name}" has a slenderness ratio of about ${Math.round(slenderness)}:1.`,
              {
                elementId: element.id,
                suggestion: 'Increase the section, or add restraint at an intermediate level.',
                conventionSource:
                  'Indicative only — slenderness limits depend on material, fixity and loading.',
              },
            ),
          );
        }
        break;
      }

      default:
        break;
    }
  }

  // Whole-model checks.
  const levelElevations = new Map<number, string[]>();
  for (const level of model.levels) {
    const existing = levelElevations.get(level.elevation) ?? [];
    existing.push(level.name);
    levelElevations.set(level.elevation, existing);
  }
  for (const [elevation, names] of levelElevations) {
    if (names.length > 1) {
      findings.push(
        finding(
          'warning',
          'Levels share an elevation',
          `${names.join(' and ')} are all at ${formatLength(elevation, units)}.`,
          { suggestion: 'Give each storey a distinct elevation so sections read correctly.' },
        ),
      );
    }
  }

  const activeConstraints = model.constraints.filter((c) => c.active);
  for (const constraint of activeConstraints) {
    if (constraint.kind === 'max-footprint-area' && constraint.value !== null) {
      // Footprint is the area the building covers on the ground, not the sum of
      // every storey — so only slabs on the lowest level count.
      const lowest = model.levels.reduce(
        (min, level) => (level.elevation < min.elevation ? level : min),
        model.levels[0]!,
      );
      const footprint = elementsOfType(model, 'slab')
        .filter((s) => s.role === 'floor' && s.levelId === lowest.id)
        .reduce((sum, s) => sum + polygonArea(s.outline), 0);
      if (footprint > constraint.value) {
        findings.push(
          finding(
            'warning',
            'Footprint exceeds a project constraint',
            `${constraint.description}: footprint is ${(footprint / 1e6).toFixed(1)} m² against a limit of ${(constraint.value / 1e6).toFixed(1)} m².`,
            {
              suggestion: 'Reduce the plan area, or relax the constraint if it no longer applies.',
            },
          ),
        );
      }
    }
    if (constraint.kind === 'min-clear-width' && constraint.value !== null) {
      for (const room of elementsOfType(model, 'room')) {
        if (!constraint.targetIds.length || constraint.targetIds.includes(room.id)) {
          const xs = room.outline.map((p) => p.x);
          const ys = room.outline.map((p) => p.y);
          const narrow = Math.min(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
          );
          if (narrow < constraint.value) {
            findings.push(
              finding(
                'warning',
                'Room is narrower than a project constraint',
                `${room.name} is ${formatLength(narrow, units)} at its narrowest; the constraint requires ${formatLength(constraint.value, units)}.`,
                { elementId: room.id, suggestion: constraint.description },
              ),
            );
          }
        }
      }
    }
  }

  return findings;
}

/** Convenience filter for the UI's severity chips. */
export function countFindings(
  findings: readonly ValidationFinding[],
): Record<FindingSeverity, number> {
  return findings.reduce((counts, f) => ({ ...counts, [f.severity]: counts[f.severity] + 1 }), {
    error: 0,
    warning: 0,
    info: 0,
  } as Record<FindingSeverity, number>);
}

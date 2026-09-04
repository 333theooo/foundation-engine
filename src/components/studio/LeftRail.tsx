'use client';

import { useMemo, useState } from 'react';
import {
  Box,
  ChevronRight,
  Columns3,
  DoorOpen,
  Eye,
  EyeOff,
  Frame,
  Layers,
  Lock,
  Search,
  Sofa,
  Square,
  Triangle,
  Unlock,
  Waves,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tooltip,
} from '@/components/ui/primitives';
import { formatLength } from '@/domain/units';
import { polygonArea, wallLength, wallOrientation } from '@/domain/project/queries';
import type { ArchElement } from '@/domain/project/schema';
import { useEditorStore } from '@/editor/store';
import { cn } from '@/lib/utils';

/**
 * Levels and scene hierarchy.
 *
 * Grouped by level then by element type, because that is how a building is
 * organised in an architect's head — not by creation order. Each row carries
 * the one dimension that identifies it (a wall's length, a room's area), so the
 * list is scannable without clicking through to the inspector.
 */

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  wall: Square,
  slab: Layers,
  room: Frame,
  opening: DoorOpen,
  roof: Triangle,
  stair: Waves,
  column: Columns3,
  beam: Box,
  railing: Waves,
  furniture: Sofa,
  group: Box,
  imported: Box,
};

const TYPE_LABEL: Record<string, string> = {
  wall: 'Walls',
  slab: 'Slabs',
  room: 'Rooms',
  opening: 'Openings',
  roof: 'Roofs',
  stair: 'Stairs',
  column: 'Columns',
  beam: 'Beams',
  railing: 'Railings',
  furniture: 'Furniture',
  group: 'Groups',
  imported: 'Imported',
};

export function LeftRail() {
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);
  const hovered = useEditorStore((state) => state.hovered);
  const activeLevelId = useEditorStore((state) => state.activeLevelId);
  const isolatedIds = useEditorStore((state) => state.isolatedIds);
  const setActiveLevel = useEditorStore((state) => state.setActiveLevel);
  const toggleSelection = useEditorStore((state) => state.toggleSelection);
  const setHovered = useEditorStore((state) => state.setHovered);
  const dispatch = useEditorStore((state) => state.dispatch);
  const requestCamera = useEditorStore((state) => state.requestCamera);
  const isolate = useEditorStore((state) => state.isolate);

  const [query, setQuery] = useState('');
  const units = model.units;

  const levels = useMemo(() => [...model.levels].sort((a, b) => b.index - a.index), [model.levels]);

  const byLevel = useMemo(() => {
    const map = new Map<string, Map<string, ArchElement[]>>();
    const lower = query.trim().toLowerCase();

    for (const id of model.elementOrder) {
      const element = model.elements[id];
      if (!element) continue;
      if (lower && !element.name.toLowerCase().includes(lower) && !element.id.includes(lower))
        continue;

      const levelId =
        element.type === 'opening'
          ? (() => {
              const host = model.elements[element.hostId];
              return host && 'levelId' in host ? (host.levelId ?? 'unassigned') : 'unassigned';
            })()
          : 'levelId' in element && element.levelId
            ? element.levelId
            : 'unassigned';

      const levelBucket = map.get(levelId) ?? new Map<string, ArchElement[]>();
      const typeBucket = levelBucket.get(element.type) ?? [];
      typeBucket.push(element);
      levelBucket.set(element.type, typeBucket);
      map.set(levelId, levelBucket);
    }
    return map;
  }, [model, query]);

  return (
    <div className="bg-surface flex h-full flex-col">
      <div className="panel-header">
        <span>Project</span>
        {isolatedIds ? (
          <Button variant="ghost" size="xs" onClick={() => isolate(null)}>
            Exit isolation
          </Button>
        ) : null}
      </div>

      <div className="border-line border-b p-2">
        <div className="relative">
          <Search className="text-ink-faint absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an element"
            className="h-7 pl-7"
            aria-label="Search elements"
          />
        </div>
      </div>

      <div className="border-line border-b px-2 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-2xs text-ink-faint font-semibold tracking-wide uppercase">
            Levels
          </span>
          <button
            type="button"
            onClick={() => setActiveLevel(null)}
            className={cn(
              'text-[10px] transition-colors',
              activeLevelId === null ? 'text-accent' : 'text-ink-faint hover:text-ink-muted',
            )}
          >
            Show all
          </button>
        </div>
        <ul className="space-y-0.5">
          {levels.map((level) => {
            const active = activeLevelId === level.id;
            const count = [...(byLevel.get(level.id)?.values() ?? [])].reduce(
              (sum, group) => sum + group.length,
              0,
            );
            return (
              <li key={level.id}>
                <div
                  className={cn(
                    'flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors',
                    active ? 'bg-accent-muted text-ink' : 'hover:bg-surface-hover',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setActiveLevel(active ? null : level.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-pressed={active}
                  >
                    <span className="truncate text-xs">{level.name}</span>
                    <span className="numeric text-ink-faint ml-auto shrink-0">
                      {formatLength(level.elevation, units)}
                    </span>
                  </button>
                  <span className="numeric text-ink-faint w-6 shrink-0 text-right">{count}</span>
                  <Tooltip content={level.visible ? 'Hide this level' : 'Show this level'}>
                    <button
                      type="button"
                      onClick={() =>
                        dispatch(
                          [
                            {
                              type: 'update_level',
                              description: `${level.visible ? 'Hide' : 'Show'} ${level.name}`,
                              levelId: level.id,
                              visible: !level.visible,
                              cascade: false,
                            },
                          ],
                          { label: `${level.visible ? 'Hide' : 'Show'} ${level.name}` },
                        )
                      }
                      className="text-ink-faint hover:text-ink transition-colors"
                      aria-label={level.visible ? `Hide ${level.name}` : `Show ${level.name}`}
                    >
                      {level.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    </button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {byLevel.size === 0 ? (
          <p className="text-2xs text-ink-faint px-1 py-6 text-center">
            {query
              ? 'Nothing matches that search.'
              : 'No elements yet. Describe a building in the chat.'}
          </p>
        ) : (
          [...byLevel.entries()]
            .sort(([a], [b]) => {
              const levelA = model.levels.find((level) => level.id === a)?.index ?? 999;
              const levelB = model.levels.find((level) => level.id === b)?.index ?? 999;
              return levelB - levelA;
            })
            .map(([levelId, groups]) => {
              const level = model.levels.find((entry) => entry.id === levelId);
              if (activeLevelId && levelId !== activeLevelId) return null;
              return (
                <div key={levelId} className="mb-3">
                  <p className="text-2xs text-ink-faint mb-1 px-1 font-semibold tracking-wide uppercase">
                    {level?.name ?? 'Unassigned'}
                  </p>
                  {[...groups.entries()].map(([type, elements]) => (
                    <TypeGroup
                      key={type}
                      type={type}
                      elements={elements}
                      selection={selection}
                      hovered={hovered}
                      units={units}
                      onSelect={toggleSelection}
                      onHover={setHovered}
                      onFrame={(ids) => requestCamera({ kind: 'frame', ids })}
                      onToggleVisible={(ids, visible) =>
                        dispatch(
                          [
                            {
                              type: 'set_visibility',
                              description: 'Toggle visibility',
                              ids,
                              visible,
                            },
                          ],
                          { label: visible ? 'Show elements' : 'Hide elements' },
                        )
                      }
                      onToggleLock={(ids, locked) =>
                        dispatch([{ type: 'set_lock', description: 'Toggle lock', ids, locked }], {
                          label: locked ? 'Lock elements' : 'Unlock elements',
                        })
                      }
                      model={model}
                    />
                  ))}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}

function TypeGroup({
  type,
  elements,
  selection,
  hovered,
  units,
  onSelect,
  onHover,
  onFrame,
  onToggleVisible,
  onToggleLock,
  model,
}: {
  type: string;
  elements: ArchElement[];
  selection: string[];
  hovered: string | null;
  units: 'metric' | 'imperial';
  onSelect: (id: string, additive: boolean) => void;
  onHover: (id: string | null) => void;
  onFrame: (ids: string[]) => void;
  onToggleVisible: (ids: string[], visible: boolean) => void;
  onToggleLock: (ids: string[], locked: boolean) => void;
  model: ReturnType<typeof useEditorStore.getState>['model'];
}) {
  const [open, setOpen] = useState(elements.length <= 12);
  const Icon = TYPE_ICON[type] ?? Box;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-surface-hover flex w-full items-center gap-1.5 rounded px-1 py-1 text-left transition-colors"
        >
          <ChevronRight
            className={cn('caret text-ink-faint h-3 w-3')}
            data-state={open ? 'open' : 'closed'}
          />
          <Icon className="text-ink-faint h-3 w-3" />
          <span className="text-ink-muted text-xs">{TYPE_LABEL[type] ?? type}</span>
          <span className="numeric text-ink-faint ml-auto">{elements.length}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="border-line mt-0.5 ml-3 space-y-px border-l pl-1.5">
          {elements.map((element) => {
            const selected = selection.includes(element.id);
            return (
              <li key={element.id}>
                <div
                  className={cn(
                    'group flex items-center gap-1 rounded px-1.5 py-1 transition-colors',
                    selected
                      ? 'bg-accent-muted'
                      : hovered === element.id
                        ? 'bg-surface-hover'
                        : 'hover:bg-surface-hover',
                    !element.visible && 'opacity-45',
                  )}
                  onMouseEnter={() => onHover(element.id)}
                  onMouseLeave={() => onHover(null)}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={(event) =>
                      onSelect(element.id, event.shiftKey || event.metaKey || event.ctrlKey)
                    }
                    onDoubleClick={() => onFrame([element.id])}
                    aria-pressed={selected}
                  >
                    <span
                      className={cn(
                        'block truncate text-xs',
                        selected ? 'text-ink' : 'text-ink-muted',
                      )}
                    >
                      {element.name}
                    </span>
                  </button>
                  <span className="numeric text-ink-faint shrink-0">
                    {describe(element, model, units)}
                  </span>
                  <button
                    type="button"
                    className="text-ink-faint shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onClick={() => onToggleLock([element.id], !element.locked)}
                    aria-label={element.locked ? `Unlock ${element.name}` : `Lock ${element.name}`}
                  >
                    {element.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                  </button>
                  <button
                    type="button"
                    className="text-ink-faint shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onClick={() => onToggleVisible([element.id], !element.visible)}
                    aria-label={element.visible ? `Hide ${element.name}` : `Show ${element.name}`}
                  >
                    {element.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The one number that identifies an element at a glance. */
function describe(
  element: ArchElement,
  model: ReturnType<typeof useEditorStore.getState>['model'],
  units: 'metric' | 'imperial',
): string {
  switch (element.type) {
    case 'wall':
      return `${formatLength(wallLength(element), units)} · ${wallOrientation(element, model.site.northAngleDeg).slice(0, 1).toUpperCase()}`;
    case 'room':
    case 'slab':
    case 'roof':
      return `${(polygonArea(element.outline) / 1e6).toFixed(1)} m²`;
    case 'opening':
      return `${formatLength(element.width, units)}`;
    case 'stair':
      return `${element.steps} risers`;
    case 'column':
      return formatLength(element.height, units);
    default:
      return '';
  }
}

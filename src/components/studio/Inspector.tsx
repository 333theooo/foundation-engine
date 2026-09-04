'use client';

import { useCallback, useState } from 'react';
import { Copy, Crosshair, Eye, EyeOff, Focus, Lock, Trash2, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Tooltip,
} from '@/components/ui/primitives';
import {
  defaultInputUnit,
  formatArea,
  formatLength,
  fromMillimetres,
  parseLengthToMm,
} from '@/domain/units';
import {
  openingsForWall,
  polygonArea,
  polygonBounds,
  wallLength,
  wallOrientation,
} from '@/domain/project/queries';
import type { ArchElement } from '@/domain/project/schema';
import { OPENING_TYPES, WALL_ALIGNMENTS } from '@/domain/project/schema';
import { useEditorStore } from '@/editor/store';
import { cn } from '@/lib/utils';

/**
 * The properties inspector.
 *
 * Every field writes a real command, so a number typed here is undoable,
 * validated and visible to the AI exactly like a chat-driven change. Dimension
 * fields accept the way architects actually type: `2400`, `2.4m`, `8'6"`,
 * `96in` — a bare number uses the project's display unit.
 *
 * Invalid input does not silently revert. The field goes red, the reason is
 * shown, and the model is left alone until the value is fixed.
 */

export function Inspector() {
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);
  const dispatch = useEditorStore((state) => state.dispatch);
  const requestCamera = useEditorStore((state) => state.requestCamera);
  const isolate = useEditorStore((state) => state.isolate);

  const elements = selection
    .map((id) => model.elements[id])
    .filter((element): element is ArchElement => Boolean(element));

  if (elements.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Crosshair className="text-ink-faint h-5 w-5" />
        <p className="text-ink-muted text-xs">Nothing selected</p>
        <p className="text-2xs text-ink-faint max-w-56 leading-relaxed">
          Click an element in the viewport or the hierarchy to edit its properties. Shift-click to
          add to the selection.
        </p>
      </div>
    );
  }

  if (elements.length > 1) {
    return <MultiSelection elements={elements} />;
  }

  const element = elements[0]!;

  return (
    <div className="flex h-full flex-col">
      <div className="panel-header">
        <span className="truncate">{element.type}</span>
        <div className="flex items-center gap-0.5">
          <Tooltip content="Frame in view" shortcut="F">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => requestCamera({ kind: 'frame', ids: [element.id] })}
              aria-label="Frame"
            >
              <Focus className="h-3 w-3" />
            </Button>
          </Tooltip>
          <Tooltip content="Isolate" shortcut="I">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => isolate([element.id])}
              aria-label="Isolate"
            >
              <Crosshair className="h-3 w-3" />
            </Button>
          </Tooltip>
          <Tooltip content={element.visible ? 'Hide' : 'Show'} shortcut="H">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={element.visible ? 'Hide' : 'Show'}
              onClick={() =>
                dispatch(
                  [
                    {
                      type: 'set_visibility',
                      description: 'Toggle visibility',
                      ids: [element.id],
                      visible: !element.visible,
                    },
                  ],
                  { label: element.visible ? 'Hide element' : 'Show element' },
                )
              }
            >
              {element.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            </Button>
          </Tooltip>
          <Tooltip content={element.locked ? 'Unlock' : 'Lock'} shortcut="L">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={element.locked ? 'Unlock' : 'Lock'}
              onClick={() =>
                dispatch(
                  [
                    {
                      type: 'set_lock',
                      description: 'Toggle lock',
                      ids: [element.id],
                      locked: !element.locked,
                    },
                  ],
                  {
                    label: element.locked ? 'Unlock element' : 'Lock element',
                  },
                )
              }
            >
              {element.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Identity">
          <TextField
            label="Name"
            value={element.name}
            onCommit={(value) =>
              dispatch(
                [
                  {
                    type: 'rename_element',
                    description: 'Rename',
                    elementId: element.id,
                    name: value,
                  },
                ],
                {
                  label: 'Rename element',
                },
              )
            }
          />
          <Row label="Id">
            <span className="numeric text-ink-faint truncate" title={element.id}>
              {element.id}
            </span>
          </Row>
          {element.origin === 'ai' ? (
            <Row label="Origin">
              <Badge tone="ai">Created by the assistant</Badge>
            </Row>
          ) : element.origin === 'import' ? (
            <Row label="Origin">
              <Badge tone="neutral">Imported</Badge>
            </Row>
          ) : null}
        </Section>

        <ElementFields element={element} />

        <Section title="Actions">
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="secondary"
              size="xs"
              onClick={() =>
                dispatch(
                  [
                    {
                      type: 'duplicate_elements',
                      description: 'Duplicate',
                      ids: [element.id],
                      offset: { x: 1000, y: 0, z: 0 },
                    },
                  ],
                  { label: 'Duplicate element', focusResult: true },
                )
              }
            >
              <Copy className="h-3 w-3" />
              Duplicate
            </Button>
            <Button
              variant="danger"
              size="xs"
              onClick={() =>
                dispatch([{ type: 'delete_elements', description: 'Delete', ids: [element.id] }], {
                  label: `Delete ${element.name}`,
                })
              }
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function ElementFields({ element }: { element: ArchElement }) {
  const model = useEditorStore((state) => state.model);
  const dispatch = useEditorStore((state) => state.dispatch);
  const units = model.units;

  const patch = useCallback(
    (values: Record<string, unknown>, label: string) =>
      dispatch(
        [{ type: 'set_element_properties', description: label, ids: [element.id], patch: values }],
        { label },
      ),
    [dispatch, element.id],
  );

  switch (element.type) {
    case 'wall': {
      const openings = openingsForWall(model, element.id);
      return (
        <>
          <Section title="Geometry">
            <Row label="Length">
              <span className="numeric text-ink">{formatLength(wallLength(element), units)}</span>
            </Row>
            <Row label="Faces">
              <span className="text-ink text-xs capitalize">
                {wallOrientation(element, model.site.northAngleDeg)}
              </span>
            </Row>
            <DimensionField
              label="Height"
              valueMm={element.height}
              units={units}
              onCommit={(mm) => patch({ height: mm }, 'Set wall height')}
            />
            <DimensionField
              label="Thickness"
              valueMm={element.thickness}
              units={units}
              onCommit={(mm) => patch({ thickness: mm }, 'Set wall thickness')}
            />
            <DimensionField
              label="Base offset"
              valueMm={element.baseOffset}
              units={units}
              allowNegative
              onCommit={(mm) => patch({ baseOffset: mm }, 'Set wall base offset')}
            />
            <SelectField
              label="Alignment"
              value={element.alignment}
              options={WALL_ALIGNMENTS.map((value) => ({ value, label: value }))}
              onCommit={(value) => patch({ alignment: value }, 'Set wall alignment')}
            />
          </Section>

          <Section title="Position">
            <PointField
              label="Start"
              point={element.start}
              units={units}
              onCommit={(point) => patch({ start: point }, 'Move wall start')}
            />
            <PointField
              label="End"
              point={element.end}
              units={units}
              onCommit={(point) => patch({ end: point }, 'Move wall end')}
            />
          </Section>

          <Section title="Construction">
            <MaterialField
              label="Material"
              value={element.materialId}
              onCommit={(value) => patch({ materialId: value }, 'Assign wall material')}
            />
            <ToggleField
              label="Structural"
              checked={element.structural}
              onCommit={(value) => patch({ structural: value }, 'Set structural')}
            />
            <ToggleField
              label="External"
              checked={element.exterior}
              onCommit={(value) => patch({ exterior: value }, 'Set external')}
            />
          </Section>

          {openings.length > 0 ? (
            <Section title={`Hosted openings (${openings.length})`}>
              <ul className="space-y-1">
                {openings.map((opening) => (
                  <li key={opening.id}>
                    <button
                      type="button"
                      onClick={() => useEditorStore.getState().setSelection([opening.id])}
                      className="hover:bg-surface-hover flex w-full items-center justify-between rounded px-1.5 py-1 text-left transition-colors"
                    >
                      <span className="text-ink-muted truncate text-xs">{opening.name}</span>
                      <span className="numeric text-ink-faint">
                        {formatLength(opening.width, units)} × {formatLength(opening.height, units)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      );
    }

    case 'opening': {
      const host = model.elements[element.hostId];
      const hostLength = host?.type === 'wall' ? wallLength(host) : 0;
      return (
        <>
          <Section title="Host">
            <Row label="Wall">
              <button
                type="button"
                className="text-accent truncate text-xs hover:underline"
                onClick={() => useEditorStore.getState().setSelection([element.hostId])}
              >
                {host?.name ?? 'missing'}
              </button>
            </Row>
            <Row label="Wall length">
              <span className="numeric text-ink-faint">{formatLength(hostLength, units)}</span>
            </Row>
          </Section>

          <Section title="Opening">
            <SelectField
              label="Type"
              value={element.openingType}
              options={OPENING_TYPES.map((value) => ({ value, label: value.replace(/-/g, ' ') }))}
              onCommit={(value) => patch({ openingType: value }, 'Set opening type')}
            />
            <DimensionField
              label="Width"
              valueMm={element.width}
              units={units}
              onCommit={(mm) => patch({ width: mm }, 'Set opening width')}
            />
            <DimensionField
              label="Height"
              valueMm={element.height}
              units={units}
              onCommit={(mm) => patch({ height: mm }, 'Set opening height')}
            />
            <DimensionField
              label="Sill height"
              valueMm={element.sillHeight}
              units={units}
              onCommit={(mm) => patch({ sillHeight: mm }, 'Set sill height')}
            />
            <DimensionField
              label="Along wall"
              valueMm={element.distanceAlongWall}
              units={units}
              hint={hostLength > 0 ? `0 – ${formatLength(hostLength, units)}` : undefined}
              onCommit={(mm) => patch({ distanceAlongWall: mm }, 'Move opening')}
            />
          </Section>

          <Section title="Materials">
            <MaterialField
              label="Frame"
              value={element.frameMaterialId ?? 'mat_metal_dark'}
              onCommit={(value) => patch({ frameMaterialId: value }, 'Set frame material')}
            />
            {element.kind === 'window' ? (
              <MaterialField
                label="Glazing"
                value={element.glazingMaterialId ?? 'mat_glass_clear'}
                onCommit={(value) => patch({ glazingMaterialId: value }, 'Set glazing material')}
              />
            ) : null}
          </Section>
        </>
      );
    }

    case 'room': {
      const bounds = polygonBounds(element.outline);
      return (
        <>
          <Section title="Space">
            <Row label="Area">
              <span className="numeric text-ink">
                {formatArea(polygonArea(element.outline), units)}
              </span>
            </Row>
            <Row label="Extent">
              <span className="numeric text-ink-faint">
                {formatLength(bounds.width, units)} × {formatLength(bounds.depth, units)}
              </span>
            </Row>
            <SelectField
              label="Programme"
              value={element.programme}
              options={[
                'living',
                'kitchen',
                'dining',
                'bedroom',
                'bathroom',
                'wc',
                'circulation',
                'storage',
                'study',
                'utility',
                'studio',
                'office',
                'retail',
                'outdoor',
                'technical',
                'other',
              ].map((value) => ({ value, label: value }))}
              onCommit={(value) => patch({ programme: value }, 'Set programme')}
            />
            <DimensionField
              label="Ceiling height"
              valueMm={
                element.ceilingHeight ??
                model.levels.find((l) => l.id === element.levelId)?.height ??
                2700
              }
              units={units}
              onCommit={(mm) => patch({ ceilingHeight: mm }, 'Set ceiling height')}
            />
            <NumberField
              label="Occupancy"
              value={element.occupancy}
              onCommit={(value) => patch({ occupancy: Math.round(value) }, 'Set occupancy')}
            />
          </Section>
        </>
      );
    }

    case 'slab':
      return (
        <Section title="Slab">
          <Row label="Area">
            <span className="numeric text-ink">
              {formatArea(polygonArea(element.outline), units)}
            </span>
          </Row>
          <DimensionField
            label="Thickness"
            valueMm={element.thickness}
            units={units}
            onCommit={(mm) => patch({ thickness: mm }, 'Set slab thickness')}
          />
          <DimensionField
            label="Top offset"
            valueMm={element.topOffset}
            units={units}
            allowNegative
            onCommit={(mm) => patch({ topOffset: mm }, 'Set slab offset')}
          />
          <SelectField
            label="Role"
            value={element.role}
            options={['floor', 'ceiling', 'terrace', 'foundation'].map((value) => ({
              value,
              label: value,
            }))}
            onCommit={(value) => patch({ role: value }, 'Set slab role')}
          />
          <MaterialField
            label="Material"
            value={element.materialId}
            onCommit={(value) => patch({ materialId: value }, 'Assign slab material')}
          />
        </Section>
      );

    case 'roof':
      return (
        <Section title="Roof">
          <SelectField
            label="Type"
            value={element.kind}
            options={['flat', 'shed', 'gable'].map((value) => ({ value, label: value }))}
            onCommit={(value) => patch({ kind: value }, 'Set roof type')}
          />
          <NumberField
            label="Pitch (°)"
            value={element.pitchDeg}
            onCommit={(value) => patch({ pitchDeg: value }, 'Set roof pitch')}
          />
          <SelectField
            label="Ridge axis"
            value={element.ridgeAxis}
            options={[
              { value: 'x', label: 'East–west' },
              { value: 'y', label: 'North–south' },
            ]}
            onCommit={(value) => patch({ ridgeAxis: value }, 'Set ridge axis')}
          />
          <DimensionField
            label="Base elevation"
            valueMm={element.baseElevation}
            units={units}
            allowNegative
            onCommit={(mm) => patch({ baseElevation: mm }, 'Set roof base')}
          />
          <DimensionField
            label="Thickness"
            valueMm={element.thickness}
            units={units}
            onCommit={(mm) => patch({ thickness: mm }, 'Set roof thickness')}
          />
          <DimensionField
            label="Overhang"
            valueMm={element.overhang}
            units={units}
            onCommit={(mm) => patch({ overhang: mm }, 'Set roof overhang')}
          />
          <MaterialField
            label="Material"
            value={element.materialId}
            onCommit={(value) => patch({ materialId: value }, 'Assign roof material')}
          />
        </Section>
      );

    case 'stair': {
      const riser = element.totalRise / element.steps;
      const blondel = 2 * riser + element.treadDepth;
      return (
        <Section title="Stair">
          <DimensionField
            label="Total rise"
            valueMm={element.totalRise}
            units={units}
            onCommit={(mm) => patch({ totalRise: mm }, 'Set stair rise')}
          />
          <NumberField
            label="Risers"
            value={element.steps}
            onCommit={(value) => patch({ steps: Math.round(value) }, 'Set riser count')}
          />
          <DimensionField
            label="Going"
            valueMm={element.treadDepth}
            units={units}
            onCommit={(mm) => patch({ treadDepth: mm }, 'Set going')}
          />
          <DimensionField
            label="Width"
            valueMm={element.width}
            units={units}
            onCommit={(mm) => patch({ width: mm }, 'Set stair width')}
          />
          <SelectField
            label="Shape"
            value={element.shape}
            options={['straight', 'l-shaped', 'u-shaped'].map((value) => ({ value, label: value }))}
            onCommit={(value) => patch({ shape: value }, 'Set stair shape')}
          />
          <Separator className="my-2" />
          <Row label="Riser height">
            <span className={cn('numeric', riser > 190 ? 'text-caution' : 'text-ink')}>
              {formatLength(riser, units)}
            </span>
          </Row>
          <Row label="2R + G">
            <span
              className={cn(
                'numeric',
                blondel < 550 || blondel > 700 ? 'text-caution' : 'text-positive',
              )}
            >
              {Math.round(blondel)} mm
            </span>
          </Row>
          <p className="text-ink-faint mt-1 text-[10px] leading-relaxed">
            Comfortable stairs usually fall between 550 and 700 mm on 2R + G. This is a
            proportioning convention, not a code check.
          </p>
        </Section>
      );
    }

    case 'column':
      return (
        <Section title="Column">
          <DimensionField
            label="Width"
            valueMm={element.width}
            units={units}
            onCommit={(mm) => patch({ width: mm }, 'Set column width')}
          />
          <DimensionField
            label="Depth"
            valueMm={element.depth}
            units={units}
            onCommit={(mm) => patch({ depth: mm }, 'Set column depth')}
          />
          <DimensionField
            label="Height"
            valueMm={element.height}
            units={units}
            onCommit={(mm) => patch({ height: mm }, 'Set column height')}
          />
          <SelectField
            label="Shape"
            value={element.shape}
            options={[
              { value: 'rectangular', label: 'Rectangular' },
              { value: 'round', label: 'Round' },
            ]}
            onCommit={(value) => patch({ shape: value }, 'Set column shape')}
          />
          <PointField
            label="Position"
            point={element.position}
            units={units}
            onCommit={(point) => patch({ position: point }, 'Move column')}
          />
          <MaterialField
            label="Material"
            value={element.materialId}
            onCommit={(value) => patch({ materialId: value }, 'Assign column material')}
          />
        </Section>
      );

    case 'beam':
      return (
        <Section title="Beam">
          <DimensionField
            label="Width"
            valueMm={element.width}
            units={units}
            onCommit={(mm) => patch({ width: mm }, 'Set beam width')}
          />
          <DimensionField
            label="Depth"
            valueMm={element.depth}
            units={units}
            onCommit={(mm) => patch({ depth: mm }, 'Set beam depth')}
          />
          <DimensionField
            label="Soffit"
            valueMm={element.baseOffset}
            units={units}
            allowNegative
            onCommit={(mm) => patch({ baseOffset: mm }, 'Set beam soffit')}
          />
          <PointField
            label="Start"
            point={element.start}
            units={units}
            onCommit={(point) => patch({ start: point }, 'Move beam start')}
          />
          <PointField
            label="End"
            point={element.end}
            units={units}
            onCommit={(point) => patch({ end: point }, 'Move beam end')}
          />
        </Section>
      );

    case 'railing':
      return (
        <Section title="Railing">
          <DimensionField
            label="Height"
            valueMm={element.height}
            units={units}
            onCommit={(mm) => patch({ height: mm }, 'Set railing height')}
          />
          <DimensionField
            label="Post spacing"
            valueMm={element.postSpacing}
            units={units}
            onCommit={(mm) => patch({ postSpacing: mm }, 'Set post spacing')}
          />
          <SelectField
            label="Infill"
            value={element.infill}
            options={['vertical-bars', 'glass', 'solid', 'none'].map((value) => ({
              value,
              label: value.replace('-', ' '),
            }))}
            onCommit={(value) => patch({ infill: value }, 'Set railing infill')}
          />
        </Section>
      );

    case 'furniture':
      return (
        <Section title="Furniture">
          <Row label="Catalogue item">
            <span className="numeric text-ink-faint">{element.catalogId}</span>
          </Row>
          <PointField
            label="Position"
            point={element.position}
            units={units}
            onCommit={(point) => patch({ position: point }, 'Move furniture')}
          />
          <NumberField
            label="Rotation (°)"
            value={element.rotationDeg}
            onCommit={(value) => patch({ rotationDeg: value }, 'Rotate furniture')}
          />
          <NumberField
            label="Scale"
            value={element.scale}
            step={0.05}
            onCommit={(value) => patch({ scale: value }, 'Scale furniture')}
          />
        </Section>
      );

    case 'imported':
      return (
        <Section title="Imported model">
          <Row label="Format">
            <span className="text-ink text-xs uppercase">{element.sourceFormat}</span>
          </Row>
          {element.semanticTag ? (
            <Row label="Source type">
              <span className="numeric text-ink-faint">{element.semanticTag}</span>
            </Row>
          ) : null}
          <Row label="Editable">
            <Badge tone={element.referenceOnly ? 'caution' : 'positive'}>
              {element.referenceOnly ? 'Reference only' : 'Converted'}
            </Badge>
          </Row>
          <p className="text-ink-faint mt-1 text-[10px] leading-relaxed">
            Reference geometry cannot be edited parametrically. Trace over it with real walls, or
            keep it as context and delete it later.
          </p>
        </Section>
      );

    case 'group':
      return (
        <Section title="Group">
          <Row label="Members">
            <span className="numeric text-ink">{element.childIds.length}</span>
          </Row>
          <Button
            variant="secondary"
            size="xs"
            className="mt-2"
            onClick={() =>
              useEditorStore
                .getState()
                .dispatch(
                  [{ type: 'ungroup_elements', description: 'Ungroup', groupId: element.id }],
                  {
                    label: 'Ungroup',
                  },
                )
            }
          >
            Ungroup
          </Button>
        </Section>
      );

    default:
      return null;
  }
}

function MultiSelection({ elements }: { elements: ArchElement[] }) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const ids = elements.map((element) => element.id);
  const counts = elements.reduce<Record<string, number>>((accumulator, element) => {
    accumulator[element.type] = (accumulator[element.type] ?? 0) + 1;
    return accumulator;
  }, {});

  return (
    <div className="flex h-full flex-col">
      <div className="panel-header">
        <span>{elements.length} selected</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Selection">
          {Object.entries(counts).map(([type, count]) => (
            <Row key={type} label={type}>
              <span className="numeric text-ink">{count}</span>
            </Row>
          ))}
        </Section>

        <Section title="Align">
          <div className="grid grid-cols-3 gap-1">
            {(['x', 'y', 'z'] as const).map((axis) =>
              (['min', 'centre', 'max'] as const).map((mode) => (
                <Button
                  key={`${axis}-${mode}`}
                  variant="secondary"
                  size="xs"
                  onClick={() =>
                    dispatch(
                      [
                        {
                          type: 'align_elements',
                          description: `Align ${axis} ${mode}`,
                          ids,
                          axis,
                          mode,
                        },
                      ],
                      {
                        label: `Align ${axis} ${mode}`,
                      },
                    )
                  }
                >
                  {axis.toUpperCase()} {mode}
                </Button>
              )),
            )}
          </div>
        </Section>

        <Section title="Distribute">
          <div className="flex gap-1.5">
            {(['x', 'y'] as const).map((axis) => (
              <Button
                key={axis}
                variant="secondary"
                size="xs"
                disabled={elements.length < 3}
                onClick={() =>
                  dispatch(
                    [{ type: 'distribute_elements', description: `Distribute ${axis}`, ids, axis }],
                    {
                      label: `Distribute along ${axis}`,
                    },
                  )
                }
              >
                Evenly along {axis.toUpperCase()}
              </Button>
            ))}
          </div>
        </Section>

        <Section title="Actions">
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="secondary"
              size="xs"
              onClick={() =>
                dispatch([{ type: 'group_elements', description: 'Group selection', ids }], {
                  label: 'Group selection',
                })
              }
            >
              Group
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() =>
                dispatch(
                  [
                    {
                      type: 'duplicate_elements',
                      description: 'Duplicate',
                      ids,
                      offset: { x: 1000, y: 0, z: 0 },
                    },
                  ],
                  { label: 'Duplicate selection', focusResult: true },
                )
              }
            >
              Duplicate
            </Button>
            <Button
              variant="danger"
              size="xs"
              onClick={() =>
                dispatch([{ type: 'delete_elements', description: 'Delete selection', ids }], {
                  label: `Delete ${ids.length} elements`,
                })
              }
            >
              Delete all
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field primitives                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line border-b px-2.5 py-2.5">
      <h3 className="text-2xs text-ink-faint mb-2 font-semibold tracking-wide uppercase">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <span className="text-2xs text-ink-muted shrink-0 capitalize">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  // React's documented pattern for resetting a field when its source changes.
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }
  return (
    <Row label={label}>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft.trim() && draft !== value && onCommit(draft.trim())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        className="h-6 w-40 text-right"
        aria-label={label}
      />
    </Row>
  );
}

/**
 * A length field.
 *
 * Displays in the project's unit and parses the way a person types: `2400`,
 * `2.4m`, `8'6"`. Rejects rather than reverts, because silently discarding
 * input is how a user loses a change without noticing.
 */
function DimensionField({
  label,
  valueMm,
  units,
  onCommit,
  allowNegative = false,
  hint,
}: {
  label: string;
  valueMm: number;
  units: 'metric' | 'imperial';
  onCommit: (mm: number) => void;
  allowNegative?: boolean;
  hint?: string;
}) {
  const display = () => formatLength(valueMm, units);
  const [draft, setDraft] = useState(display);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(`${valueMm}|${units}`);

  // Re-sync whenever the model value changes underneath us — during render, so
  // the field never briefly shows a stale number.
  const signature = `${valueMm}|${units}`;
  if (signature !== synced) {
    setSynced(signature);
    setDraft(display());
    setError(null);
  }

  const commit = () => {
    if (draft === display()) {
      setError(null);
      return;
    }
    const parsed = parseLengthToMm(draft, defaultInputUnit(units));
    if (parsed === null) {
      setError(`Could not read "${draft}". Try 2400, 2.4 m or 8' 6".`);
      return;
    }
    if (!allowNegative && parsed <= 0) {
      setError('Must be greater than zero.');
      return;
    }
    setError(null);
    onCommit(Math.round(parsed * 100) / 100);
  };

  return (
    <div>
      <Row label={label}>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(display());
              setError(null);
              event.currentTarget.blur();
            }
          }}
          className={cn('numeric h-6 w-28 text-right', error && 'border-critical')}
          aria-label={label}
          aria-invalid={Boolean(error)}
        />
      </Row>
      {error ? <p className="text-critical mt-0.5 text-right text-[10px]">{error}</p> : null}
      {!error && hint ? (
        <p className="text-ink-faint mt-0.5 text-right text-[10px]">{hint}</p>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  onCommit,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(String(value));
  }
  return (
    <Row label={label}>
      <Input
        type="number"
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const parsed = Number(draft);
          if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
          else setDraft(String(value));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className="numeric h-6 w-24 text-right"
        aria-label={label}
      />
    </Row>
  );
}

function PointField({
  label,
  point,
  units,
  onCommit,
}: {
  label: string;
  point: { x: number; y: number };
  units: 'metric' | 'imperial';
  onCommit: (point: { x: number; y: number }) => void;
}) {
  const unit = defaultInputUnit(units);
  const [x, setX] = useState(() => String(round(fromMillimetres(point.x, unit))));
  const [y, setY] = useState(() => String(round(fromMillimetres(point.y, unit))));
  const [synced, setSynced] = useState(`${point.x}|${point.y}|${unit}`);

  const signature = `${point.x}|${point.y}|${unit}`;
  if (signature !== synced) {
    setSynced(signature);
    setX(String(round(fromMillimetres(point.x, unit))));
    setY(String(round(fromMillimetres(point.y, unit))));
  }

  const commit = () => {
    const parsedX = parseLengthToMm(x, unit);
    const parsedY = parseLengthToMm(y, unit);
    if (parsedX === null || parsedY === null) return;
    if (Math.abs(parsedX - point.x) < 0.5 && Math.abs(parsedY - point.y) < 0.5) return;
    onCommit({ x: Math.round(parsedX), y: Math.round(parsedY) });
  };

  return (
    <Row label={label}>
      <div className="flex gap-1">
        <Input
          value={x}
          onChange={(event) => setX(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          className="numeric h-6 w-16 text-right"
          aria-label={`${label} east`}
        />
        <Input
          value={y}
          onChange={(event) => setY(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          className="numeric h-6 w-16 text-right"
          aria-label={`${label} north`}
        />
      </div>
    </Row>
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function SelectField({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onCommit: (value: string) => void;
}) {
  return (
    <Row label={label}>
      <Select value={value} onValueChange={onCommit}>
        <SelectTrigger className="h-6 w-36" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

function MaterialField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const materials = useEditorStore((state) => state.model.materials);
  const current = materials[value];
  return (
    <Row label={label}>
      <div className="flex items-center gap-1.5">
        <span
          className="border-line h-3.5 w-3.5 shrink-0 rounded-sm border"
          style={{ backgroundColor: current?.color ?? '#888' }}
          aria-hidden
        />
        <Select value={value} onValueChange={onCommit}>
          <SelectTrigger className="h-6 w-32" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.values(materials).map((material) => (
              <SelectItem key={material.id} value={material.id}>
                {material.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Row>
  );
}

function ToggleField({
  label,
  checked,
  onCommit,
}: {
  label: string;
  checked: boolean;
  onCommit: (value: boolean) => void;
}) {
  return (
    <Row label={label}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onCommit(!checked)}
        className={cn(
          'h-4 w-7 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-line bg-void',
        )}
      >
        <span
          className={cn(
            'block h-2.5 w-2.5 rounded-full transition-transform',
            checked ? 'bg-accent-ink translate-x-3.5' : 'bg-ink-muted translate-x-0.5',
          )}
        />
      </button>
    </Row>
  );
}

export { Label };

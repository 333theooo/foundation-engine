'use client';

import {
  Box,
  Grid3x3,
  Layers,
  Magnet,
  MousePointer2,
  Move3d,
  Rotate3d,
  Ruler,
  Scaling,
  Scan,
  Sofa,
  Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Slider,
  Tooltip,
} from '@/components/ui/primitives';
import { formatLength } from '@/domain/units';
import { modelBounds } from '@/domain/project/queries';
import { useEditorStore, type GizmoMode } from '@/editor/store';
import { cn } from '@/lib/utils';

/**
 * The viewport chrome.
 *
 * Floating over the canvas rather than framing it, so the model stays the
 * dominant thing on screen. Two clusters: manipulation tools on the left,
 * view controls on the right, both reachable without leaving the mouse.
 */

const TOOLS: Array<{
  mode: GizmoMode;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut: string;
}> = [
  { mode: 'select', icon: MousePointer2, label: 'Select', shortcut: 'Q' },
  { mode: 'translate', icon: Move3d, label: 'Move', shortcut: 'W' },
  { mode: 'rotate', icon: Rotate3d, label: 'Rotate', shortcut: 'E' },
  { mode: 'scale', icon: Scaling, label: 'Scale', shortcut: 'R' },
];

const VIEWS: Array<{
  preset: 'top' | 'front' | 'back' | 'left' | 'right' | 'iso';
  label: string;
  shortcut: string;
}> = [
  { preset: 'top', label: 'Top', shortcut: '1' },
  { preset: 'front', label: 'Front', shortcut: '2' },
  { preset: 'back', label: 'Back', shortcut: '3' },
  { preset: 'left', label: 'Left', shortcut: '4' },
  { preset: 'right', label: 'Right', shortcut: '5' },
  { preset: 'iso', label: 'Iso', shortcut: '6' },
];

export function ViewportOverlay() {
  const gizmoMode = useEditorStore((state) => state.gizmoMode);
  const setGizmoMode = useEditorStore((state) => state.setGizmoMode);
  const measurement = useEditorStore((state) => state.measurement);
  const startMeasurement = useEditorStore((state) => state.startMeasurement);
  const cancelMeasurement = useEditorStore((state) => state.cancelMeasurement);
  const commitMeasurement = useEditorStore((state) => state.commitMeasurement);
  const orthographic = useEditorStore((state) => state.orthographic);
  const setOrthographic = useEditorStore((state) => state.setOrthographic);
  const requestCamera = useEditorStore((state) => state.requestCamera);
  const snap = useEditorStore((state) => state.snap);
  const setSnap = useEditorStore((state) => state.setSnap);
  const showGrid = useEditorStore((state) => state.showGrid);
  const showRooms = useEditorStore((state) => state.showRooms);
  const showFurniture = useEditorStore((state) => state.showFurniture);
  const showShadows = useEditorStore((state) => state.showShadows);
  const wireframe = useEditorStore((state) => state.wireframe);
  const toggleDisplay = useEditorStore((state) => state.toggleDisplay);
  const sectionElevation = useEditorStore((state) => state.sectionElevation);
  const setSectionElevation = useEditorStore((state) => state.setSectionElevation);
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);

  const bounds = modelBounds(model);
  const maxSection = Math.max(bounds.max.y, 6_000);

  return (
    <>
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2.5">
        <div className="pointer-events-auto flex items-start gap-2">
          <div className="border-line bg-surface/90 shadow-panel flex items-center gap-0.5 rounded-lg border p-1 backdrop-blur">
            {TOOLS.map((tool) => (
              <Tooltip key={tool.mode} content={tool.label} shortcut={tool.shortcut}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={tool.label}
                  aria-pressed={gizmoMode === tool.mode && !measurement.active}
                  onClick={() => {
                    cancelMeasurement();
                    setGizmoMode(tool.mode);
                  }}
                  className={cn(
                    gizmoMode === tool.mode && !measurement.active && 'bg-surface-active text-ink',
                  )}
                >
                  <tool.icon className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            ))}

            <Separator orientation="vertical" className="mx-0.5 h-5" />

            <Tooltip content="Measure a distance" shortcut="M">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Measure"
                aria-pressed={measurement.active}
                onClick={() =>
                  measurement.active ? cancelMeasurement() : startMeasurement('distance')
                }
                className={cn(measurement.active && 'bg-surface-active text-ink')}
              >
                <Ruler className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>

            <Tooltip content="Frame the selection" shortcut="F">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Frame selection"
                onClick={() => requestCamera({ kind: 'frame', ids: selection })}
              >
                <Scan className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>

          {measurement.active ? (
            <div className="border-caution/40 bg-surface/90 shadow-panel flex items-center gap-2 rounded-lg border px-2.5 py-1.5 backdrop-blur">
              <span className="text-2xs text-ink">
                {measurement.points.length === 0
                  ? 'Click the first point'
                  : measurement.points.length === 1
                    ? 'Click the second point'
                    : `${measurement.points.length} points`}
              </span>
              {measurement.points.length >= 2 ? (
                <Button variant="primary" size="xs" onClick={() => commitMeasurement()}>
                  Keep
                </Button>
              ) : null}
              <Button variant="ghost" size="xs" onClick={cancelMeasurement}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>

        <div className="pointer-events-auto flex items-end justify-between gap-2">
          <div className="border-line bg-surface/90 shadow-panel flex items-center gap-0.5 rounded-lg border p-1 backdrop-blur">
            <Tooltip content="Snap to grid and angles">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Snapping"
                aria-pressed={snap.grid}
                onClick={() => setSnap({ grid: !snap.grid })}
                className={cn(snap.grid && 'bg-surface-active text-ink')}
              >
                <Magnet className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content="Ground grid" shortcut="G">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Grid"
                aria-pressed={showGrid}
                onClick={() => toggleDisplay('showGrid')}
                className={cn(showGrid && 'bg-surface-active text-ink')}
              >
                <Grid3x3 className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Display options">
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start">
                <p className="text-2xs text-ink-faint mb-2 font-semibold tracking-wide uppercase">
                  Display
                </p>
                <div className="space-y-1.5">
                  <ToggleRow
                    icon={<Box className="h-3 w-3" />}
                    label="Rooms"
                    checked={showRooms}
                    onChange={() => toggleDisplay('showRooms')}
                  />
                  <ToggleRow
                    icon={<Sofa className="h-3 w-3" />}
                    label="Furniture"
                    checked={showFurniture}
                    onChange={() => toggleDisplay('showFurniture')}
                  />
                  <ToggleRow
                    icon={<Sun className="h-3 w-3" />}
                    label="Shadows"
                    checked={showShadows}
                    onChange={() => toggleDisplay('showShadows')}
                  />
                  <ToggleRow
                    icon={<Grid3x3 className="h-3 w-3" />}
                    label="Wireframe"
                    checked={wireframe}
                    onChange={() => toggleDisplay('wireframe')}
                  />
                </div>

                <Separator className="my-3" />

                <div className="flex items-center justify-between">
                  <span className="text-2xs text-ink-muted">Grid step</span>
                  <span className="numeric text-ink">
                    {formatLength(snap.gridSizeMm, model.units)}
                  </span>
                </div>
                <div className="mt-1.5 flex gap-1">
                  {[10, 50, 100, 500, 1000].map((step) => (
                    <button
                      key={step}
                      type="button"
                      onClick={() => setSnap({ gridSizeMm: step })}
                      className={cn(
                        'flex-1 rounded border px-1 py-0.5 text-[10px] transition-colors',
                        snap.gridSizeMm === step
                          ? 'border-accent bg-accent-muted text-ink'
                          : 'border-line text-ink-faint hover:text-ink-muted',
                      )}
                    >
                      {step >= 1000 ? `${step / 1000}m` : step}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Section cut"
                  className={cn(sectionElevation !== null && 'bg-surface-active text-ink')}
                >
                  <Ruler className="h-3.5 w-3.5 rotate-90" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start">
                <div className="flex items-center justify-between">
                  <span className="text-2xs text-ink-faint font-semibold tracking-wide uppercase">
                    Section cut
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSectionElevation(sectionElevation === null ? maxSection * 0.5 : null)
                    }
                    className="text-accent text-[10px] hover:underline"
                  >
                    {sectionElevation === null ? 'Enable' : 'Clear'}
                  </button>
                </div>
                {sectionElevation !== null ? (
                  <>
                    <p className="numeric text-ink mt-2">
                      {formatLength(sectionElevation, model.units)}
                    </p>
                    <Slider
                      className="mt-2"
                      min={0}
                      max={maxSection}
                      step={50}
                      value={[sectionElevation]}
                      onValueChange={([value]) => setSectionElevation(value ?? 0)}
                      aria-label="Section cut elevation"
                    />
                  </>
                ) : (
                  <p className="text-ink-faint mt-2 text-[11px] leading-relaxed">
                    Cuts the model horizontally so you can read it in plan. Everything above the cut
                    plane is hidden.
                  </p>
                )}
              </PopoverContent>
            </Popover>
          </div>

          <div className="border-line bg-surface/90 shadow-panel flex items-center gap-0.5 rounded-lg border p-1 backdrop-blur">
            {VIEWS.map((view) => (
              <Tooltip key={view.preset} content={`${view.label} view`} shortcut={view.shortcut}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-1.5 text-[10px]"
                  onClick={() => requestCamera({ kind: 'preset', preset: view.preset })}
                >
                  {view.label}
                </Button>
              </Tooltip>
            ))}
            <Separator orientation="vertical" className="mx-0.5 h-5" />
            <Tooltip
              content={orthographic ? 'Switch to perspective' : 'Switch to orthographic'}
              shortcut="O"
            >
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5 text-[10px]"
                onClick={() => setOrthographic(!orthographic)}
                aria-pressed={orthographic}
              >
                {orthographic ? 'Ortho' : 'Persp'}
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  );
}

function ToggleRow({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="hover:bg-surface-hover flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors"
    >
      <span className={cn('shrink-0', checked ? 'text-accent' : 'text-ink-faint')}>{icon}</span>
      <span className="text-ink-muted flex-1 text-xs">{label}</span>
      <span
        className={cn(
          'h-4 w-7 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-line bg-void',
        )}
      >
        <span
          className={cn(
            'block h-2.5 w-2.5 translate-y-[3px] rounded-full transition-transform',
            checked ? 'bg-accent-ink translate-x-3.5' : 'bg-ink-muted translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
}

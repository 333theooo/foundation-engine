'use client';

import { AlertTriangle, Activity, Boxes, Info, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/primitives';
import { formatArea, formatLength } from '@/domain/units';
import {
  countElementsByType,
  grossFloorArea,
  modelBounds,
  polygonArea,
  wallLength,
} from '@/domain/project/queries';
import { MAX_ELEMENTS } from '@/domain/project/limits';
import { useEditorStore } from '@/editor/store';
import { cn } from '@/lib/utils';

/**
 * The status bar.
 *
 * Answers the three questions a modeller asks constantly: what is selected and
 * how big is it, is the scene still fast, and is anything wrong. Scene
 * complexity is shown against the hard element cap so a project approaching it
 * is visible before commands start being refused.
 */
export function StatusBar({ onShowIssues }: { onShowIssues: () => void }) {
  const model = useEditorStore((state) => state.model);
  const findings = useEditorStore((state) => state.findings);
  const performance = useEditorStore((state) => state.performance);
  const snap = useEditorStore((state) => state.snap);
  const isolatedIds = useEditorStore((state) => state.isolatedIds);
  const activeLevelId = useEditorStore((state) => state.activeLevelId);

  const units = model.units;
  const elementCount = Object.keys(model.elements).length;
  const counts = countElementsByType(model);
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const infos = findings.filter((finding) => finding.severity === 'info').length;

  const complexity = elementCount / MAX_ELEMENTS;
  const activeLevel = model.levels.find((level) => level.id === activeLevelId);

  return (
    <footer className="border-line bg-surface text-2xs text-ink-faint flex h-7 shrink-0 items-center gap-3 border-t px-2.5">
      <SelectionReadout />

      <span className="text-line-strong">|</span>

      <Tooltip
        content={
          Object.entries(counts)
            .map(([type, n]) => `${n} ${type}`)
            .join(', ') || 'Empty project'
        }
      >
        <span
          className="flex items-center gap-1"
          data-testid="element-count"
          data-count={elementCount}
        >
          <Boxes className="h-3 w-3" />
          <span className="numeric">{elementCount}</span>
          <span>elements</span>
        </span>
      </Tooltip>

      <Tooltip content="Gross floor area, summed over floor slabs">
        <span className="numeric">{formatArea(grossFloorArea(model), units)}</span>
      </Tooltip>

      {activeLevel ? (
        <>
          <span className="text-line-strong">|</span>
          <span>
            Level: <span className="text-ink-muted">{activeLevel.name}</span>
          </span>
        </>
      ) : null}

      {isolatedIds ? (
        <>
          <span className="text-line-strong">|</span>
          <span className="text-caution">Isolated ({isolatedIds.length})</span>
        </>
      ) : null}

      <div className="flex-1" />

      {findings.length > 0 ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onShowIssues}
          className={cn(
            'gap-1',
            errors > 0 ? 'text-critical' : warnings > 0 ? 'text-caution' : 'text-ink-faint',
          )}
        >
          {errors > 0 ? (
            <AlertTriangle className="h-3 w-3" />
          ) : warnings > 0 ? (
            <TriangleAlert className="h-3 w-3" />
          ) : (
            <Info className="h-3 w-3" />
          )}
          {errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : null}
          {errors > 0 && warnings > 0 ? ', ' : null}
          {warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : null}
          {errors === 0 && warnings === 0 && infos > 0
            ? `${infos} note${infos === 1 ? '' : 's'}`
            : null}
        </Button>
      ) : (
        <span className="text-positive">No review findings</span>
      )}

      <span className="text-line-strong">|</span>

      <span>Snap {snap.grid ? formatLength(snap.gridSizeMm, units) : 'off'}</span>

      <span className="text-line-strong">|</span>

      <Tooltip
        content={`${performance.drawCalls} draw calls · ${performance.triangles.toLocaleString()} triangles · ${performance.geometries} cached geometries · ${elementCount}/${MAX_ELEMENTS} elements`}
        side="top"
      >
        <span
          className={cn(
            'flex items-center gap-1',
            performance.fps > 0 && performance.fps < 24
              ? 'text-caution'
              : complexity > 0.8
                ? 'text-caution'
                : 'text-ink-faint',
          )}
        >
          <Activity className="h-3 w-3" />
          <span className="numeric">{performance.fps || '–'}</span>
          <span>fps</span>
        </span>
      </Tooltip>
    </footer>
  );
}

/** Selection dimensions, which is what a status bar in a modeller is really for. */
function SelectionReadout() {
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);
  const units = model.units;

  if (selection.length === 0) {
    return <span>Nothing selected</span>;
  }

  if (selection.length === 1) {
    const element = model.elements[selection[0]!];
    if (!element) return <span>Nothing selected</span>;

    let detail = '';
    if (element.type === 'wall') {
      detail = `${formatLength(wallLength(element), units)} long · ${formatLength(element.height, units)} high · ${formatLength(element.thickness, units)} thick`;
    } else if (element.type === 'room' || element.type === 'slab' || element.type === 'roof') {
      detail = formatArea(polygonArea(element.outline), units);
    } else if (element.type === 'opening') {
      detail = `${formatLength(element.width, units)} × ${formatLength(element.height, units)}`;
    } else if (element.type === 'stair') {
      detail = `${element.steps} risers of ${formatLength(element.totalRise / element.steps, units)}`;
    } else if (element.type === 'column') {
      detail = `${formatLength(element.width, units)} × ${formatLength(element.depth, units)} × ${formatLength(element.height, units)}`;
    }

    return (
      <span className="flex items-center gap-2">
        <span className="text-ink-muted max-w-48 truncate">{element.name}</span>
        {detail ? <span className="numeric">{detail}</span> : null}
      </span>
    );
  }

  const bounds = modelBounds(model, selection);
  return (
    <span className="flex items-center gap-2">
      <span className="text-ink-muted">{selection.length} selected</span>
      <span className="numeric">
        {formatLength(bounds.max.x - bounds.min.x, units)} ×{' '}
        {formatLength(bounds.max.z - bounds.min.z, units)} ×{' '}
        {formatLength(bounds.max.y - bounds.min.y, units)}
      </span>
    </span>
  );
}

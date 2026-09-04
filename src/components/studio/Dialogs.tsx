'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  History,
  Image as ImageIcon,
  Loader2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Dialog, DialogClose, DialogContent, Separator } from '@/components/ui/primitives';
import { SHORTCUTS } from '@/editor/useShortcuts';
import { useEditorStore } from '@/editor/store';
import { detectFormat, importFile } from '@/io/importer';
import { describeExportScope, downloadResult, exportProject } from '@/io/exporters';
import type { ExportFormat, ImportReport } from '@/io/types';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { MM_TO_SCENE } from '@/domain/units';

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * The import dialog.
 *
 * Its most important job is telling the truth about what came in. Every import
 * ends on a report screen that separates converted elements from reference
 * geometry and lists what was not converted and why — because the alternative
 * is a user discovering three days later that their "walls" cannot be edited.
 */
export function ImportDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const loadProject = useEditorStore((state) => state.loadProject);
  const requestCamera = useEditorStore((state) => state.requestCamera);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [scaleToMm, setScaleToMm] = useState('1000');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setBusy(false);
    setProgress('');
    setReport(null);
  };

  const handleFile = useCallback(
    async (file: File) => {
      const format = detectFormat(file.name);
      if (!format) {
        toast.error(`"${file.name}" is not a supported format.`, {
          description: 'Accepted: native JSON, glTF, GLB, OBJ, STL, IFC and DXF.',
        });
        return;
      }

      setBusy(true);
      setReport(null);
      setProgress('Reading the file');

      try {
        // Keep the original alongside the project. It is what makes reference
        // geometry reloadable, and it is the provenance record for the import.
        const form = new FormData();
        form.append('file', file);
        const upload = await fetch(`/api/projects/${projectId}/uploads`, {
          method: 'POST',
          body: form,
        });
        if (!upload.ok) {
          const body = (await upload.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'The file could not be stored.');
        }
        const uploaded = (await upload.json()) as { asset: { key: string; filename: string } };

        const outcome = await importFile(file, {
          scaleToMm: Number(scaleToMm) || (format === 'dxf' ? 1 : 1000),
          onProgress: setProgress,
        });

        if (outcome.kind === 'native') {
          loadProject(projectId, outcome.model, outcome.warnings);
          toast.success('Project file loaded.', {
            description: outcome.warnings.length
              ? `${outcome.warnings.length} item(s) were repaired while loading.`
              : undefined,
          });
          onOpenChange(false);
          reset();
          return;
        }

        const result = outcome.report;
        setReport(result);

        const commands = [...result.commands];
        if (result.meshes.length > 0) {
          commands.push({
            type: 'import_file',
            description: `Reference geometry from ${uploaded.asset.filename}`,
            assetRef: uploaded.asset.key,
            format: result.format === 'json' ? 'gltf' : result.format,
            name: uploaded.asset.filename,
            scale: 1,
          });
        }

        if (commands.length === 0) {
          toast.error('Nothing could be imported from that file.', {
            description:
              result.errors[0] ?? 'The file contained no geometry this build understands.',
          });
          setBusy(false);
          return;
        }

        const applied = dispatch(commands, {
          label: `Import ${uploaded.asset.filename}`,
          source: 'import',
        });
        if (!applied.ok) {
          toast.error('The import could not be applied.', {
            description: applied.issues[0]?.message ?? 'The commands failed validation.',
          });
        } else {
          requestCamera({ kind: 'frame', ids: applied.createdIds });
          toast.success(`Imported ${uploaded.asset.filename}.`);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'The import failed.');
      } finally {
        setBusy(false);
        setProgress('');
      }
    },
    [projectId, scaleToMm, dispatch, loadProject, requestCamera, onOpenChange],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent
        title="Import a model"
        description="Native JSON round-trips exactly. Other formats convert what they can and bring the rest in as reference geometry."
        className="w-[min(94vw,40rem)]"
      >
        {report ? (
          <ImportReportView report={report} onDone={() => onOpenChange(false)} />
        ) : (
          <>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void handleFile(file);
              }}
              className={`flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
                dragging ? 'border-accent bg-accent-muted/40' : 'border-line-strong bg-void'
              }`}
            >
              {busy ? (
                <>
                  <Loader2 className="text-accent h-5 w-5 animate-spin" />
                  <p className="text-ink mt-2 text-xs">{progress || 'Working'}</p>
                  <p className="text-2xs text-ink-faint mt-1">
                    Heavy formats are parsed in a background worker, so the viewport stays
                    responsive.
                  </p>
                </>
              ) : (
                <>
                  <Upload className="text-ink-faint h-5 w-5" />
                  <p className="text-ink mt-2 text-xs">Drop a file here</p>
                  <p className="text-2xs text-ink-faint mt-1 max-w-sm leading-relaxed">
                    .json (native) · .ifc · .dxf · .gltf · .glb · .obj · .stl — up to 50 MB
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => inputRef.current?.click()}
                  >
                    Choose a file
                  </Button>
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".json,.ifc,.dxf,.gltf,.glb,.obj,.stl"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleFile(file);
                      event.target.value = '';
                    }}
                  />
                </>
              )}
            </div>

            <div className="mt-4 flex items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="import-scale">Source units, in millimetres per unit</Label>
                <Input
                  id="import-scale"
                  value={scaleToMm}
                  onChange={(event) => setScaleToMm(event.target.value)}
                  className="numeric w-32"
                />
              </div>
              <p className="text-ink-faint flex-1 pb-1.5 text-[11px] leading-relaxed">
                1000 for a file authored in metres, 1 for millimetres, 25.4 for inches. IFC files
                are normally in metres; DXF carries no reliable unit, so check the result.
              </p>
            </div>

            <div className="border-line bg-void mt-4 rounded border px-2.5 py-2">
              <p className="text-ink-muted text-[11px] leading-relaxed">
                <strong className="text-ink">What to expect.</strong> IFC recovers levels, straight
                walls, spaces and hosted openings as real editable elements; anything else arrives
                as reference geometry. DXF converts straight lines on wall-named layers and brings
                the rest in as reference lines. glTF, OBJ and STL carry no architectural semantics,
                so they are always reference geometry.
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportReportView({ report, onDone }: { report: ImportReport; onDone: () => void }) {
  const convertedTotal = Object.values(report.converted).reduce((sum, n) => sum + n, 0);

  return (
    <div>
      <div className="flex items-center gap-2">
        {report.errors.length > 0 ? (
          <AlertTriangle className="text-critical h-4 w-4" />
        ) : (
          <CheckCircle2 className="text-positive h-4 w-4" />
        )}
        <p className="text-ink text-xs">
          {report.format.toUpperCase()} · {formatBytes(report.stats.bytes)} · parsed in{' '}
          {(report.stats.durationMs / 1000).toFixed(1)}s
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <section className="border-positive/30 bg-positive/5 rounded border px-2.5 py-2">
          <h3 className="text-2xs text-positive font-semibold tracking-wide uppercase">
            Converted to editable elements
          </h3>
          {convertedTotal === 0 ? (
            <p className="text-ink-faint mt-1 text-[11px]">
              Nothing in this file could be converted.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {Object.entries(report.converted).map(([category, count]) => (
                <li key={category} className="text-ink-muted text-[11px]">
                  <span className="numeric text-ink">{count}</span> {category}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-line bg-void rounded border px-2.5 py-2">
          <h3 className="text-2xs text-ink-faint font-semibold tracking-wide uppercase">
            Reference geometry
          </h3>
          <p className="text-ink-muted mt-1 text-[11px]">
            {report.meshes.length === 0
              ? 'None.'
              : `${report.meshes.length} group(s), ${report.stats.vertices.toLocaleString()} vertices. Not editable — trace over it or delete it.`}
          </p>
        </section>
      </div>

      {report.unsupported.length > 0 ? (
        <section className="border-caution/30 bg-caution/5 mt-3 rounded border px-2.5 py-2">
          <h3 className="text-2xs text-caution font-semibold tracking-wide uppercase">
            Not converted
          </h3>
          <ul className="mt-1 space-y-1">
            {report.unsupported.map((entry) => (
              <li key={entry.category} className="text-ink-muted text-[11px] leading-relaxed">
                <span className="numeric text-ink">{entry.count}</span> {entry.category} —{' '}
                <span className="text-ink-faint">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.warnings.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {report.warnings.map((warning, index) => (
            <li key={index} className="text-ink-faint text-[11px] leading-relaxed">
              · {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {report.errors.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {report.errors.map((error, index) => (
            <li key={index} className="text-critical text-[11px] leading-relaxed">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Button variant="primary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const EXPORT_OPTIONS: Array<{
  format: ExportFormat;
  title: string;
  detail: string;
  lossless: boolean;
}> = [
  {
    format: 'json',
    title: 'Native project (.json)',
    detail:
      'Lossless. Every element, dimension, material and id. Re-import to get this exact model back.',
    lossless: true,
  },
  {
    format: 'glb',
    title: 'glTF binary (.glb)',
    detail: 'Meshes and materials for viewers and renderers. Parametric information is lost.',
    lossless: false,
  },
  {
    format: 'gltf',
    title: 'glTF JSON (.gltf)',
    detail: 'Same as GLB, in a readable text format.',
    lossless: false,
  },
  {
    format: 'obj',
    title: 'Wavefront (.obj)',
    detail: 'Widely supported meshes. No materials, no semantics.',
    lossless: false,
  },
  {
    format: 'stl',
    title: 'STL (.stl)',
    detail: 'Triangles only, for 3D printing and physical models.',
    lossless: false,
  },
  {
    format: 'screenshot',
    title: 'Viewport image (.png)',
    detail: 'Exactly what is on screen now, at the current camera and lighting.',
    lossless: false,
  },
  {
    format: 'summary',
    title: 'Project summary (.md)',
    detail: 'Schedules of spaces and openings, construction notes, and the design review findings.',
    lossless: false,
  },
];

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="viewport"] canvas');
      const result = await exportProject(model, format, {
        ...(selectionOnly && selection.length > 0 ? { elementIds: selection } : {}),
        canvas,
      });
      downloadResult(result);
      toast.success(`Exported ${result.filename}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The export failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Export" className="w-[min(94vw,36rem)]">
        {selection.length > 0 ? (
          <label className="text-ink-muted mb-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={selectionOnly}
              onChange={(event) => setSelectionOnly(event.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Export only the {selection.length} selected element
            {selection.length === 1 ? '' : 's'}
          </label>
        ) : null}

        <p className="text-2xs text-ink-faint mb-3">
          {describeExportScope(model, selectionOnly ? selection : undefined)} will be included.
        </p>

        <ul className="space-y-1.5">
          {EXPORT_OPTIONS.map((option) => (
            <li key={option.format}>
              <button
                type="button"
                onClick={() => void run(option.format)}
                disabled={busy !== null}
                className="border-line bg-void hover:border-line-strong flex w-full items-start gap-2.5 rounded border px-2.5 py-2 text-left transition-colors disabled:opacity-50"
              >
                <span className="text-ink-faint mt-0.5">
                  {busy === option.format ? (
                    <Loader2 className="text-accent h-3.5 w-3.5 animate-spin" />
                  ) : option.format === 'screenshot' ? (
                    <ImageIcon className="h-3.5 w-3.5" />
                  ) : option.format === 'json' || option.format === 'summary' ? (
                    <FileJson className="h-3.5 w-3.5" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-ink text-xs font-medium">{option.title}</span>
                    {option.lossless ? <Badge tone="positive">Lossless</Badge> : null}
                  </span>
                  <span className="text-ink-faint mt-0.5 block text-[11px] leading-relaxed">
                    {option.detail}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

interface VersionSummary {
  id: string;
  label: string;
  kind: string;
  revision: number;
  createdAt: string;
}

/**
 * Mounted only while open, by the caller. That is what lets the initial state
 * be "loading" and the effect do nothing synchronously — every state change
 * happens after an await, so there is no cascading render on open.
 */
export function VersionsDialog({
  onOpenChange,
  projectId,
}: {
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const loadProject = useEditorStore((state) => state.loadProject);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/versions`);
      if (!response.ok) throw new Error('Could not load the version history.');
      const body = (await response.json()) as { versions: VersionSummary[] };
      setVersions(body.versions);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load versions.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const createVersion = async () => {
    const name = label.trim();
    if (!name) return;
    setLabel('');
    try {
      const response = await fetch(`/api/projects/${projectId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: name }),
      });
      if (!response.ok) throw new Error('Could not save the version.');
      await refresh();
      toast.success(`Saved "${name}".`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the version.');
    }
  };

  const restore = async (version: VersionSummary) => {
    setBusyId(version.id);
    try {
      const response = await fetch(`/api/projects/${projectId}/versions/${version.id}/restore`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Could not restore that version.');
      const body = (await response.json()) as {
        model: Parameters<typeof loadProject>[1];
        warnings: string[];
      };
      loadProject(projectId, body.model, body.warnings);
      toast.success(`Restored "${version.label}".`, {
        description: 'The state before restoring was saved as a version, so this is reversible.',
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not restore that version.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Version history"
        description="Autosaves are kept automatically; named versions are kept indefinitely."
        className="w-[min(94vw,38rem)]"
      >
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createVersion();
          }}
        >
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name this version, e.g. “Before the roof change”"
            aria-label="Version name"
          />
          <Button type="submit" variant="primary" size="md" disabled={!label.trim()}>
            Save version
          </Button>
        </form>

        <Separator className="my-3" />

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-ink-faint h-4 w-4 animate-spin" />
          </div>
        ) : versions.length === 0 ? (
          <p className="text-ink-faint py-8 text-center text-xs">No versions saved yet.</p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {versions.map((version) => (
              <li
                key={version.id}
                className="border-line bg-void flex items-center gap-2 rounded border px-2.5 py-2"
              >
                <History className="text-ink-faint h-3 w-3 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate text-xs">{version.label}</p>
                  <p className="text-ink-faint text-[10px]">
                    {formatRelativeTime(version.createdAt)} · revision {version.revision} ·{' '}
                    {version.kind.toLowerCase().replace('_', ' ')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void restore(version)}
                  disabled={busyId !== null}
                >
                  {busyId === version.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                           */
/* ------------------------------------------------------------------ */

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const groups = SHORTCUTS.reduce<Record<string, typeof SHORTCUTS>>((accumulator, shortcut) => {
    (accumulator[shortcut.group] ??= []).push(shortcut);
    return accumulator;
  }, {});

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" className="w-[min(94vw,34rem)]">
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(groups).map(([group, shortcuts]) => (
            <section key={group}>
              <h3 className="text-2xs text-ink-faint mb-1.5 font-semibold tracking-wide uppercase">
                {group}
              </h3>
              <ul className="space-y-1">
                {shortcuts.map((shortcut) => (
                  <li key={shortcut.keys} className="flex items-center justify-between gap-3">
                    <span className="text-ink-muted text-xs">{shortcut.description}</span>
                    <kbd className="border-line bg-void text-ink-faint shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]">
                      {shortcut.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="text-ink-faint mt-4 text-[11px] leading-relaxed">
          Shortcuts stand down while you are typing, so writing “delete the north wall” in the chat
          does exactly that and nothing else.
        </p>
        <div className="mt-3 flex justify-end">
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Scene-space helper shared by the dialogs that place imported geometry. */
export const SCENE_SCALE = MM_TO_SCENE;

'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Check,
  ChevronDown,
  CloudOff,
  Download,
  History,
  Keyboard,
  Loader2,
  Redo2,
  Undo2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Separator,
  Tooltip,
} from '@/components/ui/primitives';
import { Mark } from '@/components/marketing/Landing';
import { useEditorStore } from '@/editor/store';
import { formatRelativeTime } from '@/lib/utils';

/**
 * The project bar.
 *
 * Everything here is live: the name field renames the project through the
 * command engine (so it undoes), the save indicator reflects the real autosave
 * state including failures, and undo/redo are disabled precisely when the
 * stacks are empty rather than always enabled and silently doing nothing.
 */

export interface TopBarProps {
  projectName: string;
  user: { name: string; isGuest: boolean };
  aiProvider: { provider: string; model: string; note: string };
  onImport: () => void;
  onExport: () => void;
  onVersions: () => void;
  onShortcuts: () => void;
  onSignOut: () => void;
}

export function TopBar({
  projectName,
  user,
  aiProvider,
  onImport,
  onExport,
  onVersions,
  onShortcuts,
  onSignOut,
}: TopBarProps) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const undoStack = useEditorStore((state) => state.undoStack);
  const redoStack = useEditorStore((state) => state.redoStack);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const saveError = useEditorStore((state) => state.saveError);
  const lastSavedAt = useEditorStore((state) => state.lastSavedAt);
  const units = useEditorStore((state) => state.model.units);

  const [name, setName] = useState(projectName);
  const [syncedName, setSyncedName] = useState(projectName);
  const [editing, setEditing] = useState(false);

  // Adjusting state during render rather than in an effect: this is the pattern
  // React documents for "reset a field when its source prop changes", and it
  // avoids the extra commit an effect would cause.
  if (projectName !== syncedName) {
    setSyncedName(projectName);
    setName(projectName);
  }

  const commitName = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === projectName) {
      setName(projectName);
      return;
    }
    dispatch([{ type: 'set_project_info', description: 'Rename project', name: trimmed }], {
      label: 'Rename project',
    });
  };

  const lastUndo = undoStack[undoStack.length - 1];
  const lastRedo = redoStack[redoStack.length - 1];

  return (
    <header className="border-line bg-surface flex h-11 shrink-0 items-center gap-2 border-b px-2">
      <Link
        href="/dashboard"
        className="hover:bg-surface-hover flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors"
        aria-label="Back to projects"
      >
        <Mark className="h-4 w-4" />
      </Link>

      <Separator orientation="vertical" className="h-5" />

      {editing ? (
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitName();
            if (event.key === 'Escape') {
              setName(projectName);
              setEditing(false);
            }
          }}
          autoFocus
          className="h-7 w-56"
          aria-label="Project name"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-ink hover:bg-surface-hover max-w-64 truncate rounded px-1.5 py-1 text-xs font-medium transition-colors"
          title="Click to rename"
        >
          {projectName}
        </button>
      )}

      <SaveIndicator status={saveStatus} error={saveError} lastSavedAt={lastSavedAt} />

      <Separator orientation="vertical" className="h-5" />

      <Tooltip content={lastUndo ? `Undo ${lastUndo.label}` : 'Nothing to undo'} shortcut="⌘Z">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => undo()}
          disabled={undoStack.length === 0}
          aria-label="Undo"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content={lastRedo ? `Redo ${lastRedo.label}` : 'Nothing to redo'} shortcut="⌘⇧Z">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => redo()}
          disabled={redoStack.length === 0}
          aria-label="Redo"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>

      <div className="flex-1" />

      <UnitsToggle units={units} />

      <Tooltip content="Import a model" shortcut="⌘O">
        <Button variant="ghost" size="icon" onClick={onImport} aria-label="Import">
          <Upload className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Export" shortcut="⌘E">
        <Button variant="ghost" size="icon" onClick={onExport} aria-label="Export">
          <Download className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Version history">
        <Button variant="ghost" size="icon" onClick={onVersions} aria-label="Version history">
          <History className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Keyboard shortcuts" shortcut="?">
        <Button variant="ghost" size="icon" onClick={onShortcuts} aria-label="Keyboard shortcuts">
          <Keyboard className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>

      <Separator orientation="vertical" className="h-5" />

      <Tooltip content={aiProvider.note} side="bottom">
        <span>
          <Badge tone={aiProvider.provider === 'anthropic' ? 'ai' : 'neutral'}>
            {aiProvider.provider === 'anthropic' ? aiProvider.model : 'Local interpreter'}
          </Badge>
        </span>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1">
            {user.isGuest ? 'Guest' : user.name}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/dashboard">All projects</Link>
          </DropdownMenuItem>
          {user.isGuest ? (
            <DropdownMenuItem asChild>
              <Link href="/sign-up">Create an account to keep this work</Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function UnitsToggle({ units }: { units: 'metric' | 'imperial' }) {
  const dispatch = useEditorStore((state) => state.dispatch);
  return (
    <Tooltip content="Display units only. Stored dimensions never change.">
      <div className="border-line flex items-center overflow-hidden rounded border">
        {(['metric', 'imperial'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() =>
              dispatch(
                [{ type: 'set_units', description: `Display ${option} units`, units: option }],
                {
                  label: `Display ${option} units`,
                },
              )
            }
            className={
              units === option
                ? 'bg-surface-active text-ink px-2 py-1 text-[10px] font-medium'
                : 'text-ink-faint hover:text-ink-muted px-2 py-1 text-[10px] transition-colors'
            }
            aria-pressed={units === option}
          >
            {option === 'metric' ? 'mm / m' : 'ft / in'}
          </button>
        ))}
      </div>
    </Tooltip>
  );
}

function SaveIndicator({
  status,
  error,
  lastSavedAt,
}: {
  status: string;
  error: string | null;
  lastSavedAt: number | null;
}) {
  if (status === 'saving') {
    return (
      <span className="text-2xs text-ink-faint flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (status === 'error') {
    return (
      <Tooltip content={error ?? 'The last save failed.'}>
        <span className="text-2xs text-critical flex items-center gap-1">
          <CloudOff className="h-3 w-3" />
          Not saved
        </span>
      </Tooltip>
    );
  }
  if (status === 'dirty') {
    return <span className="text-2xs text-ink-faint">Unsaved changes</span>;
  }
  if (status === 'saved' && lastSavedAt) {
    return (
      <span className="text-2xs text-ink-faint flex items-center gap-1">
        <Check className="text-positive h-3 w-3" />
        Saved {formatRelativeTime(lastSavedAt)}
      </span>
    );
  }
  return null;
}

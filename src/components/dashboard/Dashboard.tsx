'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/primitives';
import { Mark } from '@/components/marketing/Landing';
import { formatRelativeTime } from '@/lib/utils';

/**
 * The project dashboard.
 *
 * Every action here is wired to a real endpoint — create, rename, duplicate,
 * archive, restore and delete all round-trip to the server and re-fetch. There
 * are no optimistic states that could lie about what happened.
 */

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  elementCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function Dashboard({
  initialProjects,
  user,
}: {
  initialProjects: ProjectSummary[];
  user: { name: string; email: string; isGuest: boolean };
}) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects?archived=${showArchived}`);
    if (!response.ok) return;
    const body = (await response.json()) as { projects: ProjectSummary[] };
    setProjects(body.projects);
  }, [showArchived]);

  // The server already rendered the initial list, so only refetch when the
  // archived filter actually changes. A ref, not state: this marker is
  // bookkeeping, and storing it in state would cause an extra render.
  const syncedFilter = useRef(showArchived);
  useEffect(() => {
    if (syncedFilter.current === showArchived) return;
    syncedFilter.current = showArchived;
    void refresh();
  }, [showArchived, refresh]);

  async function createProject(template: 'empty' | 'sample') {
    setCreating(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template,
          name: template === 'sample' ? 'Lakeside Studio' : 'Untitled project',
        }),
      });
      const body = (await response.json()) as { error?: string; project?: { id: string } };
      if (!response.ok || !body.project)
        throw new Error(body.error ?? 'Could not create the project.');
      router.push(`/studio/${body.project.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the project.');
      setCreating(false);
    }
  }

  async function act(
    project: ProjectSummary,
    action: 'duplicate' | 'archive' | 'restore' | 'delete',
    name?: string,
  ) {
    setBusyId(project.id);
    try {
      const response =
        action === 'duplicate'
          ? await fetch(`/api/projects/${project.id}/duplicate`, { method: 'POST' })
          : action === 'delete'
            ? await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
            : await fetch(`/api/projects/${project.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                  name !== undefined ? { name } : { archived: action === 'archive' },
                ),
              });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'That did not work.');
      }
      await refresh();
      toast.success(
        action === 'duplicate'
          ? 'Project duplicated.'
          : action === 'delete'
            ? 'Project deleted.'
            : action === 'archive'
              ? 'Project archived.'
              : 'Project restored.',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  }

  async function rename() {
    if (!renaming) return;
    const target = renaming;
    setRenaming(null);
    setBusyId(target.id);
    try {
      const response = await fetch(`/api/projects/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() || target.name }),
      });
      if (!response.ok) throw new Error('Could not rename the project.');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not rename the project.');
    } finally {
      setBusyId(null);
    }
  }

  const visible = projects.filter((project) => (showArchived ? true : !project.archivedAt));

  return (
    <div className="min-h-screen">
      <header className="border-line flex items-center justify-between border-b px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <Mark />
          <span className="text-sm font-semibold tracking-tight">Atrium Studio</span>
        </Link>
        <div className="flex items-center gap-3">
          {user.isGuest ? (
            <Badge tone="caution">Guest session · expires in 7 days</Badge>
          ) : (
            <span className="text-ink-muted text-xs">{user.email}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' });
              router.push('/');
              router.refresh();
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-ink text-lg font-semibold tracking-tight">Projects</h1>
            <p className="text-ink-muted mt-1 text-xs">
              {visible.length} {visible.length === 1 ? 'project' : 'projects'}
              {user.isGuest ? ' in this guest workspace' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowArchived((value) => !value)}>
              {showArchived ? 'Hide archived' : 'Show archived'}
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={creating}
              onClick={() => void createProject('sample')}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Open sample
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={creating}
              onClick={() => void createProject('empty')}
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              New project
            </Button>
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState onCreate={() => void createProject('sample')} busy={creating} />
        ) : (
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((project) => (
              <li
                key={project.id}
                className="group border-line bg-surface hover:border-line-strong relative rounded-lg border transition-colors"
              >
                <Link href={`/studio/${project.id}`} className="block p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-ink group-hover:text-accent text-sm font-medium">
                      {project.name}
                    </h2>
                    {project.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
                  </div>
                  <p className="text-ink-muted mt-1 line-clamp-2 min-h-8 text-xs">
                    {project.description || 'No description yet.'}
                  </p>
                  <div className="text-2xs text-ink-faint mt-3 flex items-center gap-3">
                    <span className="numeric">{project.elementCount} elements</span>
                    <span>·</span>
                    <span>Edited {formatRelativeTime(project.updatedAt)}</span>
                  </div>
                </Link>

                <div className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${project.name}`}
                      >
                        {busyId === project.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setRenameValue(project.name);
                          setRenaming(project);
                        }}
                      >
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void act(project, 'duplicate')}>
                        <Copy className="h-3.5 w-3.5" />
                        Duplicate
                      </DropdownMenuItem>
                      {project.archivedAt ? (
                        <DropdownMenuItem onSelect={() => void act(project, 'restore')}>
                          <ArchiveRestore className="h-3.5 w-3.5" />
                          Restore
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => void act(project, 'archive')}>
                          <Archive className="h-3.5 w-3.5" />
                          Archive
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-critical data-[highlighted]:bg-critical/10"
                        onSelect={() => setDeleting(project)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent title="Rename project">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
              maxLength={120}
              aria-label="Project name"
            />
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm">
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent
          title="Delete this project?"
          description="This removes the project, every saved version and its conversation. It cannot be undone."
        >
          <p className="text-ink-muted text-xs">
            You are about to delete <span className="text-ink">{deleting?.name}</span>.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Keep it
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (deleting) void act(deleting, 'delete');
                setDeleting(null);
              }}
            >
              Delete permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ onCreate, busy }: { onCreate: () => void; busy: boolean }) {
  return (
    <div className="border-line-strong bg-surface/40 mt-8 rounded-lg border border-dashed px-6 py-16 text-center">
      <Mark className="mx-auto h-8 w-8 opacity-60" />
      <h2 className="text-ink mt-4 text-sm font-medium">Nothing here yet</h2>
      <p className="text-ink-muted mx-auto mt-1 max-w-sm text-xs leading-relaxed">
        Start from the sample project — a two-storey house with a gable roof, glazed south façade
        and a furnished ground floor — or open an empty model and describe what you want.
      </p>
      <Button variant="primary" size="md" className="mt-5" onClick={onCreate} disabled={busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        Open the sample project
      </Button>
    </div>
  );
}

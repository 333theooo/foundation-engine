'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { AlertTriangle, Info, Loader2, PanelLeft, PanelRight, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from '@/components/ui/primitives';
import type { ProjectModel } from '@/domain/project/schema';
import { useEditorStore } from '@/editor/store';
import { recoverDraft } from '@/editor/useAutosave';
import { useAutosave } from '@/editor/useAutosave';
import { useChat, type ChatMessage } from '@/editor/useChat';
import { useShortcuts } from '@/editor/useShortcuts';
import { cn } from '@/lib/utils';
import { ChatPanel } from './ChatPanel';
import { ExportDialog, ImportDialog, ShortcutsDialog, VersionsDialog } from './Dialogs';
import { Inspector } from './Inspector';
import { LeftRail } from './LeftRail';
import { Onboarding } from './Onboarding';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { ViewportOverlay } from './ViewportOverlay';

/**
 * The workspace.
 *
 * Layout: a narrow left rail for levels and hierarchy, a dominant central
 * viewport, and a right panel that switches between the conversation and the
 * properties inspector. Both side panels collapse so the viewport can take the
 * whole screen, which is what you want the moment you are presenting.
 *
 * The Three.js canvas is loaded client-side only. It is the largest chunk in
 * the application and it cannot server-render, so keeping it out of the initial
 * payload means the shell paints immediately and the viewport fades in behind a
 * real loading state.
 */

const Viewport = dynamic(() => import('@/three/Viewport').then((module) => module.Viewport), {
  ssr: false,
  loading: () => (
    <div className="bg-canvas flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="text-ink-faint h-5 w-5 animate-spin" />
        <p className="text-2xs text-ink-faint">Preparing the 3D viewport</p>
      </div>
    </div>
  ),
});

export interface StudioProps {
  projectId: string;
  projectName: string;
  initialModel: ProjectModel;
  loadWarnings: string[];
  initialMessages: ChatMessage[];
  user: { name: string; isGuest: boolean };
  aiProvider: { provider: string; model: string; note: string };
}

export function Studio({
  projectId,
  projectName,
  initialModel,
  loadWarnings,
  initialMessages,
  user,
  aiProvider,
}: StudioProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const loadProject = useEditorStore((state) => state.loadProject);
  const loaded = useEditorStore((state) => state.loaded);
  const storeProjectId = useEditorStore((state) => state.projectId);
  const rightPanel = useEditorStore((state) => state.rightPanel);
  const setRightPanel = useEditorStore((state) => state.setRightPanel);
  const leftPanelOpen = useEditorStore((state) => state.leftPanelOpen);
  const rightPanelOpen = useEditorStore((state) => state.rightPanelOpen);
  const togglePanel = useEditorStore((state) => state.togglePanel);
  const findings = useEditorStore((state) => state.findings);
  const modelName = useEditorStore((state) => state.model.name);

  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const initialPromptSent = useRef(false);

  const chat = useChat(projectId, initialMessages);
  useAutosave(projectId);

  // Load the project into the store once, and offer any newer local draft.
  useEffect(() => {
    if (storeProjectId === projectId && loaded) return;
    loadProject(projectId, initialModel, loadWarnings);

    const draft = recoverDraft(projectId, initialModel);
    if (draft) {
      toast('Unsaved changes were recovered from this browser.', {
        description: `A local draft at revision ${draft.revision} is newer than the saved project (revision ${initialModel.revision}).`,
        duration: 20_000,
        action: {
          label: 'Restore it',
          onClick: () => {
            loadProject(projectId, draft.model, ['Restored from a local draft.']);
            useEditorStore.getState().setSaveStatus('dirty');
          },
        },
      });
    }

    if (loadWarnings.length > 0) {
      toast.warning('The project needed repairs while loading.', {
        description: loadWarnings.slice(0, 3).join(' '),
        duration: 12_000,
      });
    }
  }, [projectId, initialModel, loadWarnings, loadProject, loaded, storeProjectId]);

  // A prompt handed over from the landing page runs itself, once.
  useEffect(() => {
    const prompt = searchParams.get('prompt');
    if (!prompt || initialPromptSent.current || !loaded) return;
    initialPromptSent.current = true;
    setRightPanel('chat');
    void chat.send(prompt);
    router.replace(`/studio/${projectId}`, { scroll: false });
  }, [searchParams, loaded, chat, projectId, router, setRightPanel]);

  const handlers = useMemo(
    () => ({
      onSave: () => setVersionsOpen(true),
      onExport: () => setExportOpen(true),
      onImport: () => setImportOpen(true),
      onFocusChat: () => {
        setRightPanel('chat');
        // The panel may need a frame to mount before the field can take focus.
        requestAnimationFrame(() => chatInputRef.current?.focus());
      },
      onToggleHelp: () => setShortcutsOpen((value) => !value),
    }),
    [setRightPanel],
  );
  useShortcuts(handlers);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
    router.refresh();
  }, [router]);

  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        projectName={modelName || projectName}
        user={user}
        aiProvider={aiProvider}
        onImport={() => setImportOpen(true)}
        onExport={() => setExportOpen(true)}
        onVersions={() => setVersionsOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onSignOut={() => void signOut()}
      />

      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="atrium.layout">
          {leftPanelOpen ? (
            <>
              <Panel defaultSize={17} minSize={12} maxSize={30} order={1}>
                <div className="border-line h-full border-r">
                  <LeftRail />
                </div>
              </Panel>
              <ResizeHandle />
            </>
          ) : null}

          <Panel order={2} minSize={30}>
            <div className="relative h-full">
              <Viewport className="h-full w-full" />
              <ViewportOverlay />

              <div className="pointer-events-none absolute top-2.5 left-1/2 -translate-x-1/2">
                <div className="pointer-events-auto flex gap-1">
                  <Tooltip
                    content={leftPanelOpen ? 'Hide the project panel' : 'Show the project panel'}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => togglePanel('left')}
                      aria-label="Toggle project panel"
                      className="bg-surface/80 backdrop-blur"
                    >
                      <PanelLeft className="h-3 w-3" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={rightPanelOpen ? 'Hide the side panel' : 'Show the side panel'}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => togglePanel('right')}
                      aria-label="Toggle side panel"
                      className="bg-surface/80 backdrop-blur"
                    >
                      <PanelRight className="h-3 w-3" />
                    </Button>
                  </Tooltip>
                </div>
              </div>
            </div>
          </Panel>

          {rightPanelOpen ? (
            <>
              <ResizeHandle />
              <Panel defaultSize={26} minSize={18} maxSize={45} order={3}>
                <div className="border-line bg-surface flex h-full flex-col border-l">
                  <Tabs
                    value={rightPanel}
                    onValueChange={(value) => setRightPanel(value as typeof rightPanel)}
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <TabsList>
                      <TabsTrigger value="chat">Assistant</TabsTrigger>
                      <TabsTrigger value="properties">Properties</TabsTrigger>
                      <TabsTrigger value="issues" className="gap-1">
                        Review
                        {errorCount > 0 ? (
                          <span className="bg-critical/20 text-critical ml-0.5 rounded-full px-1 text-[9px]">
                            {errorCount}
                          </span>
                        ) : warningCount > 0 ? (
                          <span className="bg-caution/20 text-caution ml-0.5 rounded-full px-1 text-[9px]">
                            {warningCount}
                          </span>
                        ) : null}
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="chat" className="min-h-0 flex-1 outline-none">
                      <ChatPanel
                        messages={chat.messages}
                        phase={chat.phase}
                        phaseMessage={chat.phaseMessage}
                        busy={chat.busy}
                        provider={aiProvider}
                        onSend={(text) => void chat.send(text)}
                        onCancel={chat.cancel}
                        onRate={(message, rating) => void chat.rate(message, rating)}
                        inputRef={chatInputRef}
                      />
                    </TabsContent>

                    <TabsContent
                      value="properties"
                      className="min-h-0 flex-1 overflow-hidden outline-none"
                    >
                      <Inspector />
                    </TabsContent>

                    <TabsContent
                      value="issues"
                      className="min-h-0 flex-1 overflow-hidden outline-none"
                    >
                      <ReviewPanel />
                    </TabsContent>
                  </Tabs>
                </div>
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>

      <StatusBar onShowIssues={() => setRightPanel('issues')} />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} projectId={projectId} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      {versionsOpen ? (
        <VersionsDialog onOpenChange={setVersionsOpen} projectId={projectId} />
      ) : null}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Onboarding
        onRunPrompt={(prompt) => {
          setRightPanel('chat');
          void chat.send(prompt);
        }}
      />
    </div>
  );
}

function ResizeHandle() {
  return (
    <PanelResizeHandle className="group bg-line data-[resize-handle-state=drag]:bg-accent hover:bg-line-strong relative w-px transition-colors">
      <span className="absolute inset-y-0 -left-1 w-2" />
    </PanelResizeHandle>
  );
}

/**
 * The design review panel.
 *
 * Findings are advice, never blockers, and the panel says so at the bottom.
 * Each one selects and frames its element, because a warning you cannot locate
 * is not much use.
 */
function ReviewPanel() {
  const findings = useEditorStore((state) => state.findings);
  const model = useEditorStore((state) => state.model);
  const setSelection = useEditorStore((state) => state.setSelection);
  const requestCamera = useEditorStore((state) => state.requestCamera);
  const operations = useEditorStore((state) => state.operations);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section>
          <div className="panel-header">
            <span>Design review</span>
            <span className="normal-case">
              {findings.length} finding{findings.length === 1 ? '' : 's'}
            </span>
          </div>

          {findings.length === 0 ? (
            <p className="text-ink-faint px-3 py-6 text-center text-xs">
              Nothing outstanding. Geometric checks and proportional conventions all pass.
            </p>
          ) : (
            <ul className="divide-line divide-y">
              {findings.map((finding) => {
                const element = finding.elementId ? model.elements[finding.elementId] : undefined;
                return (
                  <li key={finding.id}>
                    <button
                      type="button"
                      className="hover:bg-surface-hover w-full px-3 py-2.5 text-left transition-colors"
                      onClick={() => {
                        if (finding.elementId && model.elements[finding.elementId]) {
                          setSelection([finding.elementId]);
                          requestCamera({ kind: 'frame', ids: [finding.elementId] });
                        }
                      }}
                    >
                      <div className="flex items-start gap-2">
                        {finding.severity === 'error' ? (
                          <AlertTriangle className="text-critical mt-0.5 h-3 w-3 shrink-0" />
                        ) : finding.severity === 'warning' ? (
                          <TriangleAlert className="text-caution mt-0.5 h-3 w-3 shrink-0" />
                        ) : (
                          <Info className="text-ink-faint mt-0.5 h-3 w-3 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p
                            className={cn(
                              'text-xs font-medium',
                              finding.severity === 'error'
                                ? 'text-critical'
                                : finding.severity === 'warning'
                                  ? 'text-caution'
                                  : 'text-ink',
                            )}
                          >
                            {finding.title}
                          </p>
                          <p className="text-ink-muted mt-0.5 text-[11px] leading-relaxed">
                            {finding.detail}
                          </p>
                          {finding.suggestion ? (
                            <p className="text-ink-faint mt-1 text-[11px] leading-relaxed">
                              {finding.suggestion}
                            </p>
                          ) : null}
                          {finding.conventionSource ? (
                            <p className="text-ink-faint mt-1 text-[10px] leading-relaxed italic">
                              {finding.conventionSource}
                            </p>
                          ) : null}
                          {element ? (
                            <p className="text-accent mt-1 text-[10px]">{element.name}</p>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {operations.length > 0 ? (
          <section>
            <div className="panel-header">
              <span>Operation log</span>
            </div>
            <ul className="divide-line divide-y">
              {operations.slice(0, 30).map((operation) => (
                <li key={operation.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        operation.status === 'applied' ? 'bg-positive' : 'bg-critical',
                      )}
                    />
                    <span className="text-ink-muted min-w-0 flex-1 truncate text-[11px]">
                      {operation.label}
                    </span>
                    <span className="numeric text-ink-faint shrink-0">
                      {operation.source === 'ai'
                        ? 'AI'
                        : operation.source === 'import'
                          ? 'IMP'
                          : 'YOU'}
                    </span>
                  </div>
                  {operation.issues.length > 0 ? (
                    <p className="text-ink-faint mt-0.5 pl-3.5 text-[10px] leading-relaxed">
                      {operation.issues[0]?.message}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <p className="border-line text-ink-faint border-t px-3 py-2 text-[10px] leading-relaxed">
        These are geometric checks and proportioning conventions built into Atrium Studio. They are
        not a code check, an accessibility audit or a structural assessment.
      </p>
    </div>
  );
}

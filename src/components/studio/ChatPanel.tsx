'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  CircleHelp,
  Info,
  Loader2,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/primitives';
import type { ChatMessage } from '@/editor/useChat';
import { useEditorStore } from '@/editor/store';
import { cn } from '@/lib/utils';
import type { OperationPhase } from '@/ai/types';

/**
 * The conversation panel.
 *
 * The design problem here is that an AI operation has several distinct stages
 * and the user needs to know which one they are in — waiting on a model, having
 * commands validated, watching geometry appear — because each has a different
 * expected duration and a different meaning if it stalls. So the phase is
 * always shown explicitly rather than behind one undifferentiated spinner.
 *
 * Assumptions get their own block, because in a design tool the thing the AI
 * decided on your behalf is often more important than what you asked for.
 */

const PHASE_LABEL: Record<OperationPhase, string> = {
  queued: 'Queued',
  'reading-project': 'Reading the project',
  thinking: 'Interpreting',
  planning: 'Planning',
  validating: 'Validating',
  applying: 'Applying',
  summarising: 'Summarising',
  done: '',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STARTER_PROMPTS = [
  'Create a 10 m × 14 m single-storey pavilion.',
  'Add a 3 m-high perimeter wall with an entrance on the south side.',
  'Divide the floor into a studio, storage room, and accessible bathroom.',
  'Add three evenly spaced windows to the west façade.',
  'Change the façade to dark timber.',
  'Show the building during an overcast afternoon.',
];

export interface ChatPanelProps {
  messages: ChatMessage[];
  phase: OperationPhase;
  phaseMessage: string;
  busy: boolean;
  provider: { provider: string; model: string; note: string };
  onSend: (text: string) => void;
  onCancel: () => void;
  onRate: (message: ChatMessage, rating: 1 | -1) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function ChatPanel({
  messages,
  phase,
  phaseMessage,
  busy,
  provider,
  onSend,
  onCancel,
  onRate,
  inputRef,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const selection = useEditorStore((state) => state.selection);
  const model = useEditorStore((state) => state.model);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // Only follow the stream when the user is already at the bottom, so
    // scrolling back to read something is not fought by the autoscroll.
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160;
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="bg-surface flex h-full flex-col">
      <div className="panel-header">
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3 w-3" />
          Design assistant
        </span>
        <Tooltip content={provider.note} side="left">
          <span>
            <Badge tone={provider.provider === 'anthropic' ? 'ai' : 'neutral'}>
              {provider.provider === 'anthropic' ? provider.model : 'local'}
            </Badge>
          </span>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <EmptyConversation
            provider={provider}
            onPick={(text) => {
              setDraft(text);
              inputRef?.current?.focus();
            }}
          />
        ) : (
          <ol className="space-y-4">
            {messages.map((message) => (
              <li key={message.id}>
                <MessageBubble
                  message={message}
                  onRate={onRate}
                  onFollowUp={(text) => onSend(text)}
                />
              </li>
            ))}
          </ol>
        )}

        {busy && phase !== 'done' ? (
          <div className="border-line bg-surface-raised mt-4 flex items-center gap-2 rounded border px-2.5 py-2">
            <Loader2 className="text-ai h-3 w-3 animate-spin" />
            <span className="text-2xs text-ink-muted">
              {PHASE_LABEL[phase] || 'Working'}
              {phaseMessage ? ` — ${phaseMessage}` : ''}
            </span>
            <div className="working-stripes ml-auto h-1 w-16 rounded-full" aria-hidden />
          </div>
        ) : null}
      </div>

      <div className="border-line border-t p-2">
        {selection.length > 0 ? (
          <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
            <Badge tone="accent">
              {selection.length === 1
                ? (model.elements[selection[0]!]?.name ?? '1 selected')
                : `${selection.length} selected`}
            </Badge>
            <span className="text-ink-faint text-[10px]">will be used as context</span>
          </div>
        ) : null}

        <div className="border-line bg-void focus-within:border-line-strong rounded-lg border transition-colors">
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder="Describe a change… (Enter to send, Shift+Enter for a new line)"
            className="border-0 bg-transparent focus:border-0"
            aria-label="Message the design assistant"
            disabled={busy}
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-ink-faint text-[10px]">
              {busy ? 'Working…' : 'All lengths are interpreted in your project units.'}
            </span>
            {busy ? (
              <Button variant="secondary" size="sm" onClick={onCancel}>
                <Square className="h-3 w-3" />
                Stop
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={submit} disabled={!draft.trim()}>
                <ArrowUp className="h-3 w-3" />
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyConversation({
  provider,
  onPick,
}: {
  provider: { provider: string; note: string };
  onPick: (text: string) => void;
}) {
  return (
    <div className="py-4">
      <h2 className="text-ink text-xs font-medium">Describe what you want to build</h2>
      <p className="text-ink-muted mt-1.5 text-xs leading-relaxed">
        Talk about the design, not the software. Give dimensions where they matter and the assistant
        will state the ones it assumed.
      </p>

      <ul className="mt-4 space-y-1.5">
        {STARTER_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => onPick(prompt)}
              className="border-line bg-void text-ink-muted hover:border-line-strong hover:text-ink w-full rounded border px-2.5 py-2 text-left text-xs transition-colors"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>

      {provider.provider !== 'anthropic' ? (
        <div className="border-caution/30 bg-caution/5 mt-5 rounded border px-2.5 py-2">
          <p className="text-caution flex items-start gap-1.5 text-[11px] leading-relaxed">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{provider.note}</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  onRate,
  onFollowUp,
}: {
  message: ChatMessage;
  onRate: (message: ChatMessage, rating: 1 | -1) => void;
  onFollowUp: (text: string) => void;
}) {
  const setSelection = useEditorStore((state) => state.setSelection);
  const requestCamera = useEditorStore((state) => state.requestCamera);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="bg-accent-muted text-ink max-w-[85%] rounded-lg rounded-br-sm px-2.5 py-1.5 text-xs leading-relaxed">
          {message.content}
        </p>
      </div>
    );
  }

  const errored = message.status === 'error';
  const clarifying = message.status === 'clarification';

  return (
    <div className="space-y-2">
      {message.plan && message.plan.length > 0 ? (
        <ol className="border-line bg-void space-y-1 rounded border px-2.5 py-2">
          <li className="text-ink-faint mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase">
            <Wrench className="h-2.5 w-2.5" />
            Operation plan
          </li>
          {message.plan.map((step, index) => (
            <li key={index} className="text-ink-muted flex gap-2 text-[11px] leading-relaxed">
              <span className="numeric text-ink-faint shrink-0">{index + 1}</span>
              <span>
                {step.title}
                {step.detail ? <span className="text-ink-faint"> — {step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      <div
        className={cn(
          'rounded-lg rounded-bl-sm px-2.5 py-2 text-xs leading-relaxed',
          errored
            ? 'border-critical/40 bg-critical/10 text-critical border'
            : clarifying
              ? 'border-caution/40 bg-caution/10 text-ink border'
              : 'border-line bg-surface-raised text-ink border',
        )}
      >
        {clarifying ? (
          <p className="flex items-start gap-1.5">
            <CircleHelp className="text-caution mt-0.5 h-3 w-3 shrink-0" />
            <span>{message.content}</span>
          </p>
        ) : message.content ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <span className="text-ink-faint inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Thinking
          </span>
        )}

        {clarifying && message.clarificationOptions?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.clarificationOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onFollowUp(option)}
                className="border-caution/40 bg-caution/10 text-ink hover:bg-caution/20 rounded-full border px-2 py-1 text-[11px] transition-colors"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {message.assumptions && message.assumptions.length > 0 ? (
        <div className="border-line bg-void rounded border px-2.5 py-2">
          <p className="text-ink-faint mb-1 text-[10px] font-semibold tracking-wide uppercase">
            Assumptions
          </p>
          <ul className="space-y-0.5">
            {message.assumptions.map((assumption, index) => (
              <li key={index} className="text-ink-muted text-[11px] leading-relaxed">
                · {assumption}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message.issues && message.issues.length > 0 ? (
        <ul className="border-critical/30 bg-critical/5 space-y-1 rounded border px-2.5 py-2">
          {message.issues.slice(0, 6).map((issue, index) => (
            <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed">
              <AlertTriangle
                className={cn(
                  'mt-0.5 h-3 w-3 shrink-0',
                  issue.severity === 'error' ? 'text-critical' : 'text-caution',
                )}
              />
              <span className="text-ink-muted">
                {issue.message}
                {issue.hint ? <span className="text-ink-faint"> {issue.hint}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {message.findings && message.findings.length > 0 ? (
        <ul className="border-line bg-void space-y-1 rounded border px-2.5 py-2">
          <li className="text-ink-faint mb-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Design review
          </li>
          {message.findings.slice(0, 5).map((finding) => (
            <li key={finding.id} className="text-[11px] leading-relaxed">
              <button
                type="button"
                className="text-left"
                onClick={() => {
                  if (finding.elementId) {
                    setSelection([finding.elementId]);
                    requestCamera({ kind: 'frame', ids: [finding.elementId] });
                  }
                }}
              >
                <span
                  className={cn(
                    finding.severity === 'error'
                      ? 'text-critical'
                      : finding.severity === 'warning'
                        ? 'text-caution'
                        : 'text-ink-muted',
                  )}
                >
                  {finding.title}
                </span>
                <span className="text-ink-faint"> — {finding.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {message.citations && message.citations.length > 0 ? (
        <div className="border-line bg-void rounded border px-2.5 py-2">
          <p className="text-ink-faint mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase">
            <BookOpen className="h-2.5 w-2.5" />
            Sources consulted
          </p>
          <ul className="space-y-0.5">
            {message.citations.map((citation) => (
              <li
                key={`${citation.documentId}-${citation.score}`}
                className="text-ink-muted text-[11px]"
              >
                {citation.title}
                {citation.source && citation.source !== citation.title ? (
                  <span className="text-ink-faint"> · {citation.source}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message.status === 'complete' && message.operationId ? (
        <div className="flex items-center gap-2 px-0.5">
          {message.createdIds && message.createdIds.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setSelection(message.createdIds!);
                requestCamera({ kind: 'frame', ids: message.createdIds! });
              }}
              className="text-accent text-[10px] hover:underline"
            >
              Show the {message.createdIds.length} new element
              {message.createdIds.length === 1 ? '' : 's'}
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip content="This was a good result">
              <button
                type="button"
                onClick={() => onRate(message, 1)}
                aria-label="Good result"
                aria-pressed={message.feedback === 1}
                className={cn(
                  'hover:bg-surface-hover rounded p-1 transition-colors',
                  message.feedback === 1 ? 'text-positive' : 'text-ink-faint',
                )}
              >
                <ThumbsUp className="h-3 w-3" />
              </button>
            </Tooltip>
            <Tooltip content="This missed the mark">
              <button
                type="button"
                onClick={() => onRate(message, -1)}
                aria-label="Poor result"
                aria-pressed={message.feedback === -1}
                className={cn(
                  'hover:bg-surface-hover rounded p-1 transition-colors',
                  message.feedback === -1 ? 'text-critical' : 'text-ink-faint',
                )}
              >
                <ThumbsDown className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
        </div>
      ) : null}
    </div>
  );
}

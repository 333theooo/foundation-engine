'use client';

import { useState } from 'react';
import { ArrowRight, MessageSquare, MousePointerClick, Sparkles, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent } from '@/components/ui/primitives';
import { useEditorStore } from '@/editor/store';

/**
 * First-run onboarding.
 *
 * Teaches by doing rather than by touring. Each step ends with an action the
 * user takes in the real interface, and the first one actually runs a prompt —
 * so within thirty seconds there is a building on screen that they asked for.
 *
 * Dismissal is remembered per browser. It never reappears for a returning user
 * and never blocks anything: the dialog is closeable at every step.
 */

const STORAGE_KEY = 'atrium.onboarding.v1';

interface Step {
  title: string;
  body: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: { label: string; prompt: string };
}

const STEPS: Step[] = [
  {
    title: 'Describe what you want to build',
    body: 'Type an architectural intention into the chat on the right. The assistant turns it into real walls, slabs and openings with actual dimensions — not a picture of a building, a model you keep working in.',
    icon: MessageSquare,
    action: {
      label: 'Try it: create a pavilion',
      prompt: 'Create a 10 m × 14 m single-storey pavilion.',
    },
  },
  {
    title: 'Edit directly too',
    body: 'Click anything in the viewport to select it. Press W to move it, or type an exact dimension into the inspector. Manual edits go through the same engine as the AI, so the assistant always sees what you changed.',
    icon: MousePointerClick,
  },
  {
    title: 'Everything is undoable',
    body: 'AI operations and manual edits share one undo stack. Ctrl+Z steps back through both. If a set of AI commands fails validation, nothing is applied at all — the model is never left half-built.',
    icon: Undo2,
  },
  {
    title: 'Know what it is not',
    body: 'This is a concept and schematic design tool. It applies widely-used conventions and tells you which assumptions it made, but it does not check your design against any building standard. That work still belongs to a qualified professional.',
    icon: Sparkles,
  },
];

export function Onboarding({
  onRunPrompt,
  forceOpen = false,
  onClose,
}: {
  onRunPrompt: (prompt: string) => void;
  forceOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const elementCount = useEditorStore((state) => Object.keys(state.model.elements).length);
  const loaded = useEditorStore((state) => state.loaded);

  const [considered, setConsidered] = useState(false);

  // Decided once, during render, rather than in an effect that would open the
  // dialog on a second commit and make it flash in.
  if (!considered && (forceOpen || loaded)) {
    setConsidered(true);
    let seen = false;
    try {
      seen = localStorage.getItem(STORAGE_KEY) === 'done';
    } catch {
      // Storage unavailable: showing onboarding once per session is acceptable.
    }
    if (forceOpen || !seen) {
      setStep(0);
      setOpen(true);
    }
  }

  const dismiss = () => {
    setOpen(false);
    onClose?.();
    try {
      localStorage.setItem(STORAGE_KEY, 'done');
    } catch {
      // Nothing to do; onboarding will show again next session at worst.
    }
  };

  const current = STEPS[step];
  if (!current) return null;
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <DialogContent title="Welcome to Atrium Studio" className="w-[min(94vw,32rem)]">
        <div className="flex items-start gap-3">
          <span className="border-accent/30 bg-accent-muted text-accent mt-0.5 rounded-md border p-2">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-ink text-sm font-medium">{current.title}</h3>
            <p className="text-ink-muted mt-1.5 text-xs leading-relaxed">{current.body}</p>

            {current.action && elementCount === 0 ? (
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                onClick={() => {
                  onRunPrompt(current.action!.prompt);
                  setStep((value) => Math.min(value + 1, STEPS.length - 1));
                }}
              >
                {current.action.label}
                <ArrowRight className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <div className="flex gap-1" role="tablist" aria-label="Onboarding progress">
            {STEPS.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                role="tab"
                aria-selected={index === step}
                aria-label={entry.title}
                onClick={() => setStep(index)}
                className={
                  index === step
                    ? 'bg-accent h-1 w-6 rounded-full'
                    : 'bg-line hover:bg-line-strong h-1 w-6 rounded-full transition-colors'
                }
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Skip
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => (isLast ? dismiss() : setStep((value) => value + 1))}
            >
              {isLast ? 'Start designing' : 'Next'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

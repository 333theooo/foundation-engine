'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Box, Loader2, MessageSquare, Ruler, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * The landing page.
 *
 * Deliberately shaped like the thing it introduces: a dark ground, one prompt
 * field, and example requests you can click. Someone arriving here should
 * understand what the product does before reading a word of explanation — and
 * be one click from a live model.
 */

const EXAMPLE_PROMPTS = [
  'Create a 10 m × 14 m single-storey pavilion.',
  'Create a two-storey Scandinavian house, 12 by 8 metres.',
  'Add a 3 m-high perimeter wall with an entrance on the south side.',
  'Divide the floor into a studio, storage room, and accessible bathroom.',
  'Use oak flooring, white plaster walls, and dark metal window frames.',
];

export function Landing({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(initialPrompt: string) {
    if (busy) return;
    setBusy(true);
    try {
      if (signedIn) {
        router.push(
          initialPrompt.trim()
            ? `/dashboard?prompt=${encodeURIComponent(initialPrompt.trim())}`
            : '/dashboard',
        );
        return;
      }

      const response = await fetch('/api/auth/guest', { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Guest sessions are not available on this deployment.');
      }
      const { projectId } = (await response.json()) as { projectId: string };
      const suffix = initialPrompt.trim()
        ? `?prompt=${encodeURIComponent(initialPrompt.trim())}`
        : '';
      router.push(`/studio/${projectId}${suffix}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start a session.', {
        description: 'You can create an account instead.',
      });
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-line flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <Mark />
          <span className="text-sm font-semibold tracking-tight">Atrium Studio</span>
          <span className="border-line text-ink-faint ml-1 rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
            Preview
          </span>
        </div>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild variant="primary" size="sm">
            <Link href="/sign-up">Create account</Link>
          </Button>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-3xl">
          <h1 className="text-ink text-center text-3xl font-semibold tracking-tight sm:text-4xl">
            What are we designing?
          </h1>
          <p className="text-ink-muted mx-auto mt-3 max-w-xl text-center text-sm leading-relaxed">
            Describe a building in plain language. Atrium turns it into an editable, parametric 3D
            model — real walls, real dimensions, real openings — that you keep working in.
          </p>

          <form
            className="mt-8"
            onSubmit={(event) => {
              event.preventDefault();
              void start(prompt);
            }}
          >
            <div
              className={cn(
                'border-line bg-surface flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors',
                'focus-within:border-line-strong hover:border-line-strong',
              )}
            >
              <MessageSquare className="text-ink-faint h-4 w-4 shrink-0" aria-hidden />
              <input
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Create a two-storey house, 12 by 8 metres…"
                aria-label="Describe the building you want to create"
                className="text-ink placeholder:text-ink-faint flex-1 bg-transparent text-sm outline-none"
                disabled={busy}
              />
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5" />
                )}
                {busy ? 'Starting' : 'Start'}
              </Button>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => void start(example)}
                disabled={busy}
                className="border-line text-ink-muted hover:border-line-strong hover:bg-surface hover:text-ink rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>

          <p className="text-2xs text-ink-faint mt-6 text-center">
            Starting without an account creates a private guest workspace that lasts seven days.
          </p>
        </div>

        <div className="mt-20 grid w-full max-w-4xl gap-4 sm:grid-cols-3">
          <Feature
            icon={<Box className="h-4 w-4" />}
            title="A model, not a picture"
            body="Walls, slabs, rooms, openings, roofs and stairs are semantic objects with real dimensions. Windows stay hosted by their walls and move when the wall does."
          />
          <Feature
            icon={<Ruler className="h-4 w-4" />}
            title="Edit either way"
            body="Ask in the chat, or drag a gizmo and type a number. Both go through the same command engine, so undo works the same and the AI always sees the current design."
          />
          <Feature
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Honest about its limits"
            body="A concept and schematic tool. It applies widely-used conventions and says so — it does not check your design against any building standard."
          />
        </div>
      </main>

      <footer className="border-line text-2xs text-ink-faint border-t px-6 py-4 text-center">
        Atrium Studio is a concept and schematic design tool. It does not produce permit-grade
        information and it is not a substitute for a licensed professional.
      </footer>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="border-line bg-surface rounded-lg border p-4">
      <div className="text-accent flex items-center gap-2">{icon}</div>
      <h2 className="text-ink mt-2.5 text-xs font-semibold">{title}</h2>
      <p className="text-ink-muted mt-1 text-xs leading-relaxed">{body}</p>
    </div>
  );
}

/** The product mark: an atrium in plan — a void within a solid. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('text-accent h-5 w-5', className)}
      fill="none"
      aria-hidden
    >
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="8.5"
        y="8.5"
        width="7"
        height="7"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.55"
      />
      <path
        d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.35"
      />
    </svg>
  );
}

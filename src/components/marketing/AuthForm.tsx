'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';
import { Mark } from './Landing';

/**
 * Sign in and sign up.
 *
 * One component for both, because the only differences are the endpoint, the
 * copy and one extra field. Errors are rendered inline rather than as toasts:
 * a credentials error belongs next to the credentials.
 */
export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'sign-up';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(isSignUp ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isSignUp ? { email, password, name } : { email, password }),
      });
      const body = (await response.json()) as { error?: string; projectId?: string };
      if (!response.ok) throw new Error(body.error ?? 'That did not work.');
      router.push(body.projectId ? `/studio/${body.projectId}` : '/dashboard');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <Mark />
          <span className="text-sm font-semibold tracking-tight">Atrium Studio</span>
        </Link>

        <div className="border-line bg-surface rounded-lg border p-6">
          <h1 className="text-ink text-base font-semibold">
            {isSignUp ? 'Create your account' : 'Sign in'}
          </h1>
          <p className="text-ink-muted mt-1 text-xs">
            {isSignUp ? 'Your projects are private to your account.' : 'Welcome back.'}
          </p>

          <form className="mt-5 space-y-3" onSubmit={submit}>
            {isSignUp ? (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  placeholder="Your name"
                />
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@studio.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                placeholder={isSignUp ? 'At least 10 characters' : ''}
              />
            </div>

            {error ? (
              <p
                role="alert"
                className="border-critical/40 bg-critical/10 text-critical rounded border px-2.5 py-2 text-xs"
              >
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {isSignUp ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </div>

        <p className="text-ink-muted mt-4 text-center text-xs">
          {isSignUp ? 'Already have an account? ' : 'No account yet? '}
          <Link href={isSignUp ? '/sign-in' : '/sign-up'} className="text-accent hover:underline">
            {isSignUp ? 'Sign in' : 'Create one'}
          </Link>
        </p>
      </div>
    </div>
  );
}

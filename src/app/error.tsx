'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * The route error boundary.
 *
 * Shows what the user can do, not a stack trace. The digest is included because
 * it is the only thing that ties this screen to the server log entry, and it
 * carries no project content.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Route error', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertTriangle className="text-caution h-7 w-7" />
      <h1 className="text-ink text-lg font-semibold">Something went wrong</h1>
      <p className="text-ink-muted max-w-md text-xs leading-relaxed">
        The page could not be rendered. Your project is stored on the server and was not affected by
        this error.
      </p>
      {error.digest ? <p className="numeric text-ink-faint">Reference: {error.digest}</p> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="md" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="secondary" size="md">
          <Link href="/dashboard">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}

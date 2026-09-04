import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Mark } from '@/components/marketing/Landing';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <Mark className="h-8 w-8 opacity-60" />
      <h1 className="text-ink text-lg font-semibold">That page does not exist</h1>
      <p className="text-ink-muted max-w-sm text-xs leading-relaxed">
        The project may have been deleted, or it belongs to a different account.
      </p>
      <Button asChild variant="primary" size="md">
        <Link href="/dashboard">Back to your projects</Link>
      </Button>
    </div>
  );
}

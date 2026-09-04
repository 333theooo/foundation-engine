import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges conditional class names, with later Tailwind utilities winning. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Debounce that returns a cancel handle. Used by autosave and search fields. */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): ((...args: Args) => void) & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Args | null = null;

  const wrapped = (...args: Args) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args_ = pending;
      pending = null;
      if (args_) fn(...args_);
    }, waitMs);
  };

  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  wrapped.flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };

  return wrapped;
}

export function formatRelativeTime(timestamp: number | string | Date): string {
  const value = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const seconds = Math.round((Date.now() - value) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True when the event target is a field, so global shortcuts stand down. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

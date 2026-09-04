'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'border-line bg-void text-ink h-8 w-full rounded border px-2 text-xs transition-colors',
        'placeholder:text-ink-faint hover:border-line-strong focus:border-accent focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'border-line bg-void text-ink w-full resize-none rounded border px-2.5 py-2 text-xs leading-relaxed transition-colors',
      'placeholder:text-ink-faint hover:border-line-strong focus:border-accent focus:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export const Label = forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-2xs text-ink-muted font-medium tracking-wide', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

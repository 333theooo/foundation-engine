'use client';

import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
        secondary: 'bg-surface-raised text-ink hover:bg-surface-hover border border-line',
        ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        outline: 'border border-line-strong text-ink hover:bg-surface-hover',
        danger: 'bg-critical/15 text-critical hover:bg-critical/25 border border-critical/30',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 text-2xs',
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-xs',
        lg: 'h-10 px-4 text-sm',
        icon: 'h-7 w-7',
        'icon-sm': 'h-6 w-6',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Component = asChild ? Slot : 'button';
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        type={asChild ? undefined : (type ?? 'button')}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };

import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wide whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-surface-raised text-ink-muted',
        accent: 'border-accent/40 bg-accent/10 text-accent',
        ai: 'border-ai/40 bg-ai/10 text-ai',
        positive: 'border-positive/40 bg-positive/10 text-positive',
        caution: 'border-caution/40 bg-caution/10 text-caution',
        critical: 'border-critical/40 bg-critical/10 text-critical',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

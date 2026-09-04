'use client';

import { forwardRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Accessible primitives.
 *
 * Radix supplies the behaviour — focus traps, roving tab index, escape
 * handling, ARIA wiring — and these wrappers supply the house style. Building
 * these on Radix rather than from scratch is what makes the keyboard and screen
 * reader story real rather than aspirational.
 */

/* ---------------------------------- Dialog --------------------------------- */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    title: string;
    description?: string;
  }
>(({ className, children, title, description, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="bg-void/70 fixed inset-0 z-50 backdrop-blur-sm" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed top-1/2 left-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2',
        'border-line bg-surface shadow-pop rounded-lg border',
        className,
      )}
      {...props}
    >
      <div className="border-line flex items-start justify-between gap-4 border-b px-4 py-3">
        <div>
          <DialogPrimitive.Title className="text-ink text-sm font-semibold">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="text-ink-muted mt-0.5 text-xs">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
        </div>
        <DialogPrimitive.Close
          className="text-ink-faint hover:bg-surface-hover hover:text-ink rounded p-1 transition-colors"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </DialogPrimitive.Close>
      </div>
      <div className="p-4">{children}</div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

/* --------------------------------- Tooltip --------------------------------- */

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  children,
  content,
  side = 'bottom',
  shortcut,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  shortcut?: string;
}) {
  return (
    <TooltipPrimitive.Root delayDuration={400}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="border-line bg-surface-raised text-2xs text-ink shadow-pop z-50 flex items-center gap-2 rounded border px-2 py-1"
        >
          {content}
          {shortcut ? (
            <kbd className="border-line bg-void text-ink-faint rounded border px-1 font-mono text-[10px]">
              {shortcut}
            </kbd>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ----------------------------------- Tabs ---------------------------------- */

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('border-line flex items-center gap-0.5 border-b px-1', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'text-2xs text-ink-faint relative px-2.5 py-2 font-medium tracking-wide uppercase transition-colors',
      'hover:text-ink-muted data-[state=active]:text-ink',
      'after:absolute after:inset-x-1.5 after:-bottom-px after:h-px after:bg-transparent',
      'data-[state=active]:after:bg-accent',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = TabsPrimitive.Content;

/* ---------------------------------- Select --------------------------------- */

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'border-line bg-void text-ink flex h-7 w-full items-center justify-between gap-2 rounded border px-2 text-xs',
      'hover:border-line-strong focus:border-accent transition-colors focus:outline-none disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="text-ink-faint h-3 w-3" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position="popper"
      sideOffset={4}
      className={cn(
        'border-line bg-surface-raised shadow-pop z-50 max-h-72 min-w-[8rem] overflow-hidden rounded border',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'text-ink relative flex cursor-pointer items-center rounded-sm py-1.5 pr-2 pl-6 text-xs outline-none select-none',
      'data-[highlighted]:bg-surface-hover data-[state=checked]:text-accent',
      className,
    )}
    {...props}
  >
    <span className="absolute left-1.5 flex h-3 w-3 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3 w-3" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';

/* ---------------------------------- Switch --------------------------------- */

export const Switch = forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'border-line relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
      'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:bg-void',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="bg-ink-muted data-[state=checked]:bg-accent-ink pointer-events-none block h-2.5 w-2.5 translate-x-0.5 rounded-full transition-transform data-[state=checked]:translate-x-3.5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

/* ---------------------------------- Slider --------------------------------- */

export const Slider = forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none items-center select-none', className)}
    {...props}
  >
    <SliderPrimitive.Track className="bg-void relative h-1 w-full grow rounded-full">
      <SliderPrimitive.Range className="bg-accent absolute h-full rounded-full" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="border-accent bg-surface-raised hover:bg-surface-hover block h-3 w-3 rounded-full border transition-colors focus:outline-none" />
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';

/* -------------------------------- Separator -------------------------------- */

export const Separator = forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    orientation={orientation}
    className={cn(
      'bg-line shrink-0',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

/* ------------------------------- Collapsible ------------------------------- */

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;

/* --------------------------------- Dropdown -------------------------------- */

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuSeparator = forwardRef<
  React.ComponentRef<typeof DropdownPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownPrimitive.Separator
    ref={ref}
    className={cn('bg-line my-1 h-px', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export const DropdownMenuContent = forwardRef<
  React.ComponentRef<typeof DropdownPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      ref={ref}
      sideOffset={4}
      className={cn(
        'border-line bg-surface-raised shadow-pop z-50 min-w-[10rem] rounded border p-1',
        className,
      )}
      {...props}
    />
  </DropdownPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = forwardRef<
  React.ComponentRef<typeof DropdownPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn(
      'text-ink flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none select-none',
      'data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

/* --------------------------------- Popover --------------------------------- */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={6}
      className={cn(
        'border-line bg-surface-raised shadow-pop z-50 w-64 rounded border p-3',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';

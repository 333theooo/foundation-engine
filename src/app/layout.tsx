import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/primitives';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Atrium Studio — conversational 3D for architects',
    template: '%s · Atrium Studio',
  },
  description:
    'Describe a building in plain language and watch it take shape as an editable, parametric 3D model. A concept and schematic design tool for architects and architecture students.',
  applicationName: 'Atrium Studio',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0d0f12',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-canvas text-ink min-h-screen antialiased">
        <TooltipProvider delayDuration={400} skipDelayDuration={200}>
          {children}
          <Toaster
            position="bottom-center"
            theme="dark"
            closeButton
            toastOptions={{
              classNames: {
                toast: 'border border-line bg-surface-raised text-ink text-xs shadow-pop',
                description: 'text-ink-muted',
                actionButton: 'bg-accent text-accent-ink',
              },
            }}
          />
        </TooltipProvider>
      </body>
    </html>
  );
}

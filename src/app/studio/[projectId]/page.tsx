import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getCurrentUser } from '@/server/auth';
import { getProject, ProjectAccessError } from '@/server/projects';
import { prisma } from '@/server/db';
import { providerStatus } from '@/ai/orchestrator';
import { Studio } from '@/components/studio/Studio';
import type { ChatMessage } from '@/editor/useChat';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const user = await getCurrentUser();
  if (!user) return { title: 'Studio' };
  try {
    const { projectId } = await params;
    const project = await getProject(user, projectId);
    return { title: project.name };
  } catch {
    return { title: 'Studio' };
  }
}

export default async function StudioPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const { projectId } = await params;

  let record;
  try {
    record = await getProject(user, projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) notFound();
    throw error;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } },
  });

  const initialMessages: ChatMessage[] = (conversation?.messages ?? [])
    .filter((message) => message.role !== 'SYSTEM')
    .map((message) => {
      const metadata = (message.metadata ?? {}) as Record<string, unknown>;
      return {
        id: message.id,
        role: message.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: message.content,
        createdAt: message.createdAt.getTime(),
        status: 'complete' as const,
        provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
        model: typeof metadata.model === 'string' ? metadata.model : undefined,
      };
    });

  return (
    <Suspense fallback={<StudioSkeleton />}>
      <Studio
        projectId={record.id}
        projectName={record.name}
        initialModel={record.model}
        loadWarnings={record.loadWarnings}
        initialMessages={initialMessages}
        user={{ name: user.name, isGuest: user.isGuest }}
        aiProvider={providerStatus()}
      />
    </Suspense>
  );
}

function StudioSkeleton() {
  return (
    <div className="flex h-screen flex-col">
      <div className="border-line bg-surface h-11 shrink-0 border-b" />
      <div className="flex flex-1">
        <div className="border-line bg-surface w-56 border-r" />
        <div className="bg-canvas flex-1" />
        <div className="border-line bg-surface w-80 border-l" />
      </div>
      <div className="border-line bg-surface h-7 shrink-0 border-t" />
    </div>
  );
}

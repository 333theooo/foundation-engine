import { apiOk, route } from '@/server/api';
import { prisma } from '@/server/db';
import { getProject } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = route<{ projectId: string }>(async ({ params, user }) => {
  // Ownership is checked by loading the project first; the conversation is a
  // child of it, so this is the only authorisation the read needs.
  await getProject(user, params.projectId);

  const conversation = await prisma.conversation.findFirst({
    where: { projectId: params.projectId },
    orderBy: { createdAt: 'asc' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
  });

  return apiOk({
    conversationId: conversation?.id ?? null,
    messages:
      conversation?.messages.map((message) => ({
        id: message.id,
        role: message.role.toLowerCase(),
        content: message.content,
        metadata: message.metadata,
        createdAt: message.createdAt.toISOString(),
      })) ?? [],
  });
});

import { z } from 'zod';
import { apiError, apiOk, readJson, route } from '@/server/api';
import { prisma } from '@/server/db';

const schema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().max(1_000).default(''),
});

/**
 * Records feedback on an AI operation.
 *
 * Stored alongside the request, the scene summary the model was given, the
 * commands it produced and the validation result. That is deliberately the
 * shape a reviewed fine-tuning set would need — but nothing here trains
 * anything. Any future use of this data would be an explicit, reviewed,
 * opt-in process, not a side effect of clicking thumbs-down.
 */
export const POST = route<{ operationId: string }>(async ({ request, params, user }) => {
  const input = await readJson(request, schema);

  const operation = await prisma.operation.findFirst({
    where: { id: params.operationId, project: { ownerId: user.id } },
    select: { id: true },
  });
  if (!operation) return apiError('Operation not found.', 404);

  const feedback = await prisma.operationFeedback.upsert({
    where: { operationId_userId: { operationId: operation.id, userId: user.id } },
    create: {
      operationId: operation.id,
      userId: user.id,
      rating: input.rating,
      reason: input.reason,
    },
    update: { rating: input.rating, reason: input.reason },
  });

  return apiOk({ feedback: { id: feedback.id, rating: feedback.rating } });
});

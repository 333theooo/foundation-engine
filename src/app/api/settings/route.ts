import { z } from 'zod';
import { apiOk, readJson, route } from '@/server/api';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

const schema = z.object({
  units: z.enum(['metric', 'imperial']).optional(),
  defaults: z
    .object({
      wallThickness: z.number().min(50).max(1_000).optional(),
      storeyHeight: z.number().min(1_800).max(12_000).optional(),
      doorHeight: z.number().min(1_500).max(4_000).optional(),
      windowSill: z.number().min(0).max(3_000).optional(),
    })
    .optional(),
  houseRules: z.string().max(2_000).optional(),
  reducedMotion: z.boolean().optional(),
});

export const GET = route(async ({ user }) => apiOk({ settings: user.settings }));

/**
 * Updates user preferences. These reach the AI as a stable preference block, so
 * a studio's house conventions ("we detail external walls at 350") persist
 * across projects instead of being restated every session.
 */
export const PATCH = route(async ({ request, user }) => {
  const patch = await readJson(request, schema);
  const merged = { ...(user.settings ?? {}), ...patch };
  await prisma.user.update({ where: { id: user.id }, data: { settings: merged } });
  return apiOk({ settings: merged });
});

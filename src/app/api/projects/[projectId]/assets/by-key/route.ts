import { apiError, route } from '@/server/api';
import { prisma } from '@/server/db';
import { assertSafeKey, storage } from '@/server/storage';

export const dynamic = 'force-dynamic';

/**
 * Serves an uploaded source file by its storage key.
 *
 * The project model references imports by key rather than by asset id, because
 * the key is what the import command carries. The lookup is still scoped by
 * owner and project, so a key guessed or copied from another account resolves
 * to nothing.
 */
export const GET = route<{ projectId: string }>(async ({ request, params, user }) => {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return apiError('A storage key is required.', 400);

  try {
    assertSafeKey(key);
  } catch {
    return apiError('That is not a valid storage key.', 400);
  }

  const asset = await prisma.asset.findFirst({
    where: { key, ownerId: user.id, projectId: params.projectId },
  });
  if (!asset) return apiError('Asset not found.', 404);

  const bytes = await storage().get(asset.key);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${asset.filename.replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

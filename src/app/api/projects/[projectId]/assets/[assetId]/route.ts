import { apiError, route } from '@/server/api';
import { prisma } from '@/server/db';
import { storage } from '@/server/storage';

export const dynamic = 'force-dynamic';

/**
 * Serves an uploaded source file back to its owner.
 *
 * The row is looked up by id *and* owner *and* project, so a guessed id from
 * another account resolves to nothing. Content-Disposition is `attachment` with
 * a sanitised filename, so a hostile upload cannot render in the origin.
 */
export const GET = route<{ projectId: string; assetId: string }>(async ({ params, user }) => {
  const asset = await prisma.asset.findFirst({
    where: { id: params.assetId, ownerId: user.id, projectId: params.projectId },
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

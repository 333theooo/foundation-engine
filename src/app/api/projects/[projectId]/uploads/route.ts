import { apiError, apiOk, route } from '@/server/api';
import { prisma } from '@/server/db';
import { getProject } from '@/server/projects';
import { MAX_UPLOAD_BYTES } from '@/domain/project/limits';
import {
  ALLOWED_MODEL_EXTENSIONS,
  createStorageKey,
  displayFilename,
  extensionOf,
  storage,
} from '@/server/storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Stores an uploaded source file for a project.
 *
 * Parsing happens on the client, in a worker — see src/io. This endpoint keeps
 * the original so an imported model can be re-loaded when the project is
 * reopened, and so the user can see exactly what was brought in.
 *
 * Validation order matters: extension allowlist, then declared size, then the
 * actual byte length. A client-declared size is a hint, never a guarantee.
 */
export const POST = route<{ projectId: string }>(
  async ({ request, params, user, log }) => {
    await getProject(user, params.projectId);

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return apiError('No file was provided.', 400);
    }

    const extension = extensionOf(file.name);
    if (!(ALLOWED_MODEL_EXTENSIONS as readonly string[]).includes(extension)) {
      return apiError(
        `"${displayFilename(file.name)}" has an unsupported extension. Accepted: ${ALLOWED_MODEL_EXTENSIONS.join(', ')}.`,
        415,
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return apiError(
        `Uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB. That file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
        413,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return apiError('That file is larger than it claimed to be.', 413);
    }

    const key = createStorageKey('imports', user.id, extension);
    const stored = await storage().put(key, bytes, file.type || 'application/octet-stream');

    const asset = await prisma.asset.create({
      data: {
        ownerId: user.id,
        projectId: params.projectId,
        kind: 'IMPORT_SOURCE',
        key: stored.key,
        filename: displayFilename(file.name),
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: stored.size,
        checksum: stored.checksum,
      },
    });

    log.info({ assetId: asset.id, bytes: stored.size, extension }, 'import source stored');

    return apiOk(
      {
        asset: {
          id: asset.id,
          key: asset.key,
          filename: asset.filename,
          sizeBytes: asset.sizeBytes,
          format: extension,
        },
      },
      { status: 201 },
    );
  },
  { rateLimit: 'upload' },
);

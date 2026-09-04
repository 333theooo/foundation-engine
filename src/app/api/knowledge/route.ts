import { apiError, apiOk, route } from '@/server/api';
import { ingestDocument, listDocuments } from '@/knowledge';
import { MAX_DOCUMENT_BYTES } from '@/domain/project/limits';
import { ALLOWED_DOCUMENT_EXTENSIONS, displayFilename, extensionOf } from '@/server/storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = route(async ({ request, user }) => {
  const projectId = new URL(request.url).searchParams.get('projectId');
  const documents = await listDocuments(user, projectId);
  return apiOk({ documents });
});

export const POST = route(
  async ({ request, user }) => {
    const form = await request.formData();
    const file = form.get('file');
    const scope = String(form.get('scope') ?? 'USER').toUpperCase();
    const projectId = form.get('projectId') ? String(form.get('projectId')) : null;
    const source = String(form.get('source') ?? '');
    const licence = String(form.get('licence') ?? '');

    if (!(file instanceof File)) return apiError('No file was provided.', 400);
    if (scope !== 'USER' && scope !== 'PROJECT') {
      return apiError(
        'Scope must be USER or PROJECT. The shared library is managed by the deployment.',
        400,
      );
    }
    const extension = extensionOf(file.name);
    if (!(ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) {
      return apiError(
        `Knowledge documents must be one of: ${ALLOWED_DOCUMENT_EXTENSIONS.join(', ')}. Convert "${displayFilename(file.name)}" to text first.`,
        415,
      );
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return apiError(
        `Documents are limited to ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`,
        413,
      );
    }

    try {
      const result = await ingestDocument(user, {
        title: displayFilename(file.name),
        source: source || displayFilename(file.name),
        licence,
        mimeType: file.type || 'text/plain',
        bytes: new Uint8Array(await file.arrayBuffer()),
        scope,
        projectId: scope === 'PROJECT' ? projectId : null,
      });
      return apiOk({ document: result }, { status: 201 });
    } catch (error) {
      return apiError(error instanceof Error ? error.message : 'Indexing failed.', 400);
    }
  },
  { rateLimit: 'upload' },
);

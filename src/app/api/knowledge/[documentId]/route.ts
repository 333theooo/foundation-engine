import { apiError, apiOk, route } from '@/server/api';
import { deleteDocument } from '@/knowledge';

export const DELETE = route<{ documentId: string }>(async ({ params, user }) => {
  try {
    await deleteDocument(user, params.documentId);
    return apiOk({ ok: true });
  } catch (error) {
    return apiError(
      error instanceof Error ? error.message : 'Could not delete that document.',
      404,
    );
  }
});

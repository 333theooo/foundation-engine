import { z } from 'zod';
import { apiError, apiOk, readJson, route } from '@/server/api';
import { getProject, saveProjectModel } from '@/server/projects';
import { projectModelSchema } from '@/domain/project/schema';

export const dynamic = 'force-dynamic';

const saveSchema = z.object({
  model: projectModelSchema,
  versionLabel: z.string().max(120).optional(),
  versionKind: z.enum(['AUTOSAVE', 'MANUAL', 'SNAPSHOT', 'IMPORT', 'RESTORE_POINT']).optional(),
  /**
   * The revision the client started from. If the stored project has moved on,
   * the save is refused rather than silently overwriting another tab's work.
   */
  baseRevision: z.number().int().min(0).optional(),
});

export const PUT = route<{ projectId: string }>(async ({ request, params, user }) => {
  const input = await readJson(request, saveSchema);

  if (input.baseRevision !== undefined) {
    const current = await getProject(user, params.projectId);
    if (
      current.model.revision > input.baseRevision &&
      current.model.revision !== input.model.revision
    ) {
      return apiError(
        'This project changed in another session. Reload to get the latest version before saving.',
        409,
        { serverRevision: current.model.revision },
      );
    }
  }

  const summary = await saveProjectModel(user, params.projectId, input.model, {
    ...(input.versionLabel ? { versionLabel: input.versionLabel } : {}),
    ...(input.versionKind ? { versionKind: input.versionKind } : {}),
  });
  return apiOk({ project: summary, savedAt: new Date().toISOString() });
});

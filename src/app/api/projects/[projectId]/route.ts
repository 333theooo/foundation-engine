import { z } from 'zod';
import { apiOk, readJson, route } from '@/server/api';
import { deleteProject, getProject, renameProject, setArchived } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = route<{ projectId: string }>(async ({ params, user }) => {
  const project = await getProject(user, params.projectId);
  return apiOk({
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      updatedAt: project.updatedAt,
      archivedAt: project.archivedAt,
    },
    model: project.model,
    warnings: project.loadWarnings,
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
});

export const PATCH = route<{ projectId: string }>(async ({ request, params, user }) => {
  const input = await readJson(request, patchSchema);
  let summary = null;
  if (input.name !== undefined) summary = await renameProject(user, params.projectId, input.name);
  if (input.archived !== undefined)
    summary = await setArchived(user, params.projectId, input.archived);
  return apiOk({ project: summary });
});

export const DELETE = route<{ projectId: string }>(async ({ params, user }) => {
  await deleteProject(user, params.projectId);
  return apiOk({ ok: true });
});

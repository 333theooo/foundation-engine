import { apiOk, route } from '@/server/api';
import { duplicateProject } from '@/server/projects';

export const POST = route<{ projectId: string }>(async ({ params, user }) => {
  const project = await duplicateProject(user, params.projectId);
  return apiOk({ project }, { status: 201 });
});

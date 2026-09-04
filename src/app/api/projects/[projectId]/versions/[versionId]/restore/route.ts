import { apiOk, route } from '@/server/api';
import { restoreVersion } from '@/server/projects';

export const POST = route<{ projectId: string; versionId: string }>(async ({ params, user }) => {
  const restored = await restoreVersion(user, params.projectId, params.versionId);
  return apiOk({ model: restored.model, warnings: restored.loadWarnings });
});

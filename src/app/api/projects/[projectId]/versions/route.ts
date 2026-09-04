import { z } from 'zod';
import { apiOk, readJson, route } from '@/server/api';
import { createVersion, listVersions } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = route<{ projectId: string }>(async ({ params, user }) => {
  const versions = await listVersions(user, params.projectId);
  return apiOk({ versions });
});

const schema = z.object({ label: z.string().min(1).max(120) });

export const POST = route<{ projectId: string }>(async ({ request, params, user }) => {
  const { label } = await readJson(request, schema);
  const version = await createVersion(user, params.projectId, label, 'MANUAL');
  return apiOk({ version }, { status: 201 });
});

import { z } from 'zod';
import { apiOk, readJson, route } from '@/server/api';
import { createProject, listProjects } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, user }) => {
  const includeArchived = new URL(request.url).searchParams.get('archived') === 'true';
  const projects = await listProjects(user, { includeArchived });
  return apiOk({ projects });
});

const createSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  template: z.enum(['empty', 'sample']).optional(),
});

export const POST = route(async ({ request, user, log }) => {
  const input = await readJson(request, createSchema);
  const project = await createProject(user, input);
  log.info({ projectId: project.id }, 'project created');
  return apiOk(
    { project: { id: project.id, name: project.name }, model: project.model },
    { status: 201 },
  );
});

import { z } from 'zod';
import { apiOk, readJson, route } from '@/server/api';
import { registerUser, signIn } from '@/server/auth';
import { createProject } from '@/server/projects';

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(256),
  name: z.string().max(80).optional(),
});

export const POST = route(
  async ({ request }) => {
    const input = await readJson(request, schema);
    const user = await registerUser(input);
    await signIn(user);

    // A new account lands on something worth looking at rather than an empty
    // dashboard, which is the difference between "I'll come back to it" and a
    // first session that actually happens.
    const project = await createProject(user, { template: 'sample', name: 'Lakeside Studio' });

    return apiOk({
      user: { id: user.id, email: user.email, name: user.name },
      projectId: project.id,
    });
  },
  { auth: 'none', rateLimit: 'auth' },
);

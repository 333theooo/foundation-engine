import { z } from 'zod';
import { apiOk, readJson, route } from '@/server/api';
import { authenticate, signIn } from '@/server/auth';

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(256),
});

export const POST = route(
  async ({ request }) => {
    const { email, password } = await readJson(request, schema);
    const user = await authenticate(email, password);
    await signIn(user);
    return apiOk({ user: { id: user.id, email: user.email, name: user.name } });
  },
  { auth: 'none', rateLimit: 'auth' },
);

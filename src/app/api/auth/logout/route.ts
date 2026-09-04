import { apiOk, route } from '@/server/api';
import { signOut } from '@/server/auth';

export const POST = route(
  async () => {
    await signOut();
    return apiOk({ ok: true });
  },
  { auth: 'none' },
);

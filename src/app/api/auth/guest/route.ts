import { apiOk, route } from '@/server/api';
import { createGuestUser, signIn } from '@/server/auth';
import { createProject } from '@/server/projects';

/**
 * Starts a guest session.
 *
 * The guest is a real account with its own isolated data and a seven-day life.
 * Nothing about ownership checking is relaxed for it — the only difference is
 * that it was created without a password and expires.
 */
export const POST = route(
  async () => {
    const user = await createGuestUser();
    await signIn(user);
    const project = await createProject(user, { template: 'sample', name: 'Lakeside Studio' });
    return apiOk({
      user: { id: user.id, name: user.name, isGuest: true },
      projectId: project.id,
    });
  },
  { auth: 'none', rateLimit: 'auth' },
);

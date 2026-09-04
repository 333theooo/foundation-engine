import { apiOk, route } from '@/server/api';
import { getCurrentUser } from '@/server/auth';
import { providerStatus } from '@/ai/orchestrator';

export const dynamic = 'force-dynamic';

export const GET = route(
  async () => {
    const user = await getCurrentUser();
    return apiOk({
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            isGuest: user.isGuest,
            settings: user.settings,
          }
        : null,
      ai: providerStatus(),
    });
  },
  { auth: 'none' },
);

import { getCurrentUser } from '@/server/auth';
import { Landing } from '@/components/marketing/Landing';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getCurrentUser();
  return <Landing signedIn={Boolean(user)} />;
}

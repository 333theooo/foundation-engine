import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth';
import { listProjects } from '@/server/projects';
import { Dashboard } from '@/components/dashboard/Dashboard';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const projects = await listProjects(user, { includeArchived: true });

  return (
    <Dashboard
      initialProjects={projects}
      user={{ name: user.name, email: user.email, isGuest: user.isGuest }}
    />
  );
}

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth';
import { AuthForm } from '@/components/marketing/AuthForm';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (await getCurrentUser()) redirect('/dashboard');
  return <AuthForm mode="sign-in" />;
}

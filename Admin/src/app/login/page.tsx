import { LoginForm } from '@/components/LoginForm';

export const metadata = { title: 'Sign in · Restaurant Admin' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Restaurant Admin</h1>
        <p className="muted">Sign in to manage restaurants, subscriptions and access.</p>
        <LoginForm initialError={error === 'not-admin' ? 'This account does not have admin access.' : null} />
      </div>
    </main>
  );
}

import { SetPasswordForm } from '@/components/SetPasswordForm';

export const metadata = { title: 'Set your password' };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Set your password</h1>
        {token
          ? <SetPasswordForm token={token} />
          : <p className="error" role="alert">This link is incomplete. Please ask for a new one.</p>}
      </div>
    </main>
  );
}

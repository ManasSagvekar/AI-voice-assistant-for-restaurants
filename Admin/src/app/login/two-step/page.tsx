import { redirect } from 'next/navigation';
import { twoStepRequired } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { signOut } from '@/app/login/actions';
import { TwoStepForm } from '@/components/TwoStepForm';

export const metadata = { title: '2-step sign-in · Restaurant Admin' };
export const dynamic = 'force-dynamic';

export default async function TwoStepPage() {
  if (!twoStepRequired()) redirect('/');
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) redirect('/login?error=not-admin');
  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (level?.currentLevel === 'aal2') redirect('/');
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const enrolled = !!factors?.totp.some((f) => f.status === 'verified');
  return (
    <main className="center">
      <div className="card narrow">
        <h1>2-step sign-in</h1>
        <TwoStepForm enrolled={enrolled} />
        <form action={signOut}><button className="btn ghost small">Sign out</button></form>
      </div>
    </main>
  );
}

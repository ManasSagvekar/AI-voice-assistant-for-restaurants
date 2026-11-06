import 'server-only';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabaseServer';

// 2-step sign-in is off for now and planned to return. ADMIN_2FA=on turns it back on.
export const twoStepRequired = () => process.env.ADMIN_2FA === 'on';

// Every page and server action calls this first: server actions are public POST endpoints, so the
// proxy's redirect alone is not enough.
export async function requireAdmin() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) redirect('/login?error=not-admin');
  if (twoStepRequired()) {
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (level?.currentLevel !== 'aal2') redirect('/login/two-step');
  }
  return user;
}

import 'server-only';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabaseServer';

// Every page and server action calls this first: server actions are public POST endpoints, so the
// proxy's redirect alone is not enough.
export async function requireAdmin() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) redirect('/login?error=not-admin');
  return user;
}

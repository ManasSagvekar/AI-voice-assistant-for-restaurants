'use server';
// Not behind the admin sign-in: a restaurant arrives here from its link, and the token is the check.
import { createClient } from '@supabase/supabase-js';
import { audit } from '@/lib/audit';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type SetPasswordState = { error?: string; done?: boolean } | null;

export async function setPassword(_prev: SetPasswordState, form: FormData): Promise<SetPasswordState> {
  const token = String(form.get('token') ?? '');
  const password = String(form.get('password') ?? '');
  if (!token) return { error: 'This link is incomplete. Please ask for a new one.' };
  if (password.length < 10 || password.length > 72) return { error: 'Use 10 to 72 characters.' };
  if (password !== String(form.get('confirm') ?? '')) return { error: "The two passwords don't match." };
  // Its own client with no cookies, so this never touches anyone's admin session on this browser.
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.verifyOtp({ token_hash: token, type: 'recovery' });
  if (error || !data.session) return { error: 'This link has expired or was already used. Please ask for a new one.' };
  const { error: updateError } = await client.auth.updateUser({ password });
  if (updateError) return { error: updateError.message.includes('different') ? 'Please choose a different password from your last one.' : 'That password could not be saved. Please try another.' };
  const { data: restaurant } = await supabaseAdmin().from('restaurants').select('id').eq('auth_user_id', data.user?.id ?? '').maybeSingle();
  await audit(data.user?.email, 'password_set', { restaurantId: restaurant?.id as string | undefined });
  await client.auth.signOut({ scope: 'local' });
  return { done: true };
}

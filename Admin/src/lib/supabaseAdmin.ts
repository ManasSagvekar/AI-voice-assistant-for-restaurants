// Service-role client: bypasses RLS, so it is only ever created in server code, and only after
// requireAdmin() has confirmed the caller is a super-admin.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return client;
}

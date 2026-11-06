// Restaurants choose their own password, from a link, instead of being emailed one. The link carries a
// single-use token from Supabase and is safe from email scanners that open links: opening the page
// spends nothing, only submitting the form does.
import 'server-only';
import { supabaseAdmin } from './supabaseAdmin';

const baseUrl = () => (process.env.ADMIN_PUBLIC_URL || 'http://localhost:3000/admin').replace(/\/+$/, '');
// A link to this computer only works on this computer, so it is shown to the admin, not emailed.
export const linkReachable = () => !/\/\/(localhost|127\.0\.0\.1)\b/.test(baseUrl());

export async function setPasswordLink(email: string): Promise<{ url: string } | { error: string }> {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: 'recovery', email });
  if (error || !data?.properties?.hashed_token) return { error: `Could not create the link: ${error?.message ?? 'no token returned'}` };
  return { url: `${baseUrl()}/set-password?token=${encodeURIComponent(data.properties.hashed_token)}` };
}

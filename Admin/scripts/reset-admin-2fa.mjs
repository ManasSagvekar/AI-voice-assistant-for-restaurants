// For a lost phone: removes an admin's 2-step sign-in, so they set it up again at their next sign-in.
// Run on a computer holding the service role key. Usage:
//   npm run reset-admin-2fa -- admin@example.com
import { createClient } from '@supabase/supabase-js';

try { process.loadEnvFile('.env.local'); } catch { /* use the real environment */ }
const [email] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run reset-admin-2fa -- <admin email>');
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

let user = null;
for (let page = 1; !user; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error(error.message); process.exit(1); }
  user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  if (data.users.length < 200) break;
}
if (!user) { console.error(`No account found for ${email}.`); process.exit(1); }
const { data: admin } = await db.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
if (!admin) { console.error(`${email} is not an admin account.`); process.exit(1); }

const { data: factors, error } = await db.auth.admin.mfa.listFactors({ userId: user.id });
if (error) { console.error(error.message); process.exit(1); }
for (const f of factors.factors) {
  const { error: e } = await db.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id });
  if (e) { console.error(e.message); process.exit(1); }
}
const { error: logError } = await db.from('admin_audit_log').insert({ actor: 'reset-admin-2fa script', action: 'two_step_reset', detail: `For ${email}` });
if (logError) console.error(`Not recorded in the activity log: ${logError.message}`);
console.log(`Removed ${factors.factors.length} sign-in factor(s) for ${email}. They will set up 2-step sign-in again at their next sign-in.`);

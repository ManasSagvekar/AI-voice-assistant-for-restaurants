// Creates (or promotes) a super-admin account. Usage:
//   npm run create-admin -- admin@example.com "a long password"
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
import { createClient } from '@supabase/supabase-js';

try { process.loadEnvFile('.env.local'); } catch { /* use the real environment */ }
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 12) {
  console.error('Usage: npm run create-admin -- <email> <password (12+ characters)>');
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUser(address) {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === address.toLowerCase());
    if (hit || data.users.length < 200) return hit ?? null;
  }
}

let user = await findUser(email);
if (user) {
  const { data: restaurant } = await db.from('restaurants').select('id').eq('auth_user_id', user.id).maybeSingle();
  if (restaurant) { console.error('That email belongs to a restaurant account; use a separate admin email.'); process.exit(1); }
  console.log(`Found existing user ${email}; granting admin access (password unchanged).`);
} else {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: 'admin' } });
  if (error) { console.error(error.message); process.exit(1); }
  user = data.user;
  console.log(`Created ${email}.`);
}
const { error } = await db.from('admins').upsert({ user_id: user.id });
if (error) { console.error(error.message); process.exit(1); }
console.log('Admin access granted. Sign in at http://localhost:3000/admin/login (npm run dev from the workspace root)');

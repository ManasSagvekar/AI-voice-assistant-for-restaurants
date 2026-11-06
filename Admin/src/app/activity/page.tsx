import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ACTION_LABELS } from '@/lib/audit';
import { Header } from '@/components/Header';
import { UUID } from '@/lib/types';

export const metadata = { title: 'Activity · Restaurant Admin' };
export const dynamic = 'force-dynamic';

type Entry = { id: number; at: string; actor: string; action: string; restaurant_id: string | null; restaurant_name: string | null; detail: string | null; ip: string | null };
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ restaurant?: string }> }) {
  const user = await requireAdmin();
  const { restaurant } = await searchParams;
  const only = restaurant && UUID.test(restaurant) ? restaurant : null;
  let query = supabaseAdmin().from('admin_audit_log').select('id,at,actor,action,restaurant_id,restaurant_name,detail,ip').order('at', { ascending: false }).limit(200);
  if (only) query = query.eq('restaurant_id', only);
  const { data, error } = await query;
  const rows = (data ?? []) as Entry[];
  return (
    <>
      <Header email={user.email} />
      <main className="page">
        <Link href="/" className="back">← All restaurants</Link>
        <h1>Activity</h1>
        <p className="muted">
          A permanent record of what admins do, and of payments confirmed by Razorpay. Entries can&apos;t be edited or removed. Latest 200{only ? ` for ${rows[0]?.restaurant_name ?? 'this restaurant'}` : ''}; times are UTC.
          {only && <> <Link href="/activity">Show everything</Link></>}
        </p>
        {error
          ? <p className="error" role="alert">The activity log isn&apos;t available: {error.message}. Apply the migration 20261106000000_admin_security.sql.</p>
          : !rows.length ? <p className="muted">Nothing has been recorded yet.</p> : (
            <section className="card table-card">
              <table className="rtable">
                <thead><tr><th>When</th><th>Who</th><th>What</th><th>Restaurant</th><th>Details</th><th>From</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(r.at)}</td>
                      <td>{r.actor}</td>
                      <td>{ACTION_LABELS[r.action] ?? r.action}</td>
                      <td>{r.restaurant_id ? <Link href={`/activity?restaurant=${r.restaurant_id}`}>{r.restaurant_name ?? 'Deleted restaurant'}</Link> : ''}</td>
                      <td className="muted">{r.detail ?? ''}</td>
                      <td className="muted mono">{r.ip ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
      </main>
    </>
  );
}

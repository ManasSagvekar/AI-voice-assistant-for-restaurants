import { requireAdmin } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { RESTAURANT_COLUMNS as COLUMNS, type Alert, type Restaurant, type RestaurantRow } from '@/lib/types';
import { Header } from '@/components/Header';
import { AlertsPanel } from '@/components/AlertsPanel';
import { RestaurantTable } from '@/components/RestaurantTable';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const user = await requireAdmin();
  const db = supabaseAdmin();
  const [restaurants, usage, alerts] = await Promise.all([
    db.from('restaurants').select(COLUMNS).order('created_at', { ascending: false }),
    db.from('usage_last_24h').select('restaurant_id,requests'),
    db.from('admin_alerts').select('id,restaurant_id,message,created_at').is('resolved_at', null).order('created_at', { ascending: false }).limit(20),
  ]);
  if (restaurants.error) throw new Error(`Could not load restaurants: ${restaurants.error.message}`);

  const requests = new Map((usage.data ?? []).map((u) => [u.restaurant_id as string, u.requests as number]));
  const rows: RestaurantRow[] = (restaurants.data as Restaurant[]).map((r) => ({ ...r, requests_24h: requests.get(r.id) ?? 0 }));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const open = ((alerts.data ?? []) as Alert[]).map((a) => ({ ...a, restaurant: names.get(a.restaurant_id) ?? 'Unknown restaurant' }));

  const stats = [
    ['Restaurants', rows.length, 'neutral'],
    ['Active', rows.filter((r) => r.status === 'active').length, 'ok'],
    ['Suspended', rows.filter((r) => r.status === 'suspended').length, 'warn'],
    ['Flagged', rows.filter((r) => r.status === 'flagged').length, 'danger'],
    ['Unpaid', rows.filter((r) => r.payment_status === 'unpaid').length, 'warn'],
  ] as const;

  return (
    <>
      <Header alerts={open.length} email={user.email} />
      <main className="page">
        <section className="stats" aria-label="Summary">
          {stats.map(([label, value, tone]) => (
            <div key={label} className={`stat stat-${tone}`}>
              <span className="stat-label">{label}</span>
              <span className="stat-value">{value}</span>
            </div>
          ))}
        </section>
        {open.length > 0 && <AlertsPanel alerts={open} />}
        <RestaurantTable rows={rows} />
        <p className="footnote">Restaurant revenue, orders and sales values are never collected or stored. Usage is counted as request numbers only.</p>
      </main>
      <AutoRefresh seconds={15} />
    </>
  );
}

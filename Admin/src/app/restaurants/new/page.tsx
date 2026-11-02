import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { Header } from '@/components/Header';
import { OnboardForm } from '@/components/OnboardForm';

export const metadata = { title: 'Onboard restaurant · Restaurant Admin' };

export default async function NewRestaurantPage() {
  const user = await requireAdmin();
  return (
    <>
      <Header email={user.email} />
      <main className="page narrow-page">
        <Link href="/" className="back">← All restaurants</Link>
        <h1>Onboard a restaurant</h1>
        <p className="muted">Creates the restaurant&apos;s sign-in account and staff PIN, sets its plan, and emails the details.</p>
        <OnboardForm emailConfigured={!!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM} />
      </main>
    </>
  );
}

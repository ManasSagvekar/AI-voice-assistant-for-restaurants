'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Re-fetches the dashboard so new abuse flags and usage show up without a manual reload.
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && router.refresh();
    const id = setInterval(refresh, seconds * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', refresh); };
  }, [router, seconds]);
  return null;
}

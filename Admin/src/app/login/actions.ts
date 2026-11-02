'use server';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabaseServer';

export async function signIn(_prev: string | null, form: FormData): Promise<string | null> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return 'Enter your email and password.';
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error?.status === 401 && error.message === 'Invalid API key') {
    return 'Supabase rejected the API key. Check that the project URL and anon key in .env.local are correct and from the same project.';
  }
  if (error) return 'That email or password is not correct.';
  // Restaurant accounts use the same Supabase Auth, so being signed in is not enough.
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) {
    await supabase.auth.signOut();
    return 'This account does not have admin access.';
  }
  redirect('/');
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect('/login');
}

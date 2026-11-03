// Minimal Supabase client over fetch: password sign-in, token refresh and RPC calls. Only the anon
// key lives here; what the restaurant may do is decided by the database's RLS and RPC grants.
export class SupabaseError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createSupabase(url, anonKey) {
  const base = url.replace(/\/+$/, '');
  async function request(path, body, token) {
    let res;
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${token || anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new SupabaseError(0, `Supabase unreachable: ${e.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new SupabaseError(res.status, (data && (data.msg || data.message || data.error_description || data.error)) || `Supabase returned ${res.status}`);
    return data;
  }
  return {
    signIn: (email, password) => request('/auth/v1/token?grant_type=password', { email, password }),
    refresh: (refreshToken) => request('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken }),
    rpc: (fn, args, token) => request('/rest/v1/rpc/' + fn, args, token),
    signOut: (token) => request('/auth/v1/logout', {}, token),
  };
}

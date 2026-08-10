// ============================================================================
// Server-side admin authentication.
// The browser can claim anything; only this check counts.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './server.js';

/**
 * Verifies the caller's Supabase JWT and that they are a registered admin.
 * Returns { ok:true, user } or { ok:false, status, error }.
 *
 * Note: the JWT is validated with the SERVICE key (auth.getUser(token)),
 * so no anon key is needed server-side.
 */
export async function requireAdmin(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'no_token' };

  const supabase = supabaseAdmin();

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    console.error('admin auth: bad token', error?.message);
    return { ok: false, status: 401, error: 'bad_token' };
  }

  const { data: admin, error: adminErr } = await supabase
    .from('store_admins')
    .select('auth_user_id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();

  if (adminErr) {
    console.error('admin auth: store_admins query failed', adminErr.message);
    return { ok: false, status: 500, error: 'db_error' };
  }
  if (!admin) {
    console.error('admin auth: not an admin', data.user.email, data.user.id);
    return { ok: false, status: 403, error: 'not_admin' };
  }

  return { ok: true, user: data.user };
}

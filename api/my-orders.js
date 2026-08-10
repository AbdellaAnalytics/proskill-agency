// ============================================================================
// GET /api/my-orders — the signed-in customer's own orders.
//
// The JWT is verified server-side; we never trust a user id from the browser.
// Codes are returned only for orders that are paid AND delivered.
// ============================================================================

import { supabaseAdmin } from './_lib/server.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const supabase = supabaseAdmin();
  const { data: auth, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !auth?.user) return res.status(401).json({ error: 'unauthorized' });

  const user = auth.user;
  const email = (user.email || '').toLowerCase();

  // Attach any guest orders bought with this email before signing up.
  if (email) {
    const { error: claimErr } = await supabase.rpc('claim_orders_for_user', {
      p_user_id: user.id,
      p_email: email,
    });
    if (claimErr) console.error('claim_orders_for_user failed:', claimErr.message);
  }

  const { data, error } = await supabase
    .from('web_orders')
    .select(
      'order_number, quantity, total_usd, payment_status, fulfilment_status, ' +
        'delivered_content, created_at, products(name, emoji)'
    )
    .or(`auth_user_id.eq.${user.id},customer_email.eq.${email}`)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('my-orders query failed:', error.message);
    return res.status(500).json({ error: 'query failed' });
  }

  // CV service orders live in their own table, so they were missing from this
  // page entirely. A customer who cleared their email or switched browser had
  // no way back to a CV they had paid for — they'd message support, and you'd
  // look it up by hand. Matched on the account's own email, which the token
  // proves, so this can't expose anyone else's.
  let cvOrders = [];
  // An account without an email would query for orders with an empty one.
  // The schema makes that impossible today, but the cost of the guard is a
  // line and the cost of being wrong is showing someone another person's CV.
  try {
    if (!email) throw new Error('no email on account');
    const { data: cvRows } = await supabase
      .from('ps_cv_orders')
      .select('order_number, target_role, payment_status, status, price_usd, created_at')
      .eq('customer_email', email)
      .order('created_at', { ascending: false })
      .limit(30);

    cvOrders = (cvRows ?? []).map((o) => ({
      orderNumber: o.order_number,
      targetRole: o.target_role,
      paymentStatus: o.payment_status,
      status: o.status,
      priceUsd: Number(o.price_usd) || 0,
      createdAt: o.created_at,
      // The page needs the email in the link, and it's this user's own.
      url: `/cv/${o.order_number}?e=${encodeURIComponent(email)}`,
    }));
  } catch (e) {
    // A missing table (before the migration) must not break the orders page.
    console.error('my-orders: cv orders skipped:', e.message);
  }

  const orders = (data ?? []).map((o) => ({
    orderNumber: o.order_number,
    quantity: o.quantity,
    total: o.total_usd,
    paymentStatus: o.payment_status,
    fulfilmentStatus: o.fulfilment_status,
    product: o.products,
    createdAt: o.created_at,
    // Never leak codes for unpaid or undelivered orders.
    codes:
      o.payment_status === 'paid' && o.fulfilment_status === 'delivered'
        ? o.delivered_content
        : null,
  }));

  res.status(200).json({ email: user.email, orders, cvOrders });
}

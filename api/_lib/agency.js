// ============================================================================
// Pushing a completed sale to the management system's inbox.
//
// The two live on separate Supabase projects, so this is a network call, not a
// query. It writes to a plain table — never to proskill_workspace, whose single
// jsonb column holds the entire management app. A read-modify-write on that
// blob from here would race the browser and could erase hundreds of sales.
//
// Nothing in here is allowed to affect the sale itself. A customer has paid;
// whether their order also reached the back office is not their problem, and an
// unreachable inbox must never turn into a failed checkout. Every path returns
// instead of throwing.
// ============================================================================

const AGENCY_URL = process.env.AGENCY_SUPABASE_URL;
const AGENCY_KEY = process.env.AGENCY_SERVICE_KEY;

/**
 * Queue one paid order for review in the management system.
 *
 * Safe to call more than once for the same order: order_number is the primary
 * key there, so a duplicate is rejected by the database rather than guarded
 * against here — the check cannot drift from the truth that way.
 *
 * @returns {Promise<boolean>} true when it landed; false is not an error worth
 *          surfacing to anyone but the log.
 */
export async function pushSaleToAgency(order, product) {
  if (!AGENCY_URL || !AGENCY_KEY) return false;   // not configured yet
  if (!order?.order_number) return false;

  // The whole body, not just the fetch.
  //
  // The callers now AWAIT this without a catch of their own — they have to, or
  // the platform can kill the request when the function responds. That makes
  // every line below part of the payment path: one unexpected throw while
  // shaping a row and a customer's payment callback fails over a back-office
  // errand. Nothing in here is allowed to escape.
  try {
    return await send(order, product);
  } catch (e) {
    console.error('agency push failed:', e.message);
    return false;
  }
}

async function send(order, product) {

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const row = {
    order_number: String(order.order_number),
    customer_name: order.customer_name ?? null,
    customer_email: order.customer_email ?? null,
    customer_phone: order.customer_phone ?? null,
    product_name: product?.name ?? null,
    quantity: Number(order.quantity) || 1,
    // What was actually charged and what it actually cost — both already
    // settled on the order. Recomputing either here could disagree with the
    // money that moved.
    price_usd: num(order.total_usd),
    cost_usd: num(order.cost_usd),
    payment_method: order.payment_method ?? null,
    coupon_code: order.coupon_code ?? null,
    geo_country: order.geo_country ?? null,
    geo_city: order.geo_city ?? null,
    paid_at: new Date().toISOString(),
  };

  // Bounded: this runs inside the payment callback. An unreachable management
  // system must not hold up a customer's delivery.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);

  try {
    const res = await fetch(`${AGENCY_URL}/rest/v1/store_sale_inbox`, {
      method: 'POST',
      headers: {
        apikey: AGENCY_KEY,
        Authorization: `Bearer ${AGENCY_KEY}`,
        'Content-Type': 'application/json',
        // Ignore a repeat of an order already queued, rather than erroring —
        // and never overwrite one already approved.
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('agency inbox rejected:', res.status, detail.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('agency inbox unreachable:', e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

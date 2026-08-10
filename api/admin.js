// ============================================================================
// /api/admin?action=stats|orders|deliver|products|upload|coupons|reviews
//
// All admin endpoints live in ONE serverless function. Vercel's Hobby plan
// allows 12 functions; separate files would blow past that. Routing happens
// here, but every sub-handler still calls requireAdmin() independently, so the
// security boundary is unchanged.
// ============================================================================

import { requireAdmin } from './_lib/auth.js';
import { supabaseAdmin, encryptStock, decryptStock, purchaseFromVendor, purchaseWithIdempotentRetry } from './_lib/server.js';
import { emailCodes, emailManualPending, notifyAdmin } from './_lib/notify.js';
import { countryFromPhone, countryFromTz } from './_lib/geo.js';
import { readMailbox } from './_lib/mailbox.js';
import { pushSaleToAgency } from './_lib/agency.js';

export const config = { api: { bodyParser: { sizeLimit: '5mb' } }, maxDuration: 30 };

const ROUTES = {
  stats: statsHandler,
  orders: ordersHandler,
  deliver: deliverHandler,
  products: productsHandler,
  'create-product': createProductHandler,
  'vendor-browse': vendorBrowseHandler,
  balances: balancesHandler,
  'retry-order': retryOrderHandler,
  categories: categoriesHandler,
  services: servicesHandler,
  'deliver-from-stock': deliverFromStockHandler,
  'deliver-from-vendor': deliverFromVendorHandler,
  'cancel-order': cancelOrderHandler,
  'reorder-product': reorderProductHandler,
  'delete-product': deleteProductHandler,
  inventory: inventoryHandler,
  'cv-price': cvPriceHandler,
  'cv-orders': cvOrdersHandler,
  mailboxes: mailboxesHandler,
  'delete-stock': deleteStockHandler,
  'reveal-stock': revealStockHandler,
  'bulk-seed': bulkSeedHandler,
  'vendor-import': vendorImportHandler,
  'vendor-costs': vendorCostsHandler,
  stock: stockHandler,
  upload: uploadHandler,
  coupons: couponsHandler,
  reviews: reviewsHandler,
};

export default async function handler(req, res) {
  const action = String(req.query.action || '');
  const fn = ROUTES[action];
  if (!fn) return res.status(404).json({ error: 'unknown action' });
  return fn(req, res);
}

// GET /api/admin/stats — dashboard overview (admin only)

// ---- dashboard date-range filtering ----------------------------------------
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/**
 * Resolves the dashboard's date filter into a current window [from,to) and the
 * immediately preceding equal-length window [pFrom,pTo) for comparison.
 * Query: ?range=today|7d|30d|90d  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
function parseRange(req) {
  const dayMs = 864e5;
  const { from, to } = req.query;
  let start, end, label, days;
  if (from && to) {
    start = startOfDay(from);
    end = new Date(startOfDay(to).getTime() + dayMs); // make the end date inclusive
    days = Math.max(1, Math.round((end - start) / dayMs));
    label = 'custom';
  } else {
    const range = String(req.query.range || '7d');
    const n = range === 'today' ? 1 : range === '30d' ? 30 : range === '90d' ? 90 : 7;
    end = new Date(startOfDay(new Date()).getTime() + dayMs); // start of tomorrow
    start = new Date(end.getTime() - n * dayMs);
    days = n;
    label = range;
  }
  const len = end - start;
  return { from: start, to: end, pFrom: new Date(start.getTime() - len), pTo: start, label, days };
}

/**
 * All metrics over [from,to). full=false returns only the headline comparables
 * (revenue, orders, avgOrder, visitors, views, convRate) so the previous-period
 * call stays cheap. Defensive on store_views so a missing table never 500s.
 */
async function computePeriod(supabase, from, to, full) {
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  // The location columns are asked for optimistically. Before store_geo.sql has
  // been run they don't exist, and PostgREST rejects the WHOLE select — which
  // would take every number on the dashboard down, not just the new panels.
  // Ask again without them instead of failing.
  const ORDER_COLS = 'total_usd, payment_status, created_at, payment_method, product_id, quantity, customer_email, customer_phone, coupon_code, discount_usd, fulfilment_status, fulfilled_at, cost_usd';
  let { data: orders, error: ordErr } = await supabase
    .from('web_orders')
    .select(`${ORDER_COLS}, geo_country, geo_region, geo_city`)
    .gte('created_at', fromISO).lt('created_at', toISO);
  if (ordErr) {
    console.warn('stats: order geo columns missing — run store_geo.sql');
    ({ data: orders } = await supabase
      .from('web_orders').select(ORDER_COLS)
      .gte('created_at', fromISO).lt('created_at', toISO));
  }

  const paid = (orders ?? []).filter((o) => o.payment_status === 'paid');

  // The instant CV service lives in its own table, so revenue built only from
  // web_orders understates what the business actually earned — and that's the
  // number decisions get made on. Counted separately here and added to the
  // headline figure; a missing table (before the migration is run) simply
  // contributes nothing rather than breaking the dashboard.
  // --- Which markets actually buy ------------------------------------------
  // One accumulator for both order tables: "where are my customers" is a
  // question about the business, not about one product line.
  //
  // geo_country is what the request said at order time. When it's absent — an
  // order placed before any of this existed, or a request behind a proxy — the
  // dialling code already stored in the phone number answers the country. That
  // is a real fallback, not a guess dressed up as data: countryFromPhone
  // returns null rather than pick when a code is ambiguous.
  const geoCountry = new Map();   // 'EG'        -> { orders, revenue }
  const geoCity = new Map();      // 'EG|Cairo'  -> { orders, revenue }
  const addSale = (row, amount) => {
    const cc = row.geo_country || countryFromPhone(row.customer_phone);
    if (!cc) return;
    const c = geoCountry.get(cc) || { orders: 0, revenue: 0 };
    c.orders += 1; c.revenue += amount;
    geoCountry.set(cc, c);
    // Only a header can give a city. A phone number can't, so an order that
    // fell back to the phone counts toward its country and no further.
    const city = String(row.geo_city || '').trim();
    if (!city) return;
    const key = `${cc}|${city}`;
    const t = geoCity.get(key) || { orders: 0, revenue: 0 };
    t.orders += 1; t.revenue += amount;
    geoCity.set(key, t);
  };

  let cvRevenue = 0;
  let cvOrderCount = 0;
  let cvApiCost = 0;        // what the rewrites actually cost in API spend
  let cvCostedOrders = 0;   // how many of them we have a cost for
  try {
    const CV_COLS = 'price_usd, payment_status, created_at, api_cost_usd, customer_phone';
    let { data: cvRows, error: cvGeoErr } = await supabase
      .from('ps_cv_orders')
      .select(`${CV_COLS}, geo_country, geo_city`)
      .eq('payment_status', 'paid')
      .gte('created_at', fromISO).lt('created_at', toISO);
    if (cvGeoErr) {
      ({ data: cvRows } = await supabase
        .from('ps_cv_orders').select(CV_COLS)
        .eq('payment_status', 'paid')
        .gte('created_at', fromISO).lt('created_at', toISO));
    }
    for (const r of cvRows ?? []) {
      cvRevenue += Number(r.price_usd) || 0;
      cvOrderCount += 1;
      addSale(r, Number(r.price_usd) || 0);
      const c = Number(r.api_cost_usd);
      if (Number.isFinite(c) && c > 0) { cvApiCost += c; cvCostedOrders += 1; }
    }
  } catch (e) {
    // Also covers the period before store_cv_usage.sql was run: the column
    // doesn't exist, so the query fails and spend simply isn't reported —
    // rather than the whole dashboard breaking.
    console.error('cv revenue skipped:', e.message);
  }
  for (const o of paid) addSale(o, Number(o.total_usd) || 0);

  const revenue = paid.reduce((s, o) => s + (Number(o.total_usd) || 0), 0);
  const orderCount = paid.length;
  const avgOrder = orderCount ? revenue / orderCount : 0;

  // Deliberately kept OUT of `revenue` above. That variable feeds average
  // order value, conversion and the profit calculation, all of which are about
  // product orders — folding a service into them would quietly distort every
  // one. Surfaced as its own figure, and combined only for the headline total.
  const totalRevenue = revenue + cvRevenue;

  let visitors = 0, views = 0;
  const prodViews = new Map();
  const srcSessions = new Map();
  // Counted by SESSION, like every other visitor figure here — otherwise a
  // country that browses ten pages outranks one that browses ten visitors.
  const visitorCountry = new Map();
  const devSessions = { mobile: new Set(), desktop: new Set() };
  const dayViews = new Map();
  const sessProduct = new Set();
  const sessCheckout = new Set();
  const checkoutPairs = new Set(); // "session|product" — for abandoned value
  let viewsApprox = false;
  try {
    // PostgREST caps a single response, so one plain select silently stops at
    // the cap — and every visitor, funnel and source figure below it would be
    // understated while conversion looked better than it is. Page through
    // instead. The ceiling keeps a runaway month from exhausting the function;
    // if it is ever hit the numbers are marked approximate rather than wrong.
    const PAGE = 1000;
    const MAX_PAGES = 25; // 25k events
    const vrows = [];
    let viewCols = 'id, session_id, product_id, kind, source, device, created_at, tz';
    for (let page = 0; page < MAX_PAGES; page++) {
      let { data: chunk, error: vErr } = await supabase
        .from('store_views')
        .select(viewCols)
        .gte('created_at', fromISO).lt('created_at', toISO)
        .order('created_at', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      // Before store_geo.sql: no tz column. Drop it and re-ask for this page —
      // losing the country breakdown is acceptable, losing every visitor
      // number on the dashboard is not.
      if (vErr && viewCols.endsWith(', tz')) {
        viewCols = viewCols.slice(0, -', tz'.length);
        console.warn('stats: store_views.tz missing — run store_geo.sql');
        ({ data: chunk, error: vErr } = await supabase
          .from('store_views')
          .select(viewCols)
          .gte('created_at', fromISO).lt('created_at', toISO)
          .order('created_at', { ascending: true })
          .range(page * PAGE, page * PAGE + PAGE - 1));
      }
      if (vErr) throw vErr;
      if (!chunk || chunk.length === 0) break;
      vrows.push(...chunk);
      if (chunk.length < PAGE) break;
      if (page === MAX_PAGES - 1) viewsApprox = true;
    }
    if (vrows.length) {
      views = vrows.length;
      const sessAll = new Set();
      for (const v of vrows) {
        const key = v.session_id || `row:${v.id}`;
        sessAll.add(key);
        if (v.product_id) prodViews.set(v.product_id, (prodViews.get(v.product_id) ?? 0) + 1);
        if (v.kind === 'product' || v.kind === 'checkout') sessProduct.add(key);
        if (v.kind === 'checkout') {
          sessCheckout.add(key);
          if (v.product_id) checkoutPairs.add(`${key}|${v.product_id}`);
        }
        const src = v.source || 'direct';
        if (!srcSessions.has(src)) srcSessions.set(src, new Set());
        srcSessions.get(src).add(key);
        devSessions[v.device === 'mobile' ? 'mobile' : 'desktop'].add(key);
        const vcc = countryFromTz(v.tz);
        if (vcc) {
          if (!visitorCountry.has(vcc)) visitorCountry.set(vcc, new Set());
          visitorCountry.get(vcc).add(key);
        }
        const d = new Date(v.created_at).toISOString().slice(0, 10);
        dayViews.set(d, (dayViews.get(d) ?? 0) + 1);
      }
      visitors = sessAll.size;
    }
  } catch (e) { console.error('period views skipped:', e.message); }

  const convRate = visitors ? Number(((orderCount / visitors) * 100).toFixed(1)) : 0;
  const base = {
    revenue: Number(revenue.toFixed(2)),
    cvRevenue: Number(cvRevenue.toFixed(2)),
    cvOrders: cvOrderCount,
    cvApiCost: Number(cvApiCost.toFixed(3)),
    cvCostedOrders: cvCostedOrders,
    // Average cost per rewrite — the figure that answers "top up by how much".
    cvAvgCost: cvCostedOrders ? Number((cvApiCost / cvCostedOrders).toFixed(4)) : 0,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    orders: orderCount,
    avgOrder: Number(avgOrder.toFixed(2)),
    visitors, views, convRate, viewsApprox,
  };
  if (!full) return base;

  const salesByProduct = new Map();
  for (const o of paid) {
    if (!o.product_id) continue;
    const c = salesByProduct.get(o.product_id) || { revenue: 0, units: 0 };
    c.revenue += Number(o.total_usd) || 0;
    c.units += Number(o.quantity) || 1;
    salesByProduct.set(o.product_id, c);
  }
  const payMap = new Map();
  for (const o of paid) {
    const m = o.payment_method || 'other';
    payMap.set(m, (payMap.get(m) || 0) + (Number(o.total_usd) || 0));
  }
  const byPayment = [...payMap.entries()]
    .map(([method, r]) => ({ method, revenue: Number(r.toFixed(2)) }))
    .sort((a, b) => b.revenue - a.revenue);

  const wantIds = new Set([...prodViews.keys(), ...salesByProduct.keys()]);
  let nmap = new Map();
  if (wantIds.size) {
    const { data: names } = await supabase.from('products').select('id, name, emoji').in('id', [...wantIds]);
    nmap = new Map((names ?? []).map((p) => [p.id, p]));
  }
  const nm = (id) => ({ name: nmap.get(id)?.name ?? '—', emoji: nmap.get(id)?.emoji ?? '📦' });

  const topViewed = [...prodViews.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, v]) => ({ id, ...nm(id), views: v }));
  const topSellers = [...salesByProduct.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5)
    .map(([id, s]) => ({ id, ...nm(id), revenue: Number(s.revenue.toFixed(2)), units: s.units }));
  const missed = [...prodViews.entries()].filter(([id, v]) => v >= 5 && !salesByProduct.has(id))
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => ({ id, ...nm(id), views: v }));

  const sources = [...srcSessions.entries()].map(([source, set]) => ({ source, visits: set.size }))
    .sort((a, b) => b.visits - a.visits);
  const devices = { mobile: devSessions.mobile.size, desktop: devSessions.desktop.size };

  const dayMs = 864e5;
  const series = [];
  const nDays = Math.max(1, Math.round((to - from) / dayMs));
  for (let i = 0; i < nDays; i++) {
    const dStart = new Date(from.getTime() + i * dayMs);
    const dNext = new Date(dStart.getTime() + dayMs);
    const key = dStart.toISOString().slice(0, 10);
    const rev = paid.filter((o) => { const t = new Date(o.created_at); return t >= dStart && t < dNext; })
      .reduce((s, o) => s + (Number(o.total_usd) || 0), 0);
    series.push({ date: key, revenue: Number(rev.toFixed(2)), views: dayViews.get(key) ?? 0 });
  }

  const funnel = { visitors, productViews: sessProduct.size, checkouts: sessCheckout.size, purchases: orderCount };

  // ---- When do orders actually come in? (ad scheduling / staffing) ----------
  const byWeekday = Array.from({ length: 7 }, () => 0);   // 0 = Sunday
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const o of paid) {
    const d = new Date(o.created_at);
    byWeekday[d.getDay()] += 1;
    byHour[d.getHours()] += 1;
  }

  // ---- New vs returning buyers --------------------------------------------
  // "Returning" = this email had a paid order BEFORE this period started.
  // The lookup is chunked: a single .in() with hundreds of emails builds a URL
  // long enough to be rejected, which would silently report everyone as new.
  const emails = [...new Set(paid.map((o) => (o.customer_email || '').toLowerCase()).filter(Boolean))];
  let returning = 0;
  let customersApprox = false;
  if (emails.length) {
    const CHUNK = 150;
    const MAX_CHUNKS = 8; // ~1200 buyers; beyond that the figure is approximate
    const priorSet = new Set();
    try {
      const batches = [];
      for (let i = 0; i < emails.length && batches.length < MAX_CHUNKS; i += CHUNK) {
        batches.push(emails.slice(i, i + CHUNK));
      }
      if (batches.length * CHUNK < emails.length) customersApprox = true;

      for (const batch of batches) {
        const { data: prior } = await supabase
          .from('web_orders')
          .select('customer_email')
          .eq('payment_status', 'paid')
          .lt('created_at', fromISO)
          .in('customer_email', batch);
        for (const r of prior ?? []) priorSet.add((r.customer_email || '').toLowerCase());
      }
      returning = emails.filter((e) => priorSet.has(e)).length;
    } catch (e) {
      console.error('returning-customer lookup skipped:', e.message);
      customersApprox = true;
    }
  }
  const customers = {
    total: emails.length,
    returning,
    fresh: emails.length - returning,
    approx: customersApprox,
  };

  // ---- Revenue by category -------------------------------------------------
  const catRevenue = new Map();
  if (salesByProduct.size) {
    try {
      const { data: prodCats } = await supabase
        .from('products')
        .select('id, category_id, categories(name, emoji)')
        .in('id', [...salesByProduct.keys()]);
      for (const p of prodCats ?? []) {
        const rev = salesByProduct.get(p.id)?.revenue || 0;
        const key = p.categories?.name || '—';
        const cur = catRevenue.get(key) || { revenue: 0, emoji: p.categories?.emoji || '📦' };
        cur.revenue += rev;
        catRevenue.set(key, cur);
      }
    } catch (e) { console.error('category revenue skipped:', e.message); }
  }
  const byCategory = [...catRevenue.entries()]
    .map(([name, v]) => ({ name, emoji: v.emoji, revenue: Number(v.revenue.toFixed(2)) }))
    .sort((a, b) => b.revenue - a.revenue);

  // ---- Coupon impact -------------------------------------------------------
  const withCoupon = paid.filter((o) => o.coupon_code);
  const coupons = {
    orders: withCoupon.length,
    discount: Number(withCoupon.reduce((s, o) => s + (Number(o.discount_usd) || 0), 0).toFixed(2)),
    share: orderCount ? Math.round((withCoupon.length / orderCount) * 100) : 0,
  };

  // ---- Money that didn't land -------------------------------------------
  // Three different situations, and conflating them would mislead:
  //   • abandoned — order created, buyer never completed payment at the gateway
  //   • awaitingTransfer — InstaPay order, legitimately waiting on the buyer
  //   • failed — the gateway reported a failure or a wrong amount
  const sumOf = (rows) => Number(rows.reduce((s, o) => s + (Number(o.total_usd) || 0), 0).toFixed(2));
  const abandonedRows = (orders ?? []).filter(
    (o) => o.payment_status === 'unpaid' && o.fulfilment_status !== 'manual_pending'
  );
  const awaitingRows = (orders ?? []).filter(
    (o) => o.payment_status === 'unpaid' && o.fulfilment_status === 'manual_pending'
  );
  const failedRows = (orders ?? []).filter(
    (o) => o.payment_status === 'failed' || o.payment_status === 'amount_mismatch'
  );
  const lost = {
    abandoned: { count: abandonedRows.length, value: sumOf(abandonedRows) },
    awaiting: { count: awaitingRows.length, value: sumOf(awaitingRows) },
    failed: { count: failedRows.length, value: sumOf(failedRows) },
  };

  // ---- How long delivery actually takes ----------------------------------
  // Averaging everything hides the answer: automated orders land in seconds and
  // drag the mean down, masking a manual order that took six hours. Buckets
  // answer the real question — are we keeping the 1–3 hour promise?
  const times = [];
  for (const o of paid) {
    if (!o.fulfilled_at) continue;
    const mins = (new Date(o.fulfilled_at) - new Date(o.created_at)) / 60000;
    if (Number.isFinite(mins) && mins >= 0 && mins < 60 * 24 * 30) times.push(mins);
  }
  times.sort((a, b) => a - b);
  const delivery = times.length
    ? {
        count: times.length,
        median: Math.round(times[Math.floor(times.length / 2)]),
        buckets: [
          { key: 'instant', max: 5, n: times.filter((m) => m < 5).length },
          { key: 'under1h', max: 60, n: times.filter((m) => m >= 5 && m < 60).length },
          { key: 'h1to3', max: 180, n: times.filter((m) => m >= 60 && m < 180).length },
          { key: 'over3h', max: null, n: times.filter((m) => m >= 180).length },
        ],
      }
    : null;

  // ---- Gross profit -------------------------------------------------------
  // Only orders that captured a cost can be measured. Rather than quietly
  // treating unknown cost as zero — which would inflate profit — we measure the
  // covered subset and report how much of the period that is, so the number is
  // either trustworthy or visibly incomplete.
  const withCost = paid.filter((o) => Number.isFinite(Number(o.cost_usd)) && Number(o.cost_usd) > 0);
  const measuredRevenue = Number(withCost.reduce((s, o) => s + (Number(o.total_usd) || 0), 0).toFixed(2));
  const totalCost = Number(withCost.reduce((s, o) => s + (Number(o.cost_usd) || 0), 0).toFixed(2));
  const grossProfit = Number((measuredRevenue - totalCost).toFixed(2));
  const profit = {
    measuredOrders: withCost.length,
    totalOrders: orderCount,
    coverage: orderCount ? Math.round((withCost.length / orderCount) * 100) : 0,
    revenue: measuredRevenue,
    cost: totalCost,
    gross: grossProfit,
    margin: measuredRevenue > 0 ? Math.round((grossProfit / measuredRevenue) * 100) : 0,
  };

  // ---- Value sitting in abandoned checkouts -------------------------------
  // Checkout events record which product was being bought, so we can price what
  // reached the checkout page. Orders aren't linked to sessions, so the split
  // between "bought" and "walked away" is derived by subtracting revenue —
  // an estimate, and labelled as one in the UI rather than dressed up as exact.
  let abandonedCart = null;
  if (checkoutPairs.size) {
    try {
      const ids = [...new Set([...checkoutPairs].map((k) => k.split('|')[1]))];
      const { data: prices } = await supabase
        .from('products').select('id, price_usd').in('id', ids);
      const priceOf = new Map((prices ?? []).map((p) => [p.id, Number(p.price_usd) || 0]));
      let atCheckout = 0;
      for (const pair of checkoutPairs) atCheckout += priceOf.get(pair.split('|')[1]) || 0;
      atCheckout = Number(atCheckout.toFixed(2));
      abandonedCart = {
        atCheckout,
        estimatedLost: Number(Math.max(0, atCheckout - revenue).toFixed(2)),
        sessions: sessCheckout.size,
        purchases: orderCount,
      };
    } catch (e) { console.error('abandoned cart value skipped:', e.message); }
  }

  // Units sold per product — used to turn "3 left" into "runs out in 2 days".
  const unitsByProduct = [...salesByProduct.entries()].map(([id, v]) => ({ id, units: v.units }));

  // Top markets. Sliced rather than sent whole: these panels show a handful,
  // and the payload travels on every dashboard load.
  const byCountry = [...geoCountry.entries()]
    .map(([code, v]) => ({ code, orders: v.orders, revenue: Number(v.revenue.toFixed(2)) }))
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .slice(0, 8);
  const byCity = [...geoCity.entries()]
    .map(([k, v]) => ({
      code: k.slice(0, k.indexOf('|')),
      city: k.slice(k.indexOf('|') + 1),
      orders: v.orders,
      revenue: Number(v.revenue.toFixed(2)),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .slice(0, 8);
  const visitorsByCountry = [...visitorCountry.entries()]
    .map(([code, set]) => ({ code, visitors: set.size }))
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 8);
  // Traffic that never converted. The two lists above each answer half the
  // question; the gap between them is the half worth acting on.
  const sold = new Set(geoCountry.keys());
  const untapped = [...visitorCountry.entries()]
    .filter(([code]) => !sold.has(code))
    .map(([code, set]) => ({ code, visitors: set.size }))
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 6);

  return { ...base, funnel, sources, devices, topViewed, topSellers, missed, byPayment, series,
    byWeekday, byHour, customers, byCategory, coupons, lost, delivery, profit,
    abandonedCart, unitsByProduct, byCountry, byCity, visitorsByCountry, untapped };
}

async function statsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();
  const { from, to, pFrom, pTo, label, days } = parseRange(req);

  // All-time / now — independent of the date filter.
  const { count: totalCustomers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: totalProducts } = await supabase
    .from('products').select('*', { count: 'exact', head: true }).eq('is_active', true);

  // Needs-attention: unresolved paid orders in the last 30 days (always shown).
  const attSince = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: attOrders } = await supabase
    .from('web_orders').select('payment_status, fulfilment_status, created_at').gte('created_at', attSince);
  const needsAttention = (attOrders ?? []).filter((o) =>
    (o.payment_status === 'paid' && ['failed', 'manual_pending'].includes(o.fulfilment_status)) ||
    o.payment_status === 'amount_mismatch').length;

  // Low-stock watch: own instant products with 3 or fewer codes left (now).
  const { data: ownInstant } = await supabase
    .from('products').select('id, name, emoji, is_active').eq('delivery_speed', 'instant').neq('source', 'vendor');
  // Exact COUNTs, run in parallel. Selecting the rows and counting them here
  // would be one round-trip instead of N, but PostgREST caps how many rows it
  // returns — past that cap every product silently looks low on stock. A
  // head+count query returns no rows at all, so it can't be truncated, and
  // firing them together keeps the latency of a single query.
  const stockLeft = new Map();
  try {
    const list = ownInstant ?? [];
    const counts = await Promise.all(
      list.map((p) =>
        supabase
          .from('stock_items')
          .select('*', { count: 'exact', head: true })
          .eq('product_id', p.id)
          .eq('status', 'available')
          .then((r) => r.count ?? 0)
          .catch(() => 0)
      )
    );
    list.forEach((p, i) => stockLeft.set(p.id, counts[i]));
  } catch (e) { console.error('stock counts skipped:', e.message); }

  const lowStock = [];
  for (const p of ownInstant ?? []) {
    const left = stockLeft.get(p.id) ?? 0;
    if (left <= 3) lowStock.push({ id: p.id, name: p.name, emoji: p.emoji, left, hidden: !p.is_active });
  }
  lowStock.sort((a, b) => a.left - b.left);

  // Selected period + previous period for deltas.
  const cur = await computePeriod(supabase, from, to, true);
  const prev = await computePeriod(supabase, pFrom, pTo, false);

  // ---- Days of stock left -------------------------------------------------
  // "3 left" means nothing on its own: three units is a month of cover for a
  // slow product and half a day for the one that's selling. Pair the count with
  // the actual sales rate for this period so the warning is about time, not
  // quantity. Products with no sales in the period have no rate — skipped
  // rather than shown as lasting forever.
  const periodDays = Math.max(1, (to - from) / 86400000);
  const unitsMap = new Map((cur.unitsByProduct ?? []).map((u) => [u.id, u.units]));
  const runway = (ownInstant ?? [])
    .map((p) => {
      const left = stockLeft.get(p.id) ?? 0;
      const units = unitsMap.get(p.id) ?? 0;
      if (left <= 0 || units <= 0) return null;
      const perDay = units / periodDays;
      return { id: p.id, name: p.name, emoji: p.emoji, left, days: Math.floor(left / perDay) };
    })
    .filter(Boolean)
    .sort((a, b) => a.days - b.days)
    .slice(0, 6);
  const delta = (c, p) => (p ? Number((((c - p) / p) * 100).toFixed(1)) : null);

  res.status(200).json({
    period: { from: from.toISOString(), to: to.toISOString(), label, days },
    kpis: {
      revenue: { v: cur.revenue, delta: delta(cur.revenue, prev.revenue) },
      // Service income shown beside product revenue rather than merged into it,
      // so you can see both what the shop earned and what the whole business did.
      cvRevenue: { v: cur.cvRevenue ?? 0, delta: delta(cur.cvRevenue ?? 0, prev.cvRevenue ?? 0) },
      cvApiCost: { v: cur.cvApiCost ?? 0, delta: delta(cur.cvApiCost ?? 0, prev.cvApiCost ?? 0) },
      cvAvgCost: { v: cur.cvAvgCost ?? 0, delta: 0 },
      // The panel scales spend to a month, so it needs the window it's
      // scaling from — otherwise a 7-day view reads as a monthly figure.
      // `days` comes from parseRange in this handler. An earlier edit reached
      // for `n` — a variable from a different function entirely — which threw
      // at request time and took the whole overview down with it.
      rangeDays: { v: days, delta: 0 },
      cvOrders: { v: cur.cvOrders ?? 0, delta: delta(cur.cvOrders ?? 0, prev.cvOrders ?? 0) },
      totalRevenue: { v: cur.totalRevenue ?? cur.revenue, delta: delta(cur.totalRevenue ?? cur.revenue, prev.totalRevenue ?? prev.revenue) },
      orders: { v: cur.orders, delta: delta(cur.orders, prev.orders) },
      avgOrder: { v: cur.avgOrder, delta: delta(cur.avgOrder, prev.avgOrder) },
      visitors: { v: cur.visitors, delta: delta(cur.visitors, prev.visitors) },
      views: { v: cur.views, delta: delta(cur.views, prev.views) },
      conv: { v: cur.convRate, delta: delta(cur.convRate, prev.convRate) },
    },
    totalCustomers: totalCustomers ?? 0,
    totalProducts: totalProducts ?? 0,
    needsAttention,
    lowStock,
    series: cur.series,
    funnel: cur.funnel,
    sources: cur.sources,
    devices: cur.devices,
    byCountry: cur.byCountry,
    byCity: cur.byCity,
    visitorsByCountry: cur.visitorsByCountry,
    untapped: cur.untapped,
    topViewed: cur.topViewed,
    topSellers: cur.topSellers,
    missed: cur.missed,
    byPayment: cur.byPayment,
    byWeekday: cur.byWeekday,
    byHour: cur.byHour,
    customers: cur.customers,
    byCategory: cur.byCategory,
    coupons: cur.coupons,
    lost: cur.lost,
    delivery: cur.delivery,
    profit: cur.profit,
    abandonedCart: cur.abandonedCart,
    runway,
    viewsApprox: cur.viewsApprox,
  });
}

// ----------------------------------------------------------------------------

// GET /api/admin/orders?filter=all|attention — admin only

/**
 * Orders list. Written defensively: if a migration hasn't been run yet, one
 * missing column would otherwise fail the whole SELECT and render every row as
 * a bare order number. We retry without the optional columns and tell the admin
 * exactly which SQL file to run.
 */
// Enough to scan recent activity without shipping the whole table to a phone.
// Reported back when reached, so a filtered month never looks smaller than it is.
const ORDERS_LIMIT = 60;

async function ordersHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();
  let q = supabase
    .from('web_orders')
    .select(
      'id, order_number, quantity, total_usd, customer_email, customer_phone, payment_status, ' +
        'payment_method, fulfilment_status, delivered_content, error_note, ' +
        'admin_note, vendor_order_id, product_id, created_at, products(name, emoji, source)'
    )
    .order('created_at', { ascending: false })
    .limit(ORDERS_LIMIT);

  if (req.query.filter === 'attention') {
    q = q.in('fulfilment_status', ['failed', 'manual_pending']);
  }

  // Date range. Dates arrive as plain YYYY-MM-DD from a date input, so the end
  // of the range is widened to the end of that day — otherwise picking the same
  // day for both bounds returns nothing, which reads as "no orders" rather than
  // "you asked for a zero-length window".
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (isDate(from)) q = q.gte('created_at', `${from}T00:00:00.000Z`);
  if (isDate(to)) q = q.lte('created_at', `${to}T23:59:59.999Z`);

  const { data, error } = await q;
  if (error) {
    console.error('admin orders error:', error);

    // A missing optional column (admin_note comes from store_balance.sql) would
    // otherwise fail the whole SELECT and render every row as a bare order
    // number. Retry with the core columns and say which migration is missing.
    let fb = supabase
      .from('web_orders')
      .select(
        'id, order_number, quantity, total_usd, customer_email, payment_status, ' +
          'payment_method, fulfilment_status, delivered_content, product_id, ' +
          'created_at, products(name, emoji)'
      )
      .order('created_at', { ascending: false })
      .limit(200);

    if (req.query.filter === 'attention') {
      fb = fb.in('fulfilment_status', ['failed', 'manual_pending']);
    }

    const { data: basic, error: basicErr } = await fb;
    if (basicErr) {
      console.error('admin orders fallback failed:', basicErr);
      return res.status(500).json({ error: 'تعذر تحميل الطلبات' });
    }

    return res.status(200).json({
      orders: basic ?? [],
      warning: 'بعض الأعمدة مفقودة — شغّل store_balance.sql في Supabase لتفعيل كل الميزات.',
    });
  }
  const rows = data ?? [];
  // Hitting the cap means there are almost certainly more — say so rather than
  // let a filtered month quietly look like it only had 60 orders.
  res.status(200).json({ orders: rows, capped: rows.length >= ORDERS_LIMIT, limit: ORDERS_LIMIT });
}

// ----------------------------------------------------------------------------

// POST /api/admin/deliver — manually deliver an order (admin only)

/**
 * Book a coupon use for an order settled by hand.
 *
 * consume_coupon runs from the payment callback, which InstaPay orders never
 * reach — so a coupon capped at N uses could be spent without limit through
 * manual payment. Called only when the order was NOT already paid, so a
 * re-delivery of an already-paid order can't book the same coupon twice.
 */
async function bookCouponForManualSettle(supabase, order) {
  if (!order?.coupon_code) return;
  if (order.payment_status === 'paid') return;
  try {
    const { error } = await supabase.rpc('consume_coupon', { p_code: order.coupon_code });
    if (error) console.error('consume_coupon (manual) failed:', error.message);
  } catch (e) {
    console.error('consume_coupon (manual) threw:', e.message);
  }
}

/**
 * Remind me to set up mail forwarding on an account I just sold.
 *
 * Accounts sold with their own mailbox (Adobe, ChatGPT, SuperGrok and the like)
 * send verification codes to an inbox the customer can't open — they have the
 * account password, not the email password. Forwarding solves it completely and
 * takes a minute, but it has to be done at the moment of sale, and that's
 * exactly when it gets forgotten. Forgetting means the customer is locked out
 * at 3am and messages support.
 *
 * So the reminder arrives with the customer's address already in it, ready to
 * paste. Only fires for products delivered as account credentials — a coupon
 * code has no mailbox and doesn't need this.
 */
async function remindForwarding(order) {
  const content = String(order?.delivered_content || '');
  const product = order?.products?.name || '';

  // An account delivery looks like "email | password". A bare redeem code
  // doesn't, and shouldn't trigger a reminder about an inbox it hasn't got.
  const looksLikeAccount = /[\w.+-]+@[\w-]+\.[\w.]+/.test(content) && /[|:]/.test(content);
  if (!looksLikeAccount) return;

  const soldEmail = (content.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];

  notifyAdmin([
    '📮 <b>فعّل إعادة التوجيه</b>',
    '',
    `📦 ${product}`,
    `📧 حساب البيع: <code>${soldEmail}</code>`,
    `👤 إيميل العميل: <code>${order.customer_email}</code>`,
    '',
    'افتح Outlook بحساب البيع ثم:',
    'Settings → Mail → Forwarding → Enable',
    'والصق إيميل العميل أعلاه.',
    '',
    'بدونها لن يصل العميل لأكواد التحقق.',
  ].join('\n')).catch(() => {});
}

async function deliverHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { orderNumber, content } = req.body || {};
  if (!orderNumber || !content || String(content).trim().length < 3) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }

  const supabase = supabaseAdmin();
  const { data: order } = await supabase
    .from('web_orders')
    // order_number, the name, the phone and the money are here for the push to
    // the management system. Without order_number that push returned false in
    // silence — the inbox has it as its primary key — so every InstaPay sale
    // settled by hand vanished on the way, and nothing said so.
    //
    // Deliberately no geo_country/geo_city: those columns only exist after
    // store_geo.sql, and naming them here would break manual delivery itself
    // for the sake of two optional fields.
    .select('id, order_number, payment_status, fulfilment_status, payment_method, customer_name, customer_email, customer_phone, quantity, total_usd, cost_usd, coupon_code, products(name, delivery_type, delivery_speed, activation_note, activation_note_ar)')
    .eq('order_number', orderNumber)
    .maybeSingle();

  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  // Who may be delivered:
  //   'paid'            — the normal case.
  //   'amount_mismatch' — EasyKash reported a different amount (usually a
  //                       rounding overpayment) and the order was flagged.
  //   InstaPay awaiting a transfer — the money moves outside the system, so
  //                       the order is legitimately 'unpaid' until you confirm
  //                       the receipt yourself. Narrow on purpose: an EasyKash
  //                       order the customer abandoned is 'pending', not
  //                       'manual_pending', so it stays blocked.
  // In every case the update below settles the order to 'paid', so a confirmed
  // transfer also lands in revenue and profit instead of sitting unpaid.
  const isConfirmedManual =
    order.payment_method === 'instapay' && order.fulfilment_status === 'manual_pending';

  if (!['paid', 'amount_mismatch'].includes(order.payment_status) && !isConfirmedManual) {
    return res.status(400).json({ error: 'الطلب غير مدفوع — لا يمكن تسليمه' });
  }
  if (order.fulfilment_status === 'delivered') {
    return res.status(400).json({ error: 'الطلب مُسلَّم بالفعل' });
  }

  const { error } = await supabase
    .from('web_orders')
    .update({
      // Settles a confirmed mismatch AND a confirmed InstaPay transfer, so
      // the sale counts in revenue/profit instead of sitting as unpaid.
      payment_status: 'paid',
      fulfilment_status: 'delivered',
      delivered_content: String(content).trim(),
      fulfilled_at: new Date().toISOString(),
      error_note: 'delivered manually by admin',
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id);

  if (error) return res.status(500).json({ error: 'فشل التحديث' });

  await bookCouponForManualSettle(supabase, order);
  remindForwarding({ ...order, delivered_content: String(content).trim() });

  // An InstaPay sale is still a sale. Without this, only card orders would ever
  // reach the management system and the takings there would quietly be short by
  // every transfer settled by hand. Same de-duplication as the automatic path:
  // the order number is the primary key on the far side.
  // Awaited for the same reason as the payment callback: an un-awaited promise
  // can be killed when the function responds, and a sale that silently never
  // arrives is worse than one that takes a moment longer.
  //
  // The product name is already joined onto the order — a second query for it
  // would have read product_id, which is not selected either.
  await pushSaleToAgency(order, order.products);

  // Automatic delivery emails the customer from the payment callback. A manual
  // delivery never touches that path, so without this the buyer is marked
  // delivered and hears nothing — worst for an InstaPay customer, who is
  // already waiting on a transfer we confirmed by hand. Never block the
  // delivery on the email: the order is already delivered either way.
  let emailed = true;
  try {
    emailed = await emailCodes({
      to: order.customer_email,
      orderNumber,
      productName: order.products?.name || 'ProSkill',
      quantity: order.quantity || 1,
      codes: String(content).trim(),
      product: order.products || null,
    });
  } catch (e) {
    emailed = false;
    console.error('manual delivery email failed:', e.message);
  }

  res.status(200).json({ ok: true, emailed });
}

// ----------------------------------------------------------------------------

// GET  /api/admin/products — list
// POST /api/admin/products — update one product (admin only)

// An offer has to be an offer. Checked on the server because the browser is
// not where money rules live — and because a fat finger here is silent: nothing
// errors, the shop just starts selling at a loss or "discounting" upward.
function saleError(next, prev) {
  const raw = next.sale_price_usd;
  if (raw === '' || raw == null) return null;          // clearing the offer

  const sale = Number(raw);
  if (!Number.isFinite(sale) || sale <= 0) return 'سعر العرض لازم يكون رقم أكبر من صفر';

  const price = Number(next.price_usd ?? prev?.price_usd);
  if (Number.isFinite(price) && sale >= price) {
    return `سعر العرض ($${sale}) لازم يكون أقل من السعر العادي ($${price})`;
  }

  const cost = Number(next.cost_usd ?? prev?.cost_usd);
  if (Number.isFinite(cost) && cost > 0 && sale < cost) {
    return `سعر العرض ($${sale}) أقل من تكلفتك ($${cost}) — هتخسر في كل بيعة`;
  }
  return null;
}

const EDITABLE = [
  'name', 'price_usd', 'sale_price_usd', 'cost_usd', 'store_description', 'store_description_ar', 'image_url', 'store_visible',
  'is_featured', 'emoji', 'category_id', 'seo_title', 'seo_description',
  'activation_note', 'activation_note_ar',
  'is_active', // controls visibility in the BOT too — guarded below
];

async function productsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    const ADMIN_PROD_COLS =
      'id, name, emoji, price_usd, cost_usd, sort_order, store_description, store_description_ar, image_url, store_visible, ' +
      'activation_note, activation_note_ar, ' +
      'is_featured, is_active, delivery_speed, source, vendor_code, category_id';

    // Match the storefront exactly (featured first, then rank, then id as a
    // tiebreaker). If the admin list sorted differently, the number shown next
    // to a product wouldn't be the number the customer sees — and typing "3"
    // would move it somewhere else entirely.
    // NO is_active filter — the admin list must show disabled products too, or
    // there is no way to switch one back on.
    const ordered = (q) => q
      .order('is_featured', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    let { data, error } = await ordered(
      supabase.from('products').select(`${ADMIN_PROD_COLS}, sale_price_usd`)
    );
    if (error) {
      console.warn('admin: sale_price_usd missing — run store_sale_price.sql');
      ({ data, error } = await ordered(supabase.from('products').select(ADMIN_PROD_COLS)));
    }
    if (error) return res.status(500).json({ error: 'query failed' });

    const { data: cats } = await supabase.from('categories').select('id, name, emoji');
    return res.status(200).json({ products: data ?? [], categories: cats ?? [] });
  }

  if (req.method === 'POST') {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const patch = {};
    for (const k of EDITABLE) if (k in fields) patch[k] = fields[k];
    // A blank name would break the product everywhere (and the bot shares this
    // row). Drop it rather than save an empty string.
    if ('name' in patch && (!patch.name || !String(patch.name).trim())) {
      delete patch.name;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no fields' });

    if ('price_usd' in patch) {
      const p = Number(patch.price_usd);
      if (!Number.isFinite(p) || p <= 0 || p > 10000) {
        return res.status(400).json({ error: 'سعر غير صحيح' });
      }
      patch.price_usd = p;
    }

    // The offer, checked against whatever the row will actually hold — the new
    // price if it is being changed in the same save, otherwise the stored one.
    // Checking against only the submitted fields would let "price 5, sale 8" in
    // whenever the price wasn't part of the edit.
    if ('sale_price_usd' in patch) {
      const { data: prev } = await supabase
        .from('products').select('price_usd, cost_usd').eq('id', id).maybeSingle();

      const bad = saleError(patch, prev);
      if (bad) return res.status(400).json({ error: bad });

      const raw = patch.sale_price_usd;
      patch.sale_price_usd = raw === '' || raw == null ? null : Number(raw);
    }

    // Guard: turning ON an own-stock instant product with zero codes would let
    // a customer pay and receive nothing — in the bot as well as the website.
    const turningOn = patch.store_visible === true || patch.is_active === true;
    if (turningOn) {
      const { data: prod } = await supabase
        .from('products')
        .select('source, delivery_speed')
        .eq('id', id)
        .maybeSingle();

      if (prod && prod.source !== 'vendor' && prod.delivery_speed === 'instant') {
        const { count } = await supabase
          .from('stock_items')
          .select('*', { count: 'exact', head: true })
          .eq('product_id', id)
          .eq('status', 'available');

        if (!count) {
          return res.status(400).json({ error: 'لا يمكن تفعيل منتج فوري بلا مخزون. أضف أكواداً أولاً.' });
        }
      }
    }

    patch.updated_at = new Date().toISOString();
    let { error } = await supabase.from('products').update(patch).eq('id', id);

    // The form always sends the offer field, so before store_sale_price.sql
    // EVERY product save would fail — not just the ones setting an offer. Drop
    // the field and save the rest rather than block ordinary edits.
    if (error && /sale_price_usd/i.test(error.message || '')) {
      console.warn('admin: sale_price_usd missing — run store_sale_price.sql');
      delete patch.sale_price_usd;
      if (Object.keys(patch).length > 0) {
        ({ error } = await supabase.from('products').update(patch).eq('id', id));
      } else {
        error = null;
      }
    }
    if (error) return res.status(500).json({ error: 'update failed' });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method' });
}

// ----------------------------------------------------------------------------

// ============================================================================
// POST /api/admin/upload  — upload a product image (admin only)
// Body: { productId, filename, contentType, dataBase64 }
//
// The file goes to the public `product-images` bucket via the service key,
// so the browser never needs write access to storage.
// ============================================================================



const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB

async function uploadHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { productId, contentType, dataBase64, kind, serviceId } = req.body || {};
  const isService = kind === 'service';
  const targetId = isService ? serviceId : productId;
  if (!targetId || !dataBase64) return res.status(400).json({ error: 'بيانات ناقصة' });

  const ext = ALLOWED[contentType];
  if (!ext) return res.status(400).json({ error: 'الصيغة غير مدعومة (JPG / PNG / WebP فقط)' });

  const buffer = Buffer.from(String(dataBase64).split(',').pop(), 'base64');
  if (buffer.length === 0) return res.status(400).json({ error: 'ملف فارغ' });
  if (buffer.length > MAX_BYTES) return res.status(400).json({ error: 'الحجم أكبر من 3 ميجابايت' });

  const supabase = supabaseAdmin();
  const path = `${isService ? 'services' : 'products'}/${targetId}-${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('product-images')
    .upload(path, buffer, { contentType, upsert: true, cacheControl: '31536000' });

  if (upErr) {
    console.error('upload failed:', upErr.message);
    // Common cause: the 'product-images' storage bucket doesn't exist or isn't
    // public. Surface the real message so it's fixable.
    return res.status(500).json({ error: `فشل رفع الصورة: ${upErr.message}` });
  }

  const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path);
  const image_url = pub.publicUrl;

  const { error: updErr } = isService
    ? await supabase.from('ps_services').update({ image_url }).eq('id', targetId)
    : await supabase.from('products').update({ image_url, updated_at: new Date().toISOString() }).eq('id', targetId);

  if (updErr) {
    console.error('image update failed:', updErr.message);
    return res.status(500).json({ error: 'تم الرفع لكن فشل الحفظ' });
  }

  res.status(200).json({ ok: true, image_url });
}

// ----------------------------------------------------------------------------

// GET    /api/admin/coupons  — list
// POST   /api/admin/coupons  — create
// PATCH  /api/admin/coupons  — toggle active { id, is_active }
// DELETE /api/admin/coupons  — remove { id }   (only if never used)

const CODE_RE = /^[A-Z0-9_-]{3,24}$/;

async function couponsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('coupons')
      .select('*, products(name, emoji)')
      .order('created_at', { ascending: false });

    if (error) {
      // product_id comes from coupon_product.sql. If that hasn't been run the
      // join fails and the whole list would vanish — fall back and say why.
      console.error('coupons query failed:', error.message);
      const { data: basic, error: e2 } = await supabase
        .from('coupons')
        .select('*')
        .order('created_at', { ascending: false });
      if (e2) return res.status(500).json({ error: 'تعذر تحميل الكوبونات' });
      return res.status(200).json({
        coupons: basic ?? [],
        warning: 'شغّل coupon_product.sql في Supabase لتفعيل كوبونات المنتج المحدد.',
      });
    }
    return res.status(200).json({ coupons: data ?? [] });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase();

    if (!CODE_RE.test(code)) {
      return res.status(400).json({ error: 'الكود: 3-24 حرفاً إنجليزياً أو رقماً' });
    }
    if (!['percent', 'fixed'].includes(b.type)) {
      return res.status(400).json({ error: 'نوع الخصم غير صحيح' });
    }

    const value = Number(b.value);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'قيمة الخصم غير صحيحة' });
    }
    if (b.type === 'percent' && value > 90) {
      return res.status(400).json({ error: 'أقصى نسبة خصم 90%' });
    }

    const row = {
      code,
      type: b.type,
      value,
      min_order_usd: Number(b.min_order_usd) || 0,
      max_discount_usd: b.max_discount_usd ? Number(b.max_discount_usd) : null,
      max_uses: b.max_uses ? parseInt(b.max_uses, 10) : null,
      max_uses_per_email: b.max_uses_per_email ? parseInt(b.max_uses_per_email, 10) : 1,
      expires_at: b.expires_at || null,
      // null = works on every product. Set = that product only.
      product_id: b.product_id || null,
      is_active: true,
    };

    const { error } = await supabase.from('coupons').insert(row);
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'هذا الكود موجود بالفعل' });
      console.error('coupon insert failed:', error.message);
      // A generic "failed" here cost hours before (see the products.price and
      // products.source hunts). Say what actually broke.
      if (/product_id/i.test(error.message)) {
        return res.status(500).json({
          error: 'شغّل coupon_product.sql في Supabase أولاً — عمود المنتج غير موجود.',
        });
      }
      return res.status(500).json({ error: `فشل الإنشاء: ${error.message}` });
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PATCH') {
    const { id, is_active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('coupons').update({ is_active: !!is_active }).eq('id', id);
    if (error) return res.status(500).json({ error: 'update failed' });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    // Keep used coupons for accounting; deactivate them instead.
    const { data: c } = await supabase.from('coupons').select('used_count').eq('id', id).maybeSingle();
    if (c && c.used_count > 0) {
      return res.status(400).json({ error: 'الكود مُستخدَم — عطّله بدلاً من حذفه' });
    }
    const { error } = await supabase.from('coupons').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'delete failed' });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method' });
}

// ----------------------------------------------------------------------------

// GET   /api/admin/reviews          — all reviews, published or not
// PATCH /api/admin/reviews          — { id, is_published }  (hide abuse)

async function reviewsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('reviews')
      .select('id, rating, comment, author_name, is_published, created_at, order_number, products(name, emoji)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: 'query failed' });
    return res.status(200).json({ reviews: data ?? [] });
  }

  if (req.method === 'PATCH') {
    const { id, is_published } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('reviews').update({ is_published: !!is_published }).eq('id', id);
    if (error) return res.status(500).json({ error: 'update failed' });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method' });
}


// ----------------------------------------------------------------------------
// POST /api/admin?action=create-product
// Creates an OWN product (source='own'). It appears in BOTH the website
// and the Telegram bot, because both read the same `products` table.
//
// Safety: an "instant" product with no stock would take a customer's money and
// deliver nothing. We therefore create instant products as HIDDEN
// (store_visible=false, is_active=false) until stock is added.
// ----------------------------------------------------------------------------
async function createProductHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const b = req.body || {};
  const name = String(b.name || '').trim();
  const price = Number(b.price_usd);

  if (name.length < 2 || name.length > 120) {
    return res.status(400).json({ error: 'اسم المنتج بين 2 و 120 حرفاً' });
  }
  if (!Number.isFinite(price) || price <= 0 || price > 10000) {
    return res.status(400).json({ error: 'سعر غير صحيح' });
  }
  if (!['instant', 'manual_1_3h'].includes(b.delivery_speed)) {
    return res.status(400).json({ error: 'نوع التسليم غير صحيح' });
  }
  if (!['code', 'account', 'invite'].includes(b.delivery_type)) {
    return res.status(400).json({ error: 'طريقة التسليم غير صحيحة' });
  }

  const isInstant = b.delivery_speed === 'instant';

  const row = {
    name,
    price_usd: price,
    emoji: b.emoji ? String(b.emoji).slice(0, 4) : '📦',
    description: b.description ? String(b.description).slice(0, 2000) : null,
    description_ar: b.description_ar ? String(b.description_ar).slice(0, 2000) : null,
    store_description: b.store_description ? String(b.store_description).slice(0, 1000) : null,
    image_url: b.image_url ? String(b.image_url) : null,
    delivery_speed: b.delivery_speed,
    delivery_type: b.delivery_type,
    warranty_days: Math.max(0, parseInt(b.warranty_days, 10) || 0),
    category_id: b.category_id || null,
    source: 'own', // the products_source_check constraint allows only 'own' | 'vendor'
    // Instant products stay hidden until at least one code exists.
    is_active: !isInstant,
    store_visible: !isInstant,
    sort_order: 999,
  };

  const supabase = supabaseAdmin();
  const { data, error } = await supabase.from('products').insert(row).select('id, name').single();

  if (error) {
    console.error('create product failed:', error.message);
    // Surface the real reason (missing column, constraint, etc.) instead of a
    // generic message, so problems are diagnosable without guessing.
    return res.status(500).json({ error: `فشل إنشاء المنتج: ${error.message}` });
  }

  res.status(200).json({
    ok: true,
    id: data.id,
    hidden: isInstant,
    message: isInstant
      ? 'أُنشئ المنتج مخفياً — أضف أكواد المخزون ثم فعّله.'
      : 'أُنشئ المنتج وهو ظاهر الآن.',
  });
}

// ----------------------------------------------------------------------------
// GET  /api/admin?action=stock&productId=...   → available/sold counts
// POST /api/admin?action=stock                 → add codes { productId, codes[] }
//
// Codes are encrypted with the SAME key and format as the bot, so a code added
// here can be delivered by either channel.
// ----------------------------------------------------------------------------
/**
 * Show enough of a credential to identify it, and no more.
 *
 * "user@mail.com | Passw0rd" -> "use…com | Pa••••rd"
 * A full credential list rendered in a browser tab is a screenshot, a shoulder
 * glance, or a shared screen away from leaking. The preview keeps the admin
 * able to spot the row they mean without putting the secret on screen.
 */
function maskSecret(text) {
  const s = String(text || '');
  const keep = (part) => {
    const t = part.trim();
    if (t.length <= 6) return t[0] + '•'.repeat(Math.max(1, t.length - 1));
    return `${t.slice(0, 3)}${'•'.repeat(4)}${t.slice(-3)}`;
  };
  return s.split(/\r?\n/)[0].split('|').map(keep).join(' | ').slice(0, 60);
}

async function stockHandler(req, res) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    const productId = String(req.query.productId || '');
    if (!productId) return res.status(400).json({ error: 'productId required' });

    // Counts come from a COUNT query — they must stay exact however large the
    // inventory gets, and a head query can't be truncated.
    const countFor = (status) =>
      supabase
        .from('stock_items')
        .select('*', { count: 'exact', head: true })
        .eq('product_id', productId)
        .eq('status', status)
        .then((r) => r.count ?? 0);

    // The listing is capped. Decrypting thousands of rows on every open would
    // be slow on the server and a heavy payload on a phone — and the point of
    // this list is finding a specific bad code, which the newest rows cover.
    // Available first: those are the ones that can still reach a customer.
    const LIST_LIMIT = 60;
    const [available, sold, listRes] = await Promise.all([
      countFor('available'),
      countFor('sold'),
      supabase
        .from('stock_items')
        .select('id, status, content_encrypted, created_at, sold_at')
        .eq('product_id', productId)
        .order('status', { ascending: true })   // 'available' sorts before 'sold'
        .order('created_at', { ascending: true })
        .limit(LIST_LIMIT),
    ]);

    const { data, error } = listRes;
    if (error) return res.status(500).json({ error: 'query failed' });

    // Decrypt for the listing, but return a MASKED form by default. You need
    // enough to recognise which row is the broken one — not the whole
    // credential sitting in a browser tab. The full value is available per-row
    // on request (action=reveal-stock), which keeps the common case safe.
    const items = (data ?? []).map((r) => {
      let preview = null;
      let broken = false;
      try {
        const plain = decryptStock(r.content_encrypted);
        preview = maskSecret(plain);
      } catch {
        // Almost always a code encrypted under a previous ENCRYPTION_KEY. It
        // can never be delivered, so surfacing it is the whole point: you can
        // find it here and remove it instead of a customer hitting it.
        broken = true;
      }
      return {
        id: r.id,
        status: r.status,
        preview,
        broken,
        created_at: r.created_at,
        sold_at: r.sold_at,
      };
    });

    // Counts stay first for existing callers; items is additive so nothing that
    // read this endpoint before has to change.
    return res.status(200).json({
      available,
      sold,
      items,
      listCapped: (data ?? []).length >= LIST_LIMIT,
      listLimit: LIST_LIMIT,
    });
  }

  if (req.method === 'POST') {
    const { productId, codes } = req.body || {};
    if (!productId || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    if (codes.length > 200) {
      return res.status(400).json({ error: 'أقصى 200 كود في المرة الواحدة' });
    }

    const clean = codes.map((c) => String(c).trim()).filter((c) => c.length >= 3);
    if (clean.length === 0) return res.status(400).json({ error: 'لا توجد أكواد صالحة' });

    if (!process.env.ENCRYPTION_KEY) {
      console.error('ENCRYPTION_KEY missing — refusing to store plaintext stock');
      return res.status(500).json({ error: 'مفتاح التشفير غير مضبوط' });
    }

    let rows;
    try {
      rows = clean.map((c) => ({
        product_id: productId,
        content_encrypted: encryptStock(c),
        status: 'available',
      }));
    } catch (e) {
      console.error('encryption failed:', e.message);
      return res.status(500).json({ error: 'فشل تشفير الأكواد' });
    }

    const { error } = await supabase.from('stock_items').insert(rows);
    if (error) {
      console.error('stock insert failed:', error.message);
      return res.status(500).json({ error: 'فشل حفظ الأكواد' });
    }

    return res.status(200).json({ ok: true, added: rows.length });
  }

  res.status(405).json({ error: 'method' });
}


// ----------------------------------------------------------------------------
// GET /api/admin?action=vendor-browse[&vendor=all|shopbot|subnova|vex]
//
// Lists every configured vendor's catalog side by side, tagged with its origin,
// so you always know WHO you are reselling before you set a price.
// One vendor being down must not hide the others.
// ----------------------------------------------------------------------------
const VENDOR_LABELS = { shopbot: 'Shop Bot', subnova: 'Subnova', vex: 'Vexoran' };

async function vendorBrowseHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const want = String(req.query.vendor || 'all');
  const supabase = supabaseAdmin();

  const jobs = [];
  if ((want === 'all' || want === 'shopbot') && process.env.VENDOR_API_URL && process.env.VENDOR_API_KEY) {
    jobs.push(browseShopbot());
  }
  if ((want === 'all' || want === 'subnova') && process.env.SUBNOVA_API_KEY) {
    jobs.push(browseSubnova());
  }
  if ((want === 'all' || want === 'vex') && process.env.VEX_API_URL && process.env.VEX_API_KEY) {
    jobs.push(browseVex());
  }

  if (jobs.length === 0) {
    return res.status(400).json({ error: 'لا يوجد فيندور مضبوط. راجع متغيرات البيئة.' });
  }

  const settled = await Promise.all(jobs);

  const products = [];
  const errors = [];
  for (const r of settled) {
    if (r.error) errors.push({ vendor: r.vendor, label: r.label, error: r.error });
    else products.push(...r.products);
  }

  // Mark what is already in our catalog, per vendor.
  const { data: mine } = await supabase
    .from('products')
    .select('vendor_code, vendor_product_id')
    .eq('source', 'vendor');

  const imported = new Set((mine ?? []).map((m) => `${m.vendor_code}:${m.vendor_product_id}`));
  for (const p of products) p.imported = imported.has(`${p.vendor}:${p.id}`);

  products.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));

  res.status(200).json({ products, errors, vendors: Object.keys(VENDOR_LABELS) });
}

async function grab(url, headers, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { ...headers, Accept: 'application/json' }, signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function browseShopbot() {
  try {
    const j = await grab(`${process.env.VENDOR_API_URL}/products`, {
      Authorization: `Bearer ${process.env.VENDOR_API_KEY}`,
    });
    const products = (j.products ?? []).map((p) => ({
      vendor: 'shopbot',
      vendorLabel: VENDOR_LABELS.shopbot,
      id: String(p.id),
      name: String(p.name ?? 'Product'),
      cost: Number(p.price ?? 0),
      stock: p.stock === 'unlimited' ? null : Number(p.stock) || 0,
      unlimited: p.stock === 'unlimited',
      manual: false,
    }));
    return { vendor: 'shopbot', products };
  } catch (e) {
    console.error('browse shopbot:', e.message);
    return { vendor: 'shopbot', label: VENDOR_LABELS.shopbot, error: e.message };
  }
}

async function browseSubnova() {
  try {
    const base = process.env.SUBNOVA_API_URL || 'https://subnovaa.com/api/cdk';
    const j = await grab(`${base}/services`, { 'X-API-Key': process.env.SUBNOVA_API_KEY });
    const products = (j.services ?? [])
      .filter((sv) => sv.is_active)
      .map((sv) => ({
        vendor: 'subnova',
        vendorLabel: VENDOR_LABELS.subnova,
        id: String(sv.id),
        name: String(sv.name ?? 'Service'),
        cost: Number(sv.price ?? sv.cost ?? 0),
        stock: Number(sv.qty) || 0,
        unlimited: false,
        manual: false,
      }));
    return { vendor: 'subnova', products };
  } catch (e) {
    console.error('browse subnova:', e.message);
    return { vendor: 'subnova', label: VENDOR_LABELS.subnova, error: e.message };
  }
}

async function browseVex() {
  try {
    const j = await grab(`${process.env.VEX_API_URL}?action=products`, {
      Authorization: `Bearer ${process.env.VEX_API_KEY}`,
    });
    const list = Array.isArray(j) ? j : (j.products ?? j.data ?? []);
    const products = list
      .filter((p) => p?.id)
      .map((p) => ({
        vendor: 'vex',
        vendorLabel: VENDOR_LABELS.vex,
        id: String(p.id),
        name: String(p.name ?? 'Product'),
        cost: Number(p.price ?? 0),
        stock: p.manual_delivery ? null : Number(p.stock) || 0,
        unlimited: false,
        manual: Boolean(p.manual_delivery),
      }));
    return { vendor: 'vex', products };
  } catch (e) {
    console.error('browse vex:', e.message);
    return { vendor: 'vex', label: VENDOR_LABELS.vex, error: e.message };
  }
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=vendor-costs
// Re-reads every configured vendor's catalogue and writes today's cost onto the
// products imported from it.
//
// Import sets the cost once and then refuses to run again for the same item, so
// a vendor raising a price leaves a number behind that quietly stops being
// true. Every margin, every profit figure on the overview, and every decision
// about what to sell rests on that number.
//
// Prices are NEVER touched. Only the cost is the vendor's to state.
// ----------------------------------------------------------------------------
async function vendorCostsHandler(req, res) {
  // Two callers: the button in the admin (POST, admin session) and the daily
  // scheduler (GET, bearer secret). Nobody else.
  //
  // Fails CLOSED on a missing secret: without the `&& secret` the comparison
  // would be `'Bearer undefined' === 'Bearer undefined'` the moment the
  // variable is absent, and the URL is public.
  const secret = process.env.CRON_SECRET;
  const fromCron = Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;

  if (!fromCron) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  }

  const jobs = [];
  if (process.env.VENDOR_API_URL && process.env.VENDOR_API_KEY) jobs.push(browseShopbot());
  if (process.env.SUBNOVA_API_KEY) jobs.push(browseSubnova());
  if (process.env.VEX_API_URL && process.env.VEX_API_KEY) jobs.push(browseVex());
  if (jobs.length === 0) {
    return res.status(400).json({ error: 'لا يوجد فيندور مضبوط. راجع متغيرات البيئة.' });
  }

  const settled = await Promise.all(jobs);
  const errors = [];
  const live = new Map();          // 'vendor:id' -> cost
  const answered = new Set();      // vendors that actually replied

  for (const r of settled) {
    if (r.error) { errors.push({ vendor: r.vendor, error: r.error }); continue; }
    answered.add(r.vendor);
    for (const p of r.products) live.set(`${p.vendor}:${p.id}`, Number(p.cost));
  }

  const supabase = supabaseAdmin();
  const { data: mine, error: qErr } = await supabase
    .from('products')
    .select('id, name, price_usd, cost_usd, vendor_code, vendor_product_id')
    .eq('source', 'vendor');
  if (qErr) return res.status(500).json({ error: 'query failed' });

  const updated = [];
  const losing = [];
  const missing = [];
  const failed = [];

  for (const p of mine ?? []) {
    const key = `${p.vendor_code}:${p.vendor_product_id}`;
    const old = Number(p.cost_usd);
    const fresh = live.get(key);
    const hasFresh = live.has(key) && Number.isFinite(fresh) && fresh > 0;

    // A vendor that was down must not make its whole catalogue look delisted.
    if (!live.has(key) && answered.has(p.vendor_code)) {
      missing.push({ id: p.id, name: p.name });
    }

    // The cost we hold for this product AFTER this run — whether or not it
    // moved today.
    let effective = Number.isFinite(old) && old > 0 ? old : null;

    // Money in cents: 4.10 and 4.1000001 are the same price, and rewriting a
    // row for that would report a change that never happened.
    const changed = hasFresh && !(Number.isFinite(old) && Math.abs(old - fresh) < 0.005);

    if (changed) {
      const { error } = await supabase.from('products').update({ cost_usd: fresh }).eq('id', p.id);
      if (error) {
        failed.push({ id: p.id, name: p.name });
      } else {
        updated.push({
          id: p.id,
          name: p.name,
          from: Number.isFinite(old) && old > 0 ? old : null,
          to: fresh,
        });
        effective = fresh;
      }
    } else if (hasFresh) {
      effective = fresh;
    }

    // Checked for EVERY product, not only the ones that moved.
    //
    // Tying this to a change was wrong: a product already priced below its cost
    // has a cost the vendor never touches again, so it would never appear. The
    // run would report "0 updated", read as good news, and the loss would go on
    // exactly as before. The question this button answers is "am I losing money
    // anywhere", not "did anything change today".
    const price = Number(p.price_usd);
    if (effective != null && Number.isFinite(price) && price < effective) {
      losing.push({ id: p.id, name: p.name, price, cost: effective });
    }
  }

  // A daily run that reports "nothing changed" every morning gets muted within
  // a week, and then the one message that mattered is muted too. Silence unless
  // there is something to act on.
  //
  // Sent for the scheduled run only — a manual run puts the same information on
  // screen in front of the person who pressed the button.
  if (fromCron) {
    const rises = updated.filter((u) => u.from != null && u.to > u.from);
    const falls = updated.filter((u) => u.from != null && u.to < u.from);
    const firstTime = updated.filter((u) => u.from == null);

    if (rises.length || losing.length || missing.length) {
      const money = (n) => `$${Number(n).toFixed(2)}`;

      // Telegram parses this as HTML. A product called "Office 365 & Adobe" or
      // "Adobe CC <All Apps>" makes the whole message unparseable, Telegram
      // answers 400, and notifyAdmin swallows the error — so the alert simply
      // never arrives and nothing says why. Names are free text he types.
      const esc = (v) => String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // And a cap, for the same reason in reverse: Telegram rejects anything
      // over 4096 characters, so a day when the vendor re-priced fifty items —
      // exactly the day this matters most — would send nothing at all.
      const MAX = 12;
      const some = (arr, fn) => [
        ...arr.slice(0, MAX).map(fn),
        ...(arr.length > MAX ? [`• …و ${arr.length - MAX} غيرهم`] : []),
      ];

      const lines = [];

      if (rises.length) {
        lines.push('📈 <b>الفينيدور رفع أسعار</b>');
        lines.push(...some(rises, (u) => `• ${esc(u.name)}: ${money(u.from)} ← ${money(u.to)}`));
      }
      // The part that costs money today, kept last so it is what he reads last.
      if (losing.length) {
        lines.push('', '⚠️ <b>بتبيعهم تحت التكلفة دلوقتي</b>');
        lines.push(...some(losing, (l) => `• ${esc(l.name)}: سعر ${money(l.price)} · تكلفة ${money(l.cost)}`));
      }
      if (missing.length) {
        const names = missing.slice(0, MAX).map((m) => esc(m.name)).join(' · ');
        const more = missing.length > MAX ? ` …و ${missing.length - MAX} غيرهم` : '';
        lines.push('', `🚫 مش موجودين عند الفينيدور: ${names}${more}`);
      }
      if (falls.length || firstTime.length) {
        lines.push('', `ℹ️ نزلت: ${falls.length} · اتسجّلت لأول مرة: ${firstTime.length}`);
      }

      try {
        // Last guard, after every other cap — nothing gets to be 4096 long.
        await notifyAdmin(lines.join('\n').slice(0, 3900));
      } catch (e) {
        console.error('vendor-costs alert failed:', e.message);
      }
    }
  }

  return res.status(200).json({
    checked: (mine ?? []).length,
    updated, losing, missing, failed, errors,
  });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=vendor-import
// Body: { vendorProductId, name, cost, manual, price_usd, emoji }
// Creates a product in OUR catalog pointing at the vendor's item.
// ----------------------------------------------------------------------------
async function vendorImportHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const b = req.body || {};
  const price = Number(b.price_usd);
  const cost = Number(b.cost);

  if (!b.vendorProductId || !b.name) return res.status(400).json({ error: 'بيانات ناقصة' });
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'سعر غير صحيح' });
  if (Number.isFinite(cost) && price < cost) {
    return res.status(400).json({ error: `سعرك ($${price}) أقل من تكلفتك ($${cost}) — ستخسر في كل بيعة.` });
  }

  const supabase = supabaseAdmin();

  const vendorCode = String(b.vendor || 'vex');
  if (!['shopbot', 'subnova', 'vex'].includes(vendorCode)) {
    return res.status(400).json({ error: 'فيندور غير معروف' });
  }

  const { data: dup } = await supabase
    .from('products')
    .select('id')
    .eq('vendor_code', vendorCode)
    .eq('vendor_product_id', String(b.vendorProductId))
    .maybeSingle();

  if (dup) return res.status(400).json({ error: 'هذا المنتج مستورد بالفعل' });

  const { error } = await supabase.from('products').insert({
    name: String(b.name).slice(0, 120),
    price_usd: price,
    cost_usd: Number.isFinite(cost) && cost > 0 ? cost : null,
    emoji: b.emoji ? String(b.emoji).slice(0, 4) : '📦',
    source: 'vendor',
    vendor_code: vendorCode,
    vendor_product_id: String(b.vendorProductId),
    category_id: b.category_id || null,
    delivery_speed: b.manual ? 'manual_1_3h' : 'instant',
    delivery_type: 'code',
    is_active: true,
    store_visible: true,
    sort_order: 999,
  });

  if (error) {
    console.error('vendor import failed:', error.message);
    return res.status(500).json({ error: 'فشل الاستيراد' });
  }

  res.status(200).json({ ok: true });
}


// ----------------------------------------------------------------------------
// GET  /api/admin?action=balances          → live balance of every vendor
// POST /api/admin?action=balances          → { threshold } update the alert level
//
// Each vendor is queried independently: one being down must not hide the others.
// ----------------------------------------------------------------------------
async function balancesHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'POST') {
    const t = Number(req.body?.threshold);
    if (!Number.isFinite(t) || t < 0 || t > 10000) {
      return res.status(400).json({ error: 'حد غير صحيح' });
    }
    const { error } = await supabase
      .from('store_settings')
      .upsert({ key: 'low_balance_threshold', value: String(t) }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: 'فشل الحفظ' });
    return res.status(200).json({ ok: true, threshold: t });
  }

  const { data: setting } = await supabase
    .from('store_settings')
    .select('value')
    .eq('key', 'low_balance_threshold')
    .maybeSingle();
  const threshold = Number(setting?.value ?? 10);

  const vendors = [];

  // shopbot
  if (process.env.VENDOR_API_URL && process.env.VENDOR_API_KEY) {
    vendors.push(
      probe('shopbot', 'Shop Bot', `${process.env.VENDOR_API_URL}/balance`, {
        'X-API-Key': process.env.VENDOR_API_KEY,
      })
    );
  }
  // subnova
  if (process.env.SUBNOVA_API_KEY) {
    const base = process.env.SUBNOVA_API_URL || 'https://subnovaa.com/api/cdk';
    vendors.push(
      probe('subnova', 'Subnova', `${base}/balance`, { 'X-API-Key': process.env.SUBNOVA_API_KEY })
    );
  }
  // vex
  if (process.env.VEX_API_URL && process.env.VEX_API_KEY) {
    vendors.push(
      probe('vex', 'Vex', `${process.env.VEX_API_URL}?action=balance`, {
        Authorization: `Bearer ${process.env.VEX_API_KEY}`,
      })
    );
  }

  const results = await Promise.all(vendors);
  const low = results.filter((v) => v.balance != null && v.balance < threshold);

  res.status(200).json({ vendors: results, threshold, lowCount: low.length });
}

/**
 * Reads one vendor's balance without letting its failure break the others.
 *
 * Never coerce a missing field to 0: showing "$0.00" for a vendor whose response
 * we simply failed to parse would tell you to top up an account that is fine —
 * or worse, hide that a real balance is healthy. Unknown must look unknown.
 */
async function probe(code, label, url, headers) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { ...headers, Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);

    const j = await r.json().catch(() => null);
    if (!r.ok) return { code, label, balance: null, error: j?.error || `HTTP ${r.status}` };

    const raw =
      j?.balance ?? j?.data?.balance ?? j?.amount ?? j?.credit ?? j?.credits ??
      j?.wallet ?? j?.data?.amount ?? j?.result?.balance;

    const n = Number(raw);
    if (raw == null || !Number.isFinite(n)) {
      // Surface the field names so the mismatch is diagnosable at a glance.
      const keys = j && typeof j === 'object' ? Object.keys(j).slice(0, 6).join(', ') : typeof j;
      return { code, label, balance: null, error: `رد غير متوقع (${keys})` };
    }

    return { code, label, balance: n };
  } catch (e) {
    return { code, label, balance: null, error: e.name === 'AbortError' ? 'انتهت المهلة' : e.message };
  }
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=retry-order   { orderNumber }
//
// Re-attempts a vendor purchase for a PAID order that stalled. Only allowed when
// the stored note says the vendor charged nothing (retryable=yes) — retrying an
// unknown outcome could charge twice.
// ----------------------------------------------------------------------------
async function retryOrderHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const orderNumber = String(req.body?.orderNumber || '').trim().toUpperCase();
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });

  const supabase = supabaseAdmin();

  const { data: order } = await supabase
    .from('web_orders')
    .select('id, order_number, product_id, quantity, payment_status, fulfilment_status, admin_note, delivered_content')
    .eq('order_number', orderNumber)
    .maybeSingle();

  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (order.payment_status !== 'paid') return res.status(400).json({ error: 'الطلب غير مدفوع' });
  if (order.delivered_content) return res.status(400).json({ error: 'الطلب مُسلَّم بالفعل' });

  if (!/retryable=yes/.test(order.admin_note || '')) {
    return res.status(400).json({
      error: 'لا يمكن إعادة المحاولة تلقائياً — نتيجة الطلب لدى الفيندور غير مؤكدة. راجعه يدوياً ثم سلّم الأكواد.',
    });
  }

  const { data: product } = await supabase
    .from('products')
    .select('id, name, source, vendor_code, vendor_product_id')
    .eq('id', order.product_id)
    .maybeSingle();

  if (!product || product.source !== 'vendor') {
    return res.status(400).json({ error: 'هذا الطلب ليس من فيندور' });
  }

  const vendorCode = ['subnova', 'vex'].includes(product.vendor_code) ? product.vendor_code : 'shopbot';
  const buyerInfo = vendorCode === 'vex' ? `web-${order.order_number}` : `web:${order.order_number}`;

  try {
    const result = await purchaseFromVendor(
      vendorCode,
      String(product.vendor_product_id),
      order.quantity,
      buyerInfo
    );

    if (result.manual) {
      return res.status(200).json({ ok: true, manual: true, message: 'الفيندور وضع الطلب في التفعيل اليدوي.' });
    }

    const content = result.codes.join('\n\n');
    const { error } = await supabase
      .from('web_orders')
      .update({
        fulfilment_status: 'delivered',
        delivered_content: content,
        vendor_order_id: result.vendorOrderId,
        admin_note: `retried_ok|vendor=${vendorCode}`,
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);

    if (error) return res.status(500).json({ error: 'تم الشراء لكن فشل الحفظ — انسخ الأكواد يدوياً' });

    return res.status(200).json({ ok: true, delivered: true, codes: content });
  } catch (e) {
    if (e.noBalance) {
      return res.status(400).json({ error: 'الرصيد ما زال غير كافٍ. اشحن ثم أعد المحاولة.' });
    }
    console.error(`retry failed for ${orderNumber}:`, e.message);

    // A network error now means the outcome is unknown — lock further retries.
    if (e.kind === 'network') {
      await supabase
        .from('web_orders')
        .update({ admin_note: `retry_unknown|vendor=${vendorCode}|retryable=no|${e.message}` })
        .eq('id', order.id);
      return res.status(502).json({ error: 'انقطع الاتصال — النتيجة غير مؤكدة. راجع لوحة الفيندور قبل أي محاولة أخرى.' });
    }

    return res.status(400).json({ error: e.message });
  }
}


// ----------------------------------------------------------------------------
// GET    /api/admin?action=categories   → all categories (active or not)
// POST   /api/admin?action=categories   → create { name, emoji }
// PATCH  /api/admin?action=categories   → update { id, name?, emoji?, is_active?, sort_order? }
// DELETE /api/admin?action=categories   → remove { id }  (only if empty)
// ----------------------------------------------------------------------------
async function categoriesHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('categories')
      .select('id, name, emoji, is_active, sort_order')
      .order('sort_order', { ascending: true });

    if (error) return res.status(500).json({ error: 'query failed' });

    // How many products sit in each one — you should not delete a full category.
    const { data: prods } = await supabase
      .from('products')
      .select('category_id')
      .not('category_id', 'is', null);

    const counts = new Map();
    for (const p of prods ?? []) {
      counts.set(p.category_id, (counts.get(p.category_id) ?? 0) + 1);
    }

    const categories = (data ?? []).map((c) => ({ ...c, productCount: counts.get(c.id) ?? 0 }));

    const { count: uncategorised } = await supabase
      .from('products')
      .select('*', { count: 'exact', head: true })
      .is('category_id', null);

    return res.status(200).json({ categories, uncategorised: uncategorised ?? 0 });
  }

  if (req.method === 'POST') {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 40) {
      return res.status(400).json({ error: 'اسم القسم بين 2 و 40 حرفاً' });
    }

    const { data: last } = await supabase
      .from('categories')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { error } = await supabase.from('categories').insert({
      name,
      emoji: req.body?.emoji ? String(req.body.emoji).slice(0, 4) : '📁',
      is_active: true,
      sort_order: (last?.sort_order ?? 0) + 1,
    });

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'هذا القسم موجود بالفعل' });
      console.error('category insert failed:', error.message);
      return res.status(500).json({ error: 'فشل الإنشاء' });
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PATCH') {
    const { id, ...rest } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const patch = {};
    if (typeof rest.name === 'string' && rest.name.trim().length >= 2) patch.name = rest.name.trim().slice(0, 40);
    if (typeof rest.emoji === 'string') patch.emoji = rest.emoji.slice(0, 4);
    if (typeof rest.is_active === 'boolean') patch.is_active = rest.is_active;
    if (Number.isInteger(rest.sort_order)) patch.sort_order = rest.sort_order;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'لا شيء لتحديثه' });

    const { error } = await supabase.from('categories').update(patch).eq('id', id);
    if (error) return res.status(500).json({ error: 'فشل التحديث' });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    // Deleting a category would orphan its products in the storefront filter.
    const { count } = await supabase
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('category_id', id);

    if (count) {
      return res.status(400).json({
        error: `القسم يحتوي على ${count} منتج. انقلها أولاً أو عطّل القسم بدل حذفه.`,
      });
    }

    const { error } = await supabase.from('categories').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'فشل الحذف' });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method' });
}

// ----------------------------------------------------------------------------
// /api/admin?action=services  → manage the career services (ps_services)
// GET (all, incl. inactive) · POST (create) · PATCH (edit) · DELETE (remove)
// ----------------------------------------------------------------------------
async function servicesHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('ps_services')
      .select('id, title, title_ar, description, description_ar, icon, image_url, price_usd, wa_message, sort_order, is_active')
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: 'query failed' });
    return res.status(200).json({ services: data ?? [] });
  }

  if (req.method === 'POST') {
    const title = String(req.body?.title || '').trim();
    if (title.length < 2) return res.status(400).json({ error: 'اكتب اسم الخدمة (حرفين على الأقل)' });

    const { data: last } = await supabase
      .from('ps_services')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    const b = req.body || {};
    const { error } = await supabase.from('ps_services').insert({
      title,
      title_ar: b.title_ar ? String(b.title_ar).slice(0, 120) : null,
      description: b.description ? String(b.description).slice(0, 1000) : null,
      description_ar: b.description_ar ? String(b.description_ar).slice(0, 1000) : null,
      icon: b.icon ? String(b.icon).slice(0, 24) : '📄',
      image_url: b.image_url ? String(b.image_url).slice(0, 500) : null,
      price_usd: b.price_usd != null && b.price_usd !== '' ? Number(b.price_usd) : null,
      wa_message: b.wa_message ? String(b.wa_message).slice(0, 300) : null,
      is_active: true,
      sort_order: (last?.sort_order ?? 0) + 10,
    });
    if (error) {
      console.error('service insert failed:', error.message);
      return res.status(500).json({ error: 'فشل الإنشاء' });
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PATCH') {
    const { id, ...rest } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const patch = {};
    if (typeof rest.title === 'string' && rest.title.trim().length >= 2) patch.title = rest.title.trim().slice(0, 120);
    if (typeof rest.title_ar === 'string') patch.title_ar = rest.title_ar.slice(0, 120) || null;
    if (typeof rest.description === 'string') patch.description = rest.description.slice(0, 1000) || null;
    if (typeof rest.description_ar === 'string') patch.description_ar = rest.description_ar.slice(0, 1000) || null;
    if (typeof rest.icon === 'string') patch.icon = rest.icon.slice(0, 24);
    if (typeof rest.image_url === 'string') patch.image_url = rest.image_url.slice(0, 500) || null;
    if (rest.price_usd === null || rest.price_usd === '') patch.price_usd = null;
    else if (rest.price_usd != null) patch.price_usd = Number(rest.price_usd);
    if (typeof rest.wa_message === 'string') patch.wa_message = rest.wa_message.slice(0, 300) || null;
    if (typeof rest.is_active === 'boolean') patch.is_active = rest.is_active;
    if (Number.isInteger(rest.sort_order)) patch.sort_order = rest.sort_order;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'لا شيء لتحديثه' });

    const { error } = await supabase.from('ps_services').update(patch).eq('id', id);
    if (error) return res.status(500).json({ error: 'فشل التحديث' });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('ps_services').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'فشل الحذف' });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method' });
}


// ----------------------------------------------------------------------------
// POST /api/admin?action=deliver-from-stock
//
// Delivers an order using the encrypted inventory instead of content typed by
// hand. This exists because a manual delivery does NOT touch stock: typing an
// account out yourself leaves that same account sitting 'available', and the
// next buyer gets sold the identical credentials. Needed above all for InstaPay
// orders, where payment is confirmed by hand but the goods live in stock.
//
// Deliberately reuses the exact primitives the payment callback uses —
// claim_stock_for_web_order for the atomic claim, decryptStock, the same
// delivery email — so there is one way stock leaves the system, not two.
// ----------------------------------------------------------------------------
async function deliverFromStockHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { orderNumber } = req.body || {};
  if (!orderNumber) return res.status(400).json({ error: 'رقم الطلب مطلوب' });

  const supabase = supabaseAdmin();
  const { data: order } = await supabase
    .from('web_orders')
    .select('id, payment_status, fulfilment_status, payment_method, customer_email, quantity, product_id, delivered_content, coupon_code, ' +
            'products(name, delivery_type, delivery_speed, activation_note, activation_note_ar, source)')
    .eq('order_number', orderNumber)
    .maybeSingle();

  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  // Same rule as manual delivery: paid, flagged for review, or an InstaPay
  // transfer you've confirmed yourself.
  const isConfirmedManual =
    order.payment_method === 'instapay' && order.fulfilment_status === 'manual_pending';
  if (!['paid', 'amount_mismatch'].includes(order.payment_status) && !isConfirmedManual) {
    return res.status(400).json({ error: 'الطلب غير مدفوع — لا يمكن تسليمه' });
  }

  if (order.products?.source === 'vendor') {
    return res.status(400).json({ error: 'هذا منتج فيندور — ليس له مخزون عندك' });
  }

  // Stock is money: a repeated request (double tap, retried fetch) must not
  // burn a second account. Re-delivering an already-filled order is a
  // deliberate act — use manual delivery with the existing content for that.
  if (order.delivered_content) {
    return res.status(409).json({ error: 'الطلب مُسلَّم بالفعل — استخدم "إعادة تسليم" بنفس المحتوى' });
  }

  const qty = order.quantity || 1;
  const codes = [];
  let claimProblem = null;   // the DB's own reason, if it refused
  let decryptFailed = 0;     // claimed but couldn't be read back

  for (let i = 0; i < qty; i++) {
    const { data: claim, error: claimErr } = await supabase.rpc('claim_stock_for_web_order', {
      p_order_id: order.id,
      p_product_id: order.product_id,
    });

    if (claimErr) { claimProblem = `DB: ${claimErr.message}`; break; }

    const c = Array.isArray(claim) ? claim[0] : claim;
    if (!c?.success) { claimProblem = c?.message || 'out of stock'; break; }

    try {
      codes.push(decryptStock(c.content_encrypted));
    } catch (e) {
      // The row is already marked sold at this point — the claim is atomic and
      // deliberately so. Count it and report it: silently returning "no stock"
      // would hide the fact that inventory was consumed.
      decryptFailed += 1;
      console.error('decrypt failed on stock delivery:', e.message);
    }
  }

  if (codes.length === 0) {
    if (decryptFailed > 0) {
      return res.status(500).json({
        error: `تم حجز ${decryptFailed} كود من المخزون لكن تعذّر فك تشفيره — `
             + 'غالباً ENCRYPTION_KEY الحالي مختلف عن المفتاح الذي استُخدم وقت إضافة الأكواد. '
             + 'الأكواد القديمة لا تُفتح بمفتاح جديد.',
      });
    }

    // A bare "out of stock" leaves you guessing whether inventory is empty or
    // you're looking at the wrong variant — stock is per product, and
    // "Adobe 1 month" and "Adobe 4 month" are different rows. Name the product,
    // its real count, and whatever the database actually said.
    const { count } = await supabase
      .from('stock_items')
      .select('*', { count: 'exact', head: true })
      .eq('product_id', order.product_id)
      .eq('status', 'available');

    return res.status(409).json({
      error: `تعذّر سحب كود لـ "${order.products?.name || 'هذا المنتج'}" (المتاح: ${count ?? 0})`
           + (claimProblem ? ` — السبب: ${claimProblem}` : '')
           + '. لو المتاح أكبر من صفر، ابعت هذه الرسالة كما هي.',
    });
  }

  const joined = codes.join('\n\n');
  const partial = codes.length < qty;

  const { error } = await supabase
    .from('web_orders')
    .update({
      payment_status: 'paid',
      fulfilment_status: 'delivered',
      delivered_content: joined,
      fulfilled_at: new Date().toISOString(),
      error_note: partial
        ? `delivered from stock by admin (partial ${codes.length}/${qty})`
        : 'delivered from stock by admin',
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id);

  if (error) return res.status(500).json({ error: 'فشل التحديث' });

  await bookCouponForManualSettle(supabase, order);
  remindForwarding({ ...order, delivered_content: joined });

  let emailed = true;
  try {
    emailed = await emailCodes({
      to: order.customer_email,
      orderNumber,
      productName: order.products?.name || 'ProSkill',
      quantity: codes.length,
      codes: joined,
      product: order.products || null,
    });
  } catch (e) {
    emailed = false;
    console.error('stock delivery email failed:', e.message);
  }

  res.status(200).json({ ok: true, delivered: codes.length, requested: qty, partial, emailed });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=deliver-from-vendor
//
// Fills an order by buying it from the vendor, the same way an automatic
// payment does — for the orders that never went through the automatic path.
// An InstaPay transfer lands in your bank, not in a callback, so a vendor
// product bought that way had to be fetched from the vendor's panel by hand and
// pasted in.
//
// This SPENDS REAL MONEY. Everything below exists to make sure it spends it
// once, for an order that is genuinely owed.
// ----------------------------------------------------------------------------
async function deliverFromVendorHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { orderNumber } = req.body || {};
  if (!orderNumber) return res.status(400).json({ error: 'رقم الطلب مطلوب' });

  const supabase = supabaseAdmin();
  const { data: order } = await supabase
    .from('web_orders')
    .select('id, order_number, payment_status, fulfilment_status, payment_method, customer_name, customer_email, customer_phone, quantity, total_usd, cost_usd, product_id, delivered_content, coupon_code, ' +
            'products(name, source, vendor_code, vendor_product_id, delivery_type, delivery_speed, activation_note, activation_note_ar)')
    .eq('order_number', orderNumber)
    .maybeSingle();

  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  // Same gate as the other two delivery routes.
  const isConfirmedManual =
    order.payment_method === 'instapay' && order.fulfilment_status === 'manual_pending';
  if (!['paid', 'amount_mismatch'].includes(order.payment_status) && !isConfirmedManual) {
    return res.status(400).json({ error: 'الطلب غير مدفوع — لا يمكن تسليمه' });
  }

  const p = order.products || {};
  if (p.source !== 'vendor') {
    return res.status(400).json({ error: 'هذا المنتج ليس من فيندور — استخدم التسليم من المخزون' });
  }
  if (!p.vendor_code || !p.vendor_product_id) {
    return res.status(400).json({ error: 'المنتج غير مربوط بفيندور — راجع تبويب الفيندور' });
  }

  // A filled order is never bought again. A second tap, a retried request or a
  // reopened tab would otherwise pay the vendor twice for one sale.
  if (order.delivered_content) {
    return res.status(409).json({ error: 'الطلب مُسلَّم بالفعل — لن يتم الشراء مرة أخرى' });
  }

  const qty = Number(order.quantity) > 0 ? Number(order.quantity) : 1;

  // CLAIM THE ORDER BEFORE SPENDING ANYTHING.
  //
  // The delivered_content check above is a read, and a read is not a lock: two
  // taps, two tabs or a retried request all pass it and all reach the purchase.
  // The busy flag in the browser cannot help — it does not exist in the other
  // tab. And the idempotent external id only protects the one vendor that
  // honours it; for the others a second call is a second charge.
  //
  // This update is the lock. It only matches a row that is unclaimed and
  // undelivered, so exactly one caller can win it, and the loser is told rather
  // than allowed to buy.
  const claimTag = `buying-${Date.now()}`;
  const { data: claimed, error: claimErr } = await supabase
    .from('web_orders')
    .update({ vendor_order_id: claimTag, updated_at: new Date().toISOString() })
    .eq('id', order.id)
    .is('vendor_order_id', null)
    .is('delivered_content', null)
    .select('id');

  if (claimErr) {
    console.error('vendor claim failed:', claimErr.message);
    return res.status(500).json({ error: 'تعذّر حجز الطلب — لم يتم الشراء' });
  }
  if (!claimed || claimed.length === 0) {
    return res.status(409).json({
      error: 'الطلب محجوز أو مُسلَّم بالفعل — لم يتم الشراء. راجع حالته قبل أي محاولة تانية.',
    });
  }

  // Hand the claim back, so a vendor that refused before charging can be
  // retried. Only ever called where nothing was bought.
  const releaseClaim = async () => {
    await supabase.from('web_orders')
      .update({ vendor_order_id: null }).eq('id', order.id).eq('vendor_order_id', claimTag);
  };

  let bought = null;
  try {
    // The same external id the payment callback would have used for this order,
    // so a vendor that honours idempotency replays rather than re-charges.
    // 10s per attempt, not the 30s default.
    //
    // This function's whole budget is 30s. A vendor call left on the default
    // could consume all of it, and the process would be killed BEFORE the line
    // that releases the claim ever runs — locking the order permanently. And
    // the retry path needs two calls plus a pause: at 30s each that is 62s,
    // which cannot finish here at all.
    //
    // 10 + 2 + 10 = 22s, leaving room for the claim, the save and the email.
    // The payment callback passes nothing and keeps the 30s default, so its
    // behaviour is untouched.
    bought = await purchaseWithIdempotentRetry(p.vendor_code, p.vendor_product_id, qty, orderNumber, 10000);
  } catch (e) {
    console.error('vendor purchase failed:', e.message);
    await releaseClaim();
    return res.status(502).json({ error: `الفيندور رفض الطلب: ${String(e.message).slice(0, 140)}` });
  }

  const codes = Array.isArray(bought?.codes) ? bought.codes.filter(Boolean) : [];

  // The vendor took the order but fulfils it by hand.
  //
  // This is a SUCCESS, not a failure — the money is spent and the vendor owes
  // the goods. Treating it as an error is how the same order gets bought twice.
  // Handled exactly as the payment callback handles it.
  if (bought?.manual) {
    await supabase
      .from('web_orders')
      .update({
        payment_status: 'paid',
        fulfilment_status: 'manual_pending',
        vendor_order_id: bought.vendorOrderId || claimTag,
        error_note: 'ordered from vendor by admin — vendor fulfils manually',
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);

    try {
      await emailManualPending({
        to: order.customer_email,
        orderNumber,
        productName: p.name || 'ProSkill',
      });
    } catch (e) {
      console.error('manual-pending email failed:', e.message);
    }
    await safelyNotify(`⏳ طلب من الفيندور قيد التنفيذ اليدوي\n🧾 ${orderNumber}\n📦 ${p.name || ''}`);

    return res.status(200).json({ ok: true, manual: true, delivered: 0, requested: qty, emailed: true });
  }

  if (codes.length === 0) {
    // Nothing came back and it was not a manual order. Whether the vendor
    // charged is unknown, so the claim STAYS — releasing it would invite a
    // second purchase for an order that may already be paid for. Manual
    // delivery still works and is the way out.
    await safelyNotify(
      `⚠️ الفيندور لم يرجّع أي بيانات\n🧾 ${orderNumber}\n\nراجع لوحة الفيندور قبل أي شراء تاني — الطلب محجوز.`
    );
    return res.status(502).json({
      error: 'الفيندور لم يرجّع أي بيانات. راجع لوحته: لو الطلب اتنفّذ عنده، سلّمه يدوياً. متشتريش تاني.',
    });
  }

  const joined = codes.join('\n\n');
  const partial = codes.length < qty;

  const { error } = await supabase
    .from('web_orders')
    .update({
      payment_status: 'paid',
      fulfilment_status: 'delivered',
      delivered_content: joined,
      fulfilled_at: new Date().toISOString(),
      vendor_order_id: bought?.vendorOrderId || claimTag,
      error_note: partial
        ? `bought from vendor by admin (partial ${codes.length}/${qty})`
        : 'bought from vendor by admin',
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id);

  if (error) {
    // Paid for and not recorded — the one outcome that must never be silent.
    // The codes are returned so they can be pasted through manual delivery
    // instead of being bought a second time.
    console.error('vendor delivery: order update failed:', error.message);
    await safelyNotify(
      `⚠️ اشتريت من الفيندور ولم يُحفظ الطلب\n🧾 ${orderNumber}\n\n${joined}`
    );
    return res.status(500).json({
      error: 'تم الشراء من الفيندور لكن حفظ الطلب فشل. المحتوى أدناه — سلّمه يدوياً ولا تشترِ مرة أخرى.',
      codes: joined,
    });
  }

  await bookCouponForManualSettle(supabase, order);
  remindForwarding({ ...order, delivered_content: joined });
  await pushSaleToAgency(order, order.products);

  let emailed = true;
  try {
    emailed = await emailCodes({
      to: order.customer_email,
      orderNumber,
      productName: p.name || 'ProSkill',
      quantity: codes.length,
      codes: joined,
      product: order.products || null,
    });
  } catch (e) {
    emailed = false;
    console.error('vendor delivery email failed:', e.message);
  }

  res.status(200).json({ ok: true, delivered: codes.length, requested: qty, partial, emailed });
}

async function safelyNotify(text) {
  try { await notifyAdmin(text); } catch (e) { console.error('notify failed:', e.message); }
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=cancel-order
//
// Closes an order that was created but never paid — most often someone taps
// InstaPay, sees the transfer details, and never sends the money. Left alone
// those rows sit in "awaiting transfer" forever and make the dashboard look
// like money is on its way when it isn't.
//
// payment_status stays 'unpaid' (they genuinely never paid) while
// fulfilment_status moves to 'failed'. That combination is what the analytics
// already reads as "abandoned at payment", so a cancelled order lands in the
// honest bucket instead of inflating gateway failures.
//
// Nothing needs releasing: stock is only claimed on payment, and coupons are
// only consumed on payment.
// ----------------------------------------------------------------------------
async function cancelOrderHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { orderNumber } = req.body || {};
  if (!orderNumber) return res.status(400).json({ error: 'رقم الطلب مطلوب' });

  const supabase = supabaseAdmin();
  const { data: order } = await supabase
    .from('web_orders')
    .select('id, payment_status, delivered_content')
    .eq('order_number', orderNumber)
    .maybeSingle();

  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  // Refuse anything money has touched. A paid order needs a refund decision,
  // not a quiet cancel, and a delivered one is already with the customer.
  if (order.payment_status === 'paid') {
    return res.status(400).json({ error: 'الطلب مدفوع — لا يُلغى من هنا' });
  }
  if (order.delivered_content) {
    return res.status(400).json({ error: 'الطلب مُسلَّم بالفعل — لا يُلغى' });
  }

  const { error } = await supabase
    .from('web_orders')
    .update({
      fulfilment_status: 'failed',
      error_note: 'cancelled by admin — no payment received',
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .neq('payment_status', 'paid'); // guard again at write time

  if (error) return res.status(500).json({ error: 'فشل الإلغاء' });
  res.status(200).json({ ok: true });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=reorder-product   { productId, position }
//
// Moves one product to an exact position in the storefront and renumbers the
// rest. Renumbering matters: every product created so far got sort_order 999,
// so dozens of rows share a value and "swap with your neighbour" does nothing.
// Rewriting the whole sequence turns an ambiguous list into a real ranking.
//
// Only rows whose number actually changed are written, so moving one product
// near the top doesn't rewrite the entire catalogue.
// ----------------------------------------------------------------------------
async function reorderProductHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { productId, position } = req.body || {};
  const target = Number(position);
  if (!productId || !Number.isFinite(target) || target < 1) {
    return res.status(400).json({ error: 'بيانات ناقصة أو ترتيب غير صالح' });
  }

  const supabase = supabaseAdmin();

  // Read them in the same order the storefront uses, so the position the admin
  // sees is the position they get.
  const { data: rows, error: readErr } = await supabase
    .from('products')
    .select('id, sort_order, is_featured')
    .eq('is_active', true)
    .eq('store_visible', true)
    .order('is_featured', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (readErr) return res.status(500).json({ error: 'تعذر قراءة الترتيب' });

  const list = rows ?? [];
  const from = list.findIndex((p) => p.id === productId);
  if (from === -1) return res.status(404).json({ error: 'المنتج غير موجود في القائمة الظاهرة' });

  const to = Math.min(Math.max(1, Math.round(target)), list.length) - 1;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);

  // Gaps of 10 leave room to nudge things later without another full rewrite.
  const writes = [];
  list.forEach((p, i) => {
    const next = (i + 1) * 10;
    if (p.sort_order !== next) {
      writes.push(supabase.from('products').update({ sort_order: next }).eq('id', p.id));
    }
  });

  const results = await Promise.allSettled(writes);
  const failed = results.filter((r) => r.status === 'rejected' || r.value?.error).length;
  if (failed) {
    console.error('reorder: %d of %d updates failed', failed, writes.length);
    return res.status(500).json({ error: `فشل تحديث ${failed} من ${writes.length}` });
  }

  res.status(200).json({ ok: true, position: to + 1, total: list.length, updated: writes.length });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=delete-product   { productId }
//
// Removes a product for good. web_orders.product_id is a foreign key, so a
// product that has ever been ordered CANNOT be deleted — the database would
// refuse, and rightly: deleting it would erase what those customers bought
// from your own order history and from every revenue figure built on it.
//
// For those, hiding is the correct action, and the message says so instead of
// surfacing a raw constraint error.
// ----------------------------------------------------------------------------
async function deleteProductHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { productId } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'المنتج مطلوب' });

  const supabase = supabaseAdmin();

  const { data: product } = await supabase
    .from('products').select('id, name').eq('id', productId).maybeSingle();
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });

  const { count: orderCount } = await supabase
    .from('web_orders')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', productId);

  if ((orderCount ?? 0) > 0) {
    return res.status(409).json({
      error: `لا يمكن حذف "${product.name}" — عليه ${orderCount} طلب. `
           + 'الحذف كان سيمسح هذه الطلبات من سجلك وأرباحك. أخفِه من المتجر بدلاً من ذلك.',
    });
  }

  // A coupon can be restricted to one product (coupon_product.sql). If that
  // link isn't released first the delete either fails on the constraint, or —
  // worse, where no constraint exists — leaves a live coupon pointing at a
  // product that no longer exists. Freeing it turns that coupon back into a
  // store-wide one, which is the safe reading of "its product is gone".
  // The table may not have the column at all; that's fine, nothing to release.
  try {
    await supabase.from('coupons').update({ product_id: null }).eq('product_id', productId);
  } catch (e) {
    console.error('delete product: coupon unlink skipped:', e.message);
  }

  // Stock rows point at the product too; clear them first or the delete fails.
  const { error: stockErr } = await supabase
    .from('stock_items').delete().eq('product_id', productId);
  if (stockErr) {
    console.error('delete product: stock cleanup failed:', stockErr.message);
    return res.status(500).json({ error: 'تعذر حذف مخزون المنتج' });
  }

  const { error } = await supabase.from('products').delete().eq('id', productId);
  if (error) {
    console.error('delete product failed:', error.message);
    return res.status(500).json({ error: `تعذر الحذف: ${error.message}` });
  }

  res.status(200).json({ ok: true, name: product.name });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=delete-stock   { itemId }
//
// Removes one code from inventory — the broken one, the duplicate, the one a
// supplier says is dead. Only an AVAILABLE code can go: a sold row is the
// record of what a specific customer received, and deleting it would erase the
// evidence behind a support claim or a warranty replacement.
// ----------------------------------------------------------------------------
async function deleteStockHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const supabase = supabaseAdmin();
  const { data: item } = await supabase
    .from('stock_items').select('id, status').eq('id', itemId).maybeSingle();

  if (!item) return res.status(404).json({ error: 'الكود غير موجود' });
  if (item.status !== 'available') {
    return res.status(409).json({
      error: 'هذا الكود مُسلَّم بالفعل لعميل — حذفه يمحو سجل ما استلمه. لا يمكن حذفه.',
    });
  }

  const { error } = await supabase.from('stock_items').delete().eq('id', itemId);
  if (error) return res.status(500).json({ error: 'فشل الحذف' });
  res.status(200).json({ ok: true });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=reveal-stock   { itemId }
//
// Returns ONE decrypted code, on demand. Kept separate from the listing so the
// full credentials are never sitting in the page by default — you ask for the
// specific one you need, when you need it.
// ----------------------------------------------------------------------------
async function revealStockHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const supabase = supabaseAdmin();
  const { data: item } = await supabase
    .from('stock_items').select('content_encrypted').eq('id', itemId).maybeSingle();
  if (!item) return res.status(404).json({ error: 'الكود غير موجود' });

  try {
    return res.status(200).json({ ok: true, content: decryptStock(item.content_encrypted) });
  } catch (e) {
    console.error('reveal-stock decrypt failed:', e.message);
    return res.status(500).json({
      error: 'تعذّر فك تشفير هذا الكود — غالباً مُشفّر بمفتاح قديم. احذفه وأضفه من جديد.',
    });
  }
}

// ----------------------------------------------------------------------------
// GET /api/admin?action=inventory
//
// One view of every product that carries stock. The per-product panel answers
// "what's in this product?" — this answers the question that actually costs
// money: "which products are about to run out, and which have codes that can
// never be delivered?" Without it you only find out when an order fails.
//
// Counts come from the stock table in a single pass rather than a query per
// product, so this stays fast as the catalogue grows.
// ----------------------------------------------------------------------------
async function inventoryHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  // Only our own instant products hold stock. Vendor products are fetched on
  // demand from the supplier, so they have nothing to run out of here.
  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('id, name, emoji, price_usd, is_active, store_visible, source, delivery_speed')
    .neq('source', 'vendor')
    .eq('delivery_speed', 'instant')
    .order('name', { ascending: true });

  if (pErr) return res.status(500).json({ error: 'query failed' });

  const list = products ?? [];
  if (list.length === 0) return res.status(200).json({ items: [] });

  const ids = list.map((p) => p.id);

  // Available rows only — sold rows are history and can be large.
  //
  // Paged deliberately: PostgREST caps a single response, and a plain select
  // would silently stop at the cap. Counts built from a truncated read would
  // under-report stock — a product with codes would show as out, and you'd buy
  // inventory you already have. The ceiling guards the function; past it the
  // figures are marked approximate rather than quietly wrong.
  const PAGE = 1000;
  const MAX_PAGES = 12; // 12k available codes
  const stock = [];
  let stockApprox = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: chunk, error: sErr } = await supabase
      .from('stock_items')
      .select('product_id, content_encrypted, status')
      .in('product_id', ids)
      .eq('status', 'available')
      .order('product_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (sErr) break;
    if (!chunk || chunk.length === 0) break;
    stock.push(...chunk);
    if (chunk.length < PAGE) break;
    if (page === MAX_PAGES - 1) stockApprox = true;
  }

  const avail = new Map();
  const broken = new Map();
  for (const row of stock ?? []) {
    avail.set(row.product_id, (avail.get(row.product_id) ?? 0) + 1);
    // A row encrypted under a previous key can never be delivered. It counts
    // as stock everywhere else, which is exactly why it's worth surfacing:
    // the product looks in stock right up until an order fails on it.
    try {
      decryptStock(row.content_encrypted);
    } catch {
      broken.set(row.product_id, (broken.get(row.product_id) ?? 0) + 1);
    }
  }

  const items = list.map((p) => {
    const available = avail.get(p.id) ?? 0;
    const bad = broken.get(p.id) ?? 0;
    return {
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      price_usd: p.price_usd,
      hidden: !(p.is_active && p.store_visible),
      available,
      broken: bad,
      // What can actually be delivered right now.
      usable: available - bad,
    };
  });

  // Worst first: nothing deliverable, then lowest stock. A list sorted by name
  // buries the one product that needs attention today.
  items.sort((a, b) => a.usable - b.usable || b.broken - a.broken);

  res.status(200).json({ items, approx: stockApprox });
}

// ----------------------------------------------------------------------------
// GET  /api/admin?action=cv-price   → current price
// POST /api/admin?action=cv-price   → set it { priceUsd }
//
// The instant CV service price. Kept in store_settings rather than an env var
// so it can be changed from the dashboard in seconds — trying a price, running
// an offer, or reacting to cost shouldn't need a redeploy.
// ----------------------------------------------------------------------------
async function cvPriceHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'POST') {
    const which = 'cv_price_usd';
    const v = Number(req.body?.priceUsd);

    // Same bounds the service enforces when reading: zero would give the work
    // away, and an absurd figure would silently stop every sale.
    if (!Number.isFinite(v) || v <= 0 || v >= 500) {
      return res.status(400).json({ error: 'السعر يجب أن يكون بين 0 و500 دولار' });
    }
    const { error } = await supabase
      .from('store_settings')
      .upsert({ key: which, value: String(v) }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: 'فشل الحفظ' });
    return res.status(200).json({ ok: true, priceUsd: v });
  }

  const { data } = await supabase
    .from('store_settings').select('key, value').eq('key', 'cv_price_usd');

  const base = Number((data ?? [])[0]?.value);

  return res.status(200).json({
    priceUsd: Number.isFinite(base) && base > 0 ? base : Number(process.env.CV_PRICE_USD || 4),
    isDefault: !(Number.isFinite(base) && base > 0),
  });
}

// ----------------------------------------------------------------------------
// GET /api/admin?action=cv-orders
//
// The instant CV service lives in its own table, so none of the product views
// show it. Without this the orders — including paid ones that failed — are
// invisible in the dashboard.
//
// Deliberately does NOT return source_text or result_cv: those are the
// customer's full employment history, and a list view has no business shipping
// them to a browser. Enough to spot a problem and act on it, no more.
// ----------------------------------------------------------------------------
async function cvOrdersHandler(req, res) {
  // Version marker. "The feature isn't showing" has meant a stale deploy more
  // than once, and guessing costs more than a string does.
  const BUILD = 'v168';
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from('ps_cv_orders')
    .select('order_number, customer_email, customer_phone, target_role, with_photo, output_lang, customer_notes, '
          + 'price_usd, payment_status, status, error_note, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(60);

  if (error) return res.status(500).json({ error: 'query failed' });

  const rows = data ?? [];
  const paid = rows.filter((r) => r.payment_status === 'paid');
  return res.status(200).json({
    build: BUILD,
    orders: rows,
    stats: {
      total: rows.length,
      paid: paid.length,
      failed: paid.filter((r) => r.status === 'failed').length,
      stuck: paid.filter((r) => r.status === 'pending' || r.status === 'processing').length,
      revenue: Number(paid.reduce((n, r) => n + (Number(r.price_usd) || 0), 0).toFixed(2)),
    },
  });
}

// ----------------------------------------------------------------------------
// GET  /api/admin?action=mailboxes    → list (never returns secrets)
// POST /api/admin?action=mailboxes    → add/update { email, appPassword, provider }
// POST ?action=mailboxes&remove=1     → delete { email }
//
// Credentials for the mailboxes attached to accounts we sell, so a buyer can
// read their own verification codes instead of waiting on a person. The secret
// is encrypted with the same key as stock and is never sent back out — the
// list shows only whether a mailbox is configured and whether it last worked.
// ----------------------------------------------------------------------------
// Checking a mailbox is a real IMAP login. It's admin-only and manual, so this
// only has to stop a stuck finger from getting the shared mailbox throttled for
// the customers who actually need it.
const MB_CHECK = { count: 0, resetAt: 0 };
function mailboxCheckLimited() {
  const now = Date.now();
  if (now > MB_CHECK.resetAt) {
    MB_CHECK.count = 1;
    MB_CHECK.resetAt = now + 5 * 60 * 1000;
    return false;
  }
  MB_CHECK.count += 1;
  return MB_CHECK.count > 20;
}

async function mailboxesHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  if (req.method === 'POST') {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(email)) {
      return res.status(400).json({ error: 'بريد غير صحيح' });
    }

    if (req.body?.remove) {
      const { error } = await supabase.from('ps_mailboxes').delete().eq('email', email);
      if (error) return res.status(500).json({ error: 'فشل الحذف' });
      return res.status(200).json({ ok: true });
    }

    // "Did anything arrive for this account?" — answered live, at the moment
    // it's asked. A stored flag would need a column and would only ever be as
    // fresh as the last time a customer happened to press their button.
    if (req.body?.check) {
      if (mailboxCheckLimited()) {
        return res.status(429).json({ error: 'فحص كتير في وقت قصير — استنى شوية' });
      }

      const CHK_COLS = 'email, secret_enc, provider';
      let { data: box, error: bErr } = await supabase
        .from('ps_mailboxes').select(`${CHK_COLS}, imap_host, imap_user, match_extra`)
        .eq('email', email).maybeSingle();
      if (bErr) {
        ({ data: box } = await supabase
          .from('ps_mailboxes').select(CHK_COLS).eq('email', email).maybeSingle());
      }
      if (!box) return res.status(404).json({ error: 'الصندوق غير موجود' });

      try {
        const message = await readMailbox({
          email: box.email,
          password: decryptStock(box.secret_enc),
          provider: box.provider,
          host: box.imap_host,
          imapUser: box.imap_user,
          matchExtra: box.match_extra,
        });

        await supabase.from('ps_mailboxes')
          .update({ last_read_at: new Date().toISOString(), error_note: null })
          .eq('email', email);

        // Sender and time only. NOT the subject, the body or the code — the
        // question asked was whether mail arrived, not what it says, and an
        // answer that reads the customer's code back to the dashboard is a
        // different feature with different consequences.
        return res.status(200).json({
          found: !!message,
          from: message?.from || null,
          date: message?.date || null,
          // Worth surfacing: mail still landing in junk means the whitelist
          // isn't holding, and it's the only warning that says so.
          inJunk: !!message?.inJunk,
        });
      } catch (e) {
        await supabase.from('ps_mailboxes')
          .update({ error_note: String(e.message).slice(0, 200) })
          .eq('email', email);
        return res.status(200).json({ found: false, failed: String(e.message).slice(0, 140) });
      }
    }

    const secret = String(req.body?.appPassword || '').trim();
    if (secret.length < 8) {
      return res.status(400).json({ error: 'كلمة مرور التطبيق قصيرة جداً' });
    }
    if (!process.env.ENCRYPTION_KEY) {
      return res.status(500).json({ error: 'مفتاح التشفير غير مضبوط' });
    }

    // Rejected loudly rather than silently ignored: a value that can't work is
    // worse than none, because it looks configured.
    const matchExtra = String(req.body?.matchExtra || '').trim().toLowerCase();
    if (matchExtra) {
      const imapUser = String(req.body?.imapUser || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(matchExtra)) {
        return res.status(400).json({ error: 'عنوان التحويل لازم يكون بريد كامل' });
      }
      if (matchExtra === imapUser || matchExtra === email) {
        return res.status(400).json({
          error: 'عنوان التحويل لازم يكون عنوان خاص بالحساب ده — مش الصندوق المشترك',
        });
      }
    }

    // The same hole, closed at the source: a mailbox that is somebody's shared
    // login must not also exist as a sold account, and vice versa. Either
    // arrangement lets one order open a box holding many customers' mail.
    {
      const imapUser = String(req.body?.imapUser || '').trim().toLowerCase();
      const { data: clash, error: cErr } = await supabase
        .from('ps_mailboxes').select('email, imap_user');
      if (!cErr) {
        const rows = (clash ?? []).filter((r) => r.email !== email);
        if (rows.some((r) => String(r.imap_user || '').toLowerCase() === email)) {
          return res.status(400).json({
            error: 'العنوان ده مستخدم كصندوق مشترك لحسابات تانية — مينفعش يتضاف كحساب',
          });
        }
        if (imapUser && rows.some((r) => String(r.email || '').toLowerCase() === imapUser)) {
          return res.status(400).json({
            error: 'الصندوق المشترك ده متسجّل كحساب مبيوع — امسحه الأول',
          });
        }
      }
    }

    const row = {
      email,
      secret_enc: encryptStock(secret),
      provider: String(req.body?.provider || 'outlook'),
      is_active: true,
      error_note: null,
      imap_host: String(req.body?.imapHost || '').trim() || null,
      imap_user: String(req.body?.imapUser || '').trim().toLowerCase() || null,
      match_extra: matchExtra || null,
    };

    let { error } = await supabase.from('ps_mailboxes').upsert(row, { onConflict: 'email' });

    // Deployed before store_mailboxes_imap.sql: save the mailbox without the
    // custom server rather than reject it. It will read from the provider
    // default, which is what it did before these columns existed.
    if (error && /imap_host|imap_user|match_extra/i.test(error.message || '')) {
      console.warn('mailbox: imap columns missing — run store_mailboxes_imap.sql');
      delete row.imap_host; delete row.imap_user; delete row.match_extra;
      ({ error } = await supabase.from('ps_mailboxes').upsert(row, { onConflict: 'email' }));
    }

    if (error) {
      console.error('mailbox save failed:', error.message);
      return res.status(500).json({ error: 'فشل الحفظ' });
    }
    return res.status(200).json({ ok: true });
  }

  const LIST_COLS = 'email, provider, is_active, last_read_at, error_note, created_at';
  let { data, error } = await supabase
    .from('ps_mailboxes')
    .select(`${LIST_COLS}, imap_host, imap_user, match_extra`)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    ({ data, error } = await supabase
      .from('ps_mailboxes').select(LIST_COLS)
      .order('created_at', { ascending: false })
      .limit(200));
  }

  if (error) return res.status(500).json({ error: 'query failed' });
  return res.status(200).json({ mailboxes: data ?? [] });
}

// ----------------------------------------------------------------------------
// POST /api/admin?action=bulk-seed   → ONE-TIME initial catalogue import
//
// Idempotent: a product whose name already exists is skipped, so running twice
// is safe. Products are created HIDDEN at a $1 placeholder price — you set the
// real price and reveal each from the dashboard, so nothing can go live wrong.
// ----------------------------------------------------------------------------
const SEED_PRODUCTS = [
  {
    "name": "Adobe Creative Cloud Pro",
    "emoji": "🎨",
    "cat": "Business & Office",
    "speed": "manual_1_3h",
    "dtype": "account",
    "desc": "Adobe Creative Cloud Pro هو الحل المتكامل للمصممين، صُنّاع المحتوى، المونتيرز، والمسوقين اللي محتاجين أقوى برامج التصميم والمونتاج في مكان واحد. الاشتراك يتيح لك استخدام جميع برامج أدوبي الأصلية مثل Photoshop و Illustrator و Premiere Pro و After Effects، بالإضافة إلى مزايا الذكاء الاصطناعي (Adobe Firefly).\n\n✨ ما ستحصل عليه:\n• وصول كامل لكل برامج Adobe\n• يعمل على جهازين في نفس الوقت\n• 4000 كريديت Adobe Firefly شهرياً\n• تحديثات مستمرة\n• استخدام احترافي بدون قيود\n\n📦 20 برنامج: Photoshop · Illustrator · Premiere Pro · After Effects · Lightroom · InDesign · Audition · XD وغيرهم\n\n⏱️ يدوي خلال 1–3 ساعات · رسمي وآمن 100%"
  },
  {
    "name": "Canva Pro",
    "emoji": "🖌️",
    "cat": "Design & Creative",
    "speed": "manual_1_3h",
    "dtype": "account",
    "desc": "Canva Pro هو الحل المثالي لصُنّاع المحتوى، المسوّقين، أصحاب البيزنس، والطلاب اللي محتاجين تصاميم احترافية بسرعة وسهولة بدون خبرة تصميم.\n\n✨ ما ستحصل عليه:\n• آلاف القوالب الجاهزة الاحترافية\n• إزالة الخلفية من الصور بنقرة واحدة\n• Brand Kit (ألوان – خطوط – لوجو)\n• عناصر وصور وفيديوهات مدفوعة\n• تصدير بجودة عالية بدون علامة مائية\n• مساحة تخزين 100GB\n\n⏱️ يدوي خلال 1–3 ساعات · رسمي وآمن 100%"
  },
  {
    "name": "LinkedIn Premium Business",
    "emoji": "💼",
    "cat": "Business & Office",
    "speed": "manual_1_3h",
    "dtype": "invite",
    "desc": "اشتراك LinkedIn Premium Business الرسمي لتوسيع شبكة علاقاتك، تحليل المنافسين، والتواصل مع صُنّاع القرار والشركات.\n\n✨ ما ستحصل عليه:\n• 15 رسالة InMail شهرياً\n• معرفة من زار ملفك الشخصي\n• Salary insights — بيانات الرواتب\n• بحث غير محدود عن الأشخاص والشركات\n• دورات LinkedIn Learning كاملة\n• شارة Premium على ملفك\n\n🔗 خطوات التفعيل:\n1. التفعيل سريع خلال 12 ساعة\n2. يتم التفعيل على حسابك الشخصي مباشرة\n3. آمن ورسمي 100%\n4. يتم إرسال لينك التفعيل على الواتساب أو الإيميل\n\nالحساب حسابك أنت — لا تشارك بياناتك مع أحد."
  },
  {
    "name": "LinkedIn Premium Career",
    "emoji": "🎯",
    "cat": "Business & Office",
    "speed": "manual_1_3h",
    "dtype": "invite",
    "desc": "اشتراك LinkedIn Premium Career الرسمي للباحثين عن عمل ومن يريد تطوير مساره المهني.\n\n✨ ما ستحصل عليه:\n• 5 رسائل InMail شهرياً للتواصل مع مسؤولي التوظيف\n• رؤية كل من زار ملفك خلال آخر 365 يوم\n• Top Applicant — ترتيبك بين المتقدمين\n• رؤية رواتب الوظائف ومعلومات الشركات\n• دورات LinkedIn Learning كاملة\n• شارة Premium على ملفك\n\n🔗 خطوات التفعيل:\n1. التفعيل سريع خلال 12 ساعة\n2. يتم التفعيل على حسابك الشخصي مباشرة\n3. آمن ورسمي 100%\n4. يتم إرسال لينك التفعيل على الواتساب أو الإيميل\n\nالحساب حسابك أنت — لا تشارك بياناتك مع أحد."
  },
  {
    "name": "Kaspersky Premium",
    "emoji": "🛡️",
    "cat": "Business & Office",
    "speed": "manual_1_3h",
    "dtype": "code",
    "desc": "Kaspersky Premium هو الحل الأقوى للحماية الشاملة من الفيروسات، الهجمات الإلكترونية، وبرامج التجسس. يجمع بين مضاد فيروسات متقدم، حماية للخصوصية، VPN آمن، وأدوات تحسين الأداء.\n\n✨ ما ستحصل عليه:\n• مضاد فيروسات متقدم وحماية فورية\n• VPN آمن للتصفح المحمي\n• حماية الخصوصية والبيانات\n• أدوات تحسين أداء الجهاز\n• حماية ضد الهجمات وبرامج الفدية\n\n⏱️ خطوات التفعيل:\n1. تفعيل سريع\n2. تسليم كود التفعيل أو التفعيل على حسابك\n3. اشتراك رسمي وآمن 100%"
  },
  {
    "name": "Internet Download Manager (IDM)",
    "emoji": "⚡",
    "cat": "Business & Office",
    "speed": "instant",
    "dtype": "code",
    "desc": "Internet Download Manager (IDM) هو أشهر وأقوى برنامج لتحميل الملفات من الإنترنت، لزيادة سرعة التحميل وتنظيم الملفات مع دعم الاستكمال بعد انقطاع الإنترنت.\n\n✨ ما ستحصل عليه:\n• تسريع التحميل حتى 5 أضعاف\n• استكمال التحميل بعد انقطاع الإنترنت\n• تحميل الفيديوهات من أي موقع\n• تكامل مع كل المتصفحات (Chrome, Firefox, Edge)\n• تنظيم الملفات تلقائياً\n\n⏱️ خطوات التفعيل:\n1. تسليم فوري\n2. ترخيص تفعيل مدى الحياة (Lifetime License)\n3. آمن ومضمون\n4. يتم إرسال سيريال التفعيل على الواتساب أو الإيميل"
  },
  {
    "name": "Autodesk Software",
    "emoji": "📐",
    "cat": "Business & Office",
    "speed": "manual_1_3h",
    "dtype": "account",
    "desc": "تراخيص أوتوديسك الأصلية توفر أقوى برامج التصميم الهندسي والإنشائي عالمياً في مجالات الهندسة، المعمار، التصميم الداخلي، الميكانيكا، والـ 3D Modeling. تراخيص أصلية 100% بأسعار مميزة.\n\n✨ ما ستحصل عليه:\n• تفعيل رسمي وآمن\n• مناسب للاستخدام المهني والدراسي\n• دعم فني في حالة وجود أي مشكلة\n• تسليم سريع بعد الطلب\n\n📦 البرامج: AutoCAD · Revit · 3ds Max · Fusion 360 · Maya وغيرهم\n\n⏱️ التفعيل: أرسل الإيميل الذي تود تفعيل الاشتراك به"
  },
  {
    "name": "Microsoft Office 365 Family",
    "emoji": "📊",
    "cat": "Business & Office",
    "speed": "manual_1_3h",
    "dtype": "account",
    "desc": "Microsoft Office 365 Family هو الحل المثالي للعائلات، الطلاب، وأصحاب الاستخدام المتعدد اللي محتاجين برامج أوفيس أصلية على أكتر من جهاز. أحدث إصدارات Word و Excel و PowerPoint و Outlook مع مساحة OneDrive كبيرة.\n\n✨ ما ستحصل عليه:\n• استخدام حتى 5 أشخاص\n• تثبيت على الكمبيوتر والموبايل\n• مساحة تخزين OneDrive لكل مستخدم\n• تحديثات تلقائية\n• اشتراك رسمي من Microsoft\n\n📦 البرامج: Word · Excel · PowerPoint · Outlook · OneNote · Access · Publisher\n\n⏱️ خطوات التفعيل:\n1. تفعيل سريع\n2. يتم التفعيل على إيميل Microsoft الخاص بك\n3. آمن ورسمي 100%\n4. إرسال الإيميل للتفعيل"
  },
  {
    "name": "DataCamp",
    "emoji": "📈",
    "cat": "Development Tools",
    "speed": "manual_1_3h",
    "dtype": "account",
    "desc": "DataCamp منصة تعليمية متخصصة في تحليل البيانات وعلوم البيانات والذكاء الاصطناعي، للمبتدئين والمحترفين. مسارات تعلم عملية، تمارين تفاعلية، ومشاريع حقيقية في Python و SQL و R و Power BI و Machine Learning، مع شهادات رسمية.\n\n✨ ما ستحصل عليه:\n• فتح جميع كورسات DataCamp\n• مسارات تعلم كاملة (Career Tracks)\n• تمارين تفاعلية ومشاريع عملية\n• شهادات رسمية قابلة للمشاركة\n• محتوى محدث حسب متطلبات السوق\n\n📚 المجالات: Python · SQL · Data Science · Machine Learning · AI · Power BI\n\n⏱️ خطوات التفعيل:\n1. تفعيل سريع\n2. يتم التفعيل على حسابك\n3. آمن ومضمون\n4. إرسال الإيميل للتفعيل خلال 24 ساعة"
  }
];

async function bulkSeedHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabase = supabaseAdmin();

  // Ensure categories, remember ids by name
  const wantedCats = [...new Set(SEED_PRODUCTS.map((p) => p.cat))];
  const catId = {};
  const catWarnings = [];
  for (const name of wantedCats) {
    try {
      const { data: rows } = await supabase
        .from('categories').select('id').eq('name', name).limit(1);
      if (rows && rows.length) { catId[name] = rows[0].id; continue; }

      const { data: created, error } = await supabase
        .from('categories')
        .insert({ name, emoji: '\u{1F4C1}', is_active: true, sort_order: 1 })
        .select('id').single();
      // If categories can't be created, don't abort — import products WITHOUT a
      // category (you can assign them later). Losing categorisation beats
      // importing nothing.
      if (error) { catWarnings.push(`${name}: ${error.message}`); catId[name] = null; }
      else catId[name] = created.id;
    } catch (e) {
      catWarnings.push(`${name}: ${e.message}`);
      catId[name] = null;
    }
  }

  const results = [];
  for (const p of SEED_PRODUCTS) {
    // Check for an existing row WITHOUT maybeSingle() — it throws on duplicates,
    // which the old code mistook for "already exists" and silently skipped.
    const { data: existing, error: checkErr } = await supabase
      .from('products').select('id').eq('name', p.name).limit(1);

    if (checkErr) {
      results.push({ name: p.name, status: `ERROR (check): ${checkErr.message}` });
      continue;
    }
    if (existing && existing.length > 0) {
      results.push({ name: p.name, status: 'skipped' });
      continue;
    }

    const row = {
      name: p.name,
      price_usd: 1,
      emoji: p.emoji,
      store_description: p.desc.slice(0, 2000),
      description: p.desc.slice(0, 2000),
      delivery_speed: p.speed,
      delivery_type: p.dtype,
      warranty_days: 0,
      category_id: catId[p.cat],
      source: 'own',
      is_active: false,
      store_visible: false,
      is_featured: false,
      sort_order: 999,
    };
    const { error } = await supabase.from('products').insert(row);
    results.push({ name: p.name, status: error ? `ERROR: ${error.message}` : 'created' });
  }

  const created = results.filter((r) => r.status === 'created').length;
  res.status(200).json({
    ok: true,
    created,
    total: SEED_PRODUCTS.length,
    categoryWarnings: catWarnings,
    results,
  });
}

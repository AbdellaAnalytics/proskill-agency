// ============================================================================
// POST /api/checkout
// Creates an unpaid order (price read from the DB, NEVER from the browser)
// and returns an EasyKash payment URL.
// ============================================================================

import { supabaseAdmin, orderNumber, storeOrigin, effectivePrice, isOnSale } from './_lib/server.js';
import { INSTAPAY } from './_lib/instapay.js';
import { requestGeo } from './_lib/geo.js';
import { getRates } from './_lib/fx.js';
import { emailOrderPlaced, notifyAdmin } from './_lib/notify.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// EasyKash payment options (official Pay API docs): 4 = Mobile Wallet.
// Our checkout offers two gateway groups, expressed against this one list:
//   • wallet → paymentOptions: [4]          (wallets only)
//   • card   → paymentOptionsExcluded: [4]  (everything else — cards, Meeza,
//     Apple Pay, Fawry, Aman, and every instalment provider)
// Using an exclusion for the card group means any option EasyKash adds later,
// or that you enable on the account, appears automatically with no code change.
// Options only show if they're enabled on the business account.
const WALLET_OPTIONS = [4];

// Manual InstaPay fallback — used when the customer chooses to pay by transfer
// (also a lifeline when the EasyKash gateway is down). Lives in _lib because
// the order page shows the same details.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { productId, quantity, email, name, phone, coupon, method, currency, payGroup } = req.body || {};
  const isManual = String(method || '').toLowerCase() === 'instapay';
  const chosenCurrency = ['EGP', 'SAR', 'USD'].includes(String(currency || '').toUpperCase())
    ? String(currency).toUpperCase()
    : 'EGP'; // default to EGP; unknown values never reach the gateway

  if (!productId || !EMAIL_RE.test(String(email || ''))) {
    res.status(400).json({ error: 'بيانات غير صحيحة' });
    return;
  }
  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));

  const supabase = supabaseAdmin();

  // If the buyer is signed in, attach the order to their account.
  // The token is verified server-side; a forged id would simply fail here.
  let authUserId = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const { data: au } = await supabase.auth.getUser(authHeader.slice(7).trim());
    if (au?.user) authUserId = au.user.id;
  }

  // SECURITY: price and availability come from the database only.
  // Optimistic, with a fallback: before store_sale_price.sql the column does not
  // exist and the select fails — which would stop every sale in the shop, not
  // just the discounted ones. Without the column there are no offers anyway, so
  // the list price IS the effective price.
  const PROD_COLS = 'id, name, price_usd, cost_usd, is_active, store_visible, delivery_speed, source';
  let { data: product, error } = await supabase
    .from('products')
    .select(`${PROD_COLS}, sale_price_usd`)
    .eq('id', productId)
    .maybeSingle();
  if (error) {
    ({ data: product, error } = await supabase
      .from('products').select(PROD_COLS).eq('id', productId).maybeSingle());
  }

  if (error || !product || !product.is_active || !product.store_visible) {
    res.status(404).json({ error: 'المنتج غير متاح' });
    return;
  }

  // Never take money for an instant own-stock product we cannot deliver.
  // The catalog is cached for 60s, so a product can sell out between the
  // customer loading the page and pressing Pay. This is the last line of defence.
  if (product.source !== 'vendor' && product.delivery_speed === 'instant') {
    const { count } = await supabase
      .from('stock_items')
      .select('*', { count: 'exact', head: true })
      .eq('product_id', product.id)
      .eq('status', 'available');

    if (!count || count < qty) {
      res.status(409).json({
        error: count
          ? `المتوفر ${count} فقط من هذا المنتج. قلّل الكمية.`
          : 'نفذت الكمية من هذا المنتج.',
      });
      return;
    }
  }

  const unit = effectivePrice(product);
  const subtotal = Number((unit * qty).toFixed(2));

  // AUTHORITATIVE discount: recomputed here from the database. Whatever the
  // browser claims the discount is, we ignore it.
  let discount = 0;
  let couponCode = null;

  // A coupon does not stack on an offer. Deliberate: the offer price is already
  // the discount, and letting a percentage run on top of it is how a product
  // ends up sold below what it cost to buy — quietly, one order at a time.
  //
  // Silent, like an invalid coupon: the cart preview says so before payment, so
  // failing loudly here would only be a second refusal at the worst moment.
  if (coupon && !isOnSale(product)) {
    const { data: cd, error: cErr } = await supabase.rpc('validate_coupon', {
      p_code: String(coupon).trim(),
      p_subtotal: subtotal,
      p_email: String(email).trim().toLowerCase(),
      // Required for product-restricted coupons. Without it the function
      // rejects them, which is the safe direction.
      p_product_id: product.id,
    });
    const r = Array.isArray(cd) ? cd[0] : cd;
    if (cErr) {
      console.error('coupon check failed:', cErr.message);
    } else if (r?.valid) {
      discount = Number(r.discount);
      couponCode = String(coupon).trim().toUpperCase();
    }
    // An invalid coupon is silently ignored — the customer simply pays full
    // price rather than seeing a confusing failure at the payment step.
  }

  const total = Number((subtotal - discount).toFixed(2));

  if (total < 1) {
    res.status(400).json({ error: 'الحد الأدنى للطلب هو 1 دولار.' });
    return;
  }

  const num = orderNumber();

  const row = {
    order_number: num,
    product_id: product.id,
    quantity: qty,
    unit_price_usd: unit,
    subtotal_usd: subtotal,
    // Cost is snapshotted here, not read from the product later: vendor prices
    // change, and last month's profit must not move when today's cost does.
    cost_usd: Number.isFinite(Number(product.cost_usd)) && Number(product.cost_usd) > 0
      ? Number((Number(product.cost_usd) * qty).toFixed(2))
      : null,
    discount_usd: discount,
    total_usd: total,
    coupon_code: couponCode,
    customer_email: String(email).trim().toLowerCase(),
    customer_name: name ? String(name).slice(0, 120) : null,
    customer_phone: phone ? String(phone).slice(0, 30) : null,
    payment_status: 'unpaid',
    payment_method: isManual ? 'instapay' : 'easykash',
    fulfilment_status: isManual ? 'manual_pending' : 'pending',
    auth_user_id: authUserId,
    // Where the buyer was when they ordered. Read off the request that is
    // already happening — no external lookup, no added latency, no new function.
    ...requestGeo(req),
  };

  let { error: insErr } = await supabase.from('web_orders').insert(row);

  // Deployed before store_geo.sql has been run: the location columns don't
  // exist and Postgres rejects the whole row. Losing a SALE over an analytics
  // field is not a trade worth making — drop the location, keep the order.
  if (insErr && /geo_country|geo_region|geo_city/i.test(insErr.message || '')) {
    console.warn('checkout: geo columns missing — run store_geo.sql');
    delete row.geo_country; delete row.geo_region; delete row.geo_city;
    ({ error: insErr } = await supabase.from('web_orders').insert(row));
  }

  if (insErr) {
    console.error('web_orders insert error:', insErr);
    res.status(500).json({ error: 'تعذر إنشاء الطلب' });
    return;
  }

  // --- Manual InstaPay: skip the gateway, hand back transfer instructions ----
  // The order is now recorded as unpaid + manual_pending; the admin confirms the
  // transfer and delivers from the dashboard. We convert the USD total to EGP
  // with the same effective rate the storefront shows, rounded up to a whole
  // pound so the customer transfers a clean amount.
  if (isManual) {
    let egpAmount = null;
    try {
      const { rates, markup } = await getRates();
      const effective = Number(rates.EGP) * (1 + Number(markup) / 100);
      egpAmount = Math.ceil(total * effective);
    } catch (e) {
      console.error('fx for instapay failed:', e.message);
    }

    // The EasyKash callback never fires for a manual order, so this is the only
    // record the buyer gets. Notifications must never block the order: both
    // calls swallow their own errors.
    const buyerEmail = String(email).trim().toLowerCase();
    await Promise.allSettled([
      emailOrderPlaced({
        to: buyerEmail,
        orderNumber: num,
        productName: product.name,
        quantity: qty,
        egpAmount,
        totalUsd: total,
        instapay: INSTAPAY,
      }),
      notifyAdmin(
        [
          '🟣 <b>طلب InstaPay بانتظار التحويل</b>',
          '',
          `🧾 <code>${num}</code>`,
          `📦 ${product.name} × ${qty}`,
          egpAmount ? `💵 ${egpAmount} ج.م ($${total.toFixed(2)})` : `💵 $${total.toFixed(2)}`,
          `📧 ${buyerEmail}`,
          '',
          'راجع التحويل ثم سلّم الطلب من لوحة التحكم.',
        ].join('\n')
      ),
    ]);

    res.status(200).json({
      orderNumber: num,
      manual: true,
      totalUsd: total,
      egpAmount,
      instapay: INSTAPAY,
    });
    return;
  }

  const origin = storeOrigin(req);

  // --- Currency for EasyKash ------------------------------------------------
  // Prices are stored in USD, but the buyer should pay in the currency they
  // picked on the storefront (EGP / SAR / USD) — the same figure they saw.
  // USD needs no conversion. For EGP/SAR we convert server-side (the trusted
  // source, same rate the storefront shows). If the FX lookup fails, we fall
  // back to charging USD — a slightly different display number is far better
  // than a failed or wrong charge.
  let payAmount = total;
  let payCurrency = 'USD';
  if (chosenCurrency !== 'USD') {
    try {
      const { rates, markup } = await getRates();
      const rate = Number(rates[chosenCurrency]);
      const effective = rate * (1 + Number(markup) / 100);
      if (Number.isFinite(effective) && effective > 0) {
        payAmount = Math.ceil(total * effective);
        payCurrency = chosenCurrency;
      }
    } catch (e) {
      console.error('EasyKash FX conversion failed, charging USD:', e.message);
    }
  }

  // --- Create the EasyKash payment ------------------------------------------
  // EasyKash requires: amount, currency, paymentOptions[], cashExpiry,
  // name, email, mobile, redirectUrl, customerReference.
  // Note (from their docs): the buyer is always charged in EGP — a non-EGP
  // amount is converted at EasyKash's rate at payment time. Sending EGP
  // directly (our default) is therefore the most predictable for buyers.
  const payload = {
    amount: payAmount,
    currency: payCurrency,
    cashExpiry: 24,
    name: (name || 'ProSkill Customer').slice(0, 60),
    email: String(email).trim().toLowerCase(),
    mobile: String(phone || '01000000000').replace(/\D/g, '').slice(-11),
    // Carry the buyer's email through the redirect. localStorage is per-origin,
    // so a customer who starts on one domain and returns on another (or on a
    // different browser) would otherwise be asked to type it again. The value
    // is still verified server-side by /api/order-status — this only saves a step.
    redirectUrl: `${origin}/order/${num}?e=${encodeURIComponent(email.trim().toLowerCase())}`,
    customerReference: num,
  };

  // Narrow the gateway to what the buyer picked on our checkout. Sending
  // neither key lets EasyKash show every option enabled on the account.
  if (payGroup === 'wallet') {
    payload.paymentOptions = WALLET_OPTIONS;
  } else if (payGroup === 'card') {
    payload.paymentOptionsExcluded = WALLET_OPTIONS;
  }

  // With EASYKASH_DEBUG=1 this prints the exact payload we send. It settles
  // the "is the filter being sent, or is the gateway ignoring it?" question
  // without guesswork. No secrets are logged — the API key travels in a header.
  console.log('checkout redirect:', payload.redirectUrl);

  if (process.env.EASYKASH_DEBUG === '1') {
    console.log('easykash payload:', JSON.stringify({
      payGroup: payGroup || null,
      paymentOptions: payload.paymentOptions ?? null,
      paymentOptionsExcluded: payload.paymentOptionsExcluded ?? null,
      amount: payload.amount,
      currency: payload.currency,
    }));
  }

  let payUrl;
  let rawBody = '';
  try {
    const ekRes = await fetch('https://back.easykash.net/api/directpayv1/pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: process.env.EASYKASH_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    rawBody = await ekRes.text();
    let ek = null;
    try {
      ek = JSON.parse(rawBody);
    } catch {
      /* not JSON */
    }

    if (!ekRes.ok) {
      console.error('EasyKash init failed. status=%s body=%s', ekRes.status, rawBody.slice(0, 800));
      throw new Error(`gateway ${ekRes.status}`);
    }

    // Log the full success body once so the exact field names are known.
    console.log('EasyKash OK. body=%s', rawBody.slice(0, 800));

    payUrl = pickPaymentUrl(ek, origin);

    if (!payUrl) {
      console.error('EasyKash: no payment URL found in body=%s', rawBody.slice(0, 800));
      throw new Error('gateway no-url');
    }
  } catch (e) {
    console.error('EasyKash error:', e.message, '| raw:', rawBody.slice(0, 400));
    await supabase
      .from('web_orders')
      .update({ payment_status: 'failed', error_note: `gateway: ${String(e.message).slice(0, 200)}` })
      .eq('order_number', num);

    // Never return raw gateway internals to the browser. If debugging is on,
    // log server-side only — the client gets a clean message either way.
    if (process.env.EASYKASH_DEBUG === '1') {
      console.error('easykash raw response:', rawBody.slice(0, 500));
    }
    // Include only the short reason code (e.g. "gateway 401") — a status number,
    // never the key or the raw body — so the failure is diagnosable from the
    // Network response without exposing anything sensitive.
    res.status(502).json({ error: 'تعذر بدء عملية الدفع. حاول مرة أخرى.', reason: String(e.message).slice(0, 60) });
    return;
  }

  res.status(200).json({ orderNumber: num, paymentUrl: payUrl });
}

/**
 * EasyKash has changed field names across versions. Instead of guessing one,
 * walk the response and pick the first URL that is actually a hosted checkout
 * page (…easykash.net/DirectPayV1/xxxx), ignoring our own redirect URL.
 */
function pickPaymentUrl(ek, origin) {
  if (!ek || typeof ek !== 'object') return null;

  const urls = [];
  (function walk(node, depth) {
    if (depth > 4 || node == null) return;
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node)) urls.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v) => walk(v, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      Object.values(node).forEach((v) => walk(v, depth + 1));
    }
  })(ek, 0);

  const notOurs = urls.filter((u) => !origin || !u.startsWith(origin));

  // 1) Hosted checkout page (what we actually want).
  const hosted = notOurs.find((u) => /easykash\.net\/DirectPay/i.test(u));
  if (hosted) return hosted;

  // 2) Any easykash.net URL that has a path (not the bare homepage).
  const withPath = notOurs.find(
    (u) => /easykash\.net\//i.test(u) && new URL(u).pathname.replace(/\/+$/, '').length > 1
  );
  if (withPath) return withPath;

  // 3) Explicit fields, as a last resort.
  return ek.redirectUrl || ek.paymentUrl || ek.url || ek.data?.redirectUrl || null;
}

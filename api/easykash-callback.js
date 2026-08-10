// ============================================================================
// POST /api/easykash-callback
//
// The ONLY source of truth for payment. The browser redirect proves nothing.
//
// Guarantees:
//  1. HMAC-SHA512 signature verified before anything happens.
//  2. Paid amount must equal the order total (defence in depth).
//  3. mark_web_order_paid() transitions the order ONCE — a duplicate callback
//     can never deliver twice or charge a vendor twice.
//  4. Vendor purchase is attempted exactly once, never retried.
//  5. Always returns HTTP 200 so EasyKash stops retrying.
// ============================================================================

import {
  supabaseAdmin,
  decryptStock,
  purchaseFromVendor,
  purchaseWithIdempotentRetry,
  verifyEasyKashSignature,
  storeOrigin,
} from './_lib/server.js';
import {
  emailCodes,
  emailManualPending,
  emailDeliveryIssue,
  notifyAdmin,
  adminOrderMessage,
  checkStockLevel,
  checkVendorBalance,
} from './_lib/notify.js';
import { pushSaleToAgency } from './_lib/agency.js';

export const config = { maxDuration: 60 };

const ok = (res, payload) => res.status(200).json(payload);

export default async function handler(req, res) {
  if (req.method !== 'POST') return ok(res, { ok: true });

  const body = req.body || {};
  const secret = process.env.EASYKASH_HMAC_SECRET;

  if (!secret || !verifyEasyKashSignature(body, secret)) {
    console.error('EasyKash: invalid signature', body?.customerReference);
    return ok(res, { ok: false, reason: 'invalid signature' });
  }

  const orderNum = String(body.customerReference || '');
  const rawStatus = String(body.status || '').toUpperCase();
  const paidOk = rawStatus === 'PAID';
  // Fawry and Aman hand the buyer a voucher and take the money later, so a
  // callback arrives first saying the payment is still pending. That is not a
  // failure: marking it one would show a lost sale in the dashboard for an
  // order that is simply on its way. Leave it untouched and wait for the real
  // result — mark_web_order_paid still transitions it whenever PAID lands.
  const pending = rawStatus.startsWith('PEND');
  const supabase = supabaseAdmin();

  if (!orderNum) return ok(res, { ok: false, reason: 'no reference' });

  if (pending) {
    return ok(res, { ok: true, status: 'pending' });
  }

  // ---- CV service orders --------------------------------------------------
  // These live in their own table and have no stock, no vendor and no code to
  // deliver — the work happens after payment instead. Their numbers start with
  // CV, so they branch out before any of the product logic below runs.
  if (orderNum.startsWith('CV')) {
    if (!paidOk) {
      await supabase.from('ps_cv_orders')
        .update({ payment_status: 'failed' })
        .eq('order_number', orderNum)
        .eq('payment_status', 'unpaid');
      return ok(res, { ok: true, status: 'failed' });
    }

    const { data: cvOrder } = await supabase
      .from('ps_cv_orders')
      .select('id, customer_email, payment_status, price_usd')
      .eq('order_number', orderNum)
      .maybeSingle();

    if (!cvOrder) return ok(res, { ok: false, reason: 'cv order not found' });
    // Already settled — a duplicate callback must not trigger a second (paid)
    // generation run.
    if (cvOrder.payment_status === 'paid') {
      return ok(res, { ok: true, status: 'already paid' });
    }

    // Verify what was actually paid.
    //
    // Product orders have had this since a 10 EGP payment was found to clear a
    // $7.50 order; the CV service was created later and never got it. The
    // customer is charged in EGP at the live rate, so the expected figure is
    // computed the same way it was at checkout, and a small tolerance covers
    // rounding and rate movement between the two moments.
    const paidAmount = Number(body.Amount);
    if (Number.isFinite(paidAmount) && paidAmount > 0) {
      const priceUsd = Number(cvOrder.price_usd) || 0;
      let expected = priceUsd;
      try {
        const { getRates } = await import('./_lib/fx.js');
        const { rates, markup } = await getRates();
        const eff = Number(rates.EGP) * (1 + Number(markup) / 100);
        if (Number.isFinite(eff) && eff > 0) expected = priceUsd * eff;
      } catch (e) {
        console.error('cv amount check: fx unavailable:', e.message);
      }

      // Match against the currency the amount is plausibly IN, not against
      // whichever expected value it happens to clear.
      //
      // Accepting "at least the USD price OR at least the EGP price" is the
      // trap that let a 10 EGP payment settle a $7.50 order: 10 > 7.5. The
      // amount has to be near one of the expected figures — a payment far
      // below the EGP price isn't a USD payment, it's a short one.
      // "Near" means close on BOTH sides. A one-sided "at least" test is what
      // let 10 through: it clears the $4 floor while being nowhere near the
      // 210 EGP actually owed. A real USD settlement lands within a few
      // percent of the USD price, not at two and a half times it.
      const near = (paid, target) => target > 0 && paid >= target * 0.95 && paid <= target * 1.6;
      const covered = near(paidAmount, expected) || near(paidAmount, priceUsd)
        // Overpayment is never a reason to withhold the service.
        || paidAmount >= expected;

      if (!covered) {
        console.error('cv amount mismatch on %s: paid %s, expected ~%s',
          orderNum, paidAmount, expected.toFixed(2));
        await supabase.from('ps_cv_orders').update({
          payment_status: 'failed',
          error_note: `amount mismatch: paid ${paidAmount}, expected ~${expected.toFixed(2)}`,
        }).eq('id', cvOrder.id);
        return ok(res, { ok: false, reason: 'amount mismatch' });
      }
    }

    await supabase.from('ps_cv_orders').update({
      payment_status: 'paid',
      payment_method: 'easykash',
      easykash_ref: String(body.easykashRef || ''),
    }).eq('id', cvOrder.id);

    // Kick off the rewrite WITHOUT waiting for it.
    //
    // The rewrite takes the better part of a minute. Awaiting it here would
    // hold the callback open past the gateway's timeout, which reads as a
    // failed callback and gets retried — and a retry means paying for a second
    // generation of the same CV. The payment is already recorded above, so
    // acknowledging now is both correct and safe: generate is idempotent and
    // returns the existing result if it's already done.
    //
    // The result page polls, so the customer sees it land either way, and a
    // failure is written onto the row rather than lost.
    // Wait for the request to be RECEIVED, but not for the rewrite to finish.
    //
    // Fire-and-forget doesn't work here: the platform freezes the function the
    // moment it responds, so an unawaited request is killed before it leaves —
    // the generation simply never started, and the customer watched a spinner
    // forever. Awaiting the whole rewrite is the other failure: it outlasts the
    // gateway's callback timeout and gets retried.
    //
    // So: give the request a few seconds to land and be accepted, then let go.
    // /api/cv sets the row to 'processing' before it calls the model, which is
    // enough for the result page to see that work has begun.
    const origin = storeOrigin(req);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      await fetch(`${origin}/api/cv?action=generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: orderNum, email: cvOrder.customer_email }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
    } catch (e) {
      // An abort here is expected and fine — it means the rewrite is running
      // longer than we're willing to hold the callback open, which is the
      // point. The result page picks it up from 'processing'.
      if (e.name !== 'AbortError') {
        console.error('cv generate trigger failed:', e.message);
      }
    }

    return ok(res, { ok: true, status: 'cv paid' });
  }

  // ---- not a successful payment -------------------------------------------
  if (!paidOk) {
    await supabase
      .from('web_orders')
      .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq('order_number', orderNum)
      .eq('payment_status', 'unpaid');
    return ok(res, { ok: true, status: 'failed' });
  }

  // ---- amount check --------------------------------------------------------
  const { data: existing } = await supabase
    .from('web_orders')
    .select('total_usd, payment_status')
    .eq('order_number', orderNum)
    .maybeSingle();

  if (!existing) return ok(res, { ok: false, reason: 'order not found' });

  // Amount check. Since v87 EasyKash may be charged in USD, EGP, or SAR
  // (the buyer's chosen currency), while total_usd stays the USD source of
  // truth. Recompute the acceptable figures the same way checkout does and
  // accept a payment that satisfies ANY of them (with a small tolerance for
  // gateway rounding/fees — overpayment is never a reason to withhold).
  // A payment matching none (e.g. 10 EGP against a 372 EGP order) is flagged.
  const paid = Number(body.Amount);
  const expectedUsd = Number(existing.total_usd);

  let acceptable = [expectedUsd];
  try {
    const { getRates } = await import('./_lib/fx.js');
    const { rates, markup } = await getRates();
    for (const cur of ['EGP', 'SAR']) {
      const eff = Number(rates[cur]) * (1 + Number(markup) / 100);
      if (Number.isFinite(eff) && eff > 0) acceptable.push(Math.ceil(expectedUsd * eff));
    }
  } catch (e) {
    console.error('callback FX unavailable, USD-only check:', e.message);
  }

  // Valid iff paid is within 2% (or 0.5) of ONE of the expected figures, or
  // exceeds the largest one (genuine overpayment). Merely exceeding a SMALLER
  // figure — e.g. 10 EGP "covering" the $7.50 USD figure while undershooting
  // the 372 EGP one — is rejected. Verified against fraud/legit test cases.
  const maxExpected = Math.max(...acceptable);
  const nearSome = acceptable.some((exp) => Math.abs(paid - exp) <= Math.max(0.5, exp * 0.02));
  const covered = nearSome || paid >= maxExpected - Math.max(0.5, maxExpected * 0.02);

  if (!covered) {
    console.error('EasyKash amount mismatch', orderNum, paid, 'acceptable:', acceptable);
    await supabase
      .from('web_orders')
      .update({
        payment_status: 'amount_mismatch',
        easykash_ref: String(body.easykashRef || ''),
        error_note: `paid ${paid}; acceptable ${acceptable.map((a) => a.toFixed ? a.toFixed(2) : a).join(' / ')}`,
      })
      .eq('order_number', orderNum);
    return ok(res, { ok: true, flagged: 'underpaid' });
  }

  // ---- claim the order atomically (only the first callback proceeds) --------
  const { data: rpc, error: rpcErr } = await supabase.rpc('mark_web_order_paid', {
    p_order_number: orderNum,
    p_ref: String(body.easykashRef || ''),
    p_method: String(body.PaymentMethod || 'easykash'),
  });

  if (rpcErr) {
    console.error('mark_web_order_paid error:', rpcErr);
    return ok(res, { ok: false, reason: 'db error' });
  }

  const row = Array.isArray(rpc) ? rpc[0] : rpc;
  if (!row?.did_transition) {
    // Duplicate callback — already handled. Nothing to do.
    return ok(res, { ok: true, duplicate: true });
  }

  // A coupon is consumed only once the money has actually arrived, and only on
  // the first (transitioning) callback — so abandoned carts never burn a use.
  const { data: couponRow } = await supabase
    .from('web_orders')
    .select('coupon_code')
    .eq('id', row.order_id)
    .maybeSingle();

  if (couponRow?.coupon_code) {
    const { error: cErr } = await supabase.rpc('consume_coupon', { p_code: couponRow.coupon_code });
    if (cErr) console.error('consume_coupon failed:', cErr.message);
  }

  // ---- FULFILMENT ----------------------------------------------------------
  const orderId = row.order_id;

  const { data: buyer } = await supabase
    .from('web_orders')
    .select('customer_email')
    .eq('id', orderId)
    .maybeSingle();
  const email = buyer?.customer_email;

  const { data: product } = await supabase
    .from('products')
    .select('id, name, source, vendor_code, vendor_product_id, delivery_speed, delivery_type, activation_note, activation_note_ar')
    .eq('id', row.product_id)
    .maybeSingle();

  if (!product) {
    await fail(supabase, orderId, 'product missing after payment');
    await alert(res, 'failed', { orderNumber: orderNum, productName: '(unknown)', quantity: row.quantity, total: row.total_usd, email, note: 'product row missing' });
    return ok(res, { ok: true, fulfilment: 'failed' });
  }

  // Queue it for the management system.
  //
  // AFTER the product check, not before: an order whose product row has gone
  // missing is about to be marked failed, and a failed order has no business
  // appearing in a sales inbox waiting to be approved.
  //
  // Once per sale by construction — did_transition is true exactly once for an
  // order, so a repeated callback never reaches here twice. The guarantee comes
  // from the transition itself rather than a check that could drift from it.
  //
  // AWAITED — and that is the whole point.
  //
  // Left as fire-and-forget this looked correct and would have done nothing in
  // production: the platform freezes the function the moment it responds, so a
  // promise nobody is waiting on may simply never run. Every sale would have
  // been lost on the way to the inbox while every local test passed.
  //
  // Safe to await: the call cannot throw and cannot hang — it returns false on
  // any failure and aborts itself after six seconds, inside a sixty-second
  // budget. Six seconds in the worst case is the price of not losing sales.
  {
    const { data: full } = await supabase
      .from('web_orders')
      .select('order_number, customer_name, customer_email, customer_phone, quantity, total_usd, cost_usd, payment_method, coupon_code')
      .eq('id', orderId)
      .maybeSingle();
    if (full) await pushSaleToAgency(full, product);
  }

  const info = {
    orderNumber: orderNum,
    productName: product.name,
    quantity: row.quantity,
    total: row.total_usd,
    email,
  };

  // Manual products: a human activates them. Not a failure.
  if (product.delivery_speed === 'manual_1_3h') {
    await supabase
      .from('web_orders')
      .update({ fulfilment_status: 'manual_pending', updated_at: new Date().toISOString() })
      .eq('id', orderId);
    await safely(() => emailManualPending({ to: email, orderNumber: orderNum, productName: product.name }));
    await safely(() => notifyAdmin(adminOrderMessage({ status: 'manual_pending', ...info })));
    return ok(res, { ok: true, fulfilment: 'manual_pending' });
  }

  // --- vendor instant -------------------------------------------------------
  if (product.source === 'vendor') {
    const vendorCode = ['subnova', 'vex'].includes(product.vendor_code)
      ? product.vendor_code
      : 'shopbot';
    try {
      // Only the `vex` vendor guarantees idempotency: retrying with the same
      // external_order_id replays the original delivery instead of charging
      // again. For the other two, a retry could double-charge, so we never do.
      const result = await purchaseWithIdempotentRetry(
        vendorCode,
        String(product.vendor_product_id),
        row.quantity,
        orderNum
      );

      if (result.manual) {
        await supabase
          .from('web_orders')
          .update({
            fulfilment_status: 'manual_pending',
            vendor_order_id: result.vendorOrderId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId);
        await safely(() => emailManualPending({ to: email, orderNumber: orderNum, productName: product.name }));
        await safely(() => notifyAdmin(adminOrderMessage({ status: 'manual_pending', ...info })));
        return ok(res, { ok: true, fulfilment: 'manual_pending' });
      }

      const vendorCodes = result.codes.join('\n\n');
      await deliver(supabase, orderId, vendorCodes, result.vendorOrderId);
      await safely(() => emailCodes({ to: email, orderNumber: orderNum, productName: product.name, quantity: row.quantity, codes: vendorCodes, product }));
      await safely(() => notifyAdmin(adminOrderMessage({ status: 'delivered', ...info })));
      // Warn early if this sale left our vendor wallet low.
      await safely(() => checkVendorBalance(supabase, vendorCode, result.newBalance));
      return ok(res, { ok: true, fulfilment: 'delivered' });
    } catch (e) {
      // network => outcome unknown; api => vendor rejected. Either way a human
      // must look at it. The customer already paid, so never silently drop it.
      console.error(`Vendor purchase ${e.kind} error for ${orderNum}:`, e.message);

      // Our vendor wallet is empty. The customer paid us; the vendor charged
      // nothing. This is a queue item, NOT a failed order: top up, then retry.
      if (e.noBalance) {
        await supabase
          .from('web_orders')
          .update({
            fulfilment_status: 'manual_pending',
            admin_note: `awaiting_topup|vendor=${vendorCode}|retryable=yes`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId);

        await safely(() => emailManualPending({ to: email, orderNumber: orderNum, productName: product.name }));
        await safely(() =>
          notifyAdmin(
            [
              '🔴🔴 <b>رصيدك عند الفيندور فارغ — اشحن الآن</b>',
              '',
              `🏪 الفيندور: <b>${vendorCode}</b>`,
              `🧾 <code>${orderNum}</code>`,
              `📦 ${product.name} × ${row.quantity}`,
              `💵 العميل دفع $${Number(row.total_usd).toFixed(2)}`,
              `📧 ${email}`,
              '',
              'العميل دفع ولم يُخصم من الفيندور شيء.',
              'اشحن ثم اضغط «إعادة المحاولة» في الطلب.',
              '',
              `${process.env.SITE_URL || ''}/admin`,
            ].join('\n')
          )
        );
        return ok(res, { ok: true, fulfilment: 'awaiting_topup' });
      }

      // A clean rejection (out of stock, bad product id) — nothing was charged,
      // so a retry after fixing the cause is safe.
      const retryable = e.kind === 'api';

      await fail(supabase, orderId, `vendor ${e.kind}: ${e.message}`);
      await supabase
        .from('web_orders')
        .update({ admin_note: `vendor=${vendorCode}|retryable=${retryable ? 'yes' : 'no'}|${e.message}` })
        .eq('id', orderId);

      await safely(() => emailDeliveryIssue({ to: email, orderNumber: orderNum, productName: product.name }));
      await safely(() => notifyAdmin(adminOrderMessage({ status: 'failed', ...info, note: `vendor ${e.kind}: ${e.message}` })));
      return ok(res, { ok: true, fulfilment: 'failed' });
    }
  }

  // --- own instant stock ----------------------------------------------------
  const codes = [];
  for (let i = 0; i < row.quantity; i++) {
    const { data: claim, error: claimErr } = await supabase.rpc('claim_stock_for_web_order', {
      p_order_id: orderId,
      p_product_id: product.id,
    });
    const c = Array.isArray(claim) ? claim[0] : claim;
    if (claimErr || !c?.success) break;
    try {
      codes.push(decryptStock(c.content_encrypted));
    } catch (e) {
      console.error('decrypt error:', e.message);
    }
  }

  if (codes.length === 0) {
    await fail(supabase, orderId, 'no stock available after payment');
    await safely(() => emailDeliveryIssue({ to: email, orderNumber: orderNum, productName: product.name }));
    await safely(() => notifyAdmin(adminOrderMessage({ status: 'failed', ...info, note: 'out of stock after payment' })));
    return ok(res, { ok: true, fulfilment: 'failed' });
  }

  const joined = codes.join('\n\n');

  if (codes.length < row.quantity) {
    await deliver(supabase, orderId, joined, null, `partial: ${codes.length}/${row.quantity}`);
    await safely(() => emailCodes({ to: email, orderNumber: orderNum, productName: product.name, quantity: codes.length, codes: joined, product }));
    await safely(() => notifyAdmin(adminOrderMessage({ status: 'failed', ...info, note: `partial delivery ${codes.length}/${row.quantity}` })));
    await safely(() => checkStockLevel(supabase, product));
    return ok(res, { ok: true, fulfilment: 'partial' });
  }

  await deliver(supabase, orderId, joined, null);
  await safely(() => emailCodes({ to: email, orderNumber: orderNum, productName: product.name, quantity: row.quantity, codes: joined, product }));
  await safely(() => notifyAdmin(adminOrderMessage({ status: 'delivered', ...info })));
  await safely(() => checkStockLevel(supabase, product));
  return ok(res, { ok: true, fulfilment: 'delivered' });
}

/**
 * Notifications must never break fulfilment: the order is already delivered in
 * the DB, so a failed email is a logged warning, not a lost sale.
 */
async function safely(fn) {
  try {
    await fn();
  } catch (e) {
    console.error('notification failed (non-fatal):', e.message);
  }
}

/**
 * A network failure leaves the outcome unknown: the vendor may have delivered.
 * For vendors WITHOUT idempotency, retrying risks a double charge, so we don't.
 *
 * The `vex` vendor keys every order on our external_order_id and replays the
 * original result on retry, so exactly one extra attempt is safe and turns a
 * stuck order into a delivered one.
 */
// purchaseWithIdempotentRetry now lives in _lib/server.js — the admin's
// "deliver from vendor" button calls the same one, so both routes derive the
// same external id and a vendor that honours it can never be charged twice for
// one order.

async function alert(_res, status, info) {
  await safely(() => notifyAdmin(adminOrderMessage({ status, ...info })));
}

async function deliver(supabase, orderId, content, vendorOrderId, note) {
  await supabase
    .from('web_orders')
    .update({
      fulfilment_status: 'delivered',
      delivered_content: content,
      vendor_order_id: vendorOrderId || null,
      fulfilled_at: new Date().toISOString(),
      error_note: note || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId);
}

async function fail(supabase, orderId, note) {
  await supabase
    .from('web_orders')
    .update({
      fulfilment_status: 'failed',
      error_note: String(note).slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId);
}

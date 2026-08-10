// ============================================================================
// Shared server-side helpers (never bundled into the browser).
// ============================================================================

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/**
 * Server client with full privileges.
 * Supports both key generations:
 *   legacy → SUPABASE_SERVICE_ROLE_KEY (eyJ...)
 *   new    → SUPABASE_SECRET_KEY       (sb_secret_...)
 */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY');
  return createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false },
  });
}

// --- AES-256-GCM (same format as the Telegram bot) --------------------------
/**
 * Encrypts stock content. Output: iv:authTag:ciphertext (hex), identical to the
 * bot's crypto.ts, so codes added here are readable by the bot and vice-versa.
 */
export function encryptStock(plaintext) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptStock(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted payload');
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

// --- pricing ----------------------------------------------------------------

/**
 * What this product costs the customer right now.
 *
 * Every place that shows, charges or validates a price goes through here. Written
 * twice it drifts once, and the drift shows up as a customer seeing one number
 * and being charged another — the single worst bug a shop can have.
 *
 * A sale price that isn't BELOW the normal price is not a sale, and is ignored
 * rather than honoured: a typo that adds a zero must never raise the price.
 */
export function effectivePrice(product) {
  const base = Number(product?.price_usd);
  if (!Number.isFinite(base) || base <= 0) return null;
  const sale = Number(product?.sale_price_usd);
  return Number.isFinite(sale) && sale > 0 && sale < base ? sale : base;
}

/** True only when a real discount is live. */
export function isOnSale(product) {
  const base = Number(product?.price_usd);
  const sale = Number(product?.sale_price_usd);
  return Number.isFinite(base) && Number.isFinite(sale) && sale > 0 && sale < base;
}

// --- vendors ----------------------------------------------------------------
async function fetchJson(url, opts, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const json = await res.json().catch(() => null);

    if (!res.ok || json?.error || json?.ok === false) {
      const msg = json?.error || json?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      // 402/409/429/401 are *clean* rejections: the vendor states no charge was
      // made (balance is deducted only on allocation, failures auto-refund).
      // 5xx and timeouts leave the outcome unknown.
      err.kind = [400, 401, 402, 409, 422, 429].includes(res.status) ? 'api' : 'network';
      err.httpStatus = res.status;
      // 402, or any vendor wording of it, means OUR wallet is empty — not the
      // customer's fault, and nothing was charged. Recoverable by topping up.
      err.noBalance =
        res.status === 402 || /insufficient|balance|رصيد|no funds/i.test(msg);
      throw err;
    }
    return json;
  } catch (e) {
    if (!e.kind) e.kind = 'network'; // outcome unknown — do NOT retry
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- vendor 3
const VEX_URL = process.env.VEX_API_URL || '';
const VEX_KEY = process.env.VEX_API_KEY || '';

/**
 * Extracts delivered codes from a response whose exact shape is not documented
 * for quantity > 1. We accept every plausible form rather than guessing one:
 *   "ABC"                      → ["ABC"]
 *   "ABC\nDEF"                 → ["ABC","DEF"]
 *   ["ABC","DEF"]              → ["ABC","DEF"]
 *   [{code:"ABC"},{code:"DEF"}] → ["ABC","DEF"]
 *
 * Returns null when nothing recognisable is present — the caller then treats the
 * order as "needs a human" instead of delivering garbage.
 */
export function parseVexData(data) {
  if (data == null) return null;

  if (typeof data === 'string') {
    const parts = data.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : null;
  }

  if (Array.isArray(data)) {
    const out = [];
    for (const item of data) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim());
      else if (item && typeof item === 'object') {
        const v = item.code ?? item.value ?? item.data ?? item.serial;
        if (typeof v === 'string' && v.trim()) out.push(v.trim());
        else {
          // account-style payload
          const lines = [];
          for (const k of ['email', 'username', 'password', 'mail_password', 'two_factor', 'note']) {
            if (item[k]) lines.push(`${k}: ${item[k]}`);
          }
          if (lines.length) out.push(lines.join('\n'));
        }
      }
    }
    return out.length ? out : null;
  }

  if (typeof data === 'object') {
    const v = data.code ?? data.value ?? data.serial;
    if (typeof v === 'string' && v.trim()) return [v.trim()];
  }

  return null;
}

/** True when the vendor is telling us the order is not yet fulfilled. */
export function isVexPending(status) {
  return ['pending', 'processing', 'manual', 'pending_manual', 'queued'].includes(
    String(status || '').toLowerCase()
  );
}

/**
 * Buys from the correct vendor. SINGLE attempt — never retried (double-charge).
 * Returns { codes: string[], vendorOrderId, manual: boolean }
 */
/**
 * Buy from a vendor, safely retryable.
 *
 * The external id is derived from OUR order number, so it is stable and unique
 * per customer order. A vendor that honours idempotency replays the original
 * delivery instead of charging a second time — which is what makes it safe for
 * both the payment callback and the admin button to call this for the same
 * order without buying twice.
 *
 * Shared rather than copied: two versions of this would eventually disagree
 * about the external id, and the day they did, one order would be paid for
 * twice with nothing to show which call did it.
 */
export async function purchaseWithIdempotentRetry(vendorCode, vendorProductId, qty, orderNum, timeoutMs) {
  const externalId = `web-${orderNum}`;
  const buyerInfo = vendorCode === 'vex' ? externalId : `web:${orderNum}`;

  try {
    return await purchaseFromVendor(vendorCode, vendorProductId, qty, buyerInfo, timeoutMs);
  } catch (e) {
    const retryable = vendorCode === 'vex' && e.kind === 'network';
    if (!retryable) throw e;

    console.warn(`vex network error for ${orderNum}, retrying idempotently:`, e.message);
    await new Promise((r) => setTimeout(r, 2000));

    // Same external id ⇒ the vendor replays the original delivery, no second charge.
    return purchaseFromVendor(vendorCode, vendorProductId, qty, buyerInfo, timeoutMs);
  }
}

export async function purchaseFromVendor(vendorCode, vendorProductId, qty, buyerInfo, timeoutMs) {
  if (vendorCode === 'vex') {
    // This vendor supports idempotency: retrying with the same external id
    // returns the ORIGINAL delivery instead of charging twice. buyerInfo is our
    // own order number, so it is unique and stable.
    const data = await fetchJson(`${VEX_URL}?action=order`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VEX_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        product_id: String(vendorProductId),
        quantity: qty,
        external_order_id: String(buyerInfo),
      }),
    }, timeoutMs);

    const status = String(data.status || '').toLowerCase();
    const vendorOrderId = data.order_id ? String(data.order_id) : null;

    if (isVexPending(status)) {
      return { codes: [], vendorOrderId, manual: true };
    }

    const codes = parseVexData(data.data);

    if (!codes) {
      // Money may well have been taken, but we cannot read the delivery.
      // Never invent a code: surface it for manual handling.
      const e = new Error(`unrecognised delivery payload (status=${status || 'none'})`);
      e.kind = 'network'; // treated as "outcome unknown" → no auto-refund, alert admin
      throw e;
    }

    // The vendor may return fewer codes than requested; the caller reports a
    // partial delivery rather than silently dropping the shortfall.
    return { codes, vendorOrderId, manual: false };
  }

  if (vendorCode === 'subnova') {
    const data = await fetchJson(`${process.env.SUBNOVA_API_URL || 'https://subnovaa.com/api/cdk'}/orders`, {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.SUBNOVA_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ items: [{ service_id: Number(vendorProductId), quantity: qty }] }),
    }, timeoutMs);
    const order = data.orders?.[0];
    if (!order) {
      const e = new Error('Subnova returned no order');
      e.kind = 'api';
      throw e;
    }
    const codes = [];
    for (const it of order.items ?? []) {
      if (it.type === 'cdk' && it.code) codes.push(it.code);
      else if (it.type === 'account') {
        const lines = [];
        if (it.email) lines.push(`Email: ${it.email}`);
        if (it.password) lines.push(`Password: ${it.password}`);
        if (it.mail_password) lines.push(`Mail password: ${it.mail_password}`);
        if (it.two_factor) lines.push(`2FA: ${it.two_factor}`);
        if (lines.length) codes.push(lines.join('\n'));
      }
    }
    return { codes, vendorOrderId: String(order.id), manual: false };
  }

  // shopbot
  const data = await fetchJson(`${process.env.VENDOR_API_URL}/purchase`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VENDOR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ product_id: vendorProductId, qty, buyer_info: buyerInfo }),
  }, timeoutMs);

  return {
    codes: data.codes ?? [],
    vendorOrderId: data.order_id,
    manual: data.status === 'pending_manual',
    newBalance: data.new_balance ?? null,
  };
}

// --- EasyKash HMAC ----------------------------------------------------------
/**
 * Verifies the EasyKash callback signature.
 * Order is fixed by their docs — do not sort or reorder.
 */
export function verifyEasyKashSignature(body, secret) {
  const parts = [
    body.ProductCode,
    body.Amount,
    body.ProductType,
    body.PaymentMethod,
    body.status,
    body.easykashRef,
    body.customerReference,
  ];
  if (parts.some((p) => p === undefined || p === null)) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(parts.join(''))
    .digest('hex');

  const received = String(body.signatureHash || '');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function orderNumber() {
  // 6 random chars (~2.1 billion combos) on top of the time component. Order
  // access is email-gated anyway, but numbers shouldn't be guessable either.
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return 'PS' + Date.now().toString(36).toUpperCase() + rand;
}

/**
 * Where the buyer comes back to after paying.
 *
 * SITE_URL has been left pointing at the vercel.app preview host before, which
 * sends the customer back to a domain that isn't the shop — and a gateway may
 * refuse to redirect off the account's registered domain at all. Prefer the
 * canonical domain and ignore a preview hostname.
 */
export function storeOrigin(req) {
  const raw = String(process.env.SITE_URL || '').replace(/\/+$/, '');
  const CANONICAL = 'https://store.proskillagency.com';
  if (!raw || /vercel\.app/i.test(raw)) return CANONICAL;
  return raw;
}

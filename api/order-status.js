// ============================================================================
// GET /api/order-status?order=PSXXXX&email=...
// Public status for the confirmation page. Requires the buyer's email so an
// order number alone can never reveal purchased codes.
// ============================================================================

import { supabaseAdmin, decryptStock } from './_lib/server.js';
import { INSTAPAY } from './_lib/instapay.js';
import { getRates } from './_lib/fx.js';
import { readMailbox } from './_lib/mailbox.js';
import { notifyAdmin } from './_lib/notify.js';


/**
 * GET /api/order-status?order=..&email=..&inbox=1
 *
 * Shows the buyer the inbox of the account they bought.
 *
 * The guard is the whole design: the mailbox address must appear inside the
 * delivered content of an order that matches BOTH the order number and the
 * buyer's email. So a customer can only ever open a mailbox that was handed to
 * them, and only while that order stands. Knowing an address is not enough,
 * which is what separates this from a tool that reads arbitrary inboxes.
 */

// ---------------------------------------------------------------------------
// Rate limit on inbox reads.
//
// Each read is a real IMAP login. A customer refreshing while they wait for a
// code — which is exactly what they'll do — can hammer the mailbox, and
// Microsoft locks an account that's logged into repeatedly in a short window.
// The lockout would hit the account we sold, not us: the customer loses access
// to something they paid for because they were impatient.
//
// Keyed per mailbox, not per IP, because the account is what needs protecting.
// ---------------------------------------------------------------------------
const INBOX_RL = new Map();
const INBOX_MAX = 6;                 // reads
const INBOX_WINDOW = 5 * 60 * 1000;  // per 5 minutes per mailbox

// A shared mailbox serves many accounts, so the per-account limit above no
// longer bounds what any single IMAP server sees. Ten customers each staying
// politely within six reads is sixty logins against one Hostinger mailbox in
// five minutes — enough to get it throttled, which breaks the feature for
// everyone at once. Generous enough that normal use never reaches it.
const INBOX_LOGIN_MAX = 30;

// Alerts are throttled separately and far harder than reads. Six messages
// about one broken mailbox is how a notification channel becomes noise you
// learn to swipe away — and the next real alert goes unread with it.
const ALERTED = new Map();
const ALERT_WINDOW = 30 * 60 * 1000;

function alertedRecently(mailbox) {
  const now = Date.now();
  const at = ALERTED.get(mailbox);
  if (at && now - at < ALERT_WINDOW) return true;
  ALERTED.set(mailbox, now);
  if (ALERTED.size > 200) {
    for (const [k, v] of ALERTED) if (now - v > ALERT_WINDOW) ALERTED.delete(k);
  }
  return false;
}

function inboxLimited(mailbox, max = INBOX_MAX) {
  const now = Date.now();
  const rec = INBOX_RL.get(mailbox);
  if (!rec || now > rec.resetAt) {
    INBOX_RL.set(mailbox, { count: 1, resetAt: now + INBOX_WINDOW });
    if (INBOX_RL.size > 300) {
      for (const [k, v] of INBOX_RL) if (now > v.resetAt) INBOX_RL.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

async function inboxHandler(res, supabase, orderNumber, buyerEmail) {
  const { data: order } = await supabase
    .from('web_orders')
    .select('delivered_content, payment_status, fulfilment_status')
    .eq('order_number', orderNumber)
    .eq('customer_email', buyerEmail)
    .maybeSingle();

  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (order.payment_status !== 'paid' || !order.delivered_content) {
    return res.status(403).json({ error: 'الطلب غير مُسلَّم' });
  }

  // Every address that appears in what this customer was given.
  //
  // Taking only the first match was wrong: delivered content can carry a
  // recovery address or a support address alongside the account, and picking
  // the wrong one could open a mailbox this buyer has no claim to. Instead,
  // collect them all and let the mailbox table decide — the intersection of
  // "addresses in THIS order" and "mailboxes we hold" is the safe set.
  const found = [...new Set(
    (String(order.delivered_content).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])
      .map((e) => e.toLowerCase())
  )];

  if (found.length === 0) {
    return res.status(400).json({ error: 'هذا الطلب ليس حساباً ببريد' });
  }

  // A SHARED LOGIN IS NEVER ITSELF A READABLE ACCOUNT.
  //
  // Delivered content quite reasonably carries a support address — "email us at
  // support@ if the account stops working" is a normal thing to write. That
  // address then lands in `found`. If a mailbox row also exists for it, the
  // reader would open it with login === account, decide the box is DEDICATED,
  // skip the filter entirely, and hand this customer the newest message in the
  // shared mailbox: another buyer's verification code, or the owner's support
  // mail. Nothing else in the chain catches this — the order is genuinely the
  // customer's and the address genuinely appears in it.
  //
  // So: whatever serves as a login for somebody else's mail is not an account.
  let sharedLogins = new Set();
  {
    const { data: logins, error: lErr } = await supabase
      .from('ps_mailboxes').select('imap_user').not('imap_user', 'is', null);
    // Before the migration there is no imap_user column, so no shared mailbox
    // exists yet and there is nothing to exclude.
    if (!lErr) {
      sharedLogins = new Set(
        (logins ?? []).map((r) => String(r.imap_user || '').toLowerCase()).filter(Boolean)
      );
    }
  }

  const readable = found.filter((e) => !sharedLogins.has(e));
  if (readable.length === 0) {
    return res.status(400).json({ error: 'هذا الطلب ليس حساباً ببريد' });
  }

  // The IMAP columns are asked for optimistically. Before
  // store_mailboxes_imap.sql has been run they don't exist and PostgREST
  // rejects the whole select — which would break reading for the mailboxes
  // that already work. Ask again without them.
  const MB_COLS = 'email, secret_enc, provider, is_active';
  // match_extra rides along with the other optional columns — same migration,
  // same fallback if it hasn't been run.
  let { data: boxes, error: mbErr } = await supabase
    .from('ps_mailboxes')
    .select(`${MB_COLS}, imap_host, imap_user, match_extra`)
    .in('email', readable);
  if (mbErr) {
    console.warn('inbox: imap columns missing — run store_mailboxes_imap.sql');
    ({ data: boxes } = await supabase
      .from('ps_mailboxes').select(MB_COLS).in('email', readable));
  }

  const box = (boxes ?? []).find((b) => b.is_active);
  const soldEmail = box?.email;

  if (!box) {
    return res.status(404).json({
      error: 'صندوق هذا الحساب غير متاح للقراءة — راسلنا على واتساب برقم الطلب.',
    });
  }

  // Two limits, because with a shared mailbox they stopped being the same
  // thing: one bounds a single customer, the other bounds the server they all
  // land on. Short-circuited, so a customer already over their own limit
  // doesn't also consume the shared budget.
  const imapLogin = String(box.imap_user || box.email).toLowerCase();
  const overLimit = inboxLimited(soldEmail)
    || (imapLogin !== String(soldEmail).toLowerCase()
        && inboxLimited(`login:${imapLogin}`, INBOX_LOGIN_MAX));

  if (overLimit) {
    return res.status(429).json({
      error: 'حاولت كثيراً خلال وقت قصير. انتظر بضع دقائق — تكرار الفتح قد يقفل الحساب مؤقتاً.',
    });
  }

  try {
    const message = await readMailbox({
      email: box.email,
      password: decryptStock(box.secret_enc),
      provider: box.provider,
      host: box.imap_host,
      imapUser: box.imap_user,
      matchExtra: box.match_extra,
    });

    // Record the read so a failing mailbox is visible in the dashboard rather
    // than only to the customer who hit it.
    supabase.from('ps_mailboxes')
      .update({ last_read_at: new Date().toISOString(), error_note: null })
      .eq('email', soldEmail).then(() => {}, () => {});

    // An empty box is a normal answer, not an error — the code may simply
    // not have arrived yet, and the page should say so rather than fail.
    return res.status(200).json({ mailbox: soldEmail, message: message || null });
  } catch (e) {
    console.error('inbox read failed for %s: %s', soldEmail, e.message);
    supabase.from('ps_mailboxes')
      .update({ error_note: String(e.message).slice(0, 200) })
      .eq('email', soldEmail).then(() => {}, () => {});

    // Tell me, once per window.
    //
    // A broken mailbox means the customer is back to messaging support —
    // exactly what this feature exists to prevent. Writing the reason to a
    // column only helps if someone opens the dashboard; a failure that a
    // paying customer just hit should reach me the same minute. Reuses the
    // read limiter's window so a customer retrying doesn't send a burst.
    if (!alertedRecently(soldEmail)) {
      notifyAdmin([
        '📪 <b>صندوق بريد لا يفتح</b>',
        '',
        `📧 <code>${soldEmail}</code>`,
        `🧾 الطلب: <code>${orderNumber}</code>`,
        `⚠️ ${String(e.message).slice(0, 140)}`,
        '',
        /login|auth/i.test(String(e.message))
          ? 'راجع App Password أو فعّل IMAP على الحساب.'
          : 'العميل ينتظر كوده الآن.',
      ].join('\n')).catch(() => {});
    }

    return res.status(502).json({
      error: 'تعذّر فتح صندوق البريد الآن. حاول بعد قليل أو راسلنا على واتساب.',
    });
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // "I've sent the transfer."
  //
  // Says nothing about whether the money arrived — only that the buyer believes
  // they sent it, which is exactly what the shop cannot otherwise know until
  // someone opens the bank app. The transfer is still confirmed by hand before
  // anything is delivered; this only stops buyer and seller waiting on each
  // other in silence.
  //
  // Placed before the query-string checks below because this one arrives in the
  // body, not the URL.
  if (req.method === 'POST' && req.body?.action === 'paid-claim') {
    const num = String(req.body.order || '').trim();
    const mail = String(req.body.email || '').trim().toLowerCase();
    if (!num || !mail) return res.status(400).json({ error: 'بيانات ناقصة' });

    const sb = supabaseAdmin();
    const { data: o } = await sb
      .from('web_orders')
      .select('id, order_number, payment_status, fulfilment_status, total_usd, error_note, products(name)')
      .eq('order_number', num)
      .eq('customer_email', mail)
      .maybeSingle();

    // The same answer for an order that is already paid, already delivered, or
    // simply not theirs — so this cannot be used to discover which order
    // numbers exist.
    if (!o || o.payment_status === 'paid' || o.fulfilment_status !== 'manual_pending') {
      return res.status(200).json({ ok: true });
    }
    // Once. Five taps must not send five alerts.
    if (String(o.error_note || '').includes('customer says transferred')) {
      return res.status(200).json({ ok: true });
    }

    // Appended, and not filtered on the note being empty.
    //
    // The guard above decides whether this is a repeat; the write must then
    // actually happen, or the guard has nothing to find next time. Filtering on
    // `error_note is null` made the two disagree: an order carrying any earlier
    // note would never get the marker written, so every further tap would look
    // like the first and fire another alert. No path produces that note today,
    // which is exactly why it would have surfaced much later and looked random.
    const note = o.error_note
      ? `${o.error_note} | customer says transferred`
      : 'customer says transferred';

    await sb.from('web_orders')
      .update({ error_note: note, updated_at: new Date().toISOString() })
      .eq('id', o.id);

    try {
      await notifyAdmin(
        `💸 <b>عميل بيقول إنه حوّل</b>\n🧾 <code>${o.order_number}</code>\n`
        + `📦 ${o.products?.name || ''}\n💵 $${Number(o.total_usd || 0).toFixed(2)}\n\n`
        + `راجع إنستاباي وسلّم الطلب لو التحويل وصل.`
      );
    } catch (e) {
      console.error('paid-claim notify failed:', e.message);
    }

    return res.status(200).json({ ok: true });
  }

  const order = String(req.query.order || '').trim();
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!order || !email) {
    res.status(400).json({ error: 'بيانات ناقصة' });
    return;
  }

  const supabase = supabaseAdmin();

  // Inbox request — same credentials, different answer.
  if (req.query.inbox === '1') {
    return inboxHandler(res, supabase, order, email);
  }

  const { data, error } = await supabase
    .from('web_orders')
    .select(
      'order_number, quantity, total_usd, payment_status, fulfilment_status, ' +
        'delivered_content, created_at, products(name, emoji, delivery_speed)'
    )
    .eq('order_number', order)
    .eq('customer_email', email)
    .maybeSingle();

  if (error || !data) {
    res.status(404).json({ error: 'الطلب غير موجود' });
    return;
  }

  // Codes are only returned once the order is actually paid + delivered.
  const codes =
    data.payment_status === 'paid' && data.fulfilment_status === 'delivered'
      ? data.delivered_content
      : null;

  // Does this order actually have a mailbox we can read?
  //
  // The page used to decide this by looking at the SHAPE of the delivered text
  // — an address followed by "|" or ":" and a password. That made a button the
  // customer needs depend on how the account happened to be typed that day:
  // "Email: x\nPassword: y" is the same delivery and showed nothing.
  //
  // The server already knows the real answer, and checks it properly when the
  // button is pressed. Answering it here too means the page stops guessing:
  // the card appears when a mailbox exists and never when it doesn't, whatever
  // the formatting.
  let hasMailbox = false;
  if (codes) {
    const addresses = [...new Set(
      (String(codes).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).map((e) => e.toLowerCase())
    )];
    if (addresses.length > 0) {
      // Same rule as the reader: an address that serves as the shared LOGIN for
      // other accounts is not itself readable, so it must not light the button.
      let sharedLogins = new Set();
      const { data: logins, error: lErr } = await supabase
        .from('ps_mailboxes').select('imap_user').not('imap_user', 'is', null);
      if (!lErr) {
        sharedLogins = new Set(
          (logins ?? []).map((r) => String(r.imap_user || '').toLowerCase()).filter(Boolean)
        );
      }
      const readable = addresses.filter((a) => !sharedLogins.has(a));
      if (readable.length > 0) {
        const { count } = await supabase
          .from('ps_mailboxes')
          .select('email', { count: 'exact', head: true })
          .in('email', readable)
          .eq('is_active', true);
        hasMailbox = Number(count) > 0;
      }
    }
  }

  // What a buyer who is still waiting to transfer actually needs.
  //
  // The transfer details are sent once, in the order email, and shown once on
  // the confirmation screen. Close that tab or lose that mail and the order
  // page — the one place they come back to — told them only "we're reviewing
  // your order, please wait". They were not putting it off; they had nowhere
  // left to find the number.
  //
  // Only for an order that is genuinely still owed: never once it is paid.
  let transfer = null;
  if (data.payment_status !== 'paid' && data.fulfilment_status === 'manual_pending') {
    let egpAmount = null;
    try {
      // The same conversion the order email used — same rate source, same
      // markup, same rounding — so the two figures agree.
      const { rates, markup } = await getRates();
      const effective = Number(rates.EGP) * (1 + Number(markup) / 100);
      egpAmount = Math.ceil(Number(data.total_usd) * effective);
    } catch (e) {
      console.error('order-status fx failed:', e.message);
    }
    transfer = { ...INSTAPAY, egpAmount, usd: Number(data.total_usd) };
  }

  res.status(200).json({
    orderNumber: data.order_number,
    transfer,
    quantity: data.quantity,
    total: data.total_usd,
    paymentStatus: data.payment_status,
    fulfilmentStatus: data.fulfilment_status,
    product: data.products,
    codes,
    hasMailbox,
    createdAt: data.created_at,
  });
}

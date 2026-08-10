// ============================================================================
// Customer email (Resend) + admin alerts (Telegram + email).
//
// Design rule: notifications must NEVER break fulfilment. Every function here
// swallows its own errors and logs them. A failed email must not stop a
// delivered order from being marked delivered.
// ============================================================================

const RESEND_URL = 'https://api.resend.com/emails';
const SITE = process.env.SITE_URL || 'https://proskill-store.vercel.app';
const SUPPORT = 'https://wa.me/201500568788';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM; // e.g. "ProSkill <orders@proskillagency.com>"
  if (!key || !from) {
    console.warn('email skipped: RESEND_API_KEY or EMAIL_FROM not set');
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error('resend failed:', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('resend error:', e.message);
    return false;
  }
}

// --------------------------------------------------------------- customer
const shell = (inner) => `
<div style="background:#f4f6f5;padding:32px 12px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8ebe8">
    <div style="background:#0e2233;padding:22px 24px">
      <div style="color:#fff;font-size:19px;font-weight:800">ProSkill<span style="color:#7fd0c7">Store</span></div>
    </div>
    <div style="padding:26px 24px;color:#0e2233;font-size:15px;line-height:1.7" dir="rtl">${inner}</div>
    <div style="padding:16px 24px;background:#fbfbfa;border-top:1px solid #eef0ee;color:#6b7883;font-size:12px" dir="rtl">
      تحتاج مساعدة؟ <a href="${SUPPORT}" style="color:#1f6a65;font-weight:700">تواصل معنا على واتساب</a>
      <div style="margin-top:6px">© ${new Date().getFullYear()} ProSkill Digital Agency</div>
    </div>
  </div>
</div>`;

/** One-click link back to the order (email pre-filled, still verified server-side). */
const trackUrl = (orderNumber, to) =>
  `${SITE}/order/${encodeURIComponent(orderNumber)}?e=${encodeURIComponent(String(to || '').toLowerCase())}`;

// Five taps' worth of choice, one tap wide.
//
// The old invitation was a single button: press it, land on an empty form,
// choose a rating, then send. Three decisions after the click, and almost
// nobody made them. Carrying the rating in the link collapses that to one tap
// here and one confirmation there.
//
// The link only PRE-SELECTS. It deliberately does not submit, for two reasons:
// a mail scanner that prefetches links would file reviews nobody wrote, and a
// mistapped star would be final. GET requests don't change anything here.
const starRow = (orderNumber, to) => {
  const url = trackUrl(orderNumber, to);
  const stars = [1, 2, 3, 4, 5].map((n) => `
    <td style="padding:0 3px">
      <!-- &amp;, not &. A bare ampersand in an attribute is legal HTML but
           optional to parse that way, and mail clients rewrite links through
           their own sanitisers. &amp; is decoded back to & by every one of
           them; a raw & is where a link quietly loses its rating. -->
      <a href="${url}&amp;rate=${n}#review"
         style="display:inline-block;text-decoration:none;font-size:30px;line-height:1;
                color:#f0a500;padding:6px 4px">★</a>
    </td>`).join('');
  // dir="ltr" — and it is NOT cosmetic.
  //
  // The email body is dir="rtl", so the cells would flow right-to-left and star
  // 1 would sit on the RIGHT. The picker on the order page forces direction:ltr
  // (see .star-pick in styles.css), so star 1 sits on the LEFT. Mirrored, the
  // two disagree: a customer reaching for the far star to say "excellent" taps
  // 1 in the email and lands on a page showing a single lit star. Nothing
  // errors, nothing logs — the rating is simply the opposite of what they meant.
  return `<table role="presentation" dir="ltr" style="border-collapse:collapse;direction:ltr"><tr>${stars}</tr></table>`;
};

const trackButton = (orderNumber, to) => `
  <p style="margin:20px 0 0">
    <a href="${trackUrl(orderNumber, to)}"
       style="display:inline-block;background:#2f7d78;color:#fff;text-decoration:none;
              font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">
      متابعة طلبي
    </a>
  </p>
  <p style="margin:10px 0 0;font-size:12px;color:#6b7883">
    احتفظ بهذا البريد — الرابط يفتح طلبك في أي وقت.
  </p>`;

/**
 * Order recorded, payment not made yet (manual InstaPay transfer).
 *
 * Nothing else emails this customer: the EasyKash callback never fires for a
 * manual order, so without this the buyer closes the tab and has no record of
 * the order number at all.
 */
export async function emailOrderPlaced({ to, orderNumber, productName, quantity, egpAmount, totalUsd, instapay }) {
  const amount = egpAmount
    ? `<b style="font-size:20px">${esc(egpAmount)} ج.م</b>`
    : `<b style="font-size:20px">$${Number(totalUsd || 0).toFixed(2)}</b>`;

  const html = shell(`
    <h2 style="margin:0 0 6px;font-size:20px">📝 تم تسجيل طلبك</h2>
    <p style="margin:0 0 18px;color:#6b7883">طلبك محفوظ باسمك. يتبقّى تحويل المبلغ حتى نفعّله.</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
      <tr><td style="padding:6px 0;color:#6b7883">رقم الطلب</td>
          <td style="padding:6px 0;font-weight:700;direction:ltr;text-align:left">${esc(orderNumber)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7883">المنتج</td>
          <td style="padding:6px 0;font-weight:700;text-align:left">${esc(productName)} × ${quantity}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7883">المبلغ</td>
          <td style="padding:6px 0;text-align:left">${amount}</td></tr>
    </table>

    <div style="background:#f6f4fd;border:1px solid #ded5fb;border-radius:12px;padding:16px">
      <div style="font-weight:800;margin-bottom:8px">حوّل عبر InstaPay</div>
      <div style="direction:ltr;text-align:left;font-family:ui-monospace,monospace;font-size:14px">
        ${esc(instapay?.number || '')}<br>${esc(instapay?.handle || '')}
      </div>
      ${instapay?.link
        ? `<p style="margin:12px 0 0"><a href="${esc(instapay.link)}" style="color:#5b3fb8;font-weight:700">فتح رابط التحويل</a></p>`
        : ''}
    </div>

    <div style="background:#fbf2e2;border-radius:12px;padding:14px;color:#8a5d12;margin-top:14px">
      📤 بعد التحويل، أرسل صورة الإيصال مع رقم الطلب على واتساب حتى نفعّل طلبك.
    </div>
    ${trackButton(orderNumber, to)}`);

  return sendEmail({ to, subject: `تم تسجيل طلبك — ${orderNumber} | ProSkill`, html });
}

/**
 * How this product reaches the buyer, in the buyer's words.
 *
 * A code you redeem, an invite you accept, and a subscription we switched on
 * for you are three different messages. Sending "here is your code" for an
 * invite leaves people hunting for a code that was never issued — so the
 * heading, the intro and the label on the box all follow the product. A custom
 * activation note written in the dashboard always wins over the defaults.
 */
function deliveryWording(product) {
  // Defensive on purpose: a default parameter only covers `undefined`, and a
  // deleted product arrives here as null. Reading a note off null would throw
  // and cost the buyer their delivery email.
  const p = product || {};
  const custom = String(p.activation_note_ar || p.activation_note || '').trim();

  let key = 'code';
  if (p.delivery_speed === 'manual_1_3h') key = 'manual';
  else if (p.delivery_type === 'account') key = 'account';
  else if (p.delivery_type === 'invite') key = 'invite';

  const map = {
    code:    { head: '🎉 طلبك جاهز!',        subject: 'طلبك جاهز',       intro: 'كودك بالأسفل — فعّله على حسابك.', label: 'الكود' },
    account: { head: '🎉 طلبك جاهز!',        subject: 'طلبك جاهز',       intro: 'بيانات حسابك بالأسفل.', label: 'بيانات الحساب' },
    invite:  { head: '✅ تم إرسال الدعوة',   subject: 'تم إرسال الدعوة', intro: 'أرسلنا الدعوة على بريدك — افتحها واقبلها ليتفعّل اشتراكك.', label: 'تفاصيل الدعوة' },
    manual:  { head: '✅ تم تفعيل اشتراكك', subject: 'تم تفعيل اشتراكك', intro: 'فعّلنا اشتراكك. التفاصيل بالأسفل.', label: 'تفاصيل التفعيل' },
  };

  const w = map[key];
  return { ...w, intro: custom || w.intro };
}

/** The purchased codes. This is the email that must never fail silently. */
export async function emailCodes({ to, orderNumber, productName, quantity, codes, product }) {
  const w = deliveryWording(product);
  const html = shell(`
    <h2 style="margin:0 0 6px;font-size:20px">${w.head}</h2>
    <p style="margin:0 0 18px;color:#6b7883">${esc(w.intro)}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
      <tr><td style="padding:6px 0;color:#6b7883">رقم الطلب</td>
          <td style="padding:6px 0;font-weight:700;direction:ltr;text-align:left">${esc(orderNumber)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7883">المنتج</td>
          <td style="padding:6px 0;font-weight:700;text-align:left">${esc(productName)} × ${quantity}</td></tr>
    </table>
    <div style="font-size:13px;color:#6b7883;margin-bottom:6px">${esc(w.label)}</div>
    <div style="background:#0e2233;color:#e8f0f4;border-radius:12px;padding:16px;direction:ltr;text-align:left;
                font-family:ui-monospace,monospace;font-size:14px;white-space:pre-wrap;word-break:break-all">${esc(codes)}</div>
    <p style="margin:18px 0 0;font-size:13px;color:#6b7883">
      ⚠️ احتفظ بهذه البيانات في مكان آمن ولا تشاركها مع أحد.
    </p>
    ${trackButton(orderNumber, to)}

    <!-- Review invitation. The form already lives on the order page, but
         nobody ever went back there — the code arrives by email and that's
         the end of the journey. Asking here, at the moment the product
         lands, is the only point where the customer is both happy and
         actually reading. -->
    <div style="margin-top:26px;padding-top:20px;border-top:1px solid #e7ebee">
      <div style="font-weight:800;font-size:15px;margin-bottom:4px">رأيك يفرق معانا</div>
      <p style="margin:0 0 12px;color:#6b7883;font-size:13px;line-height:1.6">
        اضغط على عدد النجوم اللي تستحقها التجربة — هتلاقيها مختارة في الصفحة،
        تدوس إرسال وخلاص.
      </p>
      ${starRow(orderNumber, to)}
      <p style="margin:12px 0 0;color:#8b98a2;font-size:12px">
        <a href="${trackUrl(orderNumber, to)}#review" style="color:#1f6a65">
          أو افتح صفحة الطلب لو حابب تكتب تعليق
        </a>
      </p>
    </div>`);

  return sendEmail({ to, subject: `${w.subject} — ${orderNumber} | ProSkill`, html });
}

/** Manual products: payment received, activation pending. */
export async function emailManualPending({ to, orderNumber, productName }) {
  const html = shell(`
    <h2 style="margin:0 0 6px;font-size:20px">✅ تم استلام الدفع</h2>
    <p style="margin:0 0 14px">
      طلبك <b style="direction:ltr;display:inline-block">${esc(orderNumber)}</b> — ${esc(productName)}
    </p>
    <div style="background:#fbf2e2;border-radius:12px;padding:14px;color:#8a5d12">
      ⏱️ هذا المنتج يحتاج تفعيلاً يدوياً. سنفعّله خلال <b>1–3 ساعات</b> ونرسله على هذا البريد.
    </div>
    <p style="margin:16px 0 0;font-size:13px;color:#6b7883">لا حاجة لأي إجراء منك. سنراسلك فور جاهزيته.</p>
    ${trackButton(orderNumber, to)}`);

  return sendEmail({ to, subject: `تم استلام الدفع — ${orderNumber} | ProSkill`, html });
}

/** Something went wrong after payment. Reassure, don't scare. */
export async function emailDeliveryIssue({ to, orderNumber, productName }) {
  const html = shell(`
    <h2 style="margin:0 0 6px;font-size:20px">تم استلام دفعتك ✅</h2>
    <p style="margin:0 0 14px">
      طلبك <b style="direction:ltr;display:inline-block">${esc(orderNumber)}</b> — ${esc(productName)}
    </p>
    <div style="background:#fbeaea;border-radius:12px;padding:14px;color:#a3342a">
      واجهنا تأخيراً بسيطاً في التسليم الآلي. فريقنا يراجع طلبك الآن وسنرسله خلال دقائق.
      <b>لا تدفع مرة أخرى.</b>
    </div>
    <p style="margin:16px 0 0;font-size:13px;color:#6b7883">نعتذر عن الانتظار — أموالك ومنتجك مضمونان.</p>
    ${trackButton(orderNumber, to)}`);

  return sendEmail({ to, subject: `نراجع طلبك — ${orderNumber} | ProSkill`, html });
}

// ----------------------------------------------------------------- admin
export async function notifyAdmin(text) {
  const token = process.env.BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_ID;

  const jobs = [];

  if (token && chatId) {
    // Bounded: this now runs inside checkout, where a customer is waiting for
    // their transfer instructions. An unreachable Telegram must not stall them.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    jobs.push(
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? true : Promise.reject(new Error(`tg ${r.status}`))))
        .catch((e) => console.error('telegram notify failed:', e.message))
        .finally(() => clearTimeout(timer))
    );
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    jobs.push(
      sendEmail({
        to: adminEmail,
        subject: 'ProSkill Store — إشعار طلب',
        html: `<pre style="font-family:system-ui;font-size:14px;white-space:pre-wrap">${esc(
          text.replace(/<[^>]+>/g, '')
        )}</pre>`,
      })
    );
  }

  await Promise.allSettled(jobs);
}

export function adminOrderMessage({ status, orderNumber, productName, quantity, total, email, note }) {
  const head =
    status === 'delivered' ? '✅ <b>طلب جديد — تم التسليم</b>'
    : status === 'manual_pending' ? '⏱️ <b>طلب يحتاج تفعيل يدوي</b>'
    : '🚨 <b>طلب فشل تسليمه — تدخّل فوراً</b>';

  return [
    head,
    '',
    `🧾 <code>${esc(orderNumber)}</code>`,
    `📦 ${esc(productName)} × ${quantity}`,
    `💵 $${Number(total).toFixed(2)}`,
    `📧 ${esc(email)}`,
    note ? `📝 ${esc(note)}` : '',
    '',
    `${SITE}/admin`,
  ]
    .filter(Boolean)
    .join('\n');
}


// ----------------------------------------------------------------- stock
/**
 * Warns the owner when an own-stock instant product runs low or dries up.
 * Called after every successful own-stock delivery, so the alert arrives at the
 * moment the stock actually drops — not on a nightly cron the next morning.
 */
export async function checkStockLevel(supabase, product) {
  if (!product || product.source === 'vendor' || product.delivery_speed !== 'instant') return;

  const { count, error } = await supabase
    .from('stock_items')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', product.id)
    .eq('status', 'available');

  if (error) {
    console.error('stock level check failed:', error.message);
    return;
  }

  const left = count ?? 0;
  if (left > 3) return; // healthy

  // Out of stock: hide it so nobody can pay for what we cannot deliver.
  if (left === 0) {
    await supabase
      .from('products')
      .update({ store_visible: false, is_active: false, updated_at: new Date().toISOString() })
      .eq('id', product.id);

    await notifyAdmin(
      [
        '🔴 <b>نفد المخزون — أُخفي المنتج تلقائياً</b>',
        '',
        `📦 ${product.name}`,
        '',
        'المنتج الآن مخفي من الموقع والبوت. أضف أكواداً ثم فعّله.',
        `${SITE}/admin`,
      ].join('\n')
    );
    return;
  }

  await notifyAdmin(
    [
      '🟠 <b>المخزون على وشك النفاد</b>',
      '',
      `📦 ${product.name}`,
      `📉 المتبقّي: <b>${left}</b>`,
      '',
      'أضف أكواداً قبل أن ينفد.',
      `${SITE}/admin`,
    ].join('\n')
  );
}


/**
 * After a vendor sale, check whether our wallet with that vendor is running low
 * and warn early — long before a customer hits an empty balance.
 * Vendors that don't report a balance on purchase are simply skipped.
 */
export async function checkVendorBalance(supabase, vendorCode, newBalance) {
  if (newBalance == null || !Number.isFinite(Number(newBalance))) return;

  const { data } = await supabase
    .from('store_settings')
    .select('value')
    .eq('key', 'low_balance_threshold')
    .maybeSingle();

  const threshold = Number(data?.value ?? 10);
  const balance = Number(newBalance);
  if (balance >= threshold) return;

  await notifyAdmin(
    [
      balance <= 0 ? '🔴 <b>رصيدك عند الفيندور نفد</b>' : '🟠 <b>رصيدك عند الفيندور منخفض</b>',
      '',
      `🏪 ${vendorCode}`,
      `💰 المتبقّي: <b>$${balance.toFixed(2)}</b>`,
      `⚠️ حد التنبيه: $${threshold.toFixed(2)}`,
      '',
      'اشحن الآن حتى لا تتعطّل الطلبات القادمة.',
    ].join('\n')
  );
}

/**
 * The finished CV.
 *
 * Without this the result exists only on a page the customer has to keep open —
 * close the tab and a paid order is effectively gone. The CV goes in the body
 * rather than as an attachment so it survives any mail client, and the link
 * back carries the email so one tap reopens the full result with its report.
 */
export async function emailCvReady({ to, orderNumber, targetRole, cv, matchScore, cvStrength }) {
  const link = `${SITE}/cv/${encodeURIComponent(orderNumber)}?e=${encodeURIComponent(String(to || '').toLowerCase())}`;

  const html = shell(`
    <h2 style="margin:0 0 6px;font-size:20px">✅ سيرتك الذاتية جاهزة</h2>
    <p style="margin:0 0 18px;color:#6b7883">
      أُعيدت صياغتها لتعبر أنظمة الفرز الآلي (ATS)${targetRole ? ` — لوظيفة: ${esc(targetRole)}` : ''}.
    </p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
      <tr><td style="padding:6px 0;color:#6b7883">رقم الطلب</td>
          <td style="padding:6px 0;font-weight:700;direction:ltr;text-align:left">${esc(orderNumber)}</td></tr>
      ${Number.isFinite(Number(matchScore))
        ? `<tr><td style="padding:6px 0;color:#6b7883">نسبة المطابقة</td>
             <td style="padding:6px 0;font-weight:700;text-align:left">${Number(matchScore)}%</td></tr>`
        : Number.isFinite(Number(cvStrength))
          ? `<tr><td style="padding:6px 0;color:#6b7883">قوة السيرة</td>
               <td style="padding:6px 0;font-weight:700;text-align:left">${Number(cvStrength)}%</td></tr>`
          : ''}
    </table>

    <p style="margin:0 0 18px">
      <a href="${link}"
         style="display:inline-block;background:#2f7d78;color:#fff;text-decoration:none;
                font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">
        عرض السيرة والتقرير كاملاً
      </a>
    </p>
    <p style="margin:0 0 18px;font-size:12px;color:#6b7883">
      من الصفحة يمكنك تحميل السيرة بصيغة <b>Word</b> (قابلة للتعديل) أو حفظها <b>PDF</b>،
      كما يوضّح التقرير الكلمات المفتاحية الناقصة ونسبة المطابقة وما ينقص سيرتك من معلومات.
    </p>

    <div style="font-size:13px;color:#6b7883;margin-bottom:6px">نص السيرة</div>
    <div style="background:#f5f7f8;border:1px solid #e7ebee;border-radius:12px;padding:16px;
                white-space:pre-wrap;font-size:13px;line-height:1.75;color:#12212e">${esc(cv)}</div>

    <p style="margin:18px 0 0;font-size:12.5px;color:#6b7883">
      هذه صياغة قوية جاهزة للاستخدام — راجعها وأضف أي معلومة تخصّك قبل الإرسال.
      تحتاج مراجعة بشرية أو تصميم نهائي؟ راسلنا على واتساب برقم الطلب.
    </p>`);

  return sendEmail({ to, subject: `سيرتك الذاتية جاهزة — ${orderNumber} | ProSkill`, html });
}

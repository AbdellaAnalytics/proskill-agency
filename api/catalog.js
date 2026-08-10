// ============================================================================
// GET /api/catalog
// Returns the public catalog with LIVE vendor stock.
//
// Why server-side: vendor API keys must never reach the browser, and the
// vendor catalogs must be fetched with secrets. Cached 60s at the edge.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { getRates } from './_lib/fx.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const VENDOR_API_URL = process.env.VENDOR_API_URL || '';
const VENDOR_API_KEY = process.env.VENDOR_API_KEY || '';
const SUBNOVA_API_URL = process.env.SUBNOVA_API_URL || 'https://subnovaa.com/api/cdk';
const SUBNOVA_API_KEY = process.env.SUBNOVA_API_KEY || '';
const VEX_API_URL = process.env.VEX_API_URL || '';
const VEX_API_KEY = process.env.VEX_API_KEY || '';

// --- simple in-memory cache (per warm lambda) -------------------------------
let vendorCache = { at: 0, map: null };
const TTL = 5 * 60 * 1000;

async function fetchJson(url, headers, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Map of `${vendor_code}:${vendor_product_id}` -> live stock number. */
async function getVendorStock() {
  if (vendorCache.map && Date.now() - vendorCache.at < TTL) return vendorCache.map;

  const map = new Map();

  if (VENDOR_API_URL && VENDOR_API_KEY) {
    try {
      const data = await fetchJson(`${VENDOR_API_URL}/products`, {
        Authorization: `Bearer ${VENDOR_API_KEY}`,
      });
      for (const p of data.products ?? []) {
        const stock = p.stock === 'unlimited' ? 999 : Number(p.stock) || 0;
        map.set(`shopbot:${p.id}`, stock);
      }
    } catch (e) {
      console.error('shopbot catalog error:', e.message);
    }
  }

  if (SUBNOVA_API_KEY) {
    try {
      const data = await fetchJson(`${SUBNOVA_API_URL}/services`, {
        'X-API-Key': SUBNOVA_API_KEY,
        Accept: 'application/json',
      });
      for (const s of data.services ?? []) {
        if (!s.is_active) continue;
        map.set(`subnova:${s.id}`, Number(s.qty) || 0);
      }
    } catch (e) {
      console.error('subnova catalog error:', e.message);
    }
  }

  if (VEX_API_URL && VEX_API_KEY) {
    try {
      const data = await fetchJson(`${VEX_API_URL}?action=products`, {
        Authorization: `Bearer ${VEX_API_KEY}`,
        Accept: 'application/json',
      });
      // Response shape is not fully documented: accept an array or {products:[]}
      const list = Array.isArray(data) ? data : (data.products ?? data.data ?? []);
      for (const p of list) {
        if (!p?.id) continue;
        // Manual-delivery items are always orderable; stock only gates instant ones.
        const stock = p.manual_delivery ? 999 : Number(p.stock) || 0;
        map.set(`vex:${p.id}`, stock);
      }
    } catch (e) {
      console.error('vex catalog error:', e.message);
    }
  }

  vendorCache = { at: Date.now(), map };
  return map;
}

export default async function handler(req, res) {
  // ── Chat bot lives here as a POST branch so it doesn't consume a 12th
  // serverless function. GET below is the normal catalog. ──────────────────
  if (req.method === 'POST') {
    return chatHandler(req, res);
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // The offer column is asked for optimistically. Before store_sale_price.sql
  // has been run it does not exist and PostgREST rejects the WHOLE select —
  // which is not "no offers", it is an empty storefront. Ask again without it.
  const CATALOG_COLS =
    'id, name, slug, emoji, price_usd, delivery_speed, delivery_type, warranty_days, ' +
      'description, description_ar, store_description, store_description_ar, image_url, is_featured, '+
      'activation_note, activation_note_ar, ' +
      'source, vendor_code, vendor_product_id, category_id';

  let { data: rows, error } = await supabase
    .from('products')
    .select(`${CATALOG_COLS}, sale_price_usd`)
    .eq('is_active', true)
    .eq('store_visible', true)
    .order('is_featured', { ascending: false })
    .order('sort_order', { ascending: true })
    // Without a final tiebreaker, rows sharing a sort_order can come back in a
    // different order on each request and the grid quietly reshuffles itself.
    .order('id', { ascending: true });

  if (error) {
    console.warn('catalog: sale_price_usd missing — run store_sale_price.sql');
    ({ data: rows, error } = await supabase
      .from('products')
      .select(CATALOG_COLS)
      .eq('is_active', true)
      .eq('store_visible', true)
      .order('is_featured', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }));
  }

  if (error) {
    console.error('catalog query error:', error);
    res.status(500).json({ error: 'Could not load catalog' });
    return;
  }

  // Everything below depends only on the product list, not on each other — so
  // fetch them concurrently instead of one-await-at-a-time. This turns the
  // endpoint's DB time from "sum of all queries" into "the slowest one".
  const needsVendor = (rows ?? []).some((p) => p.source === 'vendor');
  const ownInstantIds = (rows ?? [])
    .filter((p) => p.source !== 'vendor' && p.delivery_speed === 'instant')
    .map((p) => p.id);

  const [vendorStock, ownStockRows, ratings, cats, services] = await Promise.all([
    // 1) vendor stock (only if any vendor product is present)
    needsVendor ? getVendorStock().catch(() => new Map()) : Promise.resolve(new Map()),
    // 2) own instant stock counts
    ownInstantIds.length > 0
      ? supabase.from('stock_items').select('product_id').in('product_id', ownInstantIds).eq('status', 'available')
          .then((r) => r.data ?? []).catch(() => [])
      : Promise.resolve([]),
    // 3) ratings (independent)
    supabase.from('product_ratings').select('product_id, avg_rating, review_count')
      .then((r) => r.data ?? []).catch(() => []),
    // 4) categories (independent)
    supabase.from('categories').select('id, name, emoji').eq('is_active', true)
      .order('sort_order', { ascending: true })
      .then((r) => r.data ?? []).catch(() => []),
    // 5) career services (independent; must never break the catalogue)
    supabase.from('ps_services')
      .select('id, title, title_ar, description, description_ar, icon, image_url, price_usd, wa_message, sort_order')
      .eq('is_active', true).order('sort_order', { ascending: true })
      .then((r) => r.data ?? []).catch(() => []),
  ]);

  const ownStock = new Map();
  for (const r of ownStockRows) {
    ownStock.set(r.product_id, (ownStock.get(r.product_id) ?? 0) + 1);
  }

  const products = (rows ?? []).map((p) => {
    let stock_count;
    if (p.source === 'vendor') {
      const code = ['subnova', 'vex'].includes(p.vendor_code) ? p.vendor_code : 'shopbot';
      stock_count = vendorStock.get(`${code}:${p.vendor_product_id}`) ?? 0;
    } else if (p.delivery_speed === 'instant') {
      stock_count = ownStock.get(p.id) ?? 0;
    } else {
      stock_count = 999;
    }

    // Never leak vendor identity to the browser
    const { source, vendor_code, vendor_product_id, ...safe } = p;

    // Ensure every product has a shareable slug for /p/<slug> deep links, even
    // if one was never saved. Derived from the name + a short id suffix so it's
    // always unique and URL-safe (Arabic names fall back to the id).
    if (!safe.slug) {
      const base = String(p.name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      safe.slug = base ? `${base}-${String(p.id).slice(0, 6)}` : String(p.id);
    }

    return { ...safe, stock_count };
  });

  // Attach published-review ratings (empty for new products).
  const rmap = new Map((ratings ?? []).map((r) => [r.product_id, r]));
  for (const p of products) {
    const r = rmap.get(p.id);
    p.avg_rating = r ? Number(r.avg_rating) : null;
    p.review_count = r ? r.review_count : 0;
  }

  // Give every category a URL-safe slug for /c/<slug> landing pages. Derived
  // here rather than read from a column, so no migration is required and a
  // missing column can't break the catalogue.
  const categories = (cats ?? []).map((c) => {
    const base = String(c.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return { ...c, slug: base ? `${base}-${String(c.id).slice(0, 6)}` : String(c.id) };
  });

  res.status(200).json({ products, categories, services });
}

// ============================================================================
// POST /api/catalog  → AI chat bot (Gemini 2.5 Flash)
//
// Only FREE-TEXT questions reach here; the FAQ buttons are answered client-side
// with zero AI cost. The Gemini key stays server-side. When the model is unsure
// or anything fails, we fall back to the WhatsApp support link — never a wrong
// answer about codes, prices, or refunds.
// ============================================================================

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const SUPPORT_WA = 'https://wa.me/201500568788';

// Best-effort per-IP rate limit. In-memory → resets on cold start and is
// per-instance; it's a cheap spam backstop, not a hard guarantee. The client
// also caps messages per session.
const RL = new Map(); // ip -> { count, resetAt }
const RL_MAX = 8; // messages — catches abusers who reopen to bypass the session cap
const RL_WINDOW = 10 * 60 * 1000; // per 10 minutes

function rateLimited(ip) {
  const now = Date.now();
  const rec = RL.get(ip);
  if (!rec || now > rec.resetAt) {
    RL.set(ip, { count: 1, resetAt: now + RL_WINDOW });
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

// ---------------------------------------------------------------------------
// Live catalogue for the assistant.
//
// Without this the bot can only say "check the product page", which is exactly
// the answer a customer opened the chat to avoid. Feeding it the real rows
// makes the prices it quotes grounded rather than invented — and the rule
// below still forbids anything not on this list.
//
// Cached in memory: the chat is rate-limited per IP, but a burst of questions
// shouldn't mean a burst of catalogue queries.
// ---------------------------------------------------------------------------
let CATALOG_CACHE = { text: null, at: 0 };
const CATALOG_TTL = 5 * 60 * 1000;

async function catalogFacts(supabase) {
  if (CATALOG_CACHE.text && Date.now() - CATALOG_CACHE.at < CATALOG_TTL) {
    return CATALOG_CACHE.text;
  }

  let text = '';
  try {
    const [{ data: rows }, fx] = await Promise.all([
      supabase
        .from('products')
        .select('name, price_usd, delivery_speed, warranty_days, categories(name)')
        .eq('is_active', true).eq('store_visible', true)
        .order('sort_order', { ascending: true })
        .limit(80),
      getRates().catch(() => null),
    ]);

    const eff = fx ? Number(fx.rates?.EGP) * (1 + Number(fx.markup) / 100) : null;

    const lines = (rows ?? []).map((p) => {
      const usd = Number(p.price_usd) || 0;
      const egp = eff && eff > 0 ? `${Math.ceil(usd * eff)} ج.م` : null;
      const price = egp ? `${egp} (~$${usd.toFixed(2)})` : `$${usd.toFixed(2)}`;
      const speed = p.delivery_speed === 'instant' ? 'فوري' : 'خلال 1-3 ساعات';
      const warranty = p.warranty_days ? ` · ضمان ${p.warranty_days} يوم` : '';
      const cat = p.categories?.name ? ` · ${p.categories.name}` : '';
      return `- ${p.name}: ${price} · تسليم ${speed}${warranty}${cat}`;
    });

    if (lines.length) text = lines.join('\n');
  } catch (e) {
    console.error('catalog facts skipped:', e.message);
  }

  CATALOG_CACHE = { text, at: Date.now() };
  return text;
}

const SYSTEM_AR = `أنت مساعد خدمة عملاء لمتجر "ProSkill" — متجر مصري لبيع الاشتراكات الرقمية الأصلية (ChatGPT، Adobe، Canva، LinkedIn، Netflix وغيرها) بأكواد وحسابات رسمية.
حقائق المتجر:
- التسليم: المنتجات الفورية توصل على الشاشة والإيميل فورًا بعد الدفع. منتجات أخرى تتفعّل خلال 1-3 ساعات.
- الدفع: كروت بنكية، محافظ إلكترونية، فوري، تقسيط (أمان/الأهلي)، Apple Pay.
- الضمان: كل منتج عليه فترة ضمان موضّحة في صفحته.
- الطلب: العميل يطلب مباشرة من الموقع؛ بعد الدفع يظهر الكود في صفحة الطلب ويُرسل على الإيميل.
- الدعم البشري على واتساب: ${SUPPORT_WA}
قواعد مهمة:
- رد بالعربي المصري، بوضوح وبشكل مفيد وكامل. **اذكر التفاصيل الفعلية** من حقائق المتجر (مثلاً اسمِّ طرق الدفع بالاسم، وقُل مدة التسليم بالظبط) بدل ردود عامة مطاطة مثل "عندنا طرق كتيرة". خلّي الرد موجزًا (حتى 4 جمل قصيرة) لكن يجاوب السؤال فعليًا.
- إن سُئلت عن سعر أو تفاصيل منتج، اقرأ من "قائمة المنتجات" المرفقة أدناه واذكر السعر ومدة التسليم والضمان بالظبط. لا تخترع أي منتج أو سعر غير موجود في القائمة؛ لو المنتج مش فيها قُل إنه غير متاح حاليًا ووجّهه للدعم. لا تخترع أكوادًا أو أرقام مخزون أبدًا.
- لأي مشكلة في طلب مدفوع، أو استرجاع، أو شكوى، أو طلب لم يصل → وجّهه لواتساب الدعم مباشرة.
- لو مش متأكد من الإجابة → قُل إنك ستحوّله للدعم على واتساب ${SUPPORT_WA} بدل ما تخمّن.
- ردّ بإجابة واحدة نهائية جاهزة للعميل مباشرة. ممنوع تمامًا أن تكتب مسودّات أو عناوين مثل "مسودّة" أو "Draft" أو "خيار 1/2" أو "نسخة أدق" أو أي صيغة داخلية — العميل يرى الرد كما هو.`;

const SYSTEM_EN = `You are a customer-support assistant for "ProSkill", an Egyptian store selling genuine digital subscriptions (ChatGPT, Adobe, Canva, LinkedIn, Netflix and more) as official codes/accounts.
Store facts:
- Delivery: instant products arrive on-screen and by email right after payment; some products activate within 1-3 hours.
- Payment: bank cards, e-wallets, Fawry, installments (Aman/NBE), Apple Pay.
- Warranty: every product has a warranty stated on its page.
- Ordering: buy directly on the site; after payment the code shows on the order page and is emailed.
- Human support on WhatsApp: ${SUPPORT_WA}
Rules:
- Reply in English, clearly and helpfully. **State the actual details** from the store facts (e.g. name the payment methods, give the exact delivery timing) instead of vague answers like "we have many options". Keep it concise (up to 4 short sentences) but actually answer the question.
- For a price or product question, read the "Product list" attached below and state the exact price, delivery time and warranty. Never invent a product or a price that isn't on that list; if it isn't there, say it isn't available right now and point them to support. Never invent codes or stock numbers.
- For any paid-order issue, refund, complaint, or missing order → send them to WhatsApp support.
- If unsure → say you'll connect them to WhatsApp support ${SUPPORT_WA} instead of guessing.
- Reply with ONE final answer ready for the customer. Never write drafts, options, or labels like "Draft", "Draft 2", "Option 1/2", "More precise", or any internal formatting — the customer sees the reply as-is.`;

async function chatHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!GEMINI_KEY) {
    return res.status(200).json({ reply: null, fallback: true, reason: 'no_key' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ reply: null, fallback: true, limited: true, reason: 'rate_limited' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const lang = body?.lang === 'en' ? 'en' : 'ar';
  const message = String(body?.message || '').slice(0, 500).trim();
  const history = Array.isArray(body?.history) ? body.history.slice(-6) : [];

  if (!message) {
    return res.status(400).json({ reply: null, fallback: true, reason: 'empty_message' });
  }

  // Build Gemini "contents": prior turns + the new user message.
  const contents = [];
  for (const m of history) {
    const role = m?.role === 'bot' ? 'model' : 'user';
    const text = String(m?.text || '').slice(0, 500);
    if (text) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  // Model names differ by key generation, and a single hard-coded id can 404
  // on some keys (as it did here). Try a short ordered list and use the first
  // that answers — 'gemini-flash-latest' is an always-current alias fallback.
  const MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];

  // Attach the real catalogue so answers about price, delivery and warranty
  // come from the database instead of a polite deflection.
  // Missing credentials must not break the chat — the bot simply answers
  // without the catalogue instead of throwing.
  const products = (SUPABASE_URL && SERVICE_KEY)
    ? await catalogFacts(createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }))
    : '';
  const system = (lang === 'en' ? SYSTEM_EN : SYSTEM_AR)
    + (products ? `\n\n${lang === 'en' ? 'Product list' : 'قائمة المنتجات'} (${lang === 'en' ? 'authoritative — quote from this only' : 'المصدر الوحيد للأسعار — لا تخرج عنها'}):\n${products}` : '');

  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents,
    // 300 cut Arabic replies mid-sentence — Arabic costs more tokens per word,
    // so a "short" answer still needs headroom.
    generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
  });

  let lastReason = 'unknown';
  let lastDetail = '';
  try {
    for (const model of MODELS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ctrl.signal,
            body: payload,
          }
        );
      } finally {
        clearTimeout(timer);
      }

      if (!r.ok) {
        const detail = (await r.text().catch(() => '')).slice(0, 300);
        lastReason = `gemini_${r.status}`;
        lastDetail = detail;
        // 404 = this model id isn't available to the key → try the next one.
        // Any other error (bad key, disabled API, quota) won't be fixed by a
        // different model, so stop and report it.
        if (r.status === 404) continue;
        console.error('gemini http', r.status, detail);
        return res.status(200).json({ reply: null, fallback: true, reason: lastReason, detail });
      }

      const data = await r.json();
      const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
      if (reply) {
        return res.status(200).json({ reply });
      }
      lastReason = 'no_candidate';
      lastDetail = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'none';
    }
    // Every model was tried without a usable answer.
    return res.status(200).json({ reply: null, fallback: true, reason: lastReason, detail: lastDetail });
  } catch (e) {
    console.error('chat error:', e.message);
    return res.status(200).json({ reply: null, fallback: true, reason: 'exception', detail: e.message });
  }
}

// ============================================================================
// Serves the SPA shell with REAL per-page meta injected.
//   /p/<slug>  → a product page
//   /c/<slug>  → a category landing page
//
// Why this exists:
// The app is client-rendered, so every route used to serve the same index.html.
// That meant every product page told Google `canonical = "/"` — i.e. "I am a
// duplicate of the homepage, don't index me". No product page could ever rank.
// It also meant sharing a product link on Facebook showed the generic store
// name instead of the product, which quietly hurts ad click-through.
//
// Crawlers read the HTML they're served, before any JS runs. So we look the
// product up here and rewrite the <head> tags before sending. React then
// hydrates as normal — the user sees no difference.
// ============================================================================

import { supabaseAdmin, effectivePrice } from './_lib/server.js';

const SITE = (process.env.SITE_URL || 'https://store.proskillagency.com').replace(/\/$/, '');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mirrors the slug fallback in catalog.js / sitemap.js. */
function slugFor(p) {
  if (p.slug) return p.slug;
  const base = String(p.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `${base}-${String(p.id).slice(0, 6)}` : String(p.id);
}

/** Category slug — must match the one derived in catalog.js. */
function catSlugFor(c) {
  const base = String(c.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `${base}-${String(c.id).slice(0, 6)}` : String(c.id);
}

/** First ~155 chars of the description, cleaned for a meta tag. */
function metaDescription(p) {
  const raw = (p.store_description || p.description || '')
    .replace(/[•✨🔗⏱️🔒💬📦👥📚⭐🎯💼🚀]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (raw.length <= 20) {
    return `اشترِ ${p.name} بسعر مميز من ProSkill — اشتراك رسمي، تسليم مضمون، ودعم فني.`;
  }
  if (raw.length <= 155) return raw;

  // Cut on a word boundary — a description ending mid-word ("ما ستحصل ع")
  // looks broken in a search result.
  const cut = raw.slice(0, 155);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).replace(/[،,.\s]+$/, '') + '…';
}

export default async function handler(req, res) {
  const slug = String(req.query.slug || '');
  const origin = `https://${req.headers.host}`;

  // Fetch the SPA shell as it was built (hashed asset paths and all).
  let html;
  try {
    const r = await fetch(`${origin}/index.html`);
    html = await r.text();
  } catch (e) {
    console.error('/p: could not load shell:', e.message);
    return res.redirect(302, '/');
  }

  // Set before any branch returns — every path below sends HTML.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // ---- Category landing page -------------------------------------------
  // These exist so a search like "اشتراكات تصميم" has a page to land on.
  // Without them the categories are client-side filters with no URL, and
  // nothing can rank for them.
  // ---- CV service landing page ---------------------------------------------
  // Without this, /cv inherits the shop's generic homepage tags — so the one
  // page that sells the highest-margin service says nothing about it.
  //
  // It matters twice over now. Search crawlers render JavaScript and would
  // eventually see the page; the crawlers behind AI assistants generally do
  // not. For those, these tags and this schema ARE the page.
  if (req.query.type === 'cv') {
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');

    let price = null;
    try {
      const supabase = supabaseAdmin();
      const { data } = await supabase
        .from('store_settings').select('value').eq('key', 'cv_price_usd').maybeSingle();
      const n = Number(data?.value);
      if (Number.isFinite(n) && n > 0) price = n;
    } catch {
      /* a price is a nice-to-have here; the page is not */
    }

    const title = 'سيرة ذاتية احترافية بالذكاء الاصطناعي — متوافقة مع ATS | ProSkill';
    const desc = 'ارفع سيرتك الذاتية والصق إعلان الوظيفة، واستلم خلال دقيقة نسخة معاد صياغتها لتعبر أنظمة فرز المرشحين ATS، مع تقرير بنسبة المطابقة والكلمات المفتاحية الناقصة. سبع لغات، وتحميل Word و PDF.';
    const url = `${SITE}/cv`;

    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: 'إعداد سيرة ذاتية متوافقة مع ATS بالذكاء الاصطناعي',
      serviceType: 'CV writing and ATS optimisation',
      description: desc,
      areaServed: 'EG',
      availableLanguage: ['ar', 'en'],
      provider: {
        '@type': 'Organization',
        name: 'ProSkill Digital Agency',
        url: SITE,
      },
      ...(price
        ? {
            offers: {
              '@type': 'Offer',
              url,
              price: price.toFixed(2),
              priceCurrency: 'USD',
              availability: 'https://schema.org/InStock',
            },
          }
        : {}),
    };

    let html = '';
    try {
      const r = await fetch(`${SITE}/index.html`);
      html = await r.text();
    } catch {
      // '/', not '/cv'. /cv is rewritten to THIS function, so redirecting
      // there sends the browser straight back in — a loop that ends in
      // ERR_TOO_MANY_REDIRECTS, on the page that sells the highest-margin
      // service, triggered by nothing worse than one failed fetch.
      return res.redirect(302, '/');
    }

    const inject = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <link rel="canonical" href="${esc(url)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${esc(url)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(desc)}" />
    <script type="application/ld+json">${JSON.stringify(schema)}</script>
  `;

    const out = html
      .replace(/<title>[\s\S]*?<\/title>/, '')
      .replace(/<meta name="description"[^>]*>/, '')
      .replace(/<link rel="canonical"[^>]*>/, '')
      .replace(/<meta property="og:[^"]*"[^>]*>/g, '')
      .replace(/<meta name="twitter:[^"]*"[^>]*>/g, '')
      .replace('</head>', `${inject}</head>`);

    return res.status(200).send(out);
  }

  if (req.query.type === 'c') {
    try {
      const supabase = supabaseAdmin();
      const { data: cats } = await supabase
        .from('categories')
        .select('id, name, emoji')
        .eq('is_active', true);

      const cat = (cats ?? []).find((c) => catSlugFor(c) === slug);
      if (!cat) {
        res.setHeader('Cache-Control', 's-maxage=60');
        return res.status(404).send(
          html.replace('</head>', '  <meta name="robots" content="noindex" />\n  </head>')
        );
      }

      const { data: items } = await supabase
        .from('products')
        .select('id, name, slug, price_usd')
        .eq('category_id', cat.id)
        .eq('is_active', true)
        .eq('store_visible', true)
        .limit(50);

      const list = items ?? [];
      const catUrl = `${SITE}/c/${catSlugFor(cat)}`;
      const names = list.slice(0, 5).map((p) => p.name).join(' · ');
      const catTitle = `${cat.name} — اشتراكات أصلية بأفضل الأسعار | ProSkill`;
      const catDesc = list.length
        ? `اشترِ اشتراكات ${cat.name} من ProSkill: ${names}. تسليم مضمون، أسعار مميزة، ودعم فني.`.slice(0, 155)
        : `اشتراكات ${cat.name} الأصلية من ProSkill — تسليم مضمون وأسعار مميزة.`;

      // ItemList tells Google what's on the page; BreadcrumbList shows the
      // path under the result instead of a bare URL.
      const catSchema = [
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: SITE },
            { '@type': 'ListItem', position: 2, name: cat.name, item: catUrl },
          ],
        },
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: cat.name,
          numberOfItems: list.length,
          itemListElement: list.map((p, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${SITE}/p/${slugFor(p)}`,
            name: p.name,
          })),
        },
      ];

      const catHead = `
    <title>${esc(catTitle)}</title>
    <meta name="description" content="${esc(catDesc)}" />
    <link rel="canonical" href="${esc(catUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ProSkill Store" />
    <meta property="og:title" content="${esc(catTitle)}" />
    <meta property="og:description" content="${esc(catDesc)}" />
    <meta property="og:url" content="${esc(catUrl)}" />
    <meta property="og:image" content="${SITE}/og-default.png" />
    <meta property="og:locale" content="ar_EG" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">${JSON.stringify(catSchema)}</script>
  `;

      const catOut = html
        .replace(/<title>[\s\S]*?<\/title>/, '')
        .replace(/<meta name="description"[^>]*>/, '')
        .replace(/<meta name="keywords"[^>]*>/, '')
        .replace(/<link rel="canonical"[^>]*>/, '')
        .replace(/<meta property="og:[^"]*"[^>]*>/g, '')
        .replace(/<meta name="twitter:[^"]*"[^>]*>/g, '')
        .replace('</head>', `${catHead}\n  </head>`);

      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
      return res.status(200).send(catOut);
    } catch (e) {
      console.error('/c: failed:', e.message);
      return res.status(200).send(html);
    }
  }

  // ---- Product page ------------------------------------------------------
  // Look the product up. A miss still serves the app — the client router will
  // show the storefront rather than a hard error.
  let product = null;
  // Filled only when the product has real published reviews.
  let rating = null;
  try {
    const supabase = supabaseAdmin();
    // sale_price_usd asked for optimistically — before store_sale_price.sql it
    // doesn't exist, and a failed select here would strip every product page of
    // its tags. Falling back costs the offer price in the schema; failing costs
    // the whole page's SEO.
    const P_COLS = 'id, name, slug, price_usd, image_url, emoji, store_description, description, delivery_speed';
    let { data, error } = await supabase
      .from('products')
      .select(`${P_COLS}, sale_price_usd`)
      .eq('is_active', true)
      .eq('store_visible', true)
      .limit(200);
    if (error) {
      ({ data } = await supabase
        .from('products').select(P_COLS)
        .eq('is_active', true).eq('store_visible', true).limit(200));
    }

    product = (data ?? []).find((p) => slugFor(p) === slug) || null;

    // The rating, for the stars in the results page.
    //
    // Only ever emitted when real published reviews exist. Google treats an
    // aggregateRating with nothing behind it as deceptive markup, and the
    // penalty is the whole site's rich results — so no reviews means no rating
    // block at all, never a default of five.
    if (product) {
      const { data: rv } = await supabase
        .from('reviews')
        .select('rating')
        .eq('product_id', product.id)
        .eq('is_published', true)
        .limit(500);
      const ratings = (rv ?? []).map((r) => Number(r.rating)).filter((n) => n >= 1 && n <= 5);
      if (ratings.length > 0) {
        rating = {
          value: (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1),
          count: ratings.length,
        };
      }
    }
  } catch (e) {
    console.error('/p: product lookup failed:', e.message);
  }

  if (!product) {
    // Unknown slug: don't let it be indexed as a thin duplicate.
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(404).send(
      html.replace('</head>', '  <meta name="robots" content="noindex" />\n  </head>')
    );
  }

  const url = `${SITE}/p/${slugFor(product)}`;
  const title = `${product.name} — اشتراك أصلي بأفضل سعر | ProSkill`;
  const desc = metaDescription(product);
  const image = product.image_url || `${SITE}/og-default.png`;

  // Product schema lets Google show price and availability in results.
  const schema = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.name,
    description: desc,
    image: image ? [image] : undefined,
    brand: { '@type': 'Brand', name: 'ProSkill' },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'USD',
      // What a buyer is actually charged today — the same rule the storefront
      // and the checkout use. Quoting the list price while an offer runs puts a
      // number in Google that the shop will not honour, which is both a bad
      // click and a structured-data policy problem.
      price: Number(effectivePrice(product) ?? product.price_usd).toFixed(2),
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: 'ProSkill Digital Agency' },
    },
    ...(rating
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: rating.value,
            reviewCount: rating.count,
            bestRating: '5',
            worstRating: '1',
          },
        }
      : {}),
  };

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: SITE },
      { '@type': 'ListItem', position: 2, name: product.name, item: url },
    ],
  };

  const head = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <link rel="canonical" href="${esc(url)}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="ProSkill Store" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${esc(url)}" />
    <meta property="og:image" content="${esc(image)}" />
    <meta property="og:locale" content="ar_EG" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(desc)}" />
    <meta name="twitter:image" content="${esc(image)}" />
    <meta property="product:price:amount" content="${esc(Number(effectivePrice(product) ?? product.price_usd).toFixed(2))}" />
    <meta property="product:price:currency" content="USD" />
    <script type="application/ld+json">${JSON.stringify(schema)}</script>
    <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
  `;

  // Strip the generic tags, then insert the product-specific ones.
  const out = html
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace(/<meta name="keywords"[^>]*>/, '')
    .replace(/<link rel="canonical"[^>]*>/, '')
    .replace(/<meta property="og:[^"]*"[^>]*>/g, '')
    .replace(/<meta name="twitter:[^"]*"[^>]*>/g, '')
    .replace('</head>', `${head}\n  </head>`);

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  res.status(200).send(out);
}

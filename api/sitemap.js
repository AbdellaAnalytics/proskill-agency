// ============================================================================
// GET /sitemap.xml — generated from the live catalogue.
//
// The old static file listed only 6 pages and pointed at the previous
// vercel.app domain, which contradicted the canonical tag and told Google the
// wrong home. This builds the sitemap from the database instead, so every
// visible product gets a /p/<slug> entry the moment it goes live.
// ============================================================================

import { supabaseAdmin } from './_lib/server.js';

// A sitemap must list the CANONICAL domain. If SITE_URL is left pointing at a
// vercel.app host, Google is told to index that host instead — and Search
// Console rejects the sitemap outright because the URLs sit outside the
// verified property. Fall back to the real domain rather than trust a preview
// hostname that only ever ends up here by mistake.
const RAW_SITE = process.env.SITE_URL || '';
const CANONICAL = 'https://store.proskillagency.com';
const BUILD = 'v127';
const SITE = /vercel\.app/i.test(RAW_SITE) || !RAW_SITE ? CANONICAL : RAW_SITE.replace(/\/+$/, '');

const STATIC_PAGES = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  // The CV service — a real landing page with buying intent, and it was in no
  // sitemap at all. Ranked above FAQ because it is the page that sells.
  { path: '/cv', priority: '0.9', changefreq: 'weekly' },
  { path: '/faq', priority: '0.6', changefreq: 'monthly' },
  { path: '/track', priority: '0.5', changefreq: 'monthly' },
  { path: '/terms', priority: '0.3', changefreq: 'yearly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { path: '/refund', priority: '0.3', changefreq: 'yearly' },
];

/** Mirrors the category slug derived in api/catalog.js. */
function catSlugFor(c) {
  const base = String(c.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `${base}-${String(c.id).slice(0, 6)}` : String(c.id);
}

/** Mirrors the slug fallback in api/catalog.js so links always match. */
function slugFor(p) {
  if (p.slug) return p.slug;
  const base = String(p.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `${base}-${String(p.id).slice(0, 6)}` : String(p.id);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  // Short while the sitemap is still being corrected — an hour-long CDN cache
  // made every fix look like it hadn't deployed. Raise it once it's stable.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');

  const urls = STATIC_PAGES.map(
    (p) => `  <url><loc>${SITE}${p.path}</loc><priority>${p.priority}</priority><changefreq>${p.changefreq}</changefreq></url>`
  );

  // Product pages. A database hiccup must not break the whole sitemap, so the
  // static pages are still served if this fails.
  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('products')
      .select('id, name, slug, updated_at')
      .eq('is_active', true)
      .eq('store_visible', true);

    for (const p of data ?? []) {
      const lastmod = p.updated_at ? String(p.updated_at).slice(0, 10) : null;
      urls.push(
        `  <url><loc>${SITE}/p/${xmlEscape(slugFor(p))}</loc>` +
          (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
          `<priority>0.8</priority><changefreq>weekly</changefreq></url>`
      );
    }
  } catch (e) {
    // Swallowing this produced a sitemap with only static pages and no clue
    // why. An XML comment is ignored by crawlers but visible in the browser.
    console.error('sitemap: product query failed:', e.message);
    urls.push(`  <!-- products unavailable: ${xmlEscape(String(e.message).slice(0, 120))} -->`);
  }

  // Category landing pages — these are the pages that can rank for searches
  // like "اشتراكات تصميم", so Google needs to know they exist.
  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('categories')
      .select('id, name')
      .eq('is_active', true);

    for (const c of data ?? []) {
      urls.push(
        `  <url><loc>${SITE}/c/${xmlEscape(catSlugFor(c))}</loc><priority>0.7</priority><changefreq>weekly</changefreq></url>`
      );
    }
  } catch (e) {
    console.error('sitemap: category query failed:', e.message);
    urls.push(`  <!-- categories unavailable: ${xmlEscape(String(e.message).slice(0, 120))} -->`);
  }

  res.status(200).send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<!-- build ${BUILD} | site ${SITE} -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`
  );
}

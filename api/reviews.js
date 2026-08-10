// ============================================================================
// GET  /api/reviews?productId=...  — published reviews for a product
// POST /api/reviews                — submit one (verified buyers only)
//
// Verification lives in the submit_review() DB function: the order must be
// paid, delivered, and match the reviewer's email. The API never bypasses it.
// ============================================================================

import { supabaseAdmin } from './_lib/server.js';

export default async function handler(req, res) {
  const supabase = supabaseAdmin();

  if (req.method === 'GET') {
    // The wall on the home page: the shop's own reviews, not one product's.
    //
    // A visitor deciding whether this shop is real has not chosen a product
    // yet — the reviews have to reach them before that, or they never see one.
    if (String(req.query.scope || '') === 'site') {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');

      // The buyer's city comes from their order, through the foreign key. It is
      // what turns a testimonial into somebody real: "Ahmed — Cairo" is read
      // very differently from "Ahmed".
      const BASE = 'rating, comment, author_name, created_at';
      let { data, error } = await supabase
        .from('reviews')
        .select(`${BASE}, web_orders(geo_city, geo_country)`)
        .eq('is_published', true)
        // No rating filter and no comment filter: the average has to include
        // every published review, or it is not an average. Ordering puts the
        // written ones in reach; the quote list is filtered further below.
        .order('created_at', { ascending: false })
        .limit(200);

      // Before store_geo.sql the geo columns don't exist and the embed fails.
      // A wall without cities still works; no wall at all does not.
      if (error) {
        ({ data, error } = await supabase
          .from('reviews')
          .select(BASE)
          .eq('is_published', true)
          .order('created_at', { ascending: false })
          .limit(200));
      }

      if (error) {
        console.error('site reviews query failed:', error.message);
        return res.status(200).json({ reviews: [] });   // never break the page
      }

      // The headline is the aggregate, not the quotes.
      //
      // Most people rate and say nothing — of the reviews here, the large
      // majority are stars only. Requiring a written comment threw almost all
      // of that away and left the section hidden. The average across every
      // published rating is real evidence and it is already earned.
      const all = (data ?? []).map((r) => Number(r.rating)).filter((n) => n >= 1 && n <= 5);
      const summary = all.length
        ? { average: Number((all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)), total: all.length }
        : null;

      const reviews = (data ?? [])
        // 4+ for the QUOTES, while the average above still counts everything.
        //
        // The rating filter used to sit on the query, and removing it so the
        // average would be honest quietly opened the wall to two-star
        // complaints. Both numbers stay true this way: the score reflects every
        // buyer, and the quotes are what a shop would reasonably put forward.
        .filter((r) => Number(r.rating) >= 4)
        .filter((r) => String(r.comment || '').trim().length >= 15)
        // Twelve, not six: the page shows three and reveals the rest behind a
        // button, so there has to be a rest. Still capped — the whole list is
        // never worth sending to a home page.
        .slice(0, 12)
        .map((r) => ({
          rating: r.rating,
          comment: String(r.comment).slice(0, 260),
          // No name is normal — most people don't type one. Left null so the
          // page can decide, rather than inventing "عميل" here.
          author: r.author_name ? String(r.author_name).slice(0, 40) : null,
          city: r.web_orders?.geo_city ? String(r.web_orders.geo_city).slice(0, 40) : null,
          country: r.web_orders?.geo_country || null,
          createdAt: r.created_at,
        }));

      return res.status(200).json({ reviews, summary });
    }

    const productId = String(req.query.productId || '');
    if (!productId) return res.status(400).json({ error: 'productId required' });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

    const { data, error } = await supabase
      .from('reviews')
      .select('rating, comment, author_name, created_at')
      .eq('product_id', productId)
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) {
      console.error('reviews query failed:', error.message);
      return res.status(500).json({ error: 'query failed' });
    }

    const reviews = (data ?? []).map((r) => ({
      rating: r.rating,
      comment: r.comment,
      // Never expose a full name: "Mohamed A."
      author: r.author_name ? shortName(r.author_name) : 'مشترٍ موثّق',
      date: r.created_at,
    }));

    const count = reviews.length;
    const avg = count ? Number((reviews.reduce((s, r) => s + r.rating, 0) / count).toFixed(1)) : null;

    return res.status(200).json({ reviews, avg, count });
  }

  if (req.method === 'POST') {
    const { orderNumber, email, rating, comment, author } = req.body || {};
    if (!orderNumber || !email || !rating) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    const r = parseInt(rating, 10);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return res.status(400).json({ error: 'التقييم من 1 إلى 5' });
    }

    const text = comment ? String(comment).trim().slice(0, 600) : null;

    const { data, error } = await supabase.rpc('submit_review', {
      p_order_number: String(orderNumber).trim(),
      p_email: String(email).trim().toLowerCase(),
      p_rating: r,
      p_comment: text,
      p_author: author ? String(author).trim().slice(0, 60) : null,
    });

    if (error) {
      console.error('submit_review failed:', error.message);
      return res.status(500).json({ error: 'تعذر إرسال التقييم' });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) return res.status(400).json({ error: row?.message || 'تعذر إرسال التقييم' });

    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method' });
}

/** "Mohamed Abdullah" → "Mohamed A." — enough identity, no exposure. */
function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

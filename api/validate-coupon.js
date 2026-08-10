// ============================================================================
// POST /api/validate-coupon — preview a discount while the customer types.
//
// This endpoint is a PREVIEW ONLY. The authoritative discount is recomputed
// in /api/checkout from the database. A tampered response here changes nothing.
// ============================================================================

import { supabaseAdmin, effectivePrice, isOnSale } from './_lib/server.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { code, productId, quantity, email } = req.body || {};
  if (!code || !productId) return res.status(400).json({ error: 'بيانات ناقصة' });

  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
  const supabase = supabaseAdmin();

  // Subtotal from the DB, never from the browser.
  // `id` is selected because the coupon check needs it — without it product.id
  // is undefined, which reaches the function as null and makes every
  // product-restricted coupon fail while global ones still work.
  const CP_COLS = 'id, price_usd, is_active, store_visible';
  let { data: product, error: pErr } = await supabase
    .from('products')
    .select(`${CP_COLS}, sale_price_usd`)
    .eq('id', productId)
    .maybeSingle();
  if (pErr) {
    ({ data: product } = await supabase
      .from('products').select(CP_COLS).eq('id', productId).maybeSingle());
  }

  if (!product || !product.is_active || !product.store_visible) {
    return res.status(404).json({ error: 'المنتج غير متاح' });
  }

  // Told here rather than at payment. The customer sees why the code did
  // nothing while they can still decide, instead of watching the total refuse
  // to move with no explanation.
  if (isOnSale(product)) {
    return res.status(200).json({
      valid: false,
      reason: 'المنتج ده عليه عرض بالفعل — الكوبونات مش بتشتغل مع العروض.',
    });
  }

  const subtotal = Number((effectivePrice(product) * qty).toFixed(2));

  const { data, error } = await supabase.rpc('validate_coupon', {
    p_code: String(code).trim(),
    p_subtotal: subtotal,
    p_email: email ? String(email).trim().toLowerCase() : null,
    // Must match what checkout passes, or the preview would promise a discount
    // the payment step then refuses.
    p_product_id: product.id,
  });

  if (error) {
    console.error('validate_coupon failed:', error.message);
    return res.status(500).json({ error: 'تعذر التحقق من الكود' });
  }

  const r = Array.isArray(data) ? data[0] : data;
  if (!r?.valid) {
    return res.status(200).json({ valid: false, reason: r?.reason || 'الكود غير صحيح' });
  }

  res.status(200).json({
    valid: true,
    code: String(code).trim().toUpperCase(),
    subtotal,
    discount: Number(r.discount),
    total: Number(r.final_total),
  });
}

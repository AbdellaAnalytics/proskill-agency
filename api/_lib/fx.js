// ============================================================================
// Live USD → EGP / SAR exchange rates, cached in store_settings for 6 hours.
// A configurable markup covers gateway FX spread. One fetch covers both.
// ============================================================================

import { supabaseAdmin } from './server.js';

const CACHE_HOURS = 6;
// Last resort only: used when the live API fails AND store_settings has no
// cached rate. A stale-LOW value undersells every order, so it is set near the
// market (≈50.7 as of Jul 2026). SAR is pegged at 3.75 and won't drift.
// The real safeguard is the sanity range below, not this constant.
const FALLBACK = { EGP: 51, SAR: 3.75 };

export async function getRates() {
  const supabase = supabaseAdmin();

  const { data } = await supabase
    .from('store_settings')
    .select('value')
    .eq('key', 'fx_usd_egp')
    .maybeSingle();

  const cfg = data?.value || {};
  const markup = Number(cfg.markup_percent ?? 2);
  const fetchedAt = cfg.fetched_at ? new Date(cfg.fetched_at).getTime() : 0;
  const fresh = Date.now() - fetchedAt < CACHE_HOURS * 3600 * 1000;

  if (fresh && cfg.rate) {
    return {
      markup,
      cached: true,
      rates: { EGP: Number(cfg.rate), SAR: Number(cfg.rate_sar) || FALLBACK.SAR },
    };
  }

  let egp = Number(cfg.rate) || FALLBACK.EGP;
  let sar = Number(cfg.rate_sar) || FALLBACK.SAR;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    clearTimeout(t);
    const json = await res.json();
    const liveEgp = Number(json?.rates?.EGP);
    const liveSar = Number(json?.rates?.SAR);
    if (Number.isFinite(liveEgp) && liveEgp > 10 && liveEgp < 200) egp = liveEgp;
    if (Number.isFinite(liveSar) && liveSar > 2 && liveSar < 6) sar = liveSar;
  } catch (e) {
    console.error('FX fetch failed, using last known rates:', e.message);
  }

  await supabase
    .from('store_settings')
    .update({
      value: { rate: egp, rate_sar: sar, markup_percent: markup, fetched_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    })
    .eq('key', 'fx_usd_egp');

  return { markup, cached: false, rates: { EGP: egp, SAR: sar } };
}

// Backwards-compatible helper still used by the callback path.
export async function getUsdEgpRate() {
  const { rates, markup, cached } = await getRates();
  return { rate: rates.EGP, markup, cached };
}

/** USD amount → whole-unit display price in the target currency. */
export function convert(usd, rate, markup) {
  const raw = Number(usd) * Number(rate) * (1 + Number(markup) / 100);
  return Math.ceil(raw);
}

export function toEgp(usd, rate, markup) {
  return convert(usd, rate, markup);
}

// GET /api/fx — public: current USD→EGP and USD→SAR rates for price display.
import { getRates } from './_lib/fx.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  try {
    const { rates, markup } = await getRates();
    const withMarkup = (r) => Number((r * (1 + markup / 100)).toFixed(4));
    res.status(200).json({
      markup,
      rates: {
        EGP: { rate: rates.EGP, effective: withMarkup(rates.EGP) },
        SAR: { rate: rates.SAR, effective: withMarkup(rates.SAR) },
      },
    });
  } catch (e) {
    console.error('fx endpoint error:', e.message);
    res.status(200).json({
      markup: 2,
      rates: {
        EGP: { rate: 48.5, effective: 49.47 },
        SAR: { rate: 3.75, effective: 3.83 },
      },
    });
  }
}

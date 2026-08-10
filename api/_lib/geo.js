// ============================================================================
// Where a customer is — and how to guess when we weren't told.
//
// Three sources, in descending order of trust:
//   1. Vercel's geo headers on the request that created the order. Free on
//      every plan including Hobby, no external API, no extra function.
//   2. The country code inside a phone number already on file. Recovers a
//      country for every order placed before any of this existed.
//   3. The browser's timezone, sent with a page view. The visit never touches
//      a serverless function, so there are no headers to read — the timezone
//      is the only location signal available without turning every page view
//      into an invocation.
//
// None of it is precise. IP geolocation places a customer near their exit
// node, not at their desk, and a timezone names a zone, not a city. These
// numbers answer "which markets am I selling to", not "where does this person
// live" — and nothing here is used to make a decision about an individual.
// ============================================================================

/**
 * Location of the request that reached this function.
 * Returns nulls when the headers are absent (local dev, or a proxy in front).
 */
export function requestGeo(req) {
  const h = (req && req.headers) || {};
  const get = (k) => {
    const v = h[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const cc = String(get('x-vercel-ip-country') || '').trim().toUpperCase();
  const region = String(get('x-vercel-ip-country-region') || '').trim();

  // The city header is percent-encoded so non-ASCII names survive transport.
  // Stored raw it reads as "Al%20Q%C4%81hirah" in the dashboard.
  const rawCity = String(get('x-vercel-ip-city') || '').trim();
  let city = rawCity;
  try {
    city = decodeURIComponent(rawCity);
  } catch {
    /* malformed encoding — keep the raw value rather than lose the city */
  }

  return {
    geo_country: /^[A-Z]{2}$/.test(cc) ? cc : null,
    geo_region: region ? region.slice(0, 20) : null,
    geo_city: city ? city.slice(0, 80) : null,
  };
}

// --- Phone dialling codes ---------------------------------------------------
// Longest prefix wins, so 971 is matched before 97 and 9.
//
// Two codes are shared and resolve to the larger market: 1 (US, also Canada)
// and 7 (Russia, also Kazakhstan). Every other entry here is unambiguous.
const PHONE_CC = [
  ['20', 'EG'], ['212', 'MA'], ['213', 'DZ'], ['216', 'TN'], ['218', 'LY'], ['249', 'SD'],
  ['961', 'LB'], ['962', 'JO'], ['963', 'SY'], ['964', 'IQ'], ['965', 'KW'], ['966', 'SA'],
  ['967', 'YE'], ['968', 'OM'], ['970', 'PS'], ['971', 'AE'], ['972', 'IL'], ['973', 'BH'],
  ['974', 'QA'], ['90', 'TR'], ['30', 'GR'], ['31', 'NL'], ['32', 'BE'], ['33', 'FR'],
  ['34', 'ES'], ['36', 'HU'], ['39', 'IT'], ['40', 'RO'], ['41', 'CH'], ['43', 'AT'],
  ['44', 'GB'], ['45', 'DK'], ['46', 'SE'], ['47', 'NO'], ['48', 'PL'], ['49', 'DE'],
  ['351', 'PT'], ['353', 'IE'], ['358', 'FI'], ['359', 'BG'], ['380', 'UA'], ['420', 'CZ'],
  ['27', 'ZA'], ['234', 'NG'], ['251', 'ET'], ['254', 'KE'], ['255', 'TZ'],
  ['55', 'BR'], ['52', 'MX'], ['54', 'AR'], ['57', 'CO'],
  ['60', 'MY'], ['61', 'AU'], ['62', 'ID'], ['63', 'PH'], ['64', 'NZ'], ['65', 'SG'],
  ['66', 'TH'], ['81', 'JP'], ['82', 'KR'], ['84', 'VN'], ['86', 'CN'], ['91', 'IN'],
  ['92', 'PK'], ['93', 'AF'], ['98', 'IR'], ['880', 'BD'], ['994', 'AZ'], ['998', 'UZ'],
  ['1', 'US'], ['7', 'RU'],
].sort((a, b) => b[0].length - a[0].length);

/**
 * Country from a stored phone number. Null when it can't be read confidently —
 * a wrong country is worse than a blank one on a chart you make decisions from.
 */
export function countryFromPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;

  let d = raw.replace(/\D/g, '');
  if (!d) return null;

  // A local Egyptian mobile carries no country code at all: 01 followed by
  // nine digits. It's the most common shape in this shop's orders, and read as
  // a bare international number it would file under a country code of 0.
  if (/^01\d{9}$/.test(d)) return 'EG';

  if (d.startsWith('00')) d = d.slice(2);

  for (const [prefix, cc] of PHONE_CC) {
    if (d.startsWith(prefix)) return cc;
  }
  return null;
}

// --- Browser timezones ------------------------------------------------------
// Only zones a visitor to this shop plausibly reports. An unknown zone returns
// null and is counted as unknown rather than guessed at.
const TZ_CC = {
  'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ',
  'Africa/Tunis': 'TN', 'Africa/Tripoli': 'LY', 'Africa/Khartoum': 'SD',
  'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE', 'Africa/Johannesburg': 'ZA',
  'Africa/Addis_Ababa': 'ET', 'Africa/Dar_es_Salaam': 'TZ',
  'Asia/Riyadh': 'SA', 'Asia/Dubai': 'AE', 'Asia/Kuwait': 'KW', 'Asia/Qatar': 'QA',
  'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM', 'Asia/Baghdad': 'IQ', 'Asia/Amman': 'JO',
  'Asia/Beirut': 'LB', 'Asia/Damascus': 'SY', 'Asia/Jerusalem': 'IL',
  'Asia/Gaza': 'PS', 'Asia/Hebron': 'PS', 'Asia/Aden': 'YE',
  'Asia/Istanbul': 'TR', 'Europe/Istanbul': 'TR',
  'Europe/Berlin': 'DE', 'Europe/London': 'GB', 'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO', 'Europe/Athens': 'GR',
  'Europe/Lisbon': 'PT', 'Europe/Dublin': 'IE', 'Europe/Kyiv': 'UA',
  'Europe/Kiev': 'UA', 'Europe/Moscow': 'RU',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Detroit': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO',
  'Asia/Karachi': 'PK', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN',
  'Asia/Dhaka': 'BD', 'Asia/Kabul': 'AF', 'Asia/Tehran': 'IR',
  'Asia/Baku': 'AZ', 'Asia/Tashkent': 'UZ', 'Asia/Jakarta': 'ID',
  'Asia/Kuala_Lumpur': 'MY', 'Asia/Singapore': 'SG', 'Asia/Bangkok': 'TH',
  'Asia/Manila': 'PH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Pacific/Auckland': 'NZ',
};

/** Country from a browser timezone. Null for anything not in the table. */
export function countryFromTz(tz) {
  const key = String(tz || '').trim();
  if (!key) return null;
  // hasOwnProperty, not a bare lookup. `tz` is written straight from the
  // browser with the anon key, so any visitor can post any string — and a bare
  // TZ_CC['constructor'] returns an INHERITED function, which would then be
  // counted as a country and rendered in the dashboard. Caught by the
  // adversarial-input pass, not by anything the build could see.
  return Object.prototype.hasOwnProperty.call(TZ_CC, key) ? TZ_CC[key] : null;
}

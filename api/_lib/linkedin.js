/**
 * Normalising a LinkedIn URL, in one place.
 *
 * ⚠️ This file is imported by the BROWSER as well as the server. It sits in
 * api/_lib next to modules that do read secrets, so the rule for this one
 * specifically: no process.env, no keys, no database access — pure string
 * handling only. Anything added here ships to every visitor.
 *
 * Lives in api/_lib because that's where every proven backend import points.
 * A serverless function is bundled with the files it references, and every
 * other working import in this project stays inside api/ — putting a
 * dependency outside it is untested ground, and getting it wrong means order
 * creation fails in production. The frontend imports across the boundary
 * instead, which the bundler resolves at build time and can be verified here.
 *
 * This runs twice per order: the form previews what will appear on the CV, and
 * the API decides what actually gets stored. Those two answers have to agree —
 * a preview that promises something the server then drops is worse than no
 * preview at all. Keeping one implementation is what guarantees that; two
 * copies agree until the first time somebody edits one of them.
 *
 * People paste this field in every shape it comes in: the mobile share link
 * with tracking parameters, a bare handle, "@name", the full URL with a
 * trailing slash, or a percent-encoded Arabic profile copied from the address
 * bar. A CV showing a 90-character tracked URL looks careless, and a bare
 * handle isn't clickable — so all of it collapses to one clean form.
 *
 * Returns null when the input isn't a personal profile. A company page or a
 * stray link has no place in someone's contact block, and a broken link in
 * front of a recruiter is worse than no link.
 */
export function normaliseLinkedIn(raw, { withScheme = true } = {}) {
  let v = String(raw || '').trim();
  if (!v) return null;

  v = v.replace(/^@/, '').split('?')[0].split('#')[0].replace(/\/+$/, '');

  const prefix = withScheme ? 'https://linkedin.com/in/' : 'linkedin.com/in/';

  // A full URL: keep the handle, drop everything around it. The character
  // class is deliberately permissive — Arabic and other non-Latin handles are
  // valid on LinkedIn and common among these customers, and a Latin-only rule
  // silently deleted their profile.
  const m = v.match(/linkedin\.com\/(in|pub)\/([^/\s]+)/i);
  if (m) {
    let handle = m[2];
    try { handle = decodeURIComponent(handle); } catch { /* already decoded */ }
    handle = handle.slice(0, 100);
    return handle ? prefix + handle : null;
  }

  // Anything else carrying a scheme or a path is some other link entirely.
  if (/^https?:\/\//i.test(v) || v.includes('/')) return null;

  // A bare handle.
  if (v.length >= 3 && v.length <= 100 && !/\s/.test(v)) return prefix + v;

  return null;
}

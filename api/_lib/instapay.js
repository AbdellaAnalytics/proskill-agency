/**
 * Manual transfer details.
 *
 * Display-only and not secret — the whole point is that a customer can read
 * them. Kept here rather than inside checkout.js because the order page needs
 * them too, and importing one serverless function from another would pull the
 * entire checkout bundle into the page that only wants a phone number.
 *
 * One copy: shown at checkout, sent in the order email, and shown on the order
 * page. Three places quoting three different numbers is how a transfer goes to
 * an account nobody is watching.
 */
export const INSTAPAY = {
  number: '01277771384',
  handle: 'mohamed.abdella771384@instapay',
  link: 'https://ipn.eg/S/mohamed.abdella771384/instapay/5IcbF5',
  support: 'https://wa.me/201500568788',
};

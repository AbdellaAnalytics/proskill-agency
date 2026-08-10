/**
 * Reading the inbox of an account we sold.
 *
 * Accounts sold with their own mailbox (Adobe, ChatGPT, SuperGrok…) receive
 * verification codes at an address the buyer can't open — they were given the
 * service password, not the mail password. Until now that meant messaging
 * support and waiting for a human, at whatever hour the code arrived.
 *
 * This reads the mailbox directly over IMAP so the buyer can see the code
 * themselves. Two things make that safe rather than reckless:
 *
 *   * It only ever opens mailboxes WE created and hold credentials for, and
 *     only for the customer whose order contains that exact address.
 *   * It fetches headers and a short body slice of recent messages. It doesn't
 *     download attachments, doesn't mark anything read, and doesn't send.
 *
 * Written against the raw IMAP protocol over TLS: the alternative is a
 * dependency in a serverless function that runs a few times a day, and the
 * subset of IMAP needed here is small and stable.
 */

import tls from 'node:tls';

const PORTS = { outlook: 993, gmail: 993, other: 993 };
const HOSTS = {
  outlook: 'outlook.office365.com',
  gmail: 'imap.gmail.com',
};

/**
 * A minimal IMAP conversation: log in, select INBOX, fetch the newest few
 * messages, log out. Everything is bounded — a hung connection must not hold
 * a serverless function open until the platform kills it.
 */
function imapFetch({ host, port, user, pass, timeoutMs = 20000, count = 1 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    let buffer = '';
    let step = 0;
    let total = 0;
    const raw = [];        // messages from INBOX
    const rawJunk = [];    // messages from the junk folder, if there is one
    let settled = false;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(() => done(new Error('imap timeout')), timeoutMs);

    socket.on('error', (e) => done(e));
    socket.on('close', () => {
      if (!settled) done(new Error('imap closed unexpectedly'));
    });

    const send = (line) => socket.write(`${line}\r\n`);

    // A tagged completion line only counts once its NEWLINE has arrived.
    //
    // Matching the tag alone fires the instant "a3 O" lands in the buffer, and
    // the OK test then runs against half a line: a login that succeeded reads
    // as failed, and a FETCH silently yields nothing — which looks exactly like
    // an empty mailbox. TLS records split wherever they like, and the tagged
    // line sits directly after a body of tens of kilobytes, which is precisely
    // where a chunk boundary is most likely to fall.
    const tagDone = (tag) => new RegExp(`^${tag} (OK|NO|BAD)\\b[^\\n]*\\n`, 'm').test(buffer);
    const tagOk = (tag) => new RegExp(`^${tag} OK\\b`, 'm').test(buffer);

    let junkBox = null;

    // The same request for whichever folder is open. `total` is re-read per
    // folder, so this must be called after the SELECT for that folder.
    //
    // EVERY header, not a chosen list. In a shared mailbox the only thing that
    // says WHOSE message this is, is the address it was originally sent to —
    // and which header still carries it after a forward is not knowable in
    // advance. Outlook may leave it in To, or move it to Return-Path,
    // X-Forwarded-For, Resent-To or an X-MS-Exchange header, and the receiving
    // server adds its own. Naming a list means betting on one of them; a losing
    // bet reads as "no message", which is indistinguishable from an empty box.
    // Headers are small. Fetch them all and let the search find it.
    const fetchCmd = () => {
      const lo = Math.max(1, total - count + 1);
      const range = count > 1 ? `${lo}:${total}` : `${total}`;
      return `FETCH ${range} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.3000>)`;
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // Step 0 — server greeting, then authenticate.
      if (step === 0 && /^\* OK/m.test(buffer)) {
        step = 1;
        buffer = '';
        // Quoting the password protects addresses and secrets containing
        // spaces or special characters.
        send(`a1 LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`);
        return;
      }

      // Step 1 — login result.
      if (step === 1 && tagDone('a1')) {
        if (!tagOk('a1')) {
          const reason = (buffer.match(/^a1 (NO|BAD) (.+)$/m) || [])[2] || 'login failed';
          // A BAD response can echo the command that caused it — including the
          // LOGIN line with the password in it. That reason string goes
          // straight into a log, so scrub anything quoted out of it before it
          // travels anywhere.
          const safe = reason.replace(/"[^"]*"/g, '"***"').slice(0, 120);
          return done(new Error(`imap login: ${safe}`));
        }
        step = 2;
        buffer = '';
        send('a2 SELECT INBOX');
        return;
      }

      // Step 2 — how many messages are in the box.
      if (step === 2 && tagDone('a2')) {
        if (!tagOk('a2')) return done(new Error('imap select failed'));
        total = Number((buffer.match(/^\* (\d+) EXISTS/m) || [])[1] || 0);
        // An empty INBOX is not the end of the search any more — the message
        // may be sitting in junk.
        if (!total) {
          step = 4;
          buffer = '';
          send('a4 LIST "" "*"');
          return;
        }

        step = 3;
        buffer = '';
        // How much to pull depends on who else is in this mailbox.
        //
        // A mailbox dedicated to one account: the newest message IS the code by
        // definition, and asking for a history would show the customer more of
        // a mailbox than the one message they came for. count stays 1.
        //
        // A SHARED mailbox receiving forwarded mail for many accounts: the
        // newest message probably belongs to somebody else entirely. Pull a
        // window and let readMailbox filter it down by recipient.
        send(`a3 ${fetchCmd()}`);
        return;
      }

      // Step 3 — the INBOX messages, then find out whether a junk folder even
      // exists. Forwarded mail fails SPF by design — the original sender is
      // Adobe, the sending server is Microsoft — so a verification code landing
      // in junk is the normal case, not the odd one. Reading only INBOX means
      // the customer is told there's no message while it sits one folder over.
      if (step === 3 && tagDone('a3')) {
        if (tagOk('a3')) raw.push(buffer);
        step = 4;
        buffer = '';
        send('a4 LIST "" "*"');
        return;
      }

      // Step 4 — pick the junk folder out of the listing.
      //
      // Asked, not guessed: the name is 'Junk' on one server, 'INBOX.Junk' on
      // another and 'Spam' on a third, and a guess that misses fails silently —
      // which is the same symptom as having no junk folder at all.
      if (step === 4 && tagDone('a4')) {
        // The \Junk attribute first — that's the server declaring which folder
        // it is, and it survives a mailbox named "Bulk Mail" or a localised
        // name. Fall back to matching the name only when no server says so.
        const junk =
          (buffer.match(/^\* LIST \([^)]*\\Junk[^)]*\) "[^"]*" "?([^"\r\n]+?)"?\s*$/im) || [])[1]
          || (buffer.match(/^\* LIST \([^)]*\) "[^"]*" "?([^"\r\n]*(?:junk|spam)[^"\r\n]*?)"?\s*$/im) || [])[1];
        if (!junk) {
          step = 9;
          send('a7 LOGOUT');
          return done(null, { raw, rawJunk });
        }
        step = 5;
        buffer = '';
        junkBox = junk.trim();
        send(`a5 SELECT "${junkBox.replace(/"/g, '\\"')}"`);
        return;
      }

      // Step 5 — how much is in it. A junk folder that won't open, or is empty,
      // is not an error: INBOX already answered.
      if (step === 5 && tagDone('a5')) {
        total = Number((buffer.match(/^\* (\d+) EXISTS/m) || [])[1] || 0);
        if (!tagOk('a5') || !total) {
          step = 9;
          send('a7 LOGOUT');
          return done(null, { raw, rawJunk });
        }
        step = 6;
        buffer = '';
        send(`a6 ${fetchCmd()}`);
        return;
      }

      // Step 6 — the junk messages.
      if (step === 6 && tagDone('a6')) {
        if (tagOk('a6')) rawJunk.push(buffer);
        step = 9;
        send('a7 LOGOUT');
        done(null, { raw, rawJunk });
      }
    });
  });
}

/** Decode the encodings mail servers actually use in headers and bodies. */
function decodeText(s) {
  let out = String(s || '');

  // =?UTF-8?B?...?=  and  =?UTF-8?Q?...?=
  out = out.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      if (/^b$/i.test(enc)) return Buffer.from(data, 'base64').toString('utf8');
      return data
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { return data; }
  });

  // quoted-printable in the body
  out = out
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (m, h) => {
      const c = parseInt(h, 16);
      return c >= 32 || c === 10 ? String.fromCharCode(c) : m;
    });

  return out;
}

/** Pull the sender, subject, date and any verification code out of the raw response. */
function parseMessages(rawChunks) {
  const text = rawChunks.join('\n');
  const blocks = text.split(/^\* \d+ FETCH /m).slice(1);

  return blocks.map((b) => {
    const decoded = decodeText(b);
    const grab = (field) =>
      (decoded.match(new RegExp(`^${field}:\\s*(.+)$`, 'im')) || [])[1]?.trim() || '';

    const from = grab('From');
    const subject = grab('Subject');
    const date = grab('Date');

    // Body: the TEXT section ONLY, stripped of HTML.
    //
    // The response carries two literals — the header block, then the text. This
    // used to take the whole thing, which was survivable while only four header
    // fields were requested. Asking for the full header block turned that into
    // a real bug: 8KB of Received: and Authentication-Results: lines became the
    // "body", so the customer was shown raw headers and the code was searched
    // for in the wrong half of the message.
    const textPart = b.match(/BODY\[TEXT\][^{]*\{\d+\}\r?\n([\s\S]*)$/);
    // No text section at all: fall back to NOTHING, not to the whole block.
    // Falling back to the block is the bug this replaced — headers as the
    // message, and a DKIM header's "code=999011" reported to the customer as
    // their verification code. An empty preview is a poor answer; a confident
    // wrong code is a harmful one.
    const bodySrc = textPart ? decodeText(textPart[1].replace(/\)\s*$/, '')) : '';

    const body = bodySrc
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // The code is what the customer is here for. Look for the shapes services
    // actually use, near words that indicate a code — a bare 6-digit run could
    // just as easily be an order number.
    const codeMatch =
      // "Security code: 123456" — the code right after the label.
      // The alphanumeric shape (A1B2C3) must contain at least one digit.
      // Without that guard the case-insensitive class matches any six-letter
      // word, and "verification code cannot be resent" reports the customer's
      // code as "cannot" — confidently, and wrong.
      body.match(/(?:code|رمز|كود|otp|verification|passcode)[^0-9A-Z]{0,40}([0-9]{4,8}|(?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,10})/i)
      // "Your verification code is 123456" — words between the label and the
      // digits. The gap above excludes letters, so the single most common
      // phrasing in a real verification email never matched.
      //
      // Digits only on this one: widening the gap for the alphanumeric shape
      // would let an ordinary word through — "verification code cannot be"
      // would report "cannot" as the customer's code.
      || body.match(/(?:code|رمز|كود|otp|verification|passcode)[^0-9]{0,24}([0-9]{4,8})/i)
      || subject.match(/\b([0-9]{4,8})\b/);

    return {
      from: from.slice(0, 120),
      subject: subject.slice(0, 200),
      date,
      code: codeMatch ? codeMatch[1] : null,
      preview: body.slice(0, 400),
      // Headers plus body, lowercased, for the shared-mailbox filter. Stripped
      // before anything is returned to a caller — it must never reach a
      // customer, because in a shared box it is somebody else's mail.
      _text: decoded.toLowerCase(),
    };
  }).reverse(); // newest first
}

/**
 * Read the single newest message in the mailbox.
 *
 * @returns {Promise<{from,subject,date,code,preview}|null>} null when empty
 */
export async function readMailbox({ email, password, provider = 'outlook', host, imapUser, matchExtra }) {
  // Which box to open, and which account's mail to take out of it. They are
  // the same thing only when the mailbox belongs to one account.
  const login = String(imapUser || email).trim();
  const account = String(email).trim().toLowerCase();
  const resolvedHost = String(host || '').trim() || HOSTS[provider] || HOSTS.outlook;
  const port = PORTS[provider] || 993;

  const shared = login.toLowerCase() !== account;

  // A second address that also identifies this account's mail, for the case
  // where the forward strips the original recipient everywhere. Set it to a
  // per-account alias — forward the mail to adobe1@yourdomain, put that here,
  // and ownership is proven by the address the message was delivered to
  // instead of the one it was sent to.
  const rawExtra = String(matchExtra || '').trim().toLowerCase();

  // Guarded, not trusted. This value widens the filter, so a careless one
  // widens it to everything: a bare "@proskillagency.com" appears in the
  // headers of EVERY message in the box, and so does the shared login itself —
  // either would hand every customer the whole mailbox. The field sits right
  // under one containing support@proskillagency.com, which is exactly the
  // value most likely to get pasted into it by mistake.
  //
  // Checked here as well as on save, because the row can also be edited
  // straight in the database, and this is the line that actually decides.
  const extra =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawExtra) && rawExtra !== login.toLowerCase()
      ? rawExtra
      : '';

  const raw = await imapFetch({
    host: resolvedHost,
    port,
    user: login,
    pass: password,
    count: shared ? 15 : 1,
  });

  // INBOX first, junk after. Order is the whole point: a message that made it
  // to the inbox always beats one the server distrusted.
  let messages = [
    ...parseMessages(raw.raw).map((m) => ({ ...m, inJunk: false })),
    ...parseMessages(raw.rawJunk).map((m) => ({ ...m, inJunk: true })),
  ];

  if (shared) {
    // Forwarded mail carries the address it was originally sent to — in a
    // header the receiving server stamped, or inside the forwarded copy of the
    // original message. Either one is proof the message belongs to this
    // account. Anything without it belongs to another customer, or is the
    // owner's own support mail, and never leaves this function.
    //
    // This fails CLOSED: no match means no message, not the newest one.
    messages = messages.filter(
      (m) => m._text.includes(account) || (extra && m._text.includes(extra))
    );
  }

  if (!messages[0]) return null;
  const top = { ...messages[0] };
  delete top._text;
  return top;
}

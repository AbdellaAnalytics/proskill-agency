// ═══════════════════════════════════════════════════════════════════
// /api/adobe-sheet.js — Vercel Serverless Function (ES Module)
// Reads ProSkill's Adobe Google Sheet using a service account.
// The private key NEVER reaches the browser; it lives only in Vercel
// environment variables.
//
// Required Vercel env vars:
//   GOOGLE_SA_CLIENT_EMAIL  — service account email
//   GOOGLE_SA_PRIVATE_KEY   — private key (multi-line, include BEGIN/END)
//   GOOGLE_SHEET_ID         — the sheet ID
//   GOOGLE_SHEET_RANGE      — e.g. "A:N" or "Copy of adobe Edu!A:N"
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";

// Base64-url encode (no padding, +→-, /→_)
function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Build & sign a JWT (RS256) for the Google OAuth2 token endpoint
function buildSignedJwt(clientEmail, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedClaims = b64url(JSON.stringify(claims));
  const unsigned = encodedHeader + "." + encodedClaims;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey);
  return unsigned + "." + b64url(signature);
}

// Trade the JWT for an OAuth2 access token
async function getAccessToken(clientEmail, privateKey) {
  const jwt = buildSignedJwt(clientEmail, privateKey);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Token exchange failed: " + resp.status + " " + t);
  }
  const json = await resp.json();
  return json.access_token;
}

// Read the sheet values
async function readSheet(token, sheetId, range) {
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "/values/" +
    encodeURIComponent(range);
  const resp = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Sheet read failed: " + resp.status + " " + t);
  }
  return await resp.json();
}

// Convert Google Sheets serial date (1900-based) to YYYY-MM-DD
function serialToDate(serial) {
  if (typeof serial !== "number" || !isFinite(serial)) return null;
  // Google Sheets / Excel epoch: 1899-12-30
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd;
}

// Coerce sheet cell into a friendly value
function clean(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// Transform raw rows into clean Adobe-account objects (cols A-N)
function transformRows(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  // Skip header row (index 0)
  const rows = values.slice(1);
  return rows
    .map((r, i) => {
      const get = (idx) => (r[idx] === undefined ? "" : r[idx]);
      // Column D = start date (serial), E = end date (serial)
      const startSerial = Number(get(3));
      const endSerial = Number(get(4));
      const startDate = isFinite(startSerial) && startSerial > 0 ? serialToDate(startSerial) : null;
      const endDate = isFinite(endSerial) && endSerial > 0 ? serialToDate(endSerial) : null;
      return {
        rowIndex: i + 2, // 1-based row in sheet (after header)
        email: clean(get(0)).toLowerCase(),
        passEmail: clean(get(1)),
        passAdobe: clean(get(2)),
        startDate,
        endDate,
        accountValid: get(5) === "" ? null : Number(get(5)),
        leftPerMonth: get(6) === "" ? null : Number(get(6)),
        leftPerDay: get(7) === "" ? null : Number(get(7)),
        soldTo: clean(get(8)),
        orderNumber: clean(get(9)),
        status: clean(get(10)) || "Unknown",
        verified: clean(get(11)),
        leftForCustomer: clean(get(12)),
        customerPlan: clean(get(13)),
      };
    })
    .filter(r => r.email); // ignore blank rows
}

export default async function handler(req, res) {
  // Allow only GET; respond to CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  // Cache 60s on Vercel edge — reduces Google API calls
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  try {
    const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
    let privateKey = process.env.GOOGLE_SA_PRIVATE_KEY || "";
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const range = process.env.GOOGLE_SHEET_RANGE || "A:N";

    if (!clientEmail || !privateKey || !sheetId) {
      return res.status(500).json({
        error: "Server not configured",
        missing: {
          GOOGLE_SA_CLIENT_EMAIL: !clientEmail,
          GOOGLE_SA_PRIVATE_KEY: !privateKey,
          GOOGLE_SHEET_ID: !sheetId,
        },
      });
    }
    // Vercel stores multi-line env vars with literal \n; convert to real newlines
    privateKey = privateKey.replace(/\\n/g, "\n");

    const token = await getAccessToken(clientEmail, privateKey);
    const data = await readSheet(token, sheetId, range);
    const accounts = transformRows(data.values || []);

    return res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      count: accounts.length,
      accounts,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Unknown error",
    });
  }
}

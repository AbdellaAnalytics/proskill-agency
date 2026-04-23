import { useState, useEffect, useCallback, useMemo, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════
// 📱 VIEWPORT DETECTION HOOK
// ═══════════════════════════════════════════════════════════════════
function useViewport() {
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return { width, isMobile: width < 640, isTablet: width >= 640 && width < 900, isDesktop: width >= 900 };
}

// ═══════════════════════════════════════════════════════════════════
// ☁️ SUPABASE CLOUD SYNC
// ═══════════════════════════════════════════════════════════════════
const SUPABASE_URL = "https://jsemibrimkacjbbsdozm.supabase.co";
const SUPABASE_KEY = "sb_publishable_6CVSz3Ss2wryTv1k6zVLzA_hkjCOV0k";

const sb = {
  token: null,
  user: null,
  async req(path, opts = {}) {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + (this.token || SUPABASE_KEY),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };
    if (opts.prefer) headers.Prefer = opts.prefer;
    try {
      // 15 second timeout to prevent "stuck on saving" forever
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(SUPABASE_URL + path, { ...opts, headers, signal: ctrl.signal });
      clearTimeout(timeoutId);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.message } };
    }
  },
  async signUp(email, password) {
    const r = await this.req("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password }) });
    if (r.ok && r.data && r.data.access_token) {
      this.token = r.data.access_token;
      this.user = r.data.user;
      try { localStorage.setItem("ps_t", r.data.access_token); localStorage.setItem("ps_r", r.data.refresh_token || ""); } catch {}
    }
    return r;
  },
  async signIn(email, password) {
    const r = await this.req("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
    if (r.ok && r.data && r.data.access_token) {
      this.token = r.data.access_token;
      this.user = r.data.user;
      try { localStorage.setItem("ps_t", r.data.access_token); localStorage.setItem("ps_r", r.data.refresh_token || ""); } catch {}
    }
    return r;
  },
  // Admin signs up a new member (creates Supabase account without changing admin's session)
  async adminCreateMember(email, password) {
    const savedToken = this.token;
    const savedUser = this.user;
    const r = await fetch(SUPABASE_URL + "/auth/v1/signup", {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // Restore admin session no matter what
    this.token = savedToken;
    this.user = savedUser;
    return { ok: r.ok, status: r.status, data };
  },
  async refresh(refreshToken) {
    const r = await this.req("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) });
    if (r.ok && r.data && r.data.access_token) {
      this.token = r.data.access_token;
      this.user = r.data.user;
      try { localStorage.setItem("ps_t", r.data.access_token); localStorage.setItem("ps_r", r.data.refresh_token || ""); } catch {}
    }
    return r;
  },
  async getUser() {
    if (!this.token) return null;
    const r = await this.req("/auth/v1/user");
    if (r.ok) { this.user = r.data; return r.data; }
    return null;
  },
  async signOut() {
    await this.req("/auth/v1/logout", { method: "POST" });
    this.token = null; this.user = null;
    try { localStorage.removeItem("ps_t"); localStorage.removeItem("ps_r"); } catch {}
  },
  // For admin: always reads from admin's own workspace
  // For member: reads the workspace belonging to a shared key (admin's workspace)
  async loadData(workspaceOwnerId) {
    if (!workspaceOwnerId) return null;
    const key = "ws_" + workspaceOwnerId;
    const r = await this.req("/rest/v1/proskill_workspace?workspace_key=eq." + key + "&select=data&limit=1");
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) return r.data[0].data;
    return null;
  },
  // Member: find the admin workspace by shared email key (since localStorage isn't shared across devices)
  async loadAdminWorkspaceByEmail(adminEmail) {
    if (!adminEmail) return null;
    const key = "ws_email_" + adminEmail.toLowerCase();
    const r = await this.req("/rest/v1/proskill_workspace?workspace_key=eq." + encodeURIComponent(key) + "&select=data,owner_id&limit=1");
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
      return { data: r.data[0].data, ownerId: r.data[0].owner_id };
    }
    return null;
  },
  // Remove large embedded payloads (base64 image data) before sending to Supabase
  // so workspace JSON stays small and fast to upload
  stripHeavyPayload(data) {
    if (!data) return data;
    const slim = { ...data };
    // Sales: strip out base64 paymentProof.data (keep metadata like name/type)
    if (Array.isArray(data.sales)) {
      slim.sales = data.sales.map(s => {
        if (s && s.paymentProof && s.paymentProof.data && s.paymentProof.data.length > 1000) {
          return {
            ...s,
            paymentProof: {
              name: s.paymentProof.name,
              type: s.paymentProof.type,
              size: s.paymentProof.size,
              data: null, // Stripped for cloud. Kept locally in localStorage.
              _stripped: true,
            },
          };
        }
        return s;
      });
    }
    return slim;
  },
  async saveData(workspaceOwnerId, data, adminEmail) {
    if (!workspaceOwnerId) return { ok: false };
    const key = "ws_" + workspaceOwnerId;
    // Refresh token if it's about to expire
    try {
      const refreshToken = localStorage.getItem("ps_r");
      if (refreshToken && this.token) {
        const parts = this.token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
          const expMs = (payload.exp || 0) * 1000;
          if (expMs > 0 && expMs - Date.now() < 5 * 60 * 1000) {
            console.log("[ProSkill] 🔄 Refreshing expired token...");
            await this.refresh(refreshToken);
          }
        }
      }
    } catch (e) { /* ignore */ }

    // CRITICAL: strip out heavy data (payment proof images) before uploading
    // Proofs live in localStorage only. The workspace JSON stays small/fast.
    const slimData = this.stripHeavyPayload(data);
    const body = JSON.stringify({ data: slimData, updated_at: new Date().toISOString() });
    try {
      console.log("[ProSkill] 💾 Save attempt. key:", key.slice(0, 20) + "...", "size:", Math.round(body.length / 1024) + "KB");
      // Try PATCH first
      const r = await this.req(
        "/rest/v1/proskill_workspace?workspace_key=eq." + encodeURIComponent(key),
        { method: "PATCH", prefer: "return=minimal", body }
      );
      if (r.ok) {
        // PATCH with return=minimal returns empty response on success
        // Check count in response headers would be ideal; for now assume success if 2xx
        if (adminEmail) {
          this.upsertEmailIndex(workspaceOwnerId, data, adminEmail).catch(() => {});
        }
        console.log("[ProSkill] ✅ Save OK (PATCH status " + r.status + ")");
        return { ok: true };
      }
      // If PATCH failed with anything other than "no rows", it's a real error
      console.warn("[ProSkill] PATCH failed with status", r.status, "- trying INSERT");
      const r2 = await this.req(
        "/rest/v1/proskill_workspace",
        { method: "POST", prefer: "return=minimal", body: JSON.stringify({ owner_id: workspaceOwnerId, workspace_key: key, data: slimData }) }
      );
      if (r2.ok) {
        if (adminEmail) {
          this.upsertEmailIndex(workspaceOwnerId, data, adminEmail).catch(() => {});
        }
        console.log("[ProSkill] ✅ Save OK (INSERT status " + r2.status + ")");
        return { ok: true };
      }
      // 409 Conflict on INSERT means row exists — this is actually a success (PATCH should've caught it but race)
      if (r2.status === 409) {
        console.log("[ProSkill] ℹ️ 409 conflict but row exists — treating as success");
        if (adminEmail) {
          this.upsertEmailIndex(workspaceOwnerId, data, adminEmail).catch(() => {});
        }
        return { ok: true };
      }
      console.error("[ProSkill] ❌ Save failed. PATCH:", r.status, "INSERT:", r2.status, r2.data);
      return { ok: false, status: r2.status, detail: r2.data };
    } catch (e) {
      console.error("[ProSkill] ❌ Save exception:", e.message);
      return { ok: false };
    }
  },
  // Helper: upsert the email-keyed index entry so members can discover admin's workspace
  async upsertEmailIndex(workspaceOwnerId, data, adminEmail) {
    const emailKey = "ws_email_" + adminEmail.toLowerCase();
    const slimData = this.stripHeavyPayload(data);
    const body = JSON.stringify({ data: slimData, updated_at: new Date().toISOString() });
    const r = await this.req(
      "/rest/v1/proskill_workspace?workspace_key=eq." + encodeURIComponent(emailKey),
      { method: "PATCH", prefer: "return=minimal", body }
    );
    if (r.ok) return r;
    return await this.req(
      "/rest/v1/proskill_workspace",
      { method: "POST", prefer: "return=minimal", body: JSON.stringify({ owner_id: workspaceOwnerId, workspace_key: emailKey, data: slimData }) }
    );
  },
};

// ═══════════════════════════════════════════════════════════════════
// 🔑 ADMIN CONFIG
// ═══════════════════════════════════════════════════════════════════
const ADMIN_EMAIL = "Mohamed.abdullah969@gmail.com";
const ADMIN_WA = "201270935507";
const COMPANY = {
  name: "ProSkill Digital Agency",
  website: "www.proskillagency.com",
  whatsapp: "+201270935507",
  email: "support@proskillagency.com",
  terms: "This is a digital service. Refunds are not available after successful activation. However, we guarantee full support in case of any technical issue.",
};

// ═══════════════════════════════════════════════════════════════════
// 🗂️ DEFAULTS & CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const DEFAULT_SERVICES = [
  { name: "Adobe", icon: "🎨" },
  { name: "ChatGPT", icon: "🤖" },
  { name: "LinkedIn", icon: "💼" },
  { name: "Google AI", icon: "🧠" },
  { name: "Canva", icon: "🖌️" },
  { name: "Microsoft 365", icon: "📎" },
];

const DEFAULT_CHECKLIST = [
  "Payment confirmed",
  "Account ready",
  "Activated",
  "Tested",
  "Sent to client",
  "Client confirmed",
];

const ICONS = [
  "📦","🎨","🤖","💼","🧠","🖌️","📎","📝","✏️","🎯","🔧","💡","🌐","📱","💻","🎮",
  "📊","🔒","☁️","⚡","🛒","🎵","📹","🗂️","🧩","🏢","🎓","🔬","🚀","💳","🛡️","📡",
  "🏦","📈","🔗","💎","📐","🥇","💬","📌","🧰","🔑","💰","📋","👥","⚙️","✈️","🎬",
  "📸","🖥️","🔍","🛠️","🎲","🏆","📣","🔔","💵","🎁","🌍","🌟","⭐","🔥","🌈",
];

const PERIODS = [
  ...Array.from({ length: 36 }, (_, i) => i + 1),
  0,  // No period
  -1, // Lifetime
];

const PERIOD_LABEL = (p) => {
  if (p === 0) return "No Period";
  if (p === -1) return "Lifetime";
  return p + "mo";
};

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const CURRENCIES = [
  { code: "EGP", symbol: "E£" },
  { code: "USD", symbol: "$" },
  { code: "SAR", symbol: "﷼" },
  { code: "EUR", symbol: "€" },
];
const RATES_TO_EGP = { EGP: 1, USD: 48.5, SAR: 12.9, EUR: 53 };

const EXPENSE_CATEGORIES = ["Salaries", "Rent", "Marketing", "Tools", "Internet", "Other"];

const TASK_STATUSES = [
  { id: "todo",       label: "To Do",       color: "#64748b", icon: "⭕" },
  { id: "inprogress", label: "In Progress", color: "#f59e0b", icon: "🟡" },
  { id: "done",       label: "Done",        color: "#16a34a", icon: "✅" },
];

const TASK_PRIORITIES = [
  { id: "low",    label: "Low",    color: "#64748b" },
  { id: "medium", label: "Medium", color: "#f59e0b" },
  { id: "high",   label: "High",   color: "#dc2626" },
];

// Member tab permissions
const MEMBER_TABS = [
  { id: "dashboard",   label: "📊 Dashboard",      defaultOn: true  },
  { id: "sales",       label: "🔑 Sales",          defaultOn: true  },
  { id: "customers",   label: "👤 Customers",      defaultOn: true  },
  { id: "tasks",       label: "✅ Tasks",           defaultOn: true  },
  { id: "commission",  label: "💰 Commission",      defaultOn: true  },
  { id: "stock",       label: "📦 Stock",           defaultOn: true  },
  { id: "adobe",       label: "🎨 Adobe",           defaultOn: true  },
  { id: "guide",       label: "📋 Guide",           defaultOn: true  },
];
const DEFAULT_MEMBER_PERMS = MEMBER_TABS.reduce((o, t) => { o[t.id] = t.defaultOn; return o; }, {});

// Granular per-action permissions. Each member has "perms" at tab level PLUS
// "actions" for who can see/edit/delete what.
const PERM_ACTIONS = [
  { id: "salesViewAll",    label: "🔑 See all sales (not just own)", defaultOn: false },
  { id: "salesEditAll",    label: "🔑 Edit all sales",                defaultOn: false },
  { id: "salesDelete",     label: "🔑 Delete sales",                  defaultOn: false },
  { id: "customersViewAll",label: "👤 See all customers",             defaultOn: false },
  { id: "tasksViewAll",    label: "✅ See all tasks",                  defaultOn: false },
  { id: "tasksEditAll",    label: "✅ Edit all tasks",                 defaultOn: false },
  { id: "adobeEdit",       label: "🎨 Edit Adobe renewals",           defaultOn: true  },
  { id: "stockEdit",       label: "📦 Edit stock",                    defaultOn: true  },
  { id: "approveProofs",   label: "📎 Approve/reject payment proofs", defaultOn: false },
  { id: "viewCommissionAll", label: "💰 See all team's commissions",   defaultOn: false },
];
const DEFAULT_MEMBER_ACTIONS = PERM_ACTIONS.reduce((o, a) => { o[a.id] = a.defaultOn; return o; }, {});

const DEFAULT_WA_TEMPLATES = [
  { id: 1, name: "🎉 Welcome", text: "Hi {customer}! 🎉\n\nWelcome to ProSkill Digital Agency! Your {service} subscription has been activated successfully.\n\nIf you need any help or have questions, we're here for you 24/7.\n\nBest regards,\n_ProSkill Team_" },
  { id: 2, name: "⏰ Renewal Reminder", text: "Hi {customer},\n\nYour *{service}* subscription renews on {renewDate} (in {days} days).\n\n💰 Amount: {price} {currency}\n\nWould you like to proceed with the renewal?\n\n_ProSkill Digital Agency_" },
  { id: 3, name: "💳 Payment Request", text: "Hi {customer},\n\nPlease complete your payment for *{service}*:\n\n💰 Amount: {price} {currency}\n\nPayment methods:\n• Bank Transfer\n• Vodafone Cash: 01270935507\n• InstaPay\n\nReply with payment proof when done. Thank you!\n\n_ProSkill Digital Agency_" },
  { id: 4, name: "🚨 Overdue Notice", text: "Hi {customer},\n\nYour *{service}* subscription has expired.\n\nTo avoid service interruption, please renew as soon as possible:\n💰 {price} {currency}\n\nNeed assistance? Reply to this message.\n\n_ProSkill Digital Agency_" },
  { id: 5, name: "⭐ Review Request", text: "Hi {customer}! 😊\n\nThank you for choosing ProSkill! How was your experience with *{service}*?\n\nWe'd love your feedback — reply with a rating from 1 to 5 stars ⭐\n\nYour opinion helps us improve!\n\n_ProSkill Team_" },
];

// ═══════════════════════════════════════════════════════════════════
// 🎨 THEME SYSTEM (mobile-first with generous sizing)
// ═══════════════════════════════════════════════════════════════════
function makeTheme(dark, isMobile) {
  const bg = dark ? "#0f172a" : "#f5f7f9";
  const cardBg = dark ? "#1e293b" : "#ffffff";
  const cardBg2 = dark ? "#0f172a" : "#f5f7f9";
  const text = dark ? "#e2e8f0" : "#1a2e44";
  const textMuted = dark ? "#94a3b8" : "#64748b";
  const border = dark ? "#334155" : "#e8ebe9";
  const primary = "#2a9d8f";
  const primaryDark = "#1a2e44";
  const danger = "#dc2626";
  const warning = "#f59e0b";
  const success = "#16a34a";

  // Font sizes — mobile first, but readable on desktop too
  const fs = {
    xs:   isMobile ? 11 : 9,   // smallest labels
    sm:   isMobile ? 12 : 10,  // secondary text
    base: isMobile ? 14 : 11,  // body text
    md:   isMobile ? 15 : 12,  // emphasized
    lg:   isMobile ? 17 : 13,  // tab titles, card headers
    xl:   isMobile ? 20 : 15,  // page headings
    xxl:  isMobile ? 26 : 20,  // big numbers
    xxxl: isMobile ? 32 : 24,  // hero numbers
  };

  // Spacing — more generous on mobile
  const sp = {
    xs:  isMobile ? 6 : 4,
    sm:  isMobile ? 8 : 6,
    md:  isMobile ? 12 : 8,
    lg:  isMobile ? 16 : 12,
    xl:  isMobile ? 20 : 16,
    xxl: isMobile ? 28 : 20,
  };

  // Tap targets — MUST be bigger on mobile
  const tapH = isMobile ? 44 : 32;
  const btnPad = isMobile ? "10px 16px" : "6px 12px";
  const inputH = isMobile ? 44 : 32;

  return {
    dark, isMobile, bg, cardBg, cardBg2, text, textMuted, border,
    primary, primaryDark, danger, warning, success, fs, sp, tapH, btnPad, inputH,

    // Reusable style fragments
    card: {
      background: cardBg,
      borderRadius: 12,
      padding: isMobile ? 14 : 12,
      boxShadow: dark ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
      border: "1px solid " + border,
    },
    cardCompact: {
      background: cardBg,
      borderRadius: 10,
      padding: isMobile ? 10 : 8,
      boxShadow: dark ? "none" : "0 1px 2px rgba(0,0,0,0.04)",
      border: "1px solid " + border,
    },
    btnPrimary: {
      background: primary,
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: btnPad,
      cursor: "pointer",
      fontWeight: 600,
      fontSize: fs.base,
      minHeight: tapH,
      whiteSpace: "nowrap",
      WebkitTapHighlightColor: "transparent",
      transition: "opacity 0.15s, transform 0.1s",
    },
    btnDanger: {
      background: danger,
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: btnPad,
      cursor: "pointer",
      fontWeight: 600,
      fontSize: fs.base,
      minHeight: tapH,
      whiteSpace: "nowrap",
      WebkitTapHighlightColor: "transparent",
      transition: "opacity 0.15s, transform 0.1s",
    },
    btnGhost: {
      background: "transparent",
      color: primary,
      border: "1px solid " + primary,
      borderRadius: 8,
      padding: btnPad,
      cursor: "pointer",
      fontWeight: 600,
      fontSize: fs.base,
      minHeight: tapH,
      whiteSpace: "nowrap",
      WebkitTapHighlightColor: "transparent",
      transition: "opacity 0.15s, transform 0.1s",
    },
    btnWA: {
      background: "#25D366",
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: btnPad,
      cursor: "pointer",
      fontWeight: 600,
      fontSize: fs.base,
      minHeight: tapH,
      textDecoration: "none",
      whiteSpace: "nowrap",
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
    },
    input: {
      border: "1px solid " + (dark ? "#475569" : "#d1d9e0"),
      borderRadius: 8,
      padding: isMobile ? "10px 12px" : "6px 10px",
      fontSize: fs.base,
      minHeight: inputH,
      width: "100%",
      boxSizing: "border-box",
      outline: "none",
      background: dark ? "#334155" : "#fff",
      color: text,
      fontFamily: "inherit",
    },
    label: {
      display: "block",
      fontSize: fs.sm,
      fontWeight: 600,
      color: textMuted,
      marginBottom: 4,
    },
    badge: (done) => ({
      display: "inline-block",
      padding: isMobile ? "4px 10px" : "2px 8px",
      borderRadius: 20,
      fontSize: fs.sm,
      fontWeight: 700,
      background: done ? "#fef2f2" : "#e8f4f2",
      color: done ? danger : primary,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 🛠️ HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════
function todayStr() {
  const t = new Date();
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}
function dateToStr(d) {
  const t = new Date(d);
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}
function addMonths(s, m) {
  const d = new Date(s);
  d.setMonth(d.getMonth() + m);
  return dateToStr(d);
}
function daysLeft(s) {
  if (!s) return 0;
  const n = new Date(); n.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(s) - n) / 864e5);
}
function formatDate(s) {
  if (!s) return "";
  const d = new Date(s);
  return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
}
function getWeekRange(d) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day >= 6 ? day - 6 : day + 1;
  const s = new Date(x); s.setDate(x.getDate() - diff);
  const e = new Date(s); e.setDate(s.getDate() + 6);
  return { s: dateToStr(s), e: dateToStr(e) };
}
function getMonthRange(d) {
  const x = new Date(d);
  return {
    s: dateToStr(new Date(x.getFullYear(), x.getMonth(), 1)),
    e: dateToStr(new Date(x.getFullYear(), x.getMonth() + 1, 0)),
  };
}
function getDateRange(s, e) {
  const d = [];
  const a = new Date(s), b = new Date(e);
  while (a <= b) { d.push(dateToStr(a)); a.setDate(a.getDate() + 1); }
  return d;
}
function toEgp(amt, cur) {
  return Math.round(amt * (RATES_TO_EGP[cur] || 1));
}
function waLink(phone, msg) {
  return "https://wa.me/" + (phone || "").replace(/[^0-9]/g, "") + "?text=" + encodeURIComponent(msg);
}
function copyToClipboard(t) {
  try { navigator.clipboard.writeText(t); return true; } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════
// 📥 EXPORT HELPERS
// ═══════════════════════════════════════════════════════════════════
function exportCSV(data, filename) {
  if (!data.length) { alert("No data to export"); return; }
  const keys = Object.keys(data[0]);
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const csv = "\uFEFF" + [keys.join(","), ...data.map(r => keys.map(k => esc(r[k])).join(","))].join("\n");
  const b = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const u = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = u; a.download = filename; a.click();
  URL.revokeObjectURL(u);
}

function exportExcel(data, filename, sheetName) {
  if (!data.length) { alert("No data to export"); return; }
  const keys = Object.keys(data[0]);
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cellType = (v) => (typeof v === "number" && isFinite(v)) ? "Number" : "String";
  const header = keys.map(k => '<Cell ss:StyleID="h"><Data ss:Type="String">' + esc(k) + '</Data></Cell>').join("");
  const rows = data.map(r => "<Row>" + keys.map(k => {
    const v = r[k];
    return '<Cell><Data ss:Type="' + cellType(v) + '">' + esc(v) + '</Data></Cell>';
  }).join("") + "</Row>").join("");
  const xml = '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="h"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2a9d8f" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="' + esc(sheetName || "Sheet1") + '"><Table><Row>' + header + "</Row>" + rows + "</Table></Worksheet></Workbook>";
  const b = new Blob([xml], { type: "application/vnd.ms-excel" });
  const u = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = u; a.download = filename; a.click();
  URL.revokeObjectURL(u);
}

function exportPDF(title, data, filename) {
  if (!data.length) { alert("No data to export"); return; }
  const keys = Object.keys(data[0]);
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) { alert("Please allow popups to export PDF"); return; }
  const css = "body{font-family:'Inter',system-ui,sans-serif;color:#1a2e44;padding:32px;margin:0;background:#fff}.hdr{background:linear-gradient(135deg,#1a2e44,#2a9d8f);color:#fff;padding:18px 24px;border-radius:10px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center}.hdr h1{margin:0;font-size:20px;font-weight:800}.hdr p{margin:0;font-size:10px;letter-spacing:2px;opacity:0.85}.meta{font-size:11px;color:#64748b;margin-bottom:14px;display:flex;justify-content:space-between}table{width:100%;border-collapse:collapse;font-size:10px}th{background:#1a2e44;color:#fff;padding:8px 10px;text-align:left;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;font-size:9px}td{padding:7px 10px;border-bottom:1px solid #e8ebe9}tr:nth-child(even) td{background:#f9fafb}.footer{margin-top:20px;padding-top:12px;border-top:2px solid #2a9d8f;font-size:9px;color:#64748b;text-align:center}@media print{body{padding:12px}.hdr{border-radius:0}}";
  const html = '<!DOCTYPE html><html><head><title>' + esc(title) + '</title><style>' + css + '</style></head><body>' +
    '<div class="hdr"><div><h1>' + esc(title) + '</h1><p>PROSKILL DIGITAL AGENCY</p></div>' +
    '<div style="text-align:right"><p>Generated</p><p style="font-size:12px;font-weight:600;opacity:1">' + new Date().toLocaleDateString() + '</p></div></div>' +
    '<div class="meta"><span><strong>' + data.length + '</strong> record' + (data.length !== 1 ? "s" : "") + '</span><span>' + esc(title) + '</span></div>' +
    '<table><thead><tr>' + keys.map(k => '<th>' + esc(k) + '</th>').join("") + '</tr></thead>' +
    '<tbody>' + data.map(r => "<tr>" + keys.map(k => '<td>' + esc(r[k]) + '</td>').join("") + "</tr>").join("") + '</tbody></table>' +
    '<div class="footer">ProSkill Digital Agency &middot; ' + COMPANY.website + ' &middot; ' + COMPANY.email + '</div>' +
    '<script>window.onload=function(){setTimeout(function(){window.print();},300);}</script></body></html>';
  w.document.write(html);
  w.document.close();
}

// ═══════════════════════════════════════════════════════════════════
// 🧩 UI PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

function CopyBtn({ text, label, theme }) {
  const [done, setDone] = useState(false);
  const t = theme;
  const handle = (e) => {
    e.stopPropagation();
    if (copyToClipboard(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }
  };
  return (
    <button onClick={handle} title={"Copy " + (label || "")} style={{
      background: done ? t.success : (t.dark ? "#334155" : "#e8f4f2"),
      color: done ? "#fff" : t.primary,
      border: "none",
      borderRadius: 6,
      padding: t.isMobile ? "4px 10px" : "2px 8px",
      fontSize: t.fs.sm,
      cursor: "pointer",
      fontWeight: 600,
      flexShrink: 0,
      minHeight: t.isMobile ? 32 : 22,
    }}>{done ? "✓" : "Copy"}</button>
  );
}

function PassCell({ val, theme }) {
  const [show, setShow] = useState(false);
  const t = theme;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: t.fs.base, fontFamily: "monospace", color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: t.isMobile ? 140 : 100 }}>
        {show ? val : "••••••••"}
      </span>
      <button onClick={(e) => { e.stopPropagation(); setShow(s => !s); }} style={{
        background: "none", border: "none", cursor: "pointer", fontSize: t.fs.md, padding: 0, flexShrink: 0, color: t.textMuted, minHeight: t.isMobile ? 32 : 22, minWidth: t.isMobile ? 32 : 22,
      }}>{show ? "🙈" : "👁"}</button>
      <CopyBtn text={val} label="password" theme={t} />
    </div>
  );
}

function ExportMenu({ onCsv, onXlsx, onPdf, theme }) {
  const [open, setOpen] = useState(false);
  const t = theme;
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(o => !o)} style={t.btnPrimary}>📥 Export ▾</button>
      {open && (<>
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
        <div style={{
          position: "absolute", top: "100%", right: 0, marginTop: 4,
          background: t.cardBg, border: "1px solid " + t.border,
          borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
          zIndex: 50, minWidth: t.isMobile ? 180 : 150, overflow: "hidden",
        }}>
          <div onClick={() => { onPdf(); setOpen(false); }} style={{ padding: t.isMobile ? "12px 14px" : "8px 12px", cursor: "pointer", fontSize: t.fs.base, color: t.text, borderBottom: "1px solid " + t.border }}>📄 PDF</div>
          <div onClick={() => { onXlsx(); setOpen(false); }} style={{ padding: t.isMobile ? "12px 14px" : "8px 12px", cursor: "pointer", fontSize: t.fs.base, color: t.text, borderBottom: "1px solid " + t.border }}>📊 Excel</div>
          <div onClick={() => { onCsv(); setOpen(false); }} style={{ padding: t.isMobile ? "12px 14px" : "8px 12px", cursor: "pointer", fontSize: t.fs.base, color: t.text }}>📋 CSV</div>
        </div>
      </>)}
    </div>
  );
}

function Chart({ data, height, color, theme }) {
  const t = theme;
  const h = height || (t.isMobile ? 120 : 100);
  if (!data || !data.length) return <p style={{ fontSize: t.fs.sm, color: t.textMuted, textAlign: "center", padding: 12 }}>No data</p>;
  const mx = Math.max(1, ...data.map(d => d.rev));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: h, overflowX: "auto", paddingBottom: 2 }}>
      {data.map((d, i) => {
        const bh = mx > 0 ? (d.rev / mx) * (h - 28) : 0;
        return (
          <div key={i} style={{ flex: "1 0 " + (t.isMobile ? 22 : 18) + "px", maxWidth: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span style={{ fontSize: t.fs.xs, color: t.textMuted, minHeight: 10 }}>{d.rev > 0 ? d.rev : ""}</span>
            <div style={{ width: "100%", height: Math.max(3, bh), background: d.count > 0 ? (color || t.primary) : (t.dark ? "#334155" : "#e2e8f0"), borderRadius: "3px 3px 0 0" }} />
            <span style={{ fontSize: t.fs.xs, color: t.textMuted }}>{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

let saveTimer = null;
let saveInFlight = false;
let pendingData = null; // holds latest data waiting to save

// END OF DROP 1
// Foundation complete — next drop: main App component, state, auth screens

// ═══════════════════════════════════════════════════════════════════
// 🚀 MAIN APP COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const viewport = useViewport();
  const { isMobile } = viewport;

  // ─── AUTH STATE ───
  const [authStatus, setAuthStatus] = useState("loading"); // loading | login | app
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [workspaceOwnerId, setWorkspaceOwnerId] = useState(null); // admin's user id (all workspace data lives under this)
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState("saved");

  // ─── APP DATA ───
  const [services, setServices] = useState(DEFAULT_SERVICES);
  const [sales, setSales] = useState([]);
  const [sConf, setSConf] = useState({});
  const [stockRows, setStockRows] = useState([]);
  const [guides, setGuides] = useState([]);
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST);
  const [customers, setCustomers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [comments, setComments] = useState({});
  const [expenses, setExpenses] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [feedback, setFeedback] = useState({});
  const [waTemplates, setWaTemplates] = useState(DEFAULT_WA_TEMPLATES);
  const [team, setTeam] = useState([]);
  const [dark, setDark] = useState(false);
  const [undoStack, setUndoStack] = useState([]);

  // ─── UI STATE ───
  const [tab, setTab] = useState("dashboard");
  const [sideOpen, setSideOpen] = useState(!isMobile);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Sales UI
  const [salesFilter, setSalesFilter] = useState("all");
  const [salesPeriod, setSalesPeriod] = useState("today"); // today | week | month | year | all | custom
  const [adobeSearch, setAdobeSearch] = useState("");
  const [adobeFilter, setAdobeFilter] = useState("all"); // all | overdue | due | upcoming | renewed
  const [adobeSort, setAdobeSort] = useState("days"); // days | name | renewDate
  const [editSale, setEditSale] = useState(null);
  const [newSale, setNewSale] = useState(null);
  const [selSale, setSelSale] = useState(null);
  const [search, setSearch] = useState("");
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");
  const [salesFilterProd, setSalesFilterProd] = useState("all");
  const [salesFilterPhone, setSalesFilterPhone] = useState("");
  const [selBulk, setSelBulk] = useState([]);
  const [newCmt, setNewCmt] = useState("");

  // Service UI
  const [nSvcN, setNSvcN] = useState("");
  const [nSvcI, setNSvcI] = useState("📦");
  const [showIP, setShowIP] = useState(false);

  // Guide UI
  const [newGuide, setNewGuide] = useState(null);
  const [editGuide, setEditGuide] = useState(null);

  // Customer UI
  const [selCust, setSelCust] = useState(null);
  const [custSearch, setCustSearch] = useState("");
  const [custFilterStatus, setCustFilterStatus] = useState("all");

  // Reports UI
  const [repTab, setRepTab] = useState("all");

  // Modals
  const [showFU, setShowFU] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [seenN, setSeenN] = useState([]);
  const [invSale, setInvSale] = useState(null);
  const [newExp, setNewExp] = useState(null);
  const [proofModal, setProofModal] = useState(null);
  const [showBackup, setShowBackup] = useState(false);
  const [showTemplates, setShowTemplates] = useState(null);
  const [editTemplate, setEditTemplate] = useState(null);
  const [newTask, setNewTask] = useState(null);
  const [editTask, setEditTask] = useState(null);
  const [newBundle, setNewBundle] = useState(null);
  const [showRate, setShowRate] = useState(null);
  const [newMember, setNewMember] = useState(null);
  const [editMember, setEditMember] = useState(null);
  const [commissionPeriod, setCommissionPeriod] = useState("thisMonth");
  const [dPer, setDPer] = useState("wtd");
  const [dashboardYear, setDashboardYear] = useState(new Date().getFullYear());
  const [dashboardMonth, setDashboardMonth] = useState("all"); // "all" | "0".."11"
  const fileInputRef = useRef(null);

  // Stock UI
  const [stockSearch, setStockSearch] = useState("");
  const [stockView, setStockView] = useState("all");
  const [stockFilterProd, setStockFilterProd] = useState("all");
  const [stockEditId, setStockEditId] = useState(null);
  const [stockEditRow, setStockEditRow] = useState(null);
  const [stockShowAdd, setStockShowAdd] = useState(false);
  const [stockNewRow, setStockNewRow] = useState({ product: "", email: "", password: "", link: "", note: "" });

  const svcNames = useMemo(() => services.map(s => s.name), [services]);
  const svcIcon = useCallback((n) => { const f = services.find(s => s.name === n); return f ? f.icon : "📦"; }, [services]);

  // ═══ ROLE DETECTION ═══
  // Admin email match OR no member profile found = admin. Otherwise member.
  const memberProfile = useMemo(() => {
    if (!currentUser || !currentUser.email) return null;
    const emailLower = currentUser.email.toLowerCase();
    if (emailLower === ADMIN_EMAIL.toLowerCase()) return null;
    return team.find(m => (m.email || "").toLowerCase() === emailLower) || null;
  }, [currentUser, team]);
  const isAdmin = !memberProfile;
  const memberId = memberProfile ? memberProfile.id : null;
  const memberPerms = memberProfile ? (memberProfile.permissions || DEFAULT_MEMBER_PERMS) : null;
  const memberActions = memberProfile ? (memberProfile.actions || DEFAULT_MEMBER_ACTIONS) : null;
  // Helper: check granular action permission
  const can = useCallback((action) => {
    if (isAdmin) return true;
    if (!memberActions) return false;
    return memberActions[action] === true;
  }, [isAdmin, memberActions]);
  const cU = currentUser ? {
    name: memberProfile ? memberProfile.name : currentUser.email,
    role: isAdmin ? "admin" : "member",
    email: currentUser.email,
  } : null;

  // ═══ THEME ═══
  const theme = useMemo(() => makeTheme(dark, isMobile), [dark, isMobile]);
  const t = theme;

  // ═══ INITIAL AUTH & LOAD ═══
  useEffect(() => {
    (async () => {
      try {
        const tok = localStorage.getItem("ps_t");
        const ref = localStorage.getItem("ps_r");
        if (tok) {
          sb.token = tok;
          const u = await sb.getUser();
          if (u) {
            await loadWorkspace(u);
            setCurrentUser(u);
            setAuthStatus("app");
            return;
          }
        }
        if (ref) {
          const res = await sb.refresh(ref);
          if (res.ok && sb.user) {
            await loadWorkspace(sb.user);
            setCurrentUser(sb.user);
            setAuthStatus("app");
            return;
          }
        }
      } catch (e) { /* fall through */ }
      setAuthStatus("login");
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Figure out which workspace to load:
  // - If user is admin (their email matches ADMIN_EMAIL) → load their own workspace
  // - If user is a member → we need to know the admin's user_id to load the shared workspace
  // For simplicity: admin's workspace is keyed by admin's user_id. Members' clients try loading
  // their own workspace first, then fall back to a pre-known admin workspace.
  // The cleanest approach: store adminUserId in localStorage when admin first logs in.
  const loadWorkspace = async (user) => {
    setLoaded(false);
    try {
      // Admin: use their own id as the workspace owner
      if ((user.email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
        setWorkspaceOwnerId(user.id);
        try { localStorage.setItem("ps_admin_id", user.id); } catch {}
        let d = await sb.loadData(user.id);
        // Fallback to localStorage backup if cloud load failed/empty
        if (!d) {
          try {
            const backup = localStorage.getItem("ps_backup_" + user.id);
            if (backup) {
              const parsed = JSON.parse(backup);
              d = parsed.data;
            }
          } catch {}
        }
        applyLoadedData(d);
        setLoaded(true);
        return;
      }
      // Member: find admin's workspace using the well-known ADMIN_EMAIL key (works across devices)
      const byEmail = await sb.loadAdminWorkspaceByEmail(ADMIN_EMAIL);
      if (byEmail && byEmail.ownerId) {
        setWorkspaceOwnerId(byEmail.ownerId);
        try { localStorage.setItem("ps_admin_id", byEmail.ownerId); } catch {}
        let d = byEmail.data;
        if (!d) {
          try {
            const backup = localStorage.getItem("ps_backup_" + byEmail.ownerId);
            if (backup) {
              const parsed = JSON.parse(backup);
              d = parsed.data;
            }
          } catch {}
        }
        applyLoadedData(d);
        setLoaded(true);
        return;
      }
      // Legacy fallback: use admin's id from localStorage
      const adminId = localStorage.getItem("ps_admin_id");
      if (adminId) {
        setWorkspaceOwnerId(adminId);
        let d = await sb.loadData(adminId);
        if (!d) {
          try {
            const backup = localStorage.getItem("ps_backup_" + adminId);
            if (backup) {
              const parsed = JSON.parse(backup);
              d = parsed.data;
            }
          } catch {}
        }
        applyLoadedData(d);
        setLoaded(true);
        return;
      }
      // Fallback: try their own workspace (empty)
      setWorkspaceOwnerId(user.id);
      setLoaded(true);
    } catch (e) {
      setLoaded(true);
    }
  };

  const applyLoadedData = (d) => {
    if (!d) return;
    if (d.services) setServices(d.services);
    else if (d.svcs) setServices(d.svcs);
    if (d.sales) setSales(d.sales);
    if (d.sConf) setSConf(d.sConf);
    if (d.stockRows) setStockRows(d.stockRows);
    if (d.guides) setGuides(d.guides);
    if (d.checklist) setChecklist(d.checklist);
    else if (d.cl) setChecklist(d.cl);
    if (d.customers) setCustomers(d.customers);
    else if (d.custs) setCustomers(d.custs);
    if (d.logs) setLogs(d.logs);
    if (typeof d.dark === "boolean") setDark(d.dark);
    else if (typeof d.dk === "boolean") setDark(d.dk);
    if (d.comments) setComments(d.comments);
    else if (d.cmts) setComments(d.cmts);
    if (d.expenses) setExpenses(d.expenses);
    else if (d.exps) setExpenses(d.exps);
    if (d.tasks) setTasks(d.tasks);
    if (d.bundles) setBundles(d.bundles);
    if (d.feedback) setFeedback(d.feedback);
    if (d.waTemplates) setWaTemplates(d.waTemplates);
    if (d.team) setTeam(d.team);
  };

  // ═══ AUTO-SAVE (with queue, retry, local backup) ═══
  useEffect(() => {
    if (!loaded || authStatus !== "app" || !workspaceOwnerId) return;

    const dataToSave = {
      services, sales, sConf, stockRows, guides, checklist, customers, logs,
      dark, comments, expenses, tasks, bundles, feedback, waTemplates, team,
    };

    // 1. ALWAYS write to localStorage immediately so data is never lost
    try {
      localStorage.setItem("ps_backup_" + workspaceOwnerId, JSON.stringify({
        data: dataToSave,
        savedAt: new Date().toISOString(),
      }));
    } catch {}

    // 2. Queue latest data for cloud save
    pendingData = dataToSave;
    setSyncStatus("saving");

    // 3. Debounce: wait 1s after last change before hitting cloud (faster feel)
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const doSave = async () => {
        // Guard: only one save at a time, but ALWAYS process pendingData
        if (saveInFlight || !pendingData) return;
        saveInFlight = true;
        // Safety: force-reset flag after 20s in case something goes badly wrong
        const safetyReset = setTimeout(() => { saveInFlight = false; }, 20000);
        const snapshot = pendingData;
        pendingData = null;
        try {
          const r = await sb.saveData(workspaceOwnerId, snapshot, ADMIN_EMAIL);
          if (r.ok) {
            if (!pendingData) setSyncStatus("saved");
          } else {
            setSyncStatus("error");
            if (!pendingData) pendingData = snapshot;
          }
        } catch {
          setSyncStatus("error");
          if (!pendingData) pendingData = snapshot;
        } finally {
          clearTimeout(safetyReset);
          saveInFlight = false;
          // If new changes arrived during save, save them now
          if (pendingData) {
            setTimeout(doSave, 200);
          }
        }
      };
      // Even if a save is already in flight, trigger again shortly (it will early-exit if truly in flight)
      if (saveInFlight) {
        setTimeout(doSave, 500);
      } else {
        doSave();
      }
    }, 1000);
  }, [
    services, sales, sConf, stockRows, guides, checklist, customers, logs,
    dark, comments, expenses, tasks, bundles, feedback, waTemplates, team,
    loaded, authStatus, workspaceOwnerId,
  ]);

  // ═══ Retry failed saves periodically ═══
  useEffect(() => {
    if (syncStatus !== "error" || !loaded || !workspaceOwnerId) return;
    const retry = setTimeout(() => {
      if (pendingData && !saveInFlight) {
        saveInFlight = true;
        const snapshot = pendingData;
        pendingData = null;
        sb.saveData(workspaceOwnerId, snapshot, ADMIN_EMAIL).then(r => {
          saveInFlight = false;
          if (r.ok) setSyncStatus(pendingData ? "saving" : "saved");
          else { if (!pendingData) pendingData = snapshot; }
        }).catch(() => {
          saveInFlight = false;
          if (!pendingData) pendingData = snapshot;
        });
      }
    }, 8000); // retry every 8 seconds while in error state
    return () => clearTimeout(retry);
  }, [syncStatus, loaded, workspaceOwnerId]);

  // Reset current tab if it becomes invalid for the member
  useEffect(() => {
    if (!isAdmin && memberPerms && tab && !memberPerms[tab === "sales_entry" ? "sales" : tab]) {
      // Find first allowed tab
      const allowed = Object.keys(memberPerms).find(k => memberPerms[k]);
      if (allowed) setTab(allowed === "sales" ? "sales_entry" : allowed);
    }
  }, [isAdmin, memberPerms, tab]);

  // Close sidebar by default on mobile
  useEffect(() => {
    if (isMobile) setSideOpen(false);
    else setSideOpen(true);
  }, [isMobile]);

  // ═══ ADD LOG ═══
  const addLog = (action) => {
    const entry = {
      id: Date.now() + Math.random(),
      user: cU ? cU.name : "System",
      action,
      time: new Date().toISOString(),
    };
    setLogs(p => [entry, ...p].slice(0, 300));
  };

  // ═══ AUTH HANDLERS ═══
  const handleSignUp = async () => {
    setAuthError("");
    if (!authEmail || !authPassword) { setAuthError("Email and password required"); return; }
    if (authPassword.length < 6) { setAuthError("Password must be at least 6 characters"); return; }
    setAuthLoading(true);
    const r = await sb.signUp(authEmail, authPassword);
    setAuthLoading(false);
    if (r.ok && sb.user) {
      setCurrentUser(sb.user);
      await loadWorkspace(sb.user);
      setAuthStatus("app");
    } else {
      const msg = (r.data && (r.data.error_description || r.data.msg || r.data.error)) || "Signup failed";
      if (msg.toLowerCase().includes("already")) setAuthError("Account exists. Please sign in.");
      else setAuthError(msg);
    }
  };

  const handleSignIn = async () => {
    setAuthError("");
    if (!authEmail || !authPassword) { setAuthError("Email and password required"); return; }
    setAuthLoading(true);
    const r = await sb.signIn(authEmail, authPassword);
    setAuthLoading(false);
    if (r.ok && sb.user) {
      setCurrentUser(sb.user);
      await loadWorkspace(sb.user);
      setAuthStatus("app");
    } else {
      const msg = (r.data && (r.data.error_description || r.data.msg || r.data.error)) || "Invalid credentials";
      setAuthError(msg);
    }
  };

  const handleSignOut = async () => {
    await sb.signOut();
    setCurrentUser(null);
    setWorkspaceOwnerId(null);
    setAuthStatus("login");
    setAuthEmail("");
    setAuthPassword("");
    setLoaded(false);
    setTab("dashboard");
  };

  // ═══════════════════════════════════════════════════════════════════
  // 🟨 LOADING SCREEN (rendered at end if authStatus === "loading")
  // ═══════════════════════════════════════════════════════════════════
  const renderLoading = () => (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100vh", fontFamily: "'Inter',system-ui,sans-serif",
        background: "linear-gradient(135deg,#1a2e44,#2a9d8f)", color: "#fff",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 64, height: 64, borderRadius: 14,
            background: "rgba(255,255,255,0.2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 900, fontSize: 22, margin: "0 auto 16px",
          }}>PS</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>ProSkill</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>☁️ Connecting to cloud...</div>
        </div>
      </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  // 🔐 LOGIN SCREEN (rendered at end if authStatus === "login")
  // ═══════════════════════════════════════════════════════════════════
  const renderLogin = () => (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: "100vh", fontFamily: "'Inter',system-ui,sans-serif",
        background: "linear-gradient(135deg,#1a2e44,#2a9d8f)", padding: 16,
      }}>
        <div style={{
          background: "#fff", borderRadius: 16,
          padding: isMobile ? 28 : 36,
          width: "100%", maxWidth: 420,
          textAlign: "center",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 14, background: "#2a9d8f",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 800, fontSize: 22, color: "#fff",
            margin: "0 auto 14px",
          }}>PS</div>

          <h2 style={{ margin: "0 0 4px", fontSize: 26, color: "#1a2e44", fontWeight: 800 }}>ProSkill</h2>
          <p style={{ margin: "0 0 4px", fontSize: 12, color: "#2a9d8f", fontWeight: 700, letterSpacing: 3 }}>DIGITAL AGENCY</p>
          <p style={{ margin: "0 0 24px", fontSize: 12, color: "#94a3b8" }}>☁️ Cloud-powered · Works on any device</p>

          {authError && (
            <div style={{
              background: "#fef2f2", color: "#dc2626",
              padding: "12px 14px", borderRadius: 10,
              fontSize: 13, marginBottom: 14,
              textAlign: "left",
            }}>⚠️ {authError}</div>
          )}

          <div style={{ textAlign: "left", marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Email</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "14px 16px", fontSize: 16,
                border: "2px solid #e8ebe9", borderRadius: 10,
                outline: "none", color: "#1a2e44",
              }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSignIn(); }}
            />
          </div>

          <div style={{ textAlign: "left", marginBottom: 20 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "14px 16px", fontSize: 16,
                border: "2px solid #e8ebe9", borderRadius: 10,
                outline: "none", color: "#1a2e44",
              }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSignIn(); }}
            />
          </div>

          <button
            onClick={handleSignIn}
            disabled={authLoading}
            style={{
              width: "100%", padding: "14px",
              background: "#2a9d8f", color: "#fff",
              border: "none", borderRadius: 10,
              fontSize: 16, fontWeight: 700,
              cursor: "pointer", opacity: authLoading ? 0.6 : 1,
              marginBottom: 10,
              minHeight: 50,
            }}
          >{authLoading ? "Signing in..." : "Sign In →"}</button>

          <p style={{ margin: "20px 0 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>
            🔒 This system is private.<br/>
            Team members: use the email &amp; password shared by your admin.<br/>
            No public signup — contact your admin to get access.
          </p>
        </div>
      </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  // 🔧 BUSINESS LOGIC HANDLERS
  // ═══════════════════════════════════════════════════════════════════

  // ─── Validation ───
  const validateSale = (s) => {
    if (!s.customer || !s.customer.trim()) return "Customer name required";
    if (!s.price || s.price <= 0) return "Price must be greater than 0";
    return null;
  };

  // ─── Customer auto-create ───
  const ensureCustomer = (name, phone, email) => {
    if (!name) return;
    const nm = name.trim().toLowerCase();
    const ex = customers.find(c => c.name.toLowerCase() === nm);
    if (ex) {
      if ((phone && phone !== ex.phone) || (email && email !== ex.email)) {
        setCustomers(p => p.map(c => c.id === ex.id ? { ...c, phone: phone || c.phone, email: email || c.email } : c));
      }
      return;
    }
    setCustomers(p => [...p, {
      id: Date.now() + Math.random(),
      name: name.trim(),
      phone: phone || "",
      email: email || "",
      createdDate: todayStr(),
    }]);
  };

  // ─── Services ───
  const addService = () => {
    const n = nSvcN.trim();
    if (!n || svcNames.includes(n)) return;
    setServices(p => [...p, { name: n, icon: nSvcI }]);
    addLog("Added service: " + n);
    setNSvcN(""); setNSvcI("📦");
  };
  const removeService = (n) => {
    if (!confirm("Delete service '" + n + "'?")) return;
    setServices(p => p.filter(s => s.name !== n));
    setSales(p => p.filter(a => a.service !== n));
    addLog("Deleted service: " + n);
  };

  // ─── Stock linking ───
  const findAvailableAccount = (product) => stockRows.find(r => r.product === product && !r.sold);
  const unlinkStockFromSale = (saleId) => {
    const sale = sales.find(s => s.id === saleId);
    if (!sale || !sale.linkedStockId) return;
    setStockRows(p => p.map(r => r.id === sale.linkedStockId ? { ...r, sold: false, linkedSaleId: null } : r));
    setSales(p => p.map(s => s.id === saleId ? { ...s, linkedStockId: null } : s));
    addLog("🔓 Unlinked account from " + sale.customer);
  };

  // ─── Sales CRUD ───
  const addSaleEntry = () => {
    if (!newSale) return;
    // Validate shared fields first
    if (!newSale.customer || !newSale.customer.trim()) { alert("Customer name required"); return; }
    // Gather all service lines (new format: `lines` array; fallback: single-service legacy)
    const lines = newSale.lines && newSale.lines.length > 0
      ? newSale.lines
      : [{
          service: newSale.service,
          period: newSale.period,
          price: newSale.price,
          costPrice: newSale.costPrice || 0,
          currency: newSale.currency || "EGP",
        }];
    // Validate each line
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (!L.service) { alert("Service #" + (i + 1) + ": pick a service"); return; }
      if (!L.price || L.price <= 0) { alert("Service #" + (i + 1) + " (" + L.service + "): price must be > 0"); return; }
    }
    // Auto-assign for members
    const effectiveAssignedTo = isAdmin ? (newSale.assignedTo || null) : memberId;
    const soldDate = newSale.soldDate || todayStr();
    // Shared transaction ID so renewing one can hint at related ones
    const transactionId = Date.now();
    const created = [];
    lines.forEach((L, idx) => {
      const rD = L.period > 0
        ? addMonths(soldDate, L.period)
        : L.period === -1 ? "2099-12-31" : soldDate;
      const pe = toEgp(L.price, L.currency || "EGP");
      const ce = toEgp(L.costPrice || 0, L.currency || "EGP");
      const available = findAvailableAccount(L.service);
      const saleId = transactionId + idx; // unique per line
      const entry = {
        id: saleId,
        service: L.service,
        customer: newSale.customer,
        customerPhone: newSale.customerPhone || "",
        customerEmail: newSale.customerEmail || "",
        period: L.period,
        price: L.price,
        costPrice: L.costPrice || 0,
        currency: L.currency || "EGP",
        notes: newSale.notes || "",
        soldDate,
        done: false,
        followUp: false,
        renewDate: rD,
        checklist: checklist.map(c => ({ label: c, checked: false })),
        soldBy: cU ? cU.name : "?",
        assignedTo: effectiveAssignedTo,
        createdDate: todayStr(),
        priceEGP: pe, costEGP: ce,
        paymentProof: null, proofStatus: "none",
        linkedStockId: available ? available.id : null,
        transactionId: lines.length > 1 ? transactionId : null,
      };
      if (available) {
        setStockRows(p => p.map(r => r.id === available.id ? { ...r, sold: true, linkedSaleId: saleId } : r));
      }
      created.push(entry);
    });
    ensureCustomer(newSale.customer, newSale.customerPhone, newSale.customerEmail);
    setSales(p => [...created, ...p]);
    if (created.length === 1) {
      addLog("Sale: " + created[0].customer + " " + created[0].service);
    } else {
      addLog("📦 Multi-service sale (" + created.length + " items): " + newSale.customer + " — " + created.map(x => x.service).join(", "));
    }
    setNewSale(null);
  };

  const canEditSale = (s) => {
    if (isAdmin) return true;
    if (can("salesEditAll")) return true;
    return s.assignedTo === memberId;
  };
  const canDeleteSale = () => isAdmin || can("salesDelete");

  const toggleDone = (id) => {
    const a = sales.find(x => x.id === id);
    if (!a || !canEditSale(a)) return;
    setSales(p => p.map(x => x.id === id ? { ...x, done: !x.done } : x));
    addLog((!a.done ? "✓ Done" : "↩ Undo") + ": " + a.customer);
  };

  const toggleFollow = (id) => {
    const a = sales.find(x => x.id === id);
    if (!a || !canEditSale(a)) return;
    setSales(p => p.map(x => x.id === id ? { ...x, followUp: !x.followUp } : x));
  };

  const deleteSale = (id) => {
    if (!canDeleteSale()) { alert("Only admins can delete sales."); return; }
    const a = sales.find(x => x.id === id);
    if (!confirm("Delete this sale? (Can be undone via Ctrl+Z)")) return;
    if (a) {
      setUndoStack(p => [...p, a].slice(-20));
      if (a.linkedStockId) setStockRows(p => p.map(r => r.id === a.linkedStockId ? { ...r, sold: false, linkedSaleId: null } : r));
    }
    setSales(p => p.filter(x => x.id !== id));
    if (selSale && selSale.id === id) setSelSale(null);
    if (a) addLog("🗑 Deleted: " + a.customer);
  };

  const updateChecklist = (id, idx) => {
    const a = sales.find(x => x.id === id);
    if (!a || !canEditSale(a)) return;
    setSales(p => p.map(x => {
      if (x.id !== id) return x;
      const nc = x.checklist.map((item, i) => i === idx ? { ...item, checked: !item.checked } : item);
      const item = x.checklist[idx];
      if (item && item.label.toLowerCase().includes("payment") && !item.checked) {
        addLog("💳 Payment confirmed: " + x.customer);
      }
      return { ...x, checklist: nc };
    }));
  };

  const saveEditSale = () => {
    if (!editSale) return;
    if (!canEditSale(editSale)) { alert("You can't edit this sale."); return; }
    const err = validateSale(editSale);
    if (err) { alert(err); return; }
    const rD = editSale.period > 0
      ? addMonths(editSale.soldDate || editSale.createdDate, editSale.period)
      : editSale.period === -1 ? "2099-12-31" : editSale.soldDate || editSale.createdDate;
    const pe = toEgp(editSale.price, editSale.currency || "EGP");
    const ce = toEgp(editSale.costPrice || 0, editSale.currency || "EGP");
    ensureCustomer(editSale.customer, editSale.customerPhone, editSale.customerEmail);
    setSales(p => p.map(a => a.id === editSale.id ? { ...editSale, renewDate: rD, priceEGP: pe, costEGP: ce } : a));
    setEditSale(null);
    addLog("✎ Edited: " + editSale.customer);
  };

  const renewSale = (s) => {
    setNewSale({
      service: s.service,
      customer: s.customer,
      customerPhone: s.customerPhone,
      customerEmail: s.customerEmail,
      period: s.period,
      price: s.price,
      costPrice: s.costPrice || 0,
      currency: s.currency || "EGP",
      soldDate: todayStr(),
      notes: "Renewal",
      assignedTo: s.assignedTo || null,
    });
    setTab("sales_entry");
  };

  const addComment = (saleId) => {
    if (!newCmt.trim()) return;
    const c = { user: cU ? cU.name : "?", text: newCmt.trim(), time: new Date().toISOString() };
    setComments(p => ({ ...p, [saleId]: [...(p[saleId] || []), c] }));
    setNewCmt("");
  };

  // ─── Payment proof ───
  const uploadProof = (saleId, file) => {
    if (!file) return;
    const ok = ["image/jpeg", "image/jpg", "image/png", "application/pdf"];
    if (!ok.includes(file.type)) { alert("Only JPG, PNG, or PDF allowed"); return; }
    if (file.size > 5 * 1024 * 1024) { alert("File too large (max 5MB)"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const proof = {
        data: e.target.result,
        name: file.name,
        type: file.type,
        size: file.size,
        uploadedBy: cU ? cU.name : "?",
        uploadedAt: new Date().toISOString(),
      };
      setSales(p => p.map(s => s.id === saleId ? { ...s, paymentProof: proof } : s));
      addLog("📎 Proof image uploaded: " + file.name);
    };
    reader.readAsDataURL(file);
  };
  // NEW: Submit a payment claim (amount + note, image optional).
  // This works without image upload so it stays fast to sync.
  const submitPaymentClaim = (saleId, amount, note) => {
    if (!amount || amount <= 0) { alert("Enter the amount received"); return; }
    const claim = {
      amount: Number(amount),
      note: (note || "").trim(),
      claimedBy: cU ? cU.name : "?",
      claimedByEmail: currentUser ? currentUser.email : "",
      claimedAt: new Date().toISOString(),
    };
    setSales(p => p.map(s => s.id === saleId ? { ...s, paymentClaim: claim, proofStatus: "claimed" } : s));
    const a = sales.find(x => x.id === saleId);
    if (a) addLog("💰 Payment claimed: " + a.customer + " — " + amount + " " + (a.currency || "EGP"));
  };
  const approveProof = (saleId) => {
    if (!isAdmin && !can("approveProofs")) { alert("You don't have permission to approve payments."); return; }
    setSales(p => p.map(s => s.id === saleId ? {
      ...s,
      proofStatus: "approved",
      approvedBy: cU ? cU.name : "?",
      approvedAt: new Date().toISOString(),
      // Auto-check the "Payment" checklist item
      checklist: (s.checklist || []).map(c =>
        c.label.toLowerCase().includes("payment") ? { ...c, checked: true } : c
      ),
    } : s));
    const a = sales.find(x => x.id === saleId);
    if (a) addLog("✅ Payment approved: " + a.customer);
  };
  const rejectProof = (saleId) => {
    if (!isAdmin && !can("approveProofs")) { alert("You don't have permission to reject payments."); return; }
    if (!confirm("Reject this payment claim?")) return;
    setSales(p => p.map(s => s.id === saleId ? {
      ...s,
      proofStatus: "rejected",
      rejectedBy: cU ? cU.name : "?",
      rejectedAt: new Date().toISOString(),
    } : s));
    const a = sales.find(x => x.id === saleId);
    if (a) addLog("❌ Payment rejected: " + a.customer);
  };
  const removeProof = (saleId) => {
    if (!isAdmin && !can("approveProofs")) { alert("You don't have permission to remove payments."); return; }
    if (!confirm("Reset payment claim?")) return;
    setSales(p => p.map(s => s.id === saleId ? {
      ...s,
      paymentProof: null,
      paymentClaim: null,
      proofStatus: "none",
      approvedBy: null, approvedAt: null,
      rejectedBy: null, rejectedAt: null,
    } : s));
  };

  // ─── Bulk ops (admin only) ───
  const bulkDone = () => {
    if (!isAdmin) return;
    setSales(p => p.map(a => selBulk.includes(a.id) ? { ...a, done: true } : a));
    addLog("Bulk done: " + selBulk.length);
    setSelBulk([]);
  };
  const bulkDelete = () => {
    if (!isAdmin) return;
    if (!confirm("Delete " + selBulk.length + " sales?")) return;
    setSales(p => p.filter(a => !selBulk.includes(a.id)));
    addLog("Bulk delete: " + selBulk.length);
    setSelBulk([]);
  };

  // ─── Guides ───
  const addGuide = () => { if (!newGuide) return; setGuides(p => [...p, { ...newGuide, id: Date.now() }]); setNewGuide(null); };
  const deleteGuide = (id) => setGuides(p => p.filter(g => g.id !== id));
  const saveEditGuide = () => { if (!editGuide) return; setGuides(p => p.map(g => g.id === editGuide.id ? editGuide : g)); setEditGuide(null); };

  // ─── Expenses (admin only) ───
  const addExpense = () => {
    if (!isAdmin || !newExp || !newExp.amount || newExp.amount <= 0) return;
    setExpenses(p => [{ ...newExp, id: Date.now(), date: newExp.date || todayStr() }, ...p]);
    addLog("Expense: " + newExp.category + " " + newExp.amount);
    setNewExp(null);
  };

  // ─── Tasks (with status stages) ───
  const addTask = () => {
    if (!newTask || !newTask.title.trim()) return;
    // Members can only create tasks for themselves
    const effectiveAssignedTo = isAdmin ? (newTask.assignedTo || null) : memberId;
    const tNew = {
      ...newTask,
      id: Date.now(),
      status: "todo",
      assignedTo: effectiveAssignedTo,
      createdBy: cU ? cU.name : "?",
      createdAt: todayStr(),
    };
    setTasks(p => [tNew, ...p]);
    addLog("📝 Task: " + tNew.title);
    setNewTask(null);
  };
  const canEditTask = (tk) => {
    if (isAdmin) return true;
    if (can("tasksEditAll")) return true;
    return tk.assignedTo === memberId;
  };
  const setTaskStatus = (id, status) => {
    const tk = tasks.find(x => x.id === id);
    if (!tk || !canEditTask(tk)) return;
    setTasks(p => p.map(x => {
      if (x.id !== id) return x;
      const ns = { ...x, status };
      if (status === "done") ns.completedAt = todayStr();
      return ns;
    }));
    addLog("📝 Task '" + tk.title + "' → " + status);
  };
  const cycleTaskStatus = (id) => {
    const tk = tasks.find(x => x.id === id);
    if (!tk) return;
    const order = ["todo", "inprogress", "done"];
    const i = order.indexOf(tk.status || "todo");
    const next = order[(i + 1) % order.length];
    setTaskStatus(id, next);
  };
  const deleteTask = (id) => {
    if (!isAdmin) { alert("Only admins can delete tasks."); return; }
    setTasks(p => p.filter(t => t.id !== id));
  };
  const saveEditTask = () => {
    if (!editTask) return;
    if (!canEditTask(editTask)) { alert("You can't edit this task."); return; }
    setTasks(p => p.map(t => t.id === editTask.id ? editTask : t));
    setEditTask(null);
  };

  // ─── Bundles (admin only) ───
  const addBundle = () => {
    if (!isAdmin) return;
    if (!newBundle || !newBundle.name.trim() || !newBundle.services || newBundle.services.length < 2) {
      alert("Bundle needs a name and at least 2 services"); return;
    }
    const bundleServiceName = newBundle.name + " (Bundle)";
    if (!svcNames.includes(bundleServiceName)) {
      setServices(p => [...p, { name: bundleServiceName, icon: "📦" }]);
    }
    setBundles(p => [...p, { ...newBundle, id: Date.now() }]);
    addLog("📦 Bundle: " + newBundle.name);
    setNewBundle(null);
  };
  const deleteBundle = (id) => {
    if (!isAdmin) return;
    const b = bundles.find(x => x.id === id);
    setBundles(p => p.filter(x => x.id !== id));
    if (b) setServices(p => p.filter(s => s.name !== b.name + " (Bundle)"));
  };
  const sellBundle = (bundle) => {
    setNewSale({
      service: bundle.name + " (Bundle)",
      customer: "",
      customerPhone: "",
      customerEmail: "",
      period: bundle.period || 1,
      price: bundle.price || 0,
      costPrice: bundle.cost || 0,
      currency: "EGP",
      soldDate: todayStr(),
      notes: "Includes: " + bundle.services.join(", "),
      assignedTo: null,
    });
    setTab("sales_entry");
  };

  // ─── Feedback / ratings ───
  const submitFeedback = (saleId, rating) => {
    setFeedback(p => ({
      ...p,
      [saleId]: { rating, time: new Date().toISOString(), by: cU ? cU.name : "?" },
    }));
    if (rating <= 2) setSales(p => p.map(s => s.id === saleId ? { ...s, followUp: true } : s));
    setShowRate(null);
  };

  // ─── WA Templates ───
  const renderTemplate = (text, sale) => {
    if (!sale) return text;
    const days = sale.renewDate ? daysLeft(sale.renewDate) : "";
    return (text || "")
      .replace(/\{customer\}/g, sale.customer || "")
      .replace(/\{service\}/g, sale.service || "")
      .replace(/\{price\}/g, sale.price || "")
      .replace(/\{currency\}/g, sale.currency || "EGP")
      .replace(/\{period\}/g, PERIOD_LABEL(sale.period || 0))
      .replace(/\{renewDate\}/g, sale.renewDate || "")
      .replace(/\{soldDate\}/g, sale.soldDate || "")
      .replace(/\{days\}/g, days)
      .replace(/\{phone\}/g, sale.customerPhone || "")
      .replace(/\{email\}/g, sale.customerEmail || "")
      .replace(/\{notes\}/g, sale.notes || "");
  };
  const saveTemplate = () => {
    if (!editTemplate || !editTemplate.name.trim()) return;
    if (editTemplate.id) setWaTemplates(p => p.map(t => t.id === editTemplate.id ? editTemplate : t));
    else setWaTemplates(p => [...p, { ...editTemplate, id: Date.now() }]);
    setEditTemplate(null);
  };
  const deleteTemplate = (id) => {
    if (!confirm("Delete template?")) return;
    setWaTemplates(p => p.filter(t => t.id !== id));
  };

  // ─── Backup / Restore ───
  const backupAll = () => {
    const backup = {
      version: "2.0",
      exportedAt: new Date().toISOString(),
      exportedBy: cU ? cU.name : "Unknown",
      data: {
        services, sales, sConf, stockRows, guides, checklist, customers, logs,
        comments, expenses, tasks, bundles, feedback, waTemplates, team,
      },
    };
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "proskill_backup_" + todayStr() + ".json"; a.click();
    URL.revokeObjectURL(url);
    addLog("💾 Backup exported");
  };
  const restoreBackup = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const backup = JSON.parse(e.target.result);
        if (!backup.data) { alert("Invalid backup file"); return; }
        if (!confirm("⚠️ This will REPLACE all current data. Continue?")) return;
        applyLoadedData(backup.data);
        alert("✅ Backup restored!");
        setShowBackup(false);
      } catch (err) { alert("Failed to restore: " + err.message); }
    };
    reader.readAsText(file);
  };

  // ─── Stock CRUD ───
  const toggleStockSold = useCallback((id) => {
    setStockRows(p => p.map(r => r.id === id ? { ...r, sold: !r.sold } : r));
  }, []);
  const deleteStockRow = (id) => {
    if (!confirm("Delete this stock account?")) return;
    setStockRows(p => p.filter(r => r.id !== id));
  };
  const addStockRow = () => {
    if (!stockNewRow.email.trim() || !stockNewRow.product) return;
    setStockRows(p => [...p, { ...stockNewRow, id: Date.now(), sold: false }]);
    addLog("Added account: " + stockNewRow.product);
    setStockNewRow({ product: svcNames[0] || "", email: "", password: "", link: "", note: "" });
    setStockShowAdd(false);
  };
  const saveStockEdit = () => {
    if (!stockEditRow) return;
    setStockRows(p => p.map(r => r.id === stockEditRow.id ? stockEditRow : r));
    setStockEditId(null); setStockEditRow(null);
  };

  // ─── Team (admin only) ───
  const addMember = async () => {
    if (!isAdmin) return;
    if (!newMember || !newMember.name.trim()) { alert("Name is required"); return; }
    // If email + password given, create Supabase account
    if (newMember.email && newMember.email.trim() && newMember.password && newMember.password.length >= 6) {
      const r = await sb.adminCreateMember(newMember.email.trim(), newMember.password);
      if (!r.ok) {
        const msg = (r.data && (r.data.error_description || r.data.msg || r.data.error)) || "Unknown error";
        if (!msg.toLowerCase().includes("already")) {
          if (!confirm("⚠️ Couldn't create Supabase account: " + msg + "\n\nContinue adding member anyway (without login access)?")) return;
        } else {
          if (!confirm("ℹ️ This email already has a Supabase account. They can log in with their existing password. Continue?")) return;
        }
      }
    }
    const m = {
      ...newMember,
      id: Date.now(),
      name: newMember.name.trim(),
      email: (newMember.email || "").trim().toLowerCase(),
      permissions: newMember.permissions || { ...DEFAULT_MEMBER_PERMS },
      actions: newMember.actions || { ...DEFAULT_MEMBER_ACTIONS },
      createdAt: todayStr(),
    };
    delete m.password; // never store plaintext password in workspace data
    setTeam(p => [...p, m]);
    addLog("👤 Added team member: " + m.name);
    setNewMember(null);
  };

  const saveMember = () => {
    if (!isAdmin || !editMember || !editMember.name.trim()) return;
    const clean = { ...editMember };
    delete clean.password;
    setTeam(p => p.map(m => m.id === editMember.id ? clean : m));
    addLog("👤 Updated member: " + editMember.name);
    setEditMember(null);
  };

  const deleteMember = (id) => {
    if (!isAdmin) return;
    const m = team.find(x => x.id === id);
    if (!m) return;
    if (!confirm("Delete " + m.name + "?\n\nTheir past sales will remain (unassigned). Their Supabase account (if any) is NOT deleted — you'll need to remove it from Supabase dashboard separately if needed.")) return;
    setTeam(p => p.filter(x => x.id !== id));
    addLog("👤 Removed member: " + m.name);
  };

  // ─── Keyboard shortcuts (admin only) ───
  useEffect(() => {
    const handler = (e) => {
      if (authStatus !== "app") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.key === "n" && svcNames.length > 0 && isAdmin) {
        setNewSale({
          service: svcNames[0], customer: "", customerPhone: "", customerEmail: "",
          period: 1, price: 0, costPrice: 0, currency: "EGP",
          soldDate: todayStr(), notes: "", assignedTo: null,
        });
        setTab("sales_entry");
      }
      if (e.key === "z" && e.ctrlKey && undoStack.length > 0 && isAdmin) {
        const last = undoStack[undoStack.length - 1];
        setSales(p => [last, ...p]);
        setUndoStack(p => p.slice(0, -1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [authStatus, svcNames, undoStack, isAdmin]);

  // ═══════════════════════════════════════════════════════════════════
  // 📊 COMPUTED STATS & FILTERED DATA
  // ═══════════════════════════════════════════════════════════════════

  // Member data scope (for filtering views)
  const scopedSales = useMemo(() => {
    if (isAdmin) return sales;
    if (memberActions && memberActions.salesViewAll) return sales;
    return sales.filter(a => a.assignedTo === memberId);
  }, [sales, isAdmin, memberId, memberActions]);

  const allDone = useMemo(() => scopedSales.filter(a => a.done), [scopedSales]);
  const doneSales = allDone;
  const mySales = scopedSales;
  // Dashboard always shows MEMBER's OWN sales (regardless of salesViewAll permission)
  // Only the Sales tab itself shows everyone's sales when salesViewAll is on
  const dashboardSales = useMemo(() => {
    if (isAdmin) return sales;
    return sales.filter(a => a.assignedTo === memberId);
  }, [sales, isAdmin, memberId]);
  const dashboardDone = useMemo(() => dashboardSales.filter(a => a.done), [dashboardSales]);

  const stockStatsByProduct = useMemo(() => {
    const s = {};
    svcNames.forEach(p => {
      const all = stockRows.filter(r => r.product === p);
      s[p] = {
        avail: all.filter(r => !r.sold).length,
        sold: all.filter(r => r.sold).length,
        total: all.length,
      };
    });
    return s;
  }, [stockRows, svcNames]);

  const calcStats = useCallback((sl) => {
    const byS = {};
    svcNames.forEach(s => {
      const all = sl.filter(a => a.service === s);
      const sold = all.filter(a => a.done);
      const rev = sold.reduce((x, a) => x + (a.priceEGP || a.price || 0), 0);
      const cost = sold.reduce((x, a) => x + (a.costEGP || a.costPrice || 0), 0);
      const pft = rev - cost - ((sConf[s] || {}).adsCost || 0);
      const st = stockStatsByProduct[s] || { total: 0, avail: 0 };
      byS[s] = { sold: sold.length, avl: all.length - sold.length, rev, cost, pft, rem: st.avail, stT: st.total };
    });
    const v = Object.values(byS);
    return {
      byS,
      tR: v.reduce((a, b) => a + b.rev, 0),
      tP: v.reduce((a, b) => a + b.pft, 0),
      tS: v.reduce((a, b) => a + b.sold, 0),
      tA: v.reduce((a, b) => a + b.avl, 0),
    };
  }, [svcNames, sConf, stockStatsByProduct]);

  const myStats = useMemo(() => calcStats(dashboardSales), [dashboardSales, calcStats]);
  const allStats = myStats;

  const monthExpsTotal = useMemo(() => {
    const mr = getMonthRange(new Date());
    return expenses.filter(e => e.date >= mr.s && e.date <= mr.e).reduce((s, e) => s + (e.amount || 0), 0);
  }, [expenses]);
  const totalExpsAll = useMemo(() => expenses.reduce((s, e) => s + (e.amount || 0), 0), [expenses]);
  const netProfit = allStats.tP - totalExpsAll;

  const mrr = useMemo(() => {
    const act = dashboardSales.filter(a => a.done && daysLeft(a.renewDate) > 0);
    const mo = act.reduce((s, a) => s + ((a.priceEGP || a.price || 0) / (a.period || 1)), 0);
    const ch = dashboardSales.filter(a => a.done && daysLeft(a.renewDate) < 0).length;
    const cr = dashboardDone.length > 0 ? Math.round(ch / dashboardDone.length * 100) : 0;
    return { cur: Math.round(mo), cr, arr: Math.round(mo * 12), ac: act.length };
  }, [dashboardSales, dashboardDone]);

  const moCmp = useMemo(() => {
    const n = new Date();
    const mr = getMonthRange(n);
    const prev = new Date(n.getFullYear(), n.getMonth() - 1, 1);
    const pmr = getMonthRange(prev);
    const curS = dashboardDone.filter(a => a.soldDate >= mr.s && a.soldDate <= mr.e);
    const prevS = dashboardDone.filter(a => a.soldDate >= pmr.s && a.soldDate <= pmr.e);
    const curR = curS.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
    const prevR = prevS.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
    const growth = prevR > 0 ? Math.round((curR - prevR) / prevR * 100) : 0;
    return { curC: curS.length, prevC: prevS.length, curR, prevR, growth };
  }, [dashboardDone]);

  const forecast = useMemo(() => {
    const act = dashboardSales.filter(a => a.done && daysLeft(a.renewDate) > 0);
    const moRev = act.reduce((s, a) => s + ((a.priceEGP || a.price || 0) / (a.period || 1)), 0);
    return [1, 2, 3].map(m => {
      const d = new Date(); d.setMonth(d.getMonth() + m);
      const rn = act.filter(a => daysLeft(a.renewDate) > 0 && daysLeft(a.renewDate) <= m * 30);
      return { month: MONTHS_SHORT[d.getMonth()], rev: Math.round(moRev), renewals: rn.length };
    });
  }, [dashboardSales]);

  // Adobe monthly schedule
  const adobeSchedule = useMemo(() => {
    const schedule = [];
    sales.filter(a => a.done && a.service === "Adobe" && a.period > 0).forEach(a => {
      const soldDate = a.soldDate || a.createdDate;
      const renewed = a.adobeRenewed || {};
      for (let m = 1; m <= a.period; m++) {
        const renewDate = addMonths(soldDate, m);
        const days = daysLeft(renewDate);
        const monthKey = String(m);
        const isRenewed = !!renewed[monthKey];
        let status = "Pending";
        if (isRenewed) status = "Renewed";
        else if (days < 0) status = "Overdue";
        schedule.push({
          saleId: a.id, alertId: a.id + "-m" + m,
          customer: a.customer, customerPhone: a.customerPhone, customerEmail: a.customerEmail,
          monthIndex: m, totalMonths: a.period,
          renewDate, daysUntil: days, status,
          price: a.price, currency: a.currency || "EGP", soldDate,
          needsReminder: !isRenewed && days <= 2 && days >= 0,
          isOverdue: !isRenewed && days < 0,
        });
      }
    });
    return schedule.sort((a, b) => a.daysUntil - b.daysUntil);
  }, [sales]);

  const adobePendingReminders = useMemo(() => adobeSchedule.filter(a => a.needsReminder), [adobeSchedule]);
  const adobeOverdue = useMemo(() => adobeSchedule.filter(a => a.isOverdue), [adobeSchedule]);
  const adobeUpcoming = useMemo(() => adobeSchedule.filter(a => a.status === "Pending"), [adobeSchedule]);

  const adobeFilteredList = useMemo(() => {
    let list = adobeSchedule;
    if (adobeSearch) {
      const s = adobeSearch.toLowerCase();
      list = list.filter(a =>
        (a.customer || "").toLowerCase().includes(s)
        || (a.customerPhone || "").includes(s)
        || (a.customerEmail || "").toLowerCase().includes(s)
      );
    }
    if (adobeFilter === "overdue") list = list.filter(a => a.isOverdue);
    else if (adobeFilter === "due") list = list.filter(a => a.needsReminder);
    else if (adobeFilter === "upcoming") list = list.filter(a => a.status === "Pending" && !a.needsReminder && !a.isOverdue);
    else if (adobeFilter === "renewed") list = list.filter(a => a.status === "Renewed");
    // Sort
    if (adobeSort === "days") list = [...list].sort((x, y) => x.daysUntil - y.daysUntil);
    else if (adobeSort === "name") list = [...list].sort((x, y) => (x.customer || "").localeCompare(y.customer || ""));
    else if (adobeSort === "renewDate") list = [...list].sort((x, y) => (x.renewDate || "").localeCompare(y.renewDate || ""));
    return list;
  }, [adobeSchedule, adobeSearch, adobeFilter, adobeSort]);

  const markAdobeMonthRenewed = (saleId, monthIndex) => {
    setSales(p => p.map(s => {
      if (s.id !== saleId) return s;
      const renewed = { ...(s.adobeRenewed || {}), [String(monthIndex)]: true };
      addLog("🎨 Adobe month " + monthIndex + " renewed: " + s.customer);
      return { ...s, adobeRenewed: renewed };
    }));
  };
  const unmarkAdobeMonthRenewed = (saleId, monthIndex) => {
    setSales(p => p.map(s => {
      if (s.id !== saleId) return s;
      const renewed = { ...(s.adobeRenewed || {}) };
      delete renewed[String(monthIndex)];
      return { ...s, adobeRenewed: renewed };
    }));
  };

  // Alerts / notifications
  const alerts = useMemo(() => {
    const t0 = todayStr();
    const tmr = dateToStr(new Date(Date.now() + 864e5));
    const baseSales = isAdmin ? sales : scopedSales;
    const rn = baseSales.filter(a => a.done && a.renewDate && (a.renewDate === t0 || a.renewDate === tmr));
    const ex = baseSales.filter(a => a.done && a.renewDate && daysLeft(a.renewDate) < 0);
    const pp = baseSales.filter(a => {
      const pi = a.checklist ? a.checklist.find(c => c.label.toLowerCase().includes("payment")) : null;
      return pi && !pi.checked;
    });
    const fu = baseSales.filter(a => a.followUp);
    const pendingProofs = baseSales.filter(a => a.proofStatus === "pending" || a.proofStatus === "claimed");
    const os = svcNames.filter(s => {
      const st = stockStatsByProduct[s] || { avail: 0, total: 0 };
      return st.total > 0 && st.avail === 0;
    });
    const allN = [];
    ex.forEach(a => allN.push({ id: "e" + a.id, t: "danger", m: "🚨 " + a.customer + " EXPIRED" }));
    rn.forEach(a => allN.push({ id: "r" + a.id, t: "warn", m: "⏰ " + a.customer + " renews " + (a.renewDate === t0 ? "TODAY" : "TOMORROW") }));
    if (isAdmin) {
      adobePendingReminders.forEach(a => allN.push({ id: "ad" + a.alertId, t: "warn", m: "🎨 Adobe: " + a.customer + " month " + a.monthIndex + "/" + a.totalMonths }));
      adobeOverdue.forEach(a => allN.push({ id: "ov" + a.alertId, t: "danger", m: "🎨 OVERDUE: " + a.customer + " month " + a.monthIndex }));
      os.forEach(s => allN.push({ id: "o" + s, t: "danger", m: "📦 " + s + " out of stock!" }));
    }
    pendingProofs.forEach(a => allN.push({ id: "pp" + a.id, t: "warn", m: "📎 Proof pending: " + a.customer }));
    pp.forEach(a => allN.push({ id: "upc" + a.id, t: "warn", m: "💳 Payment not confirmed: " + a.customer + " (" + a.price + " " + (a.currency || "EGP") + ")" }));
    fu.forEach(a => allN.push({ id: "f" + a.id, t: "warn", m: "📞 " + a.customer }));
    return { rn, ex, pp, fu, os, pendingProofs, allN };
  }, [sales, scopedSales, svcNames, stockStatsByProduct, adobePendingReminders, adobeOverdue, isAdmin]);

  const unseenN = useMemo(() => alerts.allN.filter(n => !seenN.includes(n.id)), [alerts.allN, seenN]);

  // Time series for charts
  const calcTime = useCallback((sl) => {
    const n = new Date();
    const t0 = todayStr();
    const wR = getWeekRange(n);
    const mR = getMonthRange(n);
    const inR = (d, s, e) => d >= s && d <= e;
    const calc = (arr) => ({
      count: arr.length,
      rev: arr.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0),
      profit: arr.reduce((s, x) => s + ((x.priceEGP || x.price || 0) - (x.costEGP || x.costPrice || 0)), 0),
    });
    // QTD: start of current quarter
    const quarterStart = new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1);
    const qs = dateToStr(quarterStart);
    const wtdD = getDateRange(wR.s, t0).map(day => {
      const a = sl.filter(x => x.soldDate === day);
      const d = new Date(day);
      return { label: DAYS_SHORT[d.getDay()], count: a.length, rev: a.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) };
    });
    const mtdD = getDateRange(mR.s, t0).map(day => {
      const a = sl.filter(x => x.soldDate === day);
      const d = new Date(day);
      return { label: "" + d.getDate(), count: a.length, rev: a.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) };
    });
    const ytdM = [];
    for (let m = 0; m <= n.getMonth(); m++) {
      const ms = n.getFullYear() + "-" + String(m + 1).padStart(2, "0") + "-01";
      const me = dateToStr(new Date(n.getFullYear(), m + 1, 0));
      const f = sl.filter(a => a.soldDate && inR(a.soldDate, ms, me));
      ytdM.push({ label: MONTHS_SHORT[m], count: f.length, rev: f.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) });
    }
    return {
      daily: calc(sl.filter(a => a.soldDate === t0)),
      weekly: calc(sl.filter(a => a.soldDate && inR(a.soldDate, wR.s, wR.e))),
      monthly: calc(sl.filter(a => a.soldDate && inR(a.soldDate, mR.s, mR.e))),
      quarterly: calc(sl.filter(a => a.soldDate && a.soldDate >= qs && a.soldDate <= t0)),
      yearly: calc(sl.filter(a => a.soldDate && a.soldDate.startsWith("" + n.getFullYear()))),
      wtdD, mtdD, ytdM,
    };
  }, []);
  const myTime = useMemo(() => calcTime(dashboardDone), [dashboardDone, calcTime]);

  // Customer health
  const custHealth = useCallback((name) => {
    const cs = scopedSales.filter(a => a.customer && a.customer.toLowerCase() === name.toLowerCase());
    if (!cs.length) return { s: 50, c: "#94a3b8", l: "New" };
    let sc = 50;
    const d = cs.filter(a => a.done);
    if (d.length > 0) sc += 15;
    if (d.length > 2) sc += 10;
    if (cs.some(a => a.followUp)) sc -= 20;
    if (cs.some(a => a.done && daysLeft(a.renewDate) < 0)) sc -= 25;
    sc = Math.max(0, Math.min(100, sc));
    return {
      s: sc,
      c: sc >= 70 ? "#16a34a" : sc >= 40 ? "#f59e0b" : "#dc2626",
      l: sc >= 70 ? "Healthy" : sc >= 40 ? "At Risk" : "Critical",
    };
  }, [scopedSales]);

  const custList = useMemo(() => {
    const seeAll = isAdmin || (memberActions && memberActions.customersViewAll);
    const visibleCustNames = seeAll ? null : new Set(scopedSales.map(a => (a.customer || "").toLowerCase()));
    const source = seeAll ? customers : customers.filter(c => visibleCustNames.has(c.name.toLowerCase()));
    return source.map(c => {
      const cs = sales.filter(a => a.customer && a.customer.toLowerCase() === c.name.toLowerCase());
      const d = cs.filter(a => a.done);
      const tv = d.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
      return {
        ...c,
        tS: d.length,
        tV: tv,
        aS: cs.filter(a => a.done && daysLeft(a.renewDate) > 0).length,
        all: cs,
        h: custHealth(c.name),
      };
    }).sort((a, b) => b.tV - a.tV);
  }, [customers, scopedSales, sales, custHealth, isAdmin, memberActions]);

  const bundleStats = useMemo(() => {
    return bundles.map(b => {
      const bSales = sales.filter(a => a.service === b.name + " (Bundle)");
      const done = bSales.filter(a => a.done);
      const rev = done.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
      return { ...b, sold: done.length, rev, pending: bSales.length - done.length };
    });
  }, [bundles, sales]);

  const avgRating = useMemo(() => {
    const vals = Object.values(feedback);
    if (!vals.length) return 0;
    return Math.round(vals.reduce((s, f) => s + f.rating, 0) / vals.length * 10) / 10;
  }, [feedback]);

  // Filtered sales for Sales tab
  const filteredSales = useMemo(() => {
    let sl = scopedSales;
    // Time period filter (applies first)
    if (salesPeriod !== "custom" && salesPeriod !== "all") {
      const now = new Date();
      const t0 = todayStr();
      if (salesPeriod === "today") {
        sl = sl.filter(a => a.soldDate === t0);
      } else if (salesPeriod === "week") {
        const wR = getWeekRange(now);
        sl = sl.filter(a => a.soldDate && a.soldDate >= wR.s && a.soldDate <= wR.e);
      } else if (salesPeriod === "month") {
        const mR = getMonthRange(now);
        sl = sl.filter(a => a.soldDate && a.soldDate >= mR.s && a.soldDate <= mR.e);
      } else if (salesPeriod === "year") {
        const y = now.getFullYear();
        sl = sl.filter(a => a.soldDate && a.soldDate.startsWith(String(y)));
      }
    }
    if (search) {
      const s = search.toLowerCase();
      sl = sl.filter(a =>
        (a.customer || "").toLowerCase().includes(s)
        || (a.customerPhone || "").includes(s)
        || (a.customerEmail || "").toLowerCase().includes(s)
        || (a.service || "").toLowerCase().includes(s)
        || (a.notes || "").toLowerCase().includes(s)
      );
    }
    if (salesFilterProd !== "all") sl = sl.filter(a => a.service === salesFilterProd);
    if (salesFilterPhone) {
      const p = salesFilterPhone.replace(/[^0-9]/g, "");
      if (p) sl = sl.filter(a => (a.customerPhone || "").replace(/[^0-9]/g, "").includes(p));
    }
    if (dFrom) sl = sl.filter(a => a.soldDate >= dFrom);
    if (dTo) sl = sl.filter(a => a.soldDate <= dTo);
    if (salesFilter === "pending") sl = sl.filter(a => !a.done);
    if (salesFilter === "done") sl = sl.filter(a => a.done);
    if (salesFilter === "followup") sl = sl.filter(a => a.followUp);
    if (salesFilter === "cancelled") sl = sl.filter(a => a.proofStatus === "rejected");
    if (salesFilter === "approved") sl = sl.filter(a => a.done && a.proofStatus === "approved");
    return sl;
  }, [scopedSales, search, dFrom, dTo, salesFilter, salesFilterProd, salesFilterPhone, salesPeriod]);

  // Filtered stock
  const stockFiltered = useMemo(() => {
    let r = stockRows;
    if (stockFilterProd !== "all") r = r.filter(x => x.product === stockFilterProd);
    if (stockView === "available") r = r.filter(x => !x.sold);
    if (stockView === "sold") r = r.filter(x => x.sold);
    if (stockSearch) {
      const s = stockSearch.toLowerCase();
      r = r.filter(x =>
        (x.email || "").toLowerCase().includes(s)
        || (x.product || "").toLowerCase().includes(s)
        || (x.note || "").toLowerCase().includes(s)
      );
    }
    return r;
  }, [stockRows, stockView, stockFilterProd, stockSearch]);

  const stockTotalAvail = stockRows.filter(r => !r.sold).length;
  const stockTotalSold = stockRows.filter(r => r.sold).length;

  // Filtered tasks
  const visibleTasks = useMemo(() => {
    if (isAdmin) return tasks;
    if (memberActions && memberActions.tasksViewAll) return tasks;
    return tasks.filter(tk => tk.assignedTo === memberId);
  }, [tasks, isAdmin, memberId, memberActions]);

  const tasksByStatus = useMemo(() => {
    const g = { todo: [], inprogress: [], done: [] };
    visibleTasks.forEach(tk => {
      const s = tk.status || "todo";
      if (g[s]) g[s].push(tk);
    });
    return g;
  }, [visibleTasks]);

  const overdueTasks = useMemo(() => {
    return visibleTasks.filter(tk =>
      (tk.status || "todo") !== "done" && tk.deadline && tk.deadline < todayStr()
    );
  }, [visibleTasks]);

  // Commission report
  const commissionPeriodRange = useMemo(() => {
    const n = new Date();
    if (commissionPeriod === "thisMonth") return getMonthRange(n);
    if (commissionPeriod === "lastMonth") {
      const prev = new Date(n.getFullYear(), n.getMonth() - 1, 1);
      return getMonthRange(prev);
    }
    if (commissionPeriod === "thisYear") return { s: n.getFullYear() + "-01-01", e: n.getFullYear() + "-12-31" };
    if (commissionPeriod === "allTime") return { s: "2000-01-01", e: "2099-12-31" };
    return getMonthRange(n);
  }, [commissionPeriod]);

  const commissionReport = useMemo(() => {
    const { s, e } = commissionPeriodRange;
    const inRange = (d) => d >= s && d <= e;
    // Members only see their own row
    const viewTeam = (isAdmin || (memberActions && memberActions.viewCommissionAll)) ? team : team.filter(m => m.id === memberId);
    return viewTeam.map(m => {
      const memberSales = sales.filter(a => a.done && a.assignedTo === m.id && inRange(a.soldDate));
      const revenue = memberSales.reduce((sum, a) => sum + (a.priceEGP || a.price || 0), 0);
      const cost = memberSales.reduce((sum, a) => sum + (a.costEGP || a.costPrice || 0), 0);
      const profit = revenue - cost;
      const rate = m.commissionRate || 0;
      const base = m.commissionBase || "revenue";
      let commission = 0;
      if (base === "revenue") commission = Math.round(revenue * rate / 100);
      else if (base === "profit") commission = Math.round(profit * rate / 100);
      else if (base === "fixed") commission = memberSales.length * rate;
      return { ...m, salesCount: memberSales.length, revenue, profit, commission, sales: memberSales };
    });
  }, [team, sales, commissionPeriodRange, isAdmin, memberId]);

  const totalCommissions = useMemo(
    () => commissionReport.reduce((s, m) => s + m.commission, 0),
    [commissionReport]
  );

  // Visible sidebar tabs based on role
  const allTabs = [
    { id: "dashboard",    label: "Dashboard",  icon: "📊", memberKey: "dashboard" },
    { id: "mrr",          label: "MRR",        icon: "💹", memberKey: null },
    { id: "services",     label: "Services",   icon: "⚙️", memberKey: null },
    { id: "sales_entry",  label: "Sales",      icon: "🔑", memberKey: "sales" },
    { id: "bundles",      label: "Bundles",    icon: "📦", memberKey: null },
    { id: "customers",    label: "Customers",  icon: "👤", memberKey: "customers" },
    { id: "adobe",        label: "Adobe",      icon: "🎨", memberKey: "adobe" },
    { id: "tasks",        label: "Tasks",      icon: "✅", memberKey: "tasks" },
    { id: "team",         label: "Team",       icon: "👥", memberKey: null },
    { id: "commission",   label: "Commission", icon: "💰", memberKey: "commission" },
    { id: "expenses",     label: "Expenses",   icon: "🧾", memberKey: null },
    { id: "stock",        label: "Stock",      icon: "📦", memberKey: "stock" },
    { id: "reports",      label: "Reports",    icon: "📈", memberKey: null },
    { id: "logs",         label: "Activity",   icon: "📜", memberKey: null },
    { id: "guide",        label: "Guide",      icon: "📋", memberKey: "guide" },
  ];
  const visTabs = isAdmin
    ? allTabs
    : allTabs.filter(tb => tb.memberKey && memberPerms && memberPerms[tb.memberKey]);

  // Get current tab info for mobile top bar
  const currentTab = visTabs.find(tb => tb.id === tab) || visTabs[0] || { label: "—", icon: "" };

  // Mobile bottom nav: show 4 most-used tabs + "More"
  const pickMobileNavTabs = () => {
    if (isAdmin) {
      const preferred = ["dashboard", "sales_entry", "tasks", "customers"];
      return preferred.map(id => visTabs.find(v => v.id === id)).filter(Boolean);
    } else {
      // Members: show whatever's in their first 4 allowed tabs
      return visTabs.slice(0, 4);
    }
  };
  const mobileNavTabs = pickMobileNavTabs();

  const syncColor = syncStatus === "saved" ? t.success : syncStatus === "saving" ? t.warning : t.danger;
  const syncLabel = syncStatus === "saved" ? "☁️ Synced" : syncStatus === "saving" ? "Saving..." : "⚠️ Will retry";

  // ═══ Warn user if they try to close tab while saves are pending ═══
  useEffect(() => {
    const handler = (e) => {
      if (syncStatus === "saving" || syncStatus === "error" || pendingData) {
        e.preventDefault();
        e.returnValue = "You have unsaved changes. They're saved on this device but not to the cloud. Are you sure?";
        return e.returnValue;
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [syncStatus]);

  // Force-save on demand (manual retry)
  const forceSyncNow = useCallback(async () => {
    if (!workspaceOwnerId || saveInFlight) return;
    const dataToSave = {
      services, sales, sConf, stockRows, guides, checklist, customers, logs,
      dark, comments, expenses, tasks, bundles, feedback, waTemplates, team,
    };
    setSyncStatus("saving");
    saveInFlight = true;
    try {
      const r = await sb.saveData(workspaceOwnerId, dataToSave, ADMIN_EMAIL);
      setSyncStatus(r.ok ? "saved" : "error");
    } catch {
      setSyncStatus("error");
    } finally {
      saveInFlight = false;
    }
  }, [workspaceOwnerId, services, sales, sConf, stockRows, guides, checklist, customers, logs, dark, comments, expenses, tasks, bundles, feedback, waTemplates, team]);

  // ═══════════════════════════════════════════════════════════════════
  // 🟢 APP SHELL — Navigation + Content
  // ═══════════════════════════════════════════════════════════════════

  // Auth-based screens (rendered after all hooks are called)
  if (authStatus === "loading") return renderLoading();
  if (authStatus === "login") return renderLogin();

  return (
    <div style={{
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      height: "100vh",
      fontFamily: "'Inter',system-ui,sans-serif",
      background: t.bg,
      color: t.text,
      overflow: "hidden",
    }}>
      {/* ─────────────── DESKTOP SIDEBAR ─────────────── */}
      {!isMobile && (
        <div style={{
          width: sideOpen ? 220 : 56,
          background: "#1a2e44",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          transition: "width 0.2s",
          flexShrink: 0,
          overflow: "hidden",
        }}>
          {/* Logo + collapse toggle */}
          <div
            style={{
              padding: sideOpen ? "14px 14px 8px" : "14px 10px 8px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
            onClick={() => setSideOpen(!sideOpen)}
          >
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: "#2a9d8f",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 800, fontSize: 12, color: "#fff", flexShrink: 0,
            }}>PS</div>
            {sideOpen && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>ProSkill</div>
                <div style={{ fontSize: 8, color: "#2a9d8f", fontWeight: 600, letterSpacing: 1.5 }}>DIGITAL AGENCY</div>
              </div>
            )}
          </div>

          {/* Sync status */}
          {sideOpen && (
            <div
              onClick={syncStatus === "error" ? forceSyncNow : undefined}
              title={syncStatus === "error" ? "Click to retry save now" : ""}
              style={{
                padding: "8px 14px", display: "flex", alignItems: "center", gap: 6,
                cursor: syncStatus === "error" ? "pointer" : "default",
              }}
            >
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: syncColor,
              }} />
              <span style={{ fontSize: 10, color: syncColor, fontWeight: 600 }}>{syncLabel}</span>
              {syncStatus === "error" && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: "auto" }}>Tap to retry</span>}
            </div>
          )}

          {/* Role badge */}
          {sideOpen && (
            <div style={{
              margin: "0 14px 6px",
              padding: "6px 10px",
              background: isAdmin ? "rgba(42,157,143,0.15)" : "rgba(245,158,11,0.15)",
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 700,
              color: isAdmin ? "#2a9d8f" : "#fbbf24",
              textAlign: "center",
              letterSpacing: 1,
            }}>{isAdmin ? "👑 ADMIN" : "👤 MEMBER"}</div>
          )}

          {/* Tab list */}
          <div style={{ flex: 1, padding: "4px 0", overflowY: "auto" }}>
            {visTabs.map(tb => {
              const active = tab === tb.id;
              return (
                <div
                  key={tb.id}
                  onClick={() => setTab(tb.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: sideOpen ? "10px 14px" : "10px 18px",
                    cursor: "pointer",
                    background: active ? "rgba(42,157,143,0.18)" : "transparent",
                    borderLeft: active ? "3px solid #2a9d8f" : "3px solid transparent",
                    color: active ? "#fff" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: active ? 700 : 500,
                    minHeight: 40,
                  }}
                >
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{tb.icon}</span>
                  {sideOpen && <span>{tb.label}</span>}
                  {sideOpen && tb.id === "tasks" && overdueTasks.length > 0 && (
                    <span style={{
                      marginLeft: "auto", background: "#ef4444", color: "#fff",
                      borderRadius: 8, padding: "1px 6px", fontSize: 9, fontWeight: 700,
                    }}>{overdueTasks.length}</span>
                  )}
                </div>
              );
            })}

            {/* Follow-up shortcut (admin only) */}
            {isAdmin && sideOpen && (
              <div
                onClick={() => setShowFU(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 14px", cursor: "pointer",
                  color: "#f59e0b", fontSize: 12, fontWeight: 600,
                  borderTop: "1px solid rgba(255,255,255,0.05)",
                  marginTop: 4, minHeight: 40,
                }}
              >
                <span style={{ fontSize: 16 }}>📞</span>
                <span>Follow Up</span>
                {alerts.fu.length > 0 && (
                  <span style={{
                    marginLeft: "auto", background: "#f59e0b", color: "#fff",
                    borderRadius: 8, padding: "1px 6px", fontSize: 9, fontWeight: 700,
                  }}>{alerts.fu.length}</span>
                )}
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div style={{ padding: sideOpen ? "10px 14px" : "10px 6px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
            {sideOpen && (
              <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 8, wordBreak: "break-all" }}>
                {cU ? cU.name : ""}
              </div>
            )}
            <div style={{
              display: "flex",
              gap: sideOpen ? 8 : 4,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: sideOpen ? "flex-start" : "center",
            }}>
              <span
                onClick={() => setShowNotif(true)}
                title="Notifications"
                style={{ cursor: "pointer", fontSize: 15, position: "relative", minHeight: 28, display: "inline-flex", alignItems: "center" }}
              >
                🔔
                {unseenN.length > 0 && (
                  <span style={{
                    position: "absolute", top: -3, right: -6,
                    background: "#ef4444", color: "#fff",
                    borderRadius: 6, padding: "0 4px", fontSize: 8, fontWeight: 700,
                  }}>{unseenN.length}</span>
                )}
              </span>
              <span onClick={() => setDark(!dark)} title={dark ? "Light" : "Dark"} style={{ cursor: "pointer", fontSize: 14, minHeight: 28, display: "inline-flex", alignItems: "center" }}>
                {dark ? "☀️" : "🌙"}
              </span>
              {isAdmin && (
                <span onClick={() => setShowBackup(true)} title="Backup" style={{ cursor: "pointer", fontSize: 14, minHeight: 28, display: "inline-flex", alignItems: "center" }}>💾</span>
              )}
              {isAdmin && (
                <span onClick={() => setShowTemplates({ sale: null })} title="WA Templates" style={{ cursor: "pointer", fontSize: 14, minHeight: 28, display: "inline-flex", alignItems: "center" }}>💬</span>
              )}
              {sideOpen && (
                <span onClick={handleSignOut} style={{ fontSize: 10, color: "#94a3b8", cursor: "pointer", marginLeft: "auto" }}>Logout</span>
              )}
              {isAdmin && undoStack.length > 0 && sideOpen && (
                <span
                  onClick={() => {
                    const last = undoStack[undoStack.length - 1];
                    setSales(p => [last, ...p]);
                    setUndoStack(p => p.slice(0, -1));
                  }}
                  style={{ fontSize: 10, color: "#f59e0b", cursor: "pointer" }}
                >↩ Undo</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─────────────── MOBILE TOP BAR ─────────────── */}
      {isMobile && (
        <div style={{
          background: "#1a2e44",
          padding: "14px 16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        }}>
          {/* Left: logo + tab name */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 8, background: "#2a9d8f",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 800, fontSize: 13, color: "#fff", flexShrink: 0,
            }}>PS</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#fff", fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 16 }}>{currentTab.icon}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentTab.label}</span>
              </div>
              <div
                onClick={syncStatus === "error" ? forceSyncNow : undefined}
                style={{
                  color: syncColor, fontSize: 10, display: "flex", alignItems: "center", gap: 4,
                  cursor: syncStatus === "error" ? "pointer" : "default",
                  textDecoration: syncStatus === "error" ? "underline" : "none",
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: syncColor }} />
                {syncLabel} {syncStatus === "error" ? "· TAP" : ""}
              </div>
            </div>
          </div>

          {/* Right: actions */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexShrink: 0 }}>
            <span
              onClick={() => setShowNotif(true)}
              style={{ cursor: "pointer", fontSize: 22, color: "#fff", position: "relative", padding: 4 }}
            >
              🔔
              {unseenN.length > 0 && (
                <span style={{
                  position: "absolute", top: -2, right: -4,
                  background: "#ef4444", color: "#fff",
                  borderRadius: 8, padding: "1px 5px", fontSize: 9, fontWeight: 700,
                  minWidth: 14, textAlign: "center",
                }}>{unseenN.length}</span>
              )}
            </span>
            {isAdmin && (
              <span
                onClick={() => setShowFU(true)}
                style={{ cursor: "pointer", fontSize: 22, color: "#fff", position: "relative", padding: 4 }}
              >
                📞
                {alerts.fu.length > 0 && (
                  <span style={{
                    position: "absolute", top: -2, right: -4,
                    background: "#f59e0b", color: "#fff",
                    borderRadius: 8, padding: "1px 5px", fontSize: 9, fontWeight: 700,
                    minWidth: 14, textAlign: "center",
                  }}>{alerts.fu.length}</span>
                )}
              </span>
            )}
            <span onClick={() => setDark(!dark)} style={{ cursor: "pointer", fontSize: 20, color: "#fff", padding: 4 }}>
              {dark ? "☀️" : "🌙"}
            </span>
          </div>
        </div>
      )}

      {/* ─────────────── MAIN CONTENT AREA ─────────────── */}
      <div style={{
        flex: 1,
        overflow: "auto",
        padding: isMobile ? "16px 14px" : "20px 24px",
        paddingBottom: isMobile ? 88 : 20, // leave room for mobile bottom nav
        WebkitOverflowScrolling: "touch",
      }}>
        {/* ═══════════════════════════════════════════════════════════════
             🪟 MODALS (shared across tabs)
             ═══════════════════════════════════════════════════════════════ */}

        {/* ─── NOTIFICATIONS PANEL ─── */}
        {showNotif && (
          <div
            onClick={() => setShowNotif(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", justifyContent: "flex-end",
              zIndex: 999,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: isMobile ? "100%" : 360,
                maxWidth: "100%",
                background: t.cardBg,
                height: "100%",
                overflow: "auto",
                padding: isMobile ? 20 : 18,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                {isMobile && (
                  <button onClick={() => setShowNotif(false)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>🔔 Notifications</h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {alerts.allN.length > 0 && (
                    <button onClick={() => setSeenN(alerts.allN.map(n => n.id))} style={{ ...t.btnGhost, padding: "6px 12px", fontSize: t.fs.sm }}>Read all</button>
                  )}
                  {!isMobile && (
                    <span onClick={() => setShowNotif(false)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                  )}
                </div>
              </div>
              {alerts.allN.length === 0 && (
                <div style={{ textAlign: "center", padding: "40px 20px", color: t.textMuted }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
                  <p style={{ margin: 0, fontSize: t.fs.base }}>All clear — nothing urgent!</p>
                </div>
              )}
              {alerts.allN.map(n => (
                <div key={n.id} style={{
                  padding: "12px 14px",
                  marginBottom: 8,
                  background: seenN.includes(n.id) ? (t.dark ? "#0f172a" : "#f5f7f9") : (n.t === "danger" ? (t.dark ? "#450a0a" : "#fef2f2") : (t.dark ? "#422006" : "#fffbeb")),
                  borderLeft: "3px solid " + (n.t === "danger" ? t.danger : t.warning),
                  borderRadius: 8,
                  opacity: seenN.includes(n.id) ? 0.6 : 1,
                }}>
                  <p style={{ margin: 0, fontSize: t.fs.base, color: n.t === "danger" ? t.danger : "#b45309", fontWeight: 500 }}>{n.m}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── FOLLOW-UP LIST (admin only) ─── */}
        {showFU && (
          <div
            onClick={() => setShowFU(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 999, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 560,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "85vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                borderRadius: isMobile ? 0 : 14,
                padding: isMobile ? 20 : 22,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                {isMobile && (
                  <button onClick={() => setShowFU(false)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>📞 Follow Up ({alerts.fu.length})</h3>
                {!isMobile && (
                  <span onClick={() => setShowFU(false)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                )}
              </div>
              {alerts.fu.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 20px", color: t.textMuted }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>🎉</div>
                  <p style={{ margin: 0, fontSize: t.fs.base }}>Nobody needs a follow-up right now!</p>
                </div>
              ) : alerts.fu.map(a => (
                <div key={a.id} style={{ ...t.cardCompact, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: t.fs.md, fontWeight: 700, marginBottom: 4 }}>{a.customer}</div>
                      <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                        {svcIcon(a.service)} {a.service} · {a.price} {a.currency || "EGP"}
                      </div>
                      {a.customerPhone && <div style={{ fontSize: t.fs.sm, color: t.primary, marginTop: 2 }}>📞 {a.customerPhone}</div>}
                      {a.notes && <p style={{ margin: "4px 0 0", fontSize: t.fs.sm, color: t.warning, fontStyle: "italic" }}>📝 {a.notes}</p>}
                    </div>
                    {a.customerPhone && (
                      <a
                        href={waLink(a.customerPhone, "Hi " + a.customer + ", just checking in about your " + a.service + " subscription.")}
                        target="_blank"
                        rel="noreferrer"
                        style={t.btnWA}
                      >📱 WA</a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── SALE DETAIL MODAL ─── */}
        {selSale && (
          <div
            onClick={() => setSelSale(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 998, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 460,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "90vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                borderRadius: isMobile ? 0 : 14,
                padding: isMobile ? 20 : 22,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                {isMobile && (
                  <button
                    onClick={() => setSelSale(null)}
                    style={{
                      ...t.btnGhost,
                      padding: "10px 14px",
                      fontSize: t.fs.base,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{svcIcon(selSale.service)} {selSale.service}</h3>
                {!isMobile && (
                  <span onClick={() => setSelSale(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                )}
              </div>

              {/* Summary */}
              <div style={{ background: t.cardBg2, borderRadius: 10, padding: 14, marginBottom: 14, fontSize: t.fs.base, lineHeight: 1.6 }}>
                <div><strong>Customer:</strong> {selSale.customer}</div>
                {selSale.customerPhone && <div><strong>Phone:</strong> {selSale.customerPhone}</div>}
                {selSale.customerEmail && <div><strong>Email:</strong> {selSale.customerEmail}</div>}
                <div>
                  <strong>Price:</strong> {selSale.price} {selSale.currency || "EGP"} &middot;
                  &nbsp;<strong>Profit:</strong> {(selSale.price || 0) - (selSale.costPrice || 0)} {selSale.currency || "EGP"}
                </div>
                <div>
                  <strong>Period:</strong> {PERIOD_LABEL(selSale.period)} &middot;
                  &nbsp;<strong>Renew:</strong>{" "}
                  {selSale.period === 0 ? "N/A"
                    : selSale.period === -1 ? "Lifetime ∞"
                    : selSale.renewDate + " (" + daysLeft(selSale.renewDate) + "d)"}
                </div>
                {selSale.assignedTo && (() => {
                  const m = team.find(x => x.id === selSale.assignedTo);
                  if (!m) return <div style={{ color: t.warning }}>👤 Assigned: <em>deleted member</em></div>;
                  const rate = m.commissionRate || 0;
                  const base = m.commissionBase || "revenue";
                  const rev = selSale.priceEGP || selSale.price || 0;
                  const cost = selSale.costEGP || selSale.costPrice || 0;
                  const comm = base === "revenue" ? Math.round(rev * rate / 100) : base === "profit" ? Math.round((rev - cost) * rate / 100) : rate;
                  return (
                    <div style={{ color: t.primary, marginTop: 4 }}>
                      <strong>👤 Sold by:</strong> {m.name} · <strong>Commission:</strong> {comm} EGP ({rate}{base === "fixed" ? " EGP fixed" : "%"})
                    </div>
                  );
                })()}
                {selSale.linkedStockId && (() => {
                  const stock = stockRows.find(r => r.id === selSale.linkedStockId);
                  if (!stock) return null;
                  return (
                    <div style={{ marginTop: 10, padding: 10, background: t.dark ? "#334155" : "#e8f4f2", borderRadius: 8, borderLeft: "3px solid " + t.primary }}>
                      <div style={{ fontSize: t.fs.sm, color: t.primary, fontWeight: 700, marginBottom: 6 }}>🔗 LINKED ACCOUNT</div>
                      <div style={{ fontSize: t.fs.base, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        <strong>{stock.email}</strong>
                        <CopyBtn text={stock.email} label="email" theme={t} />
                        {stock.password && <CopyBtn text={stock.password} label="password" theme={t} />}
                        {(isAdmin || canEditSale(selSale)) && (
                          <button
                            onClick={() => { if (confirm("Unlink this account from sale?")) unlinkStockFromSale(selSale.id); }}
                            style={{ ...t.btnGhost, padding: "4px 10px", fontSize: t.fs.sm }}
                          >Unlink</button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <span style={t.badge(selSale.done)}>{selSale.done ? "✓ Done" : "...Pending"}</span>
                {feedback[selSale.id] && (
                  <span style={{ padding: "4px 10px", borderRadius: 20, fontSize: t.fs.sm, background: t.dark ? "#422006" : "#fffbeb", color: t.warning, fontWeight: 700 }}>
                    {"⭐".repeat(feedback[selSale.id].rating)}
                  </span>
                )}
                {(isAdmin || canEditSale(selSale)) && (
                  <button onClick={() => setProofModal({ saleId: selSale.id })} style={t.btnGhost}>📎 Proof</button>
                )}
                {(isAdmin || canEditSale(selSale)) && (
                  <button
                    onClick={() => {
                      toggleFollow(selSale.id);
                      setSelSale(p => ({ ...p, followUp: !p.followUp }));
                    }}
                    style={{
                      ...t.btnGhost,
                      background: selSale.followUp ? t.warning : "transparent",
                      color: selSale.followUp ? "#fff" : t.warning,
                      borderColor: t.warning,
                    }}
                  >📞 {selSale.followUp ? "Following Up" : "Mark Follow-Up"}</button>
                )}
                <button onClick={() => setShowTemplates({ sale: selSale })} style={t.btnGhost}>💬 Template</button>
                <button onClick={() => setShowRate(selSale)} style={t.btnGhost}>⭐ Rate</button>
                <button onClick={() => setInvSale(selSale)} style={t.btnGhost}>🧾 Invoice</button>
                {(isAdmin || canEditSale(selSale)) && (
                  <button onClick={() => { renewSale(selSale); setSelSale(null); }} style={t.btnPrimary}>🔄 Renew</button>
                )}
                {selSale.customerPhone && (
                  <a
                    href={waLink(selSale.customerPhone, "Hi " + selSale.customer)}
                    target="_blank"
                    rel="noreferrer"
                    style={t.btnWA}
                  >📱 WhatsApp</a>
                )}
              </div>

              {/* Checklist */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: t.fs.md, fontWeight: 700, marginBottom: 8 }}>✅ Checklist</div>
                {(selSale.checklist || []).map((c, i) => (
                  <label
                    key={i}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: isMobile ? "10px 8px" : "6px 4px",
                      fontSize: t.fs.base,
                      cursor: canEditSale(selSale) ? "pointer" : "default",
                      color: c.checked ? t.success : t.textMuted,
                      borderRadius: 6,
                      background: c.checked ? (t.dark ? "#052e16" : "#f0fdf4") : "transparent",
                      marginBottom: 4,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={c.checked}
                      disabled={!canEditSale(selSale)}
                      onChange={() => {
                        updateChecklist(selSale.id, i);
                        setSelSale(p => ({ ...p, checklist: p.checklist.map((x, j) => j === i ? { ...x, checked: !x.checked } : x) }));
                      }}
                      style={{ width: 18, height: 18, accentColor: t.primary, flexShrink: 0 }}
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>

              {/* Comments */}
              <div>
                <div style={{ fontSize: t.fs.md, fontWeight: 700, marginBottom: 8 }}>💬 Notes</div>
                <div style={{ maxHeight: 140, overflow: "auto", marginBottom: 10 }}>
                  {(comments[selSale.id] || []).map((c, i) => (
                    <div key={i} style={{ padding: "8px 10px", marginBottom: 6, background: t.cardBg2, borderRadius: 8, fontSize: t.fs.sm }}>
                      <strong style={{ color: t.primary }}>{c.user}</strong>: {c.text}
                    </div>
                  ))}
                  {(!comments[selSale.id] || comments[selSale.id].length === 0) && (
                    <p style={{ fontSize: t.fs.sm, color: t.textMuted, textAlign: "center", padding: 10, margin: 0 }}>No notes yet.</p>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={newCmt}
                    onChange={e => setNewCmt(e.target.value)}
                    placeholder="Add note..."
                    style={{ ...t.input, flex: 1 }}
                    onKeyDown={e => { if (e.key === "Enter") addComment(selSale.id); }}
                  />
                  <button onClick={() => addComment(selSale.id)} style={t.btnPrimary}>Send</button>
                </div>
              </div>

              {/* Bottom actions: edit, delete (admin) */}
              <div style={{ display: "flex", gap: 8, marginTop: 18, paddingTop: 14, borderTop: "1px solid " + t.border }}>
                {canEditSale(selSale) && (
                  <button onClick={() => { setEditSale({ ...selSale }); setSelSale(null); }} style={{ ...t.btnGhost, flex: 1 }}>✎ Edit</button>
                )}
                {isAdmin && (
                  <button onClick={() => { deleteSale(selSale.id); }} style={{ ...t.btnDanger, flex: 1 }}>🗑 Delete</button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─── EDIT SALE MODAL ─── */}
        {editSale && (
          <div
            onClick={() => setEditSale(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 998, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 440,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "90vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                borderRadius: isMobile ? 0 : 14,
                padding: isMobile ? 20 : 22,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                {isMobile && (
                  <button onClick={() => setEditSale(null)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>✎ Edit Sale</h3>
                {!isMobile && (
                  <span onClick={() => setEditSale(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                )}
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={t.label}>Service</label>
                <select value={editSale.service} onChange={e => setEditSale(p => ({ ...p, service: e.target.value }))} style={t.input}>
                  {svcNames.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={t.label}>Customer *</label>
                <input value={editSale.customer || ""} onChange={e => setEditSale(p => ({ ...p, customer: e.target.value }))} style={t.input} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={t.label}>Phone</label>
                  <input value={editSale.customerPhone || ""} onChange={e => setEditSale(p => ({ ...p, customerPhone: e.target.value }))} style={t.input} />
                </div>
                <div>
                  <label style={t.label}>Email</label>
                  <input type="email" value={editSale.customerEmail || ""} onChange={e => setEditSale(p => ({ ...p, customerEmail: e.target.value }))} style={t.input} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={t.label}>Price *</label>
                  <input type="number" value={editSale.price || 0} onChange={e => setEditSale(p => ({ ...p, price: +e.target.value }))} style={t.input} />
                </div>
                <div>
                  <label style={t.label}>Cost</label>
                  <input type="number" value={editSale.costPrice || 0} onChange={e => setEditSale(p => ({ ...p, costPrice: +e.target.value }))} style={t.input} />
                </div>
                <div>
                  <label style={t.label}>Currency</label>
                  <select value={editSale.currency || "EGP"} onChange={e => setEditSale(p => ({ ...p, currency: e.target.value }))} style={t.input}>
                    {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={t.label}>Period</label>
                  <select value={editSale.period} onChange={e => setEditSale(p => ({ ...p, period: +e.target.value }))} style={t.input}>
                    {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABEL(p)}</option>)}
                  </select>
                </div>
                <div>
                  <label style={t.label}>Sold Date</label>
                  <input type="date" value={editSale.soldDate || ""} onChange={e => setEditSale(p => ({ ...p, soldDate: e.target.value }))} style={t.input} />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={t.label}>Notes</label>
                <input value={editSale.notes || ""} onChange={e => setEditSale(p => ({ ...p, notes: e.target.value }))} style={t.input} />
              </div>
              {isAdmin && team.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <label style={t.label}>👤 Assigned To (Sold By)</label>
                  <select value={editSale.assignedTo || ""} onChange={e => setEditSale(p => ({ ...p, assignedTo: e.target.value ? +e.target.value : null }))} style={t.input}>
                    <option value="">— Unassigned —</option>
                    {team.map(m => <option key={m.id} value={m.id}>{m.name} ({m.commissionRate || 0}%)</option>)}
                  </select>
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                <button onClick={() => setEditSale(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                <button onClick={saveEditSale} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save</button>
              </div>
            </div>
          </div>
        )}

        {/* ─── PAYMENT PROOF MODAL ─── */}
        {proofModal && (() => {
          const sale = sales.find(s => s.id === proofModal.saleId);
          if (!sale) return null;
          return (
            <div
              onClick={() => setProofModal(null)}
              style={{
                position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 999, padding: isMobile ? 0 : 20,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  ...t.card,
                  width: isMobile ? "100%" : 520,
                  maxWidth: "100%",
                  maxHeight: isMobile ? "100vh" : "92vh",
                  height: isMobile ? "100vh" : "auto",
                  overflow: "auto",
                  borderRadius: isMobile ? 0 : 14,
                  padding: isMobile ? 20 : 22,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                  {isMobile && (
                    <button onClick={() => setProofModal(null)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                  )}
                  <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>📎 Payment Proof</h3>
                  {!isMobile && (
                    <span onClick={() => setProofModal(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                  )}
                </div>
                <div style={{ fontSize: t.fs.base, color: t.textMuted, marginBottom: 14 }}>
                  <strong>{sale.customer}</strong> · {sale.service} · {sale.price} {sale.currency || "EGP"}
                </div>

                {/* Status badge */}
                {(() => {
                  const st = sale.proofStatus || "none";
                  if (st === "none") return null;
                  const cfg = {
                    claimed: { color: t.warning, label: "⏳ CLAIMED — Awaiting Admin Review" },
                    approved: { color: t.success, label: "✅ APPROVED" },
                    rejected: { color: t.danger, label: "❌ REJECTED" },
                    pending: { color: t.warning, label: "⏳ PENDING" },
                  }[st] || { color: t.textMuted, label: st.toUpperCase() };
                  return (
                    <div style={{
                      background: cfg.color + "22",
                      color: cfg.color,
                      padding: "10px 14px", borderRadius: 10,
                      fontWeight: 700, fontSize: t.fs.sm,
                      marginBottom: 14, textAlign: "center",
                    }}>
                      {cfg.label}
                    </div>
                  );
                })()}

                {/* Show existing claim info (if any) */}
                {sale.paymentClaim && (
                  <div style={{ background: t.cardBg2, borderRadius: 10, padding: 12, marginBottom: 14, fontSize: t.fs.sm, lineHeight: 1.7 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6, color: t.primary }}>💰 Payment Claim</div>
                    <div><strong>Amount:</strong> {sale.paymentClaim.amount} {sale.currency || "EGP"}</div>
                    {sale.paymentClaim.note && <div><strong>Note:</strong> {sale.paymentClaim.note}</div>}
                    <div><strong>Claimed by:</strong> {sale.paymentClaim.claimedBy}</div>
                    <div><strong>Claimed on:</strong> {new Date(sale.paymentClaim.claimedAt).toLocaleString()}</div>
                    {sale.approvedBy && <div style={{ color: t.success }}><strong>Approved by:</strong> {sale.approvedBy} on {new Date(sale.approvedAt).toLocaleString()}</div>}
                    {sale.rejectedBy && <div style={{ color: t.danger }}><strong>Rejected by:</strong> {sale.rejectedBy} on {new Date(sale.rejectedAt).toLocaleString()}</div>}
                  </div>
                )}

                {/* Optional: uploaded image */}
                {sale.paymentProof && sale.paymentProof.data && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 6 }}>📎 Attached proof:</div>
                    {sale.paymentProof.type && sale.paymentProof.type.startsWith("image/") ? (
                      <img src={sale.paymentProof.data} alt="Proof" style={{ maxWidth: "100%", maxHeight: 350, borderRadius: 8, display: "block", marginBottom: 6 }} />
                    ) : (
                      <div style={{ padding: 10, background: t.cardBg2, borderRadius: 8, fontSize: t.fs.sm }}>
                        📄 {sale.paymentProof.name} ({Math.round((sale.paymentProof.size || 0) / 1024)} KB)
                      </div>
                    )}
                    <a href={sale.paymentProof.data} download={sale.paymentProof.name} style={{ ...t.btnGhost, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "6px 12px", fontSize: t.fs.xs }}>⬇ Download</a>
                  </div>
                )}

                {/* — CLAIM FORM — shown if payment not yet claimed or rejected (needs re-submit) */}
                {(sale.proofStatus === "none" || sale.proofStatus === "rejected" || !sale.proofStatus) && (
                  <div style={{ background: t.cardBg2, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                    <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 10, color: t.primary }}>
                      💰 Submit Payment Claim
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={t.label}>Amount Received *</label>
                      <input
                        type="number"
                        value={(proofModal && proofModal.amount) || ""}
                        onChange={e => setProofModal(p => ({ ...p, amount: e.target.value }))}
                        placeholder={"e.g. " + sale.price}
                        style={t.input}
                      />
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={t.label}>Payment Note (optional)</label>
                      <input
                        type="text"
                        value={(proofModal && proofModal.note) || ""}
                        onChange={e => setProofModal(p => ({ ...p, note: e.target.value }))}
                        placeholder="e.g. Vodafone Cash 01270935507 at 2:30pm"
                        style={t.input}
                      />
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={t.label}>📎 Attach image (optional)</label>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        onChange={(e) => uploadProof(proofModal.saleId, e.target.files[0])}
                        style={{ ...t.input, padding: 10 }}
                      />
                      <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginTop: 4 }}>
                        ℹ️ Image stays on this device only — won't sync to cloud for speed.
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        submitPaymentClaim(proofModal.saleId, proofModal.amount, proofModal.note);
                        setProofModal(null);
                      }}
                      style={{ ...t.btnPrimary, width: "100%" }}
                    >💰 Mark as Paid</button>
                  </div>
                )}

                {/* — ADMIN APPROVE/REJECT — shown when claimed (status is claimed or pending) */}
                {(sale.proofStatus === "claimed" || sale.proofStatus === "pending") && (isAdmin || can("approveProofs")) && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    <button onClick={() => { approveProof(sale.id); setProofModal(null); }} style={{ ...t.btnPrimary, background: t.success, flex: 1, minWidth: 120 }}>✓ Approve</button>
                    <button onClick={() => { rejectProof(sale.id); setProofModal(null); }} style={{ ...t.btnDanger, flex: 1, minWidth: 120 }}>✕ Reject</button>
                  </div>
                )}

                {/* — RESET button for admin — works on any status */}
                {sale.proofStatus && sale.proofStatus !== "none" && (isAdmin || can("approveProofs")) && (
                  <button onClick={() => { removeProof(sale.id); setProofModal(null); }} style={{ ...t.btnGhost, color: t.danger, borderColor: t.danger, width: "100%" }}>🗑 Reset Payment Claim</button>
                )}
              </div>
            </div>
          );
        })()}

        {/* ─── RATE / FEEDBACK MODAL ─── */}
        {showRate && (
          <div
            onClick={() => setShowRate(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 999, padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 360,
                maxWidth: "100%",
                padding: 28,
                textAlign: "center",
                borderRadius: 14,
              }}
            >
              <h3 style={{ margin: "0 0 6px", fontSize: t.fs.xl, fontWeight: 700 }}>⭐ Rate Service</h3>
              <p style={{ margin: "0 0 20px", fontSize: t.fs.base, color: t.textMuted }}>
                {showRate.customer} · {showRate.service}
              </p>
              <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 20 }}>
                {[1, 2, 3, 4, 5].map(star => (
                  <span
                    key={star}
                    onClick={() => submitFeedback(showRate.id, star)}
                    style={{
                      fontSize: isMobile ? 44 : 38,
                      cursor: "pointer",
                      filter: feedback[showRate.id] && feedback[showRate.id].rating >= star ? "none" : "grayscale(1) opacity(0.3)",
                      transition: "filter 0.2s, transform 0.2s",
                      padding: 2,
                    }}
                  >⭐</span>
                ))}
              </div>
              <button onClick={() => setShowRate(null)} style={{ ...t.btnGhost, width: "100%" }}>Close</button>
            </div>
          </div>
        )}

        {/* ─── BACKUP / RESTORE MODAL ─── */}
        {showBackup && (
          <div
            onClick={() => setShowBackup(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 999, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 500,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "90vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                borderRadius: isMobile ? 0 : 14,
                padding: isMobile ? 20 : 24,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 10 }}>
                {isMobile && (
                  <button onClick={() => setShowBackup(false)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>💾 Backup &amp; Restore</h3>
                {!isMobile && (
                  <span onClick={() => setShowBackup(false)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                )}
              </div>
              <div style={{
                padding: 16,
                background: t.dark ? "#0f172a" : "#e8f4f2",
                borderRadius: 10, marginBottom: 12,
                borderLeft: "3px solid " + t.primary,
              }}>
                <h4 style={{ margin: "0 0 6px", fontSize: t.fs.md, color: t.primary }}>📤 Export Backup</h4>
                <p style={{ margin: "0 0 10px", fontSize: t.fs.sm, color: t.textMuted }}>
                  Downloads a complete backup file (JSON) including all sales, customers, team, tasks, stock, and more.
                </p>
                <button onClick={backupAll} style={{ ...t.btnPrimary, width: "100%" }}>💾 Download Backup Now</button>
              </div>
              <div style={{
                padding: 16,
                background: t.dark ? "#422006" : "#fffbeb",
                borderRadius: 10,
                borderLeft: "3px solid " + t.warning,
              }}>
                <h4 style={{ margin: "0 0 6px", fontSize: t.fs.md, color: "#b45309" }}>📥 Restore From Backup</h4>
                <p style={{ margin: "0 0 10px", fontSize: t.fs.sm, color: t.textMuted }}>
                  ⚠️ This will <strong>replace ALL current data</strong> with the contents of the backup file.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  onChange={(e) => restoreBackup(e.target.files[0])}
                  style={{ display: "none" }}
                />
                <button onClick={() => fileInputRef.current && fileInputRef.current.click()} style={{ ...t.btnPrimary, background: t.warning, width: "100%" }}>📥 Choose Backup File</button>
              </div>
            </div>
          </div>
        )}

        {/* ─── WA TEMPLATES MODAL ─── */}
        {showTemplates && (
          <div
            onClick={() => { setShowTemplates(null); setEditTemplate(null); }}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 999, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 620,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "92vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                borderRadius: isMobile ? 0 : 14,
                padding: isMobile ? 20 : 24,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
                {isMobile && (
                  <button onClick={() => { setShowTemplates(null); setEditTemplate(null); }} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>
                  💬 Templates
                  {showTemplates.sale && <span style={{ fontSize: t.fs.sm, color: t.textMuted, marginLeft: 8, fontWeight: 500 }}>for {showTemplates.sale.customer}</span>}
                </h3>
                <div style={{ display: "flex", gap: 8 }}>
                  {isAdmin && (
                    <button onClick={() => setEditTemplate({ name: "", text: "" })} style={t.btnPrimary}>+ New</button>
                  )}
                  {!isMobile && (
                    <span onClick={() => { setShowTemplates(null); setEditTemplate(null); }} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                  )}
                </div>
              </div>

              {editTemplate && isAdmin && (
                <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                  <h4 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>{editTemplate.id ? "Edit Template" : "New Template"}</h4>
                  <input
                    value={editTemplate.name}
                    onChange={e => setEditTemplate(p => ({ ...p, name: e.target.value }))}
                    placeholder="Template name (e.g. 🎉 Welcome)"
                    style={{ ...t.input, marginBottom: 10 }}
                  />
                  <textarea
                    value={editTemplate.text}
                    onChange={e => setEditTemplate(p => ({ ...p, text: e.target.value }))}
                    rows={8}
                    placeholder="Hi {customer}! Your {service}..."
                    style={{ ...t.input, resize: "vertical", fontFamily: "inherit", marginBottom: 10, minHeight: 120 }}
                  />
                  <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
                    Available variables: <code>{"{customer}"}</code> <code>{"{service}"}</code> <code>{"{price}"}</code> <code>{"{currency}"}</code> <code>{"{period}"}</code> <code>{"{renewDate}"}</code> <code>{"{days}"}</code>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setEditTemplate(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                    <button onClick={saveTemplate} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save</button>
                  </div>
                </div>
              )}

              {waTemplates.map(tp => {
                const preview = renderTemplate(tp.text, showTemplates.sale);
                return (
                  <div key={tp.id} style={{ ...t.cardCompact, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                      <h4 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700 }}>{tp.name}</h4>
                      {isAdmin && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => setEditTemplate({ ...tp })} style={{ ...t.btnGhost, padding: "4px 10px", fontSize: t.fs.sm }}>✎</button>
                          <button onClick={() => deleteTemplate(tp.id)} style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.sm }}>✕</button>
                        </div>
                      )}
                    </div>
                    <pre style={{
                      margin: 0, padding: 12,
                      background: t.cardBg2, borderRadius: 8,
                      fontSize: t.fs.sm,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "inherit",
                      color: t.text,
                      maxHeight: 180, overflow: "auto",
                      lineHeight: 1.5,
                    }}>{preview}</pre>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      {showTemplates.sale && showTemplates.sale.customerPhone && (
                        <a
                          href={waLink(showTemplates.sale.customerPhone, preview)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ ...t.btnWA, flex: 1, justifyContent: "center" }}
                        >📱 Send via WhatsApp</a>
                      )}
                      <button onClick={() => { copyToClipboard(preview); alert("Copied!"); }} style={{ ...t.btnGhost, flex: showTemplates.sale && showTemplates.sale.customerPhone ? "0 0 auto" : 1 }}>📋 Copy</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── INVOICE MODAL ─── */}
        {invSale && (
          <div
            onClick={() => setInvSale(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 999, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "#fff",
                borderRadius: isMobile ? 0 : 14,
                width: isMobile ? "100%" : 580,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "95vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                color: "#1a2e44",
              }}
            >
              {isMobile && (
                <div style={{ background: "#1a2e44", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    onClick={() => setInvSale(null)}
                    style={{
                      background: "rgba(255,255,255,0.2)", color: "#fff",
                      border: "none", borderRadius: 8, padding: "8px 14px",
                      fontSize: 14, fontWeight: 700, cursor: "pointer", minHeight: 40,
                    }}
                  >← Back</button>
                  <span style={{ color: "#fff", fontSize: 13, opacity: 0.85 }}>Close to go back to sales</span>
                </div>
              )}
              <div style={{ background: "linear-gradient(135deg,#1a2e44,#2a9d8f)", padding: isMobile ? "18px 20px" : "22px 26px", color: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: isMobile ? 22 : 24 }}>ProSkill</h2>
                    <p style={{ margin: 0, fontSize: 9, letterSpacing: 2, opacity: 0.85 }}>DIGITAL AGENCY</p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ margin: 0, fontSize: isMobile ? 24 : 26, fontWeight: 800 }}>INVOICE</p>
                    <p style={{ margin: 0, fontSize: 10, opacity: 0.85 }}>#{String(invSale.id).slice(-6)}</p>
                  </div>
                </div>
              </div>
              <div style={{ padding: isMobile ? "18px 20px" : "22px 26px" }}>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 14, marginBottom: 18 }}>
                  <div>
                    <p style={{ margin: "0 0 2px", fontSize: 9, color: "#94a3b8", fontWeight: 700 }}>BILL TO</p>
                    <p style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>{invSale.customer}</p>
                    {invSale.customerPhone && <p style={{ margin: "0 0 2px", fontSize: 11, color: "#64748b" }}>📞 {invSale.customerPhone}</p>}
                    {invSale.customerEmail && <p style={{ margin: 0, fontSize: 11, color: "#64748b" }}>✉️ {invSale.customerEmail}</p>}
                  </div>
                  <div style={{ textAlign: isMobile ? "left" : "right" }}>
                    <p style={{ margin: "0 0 2px", fontSize: 9, color: "#94a3b8", fontWeight: 700 }}>DATE</p>
                    <p style={{ margin: "0 0 2px", fontSize: 14, fontWeight: 600 }}>{invSale.soldDate}</p>
                    <p style={{ margin: 0, fontSize: 11, color: "#64748b" }}>Due: {invSale.renewDate || "N/A"}</p>
                  </div>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 18 }}>
                  <thead>
                    <tr style={{ background: "#f5f7f9", borderBottom: "2px solid #2a9d8f" }}>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Description</th>
                      <th style={{ padding: "10px 12px" }}>Period</th>
                      <th style={{ padding: "10px 12px", textAlign: "right" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ padding: 12 }}>{svcIcon(invSale.service)} {invSale.service}</td>
                      <td style={{ padding: 12, textAlign: "center" }}>{PERIOD_LABEL(invSale.period)}</td>
                      <td style={{ padding: 12, textAlign: "right", fontWeight: 600 }}>{invSale.price} {invSale.currency || "EGP"}</td>
                    </tr>
                  </tbody>
                </table>
                <div style={{ borderTop: "2px solid #1a2e44", paddingTop: 14, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 9, color: "#94a3b8" }}>Sold by: {invSale.soldBy}</p>
                    {invSale.notes && <p style={{ margin: 0, fontSize: 9, color: "#94a3b8" }}>Note: {invSale.notes}</p>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ margin: 0, fontSize: 10, color: "#94a3b8" }}>TOTAL</p>
                    <p style={{ margin: 0, fontSize: isMobile ? 24 : 28, fontWeight: 800, color: "#2a9d8f" }}>{invSale.price} {invSale.currency || "EGP"}</p>
                  </div>
                </div>
                <div style={{ background: "#f5f7f9", borderRadius: 8, padding: "12px 14px", marginTop: 14 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 9, fontWeight: 700, color: "#1a2e44" }}>TERMS</p>
                  <p style={{ margin: 0, fontSize: 10, color: "#64748b" }}>{COMPANY.terms}</p>
                </div>
              </div>
              <div style={{ background: "#1a2e44", padding: "16px 26px", color: "#fff", display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 10 }}>
                <div style={{ textAlign: "center", minWidth: 100 }}>
                  <p style={{ margin: 0, fontSize: 8, opacity: 0.7 }}>WEBSITE</p>
                  <p style={{ margin: 0, fontSize: 11 }}>{COMPANY.website}</p>
                </div>
                <div style={{ textAlign: "center", minWidth: 100 }}>
                  <p style={{ margin: 0, fontSize: 8, opacity: 0.7 }}>WHATSAPP</p>
                  <p style={{ margin: 0, fontSize: 11 }}>{COMPANY.whatsapp}</p>
                </div>
                <div style={{ textAlign: "center", minWidth: 100 }}>
                  <p style={{ margin: 0, fontSize: 8, opacity: 0.7 }}>EMAIL</p>
                  <p style={{ margin: 0, fontSize: 11 }}>{COMPANY.email}</p>
                </div>
              </div>
              <div style={{ padding: isMobile ? "14px 20px" : "14px 26px", display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid #e8ebe9", flexWrap: "wrap" }}>
                <button onClick={() => window.print()} style={{ background: "#2a9d8f", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, cursor: "pointer", fontWeight: 600, minHeight: 40 }}>🖨️ Print</button>
                {invSale.customerPhone && (
                  <a
                    href={waLink(invSale.customerPhone, "Hi " + invSale.customer + ",\n\n🧾 Invoice #" + String(invSale.id).slice(-6) + "\n" + invSale.service + " · " + invSale.price + " " + (invSale.currency || "EGP") + "\n\nThank you!\n_ProSkill Digital Agency_")}
                    target="_blank"
                    rel="noreferrer"
                    style={{ background: "#25D366", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, cursor: "pointer", fontWeight: 600, minHeight: 40, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                  >📱 Send via WhatsApp</a>
                )}
                <button onClick={() => setInvSale(null)} style={{ background: "transparent", color: "#2a9d8f", border: "1px solid #2a9d8f", borderRadius: 8, padding: "10px 20px", fontSize: 13, cursor: "pointer", fontWeight: 600, minHeight: 40 }}>Close</button>
              </div>
            </div>
          </div>
        )}

        {/* ─── CUSTOMER DETAIL MODAL ─── */}
        {selCust && (
          <div
            onClick={() => setSelCust(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 998, padding: isMobile ? 0 : 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...t.card,
                width: isMobile ? "100%" : 480,
                maxWidth: "100%",
                maxHeight: isMobile ? "100vh" : "90vh",
                height: isMobile ? "100vh" : "auto",
                overflow: "auto",
                borderRadius: isMobile ? 0 : 14,
                padding: isMobile ? 20 : 22,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                {isMobile && (
                  <button
                    onClick={() => setSelCust(null)}
                    style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}
                  >← Back</button>
                )}
                <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>👤 {selCust.name}</h3>
                {!isMobile && (
                  <span onClick={() => setSelCust(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                )}
              </div>

              {/* Stats grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
                <div style={{ background: "#e8f4f2", borderRadius: 8, padding: 10, textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: t.primary, fontWeight: 700 }}>SALES</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: t.primary }}>{selCust.tS}</div>
                </div>
                <div style={{ background: "#f0fdf4", borderRadius: 8, padding: 10, textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: t.success, fontWeight: 700 }}>VALUE</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: t.success }}>{selCust.tV}</div>
                </div>
                <div style={{ background: "#f5f3ff", borderRadius: 8, padding: 10, textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#8b5cf6", fontWeight: 700 }}>ACTIVE</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#8b5cf6" }}>{selCust.aS}</div>
                </div>
                <div style={{
                  background: selCust.h.s >= 70 ? "#f0fdf4" : selCust.h.s >= 40 ? "#fffbeb" : "#fef2f2",
                  borderRadius: 8, padding: 10, textAlign: "center",
                }}>
                  <div style={{ fontSize: 9, color: selCust.h.c, fontWeight: 700 }}>HEALTH</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: selCust.h.c }}>{selCust.h.s}%</div>
                </div>
              </div>

              {/* Contact */}
              <div style={{ ...t.cardCompact, marginBottom: 14 }}>
                {selCust.phone && (
                  <div style={{ fontSize: t.fs.base, marginBottom: 6 }}>
                    <strong>📞</strong> {selCust.phone}
                    <a href={waLink(selCust.phone, "Hi " + selCust.name)} target="_blank" rel="noreferrer" style={{ ...t.btnWA, marginLeft: 10, padding: "4px 10px", fontSize: t.fs.sm }}>WA</a>
                  </div>
                )}
                {selCust.email && <div style={{ fontSize: t.fs.base, marginBottom: 6 }}><strong>✉️</strong> {selCust.email}</div>}
                <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                  Customer since {selCust.createdDate || "—"}
                </div>
              </div>

              {/* History */}
              <h4 style={{ margin: "0 0 8px", fontSize: t.fs.md, fontWeight: 700 }}>Sales History ({(selCust.all || []).length})</h4>
              {(selCust.all || []).map(a => (
                <div
                  key={a.id}
                  onClick={() => { setSelSale(a); setSelCust(null); }}
                  style={{
                    padding: "10px 12px", marginBottom: 6,
                    background: t.cardBg2, borderRadius: 8,
                    fontSize: t.fs.base,
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    cursor: "pointer", gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{svcIcon(a.service)} {a.service}</div>
                    <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>{a.price} {a.currency || "EGP"} · {a.soldDate}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    <span style={t.badge(a.done)}>{a.done ? "✓" : "..."}</span>
                    <span style={{ fontSize: t.fs.sm, color: daysLeft(a.renewDate) <= 0 ? t.danger : t.success, fontWeight: 600 }}>
                      {a.period === 0 ? "—" : a.period === -1 ? "∞" : daysLeft(a.renewDate) + "d"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             📊 DASHBOARD TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "dashboard" && (
          <div>
            <h2 style={{ margin: "0 0 16px", fontSize: t.fs.xl, fontWeight: 800 }}>
              📊 {isAdmin ? "Overview" : "My Dashboard"}
            </h2>

            {/* Critical alerts (admin only) */}
            {isAdmin && alerts.allN.filter(n => n.t === "danger" || n.t === "warn").length > 0 && (
              <div style={{
                ...t.card,
                marginBottom: 14,
                background: t.dark ? "#422006" : "#fffbeb",
                borderLeft: "3px solid " + t.warning,
              }}>
                <h4 style={{ margin: "0 0 8px", fontSize: t.fs.md, color: "#92400e", fontWeight: 700 }}>
                  🔔 {alerts.allN.filter(n => n.t === "danger" || n.t === "warn").length} Alert{alerts.allN.filter(n => n.t === "danger" || n.t === "warn").length > 1 ? "s" : ""}
                </h4>
                {alerts.allN.filter(n => n.t === "danger" || n.t === "warn").slice(0, isMobile ? 3 : 5).map(n => (
                  <p key={n.id} style={{ margin: "4px 0", fontSize: t.fs.sm, color: n.t === "danger" ? t.danger : "#b45309" }}>{n.m}</p>
                ))}
                {alerts.allN.length > (isMobile ? 3 : 5) && (
                  <button onClick={() => setShowNotif(true)} style={{ ...t.btnGhost, marginTop: 8, fontSize: t.fs.sm }}>View all →</button>
                )}
              </div>
            )}

            {/* Top KPI cards — big & bold */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(140px, 1fr))",
              gap: t.sp.md,
              marginBottom: t.sp.md,
            }}>
              {[
                { l: "Sales", v: myStats.tS, c: t.primaryDark },
                { l: "Revenue", v: myStats.tR.toLocaleString() + " EGP", c: t.primary },
                { l: "Profit", v: myStats.tP.toLocaleString() + " EGP", c: myStats.tP >= 0 ? t.success : t.danger },
                { l: "Pending", v: myStats.tA, c: "#8b5cf6" },
              ].map((c, i) => (
                <div key={i} style={{ ...t.card, borderTop: "3px solid " + c.c }}>
                  <p style={{ margin: 0, fontSize: t.fs.sm, color: t.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>{c.l}</p>
                  <p style={{ margin: "6px 0 0", fontSize: t.fs.xxl, fontWeight: 900, color: c.c, lineHeight: 1.1 }}>{c.v}</p>
                </div>
              ))}
            </div>

            {/* Secondary KPIs */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(120px, 1fr))",
              gap: t.sp.sm,
              marginBottom: t.sp.md,
            }}>
              {[
                { l: "MRR", v: mrr.cur.toLocaleString(), c: t.primary },
                { l: "Churn", v: mrr.cr + "%", c: mrr.cr > 20 ? t.danger : t.warning },
                { l: "Net", v: netProfit.toLocaleString() + " EGP", c: netProfit >= 0 ? t.success : t.danger },
                { l: "Growth", v: (moCmp.growth > 0 ? "+" : "") + moCmp.growth + "%", c: moCmp.growth >= 0 ? t.success : t.danger },
                { l: "Rating", v: avgRating > 0 ? avgRating + "⭐" : "—", c: avgRating >= 4 ? t.success : t.warning },
                { l: "Tasks", v: overdueTasks.length > 0 ? overdueTasks.length + " overdue" : tasksByStatus.todo.length + " todo", c: overdueTasks.length > 0 ? t.danger : t.primary },
              ].map((c, i) => (
                <div key={i} style={{ ...t.cardCompact, borderTop: "2px solid " + c.c }}>
                  <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{c.l}</p>
                  <p style={{ margin: "4px 0 0", fontSize: t.fs.lg, fontWeight: 800, color: c.c, lineHeight: 1.1 }}>{c.v}</p>
                </div>
              ))}
            </div>

            {/* Time period cards — expanded with QTD */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(5, 1fr)",
              gap: t.sp.sm,
              marginBottom: t.sp.md,
            }}>
              {[
                { l: "Today (DTD)", sub: "Daily", d: myTime.daily, cl: t.warning },
                { l: "This Week (WTD)",  sub: "Week-to-date", d: myTime.weekly, cl: t.primary },
                { l: "This Month (MTD)", sub: "Month-to-date", d: myTime.monthly, cl: t.primaryDark },
                { l: "This Quarter (QTD)", sub: "Quarter-to-date", d: myTime.quarterly, cl: "#8b5cf6" },
                { l: "This Year (YTD)",  sub: "Year-to-date", d: myTime.yearly, cl: t.success },
              ].map((p, i) => (
                <div key={i} style={{ ...t.cardCompact, borderTop: "2px solid " + p.cl }}>
                  <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700 }}>{p.l}</p>
                  <p style={{ margin: 0, fontSize: 8, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{p.sub}</p>
                  <p style={{ margin: "4px 0 0", fontSize: t.fs.lg, fontWeight: 900, color: p.cl, lineHeight: 1 }}>{p.d.count}</p>
                  <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted }}>{p.d.rev.toLocaleString()} EGP</p>
                  {p.d.profit !== undefined && (
                    <p style={{ margin: 0, fontSize: t.fs.xs, color: p.d.profit >= 0 ? t.success : t.danger }}>
                      {p.d.profit >= 0 ? "+" : ""}{p.d.profit.toLocaleString()} profit
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* Custom year/month filter */}
            {(() => {
              const years = [];
              const currentYear = new Date().getFullYear();
              for (let y = currentYear - 2; y <= currentYear; y++) years.push(y);
              // Calculate filtered stats
              const filteredForPeriod = dashboardDone.filter(a => {
                if (!a.soldDate) return false;
                if (!a.soldDate.startsWith(String(dashboardYear))) return false;
                if (dashboardMonth !== "all") {
                  const m = +dashboardMonth;
                  const mStr = String(m + 1).padStart(2, "0");
                  if (!a.soldDate.startsWith(dashboardYear + "-" + mStr)) return false;
                }
                return true;
              });
              const pCount = filteredForPeriod.length;
              const pRev = filteredForPeriod.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
              const pProfit = filteredForPeriod.reduce((s, a) => s + ((a.priceEGP || a.price || 0) - (a.costEGP || a.costPrice || 0)), 0);
              const pMonthLabel = dashboardMonth === "all" ? "Full Year" : MONTHS_SHORT[+dashboardMonth];
              return (
                <div style={{ ...t.card, marginBottom: t.sp.md, borderLeft: "3px solid " + t.primary }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
                    <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700 }}>🔍 Custom Period Analysis</h3>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <select value={dashboardYear} onChange={e => setDashboardYear(+e.target.value)} style={{ ...t.input, width: "auto", minWidth: 100 }}>
                        {years.map(y => <option key={y} value={y}>{y}</option>)}
                      </select>
                      <select value={dashboardMonth} onChange={e => setDashboardMonth(e.target.value)} style={{ ...t.input, width: "auto", minWidth: 140 }}>
                        <option value="all">All months</option>
                        {MONTHS_SHORT.map((m, i) => <option key={i} value={i}>{m}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(3, 1fr)",
                    gap: t.sp.sm,
                  }}>
                    <div style={{ padding: 12, background: t.cardBg2, borderRadius: 8, textAlign: "center" }}>
                      <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700 }}>SALES</div>
                      <div style={{ fontSize: t.fs.xl, fontWeight: 900, color: t.primary }}>{pCount}</div>
                    </div>
                    <div style={{ padding: 12, background: t.cardBg2, borderRadius: 8, textAlign: "center" }}>
                      <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700 }}>REVENUE</div>
                      <div style={{ fontSize: t.fs.md, fontWeight: 900, color: t.success }}>{pRev.toLocaleString()} EGP</div>
                    </div>
                    <div style={{ padding: 12, background: t.cardBg2, borderRadius: 8, textAlign: "center" }}>
                      <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700 }}>PROFIT</div>
                      <div style={{ fontSize: t.fs.md, fontWeight: 900, color: pProfit >= 0 ? t.success : t.danger }}>{pProfit.toLocaleString()} EGP</div>
                    </div>
                  </div>
                  <p style={{ margin: "10px 0 0", fontSize: t.fs.xs, color: t.textMuted, textAlign: "center" }}>
                    📅 Showing: <strong>{pMonthLabel} {dashboardYear}</strong>
                  </p>
                </div>
              );
            })()}

            {/* Chart card with period switcher */}
            <div style={{ ...t.card, marginBottom: t.sp.md }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700 }}>Breakdown</h3>
                <div style={{ display: "flex", gap: 4 }}>
                  {[
                    { id: "wtd", l: "Week" },
                    { id: "mtd", l: "Month" },
                    { id: "ytd", l: "Year" },
                  ].map(p => (
                    <button
                      key={p.id}
                      onClick={() => setDPer(p.id)}
                      style={{
                        ...t.btnGhost,
                        padding: isMobile ? "6px 12px" : "4px 10px",
                        fontSize: t.fs.sm,
                        background: dPer === p.id ? t.primary : "transparent",
                        color: dPer === p.id ? "#fff" : t.primary,
                        minHeight: isMobile ? 36 : 28,
                      }}
                    >{p.l}</button>
                  ))}
                </div>
              </div>
              {dPer === "wtd" && <Chart data={myTime.wtdD} theme={t} />}
              {dPer === "mtd" && <Chart data={myTime.mtdD} color={t.primaryDark} theme={t} />}
              {dPer === "ytd" && <Chart data={myTime.ytdM} theme={t} />}
            </div>

            {/* Bottom split: stock + recent sales */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: t.sp.md,
            }}>
              <div style={t.card}>
                <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>📦 Stock</h3>
                {svcNames.filter(s => (stockStatsByProduct[s]?.total || 0) > 0).map(s => {
                  const st = stockStatsByProduct[s];
                  const pct = Math.min(100, Math.round((st.avail / st.total) * 100));
                  return (
                    <div key={s} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: t.fs.sm, marginBottom: 4 }}>
                        <span>{svcIcon(s)} {s}</span>
                        <span style={{ color: st.avail < 3 ? t.danger : t.success, fontWeight: 700 }}>{st.avail}/{st.total}</span>
                      </div>
                      <div style={{ height: 6, background: t.dark ? "#334155" : "#e8ebe9", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: pct + "%", background: st.avail < 3 ? t.danger : t.primary, borderRadius: 3, transition: "width 0.3s" }} />
                      </div>
                    </div>
                  );
                })}
                {svcNames.every(s => (stockStatsByProduct[s]?.total || 0) === 0) && (
                  <p style={{ fontSize: t.fs.sm, color: t.textMuted, textAlign: "center", padding: 14, margin: 0 }}>
                    No stock accounts yet. Go to 📦 Stock tab to add some.
                  </p>
                )}
              </div>
              <div style={t.card}>
                <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>🕒 Recent Sales</h3>
                {scopedSales.slice(0, 6).map(s => (
                  <div
                    key={s.id}
                    onClick={() => setSelSale(s)}
                    style={{
                      padding: "10px 0", borderBottom: "1px solid " + t.border,
                      fontSize: t.fs.base,
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      cursor: "pointer",
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.customer}</div>
                      <div style={{ fontSize: t.fs.sm, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{svcIcon(s.service)} {s.service}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, color: s.done ? t.success : t.warning }}>{s.price} {s.currency || "EGP"}</div>
                      <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>{s.soldDate}</div>
                    </div>
                  </div>
                ))}
                {scopedSales.length === 0 && (
                  <p style={{ fontSize: t.fs.sm, color: t.textMuted, textAlign: "center", padding: 14, margin: 0 }}>
                    No sales yet. Go to 🔑 Sales tab to add one.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             💹 MRR TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "mrr" && (
          <div>
            <h2 style={{ margin: "0 0 16px", fontSize: t.fs.xl, fontWeight: 800 }}>💹 MRR &amp; Profitability</h2>

            {/* Top KPIs */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(170px, 1fr))",
              gap: t.sp.md,
              marginBottom: t.sp.lg,
            }}>
              {[
                { l: "Monthly Recurring Revenue", sub: "MRR", v: mrr.cur.toLocaleString() + " EGP", c: t.primary },
                { l: "Annual Recurring Revenue", sub: "ARR", v: mrr.arr.toLocaleString() + " EGP", c: t.primaryDark },
                { l: "Churn Rate", sub: mrr.cr > 20 ? "High" : "OK", v: mrr.cr + "%", c: mrr.cr > 20 ? t.danger : t.warning },
                { l: "Net Profit", sub: "After expenses", v: netProfit.toLocaleString() + " EGP", c: netProfit >= 0 ? t.success : t.danger },
              ].map((c, i) => (
                <div key={i} style={{ ...t.card, borderTop: "3px solid " + c.c }}>
                  <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{c.l}</p>
                  <p style={{ margin: "6px 0 2px", fontSize: t.fs.xxl, fontWeight: 900, color: c.c, lineHeight: 1.1 }}>{c.v}</p>
                  <p style={{ margin: 0, fontSize: t.fs.sm, color: t.textMuted }}>{c.sub}</p>
                </div>
              ))}
            </div>

            {/* Service ranking */}
            <div style={{ ...t.card, marginBottom: t.sp.lg }}>
              <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>🏆 Service Ranking</h3>
              {svcNames.length === 0 ? (
                <p style={{ fontSize: t.fs.base, color: t.textMuted, textAlign: "center", padding: 20, margin: 0 }}>
                  No services yet.
                </p>
              ) : svcNames.map((s, i) => {
                const v = allStats.byS[s];
                const mg = v.rev > 0 ? Math.round(v.pft / v.rev * 100) : 0;
                return (
                  <div
                    key={s}
                    style={{
                      padding: "12px 0",
                      borderBottom: i < svcNames.length - 1 ? "1px solid " + t.border : "none",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                        <span style={{
                          background: i === 0 ? "#fbbf24" : i === 1 ? "#94a3b8" : i === 2 ? "#ea580c" : t.border,
                          color: "#fff", fontWeight: 800, fontSize: t.fs.sm,
                          width: 24, height: 24, borderRadius: 12,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          flexShrink: 0,
                        }}>{i + 1}</span>
                        <span style={{ fontSize: t.fs.base, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {svcIcon(s)} {s}
                        </span>
                      </div>
                      <div style={{ textAlign: "right", fontSize: t.fs.sm, flexShrink: 0 }}>
                        <div style={{ fontWeight: 700, color: t.primary }}>{v.rev.toLocaleString()} EGP</div>
                        <div style={{ color: v.pft >= 0 ? t.success : t.danger }}>
                          {v.pft >= 0 ? "+" : ""}{v.pft.toLocaleString()} · {mg}% margin
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 3-month forecast */}
            <div style={t.card}>
              <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>📈 3-Month Forecast</h3>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: t.sp.sm,
              }}>
                {forecast.map(f => (
                  <div
                    key={f.month}
                    style={{
                      padding: 14,
                      background: t.cardBg2,
                      borderRadius: 10,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: t.fs.sm, color: t.textMuted, fontWeight: 700 }}>{f.month}</div>
                    <div style={{ fontSize: t.fs.xl, fontWeight: 800, color: t.primary, marginTop: 6 }}>
                      {f.rev.toLocaleString()}
                    </div>
                    <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginTop: 2 }}>EGP projected</div>
                    <div style={{ fontSize: t.fs.sm, color: t.warning, marginTop: 6, fontWeight: 600 }}>
                      🔄 {f.renewals}
                    </div>
                    <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>renewals</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             🔑 SALES TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "sales_entry" && (
          <div>
            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>
                🔑 {isAdmin ? "Sales" : "My Sales"} ({filteredSales.length})
              </h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {svcNames.length > 0 && (
                  <button
                    onClick={() => setNewSale({
                      service: svcNames[0], customer: "", customerPhone: "", customerEmail: "",
                      period: 1, price: 0, costPrice: 0, currency: "EGP",
                      soldDate: todayStr(), notes: "", assignedTo: null,
                    })}
                    style={t.btnPrimary}
                  >+ New Sale</button>
                )}
                <ExportMenu
                  theme={t}
                  onCsv={() => exportCSV(filteredSales.map(a => ({
                    ID: String(a.id).slice(-6),
                    Service: a.service,
                    Customer: a.customer,
                    Phone: a.customerPhone || "",
                    Email: a.customerEmail || "",
                    Price: a.price,
                    Currency: a.currency || "EGP",
                    "Sold Date": a.soldDate,
                    "Renew Date": a.renewDate,
                    Status: a.done ? "Done" : "Pending",
                    "Sold By": a.soldBy,
                  })), "sales_" + todayStr() + ".csv")}
                  onXlsx={() => exportExcel(filteredSales.map(a => ({
                    Service: a.service, Customer: a.customer, Phone: a.customerPhone || "",
                    Email: a.customerEmail || "",
                    Price: a.price, Currency: a.currency || "EGP",
                    SoldDate: a.soldDate, RenewDate: a.renewDate,
                    Status: a.done ? "Done" : "Pending",
                  })), "sales_" + todayStr() + ".xls", "Sales")}
                  onPdf={() => exportPDF("Sales Report", filteredSales.map(a => ({
                    Service: a.service, Customer: a.customer,
                    Phone: a.customerPhone || "—",
                    Email: a.customerEmail || "—",
                    Price: a.price + " " + (a.currency || "EGP"),
                    "Sold Date": a.soldDate,
                    Status: a.done ? "Done" : "Pending",
                  })), "sales_" + todayStr() + ".pdf")}
                />
              </div>
            </div>

            {/* Time period chips (default: Today) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {[
                { id: "today",  l: "📅 Today" },
                { id: "week",   l: "📆 This Week" },
                { id: "month",  l: "🗓 This Month" },
                { id: "year",   l: "📈 This Year" },
                { id: "all",    l: "♾ All Time" },
              ].map(p => {
                const active = salesPeriod === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSalesPeriod(p.id)}
                    style={{
                      ...t.btnGhost,
                      background: active ? t.primaryDark : "transparent",
                      color: active ? "#fff" : t.primaryDark,
                      borderColor: t.primaryDark,
                      fontSize: t.fs.sm,
                      fontWeight: active ? 700 : 500,
                      padding: isMobile ? "8px 14px" : "4px 10px",
                      minHeight: isMobile ? 36 : 28,
                    }}
                  >{p.l}</button>
                );
              })}
            </div>

            {/* Filter chips */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {[
                { id: "all",       l: "All" },
                { id: "pending",   l: "⏳ Pending" },
                { id: "done",      l: "✓ Done" },
                { id: "approved",  l: "💰 Approved" },
                { id: "cancelled", l: "✕ Cancelled" },
                { id: "followup",  l: "📞 Follow-up" },
              ].map(f => {
                const active = salesFilter === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setSalesFilter(f.id)}
                    style={{
                      ...t.btnGhost,
                      background: active ? t.primary : "transparent",
                      color: active ? "#fff" : t.primary,
                      fontSize: t.fs.sm,
                      padding: isMobile ? "8px 14px" : "4px 10px",
                      minHeight: isMobile ? 36 : 28,
                    }}
                  >{f.l}</button>
                );
              })}
            </div>

            {/* Search + filters */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "2fr 1fr 1fr 1fr 1fr",
              gap: 8,
              marginBottom: 14,
            }}>
              <input placeholder="🔍 Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...t.input, gridColumn: isMobile ? "1 / -1" : "auto" }} />
              <select value={salesFilterProd} onChange={e => setSalesFilterProd(e.target.value)} style={t.input}>
                <option value="all">All Products</option>
                {svcNames.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input placeholder="📞 Phone..." value={salesFilterPhone} onChange={e => setSalesFilterPhone(e.target.value)} style={t.input} />
              <input type="date" value={dFrom} onChange={e => setDFrom(e.target.value)} style={t.input} placeholder="From" />
              <input type="date" value={dTo} onChange={e => setDTo(e.target.value)} style={t.input} placeholder="To" />
            </div>

            {/* New sale form — multi-service + customer autocomplete */}
            {newSale && (() => {
              if (!newSale.lines) {
                setTimeout(() => setNewSale(p => p ? ({
                  ...p,
                  lines: [{
                    service: p.service || svcNames[0] || "",
                    period: p.period || 1,
                    price: p.price || 0,
                    costPrice: p.costPrice || 0,
                    currency: p.currency || "EGP",
                  }],
                }) : p), 0);
                return null;
              }
              const updateLine = (idx, patch) => {
                setNewSale(p => ({ ...p, lines: p.lines.map((L, i) => i === idx ? { ...L, ...patch } : L) }));
              };
              const addLine = () => {
                setNewSale(p => ({
                  ...p,
                  lines: [...p.lines, {
                    service: svcNames.find(s => !p.lines.some(L => L.service === s)) || svcNames[0] || "",
                    period: 1, price: 0, costPrice: 0, currency: "EGP",
                  }],
                }));
              };
              const removeLine = (idx) => {
                if (newSale.lines.length <= 1) return;
                setNewSale(p => ({ ...p, lines: p.lines.filter((_, i) => i !== idx) }));
              };
              const custMatches = newSale.customer && newSale.customer.length >= 1
                ? customers.filter(c =>
                    c.name.toLowerCase().includes(newSale.customer.toLowerCase())
                    && c.name.toLowerCase() !== newSale.customer.toLowerCase()
                  ).slice(0, 6)
                : [];
              const totalPrice = newSale.lines.reduce((s, L) => s + (Number(L.price) || 0), 0);
              return (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Sale</h3>

                {/* Customer section */}
                <div style={{ background: t.cardBg2, padding: 12, borderRadius: 10, marginBottom: 12 }}>
                  <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 8, color: t.primary }}>👤 Customer</div>
                  <div style={{ position: "relative", marginBottom: 10 }}>
                    <label style={t.label}>Customer Name *</label>
                    <input
                      value={newSale.customer || ""}
                      onChange={e => setNewSale(p => ({ ...p, customer: e.target.value, _showSug: true }))}
                      onFocus={() => setNewSale(p => ({ ...p, _showSug: true }))}
                      onBlur={() => setTimeout(() => setNewSale(p => p ? ({ ...p, _showSug: false }) : p), 150)}
                      placeholder="Start typing to find existing customers..."
                      style={{ ...t.input, borderColor: !newSale.customer || !newSale.customer.trim() ? t.danger : undefined }}
                      autoComplete="off"
                    />
                    {newSale._showSug && custMatches.length > 0 && (
                      <div style={{
                        position: "absolute", top: "100%", left: 0, right: 0,
                        background: t.cardBg, border: "1px solid " + t.primary,
                        borderRadius: 8, marginTop: 2, zIndex: 100,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                        maxHeight: 220, overflow: "auto",
                      }}>
                        <div style={{ padding: "6px 10px", fontSize: t.fs.xs, color: t.textMuted, borderBottom: "1px solid " + t.border, background: t.cardBg2 }}>
                          📋 Existing customers — tap to fill
                        </div>
                        {custMatches.map(c => (
                          <div
                            key={c.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setNewSale(p => ({
                                ...p,
                                customer: c.name,
                                customerPhone: c.phone || p.customerPhone || "",
                                customerEmail: c.email || p.customerEmail || "",
                                _showSug: false,
                              }));
                            }}
                            style={{
                              padding: "10px 12px", cursor: "pointer",
                              borderBottom: "1px solid " + t.border,
                              fontSize: t.fs.sm,
                            }}
                          >
                            <div style={{ fontWeight: 600 }}>{c.name}</div>
                            <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>
                              {c.phone && "📞 " + c.phone}
                              {c.email && (c.phone ? " · " : "") + "✉️ " + c.email}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={t.label}>Phone</label>
                      <input value={newSale.customerPhone || ""} onChange={e => setNewSale(p => ({ ...p, customerPhone: e.target.value }))} style={t.input} />
                    </div>
                    <div>
                      <label style={t.label}>Email</label>
                      <input type="email" value={newSale.customerEmail || ""} onChange={e => setNewSale(p => ({ ...p, customerEmail: e.target.value }))} style={t.input} />
                    </div>
                  </div>
                </div>

                {/* Service lines */}
                <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 8, color: t.primary }}>
                  🛒 Services ({newSale.lines.length})
                </div>
                {newSale.lines.map((L, idx) => (
                  <div key={idx} style={{
                    background: t.cardBg2, padding: 12, borderRadius: 10, marginBottom: 10,
                    borderLeft: "3px solid " + t.primary,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: t.fs.sm, fontWeight: 700 }}>Service {idx + 1}</span>
                      {newSale.lines.length > 1 && (
                        <button onClick={() => removeLine(idx)} style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.xs }}>✕ Remove</button>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr", gap: 8, marginBottom: 8 }}>
                      <div>
                        <label style={t.label}>Service</label>
                        <select value={L.service} onChange={e => updateLine(idx, { service: e.target.value })} style={t.input}>
                          {svcNames.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={t.label}>Period</label>
                        <select value={L.period} onChange={e => updateLine(idx, { period: +e.target.value })} style={t.input}>
                          {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABEL(p)}</option>)}
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      <div>
                        <label style={t.label}>Price *</label>
                        <input type="number" value={L.price} onChange={e => updateLine(idx, { price: +e.target.value })} style={{ ...t.input, borderColor: L.price <= 0 ? t.danger : undefined }} />
                      </div>
                      <div>
                        <label style={t.label}>Cost</label>
                        <input type="number" value={L.costPrice} onChange={e => updateLine(idx, { costPrice: +e.target.value })} style={t.input} />
                      </div>
                      <div>
                        <label style={t.label}>Currency</label>
                        <select value={L.currency} onChange={e => updateLine(idx, { currency: e.target.value })} style={t.input}>
                          {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Add another service button */}
                <button
                  onClick={addLine}
                  style={{
                    ...t.btnGhost,
                    width: "100%",
                    padding: "12px",
                    fontSize: t.fs.base,
                    fontWeight: 600,
                    marginBottom: 12,
                    borderStyle: "dashed",
                    minHeight: 48,
                  }}
                >➕ Add Another Service (same customer)</button>

                {/* Shared fields */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Sold Date</label>
                    <input type="date" value={newSale.soldDate} onChange={e => setNewSale(p => ({ ...p, soldDate: e.target.value }))} style={t.input} />
                  </div>
                  {isAdmin && team.length > 0 && (
                    <div>
                      <label style={t.label}>👤 Sold By</label>
                      <select value={newSale.assignedTo || ""} onChange={e => setNewSale(p => ({ ...p, assignedTo: e.target.value ? +e.target.value : null }))} style={t.input}>
                        <option value="">— Unassigned —</option>
                        {team.map(m => <option key={m.id} value={m.id}>{m.name} ({m.commissionRate || 0}%)</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={t.label}>Notes (shared across all services)</label>
                  <input value={newSale.notes || ""} onChange={e => setNewSale(p => ({ ...p, notes: e.target.value }))} style={t.input} />
                </div>

                {/* Total summary */}
                <div style={{
                  background: t.dark ? "#052e16" : "#f0fdf4",
                  padding: "12px 14px",
                  borderRadius: 10,
                  marginBottom: 12,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span style={{ fontSize: t.fs.sm, color: t.textMuted, fontWeight: 600 }}>
                    Total ({newSale.lines.length} service{newSale.lines.length > 1 ? "s" : ""})
                  </span>
                  <span style={{ fontSize: t.fs.xl, fontWeight: 800, color: t.success }}>
                    {totalPrice.toLocaleString()} {newSale.lines[0] && newSale.lines[0].currency}
                  </span>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setNewSale(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addSaleEntry} style={{ ...t.btnPrimary, flex: 2 }}>💾 Save {newSale.lines.length > 1 ? (newSale.lines.length + " Sales") : "Sale"}</button>
                </div>
              </div>
              );
            })()}

            {/* Bulk actions (admin only) */}
            {isAdmin && selBulk.length > 0 && (
              <div style={{
                ...t.card,
                marginBottom: 10,
                background: t.dark ? "#422006" : "#fffbeb",
                borderLeft: "3px solid " + t.warning,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                flexWrap: "wrap", gap: 10,
              }}>
                <span style={{ fontSize: t.fs.base, fontWeight: 600 }}>{selBulk.length} selected</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={bulkDone} style={{ ...t.btnPrimary, background: t.success }}>✓ Mark Done</button>
                  <button onClick={bulkDelete} style={t.btnDanger}>🗑 Delete</button>
                  <button onClick={() => setSelBulk([])} style={t.btnGhost}>Clear</button>
                </div>
              </div>
            )}

            {/* ═══ MOBILE: CARD VIEW (grouped by service) ═══ */}
            {isMobile && (
              <div>
                {filteredSales.length === 0 ? (
                  <div style={{ ...t.card, textAlign: "center", padding: 30, color: t.textMuted }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>📭</div>
                    <p style={{ margin: 0 }}>No sales match your filters.</p>
                  </div>
                ) : svcNames.map(svc => {
                  const svcSales = filteredSales.filter(a => a.service === svc);
                  if (!svcSales.length) return null;
                  return (
                    <div key={svc} style={{ marginBottom: 16 }}>
                      {/* Group header */}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "10px 4px 8px",
                        borderBottom: "2px solid " + t.primary,
                        marginBottom: 8,
                      }}>
                        <span style={{ fontSize: 22 }}>{svcIcon(svc)}</span>
                        <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 800, flex: 1 }}>{svc}</h3>
                        <span style={{
                          fontSize: t.fs.xs, fontWeight: 700,
                          background: t.primary, color: "#fff",
                          padding: "3px 10px", borderRadius: 10,
                        }}>{svcSales.length}</span>
                      </div>
                      {svcSales.map(a => {
                  const days = daysLeft(a.renewDate);
                  const renewColor = a.period === 0 ? t.textMuted : a.period === -1 ? t.success : days <= 0 ? t.danger : days <= 7 ? t.warning : t.success;
                  return (
                    <div
                      key={a.id}
                      onClick={() => setSelSale(a)}
                      style={{
                        ...t.card,
                        marginBottom: 10,
                        cursor: "pointer",
                        background: a.followUp ? (t.dark ? "#422006" : "#fff7ed") : t.cardBg,
                        borderLeft: a.done ? "4px solid " + t.success : "4px solid " + t.warning,
                      }}
                    >
                      {/* Top row: service + status + bulk checkbox */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                          {isAdmin && (
                            <input
                              type="checkbox"
                              checked={selBulk.includes(a.id)}
                              onChange={() => setSelBulk(p => p.includes(a.id) ? p.filter(x => x !== a.id) : [...p, a.id])}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: 20, height: 20, accentColor: t.primary, flexShrink: 0 }}
                            />
                          )}
                          <span style={{ fontSize: 22, flexShrink: 0 }}>{svcIcon(a.service)}</span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: t.fs.md, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.customer}</div>
                            <div style={{ fontSize: t.fs.sm, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.service}</div>
                          </div>
                        </div>
                        <span style={t.badge(a.done)}>{a.done ? "✓ Done" : "Pending"}</span>
                      </div>

                      {/* Price + period + renewal */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
                        <div style={{ fontSize: t.fs.lg, fontWeight: 800, color: t.success }}>
                          {a.price} {a.currency || "EGP"}
                        </div>
                        <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                          {PERIOD_LABEL(a.period)}
                        </div>
                        <div style={{ fontSize: t.fs.sm, color: renewColor, fontWeight: 700 }}>
                          {a.period === 0 ? "—" : a.period === -1 ? "∞" : days + "d"}
                        </div>
                      </div>

                      {/* Contact + assigned */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: t.fs.sm, color: t.textMuted, flexWrap: "wrap" }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          {a.customerPhone && <div>📞 {a.customerPhone}</div>}
                          {a.customerEmail && <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✉️ {a.customerEmail}</div>}
                        </div>
                        {a.assignedTo && (() => {
                          const m = team.find(x => x.id === a.assignedTo);
                          return m ? <span style={{ color: t.primary, fontWeight: 600, flexShrink: 0 }}>👤 {m.name}</span> : null;
                        })()}
                      </div>

                      {/* Action row */}
                      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                        {canEditSale(a) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleDone(a.id); }}
                            style={{ ...t.btnGhost, padding: "8px 12px", fontSize: t.fs.sm, flex: 1, minWidth: 80 }}
                          >{a.done ? "↩ Undo" : "✓ Done"}</button>
                        )}
                        {canEditSale(a) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleFollow(a.id); }}
                            style={{
                              ...t.btnGhost, padding: "8px 12px", fontSize: t.fs.sm, flex: 1, minWidth: 80,
                              background: a.followUp ? t.warning : "transparent",
                              color: a.followUp ? "#fff" : t.warning,
                              borderColor: t.warning,
                            }}
                          >📞 {a.followUp ? "Following" : "Follow"}</button>
                        )}
                        {a.customerPhone && (
                          <a
                            href={waLink(a.customerPhone, "Hi " + a.customer)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ ...t.btnWA, padding: "8px 12px", fontSize: t.fs.sm, flex: 1, minWidth: 80, justifyContent: "center" }}
                          >📱 WA</a>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); setInvSale(a); }}
                          style={{ ...t.btnGhost, padding: "8px 12px", fontSize: t.fs.sm }}
                        >🧾</button>
                      </div>
                    </div>
                  );
                })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ═══ DESKTOP: TABLE VIEW (grouped by service) ═══ */}
            {!isMobile && (
              <div>
                {filteredSales.length === 0 ? (
                  <div style={{ ...t.card, textAlign: "center", padding: 40, color: t.textMuted }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>📭</div>
                    <p style={{ margin: 0 }}>No sales match your filters.</p>
                  </div>
                ) : svcNames.map(svc => {
                  const svcSales = filteredSales.filter(a => a.service === svc);
                  if (!svcSales.length) return null;
                  return (
                    <div key={svc} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 18 }}>{svcIcon(svc)}</span>
                        <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700 }}>{svc}</h3>
                        <span style={{ fontSize: t.fs.sm, color: t.textMuted, background: t.dark ? "#334155" : "#e8ebe9", padding: "2px 8px", borderRadius: 8 }}>{svcSales.length}</span>
                      </div>
                      <div style={{ ...t.card, padding: 0, overflow: "hidden" }}>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, fontSize: t.fs.sm }}>
                            <thead>
                              <tr style={{ background: t.cardBg2, borderBottom: "2px solid " + t.border }}>
                                {["", "Status", "Customer", "Phone", "Period", "Price", "Date", "Renew", "Member", ""].map((h, i) => (
                                  <th key={i} style={{ textAlign: "left", padding: "10px 10px", fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {svcSales.map(a => {
                                const days = daysLeft(a.renewDate);
                                const renewColor = days <= 0 ? t.danger : days <= 7 ? t.warning : t.success;
                                const m = a.assignedTo ? team.find(x => x.id === a.assignedTo) : null;
                                return (
                                  <tr
                                    key={a.id}
                                    onClick={() => setSelSale(a)}
                                    style={{
                                      borderBottom: "1px solid " + t.border,
                                      cursor: "pointer",
                                      background: a.followUp ? (t.dark ? "#422006" : "#fff7ed") : "transparent",
                                    }}
                                  >
                                    <td style={{ padding: "10px" }} onClick={e => e.stopPropagation()}>
                                      {isAdmin && (
                                        <input type="checkbox" checked={selBulk.includes(a.id)} onChange={() => setSelBulk(p => p.includes(a.id) ? p.filter(x => x !== a.id) : [...p, a.id])} />
                                      )}
                                    </td>
                                    <td style={{ padding: "10px" }}><span style={t.badge(a.done)}>{a.done ? "✓" : "..."}</span></td>
                                    <td style={{ padding: "10px", fontWeight: 600 }}>{a.customer}</td>
                                    <td style={{ padding: "10px", color: t.primary }}>{a.customerPhone || "—"}</td>
                                    <td style={{ padding: "10px" }}>{PERIOD_LABEL(a.period)}</td>
                                    <td style={{ padding: "10px", fontWeight: 700, color: t.success }}>{a.price} {a.currency || "EGP"}</td>
                                    <td style={{ padding: "10px", fontSize: t.fs.xs, color: t.textMuted }}>{a.soldDate}</td>
                                    <td style={{ padding: "10px" }}>
                                      {a.period === 0 ? "—" : a.period === -1 ? "∞" : <span style={{ color: renewColor, fontWeight: 700 }}>{days}d</span>}
                                    </td>
                                    <td style={{ padding: "10px", fontSize: t.fs.xs, color: m ? t.primary : t.textMuted }}>
                                      {m ? "👤 " + m.name : "—"}
                                    </td>
                                    <td style={{ padding: "10px" }} onClick={e => e.stopPropagation()}>
                                      <div style={{ display: "flex", gap: 4 }}>
                                        {canEditSale(a) && <button onClick={() => toggleDone(a.id)} style={{ ...t.btnGhost, padding: "4px 8px", minHeight: 28, fontSize: t.fs.xs }}>{a.done ? "↩" : "✓"}</button>}
                                        <button onClick={() => setInvSale(a)} style={{ ...t.btnGhost, padding: "4px 8px", minHeight: 28, fontSize: t.fs.xs }}>🧾</button>
                                        {canEditSale(a) && <button onClick={() => setEditSale({ ...a })} style={{ ...t.btnGhost, padding: "4px 8px", minHeight: 28, fontSize: t.fs.xs }}>✎</button>}
                                        {isAdmin && <button onClick={() => deleteSale(a.id)} style={{ ...t.btnDanger, padding: "4px 8px", minHeight: 28, fontSize: t.fs.xs }}>✕</button>}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             👤 CUSTOMERS TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "customers" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>
                👤 {isAdmin ? "Customers" : "My Customers"} ({custList.length})
              </h2>
              <ExportMenu
                theme={t}
                onCsv={() => exportCSV(custList.map(c => ({
                  Name: c.name, Phone: c.phone || "", Email: c.email || "",
                  "Total Sales": c.tS, "Active Subs": c.aS,
                  "Total Value (EGP)": c.tV, Status: c.h.l,
                })), "customers_" + todayStr() + ".csv")}
                onXlsx={() => exportExcel(custList.map(c => ({
                  Name: c.name, Phone: c.phone || "", Email: c.email || "",
                  TotalSales: c.tS, ActiveSubs: c.aS, Value: c.tV, Status: c.h.l,
                })), "customers_" + todayStr() + ".xls", "Customers")}
                onPdf={() => exportPDF("Customer Report", custList.map(c => ({
                  Name: c.name, Phone: c.phone || "—",
                  Sales: c.tS, Active: c.aS,
                  Value: c.tV.toLocaleString(), Status: c.h.l,
                })), "customers_" + todayStr() + ".pdf")}
              />
            </div>

            {/* Search + filter */}
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr", gap: 8, marginBottom: 14 }}>
              <input
                placeholder="🔍 Search by name, phone, email..."
                value={custSearch}
                onChange={e => setCustSearch(e.target.value)}
                style={t.input}
              />
              <select value={custFilterStatus} onChange={e => setCustFilterStatus(e.target.value)} style={t.input}>
                <option value="all">All Customers</option>
                <option value="active">🔄 Active (has running sub)</option>
                <option value="unpaid">💳 Not Paid</option>
                <option value="followup">📞 Follow-up</option>
                <option value="upcomingRenew">⏰ Upcoming Renew (≤14d)</option>
                <option value="recurring">⭐ Recurring Customer (2+ sales)</option>
              </select>
            </div>

            {(() => {
              const filtered = custList.filter(c => {
                if (custSearch) {
                  const s = custSearch.toLowerCase();
                  if (!c.name.toLowerCase().includes(s) && !(c.phone || "").includes(s) && !(c.email || "").toLowerCase().includes(s)) return false;
                }
                const cSales = c.all || [];
                if (custFilterStatus === "active") return c.aS > 0;
                if (custFilterStatus === "unpaid") {
                  return cSales.some(a => {
                    const pi = a.checklist ? a.checklist.find(x => x.label.toLowerCase().includes("payment")) : null;
                    return pi && !pi.checked;
                  });
                }
                if (custFilterStatus === "followup") return cSales.some(a => a.followUp);
                if (custFilterStatus === "upcomingRenew") {
                  return cSales.some(a => a.done && a.renewDate && daysLeft(a.renewDate) >= 0 && daysLeft(a.renewDate) <= 14);
                }
                if (custFilterStatus === "recurring") return cSales.filter(a => a.done).length >= 2;
                return true;
              });

              if (filtered.length === 0) {
                return (
                  <div style={{ ...t.card, textAlign: "center", padding: 30, color: t.textMuted }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>👥</div>
                    <p style={{ margin: 0 }}>No customers match your filters.</p>
                    {customers.length === 0 && (
                      <p style={{ margin: "8px 0 0", fontSize: t.fs.sm }}>
                        Customers are added automatically when you create sales.
                      </p>
                    )}
                  </div>
                );
              }

              // MOBILE: card view
              if (isMobile) {
                return filtered.map(c => (
                  <div
                    key={c.id}
                    onClick={() => setSelCust(c)}
                    style={{
                      ...t.card,
                      marginBottom: 10,
                      cursor: "pointer",
                      borderLeft: "4px solid " + c.h.c,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: t.fs.md, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                        {c.phone && <div style={{ fontSize: t.fs.sm, color: t.primary, marginTop: 2 }}>📞 {c.phone}</div>}
                        {c.email && <div style={{ fontSize: t.fs.sm, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✉️ {c.email}</div>}
                      </div>
                      <span style={{
                        padding: "4px 10px", borderRadius: 20, fontSize: t.fs.sm, fontWeight: 700,
                        background: c.h.s >= 70 ? "#f0fdf4" : c.h.s >= 40 ? "#fffbeb" : "#fef2f2",
                        color: c.h.c,
                        flexShrink: 0,
                      }}>{c.h.l} {c.h.s}%</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
                      <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Sales</div>
                        <div style={{ fontSize: t.fs.lg, fontWeight: 800, color: t.primary }}>{c.tS}</div>
                      </div>
                      <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Value</div>
                        <div style={{ fontSize: t.fs.lg, fontWeight: 800, color: t.success }}>{c.tV}</div>
                      </div>
                      <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Active</div>
                        <div style={{ fontSize: t.fs.lg, fontWeight: 800, color: "#8b5cf6" }}>{c.aS}</div>
                      </div>
                    </div>
                  </div>
                ));
              }

              // DESKTOP: list view
              return (
                <div style={t.card}>
                  {filtered.map(c => (
                    <div
                      key={c.id}
                      onClick={() => setSelCust(c)}
                      style={{
                        padding: "10px 0", borderBottom: "1px solid " + t.border,
                        cursor: "pointer",
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        gap: 12, flexWrap: "wrap",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: t.fs.base, fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                          {c.phone && "📞 " + c.phone}
                          {c.phone && c.email && " · "}
                          {c.email && "✉️ " + c.email}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: t.fs.sm, fontWeight: 700, color: t.primary }}>{c.tS} sales</span>
                        <span style={{ fontSize: t.fs.sm, color: t.success }}>{c.tV.toLocaleString()} EGP</span>
                        <span style={{
                          padding: "2px 8px", borderRadius: 8, fontSize: t.fs.xs,
                          background: c.h.s >= 70 ? "#f0fdf4" : c.h.s >= 40 ? "#fffbeb" : "#fef2f2",
                          color: c.h.c, fontWeight: 700,
                        }}>{c.h.l}</span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             ✅ TASKS TAB (with status stages)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "tasks" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>
                ✅ {isAdmin ? "Tasks" : "My Tasks"} ({visibleTasks.length})
              </h2>
              <button onClick={() => setNewTask({ title: "", description: "", priority: "medium", deadline: "", assignedTo: memberId || (team[0] && team[0].id) || null })} style={t.btnPrimary}>+ New Task</button>
            </div>

            {/* Overdue warning */}
            {overdueTasks.length > 0 && (
              <div style={{
                ...t.card,
                marginBottom: 12,
                background: t.dark ? "#450a0a" : "#fef2f2",
                borderLeft: "3px solid " + t.danger,
              }}>
                <p style={{ margin: 0, fontSize: t.fs.base, color: t.danger, fontWeight: 700 }}>
                  ⚠️ {overdueTasks.length} overdue task{overdueTasks.length > 1 ? "s" : ""}
                </p>
              </div>
            )}

            {/* New task form */}
            {newTask && (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Task</h3>
                <div style={{ marginBottom: 10 }}>
                  <label style={t.label}>Title *</label>
                  <input value={newTask.title} onChange={e => setNewTask(p => ({ ...p, title: e.target.value }))} style={t.input} autoFocus />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={t.label}>Description</label>
                  <textarea value={newTask.description} onChange={e => setNewTask(p => ({ ...p, description: e.target.value }))} rows={2} style={{ ...t.input, resize: "vertical", minHeight: 60 }} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Priority</label>
                    <select value={newTask.priority} onChange={e => setNewTask(p => ({ ...p, priority: e.target.value }))} style={t.input}>
                      {TASK_PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={t.label}>Deadline</label>
                    <input type="date" value={newTask.deadline} onChange={e => setNewTask(p => ({ ...p, deadline: e.target.value }))} style={t.input} />
                  </div>
                  {isAdmin && team.length > 0 && (
                    <div style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>
                      <label style={t.label}>👤 Assign To</label>
                      <select value={newTask.assignedTo || ""} onChange={e => setNewTask(p => ({ ...p, assignedTo: e.target.value ? +e.target.value : null }))} style={t.input}>
                        <option value="">— Unassigned —</option>
                        {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setNewTask(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addTask} style={{ ...t.btnPrimary, flex: 1 }}>💾 Add Task</button>
                </div>
              </div>
            )}

            {/* Edit task modal */}
            {editTask && (
              <div
                onClick={() => setEditTask(null)}
                style={{
                  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  zIndex: 999, padding: isMobile ? 0 : 20,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    ...t.card,
                    width: isMobile ? "100%" : 440,
                    maxWidth: "100%",
                    height: isMobile ? "100vh" : "auto",
                    maxHeight: isMobile ? "100vh" : "90vh",
                    overflow: "auto",
                    borderRadius: isMobile ? 0 : 14,
                    padding: isMobile ? 20 : 22,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                    {isMobile && (
                      <button onClick={() => setEditTask(null)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                    )}
                    <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>✎ Edit Task</h3>
                    {!isMobile && (
                      <span onClick={() => setEditTask(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                    )}
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={t.label}>Title</label>
                    <input value={editTask.title} onChange={e => setEditTask(p => ({ ...p, title: e.target.value }))} style={t.input} />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={t.label}>Description</label>
                    <textarea value={editTask.description || ""} onChange={e => setEditTask(p => ({ ...p, description: e.target.value }))} rows={3} style={{ ...t.input, resize: "vertical" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div>
                      <label style={t.label}>Priority</label>
                      <select value={editTask.priority || "medium"} onChange={e => setEditTask(p => ({ ...p, priority: e.target.value }))} style={t.input}>
                        {TASK_PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={t.label}>Deadline</label>
                      <input type="date" value={editTask.deadline || ""} onChange={e => setEditTask(p => ({ ...p, deadline: e.target.value }))} style={t.input} />
                    </div>
                    {isAdmin && team.length > 0 && (
                      <div style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>
                        <label style={t.label}>Assigned</label>
                        <select value={editTask.assignedTo || ""} onChange={e => setEditTask(p => ({ ...p, assignedTo: e.target.value ? +e.target.value : null }))} style={t.input}>
                          <option value="">—</option>
                          {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setEditTask(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                    <button onClick={saveEditTask} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save</button>
                  </div>
                </div>
              </div>
            )}

            {/* Kanban-lite: 3 columns on desktop, stacked on mobile */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr",
              gap: 12,
            }}>
              {TASK_STATUSES.map(s => {
                const items = tasksByStatus[s.id] || [];
                return (
                  <div
                    key={s.id}
                    style={{
                      ...t.card,
                      borderTop: "3px solid " + s.color,
                      minHeight: isMobile ? "auto" : 200,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700, color: s.color }}>
                        {s.icon} {s.label}
                      </h3>
                      <span style={{ fontSize: t.fs.sm, color: t.textMuted, background: t.cardBg2, padding: "2px 10px", borderRadius: 10, fontWeight: 700 }}>{items.length}</span>
                    </div>
                    {items.length === 0 ? (
                      <p style={{ fontSize: t.fs.sm, color: t.textMuted, textAlign: "center", padding: 20, margin: 0, fontStyle: "italic" }}>No tasks</p>
                    ) : items.map(tk => {
                      const prio = TASK_PRIORITIES.find(p => p.id === (tk.priority || "medium"));
                      const overdue = (tk.status || "todo") !== "done" && tk.deadline && tk.deadline < todayStr();
                      const assignedName = tk.assignedTo ? (team.find(m => m.id === tk.assignedTo) || {}).name : null;
                      return (
                        <div
                          key={tk.id}
                          style={{
                            padding: 12,
                            marginBottom: 8,
                            background: overdue ? (t.dark ? "#450a0a" : "#fef2f2") : t.cardBg2,
                            borderRadius: 10,
                            borderLeft: "3px solid " + (overdue ? t.danger : prio.color),
                            cursor: canEditTask(tk) ? "default" : "default",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                            <div style={{ fontSize: t.fs.md, fontWeight: 700, textDecoration: tk.status === "done" ? "line-through" : "none", color: tk.status === "done" ? t.textMuted : t.text, minWidth: 0, flex: 1 }}>
                              {tk.title}
                            </div>
                            <span style={{
                              padding: "2px 8px", borderRadius: 8, fontSize: t.fs.xs, fontWeight: 700,
                              background: prio.color + "22", color: prio.color,
                              textTransform: "uppercase", flexShrink: 0,
                            }}>{prio.label}</span>
                          </div>
                          {tk.description && (
                            <p style={{ margin: "0 0 8px", fontSize: t.fs.sm, color: t.textMuted }}>{tk.description}</p>
                          )}
                          <div style={{ display: "flex", gap: 8, fontSize: t.fs.sm, color: t.textMuted, flexWrap: "wrap", marginBottom: 8 }}>
                            {tk.deadline && (
                              <span style={{ color: overdue ? t.danger : t.textMuted, fontWeight: overdue ? 700 : 500 }}>
                                📅 {tk.deadline}{overdue ? " ⚠️" : ""}
                              </span>
                            )}
                            {assignedName && <span style={{ color: t.primary }}>👤 {assignedName}</span>}
                          </div>

                          {/* Status cycle buttons — one-tap to advance status */}
                          {canEditTask(tk) && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {TASK_STATUSES.map(st => {
                                const active = (tk.status || "todo") === st.id;
                                return (
                                  <button
                                    key={st.id}
                                    onClick={() => setTaskStatus(tk.id, st.id)}
                                    style={{
                                      flex: 1,
                                      padding: isMobile ? "8px 4px" : "4px 6px",
                                      fontSize: t.fs.xs,
                                      background: active ? st.color : "transparent",
                                      color: active ? "#fff" : st.color,
                                      border: "1px solid " + st.color,
                                      borderRadius: 6,
                                      cursor: "pointer",
                                      fontWeight: active ? 700 : 500,
                                      minHeight: isMobile ? 32 : 22,
                                      whiteSpace: "nowrap",
                                    }}
                                  >{st.icon} {isMobile ? st.label : st.label.split(" ")[0]}</button>
                                );
                              })}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
                            {canEditTask(tk) && <button onClick={() => setEditTask({ ...tk })} style={{ ...t.btnGhost, padding: "4px 10px", fontSize: t.fs.xs }}>✎</button>}
                            {isAdmin && <button onClick={() => deleteTask(tk.id)} style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.xs }}>🗑</button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {visibleTasks.length === 0 && (
              <div style={{ ...t.card, textAlign: "center", padding: 30, color: t.textMuted, marginTop: 12 }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>📝</div>
                <p style={{ margin: 0 }}>No tasks yet. Click "+ New Task" to create one.</p>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             📦 STOCK TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "stock" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>📦 Stock / Accounts</h2>
              <button
                onClick={() => {
                  setStockNewRow({ product: svcNames[0] || "", email: "", password: "", link: "", note: "" });
                  setStockShowAdd(s => !s);
                }}
                style={t.btnPrimary}
              >+ Add Account</button>
            </div>

            {/* Summary cards */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(140px, 1fr))",
              gap: t.sp.sm,
              marginBottom: 14,
            }}>
              <div style={{ ...t.card, borderTop: "3px solid " + t.primary }}>
                <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>Available</div>
                <div style={{ fontSize: t.fs.xxl, fontWeight: 900, color: t.primary }}>{stockTotalAvail}</div>
              </div>
              <div style={{ ...t.card, borderTop: "3px solid " + t.danger }}>
                <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>Sold</div>
                <div style={{ fontSize: t.fs.xxl, fontWeight: 900, color: t.danger }}>{stockTotalSold}</div>
              </div>
              {svcNames.filter(p => (stockStatsByProduct[p]?.total || 0) > 0).map(p => {
                const st = stockStatsByProduct[p];
                const active = stockFilterProd === p;
                return (
                  <div
                    key={p}
                    onClick={() => setStockFilterProd(fp => fp === p ? "all" : p)}
                    style={{
                      ...t.card,
                      background: active ? (t.dark ? "rgba(42,157,143,0.15)" : "#e8f4f2") : t.cardBg,
                      border: active ? "2px solid " + t.primary : "1px solid " + t.border,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {svcIcon(p)} {p}
                    </div>
                    <div style={{ fontSize: t.fs.xl, fontWeight: 900, color: active ? t.primary : (st.avail === 0 ? t.danger : t.success) }}>{st.avail}</div>
                    <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>{st.sold} sold · {st.total} total</div>
                  </div>
                );
              })}
            </div>

            {/* New account form */}
            {stockShowAdd && (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Account</h3>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Product</label>
                    <select value={stockNewRow.product} onChange={e => setStockNewRow(p => ({ ...p, product: e.target.value }))} style={t.input}>
                      {svcNames.map(p => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={t.label}>Email *</label>
                    <input value={stockNewRow.email} onChange={e => setStockNewRow(p => ({ ...p, email: e.target.value }))} style={t.input} />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Password</label>
                    <input value={stockNewRow.password} onChange={e => setStockNewRow(p => ({ ...p, password: e.target.value }))} style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Link</label>
                    <input value={stockNewRow.link} onChange={e => setStockNewRow(p => ({ ...p, link: e.target.value }))} style={t.input} placeholder="https://..." />
                  </div>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={t.label}>Note</label>
                  <input value={stockNewRow.note} onChange={e => setStockNewRow(p => ({ ...p, note: e.target.value }))} style={t.input} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setStockShowAdd(false)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addStockRow} style={{ ...t.btnPrimary, flex: 1 }}>💾 Add</button>
                </div>
              </div>
            )}

            {/* Search + view filter */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
              <input
                placeholder="🔍 Search email, product, note..."
                value={stockSearch}
                onChange={e => setStockSearch(e.target.value)}
                style={{ ...t.input, flex: 1, minWidth: 200 }}
              />
              {["all", "available", "sold"].map(v => (
                <button
                  key={v}
                  onClick={() => setStockView(v)}
                  style={{
                    ...t.btnGhost,
                    padding: isMobile ? "8px 14px" : "6px 12px",
                    fontSize: t.fs.sm,
                    background: stockView === v ? t.primary : "transparent",
                    color: stockView === v ? "#fff" : t.primary,
                    textTransform: "capitalize",
                  }}
                >{v}</button>
              ))}
            </div>

            {/* ═══ MOBILE: CARD VIEW (grouped by product) ═══ */}
            {isMobile && (
              <div>
                {stockFiltered.length === 0 ? (
                  <div style={{ ...t.card, textAlign: "center", padding: 30, color: t.textMuted }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>📦</div>
                    <p style={{ margin: 0 }}>No accounts match your filters.</p>
                  </div>
                ) : svcNames.map(prod => {
                  const prodRows = stockFiltered.filter(r => r.product === prod);
                  if (!prodRows.length) return null;
                  const prodAvail = prodRows.filter(r => !r.sold).length;
                  const prodSold = prodRows.filter(r => r.sold).length;
                  return (
                    <div key={prod} style={{ marginBottom: 16 }}>
                      {/* Product group header */}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "10px 4px 8px",
                        borderBottom: "2px solid " + t.primary,
                        marginBottom: 8,
                      }}>
                        <span style={{ fontSize: 22 }}>{svcIcon(prod)}</span>
                        <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 800, flex: 1 }}>{prod}</h3>
                        <span style={{
                          fontSize: t.fs.xs, fontWeight: 700,
                          background: t.success, color: "#fff",
                          padding: "3px 8px", borderRadius: 10,
                        }}>{prodAvail} avail</span>
                        {prodSold > 0 && (
                          <span style={{
                            fontSize: t.fs.xs, fontWeight: 700,
                            background: t.danger, color: "#fff",
                            padding: "3px 8px", borderRadius: 10,
                          }}>{prodSold} sold</span>
                        )}
                      </div>
                      {prodRows.map(row => {
                  const isEdit = stockEditId === row.id;
                  if (isEdit) {
                    return (
                      <div key={row.id} style={{ ...t.card, marginBottom: 10, border: "2px solid " + t.primary }}>
                        <div style={{ marginBottom: 8 }}>
                          <label style={t.label}>Product</label>
                          <select value={stockEditRow.product} onChange={e => setStockEditRow(p => ({ ...p, product: e.target.value }))} style={t.input}>
                            {svcNames.map(p => <option key={p}>{p}</option>)}
                          </select>
                        </div>
                        <div style={{ marginBottom: 8 }}>
                          <label style={t.label}>Email</label>
                          <input value={stockEditRow.email} onChange={e => setStockEditRow(p => ({ ...p, email: e.target.value }))} style={t.input} />
                        </div>
                        <div style={{ marginBottom: 8 }}>
                          <label style={t.label}>Password</label>
                          <input value={stockEditRow.password || ""} onChange={e => setStockEditRow(p => ({ ...p, password: e.target.value }))} style={t.input} />
                        </div>
                        <div style={{ marginBottom: 8 }}>
                          <label style={t.label}>Link</label>
                          <input value={stockEditRow.link || ""} onChange={e => setStockEditRow(p => ({ ...p, link: e.target.value }))} style={t.input} />
                        </div>
                        <div style={{ marginBottom: 8 }}>
                          <label style={t.label}>Note</label>
                          <input value={stockEditRow.note || ""} onChange={e => setStockEditRow(p => ({ ...p, note: e.target.value }))} style={t.input} />
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => { setStockEditId(null); setStockEditRow(null); }} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                          <button onClick={saveStockEdit} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save</button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={row.id}
                      style={{
                        ...t.card,
                        marginBottom: 10,
                        borderLeft: "4px solid " + (row.sold ? t.danger : t.success),
                        opacity: row.sold ? 0.75 : 1,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: t.fs.md, fontWeight: 700 }}>{svcIcon(row.product)} {row.product}</div>
                        </div>
                        <span style={{
                          padding: "4px 10px", borderRadius: 20, fontSize: t.fs.sm, fontWeight: 700,
                          background: row.sold ? "#fef2f2" : "#e8f4f2",
                          color: row.sold ? t.danger : t.primary,
                        }}>{row.sold ? "Sold" : "Available"}</span>
                      </div>
                      <div style={{ fontSize: t.fs.base, marginBottom: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <strong>📧</strong> <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.email}</span>
                        <CopyBtn text={row.email} label="email" theme={t} />
                      </div>
                      {row.password && (
                        <div style={{ fontSize: t.fs.base, marginBottom: 6, display: "flex", gap: 6, alignItems: "center" }}>
                          <strong>🔑</strong> <PassCell val={row.password} theme={t} />
                        </div>
                      )}
                      {row.link && (
                        <div style={{ fontSize: t.fs.sm, marginBottom: 6 }}>
                          <a href={row.link} target="_blank" rel="noreferrer" style={{ color: t.primary }}>🔗 Open Link</a>
                        </div>
                      )}
                      {row.note && (
                        <div style={{ fontSize: t.fs.sm, color: t.textMuted, marginBottom: 8, fontStyle: "italic" }}>💬 {row.note}</div>
                      )}
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          onClick={() => toggleStockSold(row.id)}
                          style={{
                            ...t.btnGhost,
                            flex: 1,
                            fontSize: t.fs.sm,
                            background: row.sold ? "transparent" : t.primary,
                            color: row.sold ? t.primary : "#fff",
                          }}
                        >{row.sold ? "↩ Mark Available" : "✓ Mark Sold"}</button>
                        <button onClick={() => { setStockEditId(row.id); setStockEditRow({ ...row }); }} style={{ ...t.btnGhost, padding: "8px 14px", fontSize: t.fs.sm }}>✎</button>
                        <button onClick={() => deleteStockRow(row.id)} style={{ ...t.btnDanger, padding: "8px 14px", fontSize: t.fs.sm }}>🗑</button>
                      </div>
                    </div>
                  );
                })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ═══ DESKTOP: TABLE VIEW ═══ */}
            {!isMobile && (
              <div style={{ ...t.card, padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                    <thead>
                      <tr style={{ background: t.cardBg2, borderBottom: "2px solid " + t.border }}>
                        {["", "Product", "Email", "Password", "Link", "Note", "Status", ""].map((h, i) => (
                          <th key={i} style={{ padding: "10px 12px", textAlign: "left", fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stockFiltered.length === 0 && (
                        <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", color: t.textMuted }}>No accounts to show.</td></tr>
                      )}
                      {stockFiltered.map(row => {
                        const isEdit = stockEditId === row.id;
                        return (
                          <tr key={row.id} style={{ borderBottom: "1px solid " + t.border, opacity: row.sold ? 0.6 : 1 }}>
                            <td style={{ padding: "10px 12px" }}>
                              <input type="checkbox" checked={row.sold} onChange={() => toggleStockSold(row.id)} style={{ width: 18, height: 18, accentColor: t.primary }} />
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              {isEdit ? (
                                <select value={stockEditRow.product} onChange={e => setStockEditRow(p => ({ ...p, product: e.target.value }))} style={t.input}>{svcNames.map(p => <option key={p}>{p}</option>)}</select>
                              ) : <span style={{ fontSize: t.fs.base, fontWeight: 700 }}>{svcIcon(row.product)} {row.product}</span>}
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              {isEdit ? (
                                <input value={stockEditRow.email} onChange={e => setStockEditRow(p => ({ ...p, email: e.target.value }))} style={t.input} />
                              ) : <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: t.fs.sm }}>{row.email}</span><CopyBtn text={row.email} label="email" theme={t} /></div>}
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              {isEdit ? (
                                <input value={stockEditRow.password || ""} onChange={e => setStockEditRow(p => ({ ...p, password: e.target.value }))} style={t.input} />
                              ) : (row.password ? <PassCell val={row.password} theme={t} /> : "—")}
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              {isEdit ? (
                                <input value={stockEditRow.link || ""} onChange={e => setStockEditRow(p => ({ ...p, link: e.target.value }))} style={t.input} />
                              ) : (row.link ? <a href={row.link} target="_blank" rel="noreferrer" style={{ fontSize: t.fs.sm, color: t.primary }}>Open</a> : "—")}
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              {isEdit ? (
                                <input value={stockEditRow.note || ""} onChange={e => setStockEditRow(p => ({ ...p, note: e.target.value }))} style={t.input} />
                              ) : <span style={{ fontSize: t.fs.sm, color: t.textMuted }}>{row.note || "—"}</span>}
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <span style={{
                                padding: "2px 10px", borderRadius: 20, fontSize: t.fs.xs, fontWeight: 700,
                                background: row.sold ? "#fef2f2" : "#e8f4f2",
                                color: row.sold ? t.danger : t.primary,
                              }}>{row.sold ? "Sold" : "Available"}</span>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <div style={{ display: "flex", gap: 4 }}>
                                {isEdit ? (
                                  <>
                                    <button onClick={saveStockEdit} style={{ ...t.btnPrimary, padding: "4px 10px", minHeight: 28 }}>Save</button>
                                    <button onClick={() => { setStockEditId(null); setStockEditRow(null); }} style={{ ...t.btnGhost, padding: "4px 10px", minHeight: 28 }}>✕</button>
                                  </>
                                ) : (
                                  <>
                                    <button onClick={() => { setStockEditId(row.id); setStockEditRow({ ...row }); }} style={{ ...t.btnGhost, padding: "4px 10px", minHeight: 28 }}>✎</button>
                                    <button onClick={() => deleteStockRow(row.id)} style={{ ...t.btnDanger, padding: "4px 10px", minHeight: 28 }}>✕</button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             🎨 ADOBE MONTHLY RENEWALS
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "adobe" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>🎨 Adobe Monthly Renewals</h2>
              <ExportMenu
                theme={t}
                onCsv={() => exportCSV(adobeSchedule.map(a => ({
                  Customer: a.customer, Phone: a.customerPhone || "",
                  Email: a.customerEmail || "",
                  Month: a.monthIndex + "/" + a.totalMonths,
                  "Renew Date": a.renewDate, Days: a.daysUntil,
                  Status: a.status, Price: a.price + " " + a.currency,
                })), "adobe_" + todayStr() + ".csv")}
                onXlsx={() => exportExcel(adobeSchedule.map(a => ({
                  Customer: a.customer, Phone: a.customerPhone || "",
                  Email: a.customerEmail || "",
                  Month: a.monthIndex + "/" + a.totalMonths,
                  RenewDate: a.renewDate, Days: a.daysUntil,
                  Status: a.status, Price: a.price, Currency: a.currency,
                })), "adobe_" + todayStr() + ".xls", "Adobe")}
                onPdf={() => exportPDF("Adobe Renewal Schedule", adobeSchedule.map(a => ({
                  Customer: a.customer, Phone: a.customerPhone || "—",
                  Email: a.customerEmail || "—",
                  Month: a.monthIndex + "/" + a.totalMonths,
                  "Renew Date": a.renewDate, Days: a.daysUntil,
                  Status: a.status, Price: a.price + " " + a.currency,
                })), "adobe_" + todayStr() + ".pdf")}
              />
            </div>

            {/* Summary cards */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)",
              gap: t.sp.sm,
              marginBottom: 14,
            }}>
              {[
                { l: "Overdue", v: adobeOverdue.length, c: t.danger },
                { l: "Due ≤2 days", v: adobePendingReminders.length, c: t.warning },
                { l: "Upcoming", v: adobeUpcoming.length, c: t.primary },
                { l: "Total", v: adobeSchedule.length, c: t.primaryDark },
              ].map((c, i) => (
                <div key={i} style={{ ...t.cardCompact, borderTop: "3px solid " + c.c }}>
                  <div style={{ fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{c.l}</div>
                  <div style={{ fontSize: t.fs.xxl, fontWeight: 900, color: c.c, lineHeight: 1.1 }}>{c.v}</div>
                </div>
              ))}
            </div>

            {adobeSchedule.length === 0 ? (
              <div style={{ ...t.card, padding: 40, textAlign: "center", color: t.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>🎨</div>
                <p style={{ margin: "0 0 6px", fontSize: t.fs.base }}>No Adobe subscriptions yet.</p>
                <p style={{ margin: 0, fontSize: t.fs.sm }}>Sell an "Adobe" service with a period &gt; 0 to see monthly renewals here.</p>
              </div>
            ) : (
              <>
                {/* Adobe search + filter + sort bar */}
                <div style={{ ...t.card, marginBottom: 12, padding: isMobile ? 12 : 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <input
                      placeholder="🔍 Search by customer name, phone, email..."
                      value={adobeSearch}
                      onChange={e => setAdobeSearch(e.target.value)}
                      style={t.input}
                    />
                    <select value={adobeFilter} onChange={e => setAdobeFilter(e.target.value)} style={t.input}>
                      <option value="all">All renewals</option>
                      <option value="overdue">🚨 Overdue only</option>
                      <option value="due">⚠️ Due soon (≤2d)</option>
                      <option value="upcoming">⏰ Upcoming</option>
                      <option value="renewed">✓ Already renewed</option>
                    </select>
                    <select value={adobeSort} onChange={e => setAdobeSort(e.target.value)} style={t.input}>
                      <option value="days">Sort: Days left</option>
                      <option value="name">Sort: Customer name</option>
                      <option value="renewDate">Sort: Renew date</option>
                    </select>
                  </div>
                  <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                    Showing <strong style={{ color: t.primary }}>{adobeFilteredList.length}</strong> of {adobeSchedule.length} renewals
                  </div>
                </div>

                {adobeFilteredList.length === 0 ? (
                  <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>🔍</div>
                    <p style={{ margin: 0 }}>No renewals match your filters.</p>
                  </div>
                ) : isMobile ? (
              /* ═══ MOBILE: CARD VIEW ═══ */
              <div>
                {adobeFilteredList.map(a => {
                  const rowBg = a.status === "Renewed" ? (t.dark ? "#052e16" : "#f0fdf4")
                    : a.isOverdue ? (t.dark ? "#450a0a" : "#fef2f2")
                    : a.needsReminder ? (t.dark ? "#422006" : "#fffbeb")
                    : t.cardBg;
                  const statusColor = a.status === "Renewed" ? t.success
                    : a.isOverdue ? t.danger
                    : a.needsReminder ? t.warning
                    : t.primary;
                  return (
                    <div
                      key={a.alertId}
                      style={{
                        ...t.card,
                        marginBottom: 10,
                        background: rowBg,
                        borderLeft: "4px solid " + statusColor,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: t.fs.md, fontWeight: 700 }}>{a.customer}</div>
                          {a.customerPhone && <div style={{ fontSize: t.fs.sm, color: t.primary }}>📞 {a.customerPhone}</div>}
                          {a.customerEmail && <div style={{ fontSize: t.fs.sm, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✉️ {a.customerEmail}</div>}
                        </div>
                        <span style={{
                          padding: "4px 10px", borderRadius: 20, fontSize: t.fs.sm, fontWeight: 700,
                          background: statusColor + "22", color: statusColor,
                        }}>{a.status}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                        <div style={{ fontSize: t.fs.base, fontWeight: 700 }}>
                          Month <span style={{ color: t.primary }}>{a.monthIndex}</span>/{a.totalMonths}
                        </div>
                        <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                          📅 {a.renewDate}
                        </div>
                        <div style={{ fontSize: t.fs.md, fontWeight: 800, color: a.daysUntil <= 0 ? t.danger : a.daysUntil <= 7 ? t.warning : t.success }}>
                          {a.daysUntil}d
                        </div>
                      </div>
                      <div style={{ fontSize: t.fs.base, fontWeight: 700, color: t.success, marginBottom: 8 }}>
                        💰 {a.price} {a.currency}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {a.status !== "Renewed" ? (
                          <button
                            onClick={() => markAdobeMonthRenewed(a.saleId, a.monthIndex)}
                            style={{ ...t.btnPrimary, background: t.success, flex: 1, fontSize: t.fs.sm }}
                          >✓ Mark Renewed</button>
                        ) : (
                          <button
                            onClick={() => unmarkAdobeMonthRenewed(a.saleId, a.monthIndex)}
                            style={{ ...t.btnGhost, flex: 1, fontSize: t.fs.sm }}
                          >↩ Undo</button>
                        )}
                        {a.customerPhone && (
                          <a
                            href={waLink(a.customerPhone, "Hi " + a.customer + ",\n\nYour *Adobe* subscription month " + a.monthIndex + "/" + a.totalMonths + " renews on " + a.renewDate + " (in " + a.daysUntil + " days).\n\n💰 " + a.price + " " + a.currency + "\n\n_ProSkill Team_")}
                            target="_blank"
                            rel="noreferrer"
                            style={{ ...t.btnWA, flex: 1, fontSize: t.fs.sm, justifyContent: "center" }}
                          >📱 WA</a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* ═══ DESKTOP: TABLE VIEW ═══ */
              <div style={{ ...t.card, padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720, fontSize: t.fs.sm }}>
                    <thead>
                      <tr style={{ background: t.cardBg2, borderBottom: "2px solid " + t.border }}>
                        {["Customer", "Phone", "Email", "Month", "Renew Date", "Days", "Price", "Status", "Actions"].map(h => (
                          <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {adobeFilteredList.map(a => {
                        const rowBg = a.status === "Renewed" ? (t.dark ? "#052e16" : "#f0fdf4")
                          : a.isOverdue ? (t.dark ? "#450a0a" : "#fef2f2")
                          : a.needsReminder ? (t.dark ? "#422006" : "#fffbeb")
                          : "transparent";
                        const statusColor = a.status === "Renewed" ? t.success
                          : a.isOverdue ? t.danger
                          : a.needsReminder ? t.warning
                          : t.primary;
                        return (
                          <tr key={a.alertId} style={{ borderBottom: "1px solid " + t.border, background: rowBg }}>
                            <td style={{ padding: "10px 12px", fontWeight: 600 }}>{a.customer}</td>
                            <td style={{ padding: "10px 12px", color: t.primary }}>{a.customerPhone || "—"}</td>
                            <td style={{ padding: "10px 12px", color: t.textMuted, fontSize: t.fs.xs }}>{a.customerEmail || "—"}</td>
                            <td style={{ padding: "10px 12px" }}><strong>{a.monthIndex}</strong>/{a.totalMonths}</td>
                            <td style={{ padding: "10px 12px" }}>{a.renewDate}</td>
                            <td style={{ padding: "10px 12px", fontWeight: 700, color: a.daysUntil <= 0 ? t.danger : a.daysUntil <= 7 ? t.warning : t.success }}>{a.daysUntil}d</td>
                            <td style={{ padding: "10px 12px", fontWeight: 700, color: t.success }}>{a.price} {a.currency}</td>
                            <td style={{ padding: "10px 12px" }}>
                              <span style={{
                                padding: "2px 10px", borderRadius: 20, fontSize: t.fs.xs, fontWeight: 700,
                                background: statusColor + "22", color: statusColor,
                              }}>{a.status}</span>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {a.status !== "Renewed" ? (
                                  <button onClick={() => markAdobeMonthRenewed(a.saleId, a.monthIndex)} style={{ ...t.btnPrimary, background: t.success, padding: "4px 10px", fontSize: t.fs.xs, minHeight: 28 }}>✓</button>
                                ) : (
                                  <button onClick={() => unmarkAdobeMonthRenewed(a.saleId, a.monthIndex)} style={{ ...t.btnGhost, padding: "4px 10px", fontSize: t.fs.xs, minHeight: 28 }}>↩</button>
                                )}
                                {a.customerPhone && (
                                  <a
                                    href={waLink(a.customerPhone, "Hi " + a.customer + ", your Adobe month " + a.monthIndex + "/" + a.totalMonths + " renews on " + a.renewDate)}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ ...t.btnWA, padding: "4px 10px", fontSize: t.fs.xs, minHeight: 28 }}
                                  >📱</a>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
              </>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             📦 BUNDLES TAB (admin only)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "bundles" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>📦 Service Bundles</h2>
              <button onClick={() => setNewBundle({ name: "", services: [], price: 0, cost: 0, period: 1 })} style={t.btnPrimary}>+ New Bundle</button>
            </div>

            {newBundle && (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Bundle</h3>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                  <div>
                    <label style={t.label}>Bundle Name *</label>
                    <input value={newBundle.name} onChange={e => setNewBundle(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Starter Pack" style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Price (EGP) *</label>
                    <input type="number" value={newBundle.price} onChange={e => setNewBundle(p => ({ ...p, price: +e.target.value }))} style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Cost (EGP)</label>
                    <input type="number" value={newBundle.cost} onChange={e => setNewBundle(p => ({ ...p, cost: +e.target.value }))} style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Period</label>
                    <select value={newBundle.period} onChange={e => setNewBundle(p => ({ ...p, period: +e.target.value }))} style={t.input}>
                      {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABEL(p)}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={t.label}>Services (pick at least 2)</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {svcNames.filter(s => !s.endsWith("(Bundle)")).map(s => {
                      const on = newBundle.services.includes(s);
                      return (
                        <span
                          key={s}
                          onClick={() => setNewBundle(p => ({ ...p, services: on ? p.services.filter(x => x !== s) : [...p.services, s] }))}
                          style={{
                            padding: isMobile ? "8px 14px" : "4px 12px",
                            borderRadius: 20,
                            fontSize: t.fs.sm,
                            cursor: "pointer",
                            background: on ? t.primary : (t.dark ? "#334155" : "#e8ebe9"),
                            color: on ? "#fff" : t.text,
                            fontWeight: 600,
                          }}
                        >{svcIcon(s)} {s}</span>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setNewBundle(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addBundle} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save Bundle</button>
                </div>
              </div>
            )}

            {bundleStats.length === 0 ? (
              <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>📦</div>
                <p style={{ margin: "0 0 6px", fontSize: t.fs.base }}>No bundles yet.</p>
                <p style={{ margin: 0, fontSize: t.fs.sm }}>Create a bundle of 2+ services to upsell and track performance.</p>
              </div>
            ) : (
              <div style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(280px, 1fr))",
                gap: t.sp.md,
              }}>
                {bundleStats.map(b => (
                  <div key={b.id} style={t.card}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <h4 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700 }}>📦 {b.name}</h4>
                      <button onClick={() => deleteBundle(b.id)} style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.sm }}>✕</button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
                      {b.services.map(s => (
                        <span
                          key={s}
                          style={{
                            padding: "3px 8px", borderRadius: 6, fontSize: t.fs.xs,
                            background: t.dark ? "#334155" : "#e8f4f2",
                            color: t.dark ? "#e2e8f0" : t.primary,
                          }}
                        >{svcIcon(s)} {s}</span>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
                      <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Price</div>
                        <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.primary }}>{b.price}</div>
                      </div>
                      <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Sold</div>
                        <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.primaryDark }}>{b.sold}</div>
                      </div>
                      <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Revenue</div>
                        <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.success }}>{b.rev.toLocaleString()}</div>
                      </div>
                    </div>
                    <button onClick={() => sellBundle(b)} style={{ ...t.btnPrimary, width: "100%" }}>💰 Sell This Bundle</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             👥 TEAM TAB (admin only)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "team" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>👥 Team ({team.length})</h2>
              <button
                onClick={() => setNewMember({
                  name: "", role: "Sales", phone: "", email: "", password: "",
                  commissionRate: 10, commissionBase: "revenue",
                  permissions: { ...DEFAULT_MEMBER_PERMS },
                  actions: { ...DEFAULT_MEMBER_ACTIONS },
                  notes: "",
                })}
                style={t.btnPrimary}
              >+ Add Member</button>
            </div>

            {/* New member form */}
            {newMember && (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Team Member</h3>

                {/* Basic info */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Name *</label>
                    <input value={newMember.name} onChange={e => setNewMember(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Ahmed Ali" style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Role</label>
                    <input value={newMember.role} onChange={e => setNewMember(p => ({ ...p, role: e.target.value }))} placeholder="Sales / Support" style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Phone</label>
                    <input value={newMember.phone} onChange={e => setNewMember(p => ({ ...p, phone: e.target.value }))} placeholder="201..." style={t.input} />
                  </div>
                </div>

                {/* Login credentials — highlighted */}
                <div style={{
                  background: t.dark ? "#0f172a" : "#e8f4f2",
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 12,
                  borderLeft: "3px solid " + t.primary,
                }}>
                  <div style={{ fontSize: t.fs.sm, fontWeight: 700, color: t.primary, marginBottom: 8 }}>
                    🔐 LOGIN CREDENTIALS (optional — leave blank if this member won't log in)
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={t.label}>Email</label>
                      <input
                        type="email"
                        value={newMember.email}
                        onChange={e => setNewMember(p => ({ ...p, email: e.target.value }))}
                        placeholder="member@example.com"
                        style={t.input}
                      />
                    </div>
                    <div>
                      <label style={t.label}>Password (min 6 chars)</label>
                      <input
                        type="text"
                        value={newMember.password}
                        onChange={e => setNewMember(p => ({ ...p, password: e.target.value }))}
                        placeholder="Share this with them"
                        style={t.input}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                    💡 When you save, we'll create their Supabase login account automatically. Share the email + password with them via WhatsApp so they can sign in.
                  </div>
                </div>

                {/* Commission settings */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
                  <div>
                    <label style={t.label}>Commission Base</label>
                    <select value={newMember.commissionBase} onChange={e => setNewMember(p => ({ ...p, commissionBase: e.target.value }))} style={t.input}>
                      <option value="revenue">% of Revenue</option>
                      <option value="profit">% of Profit</option>
                      <option value="fixed">Fixed EGP per Sale</option>
                    </select>
                  </div>
                  <div>
                    <label style={t.label}>Rate {newMember.commissionBase === "fixed" ? "(EGP per sale)" : "(%)"}</label>
                    <input type="number" value={newMember.commissionRate} onChange={e => setNewMember(p => ({ ...p, commissionRate: +e.target.value }))} style={t.input} />
                  </div>
                </div>

                {/* Permissions checkboxes */}
                <div style={{
                  background: t.dark ? "#0f172a" : "#f5f7f9",
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 12,
                }}>
                  <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 4 }}>
                    🔒 TAB ACCESS
                  </div>
                  <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginBottom: 10 }}>
                    Which sections this member will see in the sidebar
                  </div>
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                    gap: 8,
                  }}>
                    {MEMBER_TABS.map(mt => {
                      const on = (newMember.permissions || {})[mt.id] !== false;
                      return (
                        <label
                          key={mt.id}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: isMobile ? "10px 12px" : "6px 10px",
                            background: on ? (t.dark ? "#052e16" : "#f0fdf4") : (t.dark ? "#1e293b" : "#fff"),
                            borderRadius: 8,
                            cursor: "pointer",
                            border: "1px solid " + (on ? t.success : t.border),
                            minHeight: 40,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setNewMember(p => ({
                              ...p,
                              permissions: { ...(p.permissions || {}), [mt.id]: !on }
                            }))}
                            style={{ width: 18, height: 18, accentColor: t.primary, flexShrink: 0 }}
                          />
                          <span style={{ fontSize: t.fs.sm }}>{mt.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* NEW: Action-level permissions */}
                <div style={{
                  background: t.dark ? "#0f172a" : "#fffbeb",
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 12,
                  borderLeft: "3px solid " + t.warning,
                }}>
                  <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 4 }}>
                    ⚙️ ACTION PERMISSIONS
                  </div>
                  <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginBottom: 10 }}>
                    What this member can do. Unchecked = view/edit only their own data.
                  </div>
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                    gap: 8,
                  }}>
                    {PERM_ACTIONS.map(act => {
                      const actions = newMember.actions || { ...DEFAULT_MEMBER_ACTIONS };
                      const on = actions[act.id] === true;
                      return (
                        <label
                          key={act.id}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: isMobile ? "10px 12px" : "6px 10px",
                            background: on ? (t.dark ? "#052e16" : "#f0fdf4") : (t.dark ? "#1e293b" : "#fff"),
                            borderRadius: 8,
                            cursor: "pointer",
                            border: "1px solid " + (on ? t.success : t.border),
                            minHeight: 40,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setNewMember(p => ({
                              ...p,
                              actions: { ...(p.actions || { ...DEFAULT_MEMBER_ACTIONS }), [act.id]: !on }
                            }))}
                            style={{ width: 18, height: 18, accentColor: t.primary, flexShrink: 0 }}
                          />
                          <span style={{ fontSize: t.fs.sm }}>{act.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label style={t.label}>Notes</label>
                  <input value={newMember.notes} onChange={e => setNewMember(p => ({ ...p, notes: e.target.value }))} style={t.input} />
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setNewMember(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addMember} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save Member</button>
                </div>
              </div>
            )}

            {/* Edit member modal */}
            {editMember && (
              <div
                onClick={() => setEditMember(null)}
                style={{
                  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  zIndex: 999, padding: isMobile ? 0 : 20,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    ...t.card,
                    width: isMobile ? "100%" : 500,
                    maxWidth: "100%",
                    height: isMobile ? "100vh" : "auto",
                    maxHeight: isMobile ? "100vh" : "92vh",
                    overflow: "auto",
                    borderRadius: isMobile ? 0 : 14,
                    padding: isMobile ? 20 : 24,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                    {isMobile && (
                      <button onClick={() => setEditMember(null)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                    )}
                    <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>✏️ Edit {editMember.name}</h3>
                    {!isMobile && (
                      <span onClick={() => setEditMember(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                    )}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr", gap: 10, marginBottom: 10 }}>
                    <div>
                      <label style={t.label}>Name *</label>
                      <input value={editMember.name} onChange={e => setEditMember(p => ({ ...p, name: e.target.value }))} style={t.input} />
                    </div>
                    <div>
                      <label style={t.label}>Role</label>
                      <input value={editMember.role || ""} onChange={e => setEditMember(p => ({ ...p, role: e.target.value }))} style={t.input} />
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <div>
                      <label style={t.label}>Phone</label>
                      <input value={editMember.phone || ""} onChange={e => setEditMember(p => ({ ...p, phone: e.target.value }))} style={t.input} />
                    </div>
                    <div>
                      <label style={t.label}>Email (login)</label>
                      <input type="email" value={editMember.email || ""} onChange={e => setEditMember(p => ({ ...p, email: e.target.value }))} style={t.input} />
                    </div>
                  </div>
                  <div style={{ background: t.dark ? "#422006" : "#fffbeb", padding: 10, borderRadius: 8, fontSize: t.fs.xs, color: "#b45309", marginBottom: 12 }}>
                    💡 Email & password changes don't update their Supabase login automatically. If they need a new password, ask them to use "forgot password" on the login screen, or create a new member entry.
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div>
                      <label style={t.label}>Commission Base</label>
                      <select value={editMember.commissionBase || "revenue"} onChange={e => setEditMember(p => ({ ...p, commissionBase: e.target.value }))} style={t.input}>
                        <option value="revenue">% of Revenue</option>
                        <option value="profit">% of Profit</option>
                        <option value="fixed">Fixed EGP per Sale</option>
                      </select>
                    </div>
                    <div>
                      <label style={t.label}>Rate {editMember.commissionBase === "fixed" ? "(EGP)" : "(%)"}</label>
                      <input type="number" value={editMember.commissionRate || 0} onChange={e => setEditMember(p => ({ ...p, commissionRate: +e.target.value }))} style={t.input} />
                    </div>
                  </div>

                  {/* Permissions */}
                  <div style={{ background: t.dark ? "#0f172a" : "#f5f7f9", borderRadius: 10, padding: 14, marginBottom: 12 }}>
                    <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 10 }}>🔒 Tab Access</div>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
                      {MEMBER_TABS.map(mt => {
                        const perms = editMember.permissions || { ...DEFAULT_MEMBER_PERMS };
                        const on = perms[mt.id] !== false;
                        return (
                          <label
                            key={mt.id}
                            style={{
                              display: "flex", alignItems: "center", gap: 10,
                              padding: isMobile ? "10px 12px" : "6px 10px",
                              background: on ? (t.dark ? "#052e16" : "#f0fdf4") : (t.dark ? "#1e293b" : "#fff"),
                              borderRadius: 8,
                              cursor: "pointer",
                              border: "1px solid " + (on ? t.success : t.border),
                              minHeight: 40,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setEditMember(p => ({
                                ...p,
                                permissions: { ...(p.permissions || { ...DEFAULT_MEMBER_PERMS }), [mt.id]: !on }
                              }))}
                              style={{ width: 18, height: 18, accentColor: t.primary, flexShrink: 0 }}
                            />
                            <span style={{ fontSize: t.fs.sm }}>{mt.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Action permissions */}
                  <div style={{ background: t.dark ? "#0f172a" : "#fffbeb", borderRadius: 10, padding: 14, marginBottom: 12, borderLeft: "3px solid " + t.warning }}>
                    <div style={{ fontSize: t.fs.sm, fontWeight: 700, marginBottom: 4 }}>⚙️ Action Permissions</div>
                    <div style={{ fontSize: t.fs.xs, color: t.textMuted, marginBottom: 10 }}>
                      Check to let this member see/edit everyone's data (not just their own)
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
                      {PERM_ACTIONS.map(act => {
                        const actions = editMember.actions || { ...DEFAULT_MEMBER_ACTIONS };
                        const on = actions[act.id] === true;
                        return (
                          <label
                            key={act.id}
                            style={{
                              display: "flex", alignItems: "center", gap: 10,
                              padding: isMobile ? "10px 12px" : "6px 10px",
                              background: on ? (t.dark ? "#052e16" : "#f0fdf4") : (t.dark ? "#1e293b" : "#fff"),
                              borderRadius: 8,
                              cursor: "pointer",
                              border: "1px solid " + (on ? t.success : t.border),
                              minHeight: 40,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setEditMember(p => ({
                                ...p,
                                actions: { ...(p.actions || { ...DEFAULT_MEMBER_ACTIONS }), [act.id]: !on }
                              }))}
                              style={{ width: 18, height: 18, accentColor: t.primary, flexShrink: 0 }}
                            />
                            <span style={{ fontSize: t.fs.sm }}>{act.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={t.label}>Notes</label>
                    <input value={editMember.notes || ""} onChange={e => setEditMember(p => ({ ...p, notes: e.target.value }))} style={t.input} />
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setEditMember(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                    <button onClick={saveMember} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save Changes</button>
                  </div>
                </div>
              </div>
            )}

            {/* Team members grid */}
            {team.length === 0 ? (
              <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>👥</div>
                <p style={{ margin: "0 0 6px", fontSize: t.fs.base }}>No team members yet.</p>
                <p style={{ margin: 0, fontSize: t.fs.sm }}>Add sales reps who will be credited for closed sales and see the app from their phones.</p>
              </div>
            ) : (
              <div style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(300px, 1fr))",
                gap: t.sp.md,
              }}>
                {team.map(m => {
                  const myMonthSales = sales.filter(a => a.done && a.assignedTo === m.id && a.soldDate >= getMonthRange(new Date()).s);
                  const myMonthRev = myMonthSales.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
                  const rate = m.commissionRate || 0;
                  const base = m.commissionBase || "revenue";
                  const baseLabel = base === "revenue" ? "% of Revenue" : base === "profit" ? "% of Profit" : "EGP per Sale";
                  const permsActive = m.permissions ? Object.values(m.permissions).filter(v => v).length : MEMBER_TABS.length;
                  const hasLogin = !!m.email;
                  return (
                    <div key={m.id} style={t.card}>
                      {/* Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <h4 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                            👤 {m.name}
                            {hasLogin && <span title="Has login access" style={{ fontSize: 14 }}>🔐</span>}
                          </h4>
                          <p style={{ margin: "2px 0 0", fontSize: t.fs.sm, color: t.primary, fontWeight: 600 }}>{m.role || "Member"}</p>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => setEditMember({ ...m })} style={{ ...t.btnGhost, padding: "4px 10px", fontSize: t.fs.sm }}>✎</button>
                          <button onClick={() => deleteMember(m.id)} style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.sm }}>✕</button>
                        </div>
                      </div>

                      {/* Contact */}
                      <div style={{ fontSize: t.fs.sm, color: t.textMuted, marginBottom: 10, lineHeight: 1.6 }}>
                        {m.phone && (
                          <div>
                            📞 {m.phone}
                            {m.phone && <a href={waLink(m.phone, "Hi " + m.name)} target="_blank" rel="noreferrer" style={{ color: "#25D366", marginLeft: 8, fontWeight: 600 }}>WA</a>}
                          </div>
                        )}
                        {m.email && <div>✉️ {m.email}</div>}
                        {m.notes && <div style={{ fontStyle: "italic", marginTop: 4 }}>💬 {m.notes}</div>}
                      </div>

                      {/* Stats */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                        <div style={{ background: t.dark ? "#0f172a" : "#e8f4f2", padding: 8, borderRadius: 8, textAlign: "center" }}>
                          <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Rate</div>
                          <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.primary }}>{rate}{base === "fixed" ? "" : "%"}</div>
                          <div style={{ fontSize: 8, color: t.textMuted, marginTop: 1 }}>{baseLabel}</div>
                        </div>
                        <div style={{ background: t.dark ? "#0f172a" : "#f0fdf4", padding: 8, borderRadius: 8, textAlign: "center" }}>
                          <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>This Month</div>
                          <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.success }}>{myMonthSales.length}</div>
                          <div style={{ fontSize: 8, color: t.textMuted, marginTop: 1 }}>sales</div>
                        </div>
                        <div style={{ background: t.dark ? "#0f172a" : "#fffbeb", padding: 8, borderRadius: 8, textAlign: "center" }}>
                          <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Revenue</div>
                          <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.warning }}>{myMonthRev.toLocaleString()}</div>
                          <div style={{ fontSize: 8, color: t.textMuted, marginTop: 1 }}>EGP</div>
                        </div>
                      </div>

                      {/* Login info pill */}
                      {hasLogin && (
                        <div style={{
                          padding: "6px 10px",
                          background: t.dark ? "#052e16" : "#f0fdf4",
                          borderRadius: 8,
                          fontSize: t.fs.xs,
                          color: t.success,
                          marginBottom: 8,
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                        }}>
                          <span>🔐 Can log in · {permsActive} / {MEMBER_TABS.length} tabs allowed</span>
                          {m.phone && (
                            <a
                              href={waLink(m.phone, "Hi " + m.name + "!\n\n🎉 Your ProSkill account is ready.\n\n🔗 Login: https://proskill-agency.vercel.app\n📧 Email: " + m.email + "\n🔑 Ask me for your password\n\nLooking forward to working with you!")}
                              target="_blank"
                              rel="noreferrer"
                              style={{ ...t.btnWA, padding: "3px 10px", fontSize: t.fs.xs }}
                            >📱 Send Invite</a>
                          )}
                        </div>
                      )}
                      {!hasLogin && (
                        <div style={{ padding: "6px 10px", background: t.dark ? "#1e293b" : "#f5f7f9", borderRadius: 8, fontSize: t.fs.xs, color: t.textMuted }}>
                          ℹ️ No login — admin-managed only
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             💰 COMMISSION TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "commission" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>
                💰 {isAdmin ? "Commission Report" : "My Earnings"}
              </h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select value={commissionPeriod} onChange={e => setCommissionPeriod(e.target.value)} style={{ ...t.input, minWidth: 160, width: "auto" }}>
                  <option value="thisMonth">📅 This Month</option>
                  <option value="lastMonth">📆 Last Month</option>
                  <option value="thisYear">🗓 This Year</option>
                  <option value="allTime">♾ All Time</option>
                </select>
                {isAdmin && (
                  <ExportMenu
                    theme={t}
                    onCsv={() => exportCSV(commissionReport.map(m => ({
                      Name: m.name, Role: m.role || "",
                      "Sales Count": m.salesCount,
                      "Revenue (EGP)": m.revenue,
                      "Profit (EGP)": m.profit,
                      "Rate": (m.commissionRate || 0) + (m.commissionBase === "fixed" ? " EGP/sale" : "%"),
                      "Base": m.commissionBase || "revenue",
                      "Commission (EGP)": m.commission,
                    })), "commission_" + commissionPeriod + "_" + todayStr() + ".csv")}
                    onXlsx={() => exportExcel(commissionReport.map(m => ({
                      Name: m.name, Role: m.role || "",
                      SalesCount: m.salesCount, Revenue: m.revenue, Profit: m.profit,
                      Rate: m.commissionRate || 0, Base: m.commissionBase || "revenue",
                      Commission: m.commission,
                    })), "commission_" + commissionPeriod + "_" + todayStr() + ".xls", "Commissions")}
                    onPdf={() => exportPDF("Commission Report — " + commissionPeriod, commissionReport.map(m => ({
                      Name: m.name, Role: m.role || "—",
                      Sales: m.salesCount,
                      Revenue: m.revenue.toLocaleString() + " EGP",
                      Profit: m.profit.toLocaleString() + " EGP",
                      Rate: (m.commissionRate || 0) + (m.commissionBase === "fixed" ? " EGP" : "%"),
                      Commission: m.commission.toLocaleString() + " EGP",
                    })), "commission_" + commissionPeriod + "_" + todayStr() + ".pdf")}
                  />
                )}
              </div>
            </div>

            {team.length === 0 ? (
              <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>👥</div>
                <p style={{ margin: "0 0 6px", fontSize: t.fs.base }}>No team members yet.</p>
                <p style={{ margin: 0, fontSize: t.fs.sm }}>Go to 👥 Team tab to add sales reps, then assign sales to track commissions.</p>
              </div>
            ) : commissionReport.length === 0 ? (
              <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted }}>
                <p style={{ margin: 0, fontSize: t.fs.base }}>No sales in this period yet.</p>
              </div>
            ) : (
              <>
                {/* Summary cards (admin only — members see their own row directly) */}
                {isAdmin && (
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(160px, 1fr))",
                    gap: t.sp.md,
                    marginBottom: 14,
                  }}>
                    {[
                      { l: "Team Size", v: team.length, c: t.primary },
                      { l: "Sales Closed", v: commissionReport.reduce((s, m) => s + m.salesCount, 0), c: t.primaryDark },
                      { l: "Total Revenue", v: commissionReport.reduce((s, m) => s + m.revenue, 0).toLocaleString() + " EGP", c: t.success },
                      { l: "Commissions Due", v: totalCommissions.toLocaleString() + " EGP", c: t.danger },
                    ].map((c, i) => (
                      <div key={i} style={{ ...t.card, borderTop: "3px solid " + c.c }}>
                        <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{c.l}</p>
                        <p style={{ margin: "6px 0 0", fontSize: t.fs.xl, fontWeight: 900, color: c.c, lineHeight: 1.1 }}>{c.v}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* ═══ MOBILE: CARD VIEW ═══ */}
                {isMobile ? (
                  <div>
                    {commissionReport.map(m => (
                      <div key={m.id} style={{ ...t.card, marginBottom: 12, borderLeft: "4px solid " + t.primary }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: t.fs.md, fontWeight: 700 }}>👤 {m.name}</div>
                            {m.role && <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>{m.role}</div>}
                          </div>
                          <div style={{ fontSize: t.fs.xs, color: t.textMuted, textAlign: "right" }}>
                            {m.commissionRate || 0}{m.commissionBase === "fixed" ? " EGP" : "%"}<br/>
                            {m.commissionBase || "revenue"}
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
                          <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                            <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Sales</div>
                            <div style={{ fontSize: t.fs.md, fontWeight: 800, color: t.primary }}>{m.salesCount}</div>
                          </div>
                          <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                            <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Revenue</div>
                            <div style={{ fontSize: t.fs.sm, fontWeight: 800, color: t.success }}>{m.revenue.toLocaleString()}</div>
                          </div>
                          <div style={{ textAlign: "center", padding: 8, background: t.cardBg2, borderRadius: 8 }}>
                            <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>Profit</div>
                            <div style={{ fontSize: t.fs.sm, fontWeight: 800, color: m.profit >= 0 ? t.success : t.danger }}>{m.profit.toLocaleString()}</div>
                          </div>
                        </div>
                        <div style={{
                          padding: 12,
                          background: t.dark ? "#450a0a" : "#fef2f2",
                          borderRadius: 10,
                          marginBottom: 10,
                          textAlign: "center",
                        }}>
                          <div style={{ fontSize: t.fs.sm, color: t.textMuted, fontWeight: 700 }}>COMMISSION DUE</div>
                          <div style={{ fontSize: t.fs.xxl, fontWeight: 900, color: t.danger, lineHeight: 1.1 }}>{m.commission.toLocaleString()} EGP</div>
                        </div>
                        {isAdmin && m.phone && (
                          <a
                            href={waLink(m.phone, "Hi " + m.name + ",\n\nYour commission report for *" + commissionPeriod + "*:\n\n📊 Sales closed: " + m.salesCount + "\n💰 Revenue: " + m.revenue.toLocaleString() + " EGP\n🎯 Commission due: *" + m.commission.toLocaleString() + " EGP*\n\n_ProSkill Digital Agency_")}
                            target="_blank"
                            rel="noreferrer"
                            style={{ ...t.btnWA, width: "100%", justifyContent: "center" }}
                          >📱 Send Commission via WhatsApp</a>
                        )}
                      </div>
                    ))}
                    {/* Total footer */}
                    {isAdmin && (
                      <div style={{
                        ...t.card,
                        background: "linear-gradient(135deg, #1a2e44, #2a9d8f)",
                        color: "#fff",
                        textAlign: "center",
                      }}>
                        <div style={{ fontSize: t.fs.sm, opacity: 0.85 }}>TOTAL COMMISSIONS DUE</div>
                        <div style={{ fontSize: 32, fontWeight: 900, lineHeight: 1.1 }}>{totalCommissions.toLocaleString()} EGP</div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* ═══ DESKTOP: TABLE VIEW ═══ */
                  <div style={{ ...t.card, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: t.fs.sm, minWidth: 700 }}>
                      <thead>
                        <tr style={{ background: t.cardBg2, borderBottom: "2px solid " + t.border }}>
                          {["Member", "Role", "Sales", "Revenue", "Profit", "Rate", "Commission", ""].map(h => (
                            <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {commissionReport.map(m => (
                          <tr key={m.id} style={{ borderBottom: "1px solid " + t.border }}>
                            <td style={{ padding: "10px 12px", fontWeight: 700 }}>👤 {m.name}</td>
                            <td style={{ padding: "10px 12px", color: t.textMuted }}>{m.role || "—"}</td>
                            <td style={{ padding: "10px 12px", fontWeight: 600, color: t.primary }}>{m.salesCount}</td>
                            <td style={{ padding: "10px 12px", color: t.success }}>{m.revenue.toLocaleString()} EGP</td>
                            <td style={{ padding: "10px 12px", color: m.profit >= 0 ? t.success : t.danger }}>{m.profit.toLocaleString()} EGP</td>
                            <td style={{ padding: "10px 12px", fontSize: t.fs.xs, color: t.textMuted }}>
                              {m.commissionRate || 0}{m.commissionBase === "fixed" ? " EGP" : "%"} {m.commissionBase || "rev"}
                            </td>
                            <td style={{ padding: "10px 12px", fontWeight: 800, color: t.danger, fontSize: t.fs.md }}>{m.commission.toLocaleString()} EGP</td>
                            <td style={{ padding: "10px 12px" }}>
                              {isAdmin && m.phone && (
                                <a
                                  href={waLink(m.phone, "Hi " + m.name + ",\n\nYour commission report for *" + commissionPeriod + "*:\n\n📊 Sales: " + m.salesCount + "\n💰 Revenue: " + m.revenue.toLocaleString() + " EGP\n🎯 Due: *" + m.commission.toLocaleString() + " EGP*\n\n_ProSkill Team_")}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ ...t.btnWA, padding: "4px 10px", fontSize: t.fs.xs }}
                                >📱 WA</a>
                              )}
                            </td>
                          </tr>
                        ))}
                        {isAdmin && (
                          <tr style={{ background: t.cardBg2, borderTop: "2px solid " + t.primary }}>
                            <td colSpan={2} style={{ padding: "12px", fontWeight: 800, fontSize: t.fs.md }}>TOTAL</td>
                            <td style={{ padding: "12px", fontWeight: 800 }}>{commissionReport.reduce((s, m) => s + m.salesCount, 0)}</td>
                            <td style={{ padding: "12px", fontWeight: 800, color: t.success }}>{commissionReport.reduce((s, m) => s + m.revenue, 0).toLocaleString()} EGP</td>
                            <td style={{ padding: "12px", fontWeight: 800, color: t.success }}>{commissionReport.reduce((s, m) => s + m.profit, 0).toLocaleString()} EGP</td>
                            <td style={{ padding: "12px" }}>—</td>
                            <td style={{ padding: "12px", fontWeight: 800, color: t.danger, fontSize: t.fs.lg }}>{totalCommissions.toLocaleString()} EGP</td>
                            <td></td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {isAdmin && (
                  <div style={{ ...t.card, marginTop: 14, padding: 14, background: t.dark ? "#0f172a" : "#fffbeb", borderLeft: "3px solid " + t.warning }}>
                    <p style={{ margin: 0, fontSize: t.fs.sm, color: t.textMuted }}>
                      💡 <strong>Tip:</strong> Click "📱 WA" to message each team member their commission summary. Export to PDF at month-end for your records.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             🧾 EXPENSES TAB (admin only)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "expenses" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>🧾 Expenses</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <ExportMenu
                  theme={t}
                  onCsv={() => exportCSV(expenses.map(e => ({
                    Date: e.date, Category: e.category, Amount: e.amount, Note: e.note || "",
                  })), "expenses_" + todayStr() + ".csv")}
                  onXlsx={() => exportExcel(expenses.map(e => ({
                    Date: e.date, Category: e.category, Amount: e.amount, Note: e.note || "",
                  })), "expenses_" + todayStr() + ".xls", "Expenses")}
                  onPdf={() => exportPDF("Expenses Report", expenses.map(e => ({
                    Date: e.date, Category: e.category,
                    Amount: e.amount + " EGP", Note: e.note || "—",
                  })), "expenses_" + todayStr() + ".pdf")}
                />
                <button onClick={() => setNewExp({ category: EXPENSE_CATEGORIES[0], amount: 0, date: todayStr(), note: "" })} style={t.btnPrimary}>+ Expense</button>
              </div>
            </div>

            {/* Summary cards */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)",
              gap: t.sp.md,
              marginBottom: 14,
            }}>
              <div style={{ ...t.card, borderTop: "3px solid " + t.warning }}>
                <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>This Month</p>
                <p style={{ margin: "6px 0 0", fontSize: t.fs.xxl, fontWeight: 900, color: t.warning, lineHeight: 1.1 }}>{monthExpsTotal.toLocaleString()} EGP</p>
              </div>
              <div style={{ ...t.card, borderTop: "3px solid " + t.danger }}>
                <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>Total Expenses</p>
                <p style={{ margin: "6px 0 0", fontSize: t.fs.xxl, fontWeight: 900, color: t.danger, lineHeight: 1.1 }}>{totalExpsAll.toLocaleString()} EGP</p>
              </div>
              <div style={{ ...t.card, borderTop: "3px solid " + (netProfit >= 0 ? t.success : t.danger) }}>
                <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>Net Profit</p>
                <p style={{ margin: "6px 0 0", fontSize: t.fs.xxl, fontWeight: 900, color: netProfit >= 0 ? t.success : t.danger, lineHeight: 1.1 }}>{netProfit.toLocaleString()} EGP</p>
              </div>
            </div>

            {/* New expense form */}
            {newExp && (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Expense</h3>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 2fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Category</label>
                    <select value={newExp.category} onChange={e => setNewExp(p => ({ ...p, category: e.target.value }))} style={t.input}>
                      {EXPENSE_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={t.label}>Amount (EGP)</label>
                    <input type="number" value={newExp.amount} onChange={e => setNewExp(p => ({ ...p, amount: +e.target.value }))} style={t.input} />
                  </div>
                  <div>
                    <label style={t.label}>Date</label>
                    <input type="date" value={newExp.date} onChange={e => setNewExp(p => ({ ...p, date: e.target.value }))} style={t.input} />
                  </div>
                  <div style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>
                    <label style={t.label}>Note</label>
                    <input value={newExp.note} onChange={e => setNewExp(p => ({ ...p, note: e.target.value }))} style={t.input} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setNewExp(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addExpense} style={{ ...t.btnPrimary, flex: 1 }}>💾 Add Expense</button>
                </div>
              </div>
            )}

            {/* Expense list */}
            {expenses.length === 0 ? (
              <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>🧾</div>
                <p style={{ margin: 0, fontSize: t.fs.base }}>No expenses recorded yet.</p>
              </div>
            ) : isMobile ? (
              /* Mobile cards */
              <div>
                {expenses.map(e => (
                  <div key={e.id} style={{ ...t.card, marginBottom: 8, borderLeft: "4px solid " + t.danger }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: t.fs.md, fontWeight: 700 }}>{e.category}</div>
                        <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>📅 {e.date}</div>
                        {e.note && <div style={{ fontSize: t.fs.sm, color: t.textMuted, marginTop: 4 }}>💬 {e.note}</div>}
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: t.fs.lg, fontWeight: 800, color: t.danger }}>-{e.amount.toLocaleString()}</div>
                        <button
                          onClick={() => { if (confirm("Delete this expense?")) setExpenses(p => p.filter(x => x.id !== e.id)); }}
                          style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.xs, marginTop: 4 }}
                        >✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* Desktop list */
              <div style={t.card}>
                {expenses.map(e => (
                  <div key={e.id} style={{ padding: "10px 0", borderBottom: "1px solid " + t.border, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong>{e.category}</strong> · {e.date}
                      {e.note && <span style={{ color: t.textMuted, marginLeft: 8 }}> · {e.note}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
                      <span style={{ fontWeight: 700, color: t.danger, fontSize: t.fs.md }}>-{e.amount.toLocaleString()} EGP</span>
                      <button
                        onClick={() => { if (confirm("Delete this expense?")) setExpenses(p => p.filter(x => x.id !== e.id)); }}
                        style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.xs }}
                      >✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             ⚙️ SERVICES TAB (admin only)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "services" && (
          <div>
            <h2 style={{ margin: "0 0 14px", fontSize: t.fs.xl, fontWeight: 800 }}>⚙️ Services ({services.length})</h2>

            {/* Add service form */}
            <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
              <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>➕ Add Service</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ position: "relative" }}>
                  <label style={t.label}>Icon</label>
                  <div
                    onClick={() => setShowIP(!showIP)}
                    style={{
                      ...t.input,
                      width: isMobile ? 56 : 48,
                      fontSize: 22,
                      textAlign: "center",
                      cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >{nSvcI}</div>
                  {showIP && (
                    <div style={{
                      position: "absolute", top: "calc(100% + 4px)", left: 0,
                      zIndex: 50,
                      background: t.cardBg,
                      border: "1px solid " + t.border,
                      borderRadius: 10,
                      padding: 10,
                      width: 280,
                      display: "flex", flexWrap: "wrap", gap: 4,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                      maxHeight: 200, overflow: "auto",
                    }}>
                      {ICONS.map(ic => (
                        <span
                          key={ic}
                          onClick={() => { setNSvcI(ic); setShowIP(false); }}
                          style={{
                            fontSize: 18,
                            cursor: "pointer",
                            padding: 6,
                            borderRadius: 6,
                            background: nSvcI === ic ? (t.dark ? "rgba(42,157,143,0.2)" : "#e8f4f2") : "transparent",
                            width: 30, height: 30,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >{ic}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <label style={t.label}>Service Name</label>
                  <input
                    value={nSvcN}
                    onChange={e => setNSvcN(e.target.value)}
                    placeholder="e.g. Netflix Premium"
                    style={t.input}
                    onKeyDown={e => { if (e.key === "Enter") addService(); }}
                  />
                </div>
                <button onClick={addService} style={t.btnPrimary}>+ Add</button>
              </div>
            </div>

            {/* Services grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(180px, 1fr))",
              gap: t.sp.md,
            }}>
              {services.map(s => {
                const st = stockStatsByProduct[s.name] || { total: 0, avail: 0 };
                const saleCount = sales.filter(a => a.service === s.name).length;
                return (
                  <div key={s.name} style={t.card}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 28 }}>{s.icon}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <h4 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</h4>
                        <div style={{ fontSize: t.fs.xs, color: t.textMuted }}>{saleCount} sales</div>
                      </div>
                    </div>
                    {st.total > 0 && (
                      <div style={{ fontSize: t.fs.sm, color: st.avail === 0 ? t.danger : t.success, marginBottom: 8 }}>
                        📦 {st.avail} / {st.total} available
                      </div>
                    )}
                    <button onClick={() => removeService(s.name)} style={{ ...t.btnDanger, width: "100%", padding: "6px 10px", fontSize: t.fs.sm }}>🗑 Delete</button>
                  </div>
                );
              })}
              {services.length === 0 && (
                <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted, gridColumn: "1 / -1" }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>⚙️</div>
                  <p style={{ margin: 0 }}>No services yet. Add one above.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             📈 REPORTS TAB (admin only)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "reports" && (
          <div>
            <h2 style={{ margin: "0 0 14px", fontSize: t.fs.xl, fontWeight: 800 }}>📈 Reports</h2>

            {/* Sub-tabs */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              {[
                { id: "all",      l: "📊 Overview" },
                { id: "renewals", l: "🔄 Renewals" },
                { id: "followup", l: "📞 Follow-ups" },
                { id: "unpaid",   l: "💳 Pending Payment" },
                { id: "pending",  l: "📎 Pending Proofs" },
              ].map(rt => {
                const active = repTab === rt.id;
                return (
                  <button
                    key={rt.id}
                    onClick={() => setRepTab(rt.id)}
                    style={{
                      ...t.btnGhost,
                      padding: isMobile ? "8px 14px" : "6px 12px",
                      fontSize: t.fs.sm,
                      background: active ? t.primary : "transparent",
                      color: active ? "#fff" : t.primary,
                    }}
                  >{rt.l}</button>
                );
              })}
            </div>

            {repTab === "all" && (
              <div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: t.sp.md,
                  marginBottom: 14,
                }}>
                  {[
                    { l: "Total Sales", v: sales.length, c: t.primaryDark },
                    { l: "Completed", v: allDone.length, c: t.success },
                    { l: "Revenue", v: myStats.tR.toLocaleString() + " EGP", c: t.primary },
                    { l: "Profit", v: myStats.tP.toLocaleString() + " EGP", c: myStats.tP >= 0 ? t.success : t.danger },
                    { l: "Expenses", v: totalExpsAll.toLocaleString() + " EGP", c: t.warning },
                    { l: "Net", v: netProfit.toLocaleString() + " EGP", c: netProfit >= 0 ? t.success : t.danger },
                  ].map((c, i) => (
                    <div key={i} style={{ ...t.card, borderTop: "3px solid " + c.c }}>
                      <p style={{ margin: 0, fontSize: t.fs.xs, color: t.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{c.l}</p>
                      <p style={{ margin: "6px 0 0", fontSize: t.fs.xl, fontWeight: 900, color: c.c, lineHeight: 1.1 }}>{c.v}</p>
                    </div>
                  ))}
                </div>
                <div style={t.card}>
                  <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>Year-to-Date Performance</h3>
                  <Chart data={myTime.ytdM} height={isMobile ? 160 : 140} color={t.primaryDark} theme={t} />
                </div>
              </div>
            )}

            {repTab === "renewals" && (() => {
              const upcoming = sales.filter(a => a.done && daysLeft(a.renewDate) >= 0 && daysLeft(a.renewDate) <= 30).sort((a, b) => daysLeft(a.renewDate) - daysLeft(b.renewDate));
              return (
                <div style={t.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700 }}>🔄 Upcoming Renewals ({upcoming.length})</h3>
                    <ExportMenu
                      theme={t}
                      onCsv={() => exportCSV(upcoming.map(a => ({
                        Customer: a.customer, Phone: a.customerPhone || "",
                        Service: a.service, "Renew Date": a.renewDate,
                        Days: daysLeft(a.renewDate), Price: a.price + " " + (a.currency || "EGP"),
                      })), "renewals_" + todayStr() + ".csv")}
                      onXlsx={() => exportExcel(upcoming.map(a => ({
                        Customer: a.customer, Phone: a.customerPhone || "", Service: a.service,
                        RenewDate: a.renewDate, Days: daysLeft(a.renewDate), Price: a.price,
                      })), "renewals_" + todayStr() + ".xls", "Renewals")}
                      onPdf={() => exportPDF("Upcoming Renewals", upcoming.map(a => ({
                        Customer: a.customer, Phone: a.customerPhone || "—",
                        Service: a.service, "Renew Date": a.renewDate,
                        Days: daysLeft(a.renewDate), Price: a.price + " " + (a.currency || "EGP"),
                      })), "renewals_" + todayStr() + ".pdf")}
                    />
                  </div>
                  {upcoming.length === 0 ? (
                    <p style={{ fontSize: t.fs.base, color: t.textMuted, textAlign: "center", padding: 20, margin: 0 }}>
                      No renewals in the next 30 days.
                    </p>
                  ) : upcoming.map(a => (
                    <div
                      key={a.id}
                      onClick={() => setSelSale(a)}
                      style={{
                        padding: "10px 0",
                        borderBottom: "1px solid " + t.border,
                        cursor: "pointer",
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        gap: 8, flexWrap: "wrap",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: t.fs.base, fontWeight: 600 }}>{a.customer}</div>
                        <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>{svcIcon(a.service)} {a.service}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: t.fs.sm, color: daysLeft(a.renewDate) <= 3 ? t.danger : daysLeft(a.renewDate) <= 7 ? t.warning : t.success, fontWeight: 700 }}>
                          {daysLeft(a.renewDate)}d
                        </span>
                        <span style={{ fontSize: t.fs.sm, color: t.success, fontWeight: 600 }}>{a.price} {a.currency || "EGP"}</span>
                        {a.customerPhone && (
                          <a
                            href={waLink(a.customerPhone, "Hi " + a.customer + ", your " + a.service + " renews on " + a.renewDate)}
                            target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ ...t.btnWA, padding: "4px 10px", fontSize: t.fs.xs }}
                          >WA</a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {repTab === "followup" && (
              <div style={t.card}>
                <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>📞 Follow-up Needed ({alerts.fu.length})</h3>
                {alerts.fu.length === 0 ? (
                  <p style={{ fontSize: t.fs.base, color: t.textMuted, textAlign: "center", padding: 20, margin: 0 }}>
                    🎉 Nobody needs a follow-up right now!
                  </p>
                ) : alerts.fu.map(a => (
                  <div
                    key={a.id}
                    onClick={() => setSelSale(a)}
                    style={{
                      padding: "10px 0",
                      borderBottom: "1px solid " + t.border,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontSize: t.fs.base, fontWeight: 600 }}>{a.customer}</div>
                    <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                      {svcIcon(a.service)} {a.service} · 📞 {a.customerPhone || "—"}
                    </div>
                    {a.notes && <p style={{ margin: "4px 0 0", fontSize: t.fs.sm, color: t.warning, fontStyle: "italic" }}>📝 {a.notes}</p>}
                  </div>
                ))}
              </div>
            )}

            {repTab === "unpaid" && (
              <div style={t.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700 }}>💳 Pending Payment ({alerts.pp.length})</h3>
                  <ExportMenu
                    theme={t}
                    onCsv={() => exportCSV(alerts.pp.map(a => ({
                      Customer: a.customer, Phone: a.customerPhone || "",
                      Email: a.customerEmail || "", Service: a.service,
                      Price: a.price + " " + (a.currency || "EGP"),
                      "Sold Date": a.soldDate,
                    })), "unpaid_" + todayStr() + ".csv")}
                    onXlsx={() => exportExcel(alerts.pp.map(a => ({
                      Customer: a.customer, Phone: a.customerPhone || "",
                      Email: a.customerEmail || "", Service: a.service,
                      Price: a.price, Currency: a.currency || "EGP",
                      SoldDate: a.soldDate,
                    })), "unpaid_" + todayStr() + ".xls", "Pending Payment")}
                    onPdf={() => exportPDF("Pending Payment", alerts.pp.map(a => ({
                      Customer: a.customer, Phone: a.customerPhone || "—",
                      Email: a.customerEmail || "—", Service: a.service,
                      Price: a.price + " " + (a.currency || "EGP"),
                      "Sold Date": a.soldDate,
                    })), "unpaid_" + todayStr() + ".pdf")}
                  />
                </div>
                <p style={{ margin: "0 0 14px", fontSize: t.fs.sm, color: t.textMuted }}>
                  Sales where the <strong>"Payment Received"</strong> checklist item is not yet checked.
                </p>
                {alerts.pp.length === 0 ? (
                  <p style={{ fontSize: t.fs.base, color: t.textMuted, textAlign: "center", padding: 20, margin: 0 }}>
                    🎉 All payments confirmed!
                  </p>
                ) : alerts.pp.map(a => (
                  <div
                    key={a.id}
                    onClick={() => setSelSale(a)}
                    style={{
                      padding: "10px 0",
                      borderBottom: "1px solid " + t.border,
                      cursor: "pointer",
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      gap: 8, flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: t.fs.base, fontWeight: 600 }}>{a.customer}</div>
                      <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>
                        {svcIcon(a.service)} {a.service} · {a.soldDate}
                      </div>
                      {a.customerPhone && <div style={{ fontSize: t.fs.sm, color: t.primary }}>📞 {a.customerPhone}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: t.fs.md, fontWeight: 700, color: t.danger }}>{a.price} {a.currency || "EGP"}</span>
                      {a.customerPhone && (
                        <a
                          href={waLink(a.customerPhone, "Hi " + a.customer + ",\n\nFriendly reminder: your *" + a.service + "* (" + a.price + " " + (a.currency || "EGP") + ") payment is still pending.\n\nCould you please confirm? Thanks!\n\n_ProSkill Team_")}
                          target="_blank" rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ ...t.btnWA, padding: "6px 12px", fontSize: t.fs.sm }}
                        >📱 Remind</a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {repTab === "pending" && (
              <div style={t.card}>
                <h3 style={{ margin: "0 0 12px", fontSize: t.fs.md, fontWeight: 700 }}>📎 Pending Payment Proofs ({alerts.pendingProofs.length})</h3>
                {alerts.pendingProofs.length === 0 ? (
                  <p style={{ fontSize: t.fs.base, color: t.textMuted, textAlign: "center", padding: 20, margin: 0 }}>
                    No pending proofs.
                  </p>
                ) : alerts.pendingProofs.map(a => (
                  <div
                    key={a.id}
                    style={{
                      padding: "10px 0",
                      borderBottom: "1px solid " + t.border,
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      gap: 8, flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: t.fs.base, fontWeight: 600 }}>{a.customer}</div>
                      <div style={{ fontSize: t.fs.sm, color: t.textMuted }}>{a.service} · {a.price} {a.currency || "EGP"}</div>
                    </div>
                    <button onClick={() => setProofModal({ saleId: a.id })} style={t.btnPrimary}>Review</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             📜 ACTIVITY LOG (admin only)
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "logs" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>📜 Activity Log ({logs.length})</h2>
              {logs.length > 0 && (
                <button
                  onClick={() => { if (confirm("Clear all activity logs?")) { setLogs([]); addLog("Cleared activity log"); } }}
                  style={t.btnDanger}
                >🗑 Clear</button>
              )}
            </div>
            <div style={t.card}>
              {logs.length === 0 ? (
                <p style={{ fontSize: t.fs.base, color: t.textMuted, textAlign: "center", padding: 30, margin: 0 }}>
                  No activity recorded yet.
                </p>
              ) : logs.map(l => (
                <div key={l.id} style={{
                  padding: "10px 0",
                  borderBottom: "1px solid " + t.border,
                  fontSize: t.fs.sm,
                  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                  gap: 10, flexWrap: "wrap",
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ color: t.primary }}>{l.user}</strong> {l.action}
                  </div>
                  <span style={{ fontSize: t.fs.xs, color: t.textMuted, flexShrink: 0 }}>{new Date(l.time).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
             📋 GUIDE TAB
             ═══════════════════════════════════════════════════════════════ */}
        {tab === "guide" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: t.fs.xl, fontWeight: 800 }}>📋 Service Guides ({guides.length})</h2>
              {isAdmin && (
                <button onClick={() => setNewGuide({ service: svcNames[0] || "", title: "", text: "", link: "" })} style={t.btnPrimary}>
                  + New Guide
                </button>
              )}
            </div>

            {/* New guide form */}
            {newGuide && isAdmin && (
              <div style={{ ...t.card, marginBottom: 14, border: "2px solid " + t.primary }}>
                <h3 style={{ margin: "0 0 10px", fontSize: t.fs.md, fontWeight: 700 }}>➕ New Guide</h3>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 2fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={t.label}>Service</label>
                    <select value={newGuide.service} onChange={e => setNewGuide(p => ({ ...p, service: e.target.value }))} style={t.input}>
                      {svcNames.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={t.label}>Title</label>
                    <input value={newGuide.title} onChange={e => setNewGuide(p => ({ ...p, title: e.target.value }))} placeholder="e.g. How to activate Adobe" style={t.input} />
                  </div>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={t.label}>Steps / Text</label>
                  <textarea
                    value={newGuide.text}
                    onChange={e => setNewGuide(p => ({ ...p, text: e.target.value }))}
                    rows={5}
                    placeholder="1. First step...&#10;2. Second step..."
                    style={{ ...t.input, resize: "vertical", minHeight: 100, fontFamily: "inherit" }}
                  />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={t.label}>Link (optional)</label>
                  <input value={newGuide.link} onChange={e => setNewGuide(p => ({ ...p, link: e.target.value }))} placeholder="https://..." style={t.input} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setNewGuide(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                  <button onClick={addGuide} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save</button>
                </div>
              </div>
            )}

            {/* Edit guide modal */}
            {editGuide && isAdmin && (
              <div
                onClick={() => setEditGuide(null)}
                style={{
                  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  zIndex: 999, padding: isMobile ? 0 : 20,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    ...t.card,
                    width: isMobile ? "100%" : 460,
                    maxWidth: "100%",
                    height: isMobile ? "100vh" : "auto",
                    maxHeight: isMobile ? "100vh" : "90vh",
                    overflow: "auto",
                    borderRadius: isMobile ? 0 : 14,
                    padding: isMobile ? 20 : 22,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10 }}>
                    {isMobile && (
                      <button onClick={() => setEditGuide(null)} style={{ ...t.btnGhost, padding: "10px 14px", fontSize: t.fs.base, fontWeight: 700, flexShrink: 0 }}>← Back</button>
                    )}
                    <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700, flex: 1, minWidth: 0 }}>✎ Edit Guide</h3>
                    {!isMobile && (
                      <span onClick={() => setEditGuide(null)} style={{ cursor: "pointer", fontSize: 24, color: t.textMuted, padding: 4 }}>✕</span>
                    )}
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={t.label}>Service</label>
                    <select value={editGuide.service} onChange={e => setEditGuide(p => ({ ...p, service: e.target.value }))} style={t.input}>
                      {svcNames.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={t.label}>Title</label>
                    <input value={editGuide.title || ""} onChange={e => setEditGuide(p => ({ ...p, title: e.target.value }))} style={t.input} />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={t.label}>Text</label>
                    <textarea value={editGuide.text || ""} onChange={e => setEditGuide(p => ({ ...p, text: e.target.value }))} rows={5} style={{ ...t.input, resize: "vertical", minHeight: 100, fontFamily: "inherit" }} />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={t.label}>Link</label>
                    <input value={editGuide.link || ""} onChange={e => setEditGuide(p => ({ ...p, link: e.target.value }))} style={t.input} />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setEditGuide(null)} style={{ ...t.btnGhost, flex: 1 }}>Cancel</button>
                    <button onClick={saveEditGuide} style={{ ...t.btnPrimary, flex: 1 }}>💾 Save</button>
                  </div>
                </div>
              </div>
            )}

            {/* Guide list */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(300px, 1fr))",
              gap: t.sp.md,
            }}>
              {guides.length === 0 ? (
                <div style={{ ...t.card, padding: 30, textAlign: "center", color: t.textMuted, gridColumn: "1 / -1" }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>📋</div>
                  <p style={{ margin: "0 0 6px", fontSize: t.fs.base }}>No guides yet.</p>
                  {isAdmin && <p style={{ margin: 0, fontSize: t.fs.sm }}>Add step-by-step instructions for each service so your team has clear reference material.</p>}
                </div>
              ) : guides.map(g => (
                <div key={g.id} style={t.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 8 }}>
                    <h4 style={{ margin: 0, fontSize: t.fs.md, fontWeight: 700, minWidth: 0, flex: 1 }}>
                      {svcIcon(g.service)} {g.title || g.service}
                    </h4>
                    {isAdmin && (
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        <button onClick={() => setEditGuide({ ...g })} style={{ ...t.btnGhost, padding: "4px 10px", fontSize: t.fs.sm }}>✎</button>
                        <button onClick={() => { if (confirm("Delete this guide?")) deleteGuide(g.id); }} style={{ ...t.btnDanger, padding: "4px 10px", fontSize: t.fs.sm }}>✕</button>
                      </div>
                    )}
                  </div>
                  {g.text && (
                    <p style={{ margin: "0 0 8px", fontSize: t.fs.sm, color: t.textMuted, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{g.text}</p>
                  )}
                  {g.link && (
                    <a href={g.link} target="_blank" rel="noreferrer" style={{ fontSize: t.fs.sm, color: t.primary, wordBreak: "break-all" }}>
                      🔗 {g.link}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ─────────────── MOBILE BOTTOM NAV ─────────────── */}
      {isMobile && (
        <div style={{
          background: "#1a2e44",
          padding: "4px 0 8px",
          display: "flex",
          justifyContent: "space-around",
          flexShrink: 0,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 -2px 8px rgba(0,0,0,0.15)",
        }}>
          {mobileNavTabs.map(tb => {
            const active = tab === tb.id;
            return (
              <div
                key={tb.id}
                onClick={() => setTab(tb.id)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  padding: "8px 4px",
                  cursor: "pointer",
                  color: active ? "#fff" : "#94a3b8",
                  background: active ? "rgba(42,157,143,0.2)" : "transparent",
                  borderRadius: 8,
                  flex: 1,
                  maxWidth: 80,
                  minWidth: 60,
                  position: "relative",
                }}
              >
                <span style={{ fontSize: 22, lineHeight: 1 }}>{tb.icon}</span>
                <span style={{ fontSize: 10, marginTop: 4, fontWeight: active ? 700 : 500 }}>{tb.label}</span>
                {tb.id === "tasks" && overdueTasks.length > 0 && (
                  <span style={{
                    position: "absolute", top: 2, right: "25%",
                    background: "#ef4444", color: "#fff",
                    borderRadius: 8, padding: "0 4px", fontSize: 8, fontWeight: 700,
                    minWidth: 14, textAlign: "center",
                  }}>{overdueTasks.length}</span>
                )}
              </div>
            );
          })}
          {visTabs.length > 4 && (
            <div
              onClick={() => setShowMoreMenu(true)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "8px 4px",
                cursor: "pointer",
                color: "#94a3b8",
                flex: 1,
                maxWidth: 80,
                minWidth: 60,
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1 }}>☰</span>
              <span style={{ fontSize: 10, marginTop: 4, fontWeight: 500 }}>More</span>
            </div>
          )}
        </div>
      )}

      {/* ─────────────── MOBILE "MORE" OVERLAY ─────────────── */}
      {isMobile && showMoreMenu && (
        <div
          onClick={() => setShowMoreMenu(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.6)", zIndex: 999,
            display: "flex", alignItems: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: t.cardBg,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: "20px 16px 28px",
              maxHeight: "80vh",
              overflow: "auto",
            }}
          >
            <div style={{
              width: 40, height: 4, background: t.border,
              borderRadius: 2, margin: "0 auto 20px",
            }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: t.fs.lg, fontWeight: 700 }}>All Sections</h3>
              <span
                onClick={() => setShowMoreMenu(false)}
                style={{ fontSize: 24, color: t.textMuted, cursor: "pointer", padding: 4 }}
              >✕</span>
            </div>

            {/* Tab grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 10,
              marginBottom: 20,
            }}>
              {visTabs.map(tb => {
                const active = tab === tb.id;
                return (
                  <div
                    key={tb.id}
                    onClick={() => { setTab(tb.id); setShowMoreMenu(false); }}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center",
                      justifyContent: "center",
                      padding: "16px 8px",
                      cursor: "pointer",
                      background: active ? "#2a9d8f" : (t.dark ? "#334155" : "#f5f7f9"),
                      color: active ? "#fff" : t.text,
                      borderRadius: 12,
                      textAlign: "center",
                      minHeight: 80,
                    }}
                  >
                    <span style={{ fontSize: 28, lineHeight: 1, marginBottom: 6 }}>{tb.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: active ? 700 : 600 }}>{tb.label}</span>
                  </div>
                );
              })}
            </div>

            {/* Quick actions */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {isAdmin && (
                <button
                  onClick={() => { setShowBackup(true); setShowMoreMenu(false); }}
                  style={{ ...t.btnGhost, flex: 1, minWidth: 140 }}
                >💾 Backup</button>
              )}
              {isAdmin && (
                <button
                  onClick={() => { setShowTemplates({ sale: null }); setShowMoreMenu(false); }}
                  style={{ ...t.btnGhost, flex: 1, minWidth: 140 }}
                >💬 WA Templates</button>
              )}
              {isAdmin && undoStack.length > 0 && (
                <button
                  onClick={() => {
                    const last = undoStack[undoStack.length - 1];
                    setSales(p => [last, ...p]);
                    setUndoStack(p => p.slice(0, -1));
                    setShowMoreMenu(false);
                  }}
                  style={{ ...t.btnGhost, flex: 1, minWidth: 140, color: "#f59e0b", borderColor: "#f59e0b" }}
                >↩ Undo Delete</button>
              )}
            </div>

            {/* Logged-in user + sign out */}
            <div style={{
              padding: "14px 12px",
              background: t.dark ? "#0f172a" : "#f5f7f9",
              borderRadius: 10,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: t.textMuted }}>Signed in as</div>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cU && cU.email}
                </div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>
                  {isAdmin ? "👑 Admin" : "👤 Member"}
                </div>
              </div>
              <button onClick={handleSignOut} style={{ ...t.btnDanger, flexShrink: 0 }}>Sign Out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════
// SUPABASE CLOUD SYNC
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
      const res = await fetch(SUPABASE_URL + path, { ...opts, headers });
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
  async loadData() {
    if (!this.user) return null;
    const key = "ws_" + this.user.id;
    const r = await this.req("/rest/v1/proskill_workspace?workspace_key=eq." + key + "&select=data&limit=1");
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) return r.data[0].data;
    return null;
  },
  async saveData(data) {
    if (!this.user) return { ok: false };
    const key = "ws_" + this.user.id;
    const body = JSON.stringify({ data, updated_at: new Date().toISOString() });
    // Try PATCH (update) first
    const r = await this.req("/rest/v1/proskill_workspace?workspace_key=eq." + key, { method: "PATCH", prefer: "return=minimal", body });
    if (r.ok) return r;
    // If no row exists yet, INSERT
    const r2 = await this.req("/rest/v1/proskill_workspace", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ owner_id: this.user.id, workspace_key: key, data }) });
    return r2;
  },
};

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const DS = [
  { name: "Adobe", icon: "🎨" },
  { name: "ChatGPT", icon: "🤖" },
  { name: "LinkedIn", icon: "💼" },
  { name: "Google AI", icon: "🧠" },
  { name: "Canva", icon: "🖌️" },
  { name: "Microsoft 365", icon: "📎" }
];
const DCL = ["Payment confirmed", "Account ready", "Activated", "Tested", "Sent to client", "Client confirmed"];
const ICONS = ["📦","🎨","🤖","💼","🧠","🖌️","📎","📝","✏️","🎯","🔧","💡","🌐","📱","💻","🎮","📊","🔒","☁️","⚡","🛒","🎵","📹","🗂️","🧩","🏢","🎓","🔬","🚀","💳","🛡️","📡","🏦","📈","🔗","💎","📐","🥇","💬","📌","🧰","🔑","💰","📋","👥","⚙️","✈️","🎬","📸","🖥️","🔍","🛠️","🎲","🏆","📣","🔔","💵","🎁","🌍","🌟","⭐","🔥","🌈"];
const PERS = [...Array.from({ length: 36 }, (_, i) => i + 1), 0, -1];
const PER_LABEL = (p) => p === 0 ? "No Period" : p === -1 ? "Lifetime" : p + "mo";
const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const CURS = [{ c: "EGP", s: "E£" }, { c: "USD", s: "$" }, { c: "SAR", s: "﷼" }, { c: "EUR", s: "€" }];
const RATES = { EGP: 1, USD: 48.5, SAR: 12.9, EUR: 53 };
const ECAT = ["Salaries", "Rent", "Marketing", "Tools", "Internet", "Other"];
const ADMIN_EMAIL = "Mohamed.abdullah969@gmail.com";
const ADMIN_WA = "201270935507";
const COMPANY = {
  website: "www.proskillagency.com",
  whatsapp: "+201270935507",
  email: "support@proskillagency.com",
  terms: "This is a digital service. Refunds are not available after successful activation. However, we guarantee full support in case of any technical issue."
};

const DEFAULT_WA_TEMPLATES = [
  { id: 1, name: "🎉 Welcome", text: "Hi {customer}! 🎉\n\nWelcome to ProSkill Digital Agency! Your {service} subscription has been activated successfully.\n\nIf you need any help or have questions, we're here for you 24/7.\n\nBest regards,\n_ProSkill Team_" },
  { id: 2, name: "⏰ Renewal Reminder", text: "Hi {customer},\n\nYour *{service}* subscription renews on {renewDate} (in {days} days).\n\n💰 Amount: {price} {currency}\n\nWould you like to proceed with the renewal?\n\n_ProSkill Digital Agency_" },
  { id: 3, name: "💳 Payment Request", text: "Hi {customer},\n\nPlease complete your payment for *{service}*:\n\n💰 Amount: {price} {currency}\n\nPayment methods:\n• Bank Transfer\n• Vodafone Cash: 01270935507\n• InstaPay\n\nReply with payment proof when done. Thank you!\n\n_ProSkill Digital Agency_" },
  { id: 4, name: "🚨 Overdue Notice", text: "Hi {customer},\n\nYour *{service}* subscription has expired.\n\nTo avoid service interruption, please renew as soon as possible:\n💰 {price} {currency}\n\nNeed assistance? Reply to this message.\n\n_ProSkill Digital Agency_" },
  { id: 5, name: "⭐ Review Request", text: "Hi {customer}! 😊\n\nThank you for choosing ProSkill! How was your experience with *{service}*?\n\nWe'd love your feedback — reply with a rating from 1 to 5 stars ⭐\n\nYour opinion helps us improve!\n\n_ProSkill Team_" }
];

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function tds(d) {
  const t = new Date(d);
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}
function gn() { return tds(new Date()); }
function amo(s, m) { const d = new Date(s); d.setMonth(d.getMonth() + m); return tds(d); }
function dl(s) { const n = new Date(); n.setHours(0, 0, 0, 0); return Math.ceil((new Date(s) - n) / 864e5); }
function fd(s) { if (!s) return ""; const d = new Date(s); return d.getDate() + " " + MN[d.getMonth()]; }
function gwr(d) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day >= 6 ? day - 6 : day + 1;
  const s = new Date(x); s.setDate(x.getDate() - diff);
  const e = new Date(s); e.setDate(s.getDate() + 6);
  return { s: tds(s), e: tds(e) };
}
function gmr(d) {
  const x = new Date(d);
  return { s: tds(new Date(x.getFullYear(), x.getMonth(), 1)), e: tds(new Date(x.getFullYear(), x.getMonth() + 1, 0)) };
}
function gdr(s, e) {
  const d = [];
  const a = new Date(s); const b = new Date(e);
  while (a <= b) { d.push(tds(a)); a.setDate(a.getDate() + 1); }
  return d;
}
function toEgp(amt, cur) { return Math.round(amt * (RATES[cur] || 1)); }
function waLink(ph, msg) { return "https://wa.me/" + (ph || "").replace(/[^0-9]/g, "") + "?text=" + encodeURIComponent(msg); }
const copy = (t) => { try { navigator.clipboard.writeText(t); } catch {} };

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
  const header = keys.map(k => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(k)}</Data></Cell>`).join("");
  const rows = data.map(r => "<Row>" + keys.map(k => { const v = r[k]; return `<Cell><Data ss:Type="${cellType(v)}">${esc(v)}</Data></Cell>`; }).join("") + "</Row>").join("");
  const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="h"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2a9d8f" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="${esc(sheetName || "Sheet1")}"><Table><Row>${header}</Row>${rows}</Table></Worksheet></Workbook>`;
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
  w.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title><style>body{font-family:'Inter',system-ui,sans-serif;color:#1a2e44;padding:32px;margin:0;background:#fff}.hdr{background:linear-gradient(135deg,#1a2e44,#2a9d8f);color:#fff;padding:18px 24px;border-radius:10px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center}.hdr h1{margin:0;font-size:20px;font-weight:800}.hdr p{margin:0;font-size:10px;letter-spacing:2px;opacity:0.85}.meta{font-size:11px;color:#64748b;margin-bottom:14px;display:flex;justify-content:space-between}table{width:100%;border-collapse:collapse;font-size:10px}th{background:#1a2e44;color:#fff;padding:8px 10px;text-align:left;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;font-size:9px}td{padding:7px 10px;border-bottom:1px solid #e8ebe9}tr:nth-child(even) td{background:#f9fafb}.footer{margin-top:20px;padding-top:12px;border-top:2px solid #2a9d8f;font-size:9px;color:#64748b;text-align:center}@media print{body{padding:12px}.hdr{border-radius:0}}</style></head><body><div class="hdr"><div><h1>${esc(title)}</h1><p>PROSKILL DIGITAL AGENCY</p></div><div style="text-align:right"><p>Generated</p><p style="font-size:12px;font-weight:600;opacity:1">${new Date().toLocaleDateString()}</p></div></div><div class="meta"><span><strong>${data.length}</strong> record${data.length !== 1 ? "s" : ""}</span><span>${title}</span></div><table><thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${data.map(r => "<tr>" + keys.map(k => `<td>${esc(r[k])}</td>`).join("") + "</tr>").join("")}</tbody></table><div class="footer">ProSkill Digital Agency · ${COMPANY.website} · ${COMPANY.email}</div><script>window.onload=function(){setTimeout(function(){window.print();},300);}</script></body></html>`);
  w.document.close();
}

// ═══════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════
function ExportMenu({ onCsv, onXlsx, onPdf }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: "#2a9d8f", color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontWeight: 600, fontSize: 10 }}>📥 Export ▾</button>
      {open && (<>
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "#fff", border: "1px solid #e8ebe9", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 140 }}>
          <div onClick={() => { onPdf(); setOpen(false); }} style={{ padding: "8px 12px", cursor: "pointer", fontSize: 10, color: "#1a2e44", borderBottom: "1px solid #f1f5f9" }}>📄 PDF</div>
          <div onClick={() => { onXlsx(); setOpen(false); }} style={{ padding: "8px 12px", cursor: "pointer", fontSize: 10, color: "#1a2e44", borderBottom: "1px solid #f1f5f9" }}>📊 Excel</div>
          <div onClick={() => { onCsv(); setOpen(false); }} style={{ padding: "8px 12px", cursor: "pointer", fontSize: 10, color: "#1a2e44" }}>📋 CSV</div>
        </div>
      </>)}
    </div>
  );
}

function Chrt({ data, height = 100, color = "#2a9d8f" }) {
  if (!data || !data.length) return <p style={{ fontSize: 10, color: "#94a3b8", textAlign: "center", padding: 12 }}>No data</p>;
  const mx = Math.max(1, ...data.map(d => d.rev));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: height, overflowX: "auto" }}>
      {data.map((d, i) => {
        const h = mx > 0 ? (d.rev / mx) * (height - 20) : 0;
        return (
          <div key={i} style={{ flex: "1 0 16px", maxWidth: 30, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <span style={{ fontSize: 5, color: "#64748b" }}>{d.rev > 0 ? d.rev : ""}</span>
            <div style={{ width: "100%", height: Math.max(2, h), background: d.count > 0 ? color : "#e2e8f0", borderRadius: "2px 2px 0 0" }} />
            <span style={{ fontSize: 5, color: "#94a3b8" }}>{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function CopyBtn({ text, label, dk }) {
  const [done, setDone] = useState(false);
  const handle = (e) => { e.stopPropagation(); copy(text); setDone(true); setTimeout(() => setDone(false), 1200); };
  return (
    <button onClick={handle} title={"Copy " + label} style={{
      background: done ? "#16a34a" : (dk ? "#334155" : "#e8f4f2"),
      color: done ? "#fff" : "#2a9d8f",
      border: "none", borderRadius: 4, padding: "2px 7px", fontSize: 9, cursor: "pointer",
      fontWeight: 600, flexShrink: 0
    }}>{done ? "✓" : "Copy"}</button>
  );
}

function PassCell({ val, dk }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 10, fontFamily: "monospace", color: dk ? "#e2e8f0" : "#1a2e44", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 90 }}>
        {show ? val : "••••••••"}
      </span>
      <button onClick={(e) => { e.stopPropagation(); setShow(s => !s); }} style={{
        background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: 0, flexShrink: 0, color: "#94a3b8"
      }}>{show ? "🙈" : "👁"}</button>
      <CopyBtn text={val} label="password" dk={dk} />
    </div>
  );
}

let saveTimer = null;

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  // AUTH STATE
  const [authStatus, setAuthStatus] = useState("loading"); // loading | login | app
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authLoading, setAuthLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState("saved");
  const [currentUser, setCurrentUser] = useState(null);
  const [loaded, setLoaded] = useState(false);

  // APP STATE
  const [tab, setTab] = useState("dashboard");
  const [dk, setDk] = useState(false);
  const [svcs, setSvcs] = useState(DS);
  const [sales, setSales] = useState([]);
  const [sConf, setSConf] = useState({});
  const [stockRows, setStockRows] = useState([]);
  const [guides, setGuides] = useState([]);
  const [cl, setCl] = useState(DCL);
  const [custs, setCusts] = useState([]);
  const [logs, setLogs] = useState([]);
  const [tgts, setTgts] = useState({});
  const [commR, setCommR] = useState(10);
  const [cmts, setCmts] = useState({});
  const [exps, setExps] = useState([]);
  const [undoStack, setUndoStack] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [feedback, setFeedback] = useState({});
  const [waTemplates, setWaTemplates] = useState(DEFAULT_WA_TEMPLATES);
  const [team, setTeam] = useState([]);
  const [newMember, setNewMember] = useState(null);
  const [editMember, setEditMember] = useState(null);
  const [commissionPeriod, setCommissionPeriod] = useState("thisMonth");

  // UI STATE
  const [aF, setAF] = useState("all");
  const [editSale, setEditSale] = useState(null);
  const [newSale, setNewSale] = useState(null);
  const [selSale, setSelSale] = useState(null);
  const [sideO, setSideO] = useState(true);
  const [nSvcN, setNSvcN] = useState("");
  const [nSvcI, setNSvcI] = useState("📦");
  const [dPer, setDPer] = useState("wtd");
  const [newGuide, setNewGuide] = useState(null);
  const [editGuide, setEditGuide] = useState(null);
  const [nCI, setNCI] = useState("");
  const [repTab, setRepTab] = useState("all");
  const [repMem, setRepMem] = useState("");
  const [showIP, setShowIP] = useState(false);
  const [showFU, setShowFU] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [search, setSearch] = useState("");
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");
  const [salesFilterProd, setSalesFilterProd] = useState("all");
  const [salesFilterPhone, setSalesFilterPhone] = useState("");
  const [custSearch, setCustSearch] = useState("");
  const [custFilterProd, setCustFilterProd] = useState("all");
  const [custFilterPhone, setCustFilterPhone] = useState("");
  const [custFilterStatus, setCustFilterStatus] = useState("all");
  const [selCust, setSelCust] = useState(null);
  const [seenN, setSeenN] = useState([]);
  const [invSale, setInvSale] = useState(null);
  const [invTemplate, setInvTemplate] = useState("standard");
  const [newCmt, setNewCmt] = useState("");
  const [selBulk, setSelBulk] = useState([]);
  const [newExp, setNewExp] = useState(null);
  const [proofModal, setProofModal] = useState(null);
  const [showBackup, setShowBackup] = useState(false);
  const [showTemplates, setShowTemplates] = useState(null);
  const [editTemplate, setEditTemplate] = useState(null);
  const [newTask, setNewTask] = useState(null);
  const [newBundle, setNewBundle] = useState(null);
  const [showRate, setShowRate] = useState(null);
  const fileInputRef = useRef(null);

  // STOCK UI
  const [stockSearch, setStockSearch] = useState("");
  const [stockView, setStockView] = useState("all");
  const [stockFilterProd, setStockFilterProd] = useState("all");
  const [stockEditId, setStockEditId] = useState(null);
  const [stockEditRow, setStockEditRow] = useState(null);
  const [stockShowAdd, setStockShowAdd] = useState(false);
  const [stockNewRow, setStockNewRow] = useState({ product: "", email: "", password: "", link: "", note: "" });
  const [stockCopiedAll, setStockCopiedAll] = useState(null);

  const svcNames = useMemo(() => svcs.map(s => s.name), [svcs]);
  const svcIcon = useCallback((n) => { const f = svcs.find(s => s.name === n); return f ? f.icon : "📦"; }, [svcs]);

  // All authenticated users are admins (single-tenant model)
  const isA = true;
  const cU = currentUser ? { name: currentUser.email, role: "admin" } : null;

  // ═══ INITIAL AUTH + LOAD ═══
  useEffect(() => {
    (async () => {
      try {
        const t = localStorage.getItem("ps_t");
        const r = localStorage.getItem("ps_r");
        if (t) {
          sb.token = t;
          const u = await sb.getUser();
          if (u) {
            await loadAppData();
            setCurrentUser(u);
            setAuthStatus("app");
            return;
          }
        }
        if (r) {
          const res = await sb.refresh(r);
          if (res.ok && sb.user) {
            await loadAppData();
            setCurrentUser(sb.user);
            setAuthStatus("app");
            return;
          }
        }
      } catch (e) {}
      setAuthStatus("login");
    })();
  }, []);

  const loadAppData = async () => {
    try {
      const d = await sb.loadData();
      if (d) {
        if (d.svcs) setSvcs(d.svcs);
        if (d.sales) setSales(d.sales);
        if (d.sConf) setSConf(d.sConf);
        if (d.stockRows) setStockRows(d.stockRows);
        if (d.guides) setGuides(d.guides);
        if (d.cl) setCl(d.cl);
        if (d.custs) setCusts(d.custs);
        if (d.logs) setLogs(d.logs);
        if (typeof d.dk === "boolean") setDk(d.dk);
        if (d.tgts) setTgts(d.tgts);
        if (d.commR !== undefined) setCommR(d.commR);
        if (d.cmts) setCmts(d.cmts);
        if (d.exps) setExps(d.exps);
        if (d.tasks) setTasks(d.tasks);
        if (d.bundles) setBundles(d.bundles);
        if (d.feedback) setFeedback(d.feedback);
        if (d.waTemplates) setWaTemplates(d.waTemplates);
        if (d.team) setTeam(d.team);
      }
    } catch (e) {}
    setLoaded(true);
  };

  // ═══ AUTO-SAVE TO SUPABASE ═══
  useEffect(() => {
    if (!loaded || authStatus !== "app") return;
    setSyncStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const r = await sb.saveData({ svcs, sales, sConf, stockRows, guides, cl, custs, logs, dk, tgts, commR, cmts, exps, tasks, bundles, feedback, waTemplates, team });
      setSyncStatus(r.ok ? "saved" : "error");
    }, 1500);
  }, [svcs, sales, sConf, stockRows, guides, cl, custs, logs, dk, tgts, commR, cmts, exps, tasks, bundles, feedback, waTemplates, team, loaded, authStatus]);

  // ═══ KEYBOARD SHORTCUTS ═══
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (authStatus !== "app") return;
      if (e.key === "n" && svcNames.length > 0) {
        setNewSale({ service: svcNames[0], customer: "", customerPhone: "", customerEmail: "", period: 1, price: 0, costPrice: 0, currency: "EGP", soldDate: gn(), notes: "", assignedTo: null });
        setTab("sales_entry");
      }
      if (e.key === "z" && e.ctrlKey && undoStack.length > 0) {
        const last = undoStack[undoStack.length - 1];
        setSales(p => [last, ...p]);
        setUndoStack(p => p.slice(0, -1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [authStatus, svcNames, undoStack]);

  const addLog = (action) => {
    const entry = { id: Date.now(), user: cU ? cU.name : "Sys", action, time: new Date().toISOString() };
    setLogs(p => [entry, ...p].slice(0, 200));
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
      await loadAppData();
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
      await loadAppData();
      setAuthStatus("app");
    } else {
      const msg = (r.data && (r.data.error_description || r.data.msg || r.data.error)) || "Invalid credentials";
      setAuthError(msg);
    }
  };

  const handleSignOut = async () => {
    await sb.signOut();
    setCurrentUser(null);
    setAuthStatus("login");
    setAuthEmail("");
    setAuthPassword("");
    setLoaded(false);
    setTab("dashboard");
  };

  // ═══ BUSINESS LOGIC ═══
  const validate = (s) => {
    if (!s.customer || !s.customer.trim()) return "Customer name required";
    if (!s.price || s.price <= 0) return "Price must be > 0";
    return null;
  };

  const ensureCust = (name, phone) => {
    if (!name) return;
    const nm = name.trim().toLowerCase();
    const ex = custs.find(c => c.name.toLowerCase() === nm);
    if (ex) {
      if (phone && phone !== ex.phone) setCusts(p => p.map(c => c.id === ex.id ? { ...c, phone } : c));
      return;
    }
    setCusts(p => [...p, { id: Date.now(), name: name.trim(), phone: phone || "", createdDate: gn() }]);
  };

  // SERVICES
  const addSvc = () => {
    const n = nSvcN.trim();
    if (!n || svcNames.includes(n)) return;
    setSvcs(p => [...p, { name: n, icon: nSvcI }]);
    addLog("Added service: " + n);
    setNSvcN(""); setNSvcI("📦");
  };
  const rmSvc = (n) => {
    if (!confirm("Delete " + n + "?")) return;
    setSvcs(p => p.filter(s => s.name !== n));
    setSales(p => p.filter(a => a.service !== n));
    addLog("Deleted: " + n);
  };

  // STOCK LINKING
  const findAvailableAccount = (product) => stockRows.find(r => r.product === product && !r.sold);
  const assignStockToSale = (saleId, stockRowId) => {
    setStockRows(p => p.map(r => r.id === stockRowId ? { ...r, sold: true, linkedSaleId: saleId } : r));
    setSales(p => p.map(s => s.id === saleId ? { ...s, linkedStockId: stockRowId } : s));
  };
  const unlinkStockFromSale = (saleId) => {
    const sale = sales.find(s => s.id === saleId);
    if (!sale || !sale.linkedStockId) return;
    setStockRows(p => p.map(r => r.id === sale.linkedStockId ? { ...r, sold: false, linkedSaleId: null } : r));
    setSales(p => p.map(s => s.id === saleId ? { ...s, linkedStockId: null } : s));
    addLog("🔓 Unlinked account from " + sale.customer);
  };

  // SALES CRUD
  const addSaleEntry = () => {
    if (!newSale) return;
    const err = validate(newSale);
    if (err) { alert(err); return; }
    const rD = newSale.period > 0 ? amo(newSale.soldDate || gn(), newSale.period) : newSale.period === -1 ? "2099-12-31" : newSale.soldDate || gn();
    const pe = toEgp(newSale.price, newSale.currency || "EGP");
    const ce = toEgp(newSale.costPrice || 0, newSale.currency || "EGP");
    const saleId = Date.now();
    const available = findAvailableAccount(newSale.service);
    const entry = {
      ...newSale, id: saleId, done: false, followUp: false,
      renewDate: rD, checklist: cl.map(c => ({ label: c, checked: false })),
      soldBy: cU ? cU.name : "?", createdDate: gn(), priceEGP: pe, costEGP: ce,
      customerEmail: newSale.customerEmail || "",
      paymentProof: null, proofStatus: "none",
      linkedStockId: available ? available.id : null
    };
    ensureCust(entry.customer, entry.customerPhone);
    setSales(p => [entry, ...p]);
    if (available) {
      setStockRows(p => p.map(r => r.id === available.id ? { ...r, sold: true, linkedSaleId: saleId } : r));
      addLog("Sale: " + entry.customer + " " + entry.service + " (linked " + available.email + ")");
    } else {
      addLog("Sale: " + entry.customer + " " + entry.service);
    }
    setNewSale(null);
  };

  const toggleDone = (id) => {
    const a = sales.find(x => x.id === id);
    if (!a) return;
    setSales(p => p.map(x => x.id === id ? { ...x, done: !x.done } : x));
    addLog((!a.done ? "Done" : "Undo") + ": " + a.customer);
  };
  const toggleFollow = (id) => setSales(p => p.map(x => x.id === id ? { ...x, followUp: !x.followUp } : x));
  const deleteSale = (id) => {
    const a = sales.find(x => x.id === id);
    if (a) {
      setUndoStack(p => [...p, a].slice(-20));
      if (a.linkedStockId) setStockRows(p => p.map(r => r.id === a.linkedStockId ? { ...r, sold: false, linkedSaleId: null } : r));
    }
    setSales(p => p.filter(x => x.id !== id));
    if (selSale && selSale.id === id) setSelSale(null);
    if (a) addLog("Deleted: " + a.customer);
  };

  const updateCL = (id, idx) => {
    setSales(p => p.map(a => {
      if (a.id !== id) return a;
      const nc = a.checklist.map((x, i) => i === idx ? { ...x, checked: !x.checked } : x);
      const item = a.checklist[idx];
      if (item && item.label.toLowerCase().includes("payment") && !item.checked) {
        addLog("💳 Payment confirmed: " + a.customer);
      }
      return { ...a, checklist: nc };
    }));
  };

  const saveEditSale = () => {
    if (!editSale) return;
    const err = validate(editSale);
    if (err) { alert(err); return; }
    const rD = editSale.period > 0 ? amo(editSale.soldDate || editSale.createdDate, editSale.period) : editSale.period === -1 ? "2099-12-31" : editSale.soldDate || editSale.createdDate;
    const pe = toEgp(editSale.price, editSale.currency || "EGP");
    const ce = toEgp(editSale.costPrice || 0, editSale.currency || "EGP");
    ensureCust(editSale.customer, editSale.customerPhone);
    setSales(p => p.map(a => a.id === editSale.id ? { ...editSale, renewDate: rD, priceEGP: pe, costEGP: ce } : a));
    setEditSale(null);
  };

  const renewSale = (s) => {
    setNewSale({
      service: s.service, customer: s.customer, customerPhone: s.customerPhone,
      period: s.period, price: s.price, costPrice: s.costPrice || 0,
      currency: s.currency || "EGP", soldDate: gn(), notes: "Renewal"
    });
    setTab("sales_entry");
  };

  const addComment = (saleId) => {
    if (!newCmt.trim()) return;
    const c = { user: cU ? cU.name : "?", text: newCmt.trim(), time: new Date().toISOString() };
    setCmts(p => ({ ...p, [saleId]: [...(p[saleId] || []), c] }));
    setNewCmt("");
  };

  // PAYMENT PROOF
  const uploadProof = (saleId, file) => {
    if (!file) return;
    const ok = ["image/jpeg", "image/jpg", "image/png", "application/pdf"];
    if (!ok.includes(file.type)) { alert("Only JPG, PNG, or PDF allowed"); return; }
    if (file.size > 5 * 1024 * 1024) { alert("File too large (max 5MB)"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const proof = { data: e.target.result, name: file.name, type: file.type, size: file.size, uploadedBy: cU ? cU.name : "?", uploadedAt: new Date().toISOString() };
      setSales(p => p.map(s => s.id === saleId ? { ...s, paymentProof: proof, proofStatus: "pending" } : s));
      addLog("📎 Proof uploaded: " + file.name);
      setProofModal(null);
    };
    reader.readAsDataURL(file);
  };
  const approveProof = (saleId) => {
    setSales(p => p.map(s => s.id === saleId ? { ...s, proofStatus: "approved" } : s));
    const a = sales.find(x => x.id === saleId);
    if (a) addLog("✅ Proof approved: " + a.customer);
  };
  const rejectProof = (saleId) => {
    if (!confirm("Reject this payment proof?")) return;
    setSales(p => p.map(s => s.id === saleId ? { ...s, proofStatus: "rejected" } : s));
  };
  const removeProof = (saleId) => {
    if (!confirm("Remove this proof?")) return;
    setSales(p => p.map(s => s.id === saleId ? { ...s, paymentProof: null, proofStatus: "none" } : s));
  };

  // BULK
  const bulkDone = () => { setSales(p => p.map(a => selBulk.includes(a.id) ? { ...a, done: true } : a)); addLog("Bulk done: " + selBulk.length); setSelBulk([]); };
  const bulkDel = () => { if (!confirm("Delete " + selBulk.length + "?")) return; setSales(p => p.filter(a => !selBulk.includes(a.id))); addLog("Bulk delete"); setSelBulk([]); };

  // GUIDES
  const addGuide = () => { if (!newGuide) return; setGuides(p => [...p, { ...newGuide, id: Date.now() }]); setNewGuide(null); };
  const deleteGuide = (id) => setGuides(p => p.filter(g => g.id !== id));
  const saveEditGuide = () => { if (!editGuide) return; setGuides(p => p.map(g => g.id === editGuide.id ? editGuide : g)); setEditGuide(null); };

  // EXPENSES
  const addExpense = () => {
    if (!newExp || !newExp.amount || newExp.amount <= 0) return;
    setExps(p => [{ ...newExp, id: Date.now(), date: newExp.date || gn() }, ...p]);
    addLog("Expense: " + newExp.category + " " + newExp.amount);
    setNewExp(null);
  };

  // TASKS
  const addTask = () => {
    if (!newTask || !newTask.title) return;
    const t = { ...newTask, id: Date.now(), status: "pending", createdBy: cU ? cU.name : "Admin", createdAt: gn() };
    setTasks(p => [t, ...p]);
    addLog("Task: " + t.title);
    setNewTask(null);
  };
  const toggleTask = (id) => {
    setTasks(p => p.map(t => {
      if (t.id !== id) return t;
      const ns = t.status === "pending" ? "done" : "pending";
      return { ...t, status: ns, completedAt: ns === "done" ? gn() : null };
    }));
  };
  const delTask = (id) => setTasks(p => p.filter(t => t.id !== id));
  const overdueTasks = useMemo(() => tasks.filter(t => t.status === "pending" && t.deadline && t.deadline < gn()), [tasks]);

  // BUNDLES
  const addBundle = () => {
    if (!newBundle || !newBundle.name || !newBundle.services || newBundle.services.length < 2) { alert("Bundle needs a name and at least 2 services"); return; }
    if (!svcNames.includes(newBundle.name + " (Bundle)")) setSvcs(p => [...p, { name: newBundle.name + " (Bundle)", icon: "📦" }]);
    setBundles(p => [...p, { ...newBundle, id: Date.now() }]);
    addLog("Bundle: " + newBundle.name);
    setNewBundle(null);
  };
  const delBundle = (id) => {
    const b = bundles.find(x => x.id === id);
    setBundles(p => p.filter(x => x.id !== id));
    if (b) setSvcs(p => p.filter(s => s.name !== b.name + " (Bundle)"));
  };
  const sellBundle = (bundle) => {
    setNewSale({ service: bundle.name + " (Bundle)", customer: "", customerPhone: "", period: bundle.period || 1, price: bundle.price || 0, costPrice: bundle.cost || 0, currency: "EGP", soldDate: gn(), notes: "Includes: " + bundle.services.join(", ") });
    setTab("sales_entry");
  };

  // FEEDBACK
  const submitFeedback = (saleId, rating) => {
    setFeedback(p => ({ ...p, [saleId]: { rating, time: new Date().toISOString(), by: cU ? cU.name : "?" } }));
    if (rating <= 2) {
      setSales(p => p.map(s => s.id === saleId ? { ...s, followUp: true } : s));
    }
    setShowRate(null);
  };

  // WA TEMPLATES
  const renderTemplate = (text, sale) => {
    if (!sale) return text;
    const days = sale.renewDate ? dl(sale.renewDate) : "";
    return (text || "")
      .replace(/\{customer\}/g, sale.customer || "")
      .replace(/\{service\}/g, sale.service || "")
      .replace(/\{price\}/g, sale.price || "")
      .replace(/\{currency\}/g, sale.currency || "EGP")
      .replace(/\{period\}/g, PER_LABEL(sale.period || 0))
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
  const deleteTemplate = (id) => { if (!confirm("Delete?")) return; setWaTemplates(p => p.filter(t => t.id !== id)); };

  // TEAM MEMBERS
  const addMember = () => {
    if (!newMember || !newMember.name.trim()) { alert("Name is required"); return; }
    const m = { ...newMember, id: Date.now(), name: newMember.name.trim(), createdAt: gn() };
    setTeam(p => [...p, m]);
    addLog("👤 Added team member: " + m.name);
    setNewMember(null);
  };
  const saveMember = () => {
    if (!editMember || !editMember.name.trim()) return;
    setTeam(p => p.map(m => m.id === editMember.id ? { ...editMember } : m));
    addLog("👤 Updated member: " + editMember.name);
    setEditMember(null);
  };
  const deleteMember = (id) => {
    const m = team.find(x => x.id === id);
    if (!m) return;
    if (!confirm("Delete " + m.name + "? Their past sales will remain but show 'Unknown'.")) return;
    setTeam(p => p.filter(x => x.id !== id));
    addLog("👤 Removed member: " + m.name);
  };

  // COMMISSION REPORT LOGIC
  const commissionPeriodRange = useMemo(() => {
    const n = new Date();
    if (commissionPeriod === "thisMonth") return gmr(n);
    if (commissionPeriod === "lastMonth") {
      const prev = new Date(n.getFullYear(), n.getMonth() - 1, 1);
      return gmr(prev);
    }
    if (commissionPeriod === "thisYear") return { s: n.getFullYear() + "-01-01", e: n.getFullYear() + "-12-31" };
    if (commissionPeriod === "allTime") return { s: "2000-01-01", e: "2099-12-31" };
    return gmr(n);
  }, [commissionPeriod]);

  const commissionReport = useMemo(() => {
    const { s, e } = commissionPeriodRange;
    const inRange = (d) => d >= s && d <= e;
    return team.map(m => {
      const memberSales = sales.filter(a => a.done && a.assignedTo === m.id && inRange(a.soldDate));
      const revenue = memberSales.reduce((sum, a) => sum + (a.priceEGP || a.price || 0), 0);
      const cost = memberSales.reduce((sum, a) => sum + (a.costEGP || a.costPrice || 0), 0);
      const profit = revenue - cost;
      const rate = m.commissionRate || 0;
      const base = m.commissionBase || "revenue"; // revenue | profit | fixed
      let commission = 0;
      if (base === "revenue") commission = Math.round(revenue * rate / 100);
      else if (base === "profit") commission = Math.round(profit * rate / 100);
      else if (base === "fixed") commission = memberSales.length * rate;
      return { ...m, salesCount: memberSales.length, revenue, profit, commission, sales: memberSales };
    });
  }, [team, sales, commissionPeriodRange]);

  const totalCommissions = useMemo(() => commissionReport.reduce((s, m) => s + m.commission, 0), [commissionReport]);

  // BACKUP
  const backupAll = () => {
    const backup = {
      version: "1.0", exportedAt: new Date().toISOString(), exportedBy: cU ? cU.name : "Unknown",
      data: { svcs, sales, sConf, stockRows, guides, cl, custs, logs, tgts, commR, cmts, exps, tasks, bundles, feedback, waTemplates, team }
    };
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "proskill_backup_" + gn() + ".json"; a.click();
    URL.revokeObjectURL(url);
    addLog("💾 Backup exported");
  };
  const restoreBackup = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const backup = JSON.parse(e.target.result);
        if (!backup.data) { alert("Invalid backup"); return; }
        if (!confirm("⚠️ This will REPLACE all current data. Continue?")) return;
        const d = backup.data;
        if (d.svcs) setSvcs(d.svcs);
        if (d.sales) setSales(d.sales);
        if (d.sConf) setSConf(d.sConf);
        if (d.stockRows) setStockRows(d.stockRows);
        if (d.guides) setGuides(d.guides);
        if (d.cl) setCl(d.cl);
        if (d.custs) setCusts(d.custs);
        if (d.logs) setLogs(d.logs);
        if (d.tgts) setTgts(d.tgts);
        if (d.commR !== undefined) setCommR(d.commR);
        if (d.cmts) setCmts(d.cmts);
        if (d.exps) setExps(d.exps);
        if (d.tasks) setTasks(d.tasks);
        if (d.bundles) setBundles(d.bundles);
        if (d.feedback) setFeedback(d.feedback);
        if (d.waTemplates) setWaTemplates(d.waTemplates);
        if (d.team) setTeam(d.team);
        alert("✅ Backup restored!");
        setShowBackup(false);
      } catch (err) { alert("Failed: " + err.message); }
    };
    reader.readAsText(file);
  };

  // STOCK ROWS
  const toggleStockSold = useCallback((id) => {
    setStockRows(p => p.map(r => r.id === id ? { ...r, sold: !r.sold } : r));
  }, []);
  const deleteStockRow = (id) => { if (!confirm("Delete?")) return; setStockRows(p => p.filter(r => r.id !== id)); };
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

  // ═══ COMPUTED STATS ═══
  const stockStatsByProduct = useMemo(() => {
    const s = {};
    svcNames.forEach(p => {
      const all = stockRows.filter(r => r.product === p);
      s[p] = { avail: all.filter(r => !r.sold).length, sold: all.filter(r => r.sold).length, total: all.length };
    });
    return s;
  }, [stockRows, svcNames]);

  const allDone = useMemo(() => sales.filter(a => a.done), [sales]);
  const doneSales = allDone;
  const mySales = sales;

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
    return { byS, tR: v.reduce((a, b) => a + b.rev, 0), tP: v.reduce((a, b) => a + b.pft, 0), tS: v.reduce((a, b) => a + b.sold, 0), tA: v.reduce((a, b) => a + b.avl, 0) };
  }, [svcNames, sConf, stockStatsByProduct]);

  const myStats = useMemo(() => calcStats(mySales), [mySales, calcStats]);
  const allStats = myStats;

  const monthExps = useMemo(() => {
    const mr = gmr(new Date());
    return exps.filter(e => e.date >= mr.s && e.date <= mr.e).reduce((s, e) => s + (e.amount || 0), 0);
  }, [exps]);
  const totalExps = useMemo(() => exps.reduce((s, e) => s + (e.amount || 0), 0), [exps]);
  const netProfit = allStats.tP - totalExps;

  const mrr = useMemo(() => {
    const act = sales.filter(a => a.done && dl(a.renewDate) > 0);
    const mo = act.reduce((s, a) => s + ((a.priceEGP || a.price || 0) / (a.period || 1)), 0);
    const ch = sales.filter(a => a.done && dl(a.renewDate) < 0).length;
    const cr = allDone.length > 0 ? Math.round(ch / allDone.length * 100) : 0;
    return { cur: Math.round(mo), cr, arr: Math.round(mo * 12), ac: act.length };
  }, [sales, allDone]);

  const moCmp = useMemo(() => {
    const n = new Date();
    const mr = gmr(n);
    const prev = new Date(n.getFullYear(), n.getMonth() - 1, 1);
    const pmr = gmr(prev);
    const curS = allDone.filter(a => a.soldDate >= mr.s && a.soldDate <= mr.e);
    const prevS = allDone.filter(a => a.soldDate >= pmr.s && a.soldDate <= pmr.e);
    const curR = curS.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
    const prevR = prevS.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
    const growth = prevR > 0 ? Math.round((curR - prevR) / prevR * 100) : 0;
    return { curC: curS.length, prevC: prevS.length, curR, prevR, growth };
  }, [allDone]);

  const forecast = useMemo(() => {
    const act = sales.filter(a => a.done && dl(a.renewDate) > 0);
    const moRev = act.reduce((s, a) => s + ((a.priceEGP || a.price || 0) / (a.period || 1)), 0);
    return [1, 2, 3].map(m => {
      const d = new Date(); d.setMonth(d.getMonth() + m);
      const rn = act.filter(a => dl(a.renewDate) > 0 && dl(a.renewDate) <= m * 30);
      return { month: MN[d.getMonth()], rev: Math.round(moRev), renewals: rn.length };
    });
  }, [sales]);

  // ADOBE MONTHLY SCHEDULE
  const adobeSchedule = useMemo(() => {
    const schedule = [];
    sales.filter(a => a.done && a.service === "Adobe" && a.period > 0).forEach(a => {
      const soldDate = a.soldDate || a.createdDate;
      const renewed = a.adobeRenewed || {};
      for (let m = 1; m <= a.period; m++) {
        const renewDate = amo(soldDate, m);
        const days = dl(renewDate);
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
          isOverdue: !isRenewed && days < 0
        });
      }
    });
    return schedule.sort((a, b) => a.daysUntil - b.daysUntil);
  }, [sales]);

  const adobePendingReminders = useMemo(() => adobeSchedule.filter(a => a.needsReminder), [adobeSchedule]);
  const adobeOverdue = useMemo(() => adobeSchedule.filter(a => a.isOverdue), [adobeSchedule]);
  const adobeUpcoming = useMemo(() => adobeSchedule.filter(a => a.status === "Pending"), [adobeSchedule]);

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

  const alerts = useMemo(() => {
    const t = gn();
    const tmr = tds(new Date(Date.now() + 864e5));
    const rn = sales.filter(a => a.done && a.renewDate && (a.renewDate === t || a.renewDate === tmr));
    const ex = sales.filter(a => a.done && a.renewDate && dl(a.renewDate) < 0);
    const pp = sales.filter(a => {
      const pi = a.checklist ? a.checklist.find(c => c.label.toLowerCase().includes("payment")) : null;
      return pi && !pi.checked;
    });
    const fu = sales.filter(a => a.followUp);
    const pendingProofs = sales.filter(a => a.proofStatus === "pending");
    const os = svcNames.filter(s => { const st = stockStatsByProduct[s] || { avail: 0, total: 0 }; return st.total > 0 && st.avail === 0; });
    const allN = [];
    ex.forEach(a => allN.push({ id: "e" + a.id, t: "danger", m: "🚨 " + a.customer + " EXPIRED" }));
    rn.forEach(a => allN.push({ id: "r" + a.id, t: "warn", m: "⏰ " + a.customer + " renews " + (a.renewDate === t ? "TODAY" : "TOMORROW") }));
    adobePendingReminders.forEach(a => allN.push({ id: "ad" + a.alertId, t: "warn", m: "🎨 Adobe: " + a.customer + " month " + a.monthIndex + "/" + a.totalMonths }));
    adobeOverdue.forEach(a => allN.push({ id: "ov" + a.alertId, t: "danger", m: "🎨 OVERDUE: " + a.customer + " month " + a.monthIndex }));
    pendingProofs.forEach(a => allN.push({ id: "pp" + a.id, t: "warn", m: "📎 Proof pending: " + a.customer }));
    fu.forEach(a => allN.push({ id: "f" + a.id, t: "warn", m: "📞 " + a.customer }));
    os.forEach(s => allN.push({ id: "o" + s, t: "danger", m: "📦 " + s + " out of stock!" }));
    return { rn, ex, pp, fu, os, pendingProofs, allN };
  }, [sales, svcNames, stockStatsByProduct, adobePendingReminders, adobeOverdue]);

  const unseenN = useMemo(() => alerts.allN.filter(n => !seenN.includes(n.id)), [alerts.allN, seenN]);

  // TIME SERIES
  const calcTime = useCallback((sl) => {
    const n = new Date();
    const t = gn();
    const wR = gwr(n);
    const mR = gmr(n);
    const inR = (d, s, e) => d >= s && d <= e;
    const calc = (arr) => ({ count: arr.length, rev: arr.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) });
    const wtdD = gdr(wR.s, t).map(day => {
      const a = sl.filter(x => x.soldDate === day);
      const d = new Date(day);
      return { label: DN[d.getDay()], count: a.length, rev: a.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) };
    });
    const mtdD = gdr(mR.s, t).map(day => {
      const a = sl.filter(x => x.soldDate === day);
      const d = new Date(day);
      return { label: "" + d.getDate(), count: a.length, rev: a.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) };
    });
    const ytdM = [];
    for (let m = 0; m <= n.getMonth(); m++) {
      const ms = n.getFullYear() + "-" + String(m + 1).padStart(2, "0") + "-01";
      const me = tds(new Date(n.getFullYear(), m + 1, 0));
      const f = sl.filter(a => a.soldDate && inR(a.soldDate, ms, me));
      ytdM.push({ label: MN[m], count: f.length, rev: f.reduce((s, x) => s + (x.priceEGP || x.price || 0), 0) });
    }
    return {
      daily: calc(sl.filter(a => a.soldDate === t)),
      weekly: calc(sl.filter(a => a.soldDate && inR(a.soldDate, wR.s, wR.e))),
      monthly: calc(sl.filter(a => a.soldDate && inR(a.soldDate, mR.s, mR.e))),
      yearly: calc(sl.filter(a => a.soldDate && a.soldDate.startsWith("" + n.getFullYear()))),
      wtdD, mtdD, ytdM
    };
  }, []);
  const myTime = useMemo(() => calcTime(doneSales), [doneSales, calcTime]);
  const allTime = myTime;

  // CUSTOMER HEALTH
  const custHealth = useCallback((name) => {
    const cs = sales.filter(a => a.customer && a.customer.toLowerCase() === name.toLowerCase());
    if (!cs.length) return { s: 50, c: "#94a3b8", l: "New" };
    let sc = 50;
    const d = cs.filter(a => a.done);
    if (d.length > 0) sc += 15;
    if (d.length > 2) sc += 10;
    if (cs.some(a => a.followUp)) sc -= 20;
    if (cs.some(a => a.done && dl(a.renewDate) < 0)) sc -= 25;
    sc = Math.max(0, Math.min(100, sc));
    return { s: sc, c: sc >= 70 ? "#16a34a" : sc >= 40 ? "#f59e0b" : "#dc2626", l: sc >= 70 ? "Healthy" : sc >= 40 ? "At Risk" : "Critical" };
  }, [sales]);

  const custList = useMemo(() => {
    return custs.map(c => {
      const cs = sales.filter(a => a.customer && a.customer.toLowerCase() === c.name.toLowerCase());
      const d = cs.filter(a => a.done);
      const tv = d.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
      return { ...c, tS: d.length, tV: tv, aS: cs.filter(a => a.done && dl(a.renewDate) > 0).length, all: cs, h: custHealth(c.name) };
    }).sort((a, b) => b.tV - a.tV);
  }, [custs, sales, custHealth]);

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

  // FILTERED SALES
  const filtSales = useMemo(() => {
    let sl = sales;
    if (search) {
      const s = search.toLowerCase();
      sl = sl.filter(a => (a.customer || "").toLowerCase().includes(s) || (a.customerPhone || "").includes(s) || (a.customerEmail || "").toLowerCase().includes(s) || (a.service || "").toLowerCase().includes(s) || (a.notes || "").toLowerCase().includes(s));
    }
    if (salesFilterProd !== "all") sl = sl.filter(a => a.service === salesFilterProd);
    if (salesFilterPhone) {
      const p = salesFilterPhone.replace(/[^0-9]/g, "");
      if (p) sl = sl.filter(a => (a.customerPhone || "").replace(/[^0-9]/g, "").includes(p));
    }
    if (dFrom) sl = sl.filter(a => a.soldDate >= dFrom);
    if (dTo) sl = sl.filter(a => a.soldDate <= dTo);
    if (aF === "pending") sl = sl.filter(a => !a.done);
    if (aF === "done") sl = sl.filter(a => a.done);
    if (aF === "followup") sl = sl.filter(a => a.followUp);
    if (aF === "cancelled") sl = sl.filter(a => a.proofStatus === "rejected");
    if (aF === "approved") sl = sl.filter(a => a.done && a.proofStatus === "approved");
    return sl;
  }, [sales, search, dFrom, dTo, aF, salesFilterProd, salesFilterPhone]);

  // STOCK FILTERED
  const stockFiltered = useMemo(() => {
    let r = stockRows;
    if (stockFilterProd !== "all") r = r.filter(x => x.product === stockFilterProd);
    if (stockView === "available") r = r.filter(x => !x.sold);
    if (stockView === "sold") r = r.filter(x => x.sold);
    if (stockSearch) {
      const s = stockSearch.toLowerCase();
      r = r.filter(x => (x.email || "").toLowerCase().includes(s) || (x.product || "").toLowerCase().includes(s) || (x.note || "").toLowerCase().includes(s));
    }
    return r;
  }, [stockRows, stockView, stockFilterProd, stockSearch]);

  const stockTotalAvail = stockRows.filter(r => !r.sold).length;
  const stockTotalSold = stockRows.filter(r => r.sold).length;

  // ═══ THEME ═══
  const bg = dk ? "#0f172a" : "#f5f7f9";
  const cbg = dk ? "#1e293b" : "#fff";
  const tx = dk ? "#e2e8f0" : "#1a2e44";
  const tx2 = dk ? "#94a3b8" : "#64748b";
  const bd = dk ? "#334155" : "#e8ebe9";

  const C = { background: cbg, borderRadius: 10, padding: "12px 14px", boxShadow: dk ? "none" : "0 1px 2px rgba(0,0,0,0.04)", border: "1px solid " + bd };
  const BP = { background: "#2a9d8f", color: "#fff", border: "none", borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontWeight: 600, fontSize: 10 };
  const BD = { ...BP, background: "#ef4444" };
  const BG = { ...BP, background: "transparent", color: "#2a9d8f", border: "1px solid #2a9d8f" };
  const IN = { border: "1px solid " + (dk ? "#475569" : "#d1d9e0"), borderRadius: 7, padding: "5px 9px", fontSize: 11, width: "100%", boxSizing: "border-box", outline: "none", background: dk ? "#334155" : "#fff", color: tx };
  const badge = (done) => ({ display: "inline-block", padding: "1px 7px", borderRadius: 12, fontSize: 8, fontWeight: 700, background: done ? "#fef2f2" : "#e8f4f2", color: done ? "#dc2626" : "#2a9d8f" });

  const visTabs = [
    { id: "dashboard", l: "Dashboard", ic: "📊" },
    { id: "mrr", l: "MRR", ic: "💹" },
    { id: "services", l: "Services", ic: "⚙️" },
    { id: "sales_entry", l: "Sales", ic: "🔑" },
    { id: "bundles", l: "Bundles", ic: "📦" },
    { id: "customers", l: "Customers", ic: "👤" },
    { id: "adobe", l: "Adobe", ic: "🎨" },
    { id: "tasks", l: "Tasks", ic: "✅" },
    { id: "team", l: "Team", ic: "👥" },
    { id: "commission", l: "Commission", ic: "💰" },
    { id: "expenses", l: "Expenses", ic: "🧾" },
    { id: "stock", l: "Stock", ic: "📦" },
    { id: "reports", l: "Reports", ic: "📈" },
    { id: "logs", l: "Activity", ic: "📜" },
    { id: "guide", l: "Guide", ic: "📋" }
  ];

  // ═══ LOADING ═══
  if (authStatus === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui", background: "linear-gradient(135deg,#1a2e44,#2a9d8f)", color: "#fff" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 50, height: 50, borderRadius: 12, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 18, margin: "0 auto 12px" }}>PS</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>ProSkill</div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 6 }}>Connecting to cloud...</div>
        </div>
      </div>
    );
  }

  // ═══ LOGIN ═══
  if (authStatus === "login") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "'Inter',system-ui,sans-serif", background: "linear-gradient(135deg,#1a2e44,#2a9d8f)", padding: 16 }}>
        <div style={{ background: "#fff", borderRadius: 14, padding: 32, width: "100%", maxWidth: 360, textAlign: "center", boxShadow: "0 16px 48px rgba(0,0,0,0.3)" }}>
          <div style={{ width: 48, height: 48, borderRadius: 10, background: "#2a9d8f", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16, color: "#fff", margin: "0 auto 10px" }}>PS</div>
          <h2 style={{ margin: "0 0 2px", fontSize: 20, color: "#1a2e44" }}>ProSkill</h2>
          <p style={{ margin: "0 0 8px", fontSize: 10, color: "#2a9d8f", fontWeight: 600, letterSpacing: 2 }}>DIGITAL AGENCY</p>
          <p style={{ margin: "0 0 18px", fontSize: 9, color: "#94a3b8" }}>☁️ Cloud-powered · Syncs everywhere</p>
          <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "#f5f7f9", borderRadius: 8, padding: 3 }}>
            <button onClick={() => { setAuthMode("login"); setAuthError(""); }} style={{ flex: 1, padding: 8, borderRadius: 6, border: "none", cursor: "pointer", background: authMode === "login" ? "#fff" : "transparent", color: "#1a2e44", fontWeight: authMode === "login" ? 700 : 400, fontSize: 12 }}>Sign In</button>
            <button onClick={() => { setAuthMode("signup"); setAuthError(""); }} style={{ flex: 1, padding: 8, borderRadius: 6, border: "none", cursor: "pointer", background: authMode === "signup" ? "#fff" : "transparent", color: "#1a2e44", fontWeight: authMode === "signup" ? 700 : 400, fontSize: 12 }}>Create Account</button>
          </div>
          {authError && <div style={{ background: "#fef2f2", color: "#dc2626", padding: "8px 10px", borderRadius: 6, fontSize: 11, marginBottom: 10 }}>{authError}</div>}
          <input type="email" placeholder="Email address" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} style={{ ...IN, background: "#fff", color: "#1a2e44", marginBottom: 8, padding: "10px 12px", fontSize: 13 }} onKeyDown={(e) => { if (e.key === "Enter") authMode === "login" ? handleSignIn() : handleSignUp(); }} />
          <input type="password" placeholder="Password (min 6 chars)" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} style={{ ...IN, background: "#fff", color: "#1a2e44", marginBottom: 16, padding: "10px 12px", fontSize: 13 }} onKeyDown={(e) => { if (e.key === "Enter") authMode === "login" ? handleSignIn() : handleSignUp(); }} />
          <button onClick={authMode === "login" ? handleSignIn : handleSignUp} disabled={authLoading} style={{ ...BP, width: "100%", padding: "11px", fontSize: 13, opacity: authLoading ? 0.7 : 1 }}>
            {authLoading ? "..." : authMode === "login" ? "Sign In →" : "Create Account →"}
          </button>
          <p style={{ margin: "12px 0 0", fontSize: 9, color: "#94a3b8" }}>
            {authMode === "signup" ? "Data syncs across all devices." : "Sign in from any device."}
          </p>
        </div>
      </div>
    );
  }

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

  // ═══ MAIN APP RENDER ═══
  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", height: "100vh", fontFamily: "'Inter',system-ui,sans-serif", background: bg, overflow: "hidden", color: tx }}>

      {/* SIDEBAR */}
      {!isMobile && (
        <div style={{ width: sideO ? 185 : 44, background: "#1a2e44", color: "#fff", display: "flex", flexDirection: "column", transition: "width 0.2s", flexShrink: 0, overflow: "hidden" }}>
          <div style={{ padding: sideO ? "12px 10px 4px" : "12px 6px 4px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => setSideO(!sideO)}>
            <div style={{ width: 24, height: 24, borderRadius: 6, background: "#2a9d8f", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 9, color: "#fff", flexShrink: 0 }}>PS</div>
            {sideO && (<div><span style={{ fontWeight: 700, fontSize: 11, display: "block" }}>ProSkill</span><span style={{ fontSize: 6, color: "#2a9d8f", fontWeight: 600, letterSpacing: 1 }}>DIGITAL AGENCY</span></div>)}
          </div>
          {sideO && (
            <div style={{ padding: "0 10px 4px", display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: syncStatus === "saved" ? "#16a34a" : syncStatus === "saving" ? "#f59e0b" : "#dc2626" }} />
              <span style={{ fontSize: 8, color: syncStatus === "saved" ? "#16a34a" : syncStatus === "saving" ? "#f59e0b" : "#dc2626" }}>
                {syncStatus === "saved" ? "☁️ Synced" : syncStatus === "saving" ? "Saving..." : "Sync error"}
              </span>
            </div>
          )}
          <div style={{ flex: 1, padding: "3px 0", overflowY: "auto" }}>
            {visTabs.map(t => (
              <div key={t.id} onClick={() => setTab(t.id)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", cursor: "pointer", background: tab === t.id ? "rgba(42,157,143,0.15)" : "transparent", borderRight: tab === t.id ? "2px solid #2a9d8f" : "2px solid transparent", color: tab === t.id ? "#fff" : "#94a3b8", fontSize: 10, fontWeight: tab === t.id ? 600 : 400 }}>
                <span style={{ fontSize: 12, flexShrink: 0 }}>{t.ic}</span>
                {sideO && <span>{t.l}</span>}
                {t.id === "reports" && sideO && unseenN.length > 0 && <span style={{ marginLeft: "auto", background: "#ef4444", color: "#fff", borderRadius: 6, padding: "0 4px", fontSize: 7, fontWeight: 700 }}>{unseenN.length}</span>}
                {t.id === "tasks" && sideO && overdueTasks.length > 0 && <span style={{ marginLeft: "auto", background: "#f59e0b", color: "#fff", borderRadius: 6, padding: "0 4px", fontSize: 7, fontWeight: 700 }}>{overdueTasks.length}</span>}
              </div>
            ))}
            {sideO && (
              <div onClick={() => setShowFU(true)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", cursor: "pointer", color: "#f59e0b", fontSize: 10, fontWeight: 600, borderTop: "1px solid rgba(255,255,255,0.05)", marginTop: 3 }}>
                <span style={{ fontSize: 12 }}>📞</span><span>Follow Up</span>
                {alerts.fu.length > 0 && <span style={{ marginLeft: "auto", background: "#f59e0b", color: "#fff", borderRadius: 6, padding: "0 4px", fontSize: 7, fontWeight: 700 }}>{alerts.fu.length}</span>}
              </div>
            )}
          </div>
          <div style={{ padding: "6px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
            {sideO && <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 4, wordBreak: "break-all" }}>{cU ? cU.name : ""}</div>}
            {sideO && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span onClick={() => setShowNotif(true)} style={{ cursor: "pointer", fontSize: 11, position: "relative" }}>🔔{unseenN.length > 0 && <span style={{ position: "absolute", top: -2, right: -3, background: "#ef4444", color: "#fff", borderRadius: 5, padding: "0 2px", fontSize: 6, fontWeight: 700 }}>{unseenN.length}</span>}</span>
                <span onClick={() => setDk(!dk)} style={{ cursor: "pointer", fontSize: 10 }}>{dk ? "☀️" : "🌙"}</span>
                <span onClick={() => setShowBackup(true)} style={{ cursor: "pointer", fontSize: 10 }} title="Backup">💾</span>
                <span onClick={() => { setShowTemplates({ sale: null }); }} style={{ cursor: "pointer", fontSize: 10 }} title="WA Templates">💬</span>
                <span onClick={handleSignOut} style={{ fontSize: 8, color: "#94a3b8", cursor: "pointer" }}>Logout</span>
                {undoStack.length > 0 && <span onClick={() => { const l = undoStack[undoStack.length - 1]; setSales(p => [l, ...p]); setUndoStack(p => p.slice(0, -1)); }} style={{ fontSize: 8, color: "#f59e0b", cursor: "pointer" }}>↩ Undo</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MOBILE TOP BAR */}
      {isMobile && (
        <div style={{ background: "#1a2e44", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 22, height: 22, borderRadius: 5, background: "#2a9d8f", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 8, color: "#fff" }}>PS</div>
            <span style={{ color: "#fff", fontWeight: 700, fontSize: 12 }}>ProSkill</span>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: syncStatus === "saved" ? "#16a34a" : syncStatus === "saving" ? "#f59e0b" : "#dc2626", marginLeft: 4 }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span onClick={() => setShowNotif(true)} style={{ cursor: "pointer", fontSize: 14, color: "#fff", position: "relative" }}>🔔{unseenN.length > 0 && <span style={{ position: "absolute", top: -3, right: -4, background: "#ef4444", color: "#fff", borderRadius: 6, padding: "0 3px", fontSize: 7, fontWeight: 700 }}>{unseenN.length}</span>}</span>
            <span onClick={() => setShowFU(true)} style={{ cursor: "pointer", fontSize: 14, color: "#fff" }}>📞</span>
            <span onClick={() => setDk(!dk)} style={{ cursor: "pointer", fontSize: 12, color: "#fff" }}>{dk ? "☀️" : "🌙"}</span>
            <span onClick={handleSignOut} style={{ fontSize: 10, color: "#94a3b8", cursor: "pointer" }}>🚪</span>
          </div>
        </div>
      )}

      {/* MAIN */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>

        {/* NOTIFICATIONS MODAL */}
        {showNotif && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", justifyContent: "flex-end", zIndex: 999 }}>
            <div style={{ width: 300, background: cbg, height: "100%", overflow: "auto", padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>🔔 Notifications</h3>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setSeenN(alerts.allN.map(n => n.id))} style={{ ...BG, padding: "2px 6px", fontSize: 8 }}>Read all</button>
                  <span onClick={() => setShowNotif(false)} style={{ cursor: "pointer", fontSize: 14, color: tx2 }}>✕</span>
                </div>
              </div>
              {alerts.allN.length === 0 && <p style={{ fontSize: 10, color: tx2, textAlign: "center", padding: 14 }}>All clear!</p>}
              {alerts.allN.map(n => (
                <div key={n.id} style={{ padding: "5px 0", borderBottom: "1px solid " + bd, opacity: seenN.includes(n.id) ? 0.3 : 1 }}>
                  <p style={{ margin: 0, fontSize: 9, color: n.t === "danger" ? "#dc2626" : "#f59e0b" }}>{n.m}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* FOLLOW-UP MODAL */}
        {showFU && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
            <div style={{ ...C, padding: 16, width: 500, maxHeight: "80vh", overflow: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>📞 Follow Up ({alerts.fu.length})</h3>
                <span onClick={() => setShowFU(false)} style={{ cursor: "pointer", fontSize: 14, color: tx2 }}>✕</span>
              </div>
              {alerts.fu.length > 0 ? alerts.fu.map(a => (
                <div key={a.id} style={{ padding: "6px 0", borderBottom: "1px solid " + bd }}>
                  <div style={{ fontSize: 10, display: "flex", justifyContent: "space-between" }}>
                    <span><strong>{a.customer}</strong> · {a.customerPhone || "—"} · {a.service} · {a.price} {a.currency || "EGP"}</span>
                    {a.customerPhone && <a href={waLink(a.customerPhone, "Hi " + a.customer)} target="_blank" rel="noreferrer" style={{ ...BP, padding: "2px 6px", fontSize: 7, background: "#25D366", textDecoration: "none" }}>WA</a>}
                  </div>
                  {a.notes && <p style={{ margin: "2px 0 0", fontSize: 8, color: "#f59e0b" }}>📝 {a.notes}</p>}
                </div>
              )) : <p style={{ fontSize: 10, color: tx2 }}>None.</p>}
            </div>
          </div>
        )}

        {/* SALE DETAIL MODAL */}
        {selSale && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 998 }}>
            <div style={{ ...C, padding: 16, width: 380, maxHeight: "80vh", overflow: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>{svcIcon(selSale.service)} {selSale.service}</h3>
                <span onClick={() => setSelSale(null)} style={{ cursor: "pointer", fontSize: 14, color: tx2 }}>✕</span>
              </div>
              <div style={{ background: dk ? "#0f172a" : "#f5f7f9", borderRadius: 6, padding: 10, marginBottom: 8, fontSize: 10 }}>
                <p style={{ margin: "0 0 2px" }}><strong>Customer:</strong> {selSale.customer} · <strong>Phone:</strong> {selSale.customerPhone || "—"}</p>
                {selSale.customerEmail && <p style={{ margin: "0 0 2px" }}><strong>Email:</strong> {selSale.customerEmail}</p>}
                <p style={{ margin: "0 0 2px" }}><strong>Price:</strong> {selSale.price} {selSale.currency || "EGP"} · <strong>Profit:</strong> {(selSale.price || 0) - (selSale.costPrice || 0)} {selSale.currency || "EGP"}</p>
                <p style={{ margin: "0 0 2px" }}><strong>Period:</strong> {PER_LABEL(selSale.period)} · <strong>Renew:</strong> {selSale.period === 0 ? "N/A" : selSale.period === -1 ? "Lifetime ∞" : selSale.renewDate + " (" + dl(selSale.renewDate) + "d)"}</p>
                {selSale.assignedTo && (() => {
                  const m = team.find(x => x.id === selSale.assignedTo);
                  if (!m) return <p style={{ margin: "0 0 2px", color: "#f59e0b" }}>👤 Assigned to: <em>deleted member</em></p>;
                  const rate = m.commissionRate || 0;
                  const base = m.commissionBase || "revenue";
                  const rev = selSale.priceEGP || selSale.price || 0;
                  const cost = selSale.costEGP || selSale.costPrice || 0;
                  const comm = base === "revenue" ? Math.round(rev * rate / 100) : base === "profit" ? Math.round((rev - cost) * rate / 100) : rate;
                  return <p style={{ margin: "0 0 2px", color: "#2a9d8f" }}><strong>👤 Sold by:</strong> {m.name} · <strong>Commission:</strong> {comm} EGP ({rate}{base === "fixed" ? " EGP fixed" : "%"})</p>;
                })()}
                {selSale.linkedStockId && (() => {
                  const stock = stockRows.find(r => r.id === selSale.linkedStockId);
                  if (!stock) return null;
                  return (
                    <div style={{ marginTop: 6, padding: 6, background: dk ? "#334155" : "#e8f4f2", borderRadius: 4, borderLeft: "3px solid #2a9d8f" }}>
                      <p style={{ margin: "0 0 2px", fontSize: 8, color: "#2a9d8f", fontWeight: 700 }}>🔗 LINKED ACCOUNT</p>
                      <p style={{ margin: 0, fontSize: 9 }}>
                        <strong>{stock.email}</strong>
                        <CopyBtn text={stock.email} label="email" dk={dk} />
                        {stock.password && <span style={{ marginLeft: 4 }}><CopyBtn text={stock.password} label="password" dk={dk} /></span>}
                        <button onClick={() => { if (confirm("Unlink?")) unlinkStockFromSale(selSale.id); }} style={{ ...BG, padding: "0 4px", fontSize: 7, marginLeft: 4 }}>Unlink</button>
                      </p>
                    </div>
                  );
                })()}
              </div>
              <div style={{ display: "flex", gap: 3, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={badge(selSale.done)}>{selSale.done ? "Done" : "Pending"}</span>
                {feedback[selSale.id] && <span style={{ fontSize: 9, color: "#f59e0b" }}>{"⭐".repeat(feedback[selSale.id].rating)}</span>}
                <button onClick={() => setProofModal({ saleId: selSale.id })} style={{ ...BG, padding: "1px 6px", fontSize: 8 }}>📎 Proof</button>
                <button onClick={() => setShowTemplates({ sale: selSale })} style={{ ...BG, padding: "1px 6px", fontSize: 8 }}>💬 Templates</button>
                <button onClick={() => setShowRate(selSale)} style={{ ...BG, padding: "1px 6px", fontSize: 8 }}>⭐ Rate</button>
                <button onClick={() => setInvSale(selSale)} style={{ ...BG, padding: "1px 6px", fontSize: 8, marginLeft: "auto" }}>🧾</button>
                <button onClick={() => { renewSale(selSale); setSelSale(null); }} style={{ ...BP, padding: "1px 6px", fontSize: 8 }}>🔄 Renew</button>
                {selSale.customerPhone && <a href={waLink(selSale.customerPhone, "Hi " + selSale.customer)} target="_blank" rel="noreferrer" style={{ ...BP, padding: "1px 6px", fontSize: 8, background: "#25D366", textDecoration: "none" }}>WA</a>}
              </div>
              <p style={{ fontSize: 9, fontWeight: 600, margin: "6px 0 3px" }}>✅ Checklist</p>
              {(selSale.checklist || []).map((c, i) => (
                <label key={i} style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 0", fontSize: 9, cursor: "pointer", color: c.checked ? "#16a34a" : tx2 }}>
                  <input type="checkbox" checked={c.checked} onChange={() => { updateCL(selSale.id, i); setSelSale(p => ({ ...p, checklist: p.checklist.map((x, j) => j === i ? { ...x, checked: !x.checked } : x) })); }} />
                  {c.label}
                </label>
              ))}
              <p style={{ fontSize: 9, fontWeight: 600, margin: "6px 0 3px" }}>💬 Notes</p>
              <div style={{ maxHeight: 70, overflow: "auto", marginBottom: 4 }}>
                {(cmts[selSale.id] || []).map((c, i) => (
                  <div key={i} style={{ padding: "2px 0", borderBottom: "1px solid " + bd, fontSize: 8 }}>
                    <strong style={{ color: "#2a9d8f" }}>{c.user}</strong>: {c.text}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 3 }}>
                <input value={newCmt} onChange={e => setNewCmt(e.target.value)} placeholder="Add note..." style={{ ...IN, flex: 1 }} onKeyDown={e => { if (e.key === "Enter") addComment(selSale.id); }} />
                <button onClick={() => addComment(selSale.id)} style={{ ...BP, padding: "3px 8px" }}>Send</button>
              </div>
            </div>
          </div>
        )}

        {/* EDIT SALE MODAL */}
        {editSale && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 998 }}>
            <div style={{ ...C, padding: 16, width: 350 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>Edit Sale</h3>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Service</label><select value={editSale.service} onChange={e => setEditSale(p => ({ ...p, service: e.target.value }))} style={IN}>{svcNames.map(s => <option key={s}>{s}</option>)}</select></div>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Customer</label><input value={editSale.customer || ""} onChange={e => setEditSale(p => ({ ...p, customer: e.target.value }))} style={IN} /></div>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Phone</label><input value={editSale.customerPhone || ""} onChange={e => setEditSale(p => ({ ...p, customerPhone: e.target.value }))} style={IN} /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 5 }}>
                <div><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Price</label><input type="number" value={editSale.price || 0} onChange={e => setEditSale(p => ({ ...p, price: +e.target.value }))} style={IN} /></div>
                <div><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Currency</label><select value={editSale.currency || "EGP"} onChange={e => setEditSale(p => ({ ...p, currency: e.target.value }))} style={IN}>{CURS.map(c => <option key={c.c} value={c.c}>{c.c}</option>)}</select></div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 5 }}>
                <div><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Period</label><select value={editSale.period} onChange={e => setEditSale(p => ({ ...p, period: +e.target.value }))} style={IN}>{PERS.map(p => <option key={p} value={p}>{PER_LABEL(p)}</option>)}</select></div>
                <div><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Date</label><input type="date" value={editSale.soldDate || ""} onChange={e => setEditSale(p => ({ ...p, soldDate: e.target.value }))} style={IN} /></div>
              </div>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Notes</label><input value={editSale.notes || ""} onChange={e => setEditSale(p => ({ ...p, notes: e.target.value }))} style={IN} /></div>
              {team.length > 0 && (
                <div style={{ marginBottom: 5 }}>
                  <label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>👤 Assigned To (Sold By)</label>
                  <select value={editSale.assignedTo || ""} onChange={e => setEditSale(p => ({ ...p, assignedTo: e.target.value ? +e.target.value : null }))} style={IN}>
                    <option value="">— Unassigned —</option>
                    {team.map(m => <option key={m.id} value={m.id}>{m.name} ({m.commissionRate || 0}%)</option>)}
                  </select>
                </div>
              )}
              <div style={{ display: "flex", gap: 4 }}><button onClick={saveEditSale} style={BP}>Save</button><button onClick={() => setEditSale(null)} style={BG}>Cancel</button></div>
            </div>
          </div>
        )}

        {/* PROOF MODAL */}
        {proofModal && (() => {
          const sale = sales.find(s => s.id === proofModal.saleId);
          if (!sale) return null;
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 12 }}>
              <div style={{ ...C, padding: 16, width: 500, maxHeight: "90vh", overflow: "auto" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 13 }}>📎 Payment Proof</h3>
                  <span onClick={() => setProofModal(null)} style={{ cursor: "pointer", fontSize: 16, color: tx2 }}>✕</span>
                </div>
                <div style={{ fontSize: 10, color: tx2, marginBottom: 8 }}>
                  <strong>{sale.customer}</strong> · {sale.service} · {sale.price} {sale.currency || "EGP"}
                </div>
                {!sale.paymentProof ? (
                  <div>
                    <p style={{ fontSize: 10, color: tx2, marginBottom: 8 }}>Upload proof (JPG, PNG, PDF, max 5MB)</p>
                    <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => uploadProof(proofModal.saleId, e.target.files[0])} style={{ ...IN, padding: 6 }} />
                  </div>
                ) : (
                  <div>
                    <div style={{ background: dk ? "#0f172a" : "#f5f7f9", borderRadius: 6, padding: 8, marginBottom: 10, fontSize: 9 }}>
                      <div><strong>File:</strong> {sale.paymentProof.name}</div>
                      <div><strong>Status:</strong> {sale.proofStatus}</div>
                    </div>
                    {sale.paymentProof.type.startsWith("image/") && <img src={sale.paymentProof.data} alt="Proof" style={{ maxWidth: "100%", maxHeight: 400, borderRadius: 4 }} />}
                    <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap" }}>
                      <a href={sale.paymentProof.data} download={sale.paymentProof.name} style={{ ...BG, padding: "5px 10px", fontSize: 10, textDecoration: "none" }}>⬇ Download</a>
                      {sale.proofStatus !== "approved" && <button onClick={() => approveProof(sale.id)} style={{ ...BP, padding: "5px 10px", background: "#16a34a" }}>✓ Approve</button>}
                      {sale.proofStatus !== "rejected" && <button onClick={() => rejectProof(sale.id)} style={{ ...BD, padding: "5px 10px" }}>✕ Reject</button>}
                      <button onClick={() => removeProof(sale.id)} style={{ ...BG, padding: "5px 10px", color: "#dc2626", borderColor: "#dc2626" }}>🗑 Remove</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* RATE MODAL */}
        {showRate && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
            <div style={{ ...C, padding: 20, width: 320, textAlign: "center" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Rate Service</h3>
              <p style={{ margin: "0 0 12px", fontSize: 10, color: tx2 }}>{showRate.customer} · {showRate.service}</p>
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 12 }}>
                {[1, 2, 3, 4, 5].map(star => (
                  <span key={star} onClick={() => submitFeedback(showRate.id, star)} style={{ fontSize: 28, cursor: "pointer", filter: feedback[showRate.id] && feedback[showRate.id].rating >= star ? "none" : "grayscale(1)" }}>⭐</span>
                ))}
              </div>
              <button onClick={() => setShowRate(null)} style={{ ...BG, padding: "5px 16px", fontSize: 10 }}>Close</button>
            </div>
          </div>
        )}

        {/* BACKUP MODAL */}
        {showBackup && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
            <div style={{ ...C, padding: 20, width: 480, maxHeight: "90vh", overflow: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>💾 Backup & Restore</h3>
                <span onClick={() => setShowBackup(false)} style={{ cursor: "pointer", fontSize: 16, color: tx2 }}>✕</span>
              </div>
              <div style={{ padding: 14, background: dk ? "#0f172a" : "#e8f4f2", borderRadius: 8, marginBottom: 10, borderLeft: "3px solid #2a9d8f" }}>
                <h4 style={{ margin: "0 0 4px", fontSize: 11, color: "#2a9d8f" }}>📤 Export Backup</h4>
                <p style={{ margin: "0 0 8px", fontSize: 9, color: tx2 }}>Download complete backup as JSON.</p>
                <button onClick={backupAll} style={BP}>💾 Download Backup</button>
              </div>
              <div style={{ padding: 14, background: dk ? "#422006" : "#fffbeb", borderRadius: 8, borderLeft: "3px solid #f59e0b" }}>
                <h4 style={{ margin: "0 0 4px", fontSize: 11, color: "#b45309" }}>📥 Restore</h4>
                <p style={{ margin: "0 0 8px", fontSize: 9, color: tx2 }}>⚠️ Will replace all current data.</p>
                <input ref={fileInputRef} type="file" accept="application/json" onChange={(e) => restoreBackup(e.target.files[0])} style={{ display: "none" }} />
                <button onClick={() => fileInputRef.current && fileInputRef.current.click()} style={{ ...BP, background: "#f59e0b" }}>📥 Choose Backup File</button>
              </div>
            </div>
          </div>
        )}

        {/* WA TEMPLATES MODAL */}
        {showTemplates && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
            <div style={{ ...C, padding: 20, width: 600, maxHeight: "90vh", overflow: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>💬 WhatsApp Templates{showTemplates.sale && <span style={{ fontSize: 10, color: tx2 }}> · {showTemplates.sale.customer}</span>}</h3>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setEditTemplate({ name: "", text: "" })} style={{ ...BP, padding: "3px 8px", fontSize: 9 }}>+ New</button>
                  <span onClick={() => { setShowTemplates(null); setEditTemplate(null); }} style={{ cursor: "pointer", fontSize: 16, color: tx2 }}>✕</span>
                </div>
              </div>
              {editTemplate && (
                <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                  <h4 style={{ margin: "0 0 6px", fontSize: 11 }}>{editTemplate.id ? "Edit" : "New"}</h4>
                  <input value={editTemplate.name} onChange={e => setEditTemplate(p => ({ ...p, name: e.target.value }))} placeholder="Name" style={{ ...IN, marginBottom: 5 }} />
                  <textarea value={editTemplate.text} onChange={e => setEditTemplate(p => ({ ...p, text: e.target.value }))} rows={6} style={{ ...IN, resize: "vertical", marginBottom: 5 }} placeholder="Text with {customer}, {service}, {price}..." />
                  <div style={{ fontSize: 7, color: tx2, marginBottom: 6 }}>Vars: {"{customer}"}, {"{service}"}, {"{price}"}, {"{currency}"}, {"{period}"}, {"{renewDate}"}, {"{days}"}</div>
                  <button onClick={saveTemplate} style={BP}>Save</button>
                  <button onClick={() => setEditTemplate(null)} style={{ ...BG, marginLeft: 4 }}>Cancel</button>
                </div>
              )}
              {waTemplates.map(t => {
                const preview = renderTemplate(t.text, showTemplates.sale);
                return (
                  <div key={t.id} style={{ ...C, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <h4 style={{ margin: 0, fontSize: 11 }}>{t.name}</h4>
                      <div style={{ display: "flex", gap: 3 }}>
                        <button onClick={() => setEditTemplate({ ...t })} style={{ ...BG, padding: "2px 6px", fontSize: 8 }}>✎</button>
                        <button onClick={() => deleteTemplate(t.id)} style={{ ...BD, padding: "2px 6px", fontSize: 8 }}>✕</button>
                      </div>
                    </div>
                    <pre style={{ margin: 0, padding: 8, background: dk ? "#0f172a" : "#f5f7f9", borderRadius: 6, fontSize: 9, whiteSpace: "pre-wrap", fontFamily: "inherit", color: tx, maxHeight: 150, overflow: "auto" }}>{preview}</pre>
                    <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                      {showTemplates.sale && showTemplates.sale.customerPhone && (
                        <a href={waLink(showTemplates.sale.customerPhone, preview)} target="_blank" rel="noreferrer" style={{ ...BP, padding: "4px 10px", fontSize: 9, background: "#25D366", textDecoration: "none" }}>📱 Send</a>
                      )}
                      <button onClick={() => { copy(preview); alert("Copied!"); }} style={{ ...BG, padding: "4px 10px", fontSize: 9 }}>📋 Copy</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* INVOICE MODAL */}
        {invSale && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 12 }}>
            <div style={{ background: "#fff", borderRadius: 12, padding: 0, width: 560, maxHeight: "95vh", overflow: "auto", color: "#1a2e44" }}>
              <div style={{ padding: "10px 20px", background: "#f5f7f9", borderBottom: "1px solid #e8ebe9", display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>Template:</span>
                <button onClick={() => setInvTemplate("standard")} style={{ padding: "4px 12px", fontSize: 10, borderRadius: 6, border: "1px solid " + (invTemplate === "standard" ? "#2a9d8f" : "#d1d9e0"), background: invTemplate === "standard" ? "#2a9d8f" : "#fff", color: invTemplate === "standard" ? "#fff" : "#1a2e44", cursor: "pointer" }}>Standard</button>
                <button onClick={() => setInvTemplate("b2b")} style={{ padding: "4px 12px", fontSize: 10, borderRadius: 6, border: "1px solid " + (invTemplate === "b2b" ? "#2a9d8f" : "#d1d9e0"), background: invTemplate === "b2b" ? "#2a9d8f" : "#fff", color: invTemplate === "b2b" ? "#fff" : "#1a2e44", cursor: "pointer" }}>B2B</button>
              </div>
              <div style={{ background: "linear-gradient(135deg,#1a2e44,#2a9d8f)", padding: "20px 24px", color: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div><h2 style={{ margin: 0, fontSize: 20 }}>ProSkill</h2><p style={{ margin: 0, fontSize: 8, letterSpacing: 2, opacity: 0.85 }}>DIGITAL AGENCY</p></div>
                  <div style={{ textAlign: "right" }}><p style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>INVOICE</p><p style={{ margin: 0, fontSize: 9, opacity: 0.85 }}>#{String(invSale.id).slice(-6)}</p></div>
                </div>
              </div>
              <div style={{ padding: "20px 24px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  <div>
                    <p style={{ margin: "0 0 2px", fontSize: 8, color: "#94a3b8", fontWeight: 600 }}>BILL TO</p>
                    <p style={{ margin: "0 0 1px", fontSize: 14, fontWeight: 700 }}>{invSale.customer}</p>
                    {invSale.customerPhone && <p style={{ margin: 0, fontSize: 10, color: "#64748b" }}>📞 {invSale.customerPhone}</p>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ margin: "0 0 2px", fontSize: 8, color: "#94a3b8", fontWeight: 600 }}>DATE</p>
                    <p style={{ margin: "0 0 1px", fontSize: 13, fontWeight: 600 }}>{invSale.soldDate}</p>
                    <p style={{ margin: 0, fontSize: 10, color: "#64748b" }}>Due: {invSale.renewDate || "N/A"}</p>
                  </div>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginBottom: 16 }}>
                  <thead><tr style={{ background: "#f5f7f9", borderBottom: "2px solid #2a9d8f" }}><th style={{ padding: "8px 10px", textAlign: "left" }}>Description</th><th style={{ padding: "8px 10px" }}>Period</th><th style={{ padding: "8px 10px", textAlign: "right" }}>Amount</th></tr></thead>
                  <tbody><tr><td style={{ padding: 10 }}>{svcIcon(invSale.service)} {invSale.service}</td><td style={{ padding: 10, textAlign: "center" }}>{PER_LABEL(invSale.period)}</td><td style={{ padding: 10, textAlign: "right", fontWeight: 600 }}>{invSale.price} {invSale.currency || "EGP"}</td></tr></tbody>
                </table>
                <div style={{ borderTop: "2px solid #1a2e44", paddingTop: 12, display: "flex", justifyContent: "space-between" }}>
                  <div><p style={{ margin: 0, fontSize: 8, color: "#94a3b8" }}>Sold by: {invSale.soldBy}</p>{invSale.notes && <p style={{ margin: 0, fontSize: 8, color: "#94a3b8" }}>Note: {invSale.notes}</p>}</div>
                  <div style={{ textAlign: "right" }}><p style={{ margin: 0, fontSize: 9, color: "#94a3b8" }}>TOTAL</p><p style={{ margin: 0, fontSize: 26, fontWeight: 800, color: "#2a9d8f" }}>{invSale.price} {invSale.currency || "EGP"}</p></div>
                </div>
                <div style={{ background: "#f5f7f9", borderRadius: 6, padding: "10px 12px", marginTop: 12 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 8, fontWeight: 700, color: "#1a2e44" }}>TERMS</p>
                  <p style={{ margin: 0, fontSize: 9, color: "#64748b" }}>{COMPANY.terms}</p>
                </div>
              </div>
              <div style={{ background: "#1a2e44", padding: "14px 24px", color: "#fff", display: "flex", justifyContent: "space-around" }}>
                <div style={{ textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, opacity: 0.7 }}>WEBSITE</p><p style={{ margin: 0, fontSize: 10 }}>{COMPANY.website}</p></div>
                <div style={{ textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, opacity: 0.7 }}>WHATSAPP</p><p style={{ margin: 0, fontSize: 10 }}>{COMPANY.whatsapp}</p></div>
                <div style={{ textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, opacity: 0.7 }}>EMAIL</p><p style={{ margin: 0, fontSize: 10 }}>{COMPANY.email}</p></div>
              </div>
              <div style={{ padding: "12px 24px", display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid #e8ebe9" }}>
                <button onClick={() => window.print()} style={{ ...BP, padding: "7px 18px", fontSize: 11 }}>🖨️ Print</button>
                {invSale.customerPhone && <a href={waLink(invSale.customerPhone, "Invoice #" + String(invSale.id).slice(-6) + " for " + invSale.service + ": " + invSale.price + " " + (invSale.currency || "EGP"))} target="_blank" rel="noreferrer" style={{ ...BP, padding: "7px 18px", fontSize: 11, background: "#25D366", textDecoration: "none" }}>WhatsApp</a>}
                <button onClick={() => setInvSale(null)} style={{ ...BG, padding: "7px 18px", fontSize: 11 }}>Close</button>
              </div>
            </div>
          </div>
        )}

        {/* CUSTOMER DETAIL MODAL */}
        {selCust && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 998 }}>
            <div style={{ ...C, padding: 16, width: 420, maxHeight: "80vh", overflow: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>👤 {selCust.name}</h3>
                <span onClick={() => setSelCust(null)} style={{ cursor: "pointer", fontSize: 14, color: tx2 }}>✕</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, marginBottom: 8 }}>
                <div style={{ background: "#e8f4f2", borderRadius: 6, padding: 5, textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, color: "#2a9d8f" }}>Sales</p><p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#2a9d8f" }}>{selCust.tS}</p></div>
                <div style={{ background: "#f0fdf4", borderRadius: 6, padding: 5, textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, color: "#16a34a" }}>Value</p><p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#16a34a" }}>{selCust.tV}</p></div>
                <div style={{ background: "#f5f3ff", borderRadius: 6, padding: 5, textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, color: "#8b5cf6" }}>Active</p><p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#8b5cf6" }}>{selCust.aS}</p></div>
                <div style={{ background: selCust.h.s >= 70 ? "#f0fdf4" : selCust.h.s >= 40 ? "#fffbeb" : "#fef2f2", borderRadius: 6, padding: 5, textAlign: "center" }}><p style={{ margin: 0, fontSize: 7, color: selCust.h.c }}>Health</p><p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: selCust.h.c }}>{selCust.h.s}%</p></div>
              </div>
              <p style={{ margin: "0 0 6px", fontSize: 9 }}><strong>Phone:</strong> {selCust.phone || "—"}{selCust.phone && <a href={waLink(selCust.phone, "Hi " + selCust.name)} target="_blank" rel="noreferrer" style={{ marginLeft: 4, color: "#25D366", fontSize: 8 }}>WhatsApp</a>}</p>
              <h4 style={{ margin: "0 0 4px", fontSize: 10 }}>History</h4>
              {(selCust.all || []).map(a => (
                <div key={a.id} style={{ padding: "3px 0", borderBottom: "1px solid " + bd, fontSize: 9, display: "flex", justifyContent: "space-between" }}>
                  <span>{svcIcon(a.service)} {a.service} · {a.price} {a.currency || "EGP"}</span>
                  <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    <span style={badge(a.done)}>{a.done ? "✓" : "..."}</span>
                    <span style={{ color: dl(a.renewDate) <= 0 ? "#dc2626" : "#16a34a" }}>{dl(a.renewDate)}d</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* EDIT GUIDE MODAL */}
        {editGuide && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 998 }}>
            <div style={{ ...C, padding: 16, width: 360 }}>
              <h3 style={{ margin: "0 0 8px" }}>Edit Guide</h3>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Service</label><select value={editGuide.service} onChange={e => setEditGuide(p => ({ ...p, service: e.target.value }))} style={IN}>{svcNames.map(s => <option key={s}>{s}</option>)}</select></div>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Title</label><input value={editGuide.title || ""} onChange={e => setEditGuide(p => ({ ...p, title: e.target.value }))} style={IN} /></div>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Text</label><textarea value={editGuide.text || ""} onChange={e => setEditGuide(p => ({ ...p, text: e.target.value }))} rows={3} style={{ ...IN, resize: "vertical" }} /></div>
              <div style={{ marginBottom: 5 }}><label style={{ fontSize: 8, fontWeight: 600, color: tx2 }}>Link</label><input value={editGuide.link || ""} onChange={e => setEditGuide(p => ({ ...p, link: e.target.value }))} style={IN} /></div>
              <div style={{ display: "flex", gap: 4 }}><button onClick={saveEditGuide} style={BP}>Save</button><button onClick={() => setEditGuide(null)} style={BG}>Cancel</button></div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════ DASHBOARD ═══════════════════════════ */}
        {tab === "dashboard" && (
          <div>
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>📊 Overview</h2>
            {alerts.allN.filter(n => n.t === "danger" || n.t === "warn").length > 0 && (
              <div style={{ ...C, marginBottom: 8, background: dk ? "#422006" : "#fffbeb", borderLeft: "3px solid #f59e0b" }}>
                <h4 style={{ margin: "0 0 3px", fontSize: 10, color: "#92400e" }}>🔔 Alerts</h4>
                {alerts.allN.filter(n => n.t === "danger" || n.t === "warn").slice(0, 4).map(n => (
                  <p key={n.id} style={{ margin: "0 0 1px", fontSize: 8, color: n.t === "danger" ? "#dc2626" : "#b45309" }}>{n.m}</p>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(100px,1fr))", gap: 6, marginBottom: 8 }}>
              {[
                { l: "Sales", v: myStats.tS, c: "#1a2e44" },
                { l: "Revenue", v: myStats.tR.toLocaleString() + " EGP", c: "#2a9d8f" },
                { l: "Profit", v: myStats.tP.toLocaleString() + " EGP", c: myStats.tP >= 0 ? "#16a34a" : "#dc2626" },
                { l: "Pending", v: myStats.tA, c: "#8b5cf6" }
              ].map((c, i) => (
                <div key={i} style={C}>
                  <p style={{ margin: 0, fontSize: 7, color: tx2 }}>{c.l}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 800, color: c.c }}>{c.v}</p>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(90px,1fr))", gap: 5, marginBottom: 8 }}>
              {[
                { l: "MRR", v: mrr.cur.toLocaleString(), c: "#2a9d8f" },
                { l: "Churn", v: mrr.cr + "%", c: mrr.cr > 20 ? "#dc2626" : "#f59e0b" },
                { l: "Net", v: netProfit.toLocaleString() + " EGP", c: netProfit >= 0 ? "#16a34a" : "#dc2626" },
                { l: "Growth", v: (moCmp.growth > 0 ? "+" : "") + moCmp.growth + "%", c: moCmp.growth >= 0 ? "#16a34a" : "#dc2626" },
                { l: "Rating", v: avgRating > 0 ? avgRating + " ⭐" : "—", c: avgRating >= 4 ? "#16a34a" : "#f59e0b" },
                { l: "Tasks", v: overdueTasks.length > 0 ? overdueTasks.length + " overdue" : tasks.filter(t => t.status === "pending").length + " pending", c: overdueTasks.length > 0 ? "#dc2626" : "#2a9d8f" }
              ].map((c, i) => (
                <div key={i} style={{ ...C, borderTop: "2px solid " + c.c }}>
                  <p style={{ margin: 0, fontSize: 6, color: tx2, fontWeight: 600 }}>{c.l}</p>
                  <p style={{ margin: "1px 0 0", fontSize: 12, fontWeight: 800, color: c.c }}>{c.v}</p>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 8 }}>
              {[{ l: "Today", d: myTime.daily, cl: "#f59e0b" }, { l: "Week", d: myTime.weekly, cl: "#2a9d8f" }, { l: "Month", d: myTime.monthly, cl: "#1a2e44" }, { l: "Year", d: myTime.yearly, cl: "#16a34a" }].map((p, i) => (
                <div key={i} style={{ ...C, borderTop: "2px solid " + p.cl }}>
                  <p style={{ margin: 0, fontSize: 6, color: tx2 }}>{p.l}</p>
                  <p style={{ margin: "1px 0", fontSize: 13, fontWeight: 800, color: p.cl }}>{p.d.count}</p>
                  <p style={{ margin: 0, fontSize: 7, color: tx2 }}>{p.d.rev.toLocaleString()}</p>
                </div>
              ))}
            </div>
            <div style={{ ...C, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <h3 style={{ margin: 0, fontSize: 10 }}>Breakdown</h3>
                <div style={{ display: "flex", gap: 2 }}>
                  {[{ id: "wtd", l: "WTD" }, { id: "mtd", l: "MTD" }, { id: "ytd", l: "YTD" }].map(p => (
                    <button key={p.id} onClick={() => setDPer(p.id)} style={{ ...BG, padding: "1px 6px", fontSize: 7, background: dPer === p.id ? "#2a9d8f" : "transparent", color: dPer === p.id ? "#fff" : "#2a9d8f" }}>{p.l}</button>
                  ))}
                </div>
              </div>
              {dPer === "wtd" && <Chrt data={myTime.wtdD} />}
              {dPer === "mtd" && <Chrt data={myTime.mtdD} color="#1a2e44" />}
              {dPer === "ytd" && <Chrt data={myTime.ytdM} />}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <div style={C}>
                <h3 style={{ margin: "0 0 4px", fontSize: 10 }}>📦 Stock</h3>
                {svcNames.filter(s => (stockStatsByProduct[s]?.total || 0) > 0).map(s => {
                  const st = stockStatsByProduct[s];
                  return (
                    <div key={s} style={{ marginBottom: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, marginBottom: 1 }}>
                        <span>{svcIcon(s)} {s}</span>
                        <span style={{ color: st.avail < 3 ? "#dc2626" : "#16a34a", fontWeight: 600 }}>{st.avail}/{st.total}</span>
                      </div>
                      <div style={{ height: 2, background: dk ? "#334155" : "#e8ebe9", borderRadius: 1 }}>
                        <div style={{ height: 2, width: Math.min(100, Math.round((st.avail / st.total) * 100)) + "%", background: st.avail < 3 ? "#dc2626" : "#2a9d8f", borderRadius: 1 }} />
                      </div>
                    </div>
                  );
                })}
                {svcNames.every(s => (stockStatsByProduct[s]?.total || 0) === 0) && <p style={{ fontSize: 8, color: tx2 }}>No stock.</p>}
              </div>
              <div style={C}>
                <h3 style={{ margin: "0 0 4px", fontSize: 10 }}>🕒 Recent Sales</h3>
                {sales.slice(0, 5).map(s => (
                  <div key={s.id} style={{ padding: "3px 0", borderBottom: "1px solid " + bd, fontSize: 9, display: "flex", justifyContent: "space-between" }}>
                    <span>{s.customer}</span>
                    <span style={{ color: s.done ? "#16a34a" : "#f59e0b", fontWeight: 600 }}>{s.price} {s.currency || "EGP"}</span>
                  </div>
                ))}
                {sales.length === 0 && <p style={{ fontSize: 8, color: tx2 }}>No sales yet.</p>}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════ MRR ═══════════════════════════ */}
        {tab === "mrr" && (
          <div>
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>💹 MRR & Profitability</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 6, marginBottom: 10 }}>
              {[
                { l: "MRR", v: mrr.cur.toLocaleString() + " EGP", c: "#2a9d8f" },
                { l: "Churn", v: mrr.cr + "%", c: mrr.cr > 20 ? "#dc2626" : "#f59e0b" },
                { l: "ARR", v: mrr.arr.toLocaleString() + " EGP", c: "#1a2e44" },
                { l: "Net Profit", v: netProfit.toLocaleString() + " EGP", c: netProfit >= 0 ? "#16a34a" : "#dc2626" }
              ].map((c, i) => (
                <div key={i} style={{ ...C, borderTop: "2px solid " + c.c }}>
                  <p style={{ margin: 0, fontSize: 8, color: tx2 }}>{c.l}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: c.c }}>{c.v}</p>
                </div>
              ))}
            </div>
            <div style={{ ...C, marginBottom: 10 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 11 }}>Service Ranking</h3>
              {svcNames.map((s, i) => {
                const v = allStats.byS[s];
                const mg = v.rev > 0 ? Math.round(v.pft / v.rev * 100) : 0;
                return (
                  <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid " + bd, fontSize: 10 }}>
                    <span><strong>{i + 1}.</strong> {svcIcon(s)} {s}</span>
                    <span>{v.rev.toLocaleString()} EGP · <span style={{ color: v.pft >= 0 ? "#16a34a" : "#dc2626" }}>{v.pft.toLocaleString()}</span> · <span style={{ color: mg >= 50 ? "#16a34a" : "#f59e0b" }}>{mg}%</span></span>
                  </div>
                );
              })}
            </div>
            <div style={C}>
              <h3 style={{ margin: "0 0 6px", fontSize: 11 }}>📈 3-Month Forecast</h3>
              {forecast.map(f => (
                <div key={f.month} style={{ padding: "5px 0", borderBottom: "1px solid " + bd }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                    <span style={{ fontWeight: 600 }}>{f.month}</span>
                    <span style={{ color: "#2a9d8f", fontWeight: 700 }}>{f.rev.toLocaleString()} EGP</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 8, color: tx2 }}>{f.renewals} renewals expected</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════ SERVICES ═══════════════════════════ */}
        {tab === "services" && (
          <div>
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>⚙️ Services</h2>
            <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
                <div style={{ position: "relative" }}>
                  <label style={{ fontSize: 8, color: tx2 }}>Icon</label>
                  <div onClick={() => setShowIP(!showIP)} style={{ ...IN, width: 38, fontSize: 16, textAlign: "center", cursor: "pointer" }}>{nSvcI}</div>
                  {showIP && (
                    <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 50, background: cbg, border: "1px solid " + bd, borderRadius: 8, padding: 6, width: 200, display: "flex", flexWrap: "wrap", gap: 2, boxShadow: "0 6px 16px rgba(0,0,0,0.1)", maxHeight: 120, overflow: "auto" }}>
                      {ICONS.map(ic => (
                        <span key={ic} onClick={() => { setNSvcI(ic); setShowIP(false); }} style={{ fontSize: 14, cursor: "pointer", padding: 2, borderRadius: 3, background: nSvcI === ic ? "#e8f4f2" : "transparent" }}>{ic}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1 }}><label style={{ fontSize: 8, color: tx2 }}>Name</label><input value={nSvcN} onChange={e => setNSvcN(e.target.value)} style={IN} onKeyDown={e => { if (e.key === "Enter") addSvc(); }} /></div>
                <button onClick={addSvc} style={BP}>+ Add</button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 6 }}>
              {svcs.map(s => (
                <div key={s.name} style={C}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 18 }}>{s.icon}</span>
                    <h4 style={{ margin: 0, flex: 1, fontSize: 11 }}>{s.name}</h4>
                    <button onClick={() => rmSvc(s.name)} style={{ ...BD, padding: "1px 5px", fontSize: 8 }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════ SALES ═══════════════════════════ */}
        {tab === "sales_entry" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, flexWrap: "wrap", gap: 4 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>🔑 Sales ({filtSales.length})</h2>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
                {["all", "pending", "done", "approved", "cancelled", "followup"].map(f => (
                  <button key={f} onClick={() => setAF(f)} style={{ ...BG, background: aF === f ? "#2a9d8f" : "transparent", color: aF === f ? "#fff" : "#2a9d8f", fontSize: 7, padding: "2px 6px" }}>{f === "followup" ? "📞" : f}</button>
                ))}
                <ExportMenu
                  onCsv={() => exportCSV(filtSales.map(a => ({ ID: String(a.id).slice(-6), Service: a.service, Customer: a.customer, Phone: a.customerPhone || "", Price: a.price, Currency: a.currency || "EGP", "Sold Date": a.soldDate, "Renew Date": a.renewDate, Status: a.done ? "Done" : "Pending", "Sold By": a.soldBy })), "sales_" + gn() + ".csv")}
                  onXlsx={() => exportExcel(filtSales.map(a => ({ Service: a.service, Customer: a.customer, Phone: a.customerPhone || "", Price: a.price, Currency: a.currency || "EGP", SoldDate: a.soldDate, RenewDate: a.renewDate, Status: a.done ? "Done" : "Pending" })), "sales_" + gn() + ".xls", "Sales")}
                  onPdf={() => exportPDF("Sales Report", filtSales.map(a => ({ Service: a.service, Customer: a.customer, Phone: a.customerPhone || "—", Price: a.price + " " + (a.currency || "EGP"), "Sold Date": a.soldDate, Status: a.done ? "Done" : "Pending" })), "sales_" + gn() + ".pdf")}
                />
                {svcNames.length > 0 && <button onClick={() => setNewSale({ service: svcNames[0], customer: "", customerPhone: "", customerEmail: "", period: 1, price: 0, costPrice: 0, currency: "EGP", soldDate: gn(), notes: "", assignedTo: null })} style={BP}>+ Sale</button>}
                {selBulk.length > 0 && (<>
                  <button onClick={bulkDone} style={{ ...BP, background: "#16a34a", padding: "2px 5px", fontSize: 7 }}>✓ {selBulk.length}</button>
                  <button onClick={bulkDel} style={{ ...BD, padding: "2px 5px", fontSize: 7 }}>✕ {selBulk.length}</button>
                </>)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
              <input placeholder="🔍 Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...IN, flex: 2, minWidth: 160 }} />
              <select value={salesFilterProd} onChange={e => setSalesFilterProd(e.target.value)} style={{ ...IN, flex: 1, minWidth: 110 }}>
                <option value="all">All Products</option>
                {svcNames.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input placeholder="📞 Phone..." value={salesFilterPhone} onChange={e => setSalesFilterPhone(e.target.value)} style={{ ...IN, flex: 1, minWidth: 100 }} />
              <input type="date" value={dFrom} onChange={e => setDFrom(e.target.value)} style={{ ...IN, flex: 1, minWidth: 110 }} />
              <input type="date" value={dTo} onChange={e => setDTo(e.target.value)} style={{ ...IN, flex: 1, minWidth: 110 }} />
              {(search || dFrom || dTo || salesFilterProd !== "all" || salesFilterPhone) && <button onClick={() => { setSearch(""); setDFrom(""); setDTo(""); setSalesFilterProd("all"); setSalesFilterPhone(""); }} style={{ ...BD, padding: "3px 8px", fontSize: 8 }}>Clear ✕</button>}
            </div>
            {newSale && (
              <div style={{ ...C, marginBottom: 8, border: "2px solid #2a9d8f" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, marginBottom: 4 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Service</label><select value={newSale.service} onChange={e => setNewSale(p => ({ ...p, service: e.target.value }))} style={IN}>{svcNames.map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Customer *</label><input value={newSale.customer} onChange={e => setNewSale(p => ({ ...p, customer: e.target.value }))} style={{ ...IN, borderColor: !newSale.customer.trim() ? "#ef4444" : undefined }} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Phone</label><input value={newSale.customerPhone || ""} onChange={e => setNewSale(p => ({ ...p, customerPhone: e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Email</label><input type="email" value={newSale.customerEmail || ""} onChange={e => setNewSale(p => ({ ...p, customerEmail: e.target.value }))} style={IN} /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 4, marginBottom: 4 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Period</label><select value={newSale.period} onChange={e => setNewSale(p => ({ ...p, period: +e.target.value }))} style={IN}>{PERS.map(p => <option key={p} value={p}>{PER_LABEL(p)}</option>)}</select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Price *</label><input type="number" value={newSale.price} onChange={e => setNewSale(p => ({ ...p, price: +e.target.value }))} style={{ ...IN, borderColor: newSale.price <= 0 ? "#ef4444" : undefined }} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Cost</label><input type="number" value={newSale.costPrice || 0} onChange={e => setNewSale(p => ({ ...p, costPrice: +e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Currency</label><select value={newSale.currency || "EGP"} onChange={e => setNewSale(p => ({ ...p, currency: e.target.value }))} style={IN}>{CURS.map(c => <option key={c.c} value={c.c}>{c.c}</option>)}</select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Date</label><input type="date" value={newSale.soldDate} onChange={e => setNewSale(p => ({ ...p, soldDate: e.target.value }))} style={IN} /></div>
                </div>
                {team.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <label style={{ fontSize: 7, color: tx2 }}>👤 Sold By (Team Member)</label>
                    <select value={newSale.assignedTo || ""} onChange={e => setNewSale(p => ({ ...p, assignedTo: e.target.value ? +e.target.value : null }))} style={IN}>
                      <option value="">— Unassigned (no commission) —</option>
                      {team.map(m => <option key={m.id} value={m.id}>{m.name} ({m.role || "Member"}) — {m.commissionRate || 0}%</option>)}
                    </select>
                  </div>
                )}
                <div style={{ display: "flex", gap: 3 }}>
                  <input value={newSale.notes || ""} onChange={e => setNewSale(p => ({ ...p, notes: e.target.value }))} placeholder="Notes..." style={{ ...IN, flex: 1 }} />
                  <button onClick={addSaleEntry} style={BP}>Add</button>
                  <button onClick={() => setNewSale(null)} style={BG}>✕</button>
                </div>
              </div>
            )}
            {svcNames.map(svc => {
              const accs = filtSales.filter(a => a.service === svc);
              if (!accs.length) return null;
              return (
                <div key={svc} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                    <span style={{ fontSize: 13 }}>{svcIcon(svc)}</span>
                    <h3 style={{ margin: 0, fontSize: 11 }}>{svc}</h3>
                    <span style={{ fontSize: 8, color: tx2, background: dk ? "#334155" : "#e8ebe9", padding: "0 5px", borderRadius: 6 }}>{accs.length}</span>
                  </div>
                  <div style={{ ...C, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, minWidth: 680 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid " + bd }}>
                          {["☐", "", "Customer", "Phone", "Period", "Price", "Date", "Renew", "📞", ""].map(h => (
                            <th key={h} style={{ textAlign: "left", padding: "3px 4px", fontSize: 7, color: tx2 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {accs.map(a => {
                          const dls = dl(a.renewDate);
                          const rc = dls <= 0 ? "#dc2626" : dls <= 7 ? "#f59e0b" : "#16a34a";
                          return (
                            <tr key={a.id} onClick={() => setSelSale(a)} style={{ borderBottom: "1px solid " + bd, cursor: "pointer", background: a.followUp ? (dk ? "#422006" : "#fff7ed") : "transparent" }}>
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <input type="checkbox" checked={selBulk.includes(a.id)} onChange={() => setSelBulk(p => p.includes(a.id) ? p.filter(x => x !== a.id) : [...p, a.id])} />
                              </td>
                              <td style={{ padding: "3px 4px" }}><span style={badge(a.done)}>{a.done ? "✓" : "..."}</span></td>
                              <td style={{ padding: "3px 4px", fontWeight: 500 }}>{a.customer || "—"}</td>
                              <td style={{ padding: "3px 4px", color: "#2a9d8f", fontSize: 8 }}>{a.customerPhone || "—"}</td>
                              <td style={{ padding: "3px 4px" }}>{PER_LABEL(a.period)}</td>
                              <td style={{ padding: "3px 4px", fontWeight: 600, color: "#16a34a" }}>{a.price} {a.currency || "EGP"}</td>
                              <td style={{ padding: "3px 4px", fontSize: 7, color: tx2 }}>{a.soldDate}</td>
                              <td style={{ padding: "3px 4px", fontSize: 7 }}>{a.period === 0 ? "—" : a.period === -1 ? "∞" : <span style={{ color: rc, fontWeight: 600 }}>{dls}d</span>}</td>
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <input type="checkbox" checked={a.followUp || false} onChange={() => toggleFollow(a.id)} />
                              </td>
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <div style={{ display: "flex", gap: 1 }}>
                                  <button onClick={() => toggleDone(a.id)} style={{ ...BG, padding: "0 3px", fontSize: 6 }}>{a.done ? "↩" : "✓"}</button>
                                  <button onClick={() => setInvSale(a)} style={{ ...BG, padding: "0 3px", fontSize: 6 }}>🧾</button>
                                  <button onClick={() => setEditSale({ ...a })} style={{ ...BG, padding: "0 3px", fontSize: 6 }}>✎</button>
                                  <button onClick={() => deleteSale(a.id)} style={{ ...BD, padding: "0 3px", fontSize: 6 }}>✕</button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
            {filtSales.length === 0 && <div style={{ ...C, textAlign: "center", padding: 16, color: tx2 }}>No sales found.</div>}
          </div>
        )}

        {/* ═══════════════════════════ STOCK ═══════════════════════════ */}
        {tab === "stock" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>📦 Stock / Accounts</h2>
              <button onClick={() => { setStockNewRow({ product: svcNames[0] || "", email: "", password: "", link: "", note: "" }); setStockShowAdd(s => !s); }} style={BP}>+ Add Account</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 6, marginBottom: 12 }}>
              <div style={{ ...C, borderTop: "3px solid #2a9d8f" }}><div style={{ fontSize: 7, color: tx2, fontWeight: 700 }}>AVAILABLE</div><div style={{ fontSize: 22, fontWeight: 900, color: "#2a9d8f" }}>{stockTotalAvail}</div></div>
              <div style={{ ...C, borderTop: "3px solid #dc2626" }}><div style={{ fontSize: 7, color: tx2, fontWeight: 700 }}>SOLD</div><div style={{ fontSize: 22, fontWeight: 900, color: "#dc2626" }}>{stockTotalSold}</div></div>
              {svcNames.map(p => {
                const st = stockStatsByProduct[p] || { avail: 0, sold: 0, total: 0 };
                if (st.total === 0) return null;
                const active = stockFilterProd === p;
                return (
                  <div key={p} onClick={() => setStockFilterProd(fp => fp === p ? "all" : p)} style={{ ...C, background: active ? (dk ? "rgba(42,157,143,0.15)" : "#e8f4f2") : cbg, border: "1px solid " + (active ? "#2a9d8f" : bd), cursor: "pointer" }}>
                    <div style={{ fontSize: 7, color: tx2, fontWeight: 700 }}>{svcIcon(p)} {p.toUpperCase()}</div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: active ? "#2a9d8f" : (st.avail === 0 ? "#dc2626" : "#16a34a") }}>{st.avail}</div>
                    <div style={{ fontSize: 7, color: tx2 }}>{st.sold} sold · {st.total} total</div>
                  </div>
                );
              })}
            </div>
            {stockShowAdd && (
              <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 8 }}>New Account</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr 1fr 80px", gap: 6 }}>
                  <div><div style={{ fontSize: 7, color: tx2 }}>Product</div><select value={stockNewRow.product} onChange={e => setStockNewRow(p => ({ ...p, product: e.target.value }))} style={IN}>{svcNames.map(p => <option key={p}>{p}</option>)}</select></div>
                  <div><div style={{ fontSize: 7, color: tx2 }}>Email *</div><input value={stockNewRow.email} onChange={e => setStockNewRow(p => ({ ...p, email: e.target.value }))} style={IN} /></div>
                  <div><div style={{ fontSize: 7, color: tx2 }}>Password</div><input value={stockNewRow.password} onChange={e => setStockNewRow(p => ({ ...p, password: e.target.value }))} style={IN} /></div>
                  <div><div style={{ fontSize: 7, color: tx2 }}>Link</div><input value={stockNewRow.link} onChange={e => setStockNewRow(p => ({ ...p, link: e.target.value }))} style={IN} /></div>
                  <div><div style={{ fontSize: 7, color: tx2 }}>Note</div><input value={stockNewRow.note} onChange={e => setStockNewRow(p => ({ ...p, note: e.target.value }))} style={IN} /></div>
                  <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 4 }}>
                    <button onClick={addStockRow} style={BP}>Add</button>
                    <button onClick={() => setStockShowAdd(false)} style={BG}>✕</button>
                  </div>
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input placeholder="🔍 Search..." value={stockSearch} onChange={e => setStockSearch(e.target.value)} style={{ ...IN, width: 240 }} />
              {["all", "available", "sold"].map(v => (
                <button key={v} onClick={() => setStockView(v)} style={{ ...BG, padding: "4px 10px", fontSize: 10, background: stockView === v ? "#2a9d8f" : "transparent", color: stockView === v ? "#fff" : "#2a9d8f", textTransform: "capitalize" }}>{v}</button>
              ))}
              <span style={{ marginLeft: "auto", fontSize: 9, color: tx2 }}>{stockFiltered.length} results</span>
            </div>
            <div style={{ ...C, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                  <thead>
                    <tr style={{ background: dk ? "#0f172a" : "#f5f7f9", borderBottom: "2px solid " + bd }}>
                      {["", "Product", "Email", "Password", "Link", "Note", "Status", ""].map((h, i) => (
                        <th key={i} style={{ padding: "9px 10px", textAlign: "left", fontSize: 8, color: tx2, textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stockFiltered.length === 0 && <tr><td colSpan={8} style={{ padding: 28, textAlign: "center", color: tx2 }}>No accounts.</td></tr>}
                    {stockFiltered.map(row => {
                      const isEdit = stockEditId === row.id;
                      return (
                        <tr key={row.id} style={{ borderBottom: "1px solid " + bd, opacity: row.sold ? 0.6 : 1 }}>
                          <td style={{ padding: "8px 10px" }}><input type="checkbox" checked={row.sold} onChange={() => toggleStockSold(row.id)} style={{ width: 16, height: 16, accentColor: "#2a9d8f" }} /></td>
                          <td style={{ padding: "8px 10px" }}>{isEdit ? <select value={stockEditRow.product} onChange={e => setStockEditRow(p => ({ ...p, product: e.target.value }))} style={IN}>{svcNames.map(p => <option key={p}>{p}</option>)}</select> : <span style={{ fontWeight: 700, fontSize: 11 }}>{svcIcon(row.product)} {row.product}</span>}</td>
                          <td style={{ padding: "8px 10px" }}>{isEdit ? <input value={stockEditRow.email} onChange={e => setStockEditRow(p => ({ ...p, email: e.target.value }))} style={IN} /> : <div style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 10 }}>{row.email}</span><CopyBtn text={row.email} label="email" dk={dk} /></div>}</td>
                          <td style={{ padding: "8px 10px" }}>{isEdit ? <input value={stockEditRow.password} onChange={e => setStockEditRow(p => ({ ...p, password: e.target.value }))} style={IN} /> : (row.password ? <PassCell val={row.password} dk={dk} /> : "—")}</td>
                          <td style={{ padding: "8px 10px" }}>{isEdit ? <input value={stockEditRow.link} onChange={e => setStockEditRow(p => ({ ...p, link: e.target.value }))} style={IN} /> : (row.link ? <a href={row.link} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "#2a9d8f" }}>Open</a> : "—")}</td>
                          <td style={{ padding: "8px 10px" }}>{isEdit ? <input value={stockEditRow.note || ""} onChange={e => setStockEditRow(p => ({ ...p, note: e.target.value }))} style={IN} /> : <span style={{ fontSize: 10, color: tx2 }}>{row.note || "—"}</span>}</td>
                          <td style={{ padding: "8px 10px" }}><span style={{ padding: "2px 9px", borderRadius: 20, fontSize: 9, fontWeight: 700, background: row.sold ? "#fef2f2" : "#e8f4f2", color: row.sold ? "#dc2626" : "#2a9d8f" }}>{row.sold ? "Sold" : "Available"}</span></td>
                          <td style={{ padding: "8px 10px" }}>
                            <div style={{ display: "flex", gap: 3 }}>
                              {isEdit ? (<>
                                <button onClick={saveStockEdit} style={{ ...BP, padding: "3px 8px" }}>Save</button>
                                <button onClick={() => { setStockEditId(null); setStockEditRow(null); }} style={{ ...BG, padding: "3px 8px" }}>✕</button>
                              </>) : (<>
                                <button onClick={() => { setStockEditId(row.id); setStockEditRow({ ...row }); }} style={{ ...BG, padding: "3px 7px" }}>✎</button>
                                <button onClick={() => deleteStockRow(row.id)} style={{ ...BD, padding: "3px 7px" }}>✕</button>
                              </>)}
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
        )}

        {/* ═══════════════════════════ CUSTOMERS ═══════════════════════════ */}
        {tab === "customers" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>👤 Customers ({custList.length})</h2>
              <ExportMenu
                onCsv={() => exportCSV(custList.map(c => ({ Name: c.name, Phone: c.phone || "", "Total Sales": c.tS, "Active Subs": c.aS, "Total Value (EGP)": c.tV, Status: c.h.l })), "customers_" + gn() + ".csv")}
                onXlsx={() => exportExcel(custList.map(c => ({ Name: c.name, Phone: c.phone || "", TotalSales: c.tS, ActiveSubs: c.aS, Value: c.tV, Status: c.h.l })), "customers_" + gn() + ".xls", "Customers")}
                onPdf={() => exportPDF("Customer Report", custList.map(c => ({ Name: c.name, Phone: c.phone || "—", Sales: c.tS, Active: c.aS, Value: c.tV.toLocaleString(), Status: c.h.l })), "customers_" + gn() + ".pdf")}
              />
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
              <input placeholder="🔍 Search..." value={custSearch} onChange={e => setCustSearch(e.target.value)} style={{ ...IN, flex: 2, minWidth: 180 }} />
              <select value={custFilterStatus} onChange={e => setCustFilterStatus(e.target.value)} style={{ ...IN, flex: 1, minWidth: 110 }}>
                <option value="all">All Status</option>
                <option value="healthy">Healthy</option>
                <option value="atrisk">At Risk</option>
                <option value="critical">Critical</option>
                <option value="active">Has Active Subs</option>
              </select>
            </div>
            <div style={C}>
              {custList.filter(c => {
                if (custSearch) {
                  const s = custSearch.toLowerCase();
                  if (!c.name.toLowerCase().includes(s) && !(c.phone || "").includes(s)) return false;
                }
                if (custFilterStatus === "healthy") return c.h.s >= 70;
                if (custFilterStatus === "atrisk") return c.h.s >= 40 && c.h.s < 70;
                if (custFilterStatus === "critical") return c.h.s < 40;
                if (custFilterStatus === "active") return c.aS > 0;
                return true;
              }).map(c => (
                <div key={c.id} onClick={() => setSelCust(c)} style={{ padding: "5px 0", borderBottom: "1px solid " + bd, cursor: "pointer", display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                  <span><strong>{c.name}</strong> · {c.phone || "—"}</span>
                  <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontWeight: 700, color: "#2a9d8f" }}>{c.tS} sales</span>
                    <span style={{ color: "#16a34a" }}>{c.tV.toLocaleString()} EGP</span>
                    <span style={{ padding: "1px 4px", borderRadius: 6, fontSize: 7, background: c.h.s >= 70 ? "#f0fdf4" : c.h.s >= 40 ? "#fffbeb" : "#fef2f2", color: c.h.c }}>{c.h.l}</span>
                  </span>
                </div>
              ))}
              {custList.length === 0 && <p style={{ fontSize: 9, color: tx2, textAlign: "center", padding: 14 }}>No customers yet. Customers appear automatically when you add sales.</p>}
            </div>
          </div>
        )}

        {/* ═══════════════════════════ ADOBE MONTHLY ═══════════════════════════ */}
        {tab === "adobe" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>🎨 Adobe Monthly Renewals</h2>
              <ExportMenu
                onCsv={() => exportCSV(adobeSchedule.map(a => ({ Customer: a.customer, Phone: a.customerPhone || "", Month: a.monthIndex + "/" + a.totalMonths, "Renew Date": a.renewDate, Days: a.daysUntil, Status: a.status, Price: a.price + " " + a.currency })), "adobe_" + gn() + ".csv")}
                onXlsx={() => exportExcel(adobeSchedule.map(a => ({ Customer: a.customer, Phone: a.customerPhone || "", Month: a.monthIndex + "/" + a.totalMonths, RenewDate: a.renewDate, Days: a.daysUntil, Status: a.status, Price: a.price, Currency: a.currency })), "adobe_" + gn() + ".xls", "Adobe")}
                onPdf={() => exportPDF("Adobe Renewal Schedule", adobeSchedule.map(a => ({ Customer: a.customer, Phone: a.customerPhone || "—", Month: a.monthIndex + "/" + a.totalMonths, "Renew Date": a.renewDate, Days: a.daysUntil, Status: a.status, Price: a.price + " " + a.currency })), "adobe_" + gn() + ".pdf")}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 6, marginBottom: 10 }}>
              {[
                { l: "Overdue", v: adobeOverdue.length, c: "#dc2626" },
                { l: "Due Soon (≤2d)", v: adobePendingReminders.length, c: "#f59e0b" },
                { l: "Upcoming", v: adobeUpcoming.length, c: "#2a9d8f" },
                { l: "Total Scheduled", v: adobeSchedule.length, c: "#1a2e44" }
              ].map((c, i) => (
                <div key={i} style={{ ...C, borderTop: "2px solid " + c.c }}>
                  <p style={{ margin: 0, fontSize: 8, color: tx2 }}>{c.l}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, color: c.c }}>{c.v}</p>
                </div>
              ))}
            </div>
            {adobeSchedule.length === 0 ? (
              <div style={{ ...C, padding: 24, textAlign: "center", color: tx2 }}>
                <p style={{ margin: 0, fontSize: 11 }}>No Adobe subscriptions yet.</p>
                <p style={{ margin: "4px 0 0", fontSize: 9 }}>Sell an "Adobe" service with a period &gt; 0 to see monthly renewal tracking here.</p>
              </div>
            ) : (
              <div style={{ ...C, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, minWidth: 720 }}>
                  <thead>
                    <tr style={{ background: dk ? "#0f172a" : "#f5f7f9", borderBottom: "2px solid " + bd }}>
                      {["Customer", "Phone", "Month", "Renew Date", "Days", "Price", "Status", "Actions"].map(h => (
                        <th key={h} style={{ padding: "7px 8px", textAlign: "left", fontSize: 8, color: tx2, textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {adobeSchedule.map(a => {
                      const rowBg = a.status === "Renewed" ? (dk ? "#052e16" : "#f0fdf4") : a.isOverdue ? (dk ? "#450a0a" : "#fef2f2") : a.needsReminder ? (dk ? "#422006" : "#fffbeb") : "transparent";
                      const statusColor = a.status === "Renewed" ? "#16a34a" : a.isOverdue ? "#dc2626" : a.needsReminder ? "#f59e0b" : "#2a9d8f";
                      return (
                        <tr key={a.alertId} style={{ borderBottom: "1px solid " + bd, background: rowBg }}>
                          <td style={{ padding: "6px 8px", fontWeight: 600 }}>{a.customer}</td>
                          <td style={{ padding: "6px 8px", color: "#2a9d8f", fontSize: 9 }}>{a.customerPhone || "—"}</td>
                          <td style={{ padding: "6px 8px" }}><strong>{a.monthIndex}</strong>/{a.totalMonths}</td>
                          <td style={{ padding: "6px 8px" }}>{a.renewDate}</td>
                          <td style={{ padding: "6px 8px", fontWeight: 700, color: a.daysUntil <= 0 ? "#dc2626" : a.daysUntil <= 7 ? "#f59e0b" : "#16a34a" }}>{a.daysUntil}d</td>
                          <td style={{ padding: "6px 8px", fontWeight: 600, color: "#16a34a" }}>{a.price} {a.currency}</td>
                          <td style={{ padding: "6px 8px" }}><span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 8, fontWeight: 700, background: statusColor + "22", color: statusColor }}>{a.status}</span></td>
                          <td style={{ padding: "6px 8px" }}>
                            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                              {a.status !== "Renewed" ? (
                                <button onClick={() => markAdobeMonthRenewed(a.saleId, a.monthIndex)} style={{ ...BP, padding: "2px 7px", fontSize: 8, background: "#16a34a" }}>✓ Mark Renewed</button>
                              ) : (
                                <button onClick={() => unmarkAdobeMonthRenewed(a.saleId, a.monthIndex)} style={{ ...BG, padding: "2px 7px", fontSize: 8 }}>↩ Undo</button>
                              )}
                              {a.customerPhone && (
                                <a href={waLink(a.customerPhone, "Hi " + a.customer + ",\n\nYour *Adobe* subscription month " + a.monthIndex + "/" + a.totalMonths + " renews on " + a.renewDate + " (in " + a.daysUntil + " days).\n\n💰 " + a.price + " " + a.currency + "\n\nProSkill Team")} target="_blank" rel="noreferrer" style={{ ...BP, padding: "2px 7px", fontSize: 8, background: "#25D366", textDecoration: "none" }}>📱 WA</a>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════ TASKS ═══════════════════════════ */}
        {tab === "tasks" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>✅ Tasks ({tasks.filter(t => t.status === "pending").length} pending)</h2>
              <button onClick={() => setNewTask({ title: "", description: "", priority: "medium", deadline: "" })} style={BP}>+ New Task</button>
            </div>
            {overdueTasks.length > 0 && (
              <div style={{ ...C, marginBottom: 8, background: dk ? "#450a0a" : "#fef2f2", borderLeft: "3px solid #dc2626" }}>
                <p style={{ margin: 0, fontSize: 10, color: "#dc2626", fontWeight: 700 }}>⚠️ {overdueTasks.length} overdue task{overdueTasks.length > 1 ? "s" : ""}</p>
              </div>
            )}
            {newTask && (
              <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 5, marginBottom: 5 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Title *</label><input value={newTask.title} onChange={e => setNewTask(p => ({ ...p, title: e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Priority</label><select value={newTask.priority} onChange={e => setNewTask(p => ({ ...p, priority: e.target.value }))} style={IN}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Deadline</label><input type="date" value={newTask.deadline} onChange={e => setNewTask(p => ({ ...p, deadline: e.target.value }))} style={IN} /></div>
                </div>
                <div style={{ marginBottom: 5 }}><textarea value={newTask.description} onChange={e => setNewTask(p => ({ ...p, description: e.target.value }))} placeholder="Description..." rows={2} style={{ ...IN, resize: "vertical" }} /></div>
                <div style={{ display: "flex", gap: 4 }}><button onClick={addTask} style={BP}>Add Task</button><button onClick={() => setNewTask(null)} style={BG}>Cancel</button></div>
              </div>
            )}
            <div style={C}>
              {tasks.length === 0 ? (
                <p style={{ fontSize: 10, color: tx2, textAlign: "center", padding: 14 }}>No tasks yet. Click "+ New Task" to start.</p>
              ) : tasks.map(t => {
                const overdue = t.status === "pending" && t.deadline && t.deadline < gn();
                const prioColor = t.priority === "high" ? "#dc2626" : t.priority === "medium" ? "#f59e0b" : "#64748b";
                return (
                  <div key={t.id} style={{ padding: "6px 0", borderBottom: "1px solid " + bd, display: "flex", alignItems: "flex-start", gap: 6, opacity: t.status === "done" ? 0.55 : 1, background: overdue ? (dk ? "#450a0a" : "#fef2f2") : "transparent" }}>
                    <input type="checkbox" checked={t.status === "done"} onChange={() => toggleTask(t.id)} style={{ marginTop: 3 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
                        <span style={{ padding: "1px 6px", borderRadius: 8, fontSize: 7, fontWeight: 700, background: prioColor + "22", color: prioColor, textTransform: "uppercase" }}>{t.priority}</span>
                        {t.deadline && <span style={{ fontSize: 8, color: overdue ? "#dc2626" : tx2 }}>📅 {t.deadline}{overdue ? " (OVERDUE)" : ""}</span>}
                      </div>
                      {t.description && <p style={{ margin: "2px 0 0", fontSize: 9, color: tx2 }}>{t.description}</p>}
                    </div>
                    <button onClick={() => delTask(t.id)} style={{ ...BD, padding: "2px 6px", fontSize: 8 }}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══════════════════════════ TEAM ═══════════════════════════ */}
        {tab === "team" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>👥 Team ({team.length})</h2>
              <button onClick={() => setNewMember({ name: "", role: "Sales", phone: "", email: "", commissionRate: 10, commissionBase: "revenue", notes: "" })} style={BP}>+ Add Member</button>
            </div>

            {newMember && (
              <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                <h4 style={{ margin: "0 0 6px", fontSize: 11 }}>New Team Member</h4>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 5, marginBottom: 5 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Name *</label><input value={newMember.name} onChange={e => setNewMember(p => ({ ...p, name: e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Role</label><input value={newMember.role} onChange={e => setNewMember(p => ({ ...p, role: e.target.value }))} placeholder="Sales / Support" style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Phone</label><input value={newMember.phone} onChange={e => setNewMember(p => ({ ...p, phone: e.target.value }))} placeholder="201..." style={IN} /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 5, marginBottom: 5 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Email (optional)</label><input type="email" value={newMember.email} onChange={e => setNewMember(p => ({ ...p, email: e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Commission Base</label><select value={newMember.commissionBase} onChange={e => setNewMember(p => ({ ...p, commissionBase: e.target.value }))} style={IN}><option value="revenue">% of Revenue</option><option value="profit">% of Profit</option><option value="fixed">Fixed / Sale</option></select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Rate {newMember.commissionBase === "fixed" ? "(EGP per sale)" : "(%)"}</label><input type="number" value={newMember.commissionRate} onChange={e => setNewMember(p => ({ ...p, commissionRate: +e.target.value }))} style={IN} /></div>
                </div>
                <div style={{ marginBottom: 5 }}><input value={newMember.notes} onChange={e => setNewMember(p => ({ ...p, notes: e.target.value }))} placeholder="Notes..." style={IN} /></div>
                <div style={{ display: "flex", gap: 4 }}><button onClick={addMember} style={BP}>Save Member</button><button onClick={() => setNewMember(null)} style={BG}>Cancel</button></div>
              </div>
            )}

            {editMember && (
              <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
                <div style={{ ...C, width: 440, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 13 }}>✏️ Edit {editMember.name}</h3>
                    <span onClick={() => setEditMember(null)} style={{ cursor: "pointer", fontSize: 14, color: tx2 }}>✕</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 5, marginBottom: 5 }}>
                    <div><label style={{ fontSize: 7, color: tx2 }}>Name *</label><input value={editMember.name} onChange={e => setEditMember(p => ({ ...p, name: e.target.value }))} style={IN} /></div>
                    <div><label style={{ fontSize: 7, color: tx2 }}>Role</label><input value={editMember.role || ""} onChange={e => setEditMember(p => ({ ...p, role: e.target.value }))} style={IN} /></div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 5 }}>
                    <div><label style={{ fontSize: 7, color: tx2 }}>Phone</label><input value={editMember.phone || ""} onChange={e => setEditMember(p => ({ ...p, phone: e.target.value }))} style={IN} /></div>
                    <div><label style={{ fontSize: 7, color: tx2 }}>Email</label><input type="email" value={editMember.email || ""} onChange={e => setEditMember(p => ({ ...p, email: e.target.value }))} style={IN} /></div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 5 }}>
                    <div><label style={{ fontSize: 7, color: tx2 }}>Commission Base</label><select value={editMember.commissionBase || "revenue"} onChange={e => setEditMember(p => ({ ...p, commissionBase: e.target.value }))} style={IN}><option value="revenue">% of Revenue</option><option value="profit">% of Profit</option><option value="fixed">Fixed / Sale</option></select></div>
                    <div><label style={{ fontSize: 7, color: tx2 }}>Rate {editMember.commissionBase === "fixed" ? "(EGP)" : "(%)"}</label><input type="number" value={editMember.commissionRate || 0} onChange={e => setEditMember(p => ({ ...p, commissionRate: +e.target.value }))} style={IN} /></div>
                  </div>
                  <div style={{ marginBottom: 8 }}><label style={{ fontSize: 7, color: tx2 }}>Notes</label><input value={editMember.notes || ""} onChange={e => setEditMember(p => ({ ...p, notes: e.target.value }))} style={IN} /></div>
                  <div style={{ display: "flex", gap: 4 }}><button onClick={saveMember} style={BP}>Save Changes</button><button onClick={() => setEditMember(null)} style={BG}>Cancel</button></div>
                </div>
              </div>
            )}

            {team.length === 0 ? (
              <div style={{ ...C, padding: 24, textAlign: "center", color: tx2 }}>
                <p style={{ margin: 0, fontSize: 12 }}>No team members yet.</p>
                <p style={{ margin: "6px 0 0", fontSize: 9 }}>Click "+ Add Member" to add sales reps who will be credited for closed sales. Each member can have a custom commission rate.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 8 }}>
                {team.map(m => {
                  const myMonthSales = sales.filter(a => a.done && a.assignedTo === m.id && a.soldDate >= gmr(new Date()).s);
                  const myMonthRev = myMonthSales.reduce((s, a) => s + (a.priceEGP || a.price || 0), 0);
                  const rate = m.commissionRate || 0;
                  const base = m.commissionBase || "revenue";
                  const baseLabel = base === "revenue" ? "% Revenue" : base === "profit" ? "% Profit" : "EGP/sale";
                  return (
                    <div key={m.id} style={{ ...C }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                        <div>
                          <h4 style={{ margin: 0, fontSize: 13 }}>👤 {m.name}</h4>
                          <p style={{ margin: "2px 0 0", fontSize: 9, color: "#2a9d8f", fontWeight: 600 }}>{m.role || "Member"}</p>
                        </div>
                        <div style={{ display: "flex", gap: 3 }}>
                          <button onClick={() => setEditMember({ ...m })} style={{ ...BG, padding: "2px 6px", fontSize: 8 }}>✎</button>
                          <button onClick={() => deleteMember(m.id)} style={{ ...BD, padding: "2px 6px", fontSize: 8 }}>✕</button>
                        </div>
                      </div>
                      <div style={{ fontSize: 9, color: tx2, marginBottom: 6 }}>
                        {m.phone && <p style={{ margin: "0 0 2px" }}>📞 {m.phone} {m.phone && <a href={waLink(m.phone, "Hi " + m.name)} target="_blank" rel="noreferrer" style={{ color: "#25D366", marginLeft: 4 }}>WA</a>}</p>}
                        {m.email && <p style={{ margin: "0 0 2px" }}>✉️ {m.email}</p>}
                        {m.notes && <p style={{ margin: "0 0 2px", fontStyle: "italic" }}>💬 {m.notes}</p>}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginTop: 8 }}>
                        <div style={{ background: dk ? "#0f172a" : "#e8f4f2", padding: 6, borderRadius: 4, textAlign: "center" }}>
                          <p style={{ margin: 0, fontSize: 7, color: tx2 }}>Rate</p>
                          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#2a9d8f" }}>{rate}{base === "fixed" ? "" : "%"}</p>
                          <p style={{ margin: 0, fontSize: 6, color: tx2 }}>{baseLabel}</p>
                        </div>
                        <div style={{ background: dk ? "#0f172a" : "#f0fdf4", padding: 6, borderRadius: 4, textAlign: "center" }}>
                          <p style={{ margin: 0, fontSize: 7, color: tx2 }}>This Month</p>
                          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#16a34a" }}>{myMonthSales.length}</p>
                          <p style={{ margin: 0, fontSize: 6, color: tx2 }}>sales</p>
                        </div>
                        <div style={{ background: dk ? "#0f172a" : "#fffbeb", padding: 6, borderRadius: 4, textAlign: "center" }}>
                          <p style={{ margin: 0, fontSize: 7, color: tx2 }}>Revenue</p>
                          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#f59e0b" }}>{myMonthRev.toLocaleString()}</p>
                          <p style={{ margin: 0, fontSize: 6, color: tx2 }}>EGP</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════ COMMISSION REPORT ═══════════════════════════ */}
        {tab === "commission" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>💰 Commission Report</h2>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <select value={commissionPeriod} onChange={e => setCommissionPeriod(e.target.value)} style={{ ...IN, width: 140 }}>
                  <option value="thisMonth">This Month</option>
                  <option value="lastMonth">Last Month</option>
                  <option value="thisYear">This Year</option>
                  <option value="allTime">All Time</option>
                </select>
                <ExportMenu
                  onCsv={() => exportCSV(commissionReport.map(m => ({ Name: m.name, Role: m.role || "", "Sales Count": m.salesCount, "Revenue (EGP)": m.revenue, "Profit (EGP)": m.profit, "Rate": (m.commissionRate || 0) + (m.commissionBase === "fixed" ? " EGP/sale" : "%"), "Base": m.commissionBase || "revenue", "Commission (EGP)": m.commission })), "commission_" + commissionPeriod + "_" + gn() + ".csv")}
                  onXlsx={() => exportExcel(commissionReport.map(m => ({ Name: m.name, Role: m.role || "", SalesCount: m.salesCount, Revenue: m.revenue, Profit: m.profit, Rate: m.commissionRate || 0, Base: m.commissionBase || "revenue", Commission: m.commission })), "commission_" + commissionPeriod + "_" + gn() + ".xls", "Commissions")}
                  onPdf={() => exportPDF("Commission Report — " + commissionPeriod, commissionReport.map(m => ({ Name: m.name, Role: m.role || "—", Sales: m.salesCount, Revenue: m.revenue.toLocaleString() + " EGP", Profit: m.profit.toLocaleString() + " EGP", Rate: (m.commissionRate || 0) + (m.commissionBase === "fixed" ? " EGP" : "%"), Commission: m.commission.toLocaleString() + " EGP" })), "commission_" + commissionPeriod + "_" + gn() + ".pdf")}
                />
              </div>
            </div>

            {team.length === 0 ? (
              <div style={{ ...C, padding: 24, textAlign: "center", color: tx2 }}>
                <p style={{ margin: 0, fontSize: 12 }}>No team members yet.</p>
                <p style={{ margin: "6px 0 0", fontSize: 9 }}>Go to the Team tab to add sales reps, then assign sales to them to track commissions.</p>
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 6, marginBottom: 10 }}>
                  <div style={{ ...C, borderTop: "3px solid #2a9d8f" }}>
                    <p style={{ margin: 0, fontSize: 8, color: tx2 }}>TEAM SIZE</p>
                    <p style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, color: "#2a9d8f" }}>{team.length}</p>
                  </div>
                  <div style={{ ...C, borderTop: "3px solid #1a2e44" }}>
                    <p style={{ margin: 0, fontSize: 8, color: tx2 }}>SALES CLOSED</p>
                    <p style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, color: dk ? "#e2e8f0" : "#1a2e44" }}>{commissionReport.reduce((s, m) => s + m.salesCount, 0)}</p>
                  </div>
                  <div style={{ ...C, borderTop: "3px solid #16a34a" }}>
                    <p style={{ margin: 0, fontSize: 8, color: tx2 }}>REVENUE</p>
                    <p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: "#16a34a" }}>{commissionReport.reduce((s, m) => s + m.revenue, 0).toLocaleString()} EGP</p>
                  </div>
                  <div style={{ ...C, borderTop: "3px solid #dc2626" }}>
                    <p style={{ margin: 0, fontSize: 8, color: tx2 }}>TOTAL COMMISSIONS DUE</p>
                    <p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: "#dc2626" }}>{totalCommissions.toLocaleString()} EGP</p>
                  </div>
                </div>

                <div style={{ ...C, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, minWidth: 700 }}>
                    <thead>
                      <tr style={{ background: dk ? "#0f172a" : "#f5f7f9", borderBottom: "2px solid " + bd }}>
                        {["Member", "Role", "Sales", "Revenue", "Profit", "Rate", "Commission", ""].map(h => (
                          <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 8, color: tx2, textTransform: "uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {commissionReport.map(m => (
                        <tr key={m.id} style={{ borderBottom: "1px solid " + bd }}>
                          <td style={{ padding: "8px 10px", fontWeight: 700 }}>👤 {m.name}</td>
                          <td style={{ padding: "8px 10px", color: tx2 }}>{m.role || "—"}</td>
                          <td style={{ padding: "8px 10px", fontWeight: 600, color: "#2a9d8f" }}>{m.salesCount}</td>
                          <td style={{ padding: "8px 10px", color: "#16a34a" }}>{m.revenue.toLocaleString()} EGP</td>
                          <td style={{ padding: "8px 10px", color: m.profit >= 0 ? "#16a34a" : "#dc2626" }}>{m.profit.toLocaleString()} EGP</td>
                          <td style={{ padding: "8px 10px", fontSize: 9, color: tx2 }}>{m.commissionRate || 0}{m.commissionBase === "fixed" ? " EGP" : "%"} {m.commissionBase || "rev"}</td>
                          <td style={{ padding: "8px 10px", fontWeight: 800, color: "#dc2626", fontSize: 12 }}>{m.commission.toLocaleString()} EGP</td>
                          <td style={{ padding: "8px 10px" }}>
                            {m.phone && (
                              <a href={waLink(m.phone, "Hi " + m.name + ",\n\nYour commission report for *" + commissionPeriod + "*:\n\n📊 Sales closed: " + m.salesCount + "\n💰 Revenue: " + m.revenue.toLocaleString() + " EGP\n🎯 Commission due: *" + m.commission.toLocaleString() + " EGP*\n\n_ProSkill Digital Agency_")} target="_blank" rel="noreferrer" style={{ ...BP, padding: "3px 8px", fontSize: 8, background: "#25D366", textDecoration: "none" }}>📱 Send via WA</a>
                            )}
                          </td>
                        </tr>
                      ))}
                      <tr style={{ background: dk ? "#1e293b" : "#f5f7f9", borderTop: "2px solid #2a9d8f" }}>
                        <td colSpan={2} style={{ padding: "10px", fontWeight: 800, fontSize: 11 }}>TOTAL</td>
                        <td style={{ padding: "10px", fontWeight: 800 }}>{commissionReport.reduce((s, m) => s + m.salesCount, 0)}</td>
                        <td style={{ padding: "10px", fontWeight: 800, color: "#16a34a" }}>{commissionReport.reduce((s, m) => s + m.revenue, 0).toLocaleString()} EGP</td>
                        <td style={{ padding: "10px", fontWeight: 800, color: "#16a34a" }}>{commissionReport.reduce((s, m) => s + m.profit, 0).toLocaleString()} EGP</td>
                        <td style={{ padding: "10px" }}>—</td>
                        <td style={{ padding: "10px", fontWeight: 800, color: "#dc2626", fontSize: 13 }}>{totalCommissions.toLocaleString()} EGP</td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div style={{ ...C, marginTop: 10, padding: 12, background: dk ? "#0f172a" : "#fffbeb", borderLeft: "3px solid #f59e0b" }}>
                  <p style={{ margin: 0, fontSize: 9, color: tx2 }}><strong>💡 Tip:</strong> Click "📱 Send via WA" to message each team member their commission summary. Export to PDF at month-end for your records.</p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ═══════════════════════════ BUNDLES ═══════════════════════════ */}
        {tab === "bundles" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>📦 Service Bundles</h2>
              <button onClick={() => setNewBundle({ name: "", services: [], price: 0, cost: 0, period: 1, discount: 0 })} style={BP}>+ New Bundle</button>
            </div>
            {newBundle && (
              <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                <h4 style={{ margin: "0 0 6px", fontSize: 11 }}>New Bundle</h4>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 5, marginBottom: 6 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Bundle Name *</label><input value={newBundle.name} onChange={e => setNewBundle(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Starter Pack" style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Price (EGP) *</label><input type="number" value={newBundle.price} onChange={e => setNewBundle(p => ({ ...p, price: +e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Cost (EGP)</label><input type="number" value={newBundle.cost} onChange={e => setNewBundle(p => ({ ...p, cost: +e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Period (months)</label><select value={newBundle.period} onChange={e => setNewBundle(p => ({ ...p, period: +e.target.value }))} style={IN}>{PERS.map(p => <option key={p} value={p}>{PER_LABEL(p)}</option>)}</select></div>
                </div>
                <div style={{ marginBottom: 6 }}>
                  <label style={{ fontSize: 7, color: tx2 }}>Services (pick at least 2)</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 }}>
                    {svcNames.filter(s => !s.endsWith("(Bundle)")).map(s => {
                      const on = newBundle.services.includes(s);
                      return (
                        <span key={s} onClick={() => setNewBundle(p => ({ ...p, services: on ? p.services.filter(x => x !== s) : [...p.services, s] }))} style={{ padding: "3px 8px", borderRadius: 12, fontSize: 9, cursor: "pointer", background: on ? "#2a9d8f" : (dk ? "#334155" : "#e8ebe9"), color: on ? "#fff" : tx, fontWeight: 600 }}>{svcIcon(s)} {s}</span>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}><button onClick={addBundle} style={BP}>Save Bundle</button><button onClick={() => setNewBundle(null)} style={BG}>Cancel</button></div>
              </div>
            )}
            {bundleStats.length === 0 ? (
              <div style={{ ...C, padding: 20, textAlign: "center", color: tx2 }}>
                <p style={{ margin: 0, fontSize: 11 }}>No bundles yet.</p>
                <p style={{ margin: "4px 0 0", fontSize: 9 }}>Create a bundle of 2+ services to upsell and track performance.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 8 }}>
                {bundleStats.map(b => (
                  <div key={b.id} style={{ ...C }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                      <h4 style={{ margin: 0, fontSize: 12 }}>📦 {b.name}</h4>
                      <button onClick={() => delBundle(b.id)} style={{ ...BD, padding: "1px 5px", fontSize: 7 }}>✕</button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginBottom: 6 }}>
                      {b.services.map(s => <span key={s} style={{ padding: "1px 5px", borderRadius: 6, fontSize: 8, background: dk ? "#334155" : "#e8f4f2", color: dk ? "#e2e8f0" : "#2a9d8f" }}>{svcIcon(s)} {s}</span>)}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 5 }}>
                      <div><p style={{ margin: 0, fontSize: 7, color: tx2 }}>Price</p><p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#2a9d8f" }}>{b.price} EGP</p></div>
                      <div><p style={{ margin: 0, fontSize: 7, color: tx2 }}>Sold</p><p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#1a2e44" }}>{b.sold}</p></div>
                      <div><p style={{ margin: 0, fontSize: 7, color: tx2 }}>Revenue</p><p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#16a34a" }}>{b.rev.toLocaleString()}</p></div>
                    </div>
                    <button onClick={() => sellBundle(b)} style={{ ...BP, width: "100%" }}>💰 Sell This Bundle</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════ EXPENSES ═══════════════════════════ */}
        {tab === "expenses" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>🧾 Expenses</h2>
              <div style={{ display: "flex", gap: 4 }}>
                <ExportMenu
                  onCsv={() => exportCSV(exps.map(e => ({ Date: e.date, Category: e.category, Amount: e.amount, Note: e.note || "" })), "expenses_" + gn() + ".csv")}
                  onXlsx={() => exportExcel(exps.map(e => ({ Date: e.date, Category: e.category, Amount: e.amount, Note: e.note || "" })), "expenses_" + gn() + ".xls", "Expenses")}
                  onPdf={() => exportPDF("Expenses Report", exps.map(e => ({ Date: e.date, Category: e.category, Amount: e.amount + " EGP", Note: e.note || "—" })), "expenses_" + gn() + ".pdf")}
                />
                <button onClick={() => setNewExp({ category: ECAT[0], amount: 0, date: gn(), note: "" })} style={BP}>+ Expense</button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 10 }}>
              <div style={{ ...C, borderTop: "2px solid #f59e0b" }}><p style={{ margin: 0, fontSize: 7, color: tx2 }}>THIS MONTH</p><p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: "#f59e0b" }}>{monthExps.toLocaleString()} EGP</p></div>
              <div style={{ ...C, borderTop: "2px solid #dc2626" }}><p style={{ margin: 0, fontSize: 7, color: tx2 }}>TOTAL</p><p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: "#dc2626" }}>{totalExps.toLocaleString()} EGP</p></div>
              <div style={{ ...C, borderTop: "2px solid " + (netProfit >= 0 ? "#16a34a" : "#dc2626") }}><p style={{ margin: 0, fontSize: 7, color: tx2 }}>NET PROFIT</p><p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: netProfit >= 0 ? "#16a34a" : "#dc2626" }}>{netProfit.toLocaleString()} EGP</p></div>
            </div>
            {newExp && (
              <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr", gap: 4, marginBottom: 4 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Category</label><select value={newExp.category} onChange={e => setNewExp(p => ({ ...p, category: e.target.value }))} style={IN}>{ECAT.map(c => <option key={c}>{c}</option>)}</select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Amount (EGP)</label><input type="number" value={newExp.amount} onChange={e => setNewExp(p => ({ ...p, amount: +e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Date</label><input type="date" value={newExp.date} onChange={e => setNewExp(p => ({ ...p, date: e.target.value }))} style={IN} /></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Note</label><input value={newExp.note || ""} onChange={e => setNewExp(p => ({ ...p, note: e.target.value }))} style={IN} /></div>
                </div>
                <div style={{ display: "flex", gap: 4 }}><button onClick={addExpense} style={BP}>Add</button><button onClick={() => setNewExp(null)} style={BG}>✕</button></div>
              </div>
            )}
            <div style={C}>
              {exps.length === 0 ? <p style={{ fontSize: 10, color: tx2, textAlign: "center", padding: 14 }}>No expenses yet.</p> : exps.map(e => (
                <div key={e.id} style={{ padding: "5px 0", borderBottom: "1px solid " + bd, display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                  <span><strong>{e.category}</strong> · {e.date}{e.note && <span style={{ color: tx2 }}> · {e.note}</span>}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontWeight: 700, color: "#dc2626" }}>-{e.amount.toLocaleString()} EGP</span>
                    <button onClick={() => { if (confirm("Delete this expense?")) setExps(p => p.filter(x => x.id !== e.id)); }} style={{ ...BD, padding: "1px 5px", fontSize: 8 }}>✕</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════ REPORTS ═══════════════════════════ */}
        {tab === "reports" && (
          <div>
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>📈 Reports</h2>
            <div style={{ display: "flex", gap: 3, marginBottom: 10, flexWrap: "wrap" }}>
              {[{ id: "all", l: "Overview" }, { id: "renewals", l: "Renewals" }, { id: "followup", l: "Follow-ups" }, { id: "pending", l: "Pending Proofs" }].map(t => (
                <button key={t.id} onClick={() => setRepTab(t.id)} style={{ ...BG, padding: "3px 10px", fontSize: 10, background: repTab === t.id ? "#2a9d8f" : "transparent", color: repTab === t.id ? "#fff" : "#2a9d8f" }}>{t.l}</button>
              ))}
            </div>
            {repTab === "all" && (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 6, marginBottom: 10 }}>
                  {[
                    { l: "Total Sales", v: sales.length, c: "#1a2e44" },
                    { l: "Completed", v: allDone.length, c: "#16a34a" },
                    { l: "Revenue (EGP)", v: myStats.tR.toLocaleString(), c: "#2a9d8f" },
                    { l: "Profit (EGP)", v: myStats.tP.toLocaleString(), c: myStats.tP >= 0 ? "#16a34a" : "#dc2626" },
                    { l: "Expenses", v: totalExps.toLocaleString(), c: "#f59e0b" },
                    { l: "Net", v: netProfit.toLocaleString(), c: netProfit >= 0 ? "#16a34a" : "#dc2626" }
                  ].map((c, i) => (
                    <div key={i} style={{ ...C, borderTop: "2px solid " + c.c }}>
                      <p style={{ margin: 0, fontSize: 8, color: tx2 }}>{c.l}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 800, color: c.c }}>{c.v}</p>
                    </div>
                  ))}
                </div>
                <div style={{ ...C, marginBottom: 10 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 11 }}>Year-to-Date Performance</h3>
                  <Chrt data={allTime.ytdM} height={140} color="#1a2e44" />
                </div>
              </div>
            )}
            {repTab === "renewals" && (
              <div style={C}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <h3 style={{ margin: 0, fontSize: 11 }}>Upcoming Renewals ({sales.filter(a => a.done && dl(a.renewDate) >= 0 && dl(a.renewDate) <= 30).length})</h3>
                  <ExportMenu
                    onCsv={() => exportCSV(sales.filter(a => a.done && dl(a.renewDate) >= 0 && dl(a.renewDate) <= 30).map(a => ({ Customer: a.customer, Phone: a.customerPhone || "", Service: a.service, "Renew Date": a.renewDate, Days: dl(a.renewDate), Price: a.price + " " + (a.currency || "EGP") })), "renewals_" + gn() + ".csv")}
                    onXlsx={() => exportExcel(sales.filter(a => a.done && dl(a.renewDate) >= 0 && dl(a.renewDate) <= 30).map(a => ({ Customer: a.customer, Phone: a.customerPhone || "", Service: a.service, RenewDate: a.renewDate, Days: dl(a.renewDate), Price: a.price })), "renewals_" + gn() + ".xls", "Renewals")}
                    onPdf={() => exportPDF("Upcoming Renewals", sales.filter(a => a.done && dl(a.renewDate) >= 0 && dl(a.renewDate) <= 30).map(a => ({ Customer: a.customer, Phone: a.customerPhone || "—", Service: a.service, "Renew Date": a.renewDate, Days: dl(a.renewDate), Price: a.price + " " + (a.currency || "EGP") })), "renewals_" + gn() + ".pdf")}
                  />
                </div>
                {sales.filter(a => a.done && dl(a.renewDate) >= 0 && dl(a.renewDate) <= 30).sort((a, b) => dl(a.renewDate) - dl(b.renewDate)).map(a => (
                  <div key={a.id} style={{ padding: "4px 0", borderBottom: "1px solid " + bd, display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                    <span><strong>{a.customer}</strong> · {svcIcon(a.service)} {a.service}</span>
                    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ color: dl(a.renewDate) <= 3 ? "#dc2626" : dl(a.renewDate) <= 7 ? "#f59e0b" : "#16a34a", fontWeight: 700 }}>{dl(a.renewDate)}d</span>
                      <span style={{ color: "#16a34a", fontWeight: 600 }}>{a.price} {a.currency || "EGP"}</span>
                      {a.customerPhone && <a href={waLink(a.customerPhone, "Hi " + a.customer + ", your " + a.service + " subscription renews on " + a.renewDate)} target="_blank" rel="noreferrer" style={{ ...BP, padding: "1px 5px", fontSize: 7, background: "#25D366", textDecoration: "none" }}>WA</a>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {repTab === "followup" && (
              <div style={C}>
                <h3 style={{ margin: "0 0 6px", fontSize: 11 }}>Follow-up Needed ({alerts.fu.length})</h3>
                {alerts.fu.length === 0 ? <p style={{ fontSize: 10, color: tx2 }}>No follow-ups pending.</p> : alerts.fu.map(a => (
                  <div key={a.id} style={{ padding: "4px 0", borderBottom: "1px solid " + bd, fontSize: 10 }}>
                    <strong>{a.customer}</strong> · {a.service} · {a.customerPhone || "—"}
                    {a.notes && <p style={{ margin: "1px 0 0", fontSize: 8, color: "#f59e0b" }}>📝 {a.notes}</p>}
                  </div>
                ))}
              </div>
            )}
            {repTab === "pending" && (
              <div style={C}>
                <h3 style={{ margin: "0 0 6px", fontSize: 11 }}>Pending Payment Proofs ({alerts.pendingProofs.length})</h3>
                {alerts.pendingProofs.length === 0 ? <p style={{ fontSize: 10, color: tx2 }}>No pending proofs.</p> : alerts.pendingProofs.map(a => (
                  <div key={a.id} style={{ padding: "4px 0", borderBottom: "1px solid " + bd, display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                    <span><strong>{a.customer}</strong> · {a.service} · {a.price} {a.currency || "EGP"}</span>
                    <button onClick={() => setProofModal({ saleId: a.id })} style={{ ...BP, padding: "1px 6px", fontSize: 8 }}>Review</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════ ACTIVITY / LOGS ═══════════════════════════ */}
        {tab === "logs" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>📜 Activity Log ({logs.length})</h2>
              {logs.length > 0 && <button onClick={() => { if (confirm("Clear all activity logs?")) { setLogs([]); addLog("Cleared activity log"); } }} style={BD}>Clear</button>}
            </div>
            <div style={C}>
              {logs.length === 0 ? <p style={{ fontSize: 10, color: tx2, textAlign: "center", padding: 14 }}>No activity yet.</p> : logs.map(l => (
                <div key={l.id} style={{ padding: "4px 0", borderBottom: "1px solid " + bd, fontSize: 10, display: "flex", justifyContent: "space-between" }}>
                  <span><strong style={{ color: "#2a9d8f" }}>{l.user}</strong> · {l.action}</span>
                  <span style={{ fontSize: 8, color: tx2 }}>{new Date(l.time).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════ GUIDE ═══════════════════════════ */}
        {tab === "guide" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>📋 Service Guides</h2>
              <button onClick={() => setNewGuide({ service: svcNames[0] || "", title: "", text: "", link: "" })} style={BP}>+ New Guide</button>
            </div>
            {newGuide && (
              <div style={{ ...C, marginBottom: 10, border: "2px solid #2a9d8f" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 4, marginBottom: 4 }}>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Service</label><select value={newGuide.service} onChange={e => setNewGuide(p => ({ ...p, service: e.target.value }))} style={IN}>{svcNames.map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><label style={{ fontSize: 7, color: tx2 }}>Title</label><input value={newGuide.title} onChange={e => setNewGuide(p => ({ ...p, title: e.target.value }))} style={IN} /></div>
                </div>
                <div style={{ marginBottom: 4 }}><textarea value={newGuide.text} onChange={e => setNewGuide(p => ({ ...p, text: e.target.value }))} placeholder="Guide steps..." rows={3} style={{ ...IN, resize: "vertical" }} /></div>
                <div style={{ marginBottom: 4 }}><input value={newGuide.link} onChange={e => setNewGuide(p => ({ ...p, link: e.target.value }))} placeholder="Link (optional)" style={IN} /></div>
                <div style={{ display: "flex", gap: 4 }}><button onClick={addGuide} style={BP}>Save</button><button onClick={() => setNewGuide(null)} style={BG}>✕</button></div>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 8 }}>
              {guides.length === 0 ? <div style={{ ...C, padding: 20, textAlign: "center", color: tx2, gridColumn: "1/-1" }}><p style={{ margin: 0, fontSize: 11 }}>No guides yet. Add step-by-step instructions for each service.</p></div> : guides.map(g => (
                <div key={g.id} style={C}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                    <h4 style={{ margin: 0, fontSize: 11 }}>{svcIcon(g.service)} {g.title || g.service}</h4>
                    <div style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => setEditGuide({ ...g })} style={{ ...BG, padding: "1px 5px", fontSize: 8 }}>✎</button>
                      <button onClick={() => { if (confirm("Delete?")) deleteGuide(g.id); }} style={{ ...BD, padding: "1px 5px", fontSize: 8 }}>✕</button>
                    </div>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 9, color: tx2, whiteSpace: "pre-wrap" }}>{g.text}</p>
                  {g.link && <a href={g.link} target="_blank" rel="noreferrer" style={{ fontSize: 9, color: "#2a9d8f" }}>🔗 {g.link}</a>}
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* MOBILE BOTTOM NAV */}
      {isMobile && (
        <div style={{ background: "#1a2e44", padding: "4px 2px", display: "flex", justifyContent: "space-around", flexShrink: 0, borderTop: "1px solid rgba(255,255,255,0.08)", overflowX: "auto" }}>
          {visTabs.slice(0, 6).map(t => (
            <div key={t.id} onClick={() => setTab(t.id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "4px 6px", cursor: "pointer", color: tab === t.id ? "#2a9d8f" : "#94a3b8", flexShrink: 0 }}>
              <span style={{ fontSize: 15 }}>{t.ic}</span>
              <span style={{ fontSize: 7, marginTop: 1 }}>{t.l}</span>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

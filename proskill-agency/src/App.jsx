import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const SUPABASE_URL = "https://jsemibrimkacjbbsdozm.supabase.co";
const SUPABASE_KEY = "sb_publishable_6CVSz3Ss2wryTv1k6zVLzA_hkjCOV0k";

// Simple Supabase client via fetch
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
    const r = await this.req("/rest/v1/proskill_workspace?select=data&limit=1");
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) return r.data[0].data;
    return null;
  },

  async saveData(data) {
    if (!this.user) return { ok: false };
    const body = { owner_id: this.user.id, workspace_key: "ws_" + this.user.id, data };
    return await this.req("/rest/v1/proskill_workspace", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: JSON.stringify(body) });
  },
};

// Constants
const DEFAULT_SERVICES = [
  { name: "Adobe", icon: "🎨" },
  { name: "ChatGPT", icon: "🤖" },
  { name: "LinkedIn", icon: "💼" },
  { name: "Canva", icon: "🖌️" },
  { name: "Microsoft 365", icon: "📎" },
];

const DEFAULT_CHECKLIST = ["Payment confirmed", "Account ready", "Activated", "Sent to client"];

const PERIODS = [1, 3, 6, 12, 24, 0, -1];
const periodLabel = (p) => p === 0 ? "No period" : p === -1 ? "Lifetime" : p + " month" + (p > 1 ? "s" : "");

const CURRENCIES = ["EGP", "USD", "SAR", "EUR"];
const RATES = { EGP: 1, USD: 48.5, SAR: 12.9, EUR: 53 };

// Helpers
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function daysUntil(dateStr) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(dateStr) - t) / 86400000);
}
function toEGP(amount, currency) {
  return Math.round(amount * (RATES[currency] || 1));
}

let saveTimer = null;

export default function App() {
  // Auth state
  const [authStatus, setAuthStatus] = useState("loading"); // loading | login | app
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authLoading, setAuthLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState("saved"); // saved | saving | error
  const [currentUser, setCurrentUser] = useState(null);

  // App data
  const [services, setServices] = useState(DEFAULT_SERVICES);
  const [sales, setSales] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [stock, setStock] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [logs, setLogs] = useState([]);
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST);
  const [dk, setDk] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

  // UI state
  const [tab, setTab] = useState("dashboard");
  const [showNewSale, setShowNewSale] = useState(false);
  const [newSale, setNewSale] = useState(null);
  const [selectedSale, setSelectedSale] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterProduct, setFilterProduct] = useState("all");
  const [stockSearch, setStockSearch] = useState("");
  const [stockView, setStockView] = useState("all");
  const [newStock, setNewStock] = useState(null);

  // Initial auth check
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
        if (d.services) setServices(d.services);
        if (d.sales) setSales(d.sales);
        if (d.customers) setCustomers(d.customers);
        if (d.stock) setStock(d.stock);
        if (d.expenses) setExpenses(d.expenses);
        if (d.logs) setLogs(d.logs);
        if (d.checklist) setChecklist(d.checklist);
        if (d.dk) setDk(d.dk);
      }
    } catch (e) {}
    setDataLoaded(true);
  };

  // Auto-save
  useEffect(() => {
    if (!dataLoaded || authStatus !== "app") return;
    setSyncStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const r = await sb.saveData({ services, sales, customers, stock, expenses, logs, checklist, dk });
      setSyncStatus(r.ok ? "saved" : "error");
    }, 1500);
  }, [services, sales, customers, stock, expenses, logs, checklist, dk, dataLoaded, authStatus]);

  const addLog = (action) => {
    const entry = { id: Date.now(), user: currentUser ? currentUser.email : "?", action, time: new Date().toISOString() };
    setLogs((p) => [entry, ...p].slice(0, 100));
  };

  // Auth handlers
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
      if (msg.toLowerCase().includes("already")) setAuthError("Account already exists. Please sign in.");
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
    setDataLoaded(false);
  };

  // Sale handlers
  const createSale = () => {
    if (!newSale || !newSale.customer || !newSale.customer.trim()) { alert("Customer name required"); return; }
    if (!newSale.price || newSale.price <= 0) { alert("Valid price required"); return; }

    const saleId = Date.now();
    const renewDate = newSale.period > 0 ? addMonths(newSale.soldDate, newSale.period) : newSale.period === -1 ? "2099-12-31" : newSale.soldDate;

    // Auto-link stock
    const availableStock = stock.find((s) => s.product === newSale.service && !s.sold);
    if (availableStock) {
      setStock((p) => p.map((s) => s.id === availableStock.id ? { ...s, sold: true, linkedSaleId: saleId } : s));
    }

    const sale = {
      ...newSale,
      id: saleId,
      done: false,
      followUp: false,
      renewDate,
      priceEGP: toEGP(newSale.price, newSale.currency),
      soldBy: currentUser ? currentUser.email : "?",
      createdDate: todayStr(),
      linkedStockId: availableStock ? availableStock.id : null,
      checklist: checklist.map((label) => ({ label, checked: false })),
    };

    // Add to customer list if new
    const custName = sale.customer.trim().toLowerCase();
    if (!customers.find((c) => c.name.toLowerCase() === custName)) {
      setCustomers((p) => [...p, { id: Date.now() + 1, name: sale.customer.trim(), phone: sale.customerPhone || "", createdDate: todayStr() }]);
    }

    setSales((p) => [sale, ...p]);
    addLog("Sale: " + sale.customer + " - " + sale.service);
    setNewSale(null);
    setShowNewSale(false);
  };

  const toggleSaleDone = (id) => {
    const s = sales.find((x) => x.id === id);
    setSales((p) => p.map((x) => x.id === id ? { ...x, done: !x.done } : x));
    if (s) addLog((s.done ? "Undone" : "Completed") + ": " + s.customer);
  };

  const deleteSale = (id) => {
    if (!confirm("Delete this sale?")) return;
    const s = sales.find((x) => x.id === id);
    if (s && s.linkedStockId) {
      setStock((p) => p.map((r) => r.id === s.linkedStockId ? { ...r, sold: false, linkedSaleId: null } : r));
    }
    setSales((p) => p.filter((x) => x.id !== id));
    if (s) addLog("Deleted: " + s.customer);
  };

  // Stock handlers
  const addStockAccount = () => {
    if (!newStock || !newStock.email.trim() || !newStock.product) return;
    setStock((p) => [...p, { ...newStock, id: Date.now(), sold: false }]);
    addLog("Added stock account: " + newStock.product);
    setNewStock(null);
  };

  const toggleStockSold = (id) => {
    setStock((p) => p.map((r) => r.id === id ? { ...r, sold: !r.sold } : r));
  };

  const deleteStock = (id) => {
    if (!confirm("Delete account?")) return;
    setStock((p) => p.filter((r) => r.id !== id));
  };

  // Computed stats
  const doneSales = sales.filter((s) => s.done);
  const totalRevenue = doneSales.reduce((sum, s) => sum + (s.priceEGP || 0), 0);
  const totalCost = doneSales.reduce((sum, s) => sum + toEGP(s.costPrice || 0, s.currency), 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const netProfit = totalRevenue - totalCost - totalExpenses;
  const pendingCount = sales.filter((s) => !s.done).length;

  const filteredSales = useMemo(() => {
    let list = sales;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter((x) => (x.customer || "").toLowerCase().includes(s) || (x.customerPhone || "").includes(s) || (x.service || "").toLowerCase().includes(s));
    }
    if (filterProduct !== "all") list = list.filter((x) => x.service === filterProduct);
    if (filterStatus === "done") list = list.filter((x) => x.done);
    if (filterStatus === "pending") list = list.filter((x) => !x.done);
    if (filterStatus === "followup") list = list.filter((x) => x.followUp);
    return list;
  }, [sales, search, filterStatus, filterProduct]);

  const filteredStock = useMemo(() => {
    let list = stock;
    if (stockView === "available") list = list.filter((s) => !s.sold);
    if (stockView === "sold") list = list.filter((s) => s.sold);
    if (stockSearch) {
      const s = stockSearch.toLowerCase();
      list = list.filter((x) => (x.email || "").toLowerCase().includes(s) || (x.product || "").toLowerCase().includes(s));
    }
    return list;
  }, [stock, stockView, stockSearch]);

  // Stock stats by product
  const stockStats = useMemo(() => {
    const result = {};
    services.forEach((svc) => {
      const all = stock.filter((r) => r.product === svc.name);
      result[svc.name] = {
        total: all.length,
        available: all.filter((r) => !r.sold).length,
        sold: all.filter((r) => r.sold).length,
      };
    });
    return result;
  }, [stock, services]);

  // Theme
  const bg = dk ? "#0f172a" : "#f5f7f9";
  const cardBg = dk ? "#1e293b" : "#ffffff";
  const tx = dk ? "#e2e8f0" : "#1a2e44";
  const tx2 = dk ? "#94a3b8" : "#64748b";
  const bd = dk ? "#334155" : "#e8ebe9";

  const C = { background: cardBg, borderRadius: 10, padding: 14, border: "1px solid " + bd };
  const BP = { background: "#2a9d8f", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600, fontSize: 11 };
  const BG = { ...BP, background: "transparent", color: "#2a9d8f", border: "1px solid #2a9d8f" };
  const BD = { ...BP, background: "#ef4444" };
  const IN = { border: "1px solid " + (dk ? "#475569" : "#d1d9e0"), borderRadius: 6, padding: "6px 10px", fontSize: 12, width: "100%", boxSizing: "border-box", outline: "none", background: dk ? "#334155" : "#ffffff", color: tx };

  // ─── RENDER ───────────────────────────────────────────────────────────────

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
            {authMode === "signup" ? "Your data syncs across all devices automatically." : "Sign in from any device to access your data."}
          </p>
        </div>
      </div>
    );
  }

  // ─── MAIN APP ────────────────────────────────────────────────────────────

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "sales", label: "Sales", icon: "💰" },
    { id: "customers", label: "Customers", icon: "👤" },
    { id: "stock", label: "Stock", icon: "📦" },
    { id: "expenses", label: "Expenses", icon: "🧾" },
    { id: "logs", label: "Activity", icon: "📜" },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'Inter',system-ui,sans-serif", background: bg, color: tx, overflow: "hidden" }}>
      {/* SIDEBAR */}
      <div style={{ width: 200, background: "#1a2e44", color: "#fff", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "14px 14px 6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: 6, background: "#2a9d8f", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 11 }}>PS</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>ProSkill</div>
              <div style={{ fontSize: 8, color: "#2a9d8f", letterSpacing: 1.5, fontWeight: 600 }}>DIGITAL AGENCY</div>
            </div>
          </div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: syncStatus === "saved" ? "#16a34a" : syncStatus === "saving" ? "#f59e0b" : "#dc2626" }} />
            <span style={{ fontSize: 9, color: syncStatus === "saved" ? "#16a34a" : syncStatus === "saving" ? "#f59e0b" : "#dc2626" }}>
              {syncStatus === "saved" ? "☁️ Synced" : syncStatus === "saving" ? "Saving..." : "Sync error"}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, padding: "8px 0" }}>
          {tabs.map((t) => (
            <div key={t.id} onClick={() => setTab(t.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", cursor: "pointer", background: tab === t.id ? "rgba(42,157,143,0.15)" : "transparent", borderLeft: tab === t.id ? "3px solid #2a9d8f" : "3px solid transparent", color: tab === t.id ? "#fff" : "#94a3b8", fontSize: 12 }}>
              <span style={{ fontSize: 14 }}>{t.icon}</span>
              <span>{t.label}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 6, wordBreak: "break-all" }}>{currentUser ? currentUser.email : ""}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <span onClick={() => setDk(!dk)} style={{ cursor: "pointer", fontSize: 12 }}>{dk ? "☀️" : "🌙"}</span>
            <span onClick={handleSignOut} style={{ fontSize: 10, color: "#94a3b8", cursor: "pointer" }}>Logout</span>
          </div>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <div>
            <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>📊 Dashboard</h2>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginBottom: 16 }}>
              <div style={{ ...C, borderTop: "3px solid #2a9d8f" }}>
                <div style={{ fontSize: 9, color: tx2, fontWeight: 600, letterSpacing: 1 }}>TOTAL REVENUE</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#2a9d8f", marginTop: 4 }}>{totalRevenue.toLocaleString()} EGP</div>
              </div>
              <div style={{ ...C, borderTop: "3px solid #16a34a" }}>
                <div style={{ fontSize: 9, color: tx2, fontWeight: 600, letterSpacing: 1 }}>NET PROFIT</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: netProfit >= 0 ? "#16a34a" : "#dc2626", marginTop: 4 }}>{netProfit.toLocaleString()} EGP</div>
              </div>
              <div style={{ ...C, borderTop: "3px solid #f59e0b" }}>
                <div style={{ fontSize: 9, color: tx2, fontWeight: 600, letterSpacing: 1 }}>PENDING</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#f59e0b", marginTop: 4 }}>{pendingCount}</div>
              </div>
              <div style={{ ...C, borderTop: "3px solid #8b5cf6" }}>
                <div style={{ fontSize: 9, color: tx2, fontWeight: 600, letterSpacing: 1 }}>CUSTOMERS</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#8b5cf6", marginTop: 4 }}>{customers.length}</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 12 }}>
              <div style={C}>
                <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>📦 Stock Status</h3>
                {services.filter((s) => stockStats[s.name] && stockStats[s.name].total > 0).map((s) => {
                  const stat = stockStats[s.name];
                  return (
                    <div key={s.name} style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
                        <span>{s.icon} {s.name}</span>
                        <span style={{ color: stat.available < 3 ? "#dc2626" : "#16a34a", fontWeight: 600 }}>{stat.available}/{stat.total}</span>
                      </div>
                      <div style={{ height: 4, background: dk ? "#334155" : "#e8ebe9", borderRadius: 2 }}>
                        <div style={{ height: 4, width: Math.min(100, Math.round((stat.available / stat.total) * 100)) + "%", background: stat.available < 3 ? "#dc2626" : "#2a9d8f", borderRadius: 2 }} />
                      </div>
                    </div>
                  );
                })}
                {services.every((s) => !stockStats[s.name] || stockStats[s.name].total === 0) && (
                  <p style={{ fontSize: 10, color: tx2 }}>No stock accounts yet. Go to Stock tab to add some.</p>
                )}
              </div>

              <div style={C}>
                <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>🕒 Recent Sales</h3>
                {sales.slice(0, 5).map((s) => (
                  <div key={s.id} style={{ padding: "4px 0", borderBottom: "1px solid " + bd, fontSize: 11, display: "flex", justifyContent: "space-between" }}>
                    <span>{s.customer}</span>
                    <span style={{ color: s.done ? "#16a34a" : "#f59e0b", fontWeight: 600 }}>{s.price} {s.currency}</span>
                  </div>
                ))}
                {sales.length === 0 && <p style={{ fontSize: 10, color: tx2 }}>No sales yet.</p>}
              </div>
            </div>
          </div>
        )}

        {/* SALES */}
        {tab === "sales" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>💰 Sales ({filteredSales.length})</h2>
              <button onClick={() => { setNewSale({ service: services[0] ? services[0].name : "", customer: "", customerPhone: "", customerEmail: "", price: 0, costPrice: 0, currency: "EGP", period: 1, soldDate: todayStr(), notes: "" }); setShowNewSale(true); }} style={BP}>+ New Sale</button>
            </div>

            {showNewSale && newSale && (
              <div style={{ ...C, marginBottom: 12, border: "2px solid #2a9d8f" }}>
                <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>New Sale</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Service</label>
                    <select value={newSale.service} onChange={(e) => setNewSale((p) => ({ ...p, service: e.target.value }))} style={IN}>
                      {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Customer *</label>
                    <input value={newSale.customer} onChange={(e) => setNewSale((p) => ({ ...p, customer: e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Phone</label>
                    <input value={newSale.customerPhone} onChange={(e) => setNewSale((p) => ({ ...p, customerPhone: e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Email</label>
                    <input type="email" value={newSale.customerEmail} onChange={(e) => setNewSale((p) => ({ ...p, customerEmail: e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Price *</label>
                    <input type="number" value={newSale.price} onChange={(e) => setNewSale((p) => ({ ...p, price: +e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Cost</label>
                    <input type="number" value={newSale.costPrice} onChange={(e) => setNewSale((p) => ({ ...p, costPrice: +e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Currency</label>
                    <select value={newSale.currency} onChange={(e) => setNewSale((p) => ({ ...p, currency: e.target.value }))} style={IN}>
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Period</label>
                    <select value={newSale.period} onChange={(e) => setNewSale((p) => ({ ...p, period: +e.target.value }))} style={IN}>
                      {PERIODS.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Date</label>
                    <input type="date" value={newSale.soldDate} onChange={(e) => setNewSale((p) => ({ ...p, soldDate: e.target.value }))} style={IN} />
                  </div>
                </div>
                <input value={newSale.notes} onChange={(e) => setNewSale((p) => ({ ...p, notes: e.target.value }))} placeholder="Notes (optional)..." style={{ ...IN, marginBottom: 8 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={createSale} style={BP}>Create Sale</button>
                  <button onClick={() => { setShowNewSale(false); setNewSale(null); }} style={BG}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <input placeholder="🔍 Search customer, phone, service..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...IN, flex: 2, minWidth: 200 }} />
              <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} style={{ ...IN, flex: 1, minWidth: 140 }}>
                <option value="all">All Products</option>
                {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ ...IN, flex: 1, minWidth: 140 }}>
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="done">Done</option>
                <option value="followup">Follow-up</option>
              </select>
            </div>

            <div style={{ ...C, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
                  <thead>
                    <tr style={{ background: dk ? "#0f172a" : "#f5f7f9", borderBottom: "2px solid " + bd }}>
                      {["Status", "Customer", "Service", "Phone", "Price", "Date", "Renew", ""].map((h) => (
                        <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: tx2, letterSpacing: 0.5, textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSales.length === 0 && (
                      <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: tx2, fontSize: 12 }}>No sales yet. Click "+ New Sale" to create one.</td></tr>
                    )}
                    {filteredSales.map((s) => {
                      const d = daysUntil(s.renewDate);
                      const rColor = d <= 0 ? "#dc2626" : d <= 7 ? "#f59e0b" : "#16a34a";
                      return (
                        <tr key={s.id} style={{ borderBottom: "1px solid " + bd }}>
                          <td style={{ padding: "10px 12px" }}>
                            <input type="checkbox" checked={s.done} onChange={() => toggleSaleDone(s.id)} style={{ cursor: "pointer", width: 16, height: 16 }} />
                          </td>
                          <td style={{ padding: "10px 12px", fontSize: 11 }}>
                            <div style={{ fontWeight: 600 }}>{s.customer}</div>
                            {s.customerEmail && <div style={{ fontSize: 9, color: tx2 }}>{s.customerEmail}</div>}
                          </td>
                          <td style={{ padding: "10px 12px", fontSize: 11 }}>{s.service}</td>
                          <td style={{ padding: "10px 12px", fontSize: 10, color: tx2 }}>{s.customerPhone || "—"}</td>
                          <td style={{ padding: "10px 12px", fontSize: 11, fontWeight: 600, color: "#16a34a" }}>{s.price} {s.currency}</td>
                          <td style={{ padding: "10px 12px", fontSize: 10, color: tx2 }}>{s.soldDate}</td>
                          <td style={{ padding: "10px 12px", fontSize: 10 }}>
                            {s.period === 0 ? <span style={{ color: tx2 }}>—</span> : s.period === -1 ? <span style={{ color: "#2a9d8f", fontWeight: 600 }}>∞</span> : <span style={{ color: rColor, fontWeight: 600 }}>{d}d</span>}
                          </td>
                          <td style={{ padding: "10px 12px" }}>
                            <button onClick={() => deleteSale(s.id)} style={{ ...BD, padding: "3px 8px", fontSize: 9 }}>✕</button>
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

        {/* CUSTOMERS */}
        {tab === "customers" && (
          <div>
            <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>👤 Customers ({customers.length})</h2>
            {customers.length === 0 ? (
              <div style={{ ...C, textAlign: "center", padding: 32, color: tx2 }}>
                <p style={{ fontSize: 40, margin: 0 }}>👤</p>
                <p style={{ margin: "8px 0 0", fontSize: 13 }}>No customers yet.</p>
                <p style={{ margin: "4px 0 0", fontSize: 10 }}>Customers are added automatically when you create sales.</p>
              </div>
            ) : (
              <div style={C}>
                {customers.map((c) => {
                  const cSales = sales.filter((s) => s.customer && s.customer.toLowerCase() === c.name.toLowerCase());
                  const done = cSales.filter((s) => s.done);
                  const value = done.reduce((sum, s) => sum + (s.priceEGP || 0), 0);
                  return (
                    <div key={c.id} style={{ padding: "10px 0", borderBottom: "1px solid " + bd, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: 10, color: tx2 }}>{c.phone || "—"}</div>
                      </div>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <span style={{ color: "#2a9d8f", fontWeight: 600 }}>{done.length} sales</span>
                        <span style={{ color: "#16a34a", fontWeight: 600 }}>{value.toLocaleString()} EGP</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* STOCK */}
        {tab === "stock" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>📦 Stock ({stock.length})</h2>
              <button onClick={() => setNewStock({ product: services[0] ? services[0].name : "", email: "", password: "", link: "", note: "" })} style={BP}>+ Add Account</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8, marginBottom: 12 }}>
              <div style={{ ...C, borderTop: "3px solid #2a9d8f" }}>
                <div style={{ fontSize: 9, color: tx2, fontWeight: 700, letterSpacing: 0.5 }}>AVAILABLE</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#2a9d8f" }}>{stock.filter((s) => !s.sold).length}</div>
              </div>
              <div style={{ ...C, borderTop: "3px solid #dc2626" }}>
                <div style={{ fontSize: 9, color: tx2, fontWeight: 700, letterSpacing: 0.5 }}>SOLD</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#dc2626" }}>{stock.filter((s) => s.sold).length}</div>
              </div>
              {services.map((svc) => {
                const stat = stockStats[svc.name] || { available: 0, sold: 0, total: 0 };
                if (stat.total === 0) return null;
                return (
                  <div key={svc.name} style={C}>
                    <div style={{ fontSize: 9, color: tx2, fontWeight: 700, letterSpacing: 0.5 }}>{svc.icon} {svc.name.toUpperCase()}</div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: stat.available === 0 && stat.total > 0 ? "#dc2626" : "#16a34a" }}>{stat.available}</div>
                    <div style={{ fontSize: 9, color: tx2 }}>{stat.sold} sold · {stat.total} total</div>
                  </div>
                );
              })}
            </div>

            {newStock && (
              <div style={{ ...C, marginBottom: 12, border: "2px solid #2a9d8f" }}>
                <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>New Account</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Product</label>
                    <select value={newStock.product} onChange={(e) => setNewStock((p) => ({ ...p, product: e.target.value }))} style={IN}>
                      {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Email *</label>
                    <input value={newStock.email} onChange={(e) => setNewStock((p) => ({ ...p, email: e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Password</label>
                    <input value={newStock.password} onChange={(e) => setNewStock((p) => ({ ...p, password: e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Link</label>
                    <input value={newStock.link} onChange={(e) => setNewStock((p) => ({ ...p, link: e.target.value }))} style={IN} />
                  </div>
                  <div>
                    <label style={{ fontSize: 9, color: tx2, fontWeight: 600 }}>Note</label>
                    <input value={newStock.note} onChange={(e) => setNewStock((p) => ({ ...p, note: e.target.value }))} style={IN} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={addStockAccount} style={BP}>Add</button>
                  <button onClick={() => setNewStock(null)} style={BG}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <input placeholder="🔍 Search..." value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} style={{ ...IN, flex: 1, minWidth: 200 }} />
              <div style={{ display: "flex", gap: 4 }}>
                {["all", "available", "sold"].map((v) => (
                  <button key={v} onClick={() => setStockView(v)} style={{ ...BG, padding: "5px 12px", fontSize: 10, background: stockView === v ? "#2a9d8f" : "transparent", color: stockView === v ? "#fff" : "#2a9d8f", textTransform: "capitalize" }}>
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ ...C, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
                  <thead>
                    <tr style={{ background: dk ? "#0f172a" : "#f5f7f9", borderBottom: "2px solid " + bd }}>
                      {["", "Product", "Email", "Password", "Link", "Note", "Status", ""].map((h) => (
                        <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: tx2, letterSpacing: 0.5, textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStock.length === 0 && (
                      <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: tx2, fontSize: 12 }}>No accounts. Click "+ Add Account" to add one.</td></tr>
                    )}
                    {filteredStock.map((row) => (
                      <tr key={row.id} style={{ borderBottom: "1px solid " + bd, opacity: row.sold ? 0.6 : 1 }}>
                        <td style={{ padding: "10px 12px" }}>
                          <input type="checkbox" checked={row.sold} onChange={() => toggleStockSold(row.id)} style={{ cursor: "pointer", width: 16, height: 16 }} />
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 11, fontWeight: 600 }}>{row.product}</td>
                        <td style={{ padding: "10px 12px", fontSize: 11 }}>{row.email}</td>
                        <td style={{ padding: "10px 12px", fontSize: 11, fontFamily: "monospace" }}>{row.password || "—"}</td>
                        <td style={{ padding: "10px 12px", fontSize: 10 }}>
                          {row.link ? <a href={row.link} target="_blank" rel="noreferrer" style={{ color: "#2a9d8f" }}>Open</a> : "—"}
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 10, color: tx2 }}>{row.note || "—"}</td>
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{ padding: "2px 8px", borderRadius: 12, fontSize: 9, fontWeight: 700, background: row.sold ? "#fef2f2" : "#e8f4f2", color: row.sold ? "#dc2626" : "#2a9d8f" }}>
                            {row.sold ? "Sold" : "Available"}
                          </span>
                        </td>
                        <td style={{ padding: "10px 12px" }}>
                          <button onClick={() => deleteStock(row.id)} style={{ ...BD, padding: "3px 8px", fontSize: 9 }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* EXPENSES */}
        {tab === "expenses" && (
          <div>
            <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>🧾 Expenses</h2>
            <div style={C}>
              <p style={{ fontSize: 12, color: tx2, textAlign: "center", padding: 16 }}>Expenses tracking — coming soon</p>
            </div>
          </div>
        )}

        {/* LOGS */}
        {tab === "logs" && (
          <div>
            <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>📜 Activity Log</h2>
            <div style={C}>
              {logs.length > 0 ? logs.slice(0, 40).map((l) => (
                <div key={l.id} style={{ padding: "6px 0", borderBottom: "1px solid " + bd, display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <div>
                    <strong style={{ color: "#2a9d8f" }}>{l.user}</strong>
                    <span style={{ color: tx2, marginLeft: 8 }}>{l.action}</span>
                  </div>
                  <span style={{ fontSize: 9, color: tx2 }}>{new Date(l.time).toLocaleString()}</span>
                </div>
              )) : <p style={{ fontSize: 11, color: tx2, textAlign: "center", padding: 14 }}>No activity yet.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
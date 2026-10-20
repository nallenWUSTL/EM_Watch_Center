/* Shared helpers for the dashboard shell: campus constants, time formatting,
   proxy-origin resolution and an auto-escaping HTML template tag. Exposed on
   window.WUEM so the plain <script> files can share them without a bundler. */
(function () {
  const CFG = window.WUEM_CONFIG || {};
  const W = (window.WUEM = window.WUEM || {});

  const DANFORTH = (CFG.campuses && CFG.campuses.danforth) || { lat: 38.6488, lon: -90.3108, name: "Danforth Campus" };
  const MEDICAL = (CFG.campuses && CFG.campuses.medical) || { lat: 38.6362, lon: -90.2636, name: "Medical Campus" };
  const TZ = "America/Chicago";
  // Managed WashU devices block *.workers.dev at the network layer, so the proxy
  // origin must be replaceable without redeploying the dashboard: a value the
  // desk saved locally wins, then the configured default host.
  // Returns a normalized absolute origin, or null if the value cannot be one.
  const normalizeOrigin = raw => {
    const v = String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
    if (!v) return null;
    const withScheme = /^https?:\/\//i.test(v) ? v : "https://" + v;
    try {
      const u = new URL(withScheme);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
      return u.origin;
    } catch (e) { return null; }
  };

  const WORKER_DEFAULT = normalizeOrigin(CFG.workerOrigin) || "https://washu-em-ameren.washu-em.workers.dev";
  const ENDPOINT_STORE = "wuem-proxy-origin";

  const proxyOrigin = () => {
    try {
      const saved = normalizeOrigin(localStorage.getItem(ENDPOINT_STORE));
      if (saved) return saved;
    } catch (e) {}
    return WORKER_DEFAULT;
  };

  // A saved value that cannot be an origin is reported as invalid rather than
  // silently ignored — otherwise the desk sees the default working and never
  // learns their entry was rejected.
  const proxyInvalid = () => {
    try {
      const raw = (localStorage.getItem(ENDPOINT_STORE) || "").trim();
      return raw && !normalizeOrigin(raw) ? raw : null;
    } catch (e) { return null; }
  };

  const round1 = v => Math.round(v * 10) / 10;
  const tzAbbr = iso => { try { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).formatToParts(new Date(iso)).find(p => p.type === "timeZoneName").value; } catch (e) { return "CT"; } };
  const fmtTime = iso => { if (!iso) return "—"; const d = new Date(iso); if (isNaN(d.getTime())) return "—"; try { return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }); } catch (e) { return "—"; } };
  const fmtZoned = iso => { const t = fmtTime(iso); return t === "—" ? t : t + " " + tzAbbr(iso); };
  const isoOffsetMin = iso => { const m = String(iso || "").match(/(Z|[+-]\d{2}:?\d{2})$/); if (!m) return null; if (m[1] === "Z") return 0; const sign = m[1][0] === "-" ? -1 : 1; const p = m[1].slice(1).replace(":", ""); return sign * (parseInt(p.slice(0, 2), 10) * 60 + parseInt(p.slice(2), 10)); };
  const campusOffsetMin = iso => { try { const d = new Date(iso); return Math.round((new Date(d.toLocaleString("en-US", { timeZone: TZ })) - new Date(d.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000); } catch (e) { return null; } };
  const officeClock = iso => { const off = isoOffsetMin(iso); const d = new Date(iso); if (off === null || isNaN(d)) return null; const sh = new Date(d.getTime() + off * 60000); const sign = off < 0 ? "-" : "+"; const abs = Math.abs(off); return String(sh.getUTCHours()).padStart(2, "0") + ":" + String(sh.getUTCMinutes()).padStart(2, "0") + " UTC" + sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0"); };
  const fmtDay = iso => { if (!iso) return "—"; const d = new Date(iso); if (isNaN(d.getTime()) || d.getUTCFullYear() < 1900) return "—"; try { return d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" }) + " " + fmtTime(iso); } catch (e) { return "—"; } };
  const c2f = c => c === null || c === undefined ? null : Math.round(c * 9 / 5 + 32);
  const kmh2mph = v => v === null || v === undefined ? null : Math.round(v * 0.621371);

  /* HTML templating. `html` escapes every interpolated value unless it is
     already markup produced by `html` (or wrapped with `raw`); arrays are
     joined, and null / undefined / false render as nothing. */
  class Markup { constructor(s) { this.s = s; } toString() { return this.s; } }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const flat = v => v instanceof Markup ? v.s
    : Array.isArray(v) ? v.map(flat).join("")
    : v === null || v === undefined || v === false ? ""
    : esc(v);
  const html = (strings, ...vals) => {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += flat(vals[i]) + strings[i + 1];
    return new Markup(out);
  };
  const raw = s => new Markup(String(s));
  // Feed-supplied links are only rendered when they are http(s).
  const safeUrl = u => { try { const p = new URL(String(u)); return /^https?:$/.test(p.protocol) ? p.href : "#"; } catch (e) { return "#"; } };

  Object.assign(W, {
    CFG, DANFORTH, MEDICAL, TZ, WORKER_DEFAULT, ENDPOINT_STORE,
    normalizeOrigin, proxyOrigin, proxyInvalid,
    round1, tzAbbr, fmtTime, fmtZoned, isoOffsetMin, campusOffsetMin, officeClock, fmtDay, c2f, kmh2mph,
    html, raw, safeUrl
  });
})();

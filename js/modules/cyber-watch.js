/* National cyber picture for an academic medical centre. Registers <cyber-watch>.
   Requires Leaflet, loaded in the DC helmet for the victim map.

   Six feeds. Four are read directly because they send CORS headers:
     · CISA Known Exploited Vulnerabilities catalogue (the official JSON)
     · FIRST EPSS exploitation-probability scores, joined to the KEV rows
     · NVD CVE 2.0 API for newly published critical and high vulnerabilities
     · openFDA device recalls, narrowed to software and firmware causes
   Two arrive through the dashboard Worker because their publishers refuse CORS:
     · CISA advisories, CISA ICS/medical advisories, HHS HC3, security press
     · ransomware.live victim listings, filtered to the three sectors

   The organising idea is exposure, not volume. The KEV catalogue is 1,600+ rows;
   what a watch desk needs is the few dozen that sit on technology a hospital, a
   research environment or a campus actually runs, ranked by how likely each is
   to be exploited. Every count on this page is one you could defend in a briefing:
   where it came from, what window it covers, and what it does not include. */
(function () {
  const KEV_URL = "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json";
  const EPSS_URL = "https://api.first.org/data/v1/epss?cve=";
  const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
  const FDA_DEVICE = "https://api.fda.gov/device/recall.json";

  const INK = "#201e1d", RULE = "rgba(32,30,29,0.4)", MUTED = "#605d5d", HAIR = "#d7d3d3",
        GROUND = "#f3f2f2", SURFACE = "#eae9e9", RED = "#ec3013", DEEPRED = "#ae1800";
  const label = extra => "font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:" + MUTED + ";" + (extra || "");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* Feed descriptions arrive as HTML, sometimes entity-encoded and sometimes cut
     mid-tag. Reduce one to plain text, drop CISA's "View CSAF / Summary"
     boilerplate and Google News link lists that only repeat the headline. */
  const cleanSummary = (s, title) => {
    const decode = x => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
    let t = String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    t = decode(t.replace(/<[^>]*>/g, " ")).replace(/<[^>]*>/g, " ").replace(/<[^>]*$/, "").replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:View CSAF\s*)+/i, "").replace(/^Summary\s*/i, "").trim();
    const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (title && norm(t).startsWith(norm(title).slice(0, 40))) return null;
    if (/^https?:\/\/\S*$/.test(t) || t.length < 12) return null;
    return t;
  };

  const PROXY_STORE = "wuem-proxy-origin";
  const PROXY_DEFAULT = (window.WUEM_CONFIG || {}).workerOrigin || "https://washu-em-ameren.washu-em.workers.dev";
  const proxyOrigin = () => {
    try {
      const raw = (localStorage.getItem(PROXY_STORE) || "").trim();
      if (raw) return new URL(raw).origin;
    } catch (e) { /* fall through to the default */ }
    return PROXY_DEFAULT;
  };

  /* Sector stack profiles. These are the vendors and products that sit in the
     path between each environment and the internet, or hold its records. A KEV
     entry naming one of them is an exposure question for that sector; everything
     else in the catalogue is context. Shared infrastructure counts for all three,
     because a NetScaler outage does not care which building it serves. */
  const SHARED_STACK = /citrix|netscaler|vmware|fortinet|ivanti|pulse secure|palo alto|cisco|sonicwall|barracuda|\bf5\b|big-ip|progress|moveit|goanywhere|accellion|microsoft|windows|exchange|sharepoint|active directory|okta|duo|manageengine|zoho|solarwinds|kaseya|connectwise|screenconnect|atlassian|confluence|veeam|commvault|apache|linux|oracle|vpn|zimbra|synacor|papercut|adobe|fileapi|sap/i;
  const SECTORS = [
    { key: "health", label: "Healthcare delivery", short: "Health",
      note: "Clinical systems, medical devices and the network gear between them and the internet",
      re: /epic systems|cerner|oracle health|meditech|allscripts|veradigm|nextgen health|athenahealth|change healthcare|philips|\bge health|siemens health|medtronic|becton|baxter|dr(ä|a)ger|hillrom|omnicell|zoll|masimo|natus|elekta|varian|fujifilm|agfa|sectra|carestream|nuance|intersystems|mirth|rhapsody|openemr|dicom|\bpacs\b|infusion|patient monitor|imaging/i },
    { key: "research", label: "Medical research", short: "Research",
      note: "Research computing, instrument control and the data platforms that hold study records",
      re: /redcap|labvantage|labarchives|benchling|thermo fisher|illumina|agilent|bruker|perkinelmer|waters corp|qiagen|globus|jupyter|anaconda|ray-project|\bray\b|slurm|open ondemand|kubernetes|docker|nvidia|lustre|ceph|hadoop|spark|matlab|\br studio|rstudio|sas institute|labview|osirix|gitlab|jenkins/i },
    { key: "education", label: "Higher education", short: "Education",
      note: "Student records, learning platforms, identity and the campus edge",
      re: /ellucian|banner|workday|peoplesoft|instructure|canvas|blackboard|moodle|brightspace|desire2learn|d2l|shibboleth|\bcas\b|touchnet|nelnet|blackbaud|slate|jenzabar|anthology|turnitin|respondus|zoom|webex|google workspace|papercut|jamf|kace|sccm|configuration manager/i }
  ];

  const sectorsFor = text => {
    const hits = SECTORS.filter(s => s.re.test(text)).map(s => s.key);
    if (SHARED_STACK.test(text)) SECTORS.forEach(s => { if (!hits.includes(s.key)) hits.push(s.key); });
    return hits;
  };
  const isShared = text => SHARED_STACK.test(text) && !SECTORS.some(s => s.re.test(text));

  /* EPSS is the number that turns a catalogue into a queue: the model's estimated
     probability that a vulnerability will be exploited in the next 30 days. Bands
     follow FIRST's own guidance rather than round numbers. */
  const EPSS_BANDS = [
    { min: 0.5, label: "Very high", color: RED, note: "≥50% chance of exploitation in 30 days" },
    { min: 0.1, label: "High", color: "#e0700b", note: "10–50%" },
    { min: 0.01, label: "Moderate", color: "#8f6b12", note: "1–10%" },
    { min: 0, label: "Low", color: MUTED, note: "<1%" }
  ];
  const epssBand = v => v == null ? null : EPSS_BANDS.find(b => v >= b.min) || EPSS_BANDS[EPSS_BANDS.length - 1];

  const SEV_COLOR = { CRITICAL: RED, HIGH: "#e0700b", MEDIUM: "#8f6b12", LOW: MUTED };

  const NEWS_WINDOWS = [24, 48, 168];
  const KEV_WINDOWS = [30, 90, 365];
  const RW_WINDOWS = [1, 7, 30];
  const RW_WIN_LABEL = { 1: "–24 H", 7: "–7 D", 30: "–30 D" };

  /* The victim map follows ransomware.live's own map: a dark full-bleed world with
     claim markers, and a tabbed panel of live feed, groups, countries and charts
     beneath it. Dark is deliberate here and only here — it is the one surface on
     the dashboard that reads as a monitor wall rather than a document. */
  const DARK = GROUND, DARK_PANEL = SURFACE, DARK_LINE = RULE,
        DARK_TEXT = INK, DARK_MUTED = MUTED;
  /* See the note in weather-monitor.js: a key containing braces would make
     Leaflet's URL templater throw, so it is validated and passed as an option. */
  const CARTO_KEY_RAW = String((window.WUEM_CONFIG || {}).cartoKey || "");
  const CARTO_KEY = /^[A-Za-z0-9_-]+$/.test(CARTO_KEY_RAW) ? CARTO_KEY_RAW : null;
  const DARK_TILES = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
    + (CARTO_KEY ? "?key={key}" : "");
  // Continental US first — the desk's own country — with the world one click away.
  const RW_EXTENTS = {
    us: { label: "United States", center: [38.5, -96], zoom: 4.25 },
    world: { label: "Whole world", center: [20, 5], zoom: 1.75 }
  };
  const RW_ACTIVITY_UI = {
    health: /health|medical|hospital|pharma|dental|biotech|life scien|nursing|clinic/i,
    research: /research|laborator|scien|biotech|pharmaceutic/i,
    education: /education|academi|school|universit|college/i
  };
  const RW_TABS = [["feed", "Live Feed"], ["groups", "Top Groups"], ["countries", "Top Countries"], ["dash", "Dashboard"]];

  /* ISO-2 → [ISO-3, display name, lat, lon]. ransomware.live reports country as a
     two-letter code; the polygon set is keyed on ISO-3, and the centroid is where
     a victim marker lands. Coordinates are visual centroids — the point that reads
     as “in” the country — not area centroids, which fall in water for Norway,
     Chile and the like. */
  const RW_GEO = {
    AE: ["ARE", "United Arab Emirates", 24.0, 54.0], AR: ["ARG", "Argentina", -35.0, -64.5],
    AT: ["AUT", "Austria", 47.6, 14.2], AU: ["AUS", "Australia", -25.5, 134.0],
    AL: ["ALB", "Albania", 41.1, 20.1], BA: ["BIH", "Bosnia & Herzegovina", 44.0, 17.8],
    BD: ["BGD", "Bangladesh", 23.8, 90.3], BE: ["BEL", "Belgium", 50.7, 4.6],
    BG: ["BGR", "Bulgaria", 42.7, 25.3], BH: ["BHR", "Bahrain", 26.1, 50.6],
    BR: ["BRA", "Brazil", -12.0, -50.0], BW: ["BWA", "Botswana", -22.2, 24.0],
    CA: ["CAN", "Canada", 56.0, -98.0], CH: ["CHE", "Switzerland", 46.8, 8.2],
    CL: ["CHL", "Chile", -33.0, -70.8], CN: ["CHN", "China", 35.0, 104.0],
    CO: ["COL", "Colombia", 4.2, -73.5], CR: ["CRI", "Costa Rica", 9.9, -84.0],
    CY: ["CYP", "Cyprus", 35.0, 33.2], CZ: ["CZE", "Czechia", 49.8, 15.4],
    DE: ["DEU", "Germany", 51.1, 10.4], DK: ["DNK", "Denmark", 56.0, 9.6],
    DO: ["DOM", "Dominican Republic", 18.8, -70.4], DZ: ["DZA", "Algeria", 28.0, 2.6],
    EC: ["ECU", "Ecuador", -1.4, -78.4], EE: ["EST", "Estonia", 58.7, 25.3],
    EG: ["EGY", "Egypt", 26.6, 30.2], ES: ["ESP", "Spain", 40.2, -3.6],
    FI: ["FIN", "Finland", 63.5, 26.0], FR: ["FRA", "France", 46.7, 2.4],
    GB: ["GBR", "United Kingdom", 53.2, -1.8], GE: ["GEO", "Georgia", 42.0, 43.5],
    GH: ["GHA", "Ghana", 7.9, -1.1], GR: ["GRC", "Greece", 39.2, 22.2],
    GT: ["GTM", "Guatemala", 15.2, -90.3], HK: ["HKG", "Hong Kong", 22.3, 114.2],
    HN: ["HND", "Honduras", 14.7, -86.6], HR: ["HRV", "Croatia", 45.2, 16.2],
    HU: ["HUN", "Hungary", 47.1, 19.4], ID: ["IDN", "Indonesia", -2.2, 118.0],
    IE: ["IRL", "Ireland", 53.2, -8.0], IL: ["ISR", "Israel", 31.4, 34.9],
    IN: ["IND", "India", 22.5, 79.0], IQ: ["IRQ", "Iraq", 33.1, 43.7],
    IR: ["IRN", "Iran", 32.4, 53.7], IS: ["ISL", "Iceland", 64.9, -18.6],
    IT: ["ITA", "Italy", 42.7, 12.6], JM: ["JAM", "Jamaica", 18.1, -77.3],
    JO: ["JOR", "Jordan", 31.3, 36.4], JP: ["JPN", "Japan", 36.4, 138.2],
    KE: ["KEN", "Kenya", 0.4, 37.9], KR: ["KOR", "South Korea", 36.5, 127.9],
    KW: ["KWT", "Kuwait", 29.3, 47.6], KZ: ["KAZ", "Kazakhstan", 48.2, 67.3],
    LB: ["LBN", "Lebanon", 33.9, 35.8], LK: ["LKA", "Sri Lanka", 7.6, 80.7],
    LT: ["LTU", "Lithuania", 55.2, 23.9], LU: ["LUX", "Luxembourg", 49.8, 6.1],
    LV: ["LVA", "Latvia", 56.9, 24.9], MA: ["MAR", "Morocco", 31.9, -6.5],
    MD: ["MDA", "Moldova", 47.2, 28.5], ME: ["MNE", "Montenegro", 42.8, 19.3],
    MK: ["MKD", "North Macedonia", 41.6, 21.7], MT: ["MLT", "Malta", 35.9, 14.4],
    MX: ["MEX", "Mexico", 23.6, -102.5], MY: ["MYS", "Malaysia", 4.1, 102.0],
    NG: ["NGA", "Nigeria", 9.1, 8.7], NL: ["NLD", "Netherlands", 52.2, 5.5],
    NO: ["NOR", "Norway", 61.0, 9.5], NP: ["NPL", "Nepal", 28.3, 84.1],
    NZ: ["NZL", "New Zealand", -41.5, 172.8], OM: ["OMN", "Oman", 21.0, 57.0],
    PA: ["PAN", "Panama", 8.5, -80.1], PE: ["PER", "Peru", -9.2, -75.0],
    PH: ["PHL", "Philippines", 12.5, 122.0], PK: ["PAK", "Pakistan", 30.0, 69.4],
    PL: ["POL", "Poland", 52.1, 19.4], PR: ["PRI", "Puerto Rico", 18.2, -66.5],
    PT: ["PRT", "Portugal", 39.6, -8.0], PY: ["PRY", "Paraguay", -23.4, -58.4],
    QA: ["QAT", "Qatar", 25.3, 51.2], RO: ["ROU", "Romania", 45.9, 25.0],
    RS: ["SRB", "Serbia", 44.1, 20.9], RU: ["RUS", "Russia", 57.0, 60.0],
    SA: ["SAU", "Saudi Arabia", 24.1, 44.9], SE: ["SWE", "Sweden", 62.2, 15.7],
    SG: ["SGP", "Singapore", 1.35, 103.85], SI: ["SVN", "Slovenia", 46.1, 14.8],
    SK: ["SVK", "Slovakia", 48.7, 19.5], SV: ["SLV", "El Salvador", 13.7, -88.9],
    TH: ["THA", "Thailand", 15.2, 101.0], TN: ["TUN", "Tunisia", 34.4, 9.5],
    TR: ["TUR", "T\u00fcrkiye", 39.1, 35.2], TT: ["TTO", "Trinidad & Tobago", 10.5, -61.3],
    TW: ["TWN", "Taiwan", 23.8, 121.0], TZ: ["TZA", "Tanzania", -6.4, 34.9],
    UA: ["UKR", "Ukraine", 49.0, 31.4], UG: ["UGA", "Uganda", 1.3, 32.4],
    US: ["USA", "United States", 39.5, -98.5], UY: ["URY", "Uruguay", -32.8, -56.0],
    VE: ["VEN", "Venezuela", 7.1, -66.2], VN: ["VNM", "Vietnam", 16.2, 106.4],
    ZA: ["ZAF", "South Africa", -29.0, 24.7], ZM: ["ZMB", "Zambia", -13.5, 27.9],
    ZW: ["ZWE", "Zimbabwe", -19.0, 29.9]
  };
  const RW_SECTOR_META = {
    health: { label: "Healthcare", color: RED },
    research: { label: "Research", color: "#e0700b" },
    education: { label: "Education", color: "#8f6b12" }
  };

  const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
  const fmtDate = v => {
    const d = new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  };
  const fmtFdaDate = v => {
    const s = String(v || "");
    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return fmtDate(m[1] + "-" + m[2] + "-" + m[3]);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? fmtDate(s) : (s || "—");
  };
  const relHours = h => h == null ? "—"
    : h < 1 ? Math.max(1, Math.round(h * 60)) + " min ago"
    : h < 48 ? Math.round(h) + " h ago"
    : Math.round(h / 24) + " d ago";
  const daysUntil = d => {
    const t = Date.parse(d);
    return isNaN(t) ? null : Math.round((t - Date.now()) / 86400000);
  };
  const titleCase = s => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());

  /* ---------- chart builders -------------------------------------------- */

  // A ranked horizontal bar list: the shape that reads fastest for "which of these
  // is worst", with the value printed rather than left to the eye.
  const barList = (rows, opts) => {
    const o = opts || {};
    if (!rows.length) return '<div style="' + label() + '">Nothing to show.</div>';
    const max = Math.max(...rows.map(r => r.v)) || 1;
    return rows.map(r => {
      const text = r.l != null ? r.l : r.label;
      const color = r.c || r.color || INK;
      return '<div style="display:grid;grid-template-columns:' + (o.labelWidth || "150px") + ' minmax(0,1fr) ' + (o.valWidth || "58px") + ';gap:10px;align-items:center;padding:6px 0;'
      + (o.rule === false ? "" : "border-bottom:1px solid " + HAIR + ";") + '">'
      + '<span style="min-width:0;"><span style="font-size:11px;font-weight:' + (r.strong ? 800 : 600) + ';display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(text) + '">' + esc(text) + "</span>"
      + (r.note ? '<span style="font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + MUTED + ';display:block;margin-top:2px;">' + esc(r.note) + "</span>" : "") + "</span>"
      + '<span style="display:block;height:9px;background:' + SURFACE + ';"><span style="display:block;height:9px;background:' + color + ';width:' + Math.max(2, (r.v / max) * 100).toFixed(1) + '%;"></span></span>'
      + '<span style="font-size:12px;font-weight:800;text-align:right;font-variant-numeric:tabular-nums;">' + (o.fmt ? o.fmt(r.v) : r.v) + "</span></div>";
    }).join("");
  };

  // Weekly additions to the KEV catalogue, as a column chart against a date axis.
  const columnChart = (bins, opts) => {
    const o = opts || {};
    const w = o.w || 520, h = o.h || 120, pad = 26, base = h - 20;
    const max = Math.max(1, ...bins.map(b => b.v));
    const bw = (w - pad - 8) / bins.length;
    return '<svg width="100%" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="display:block;">'
      + '<line x1="' + pad + '" x2="' + (w - 8) + '" y1="' + (base - (base - 8) * 0.5).toFixed(1) + '" y2="' + (base - (base - 8) * 0.5).toFixed(1) + '" stroke="' + INK + '" stroke-opacity="0.12"></line>'
      + bins.map((b, i) => {
        const bh = (b.v / max) * (base - 8);
        return '<rect x="' + (pad + i * bw + 1).toFixed(1) + '" y="' + (base - bh).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1)
          + '" height="' + Math.max(b.v ? 1.5 : 0, bh).toFixed(1) + '" fill="' + (b.c || INK) + '" opacity="' + (b.v ? 1 : 0) + '"></rect>';
      }).join("")
      + '<line x1="' + pad + '" x2="' + (w - 8) + '" y1="' + base + '" y2="' + base + '" stroke="' + INK + '" stroke-width="1.5"></line>'
      + (o.cutIndex != null && o.cutIndex < bins.length - 1
          ? '<line x1="' + (pad + (o.cutIndex + 1) * bw).toFixed(1) + '" x2="' + (pad + (o.cutIndex + 1) * bw).toFixed(1)
            + '" y1="4" y2="' + (base + 4) + '" stroke="' + INK + '" stroke-width="2"></line>'
          : "")
      + '<text x="2" y="12" font-family="Archivo,system-ui,sans-serif" font-size="9" font-weight="800" fill="' + MUTED + '">' + max + "</text>"
      + [0, bins.length - 1].map(i => '<text x="' + (pad + i * bw + bw / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="' + (i ? "end" : "start")
          + '" font-family="Archivo,system-ui,sans-serif" font-size="9" font-weight="700" fill="' + MUTED + '">' + esc(bins[i].t) + "</text>").join("")
      + "</svg>";
  };

  const TEMPLATE = `
    <div style="display:flex;align-items:center;gap:14px;padding:10px 32px;background:${INK};color:${GROUND};border-bottom:2px solid ${INK};">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;padding:4px 8px;background:${GROUND};color:${INK};">Live Cyber Feeds</span>
      <span style="font-size:12px;font-weight:600;">Public reporting only. Nothing here watches WashU's own network. These are public advisories, vulnerability lists and ransomware group claims about the technology this sector runs.</span>
    </div>

    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:22px 32px 18px;border-bottom:2px solid ${RULE};">
      <div>
        <div style="${label("margin-bottom:6px;")}">Healthcare &middot; Medical Research &middot; Higher Education</div>
        <div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:30px;line-height:1.05;letter-spacing:-0.025em;">Cyber Watch</div>
        <div data-status style="font-size:12px;color:${MUTED};margin-top:7px;max-width:920px;line-height:1.5;">Loading CISA's exploited-vulnerability list, EPSS, NVD, openFDA and the advisory feeds&hellip;</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
        <div data-updated style="${label()}"></div>
        <button data-refresh class="btn btn-secondary" style="font-size:10px;letter-spacing:0.1em;">Refresh feeds</button>
      </div>
    </div>

    <div data-kpis style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-bottom:2px solid ${RULE};"></div>

    <div style="padding:18px 32px;border-bottom:2px solid ${RULE};background:${SURFACE};">
      <div style="${label("margin-bottom:6px;")}">Situation note &middot; from the live feeds</div>
      <div data-note style="font-size:14px;font-weight:600;line-height:1.55;max-width:1180px;text-wrap:pretty;">Reading the feeds&hellip;</div>
    </div>

    <div style="border-bottom:2px solid ${RULE};">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:20px 32px 14px;">
        <div>
          <div style="${label("margin-bottom:4px;")}">Sector exposure &middot; CISA known exploited vulnerabilities</div>
          <div style="font-size:11px;color:${MUTED};max-width:760px;line-height:1.5;">KEV is CISA's list of vulnerabilities being exploited. Shown here: KEV entries naming technology each sector runs, ranked by EPSS. EPSS is the chance of exploitation in the next 30 days. Shared infrastructure counts for all three sectors.</div>
        </div>
        <div data-kev-window-seg style="display:flex;border:2px solid ${RULE};">
          ${KEV_WINDOWS.map((d, i) => '<button data-kev-window="' + d + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;' + (i ? "border-left:2px solid " + RULE + ";" : "") + "background:" + (d === 90 ? INK : "transparent") + ";color:" + (d === 90 ? GROUND : INK) + ';cursor:pointer;">' + (d < 365 ? d + " D" : "1 YR") + "</button>").join("")}
        </div>
      </div>
      <div data-sectors style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:2px solid ${RULE};"></div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(0,1fr) 380px;align-items:start;border-bottom:2px solid ${RULE};">
      <div style="border-right:2px solid ${RULE};">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:20px 20px 14px 32px;">
          <div>
            <div style="${label("margin-bottom:4px;")}">Exploited vulnerability queue</div>
            <div data-kev-note style="font-size:11px;color:${MUTED};line-height:1.5;">Reading the KEV list&hellip;</div>
          </div>
          <div data-kev-sort-seg style="display:flex;border:2px solid ${RULE};">
            <button data-kev-sort="epss" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;background:${INK};color:${GROUND};cursor:pointer;">By EPSS</button>
            <button data-kev-sort="date" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;border-left:2px solid ${RULE};background:transparent;color:${INK};cursor:pointer;">Newest</button>
            <button data-kev-sort="due" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;border-left:2px solid ${RULE};background:transparent;color:${INK};cursor:pointer;">Due soonest</button>
          </div>
        </div>
        <div data-kev-filters style="display:flex;flex-wrap:wrap;gap:0;border-top:2px solid ${RULE};border-bottom:2px solid ${RULE};"></div>
        <div data-kev-list style="max-height:640px;overflow-y:auto;"></div>
      </div>

      <aside>
        <div style="padding:20px 32px 20px 20px;border-bottom:2px solid ${RULE};">
          <div style="${label("margin-bottom:4px;")}">New KEV entries by week</div>
          <div style="font-size:11px;color:${MUTED};margin-bottom:12px;line-height:1.5;">Entries CISA added each week over the last year. CISA adds an entry only when it sees exploitation. A tall column means a busy week for attackers.</div>
          <div data-kev-chart></div>
        </div>
        <div style="padding:20px 32px 20px 20px;border-bottom:2px solid ${RULE};">
          <div style="${label("margin-bottom:12px;")}">Vendors in the sector queue</div>
          <div data-kev-vendors></div>
        </div>
      </aside>
    </div>

    <div style="border-bottom:2px solid ${RULE};">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:20px 32px 16px;border-bottom:2px solid ${RULE};">
        <div>
          <div style="${label("margin-bottom:4px;")}">Ransomware victim map &middot; leak-site claims</div>
          <div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:22px;line-height:1.1;letter-spacing:-0.02em;">Organisations named on ransomware leak sites</div>
          <div style="font-size:12px;color:${MUTED};margin-top:6px;max-width:820px;line-height:1.55;">The map opens on the United States. The data is worldwide. Healthcare, medical research and higher education are in red.</div>
        </div>
        <div style="display:flex;align-items:center;gap:14px;">
          <div data-rw-window-seg style="display:flex;border:2px solid ${RULE};">
            ${RW_WINDOWS.map((d, i) => '<button data-rw-window="' + d + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;' + (i ? "border-left:2px solid " + RULE + ";" : "") + "background:" + (d === 7 ? INK : "transparent") + ";color:" + (d === 7 ? GROUND : INK) + ';cursor:pointer;">' + RW_WIN_LABEL[d] + "</button>").join("")}
          </div>
          <div data-rw-status style="display:flex;align-items:center;gap:7px;${label()}">
            <span data-rw-dot style="width:8px;height:8px;background:${MUTED};"></span><span data-rw-status-text>connecting&hellip;</span>
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:12px;padding:9px 32px;border-bottom:2px solid ${RULE};background:${SURFACE};overflow:hidden;">
        <span style="${label()}white-space:nowrap;">Top groups</span>
        <div data-rw-ticker style="display:flex;gap:16px;font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;">&mdash;</div>
      </div>

      <div data-rw-map-shell style="position:relative;">
        <div data-rw-map style="height:560px;background:${SURFACE};"></div>
        <div style="position:absolute;top:14px;right:14px;z-index:1001;display:flex;gap:8px;">
          <div data-rw-extent-seg style="display:flex;border:2px solid ${INK};background:${GROUND};">
            ${Object.keys(RW_EXTENTS).map((k, i) => '<button data-rw-extent="' + k + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:6px 10px;border:none;' + (i ? "border-left:2px solid " + INK + ";" : "") + "background:" + (i ? "transparent" : INK) + ";color:" + (i ? INK : GROUND) + ';cursor:pointer;">' + RW_EXTENTS[k].label + "</button>").join("")}
          </div>
          <button data-rw-fullscreen style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:6px 10px;border:2px solid ${INK};background:${GROUND};color:${INK};cursor:pointer;">&#10529; Full screen</button>
        </div>
        <div data-rw-counters style="position:absolute;top:14px;left:14px;z-index:1001;display:none;border:2px solid ${INK};background:${GROUND};"></div>
        <div data-rw-legend-box style="position:absolute;bottom:14px;left:14px;z-index:1001;background:${GROUND};border:2px solid ${INK};padding:9px 11px;display:none;flex-direction:column;gap:6px;">
          <div style="${label()}">Each dot is one claimed victim</div>
          <div style="display:flex;gap:12px;font-size:10px;font-weight:700;">
            <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;border-radius:50%;background:${RED};"></span>Healthcare, research, education</span>
            <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;border-radius:50%;background:${MUTED};"></span>All other sectors</span>
          </div>
        </div>
      </div>

      <div style="display:flex;border-top:2px solid ${RULE};border-bottom:2px solid ${RULE};background:${SURFACE};">
        ${RW_TABS.map(([k, t], i) => '<button data-rw-tab="' + k + '" style="font-family:Archivo,system-ui,sans-serif;font-size:11px;font-weight:800;letter-spacing:0.06em;padding:11px 18px;border:none;' + (i ? "border-left:2px solid " + RULE + ";" : "") + "background:" + (i ? "transparent" : GROUND) + ";color:" + (i ? MUTED : INK) + ';cursor:pointer;">' + t + "</button>").join("")}
      </div>

      <div data-rw-panel style="min-height:280px;max-height:400px;overflow-y:auto;"></div>

      <div style="padding:14px 32px 18px;border-top:2px solid ${RULE};font-size:11px;color:${MUTED};line-height:1.6;">
        A listing is the ransomware group&rsquo;s own <b style="color:${INK};">claim</b>, posted on its leak site after the intrusion. It is not a confirmed breach. Dots are placed within the victim&rsquo;s country, not at an address. The feed gives no city. Rows for healthcare, medical research and higher education are marked, since those are this desk&rsquo;s sectors. Data from <a href="https://www.ransomware.live/" target="_blank" rel="noopener" style="color:${RED};">ransomware.live</a>. Map after its own victims map by Julien Mousqueton.
      </div>
    </div>

    <div style="border-bottom:2px solid ${RULE};">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:20px 32px 16px;">
        <div>
          <div style="${label("margin-bottom:4px;")}">Advisories &amp; sector reporting</div>
          <div data-news-note style="font-size:11px;color:${MUTED};max-width:820px;line-height:1.5;">Reading CISA advisories, HHS HC3 and the security trade press&hellip;</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
          <div data-news-window-seg style="display:flex;border:2px solid ${RULE};">
            ${NEWS_WINDOWS.map((h, i) => '<button data-news-window="' + h + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;' + (i ? "border-left:2px solid " + RULE + ";" : "") + "background:" + (h === 48 ? INK : "transparent") + ";color:" + (h === 48 ? GROUND : INK) + ';cursor:pointer;">' + (h < 100 ? h + " H" : h / 24 + " D") + "</button>").join("")}
          </div>
          <div data-news-counts style="${label()}"></div>
        </div>
      </div>
      <div data-news-filters style="display:flex;flex-wrap:wrap;gap:0;border-top:2px solid ${RULE};border-bottom:2px solid ${RULE};"></div>
      <div data-news style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));"></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-bottom:2px solid ${RULE};">
      <div style="border-right:2px solid ${RULE};padding:20px 24px 24px 32px;">
        <div style="${label("margin-bottom:4px;")}">Newly published critical vulnerabilities &middot; NVD</div>
        <div data-nvd-note style="font-size:11px;color:${MUTED};margin-bottom:12px;line-height:1.5;">Reading the National Vulnerability Database&hellip;</div>
        <div data-nvd style="display:flex;flex-direction:column;max-height:460px;overflow-y:auto;padding-right:6px;"></div>
      </div>
      <div style="padding:20px 32px 24px 24px;">
        <div style="${label("margin-bottom:4px;")}">Medical device software &amp; firmware recalls &middot; openFDA</div>
        <div data-device-note style="font-size:11px;color:${MUTED};margin-bottom:12px;line-height:1.5;">Reading the device recall feed&hellip;</div>
        <div data-devices style="display:flex;flex-direction:column;max-height:460px;overflow-y:auto;padding-right:6px;"></div>
      </div>
    </div>

    <div data-cw-modal style="display:none;position:fixed;inset:0;z-index:5200;background:rgba(32,30,29,0.6);align-items:center;justify-content:center;padding:24px;">
      <div style="background:${GROUND};border:2px solid ${INK};width:min(660px,100%);max-height:88vh;overflow-y:auto;">
        <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:2px solid ${INK};background:${SURFACE};">
          <div>
            <div data-cw-modal-kicker style="${label()}"></div>
            <div data-cw-modal-title style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:19px;line-height:1.18;letter-spacing:-0.01em;margin-top:4px;"></div>
          </div>
          <button data-cw-modal-close style="background:none;border:none;padding:0;font-size:18px;line-height:1;color:${MUTED};cursor:pointer;">&#10005;</button>
        </div>
        <div data-cw-modal-body style="padding:18px 20px 22px;font-size:12px;line-height:1.55;"></div>
      </div>
    </div>

    <div style="padding:18px 32px 28px;">
      <div style="${label("margin-bottom:8px;")}">What this page shows</div>
      <div style="font-size:12px;color:${MUTED};line-height:1.65;max-width:1180px;">This page shows outside reporting only. It cannot see WashU networks, devices or accounts. A quiet page is not evidence that nothing is happening here. An alarming page is not evidence that anything is. Use it to decide what to go and check. IT Security handles internal detection and incident reporting.
      <br><br>Sources: CISA Known Exploited Vulnerabilities catalogue, read from CISA's own published file &middot; FIRST EPSS v4, the chance of exploitation in 30 days &middot; NVD, the National Vulnerability Database &middot; openFDA device recalls, limited to software and firmware causes &middot; CISA advisories and ICS/medical advisories, HHS HC3, and the security trade press, through the dashboard Worker &middot; ransomware.live public leak-site listings. Sector matches, threat tags and stack profiles are this dashboard's own keyword rules. They are shown on each item so you can judge them.</div>
    </div>
  `;

  class CyberWatch extends HTMLElement {
    connectedCallback() {
      if (this._booted) return this.resume();
      this._booted = true;
      this.kevWindow = 90;
      this.kevSort = "epss";
      this.kevSector = null;
      this.newsHours = 48;
      this.newsFilter = null;
      this.rwDays = 7;
      this.rwTab = "feed";
      this.failures = [];
      this.innerHTML = TEMPLATE;
      this.boot();
    }

    q(sel) { return this.querySelector(sel); }

    boot() {
      this.q("[data-refresh]").onclick = () => this.load();
      this.q("[data-kev-window-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-kev-window]");
        if (b) this.setKevWindow(Number(b.getAttribute("data-kev-window")));
      });
      this.q("[data-kev-sort-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-kev-sort]");
        if (!b) return;
        this.kevSort = b.getAttribute("data-kev-sort");
        this.querySelectorAll("[data-kev-sort]").forEach(x => {
          const on = x.getAttribute("data-kev-sort") === this.kevSort;
          x.style.background = on ? INK : "transparent";
          x.style.color = on ? GROUND : INK;
        });
        this.renderKevList();
      });
      this.q("[data-kev-filters]").addEventListener("click", e => {
        const b = e.target.closest("[data-kev-sector]");
        if (!b) return;
        this.kevSector = b.getAttribute("data-kev-sector") || null;
        this.renderKevFilters();
        this.renderKevList();
      });
      this.q("[data-kev-list]").addEventListener("click", e => {
        const r = e.target.closest("[data-kev-idx]");
        if (r) this.showKev(Number(r.getAttribute("data-kev-idx")));
      });
      this.q("[data-sectors]").addEventListener("click", e => {
        const t = e.target.closest("[data-sector-jump]");
        if (!t) return;
        this.kevSector = t.getAttribute("data-sector-jump");
        this.renderKevFilters();
        this.renderKevList();
      });
      this.q("[data-news-window-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-news-window]");
        if (b) this.setNewsWindow(Number(b.getAttribute("data-news-window")));
      });
      this.q("[data-news-filters]").addEventListener("click", e => {
        const b = e.target.closest("[data-news-filter]");
        if (!b) return;
        this.newsFilter = b.getAttribute("data-news-filter") || null;
        this.renderNewsFilters();
        this.renderNews();
      });
      this.q("[data-news]").addEventListener("click", e => {
        const r = e.target.closest("[data-news-idx]");
        if (r) this.showNews(Number(r.getAttribute("data-news-idx")));
      });
      this.q("[data-nvd]").addEventListener("click", e => {
        const r = e.target.closest("[data-nvd-idx]");
        if (r) this.showNvd(Number(r.getAttribute("data-nvd-idx")));
      });
      this.q("[data-devices]").addEventListener("click", e => {
        const r = e.target.closest("[data-device-idx]");
        if (r) this.showDevice(Number(r.getAttribute("data-device-idx")));
      });
      this.q("[data-rw-panel]").addEventListener("click", e => {
        const r = e.target.closest("[data-rw-idx]");
        if (r) this.showRansom(Number(r.getAttribute("data-rw-idx")));
        const c = e.target.closest("[data-rw-country]");
        if (c) this.focusRwCountry(c.getAttribute("data-rw-country"));
      });
      this.q("[data-rw-window-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-rw-window]");
        if (b) this.setRwWindow(Number(b.getAttribute("data-rw-window")));
      });
      this.q("[data-rw-fullscreen]").onclick = () => this.toggleRwFullscreen();
      this.q("[data-rw-extent-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-rw-extent]");
        if (b) this.setRwExtent(b.getAttribute("data-rw-extent"));
      });
      this.querySelectorAll("[data-rw-tab]").forEach(b => {
        b.onclick = () => this.setRwTab(b.getAttribute("data-rw-tab"));
      });
      const modal = this.q("[data-cw-modal]");
      this.q("[data-cw-modal-close]").onclick = () => this.closeModal();
      modal.addEventListener("click", e => { if (e.target === modal) this.closeModal(); });
      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && this.q("[data-cw-modal]").style.display === "flex") this.closeModal();
      });

      // Staggered so six views do not fire every feed at once on mount.

      this._bootT = setTimeout(() => this.load(), 4000);

      this.startTimers();
    }

    /* The map is NOT removed here: a detach is usually a reconciliation and the
       element's DOM survives it, so destroying the map left nothing to re-arm. */
    disconnectedCallback() {
      /* The size watcher is deliberately NOT cleared on detach. It is the only
         trigger that does not depend on a lifecycle callback firing: while
         detached it reads a null container and does nothing, and it clears itself
         the moment the map measures. Clearing it here is what left three maps at a
         zero-area viewport. */
      clearTimeout(this._bootT);
      clearInterval(this.timer);
    }

    resume() {
      if (this.rwMap) this.armRwFit();
      this.startTimers();
    }

    startTimers() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.load(), 1800000);
      // Housekeeping: keeps re-arming the size watchdog until the map measures,
      // so recovery never waits on the feed refresh cadence.
      clearInterval(this._hkTimer);
      this._hkTimer = setInterval(() => {
        if (this._rwFitted) { clearInterval(this._hkTimer); this._hkTimer = null; return; }
        this.armRwFit();
      }, 2000);
    }

    status(msg) { this.q("[data-status]").innerHTML = msg; }

    /* ---------- loading -------------------------------------------------- */

    async load() {
      if (this.rwMap) this.armRwFit();
      this.status("Loading CISA's exploited-vulnerability list, EPSS, NVD, openFDA and the advisory feeds…");
      const results = await Promise.allSettled([
        this.loadKev(), this.loadNvd(), this.loadDevices(), this.loadNews(), this.loadRansomware()
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") console.warn("[" + this.tagName.toLowerCase() + "] feed " + i + " failed:", r.reason);
      });
      const names = ["CISA KEV catalogue", "NVD", "openFDA device recalls", "advisory feeds", "ransomware listings"];
      this.failures = results.map((r, i) => r.status === "rejected" ? names[i] : null).filter(Boolean);
      // Re-render the proxied panels now the failure list is known, so they name the
      // host they could not reach instead of sitting on their loading line.
      if (this.failures.includes("advisory feeds")) this.renderNews();
      if (this.failures.includes("ransomware listings")) this.renderRansom();
      this.q("[data-updated]").textContent = "Retrieved " + new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }) + " CT";
      this.status(this.failures.length
        ? "Six public feeds. " + (6 - this.failures.length) + " answering. Not answering: " + this.failures.join(", ") + "."
          + (/\.workers\.dev$/.test(proxyOrigin()) && (this.failures.includes("advisory feeds") || this.failures.includes("ransomware listings"))
              ? " Managed WashU devices block *.workers.dev. Set an allowed Worker address on the Outages tab." : "")
          + " Panels for those feeds say so. They do not show stale numbers."
        : "All six public feeds answering: CISA's exploited-vulnerability list, FIRST EPSS, NVD, openFDA device recalls, CISA and HC3 advisories, and ransomware leak-site listings.");
      this.renderKpis();
      this.renderNote();
      this.publish();
    }

    /* CISA publishes the catalogue as one JSON document. EPSS is then joined on
       CVE id in batches, because a per-CVE request for 1,600 entries would be
       both slow and rude; only the sector-relevant rows need a score. */
    async loadKev() {
      const j = await (await fetch(KEV_URL)).json();
      const all = (j.vulnerabilities || []).map(v => {
        const text = [v.vendorProject, v.product, v.vulnerabilityName, v.shortDescription].filter(Boolean).join(" ");
        return {
          cve: v.cveID,
          vendor: v.vendorProject,
          product: v.product,
          name: v.vulnerabilityName,
          description: v.shortDescription,
          action: v.requiredAction,
          added: v.dateAdded,
          due: v.dueDate,
          ransomware: /^known$/i.test(String(v.knownRansomwareCampaignUse || "")),
          cwes: v.cwes || [],
          notes: v.notes,
          sectors: sectorsFor(text),
          shared: isShared(text),
          ageDays: Math.round((Date.now() - Date.parse(v.dateAdded)) / 86400000)
        };
      });
      this.kevAll = all;
      this.kevVersion = j.catalogVersion;
      this.kevReleased = j.dateReleased;
      this.kevCount = j.count || all.length;

      // Score the rows the desk will actually look at: everything in the widest
      // window that touches a sector stack, plus everything added in 30 days.
      const wanted = all.filter(v => (v.sectors.length && v.ageDays <= 365) || v.ageDays <= 30);
      await this.attachEpss(wanted);
      this.renderKevChart();
      this.renderSectors();
      this.renderKevFilters();
      this.renderKevList();
      this.renderKevVendors();
    }

    async attachEpss(rows) {
      const ids = rows.map(r => r.cve);
      this.epss = this.epss || {};
      for (let i = 0; i < ids.length; i += 90) {
        const batch = ids.slice(i, i + 90).filter(c => this.epss[c] === undefined);
        if (!batch.length) continue;
        try {
          const j = await (await fetch(EPSS_URL + batch.join(","))).json();
          (j.data || []).forEach(d => { this.epss[d.cve] = { score: num(d.epss), pct: num(d.percentile) }; });
          batch.forEach(c => { if (this.epss[c] === undefined) this.epss[c] = null; });
        } catch (e) {
          batch.forEach(c => { this.epss[c] = null; });
        }
      }
      rows.forEach(r => {
        const e = this.epss[r.cve];
        r.epss = e ? e.score : null;
        r.epssPct = e ? e.pct : null;
      });
    }

    kevWindowRows() {
      return (this.kevAll || []).filter(v => v.ageDays <= this.kevWindow);
    }

    // The queue is the sector-relevant slice of the window, because the whole
    // catalogue is a reference document rather than a worklist.
    kevQueue() {
      const rows = this.kevWindowRows().filter(v => v.sectors.length);
      const filtered = this.kevSector ? rows.filter(v => v.sectors.includes(this.kevSector)) : rows;
      const sorted = filtered.slice();
      if (this.kevSort === "epss") {
        sorted.sort((a, b) => (b.epss == null ? -1 : b.epss) - (a.epss == null ? -1 : a.epss) || Date.parse(b.added) - Date.parse(a.added));
      } else if (this.kevSort === "date") {
        sorted.sort((a, b) => Date.parse(b.added) - Date.parse(a.added));
      } else {
        sorted.sort((a, b) => (Date.parse(a.due) || Infinity) - (Date.parse(b.due) || Infinity));
      }
      return sorted;
    }

    setKevWindow(days) {
      this.kevWindow = days;
      this.querySelectorAll("[data-kev-window]").forEach(b => {
        const on = Number(b.getAttribute("data-kev-window")) === days;
        b.style.background = on ? INK : "transparent";
        b.style.color = on ? GROUND : INK;
      });
      this.renderSectors();
      this.renderKevFilters();
      this.renderKevList();
      this.renderKevVendors();
      this.renderKpis();
      this.renderNote();
    }

    async loadNvd() {
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 86400000);
      const iso = d => d.toISOString().slice(0, 23);
      const url = NVD_URL + "?resultsPerPage=120&cvssV3Severity=CRITICAL&pubStartDate=" + iso(start) + "&pubEndDate=" + iso(end);
      const j = await (await fetch(url)).json();
      const rows = (j.vulnerabilities || []).map(v => {
        const c = v.cve;
        const metric = ((c.metrics && (c.metrics.cvssMetricV31 || c.metrics.cvssMetricV40 || c.metrics.cvssMetricV30)) || [])[0];
        const data = metric && (metric.cvssData || {});
        const desc = ((c.descriptions || []).find(d => d.lang === "en") || {}).value || "";
        const vendorText = (c.configurations || []).map(cfg =>
          (cfg.nodes || []).map(n => (n.cpeMatch || []).map(m => m.criteria).join(" ")).join(" ")).join(" ");
        const text = desc + " " + vendorText + " " + (((c.cisaVulnerabilityName) || ""));
        return {
          cve: c.id,
          published: c.published,
          ageHours: Math.round(((Date.now() - Date.parse(c.published)) / 3600000) * 10) / 10,
          score: data ? num(data.baseScore) : null,
          severity: data ? data.baseSeverity : null,
          vector: data ? data.vectorString : null,
          attackVector: data ? data.attackVector : null,
          userInteraction: data ? data.userInteraction : null,
          privileges: data ? data.privilegesRequired : null,
          description: desc,
          sectors: sectorsFor(text),
          kevListed: !!c.cisaExploitAdd,
          kevAdded: c.cisaExploitAdd || null,
          source: c.sourceIdentifier
        };
      });
      // Sector-relevant first, then remotely exploitable without interaction.
      rows.sort((a, b) => (b.sectors.length ? 1 : 0) - (a.sectors.length ? 1 : 0)
        || (b.kevListed ? 1 : 0) - (a.kevListed ? 1 : 0)
        || (b.score || 0) - (a.score || 0));
      this.nvd = rows;
      this.nvdTotal = j.totalResults;
      await this.attachEpss(rows.slice(0, 60));
      this.renderNvd();
    }

    /* openFDA's device recall set carries a root-cause field, so software and
       firmware causes can be isolated from mechanical ones. These are safety
       recalls rather than security advisories, but for a health system they land
       in the same triage: which device, whose software, what does it stop doing. */
    async loadDevices() {
      const search = 'root_cause_description:("Software+design"+OR+"Software+change+control"+OR+"Software+manufacturing+process")';
      const url = FDA_DEVICE + "?search=" + search + "&sort=event_date_initiated:desc&limit=60";
      const j = await (await fetch(url)).json();
      const rows = (j.results || []).map(r => ({
        id: r.product_res_number,
        firm: r.recalling_firm,
        product: r.product_description,
        reason: r.reason_for_recall,
        cause: r.root_cause_description,
        action: r.action,
        status: r.recall_status,
        initiated: r.event_date_initiated,
        posted: r.event_date_posted,
        quantity: r.product_quantity,
        distribution: r.distribution_pattern,
        state: r.state,
        city: r.city,
        cyber: /cyber|unauthorized|vulnerab|encrypt|network|remote access|authentication|patch/i.test([r.reason_for_recall, r.action].join(" ")),
        classCode: r.product_code
      }));
      this.devices = rows;
      this.deviceTotal = j.meta && j.meta.results && j.meta.results.total;
      this.deviceUpdated = j.meta && j.meta.last_updated;
      this.renderDevices();
    }

    async loadNews() {
      const res = await fetch(proxyOrigin() + "/cybernews?hours=" + this.newsHours, { signal: AbortSignal.timeout(30000) });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      this.news = (j.items || []).map(it => Object.assign({}, it, { summary: cleanSummary(it.summary, it.title) }));
      this.newsMeta = j;
      this.renderNewsFilters();
      this.renderNews();
      return j;
    }

    async loadRansomware() {
      const days = this.rwDays || 7;
      const res = await fetch(proxyOrigin() + "/ransomware?days=" + days + "&scope=all", { signal: AbortSignal.timeout(35000) });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      this.ransom = j.items || [];
      this.ransomMeta = j;
      this.renderRansom();
      return j;
    }

    setRwWindow(days) {
      this.rwDays = days;
      this.querySelectorAll("[data-rw-window]").forEach(b => {
        const on = Number(b.getAttribute("data-rw-window")) === days;
        b.style.background = on ? RED : "transparent";
        b.style.color = on ? "#fff" : DARK_TEXT;
      });
      this.rwStatus("loading", "loading\u2026");
      this.loadRansomware().catch(() => this.renderRansom());
    }

    setRwTab(tab) {
      this.rwTab = tab;
      this.querySelectorAll("[data-rw-tab]").forEach(b => {
        const on = b.getAttribute("data-rw-tab") === tab;
        b.style.background = on ? DARK : "transparent";
        b.style.color = on ? DARK_TEXT : DARK_MUTED;
      });
      this.renderRwPanel();
    }

    rwStatus(state, text) {
      const dot = this.q("[data-rw-dot]"), t = this.q("[data-rw-status-text]");
      if (!dot || !t) return;
      dot.style.background = state === "live" ? "#2f7d4a" : state === "error" ? RED : MUTED;
      t.textContent = text;
    }

    /* ---------- victim map ------------------------------------------------
       A dark full-bleed world with one dot per claimed victim, after
       ransomware.live's own map. The feed gives a country and nothing finer, so
       dots are scattered inside the country rather than stacked on its centroid
       — a deterministic scatter, so a victim keeps its position between renders. */

    initRwMap() {
      const el = this.q("[data-rw-map]");
      if (!el || this.rwMap) return;
      const map = L.map(el, {
        zoomSnap: 0.25, attributionControl: false, minZoom: 1.5, maxZoom: 8,
        worldCopyJump: true
      });
      this.rwMap = map;
      this.rwExtent = this.rwExtent || "us";
      const home = RW_EXTENTS[this.rwExtent];
      map.setView(home.center, home.zoom);
      try {
        const opts = { subdomains: "abcd", maxZoom: 19, detectRetina: true };
        if (CARTO_KEY) opts.key = CARTO_KEY;
        L.tileLayer(DARK_TILES, opts).addTo(map);
      } catch (e) { /* basemap is scenery; the victim dots must still plot */ }
      this.rwMarkers = L.layerGroup().addTo(map);

      /* The map is built while this tab is hidden, so it measures 0x0 and any fit
         lands at the world view. Geometry observers are the wrong tool: a
         ResizeObserver on the container sees its own invalidateSize() as a resize
         and loops. This watcher only READS clientWidth, has no wall-clock budget
         to expire against while the tab sits unopened, and cancels itself for good
         the moment a fit succeeds. */
      this.armRwFit();
    }

    /* The view is already correct from setView, so all this has to do is tell
       Leaflet the container gained size, which makes it render tiles. It reads
       clientWidth only — no layout writes — and stops once the size sticks. */
    /* setInterval, not requestAnimationFrame: this document runs hidden
       (visibilityState "hidden"), and browsers suspend rAF entirely for hidden
       documents while still running throttled timers — a rAF watchdog here is
       scheduled and never invoked. Clear and reassign on the same path so no id
       value, stale or live, can block a re-arm. */
    armRwFit() {
      if (this.fitRwHome()) return;
      clearInterval(this._rwFitTimer);
      this._rwFitTimer = setInterval(() => {
        if (this.fitRwHome()) { clearInterval(this._rwFitTimer); this._rwFitTimer = null; }
      }, 300);
    }

    fitRwHome() {
      const el = this.q("[data-rw-map]");
      if (!this.rwMap || !el || !el.clientWidth) return false;
      this.rwMap.invalidateSize();
      if (this.rwMap.getSize().x === 0) return false;
      this._rwFitted = true;
      return true;
    }

    toggleRwFullscreen() {
      const shell = this.q("[data-rw-map-shell]"), btn = this.q("[data-rw-fullscreen]"), mapEl = this.q("[data-rw-map]");
      if (shell.getAttribute("data-expanded") === "1") {
        shell.removeAttribute("data-expanded");
        shell.style.cssText = "position:relative;";
        mapEl.style.height = "560px";
        btn.innerHTML = "&#10529; Full screen";
      } else {
        shell.setAttribute("data-expanded", "1");
        shell.style.cssText = "position:fixed;inset:0;z-index:5000;background:" + GROUND + ";";
        mapEl.style.height = "100%";
        btn.innerHTML = "&#10005; Exit full screen";
      }
      setTimeout(() => this.rwMap && this.rwMap.invalidateSize(), 60);
    }

    // Hash the victim name into a stable offset inside the country, so repeated
    // renders do not make the same claim jump around the map.
    rwPoint(v, i) {
      const geo = RW_GEO[v.country];
      if (!geo) return null;
      let h = 0;
      const key = (v.victim || "") + "|" + (v.group || "") + "|" + i;
      for (let n = 0; n < key.length; n++) h = (h * 31 + key.charCodeAt(n)) & 0x7fffffff;
      const spread = v.country === "US" || v.country === "RU" || v.country === "CA" || v.country === "CN"
        || v.country === "BR" || v.country === "AU" || v.country === "IN" ? 7 : 2.2;
      const a = (h % 1000) / 1000 * Math.PI * 2;
      const r = Math.sqrt(((h >> 10) % 1000) / 1000) * spread;
      return [geo[2] + Math.sin(a) * r * 0.72, geo[3] + Math.cos(a) * r];
    }

    paintRwMap() {
      if (!this.rwMap || !this.rwMarkers) return;
      const rows = this.ransom || [];
      this.rwMarkers.clearLayers();
      rows.forEach((v, i) => {
        const p = this.rwPoint(v, i);
        if (!p) return;
        const sector = v.sectors.length > 0;
        L.circleMarker(p, {
          radius: sector ? 6 : 4,
          fillColor: sector ? RED : MUTED,
          fillOpacity: sector ? 0.9 : 0.55,
          color: INK,
          weight: sector ? 2 : 1
        }).addTo(this.rwMarkers)
          .bindTooltip(
            '<b style="font-family:Archivo,system-ui,sans-serif;">' + esc(v.victim) + "</b><br>"
            + esc(v.group) + " \u00b7 " + esc((RW_GEO[v.country] || ["", v.country || "unknown"])[1])
            + (v.activity ? "<br>" + esc(v.activity) : "")
            + "<br>" + esc(relHours(v.ageDays * 24)),
            { direction: "top", opacity: 0.95 }
          )
          .on("click", () => {
            this.rwTab = "feed";
            this.setRwTab("feed");
            this.showRansomRecord(v);
          });
      });
      if (!this._rwFitted) this.armRwFit();
      this.renderRwCounters();
      this.renderRwTicker();
      this.renderRwPanel();
    }

    setRwExtent(key) {
      this.rwExtent = key;
      this.querySelectorAll("[data-rw-extent]").forEach(b => {
        const on = b.getAttribute("data-rw-extent") === key;
        b.style.background = on ? INK : "transparent";
        b.style.color = on ? GROUND : INK;
      });
      if (!this.rwMap) return;
      const e = RW_EXTENTS[key];
      this.rwMap.invalidateSize();
      this.rwMap.setView(e.center, e.zoom, { animate: false });
    }

    focusRwCountry(iso2) {
      const geo = RW_GEO[iso2];
      if (!geo || !this.rwMap) return;
      this.rwMap.setView([geo[2], geo[3]], 4.5, { animate: false });
    }

    rwTally(keyFn) {
      const m = {};
      (this.ransom || []).forEach(v => {
        const k = keyFn(v);
        if (!k) return;
        const e = m[k] = m[k] || { n: 0, sector: 0, last: null, lastVictim: null, groups: {} };
        e.n++;
        if (v.sectors.length) e.sector++;
        e.groups[v.group] = (e.groups[v.group] || 0) + 1;
        if (!e.last || v.claimedAt > e.last) { e.last = v.claimedAt; e.lastVictim = v.victim; }
      });
      return m;
    }

    renderRwCounters() {
      const box = this.q("[data-rw-counters]");
      if (!box) return;
      const rows = this.ransom || [];
      const legend = this.q("[data-rw-legend-box]");
      if (!rows.length) {
        box.style.display = "none";
        if (legend) legend.style.display = "none";
        return;
      }
      box.style.display = "flex";
      if (legend) legend.style.display = "flex";
      const sector = rows.filter(v => v.sectors.length).length;
      const countries = new Set(rows.filter(v => v.country).map(v => v.country)).size;
      const groups = new Set(rows.map(v => v.group)).size;
      const cells = [
        ["Claims", rows.length, DARK_TEXT],
        ["Our sectors", sector, RED],
        ["Countries", countries, DARK_TEXT],
        ["Groups", groups, DARK_TEXT]
      ];
      box.innerHTML = cells.map(([l, v, c], i) =>
        '<div style="padding:8px 13px;' + (i ? "border-left:2px solid " + RULE + ";" : "") + '">'
        + '<div style="font-size:9px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:' + DARK_MUTED + ';">' + l + "</div>"
        + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:20px;line-height:1.1;font-variant-numeric:tabular-nums;color:' + c + ';">'
        + Number(v).toLocaleString("en-US") + "</div></div>").join("");
    }

    renderRwTicker() {
      const box = this.q("[data-rw-ticker]");
      if (!box) return;
      const t = this.rwTally(v => v.group);
      const top = Object.entries(t).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
      box.innerHTML = top.length
        ? top.map(([g, e]) =>
            '<span style="display:flex;align-items:center;gap:5px;">'
            + '<span style="color:' + (e.sector ? RED : MUTED) + ';">\u25cf</span>' + esc(g)
            + '<span style="color:' + DARK_MUTED + ';font-variant-numeric:tabular-nums;">' + e.n + "</span></span>").join("")
        : "&mdash;";
    }

    /* ---------- the tabbed panel ----------------------------------------- */

    rwTableShell(cols, body) {
      return '<table style="width:100%;border-collapse:collapse;font-size:11px;">'
        + "<thead><tr>" + cols.map(c =>
            '<th style="text-align:' + (c.right ? "right" : "left") + ';font-size:9px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:'
            + DARK_MUTED + ";padding:9px 14px;border-bottom:1px solid " + DARK_LINE + ";background:" + DARK_PANEL
            + ";position:sticky;top:0;" + (c.w ? "width:" + c.w + ";" : "") + '">' + c.t + "</th>").join("")
        + "</tr></thead><tbody>" + body + "</tbody></table>";
    }

    rwCell(html, opts) {
      const o = opts || {};
      return '<td style="padding:9px 14px;border-bottom:1px solid ' + HAIR + ';vertical-align:top;'
        + (o.right ? "text-align:right;" : "") + (o.nowrap ? "white-space:nowrap;" : "")
        + (o.mono ? "font-variant-numeric:tabular-nums;" : "")
        + "color:" + (o.tone || DARK_TEXT) + ";" + (o.bold ? "font-weight:800;" : "font-weight:600;") + '">' + html + "</td>";
    }

    renderRwPanel() {
      const box = this.q("[data-rw-panel]");
      if (!box) return;
      const rows = this.ransom || [];
      if (!rows.length) {
        box.innerHTML = '<div style="padding:26px 24px;font-size:12px;line-height:1.6;color:'
          + (this.failures.includes("ransomware listings") ? RED : DARK_MUTED) + ';">'
          + (this.failures.includes("ransomware listings")
              ? "The leak-site feed did not answer through " + esc(new URL(proxyOrigin()).hostname)
                + ". Managed WashU devices block that address. Set an allowed Worker address on the Outages tab."
              : "No claims posted in this window.") + "</div>";
        return;
      }
      const tab = this.rwTab || "feed";
      if (tab === "feed") return this.renderRwFeed(box);
      if (tab === "groups") return this.renderRwGroupTable(box);
      if (tab === "countries") return this.renderRwCountryTable(box);
      return this.renderRwDash(box);
    }

    renderRwFeed(box) {
      const rows = (this.ransom || []).slice(0, 120);
      this.ransomRows = rows;
      box.innerHTML = this.rwTableShell(
        [{ t: "Time", w: "104px" }, { t: "Group", w: "128px" }, { t: "Victim" }, { t: "Sector", w: "168px" }, { t: "Country", w: "150px" }],
        rows.map((v, i) => {
          const sector = v.sectors.length > 0;
          return '<tr data-rw-idx="' + i + '" title="Open the listing" style="cursor:pointer;' + (sector ? "background:rgba(236,48,19,0.06);" : "") + '">'
            + this.rwCell(esc(relHours(v.ageDays * 24)), { tone: DARK_MUTED, nowrap: true, mono: true })
            + this.rwCell('<span style="color:' + (sector ? RED : DARK_TEXT) + ';">' + esc(v.group) + "</span>", { bold: true, nowrap: true })
            + this.rwCell(esc(v.victim))
            + this.rwCell(esc(v.activity || (sector ? v.sectors.map(k => RW_SECTOR_META[k].label).join(", ") : "not stated")), { tone: sector ? DARK_TEXT : DARK_MUTED })
            + this.rwCell(esc((RW_GEO[v.country] || ["", v.country || "not given"])[1]), { tone: DARK_MUTED, nowrap: true })
            + "</tr>";
        }).join("")
      );
    }

    renderRwGroupTable(box) {
      const t = this.rwTally(v => v.group);
      const top = Object.entries(t).sort((a, b) => b[1].n - a[1].n);
      box.innerHTML = this.rwTableShell(
        [{ t: "#", w: "48px" }, { t: "Group", w: "170px" }, { t: "Claims", w: "84px", right: true }, { t: "Last victim" }, { t: "Last seen", w: "112px" }],
        top.map(([g, e], i) =>
          "<tr>"
          + this.rwCell(String(i + 1), { tone: DARK_MUTED, mono: true })
          + this.rwCell('<span style="color:' + (e.sector ? RED : DARK_TEXT) + ';">' + esc(g) + "</span>", { bold: true, nowrap: true })
          + this.rwCell(String(e.n) + (e.sector ? '<span style="color:' + RED + ';font-size:9px;font-weight:800;letter-spacing:0.08em;"> \u00b7 ' + e.sector + " OURS</span>" : ""), { right: true, bold: true, mono: true, nowrap: true })
          + this.rwCell(esc(e.lastVictim || "\u2014"))
          + this.rwCell(esc(relHours((Date.now() - Date.parse(e.last)) / 3600000)), { tone: DARK_MUTED, nowrap: true, mono: true })
          + "</tr>").join("")
      );
    }

    renderRwCountryTable(box) {
      const t = this.rwTally(v => v.country);
      const top = Object.entries(t).sort((a, b) => b[1].n - a[1].n);
      box.innerHTML = this.rwTableShell(
        [{ t: "#", w: "48px" }, { t: "Country", w: "210px" }, { t: "Claims", w: "84px", right: true }, { t: "Top group" }, { t: "Last seen", w: "112px" }],
        top.map(([c, e], i) => {
          const topGroup = Object.entries(e.groups).sort((a, b) => b[1] - a[1])[0];
          return '<tr data-rw-country="' + esc(c) + '" title="Centre the map here" style="cursor:pointer;">'
            + this.rwCell(String(i + 1), { tone: DARK_MUTED, mono: true })
            + this.rwCell(esc((RW_GEO[c] || ["", c])[1]), { bold: true, nowrap: true })
            + this.rwCell(String(e.n) + (e.sector ? '<span style="color:' + RED + ';font-size:9px;font-weight:800;letter-spacing:0.08em;"> \u00b7 ' + e.sector + " OURS</span>" : ""), { right: true, bold: true, mono: true, nowrap: true })
            + this.rwCell(esc(topGroup ? topGroup[0] + " (" + topGroup[1] + ")" : "\u2014"), { tone: DARK_MUTED })
            + this.rwCell(esc(relHours((Date.now() - Date.parse(e.last)) / 3600000)), { tone: DARK_MUTED, nowrap: true, mono: true })
            + "</tr>";
        }).join("")
      );
    }

    renderRwDash(box) {
      const daily = ((this.ransomMeta || {}).daily || []).slice(-60);
      const rows = this.ransom || [];
      const sectors = {};
      rows.forEach(v => {
        const k = v.activity ? titleCase(v.activity) : "Not stated";
        sectors[k] = (sectors[k] || 0) + 1;
      });
      const top = Object.entries(sectors).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const maxSector = Math.max(1, ...top.map(x => x[1]));
      const maxDay = Math.max(1, ...daily.map(d => d.total));
      box.innerHTML = '<div style="display:grid;grid-template-columns:minmax(0,1fr) 340px;">'
        + '<div style="padding:16px 20px 18px 24px;border-right:1px solid ' + DARK_LINE + ';">'
        + '<div style="font-size:9px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:' + DARK_MUTED + ';margin-bottom:12px;">Claims per day</div>'
        + (daily.length
            ? '<div style="display:flex;align-items:flex-end;gap:2px;height:150px;">'
              + daily.map(d =>
                  '<div title="' + d.date + " \u00b7 " + d.total + ' claims" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;">'
                  + (d.sector ? '<div style="height:' + ((d.sector / maxDay) * 148).toFixed(1) + "px;background:" + RED + ';"></div>' : "")
                  + '<div style="height:' + (((d.total - d.sector) / maxDay) * 148).toFixed(1) + 'px;background:' + MUTED + ';"></div></div>').join("")
              + "</div>"
              + '<div style="display:flex;justify-content:space-between;margin-top:7px;font-size:9px;font-weight:700;color:' + DARK_MUTED + ';">'
              + "<span>" + esc(fmtDate(daily[0].date)) + "</span><span>" + esc(fmtDate(daily[daily.length - 1].date)) + "</span></div>"
              + '<div style="font-size:10px;color:' + DARK_MUTED + ';margin-top:9px;line-height:1.5;">Red is the share of each day\u2019s claims in healthcare, medical research or higher education. Busiest day: ' + maxDay + " claims.</div>"
            : '<div style="font-size:11px;color:' + DARK_MUTED + ';">No daily counts in this window.</div>')
        + "</div>"
        + '<div style="padding:16px 24px 18px 20px;">'
        + '<div style="font-size:9px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:' + DARK_MUTED + ';margin-bottom:12px;">Top sectors</div>'
        + top.map(([k, n]) => {
            const ours = Object.keys(RW_SECTOR_META).some(s => RW_ACTIVITY_UI[s].test(k));
            return '<div style="margin-bottom:9px;">'
              + '<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;font-weight:700;margin-bottom:3px;">'
              + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (ours ? RED : DARK_TEXT) + ';">' + esc(k) + "</span>"
              + '<span style="color:' + DARK_MUTED + ';font-variant-numeric:tabular-nums;">' + n + "</span></div>"
              + '<div style="height:6px;background:' + SURFACE + ';"><div style="height:6px;width:' + ((n / maxSector) * 100).toFixed(1) + "%;background:" + (ours ? RED : INK) + ';"></div></div></div>';
          }).join("")
        + "</div></div>";
    }

    showRansomRecord(v) {
      const list = this.ransomRows || [];
      const i = list.indexOf(v);
      if (i >= 0) return this.showRansom(i);
      this.ransomRows = [v].concat(list);
      this.showRansom(0);
    }

    renderRansom() {
      // The basemap and its extent belong to the map, not to the feed: build them
      // first so a feed outage leaves an empty map with an honest message rather
      // than a grey void with floating chrome over it.
      this.initRwMap();
      const meta = this.ransomMeta;
      if (!meta || meta.error) {
        this.rwStatus("error", "feed unavailable");
        this.renderRwCounters();
        this.renderRwTicker();
        this.renderRwPanel();
        return;
      }
      const rows = this.ransom || [];
      const sector = rows.filter(v => v.sectors.length).length;
      this.rwStatus("live", rows.length.toLocaleString("en-US") + " claims \u00b7 " + sector + " in our sectors");
      this.initRwMap();
      this.paintRwMap();
    }

    setNewsWindow(hours) {
      this.newsHours = hours;
      this.querySelectorAll("[data-news-window]").forEach(b => {
        const on = Number(b.getAttribute("data-news-window")) === hours;
        b.style.background = on ? INK : "transparent";
        b.style.color = on ? GROUND : INK;
      });
      this.loadNews().catch(() => {
        this.failures = [...new Set(this.failures.concat("advisory feeds"))];
        this.renderNews();
      });
    }

    renderSectors() {
      const rows = this.kevWindowRows();
      this.q("[data-sectors]").innerHTML = SECTORS.map((s, i) => {
        const mine = rows.filter(v => v.sectors.includes(s.key));
        const scored = mine.filter(v => v.epss != null).sort((a, b) => b.epss - a.epss);
        const top = scored.slice(0, 4);
        const veryHigh = scored.filter(v => v.epss >= 0.5).length;
        const ransom = mine.filter(v => v.ransomware).length;
        const overdue = mine.filter(v => { const d = daysUntil(v.due); return d != null && d < 0; }).length;
        const specific = mine.filter(v => !v.shared).length;
        return '<div style="padding:18px 20px 20px ' + (i === 0 ? "32px" : "20px") + ";border-right:" + (i === 2 ? "none" : "2px solid " + RULE) + ';">'
          + '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:3px;">'
          + '<span style="font-size:12px;font-weight:800;">' + esc(s.label) + "</span>"
          + (veryHigh ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + RED + ";color:" + GROUND + ';padding:2px 5px;">' + veryHigh + " very high</span>" : "")
          + "</div>"
          + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:34px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;">' + mine.length + "</div>"
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:5px;line-height:1.45;">'
          + "exploited vulnerabilities in scope &middot; " + specific + " name products specific to this sector"
          + (ransom ? " &middot; " + ransom + " ransomware-linked" : "")
          + (overdue ? ' &middot; <span style="color:' + DEEPRED + ';font-weight:700;">' + overdue + " past CISA due date</span>" : "")
          + "</div>"
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:8px;line-height:1.45;">' + esc(s.note) + "</div>"
          + (top.length
              ? '<div style="' + label("margin:14px 0 7px;") + '">Highest EPSS in scope</div>'
                + barList(top.map(v => ({ l: v.vendor + " " + String(v.product).slice(0, 24), v: v.epss, c: epssBand(v.epss).color })),
                    { labelWidth: "1fr", valWidth: "44px", fmt: v => (v * 100).toFixed(0) + "%" })
              : '<div style="' + label("margin-top:14px;") + '">No scored entries in this window</div>')
          + '<button data-sector-jump="' + s.key + '" class="btn btn-ghost" style="margin-top:12px;font-size:10px;letter-spacing:0.1em;padding:6px 0;">Filter the queue &rarr;</button>'
          + "</div>";
      }).join("");
    }

    renderKevChart() {
      const rows = this.kevAll || [];
      const weeks = 52;
      const bins = [];
      for (let i = weeks - 1; i >= 0; i--) {
        const end = Date.now() - i * 604800000;
        const start = end - 604800000;
        const n = rows.filter(v => { const t = Date.parse(v.added); return t > start && t <= end; }).length;
        bins.push({ t: fmtDate(new Date(end).toISOString()).replace(/, \d{4}$/, ""), v: n });
      }
      const peak = Math.max(...bins.map(b => b.v));
      bins.forEach(b => { if (b.v === peak && peak) b.c = RED; });
      const total = bins.reduce((n, b) => n + b.v, 0);
      this.q("[data-kev-chart]").innerHTML = columnChart(bins, { w: 320, h: 110 })
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:8px;line-height:1.5;">'
        + total + " added in 52 weeks &middot; busiest week " + peak
        + " &middot; " + (this.kevCount || 0).toLocaleString("en-US") + " in the full list &middot; version "
        + esc(this.kevVersion || "—") + "</div>";
    }

    renderKevVendors() {
      const rows = this.kevWindowRows().filter(v => v.sectors.length);
      const byVendor = {};
      rows.forEach(v => { byVendor[v.vendor] = (byVendor[v.vendor] || 0) + 1; });
      const top = Object.entries(byVendor).sort((a, b) => b[1] - a[1]).slice(0, 9)
        .map(([vendor, n]) => ({ l: vendor, v: n }));
      this.q("[data-kev-vendors]").innerHTML = top.length
        ? barList(top, { labelWidth: "1fr", valWidth: "34px" })
          + '<div style="' + label("margin-top:10px;line-height:1.5;") + '">Selected window only. Entries that touch our sectors only.</div>'
        : '<div style="' + label() + '">No entries touch our sectors in this window.</div>';
    }

    renderKevFilters() {
      const rows = this.kevWindowRows().filter(v => v.sectors.length);
      const cells = [{ key: null, label: "All sectors", n: rows.length }]
        .concat(SECTORS.map(s => ({ key: s.key, label: s.short, n: rows.filter(v => v.sectors.includes(s.key)).length })));
      this.q("[data-kev-filters]").innerHTML = cells.map((c, i) => {
        const on = this.kevSector === c.key || (!this.kevSector && c.key === null);
        return '<button data-kev-sector="' + (c.key || "") + '" style="flex:1 1 0;min-width:0;text-align:left;padding:10px 14px;border:none;border-right:'
          + (i === cells.length - 1 ? "none" : "2px solid " + RULE) + ";background:" + (on ? INK : "transparent") + ";color:" + (on ? GROUND : INK)
          + ';cursor:pointer;font-family:Archivo,system-ui,sans-serif;">'
          + '<div style="font-weight:800;font-size:18px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">' + c.n + "</div>"
          + '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-top:5px;opacity:0.85;">' + esc(c.label) + "</div></button>";
      }).join("");
    }

    renderKevList() {
      const rows = this.kevQueue();
      const box = this.q("[data-kev-list]");
      const note = this.q("[data-kev-note]");
      const all = this.kevAll || [];
      if (!all.length) {
        note.textContent = "The CISA KEV list did not load. This is a feed problem. The list itself is not empty. Try Refresh feeds.";
        box.innerHTML = "";
        return;
      }
      const inWindow = this.kevWindowRows();
      note.innerHTML = rows.length + " of " + inWindow.length + " entries added in the last "
        + (this.kevWindow < 365 ? this.kevWindow + " days" : "year") + " touch sector technology"
        + (this.kevSector ? " &middot; showing " + esc((SECTORS.find(s => s.key === this.kevSector) || {}).label || "") + " only" : "")
        + ". CISA lists a vulnerability only when it is being exploited. CISA also sets a fix-by date for federal agencies. That date is a useful clock for WashU too.";

      this.kevRows = rows;
      if (!rows.length) { box.innerHTML = '<div style="padding:20px 32px;font-size:12px;color:' + MUTED + ';">No entries touch our sectors in this window. Try a wider window above.</div>'; return; }

      box.innerHTML = rows.map((v, i) => {
        const band = epssBand(v.epss);
        const due = daysUntil(v.due);
        const overdue = due != null && due < 0;
        return '<div data-kev-idx="' + i + '" title="Open the KEV entry" style="display:grid;grid-template-columns:96px minmax(0,1fr) 96px;gap:12px;align-items:center;padding:12px 20px 12px 32px;border-bottom:1px solid ' + HAIR + ';cursor:pointer;'
          + (v.epss != null && v.epss >= 0.5 ? "background:rgba(236,48,19,0.05);" : "") + '">'
          + '<div><div style="font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;">' + esc(v.cve) + "</div>"
          + '<div style="' + label("margin-top:3px;") + '">' + esc(fmtDate(v.added).replace(/,.*/, "")) + "</div></div>"
          + '<div style="min-width:0;">'
          + '<div style="font-size:12px;font-weight:700;line-height:1.35;border-bottom:1px solid ' + INK + ';display:inline;">' + esc(v.vendor) + " " + esc(v.product) + "</div>"
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:4px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(v.name) + "</div>"
          + '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;align-items:center;">'
          + v.sectors.map(k => '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:2px 5px;border:1px solid ' + INK + ';">' + esc((SECTORS.find(s => s.key === k) || {}).short || k) + "</span>").join("")
          + (v.shared ? '<span style="' + label() + '">shared infrastructure</span>' : "")
          + (v.ransomware ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:2px 5px;">Ransomware</span>' : "")
          + "</div></div>"
          + '<div style="text-align:right;">'
          + '<div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">'
          + (band ? '<span style="width:9px;height:9px;background:' + band.color + ';"></span>' : "")
          + '<span style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:16px;line-height:1;font-variant-numeric:tabular-nums;">'
          + (v.epss == null ? "—" : (v.epss * 100).toFixed(v.epss >= 0.1 ? 0 : 1) + "%") + "</span></div>"
          + '<div style="' + label("margin-top:4px;") + '">EPSS</div>'
          + (due != null
              ? '<div style="font-size:10px;font-weight:700;margin-top:5px;color:' + (overdue ? DEEPRED : MUTED) + ';">'
                + (overdue ? Math.abs(due) + " d overdue" : "due in " + due + " d") + "</div>"
              : "")
          + "</div></div>";
      }).join("");
    }

    renderNewsFilters() {
      const items = this.news || [];
      const meta = this.newsMeta || {};
      const sectors = (meta.sectors || SECTORS.map(s => ({ key: s.key, label: s.short })));
      const threats = (meta.threats || []);
      const cells = [{ key: null, label: "Everything", n: items.length }]
        .concat(sectors.map(s => ({ key: "sector:" + s.key, label: s.label, n: items.filter(i => (i.sectors || []).includes(s.key)).length })))
        .concat([{ key: "official", label: "Official only", n: items.filter(i => i.official).length }])
        .concat(threats.slice(0, 4).map(t => ({ key: "threat:" + t.key, label: t.label, n: items.filter(i => (i.threats || []).includes(t.key)).length })));
      this.q("[data-news-filters]").innerHTML = cells.map((c, i) => {
        const on = this.newsFilter === c.key || (!this.newsFilter && c.key === null);
        return '<button data-news-filter="' + (c.key || "") + '" style="flex:1 1 0;min-width:0;text-align:left;padding:10px 12px;border:none;border-right:'
          + (i === cells.length - 1 ? "none" : "2px solid " + RULE) + ";background:" + (on ? INK : "transparent") + ";color:" + (on ? GROUND : INK)
          + ';cursor:pointer;opacity:' + (c.n || c.key === null ? 1 : 0.45) + ';font-family:Archivo,system-ui,sans-serif;">'
          + '<div style="font-weight:800;font-size:17px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">' + c.n + "</div>"
          + '<div style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-top:5px;opacity:0.85;">' + esc(c.label) + "</div></button>";
      }).join("");
    }

    renderNews() {
      const all = this.news || [];
      const box = this.q("[data-news]");
      const note = this.q("[data-news-note]");
      const meta = this.newsMeta || {};
      const win = this.newsHours < 100 ? "last " + this.newsHours + " hours" : "last " + this.newsHours / 24 + " days";

      if (!all.length) {
        note.innerHTML = this.failures.includes("advisory feeds")
          ? 'Advisory feeds did not answer through <b>' + esc(new URL(proxyOrigin()).hostname) + "</b>. This panel needs the dashboard Worker. Managed WashU devices may block that address. Set an allowed Worker address on the Outages tab."
          : "No advisories or reports in the " + win + ". Try a wider window above.";
        box.innerHTML = "";
        this.q("[data-news-counts]").textContent = "";
        return;
      }

      const official = all.filter(i => i.official).length;
      note.innerHTML = all.length + " items in the " + win + " &middot; " + official + " official advisor" + (official === 1 ? "y" : "ies")
        + ", " + (all.length - official) + " press report" + ((all.length - official) === 1 ? "" : "s")
        + (meta.sourcesAnswering ? " &middot; " + meta.sourcesAnswering + " of " + meta.sourcesTotal + " sources answering" : "")
        + '. <span style="color:' + MUTED + ';">Sector and threat tags come from keyword rules. Press items are news reports, not official notices.</span>';
      const fresh = all.filter(i => i.ageHours != null && i.ageHours <= 6).length;
      const stack = all.filter(i => i.stack).length;
      this.q("[data-news-counts]").textContent = fresh + " in the last 6 h" + (stack ? " · " + stack + " name sector infrastructure" : "");

      let rows = all;
      if (this.newsFilter === "official") rows = all.filter(i => i.official);
      else if (String(this.newsFilter || "").startsWith("sector:")) rows = all.filter(i => (i.sectors || []).includes(this.newsFilter.slice(7)));
      else if (String(this.newsFilter || "").startsWith("threat:")) rows = all.filter(i => (i.threats || []).includes(this.newsFilter.slice(7)));
      this.newsRows = rows.slice(0, 40);

      if (!this.newsRows.length) {
        box.innerHTML = '<div style="padding:20px 32px;font-size:12px;color:' + MUTED + ';">Nothing in this group for the selected window.</div>';
        return;
      }

      box.innerHTML = this.newsRows.map((it, i) => {
        const tags = (it.threats || []).slice(0, 2).map(k =>
          '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:2px 5px;border:1px solid ' + INK + ';">'
          + esc(((meta.threats || []).find(t => t.key === k) || {}).label || k) + "</span>").join("");
        const secs = (it.sectors || []).map(k =>
          '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:2px 5px;background:' + SURFACE + ';">'
          + esc(((meta.sectors || []).find(s => s.key === k) || {}).label || k) + "</span>").join("");
        return '<div data-news-idx="' + i + '" title="Open the item" style="padding:14px 20px 14px ' + (i % 2 === 0 ? "32px" : "20px")
          + ';border-right:' + (i % 2 === 0 ? "2px solid " + RULE : "none") + ';border-bottom:1px solid ' + HAIR + ';cursor:pointer;'
          + (it.official ? "background:" + SURFACE + ";" : "") + '">'
          + '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:6px;">'
          + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:' + (it.official ? DEEPRED : MUTED) + ';">' + esc(it.outlet) + "</span>"
          + (it.official ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:2px 5px;">' + (it.ics ? "Advisory · ICS" : "Advisory") + "</span>" : "")
          + (it.stack ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + INK + ';padding:1px 4px;">Stack</span>' : "")
          + '<span style="' + label() + 'margin-left:auto;font-variant-numeric:tabular-nums;">' + esc(relHours(it.ageHours)) + "</span></div>"
          + '<div style="font-size:13px;font-weight:700;line-height:1.4;border-bottom:1px solid ' + INK + ';display:inline;">' + esc(it.title) + "</div>"
          + (it.cves ? '<div style="' + label("margin-top:7px;") + '">' + esc(it.cves.join(" · ")) + "</div>" : "")
          + (it.summary ? '<div style="font-size:11px;color:' + MUTED + ';margin-top:7px;line-height:1.5;">' + esc(it.summary.slice(0, 160)) + (it.summary.length > 160 ? "…" : "") + "</div>" : "")
          + '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:9px;">' + secs + tags + "</div></div>";
      }).join("");
    }

    renderNvd() {
      const rows = this.nvd || [];
      const box = this.q("[data-nvd]");
      const note = this.q("[data-nvd-note]");
      if (!rows.length) {
        note.textContent = "No critical CVEs published in the last seven days, or NVD did not answer. Try Refresh feeds.";
        box.innerHTML = "";
        return;
      }
      const relevant = rows.filter(r => r.sectors.length);
      const kev = rows.filter(r => r.kevListed);
      note.innerHTML = rows.length + " critical vulnerabilities published in the last seven days"
        + (this.nvdTotal && this.nvdTotal > rows.length ? " (of " + this.nvdTotal.toLocaleString("en-US") + " in NVD for the window)" : "")
        + " &middot; " + relevant.length + " name sector technology"
        + (kev.length ? " &middot; " + kev.length + " already on CISA's exploited list" : "")
        + '. <span style="color:' + MUTED + ';">CVSS says how bad it would be if exploited. EPSS says how likely exploitation is in 30 days. Read both.</span>';
      this.nvdRows = rows.slice(0, 40);
      box.innerHTML = this.nvdRows.map((r, i) => {
        const band = epssBand(r.epss);
        return '<div data-nvd-idx="' + i + '" title="Open the CVE record" style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:baseline;padding:11px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;">'
          + '<span style="width:9px;height:9px;margin-top:5px;background:' + (SEV_COLOR[r.severity] || MUTED) + ';"></span>'
          + '<div style="min-width:0;">'
          + '<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;">'
          + '<span style="font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;border-bottom:1px solid ' + INK + ';">' + esc(r.cve) + "</span>"
          + '<span style="' + label() + '">CVSS ' + (r.score == null ? "—" : r.score.toFixed(1)) + " &middot; " + esc(relHours(r.ageHours)) + "</span>"
          + (r.kevListed ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + RED + ";color:" + GROUND + ';padding:2px 5px;">Exploited</span>' : "")
          + "</div>"
          + '<div style="font-size:11px;line-height:1.45;margin-top:5px;">' + esc(String(r.description).slice(0, 150)) + (String(r.description).length > 150 ? "…" : "") + "</div>"
          + (r.sectors.length
              ? '<div style="display:flex;gap:5px;margin-top:7px;">' + r.sectors.map(k => '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:2px 5px;background:' + SURFACE + ';">' + esc((SECTORS.find(s => s.key === k) || {}).short || k) + "</span>").join("") + "</div>"
              : "")
          + "</div>"
          + '<span style="text-align:right;white-space:nowrap;"><span style="font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;color:' + (band ? band.color : MUTED) + ';">'
          + (r.epss == null ? "—" : (r.epss * 100).toFixed(r.epss >= 0.1 ? 0 : 1) + "%") + '</span><span style="' + label("display:block;margin-top:3px;") + '">EPSS</span></span></div>';
      }).join("");
    }

    renderDevices() {
      const rows = this.devices || [];
      const box = this.q("[data-devices]");
      const note = this.q("[data-device-note]");
      if (!rows.length) { note.textContent = "The device recall feed did not answer. Try Refresh feeds."; box.innerHTML = ""; return; }
      const cyber = rows.filter(r => r.cyber).length;
      note.innerHTML = "The " + rows.length + " most recent recalls caused by software or firmware"
        + (this.deviceTotal ? ", of " + this.deviceTotal.toLocaleString("en-US") + " on record" : "")
        + (cyber ? " &middot; " + cyber + " mention access, authentication, encryption or network behaviour" : "")
        + '. <span style="color:' + MUTED + ';">These are safety recalls. They are not security advisories. For a hospital they need the same triage.</span>';
      this.deviceRows = rows;
      box.innerHTML = rows.map((r, i) =>
        '<div data-device-idx="' + i + '" title="Open the recall record" style="display:grid;grid-template-columns:auto 1fr;gap:10px;padding:11px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;">'
        + '<span style="width:9px;height:9px;margin-top:5px;background:' + (r.cyber ? RED : MUTED) + ';"></span>'
        + '<div style="min-width:0;">'
        + '<div style="font-size:12px;font-weight:700;line-height:1.4;border-bottom:1px solid ' + INK + ';display:inline;">' + esc(titleCase(r.firm || "Firm not named")) + "</div>"
        + '<div style="' + label("margin-top:4px;") + '">' + esc(r.id || "") + " &middot; " + esc(fmtFdaDate(r.initiated)) + " &middot; " + esc(r.status || "") + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:5px;line-height:1.45;">' + esc(String(r.reason || "").slice(0, 150)) + (String(r.reason || "").length > 150 ? "…" : "") + "</div>"
        + "</div></div>").join("");
    }

    /* ---------- record pop-ups ------------------------------------------- */

    closeModal() { this.q("[data-cw-modal]").style.display = "none"; }

    openModal(kicker, title, body) {
      this.q("[data-cw-modal]").style.display = "flex";
      this.q("[data-cw-modal-kicker]").textContent = kicker;
      this.q("[data-cw-modal-title]").textContent = title;
      this.q("[data-cw-modal-body]").innerHTML = body;
    }

    modalRow(k, v, tone) {
      if (v == null || v === "") return "";
      return '<div style="display:grid;grid-template-columns:38% 1fr;gap:12px;padding:8px 0;border-bottom:1px solid ' + HAIR + ';align-items:baseline;">'
        + '<span style="' + label() + '">' + esc(k) + "</span>"
        + '<span style="font-weight:600;color:' + (tone || INK) + ';">' + esc(v) + "</span></div>";
    }

    modalActions(links) {
      return '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:16px;">'
        + links.filter(l => l && l.href).map((l, i) =>
          '<a href="' + esc(l.href) + '" target="_blank" rel="noopener" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:9px 13px;text-decoration:none;border:2px solid '
          + INK + ";background:" + (i === 0 ? INK : "transparent") + ";color:" + (i === 0 ? GROUND : INK) + ';">' + esc(l.text) + "</a>").join("")
        + "</div>";
    }

    showKev(i) {
      const v = (this.kevRows || [])[i];
      if (!v) return;
      const band = epssBand(v.epss);
      const due = daysUntil(v.due);
      const notes = String(v.notes || "").split(/\s*;\s*/).filter(x => /^https?:/.test(x));
      const body =
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-bottom:14px;">'
        + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + RED + ";color:" + GROUND + ';padding:3px 6px;">Known exploited</span>'
        + (band ? '<span style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;"><span style="width:10px;height:10px;background:' + band.color + ';"></span>' + esc(band.label) + " EPSS &middot; " + esc(band.note) + "</span>" : "")
        + (v.ransomware ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + INK + ';padding:2px 5px;">Used in ransomware campaigns</span>' : "")
        + "</div>"
        + '<div style="font-size:13px;font-weight:600;line-height:1.55;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">' + esc(v.description) + "</div>"
        + '<div style="margin-top:6px;">'
        + this.modalRow("CVE", v.cve)
        + this.modalRow("Vendor and product", v.vendor + " " + v.product)
        + this.modalRow("Vulnerability", v.name)
        + this.modalRow("EPSS score", v.epss == null ? "not scored" : (v.epss * 100).toFixed(2) + "% chance of exploitation in 30 days")
        + this.modalRow("EPSS percentile", v.epssPct == null ? null : (v.epssPct * 100).toFixed(1) + "% of all scored CVEs rank lower")
        + this.modalRow("Added to KEV list", fmtDate(v.added))
        + this.modalRow("CISA due date", v.due ? fmtDate(v.due) + (due != null ? (due < 0 ? " · " + Math.abs(due) + " days overdue" : " · " + due + " days left") : "") : null, due != null && due < 0 ? DEEPRED : INK)
        + this.modalRow("Ransomware use", v.ransomware ? "Known" : "Not known to CISA")
        + this.modalRow("Weakness types", (v.cwes || []).join(", "))
        + this.modalRow("Sectors matched", v.sectors.map(k => (SECTORS.find(s => s.key === k) || {}).label).filter(Boolean).join(", "))
        + this.modalRow("Match basis", v.shared ? "shared infrastructure, counted for all three sectors" : "product specific to this sector")
        + "</div>"
        + '<div style="' + label("margin:16px 0 6px;") + '">Required action, as published by CISA</div>'
        + '<div style="font-size:12px;line-height:1.55;">' + esc(v.action) + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">The due date is CISA&rsquo;s deadline for federal civilian agencies. WashU is not bound by it. The rest of the sector works to it, so it is a useful clock for setting priorities.</div>'
        + this.modalActions([
          { text: "NVD record", href: "https://nvd.nist.gov/vuln/detail/" + v.cve },
          { text: "CISA KEV entry", href: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=" + encodeURIComponent(v.cve) },
          notes[0] ? { text: "Vendor advisory", href: notes[0] } : null
        ]);
      this.openModal("CISA known exploited vulnerability", v.vendor + " " + v.product, body);
    }

    showNvd(i) {
      const r = (this.nvdRows || [])[i];
      if (!r) return;
      const band = epssBand(r.epss);
      const body =
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-bottom:14px;">'
        + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + (SEV_COLOR[r.severity] || MUTED) + ";color:" + GROUND + ';padding:3px 6px;">'
        + esc(r.severity || "unscored") + " &middot; CVSS " + (r.score == null ? "—" : r.score.toFixed(1)) + "</span>"
        + (band ? '<span style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;"><span style="width:10px;height:10px;background:' + band.color + ';"></span>' + esc(band.label) + " EPSS</span>" : "")
        + (r.kevListed ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + RED + ";color:" + GROUND + ';padding:2px 5px;">On CISA\'s exploited list</span>' : "")
        + "</div>"
        + '<div style="font-size:13px;font-weight:600;line-height:1.55;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">' + esc(r.description) + "</div>"
        + '<div style="margin-top:6px;">'
        + this.modalRow("CVE", r.cve)
        + this.modalRow("Published", new Date(r.published).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT")
        + this.modalRow("CVSS vector", r.vector)
        + this.modalRow("Attack vector", r.attackVector)
        + this.modalRow("Privileges required", r.privileges)
        + this.modalRow("User interaction", r.userInteraction)
        + this.modalRow("EPSS score", r.epss == null ? "not scored" : (r.epss * 100).toFixed(2) + "% chance of exploitation in 30 days")
        + this.modalRow("Exploited in the wild", r.kevListed ? "Yes. CISA listed it " + fmtDate(r.kevAdded) : "No. CISA has not listed it")
        + this.modalRow("Sectors matched", r.sectors.map(k => (SECTORS.find(s => s.key === k) || {}).label).filter(Boolean).join(", "))
        + this.modalRow("Reported by", r.source)
        + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">CVSS says how bad it would be if exploited. EPSS says how likely exploitation is in 30 days. Critical CVSS with low EPSS can usually be patched on schedule. Moderate CVSS with high EPSS often cannot.</div>'
        + this.modalActions([
          { text: "NVD record", href: "https://nvd.nist.gov/vuln/detail/" + r.cve },
          { text: "EPSS detail", href: "https://api.first.org/data/v1/epss?cve=" + r.cve }
        ]);
      this.openModal("Newly published vulnerability", r.cve, body);
    }

    showDevice(i) {
      const r = (this.deviceRows || [])[i];
      if (!r) return;
      const body =
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-bottom:14px;">'
        + '<span style="width:11px;height:11px;background:' + (r.cyber ? RED : MUTED) + ';"></span>'
        + '<span style="font-size:12px;font-weight:800;">' + esc(r.cause || "Software root cause") + "</span>"
        + (r.cyber ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + INK + ';padding:2px 5px;">Mentions access, authentication or network behaviour</span>' : "")
        + "</div>"
        + '<div style="font-size:13px;font-weight:600;line-height:1.55;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">' + esc(r.reason || "Reason not published") + "</div>"
        + '<div style="margin-top:6px;">'
        + this.modalRow("Recall number", r.id)
        + this.modalRow("Recalling firm", titleCase(r.firm || ""))
        + this.modalRow("Firm location", [titleCase(r.city || ""), r.state].filter(Boolean).join(", "))
        + this.modalRow("Status", r.status)
        + this.modalRow("Recall started", fmtFdaDate(r.initiated))
        + this.modalRow("Posted", fmtFdaDate(r.posted))
        + this.modalRow("Root cause", r.cause)
        + this.modalRow("Units on the market", r.quantity)
        + this.modalRow("Distribution", r.distribution ? String(r.distribution).slice(0, 220) : null)
        + "</div>"
        + '<div style="' + label("margin:16px 0 6px;") + '">Product</div>'
        + '<div style="font-size:12px;line-height:1.55;">' + esc(r.product || "Not published") + "</div>"
        + (r.action ? '<div style="' + label("margin:16px 0 6px;") + '">Firm action</div><div style="font-size:12px;line-height:1.55;">' + esc(String(r.action).slice(0, 600)) + "</div>" : "")
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">This is the openFDA recall record. FDA&rsquo;s own database is the official source. It also carries any related safety notice.</div>'
        + this.modalActions([
          { text: "FDA recall database", href: "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfres/res.cfm?start_search=1&productdescriptiontxt=&productcode=&IVDProducts=&rootCauseText=&recallnumber=" + encodeURIComponent(r.id || "") },
          { text: "openFDA record", href: FDA_DEVICE + '?search=product_res_number:"' + encodeURIComponent(r.id || "") + '"' }
        ]);
      this.openModal("Medical device recall · software root cause", titleCase(r.firm || "Device recall"), body);
    }

    showRansom(i) {
      const r = (this.ransomRows || [])[i];
      if (!r) return;
      const body =
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-bottom:14px;">'
        + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + MUTED + ";color:" + MUTED + ';padding:2px 5px;">Ransomware group claim &middot; unconfirmed</span>'
        + r.sectors.map(k => '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:3px 6px;background:' + SURFACE + ';">' + esc((RW_SECTOR_META[k] || {}).label || k) + "</span>").join("")
        + "</div>"
        + (r.description ? '<div style="font-size:13px;font-weight:600;line-height:1.55;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">' + esc(r.description) + "</div>" : "")
        + '<div style="margin-top:6px;">'
        + this.modalRow("Victim as listed", r.victim)
        + this.modalRow("Group", r.group)
        + this.modalRow("Country", r.country ? (RW_GEO[r.country] || ["", r.country])[1] + " (" + r.country + ")" : "not given")
        + this.modalRow("Activity as listed", r.activity || "not given")
        + this.modalRow("Sector based on", r.sectorSource === "activity" ? "the feed’s own activity label" : r.sectorSource === "description" ? "the victim description, a weaker signal" : "no sector match")
        + this.modalRow("Claimed", new Date(r.claimedAt).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT")
        + this.modalRow("Age of claim", Math.round(r.ageDays) + " days")
        + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">Taken from the group&rsquo;s own leak site. A listing means the group claims this victim. It does not confirm a breach. Groups usually post weeks after the intrusion. Country comes from the feed. Use this for sector trends. Do not treat it as a report about any named organisation.</div>'
        + this.modalActions([{ text: "ransomware.live", href: "https://www.ransomware.live/" }]
          .concat(r.url ? [{ text: "Listing as posted", href: r.url }] : []));
      this.openModal("Ransomware leak-site listing", r.victim, body);
    }

    showNews(i) {
      const it = (this.newsRows || [])[i];
      if (!it) return;
      const meta = this.newsMeta || {};
      const body =
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;">'
        + (it.official
            ? '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:3px 6px;">Official advisory' + (it.ics ? " · ICS/medical" : "") + "</span>"
            : '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + MUTED + ";color:" + MUTED + ';padding:2px 5px;">Press report &middot; unverified</span>')
        + (it.threats || []).map(k => '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:3px 6px;border:1px solid ' + INK + ';">'
            + esc(((meta.threats || []).find(t => t.key === k) || {}).label || k) + "</span>").join("")
        + "</div>"
        + (it.summary ? '<div style="font-size:13px;font-weight:600;line-height:1.55;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">' + esc(it.summary) + "</div>" : "")
        + '<div style="margin-top:6px;">'
        + this.modalRow("Source", it.outlet)
        + this.modalRow("Received through", it.via || "dashboard Worker")
        + this.modalRow("Published", it.published ? new Date(it.published).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT" : "not stated")
        + this.modalRow("Age", relHours(it.ageHours))
        + this.modalRow("Sectors matched", (it.sectors || []).map(k => ((meta.sectors || []).find(s => s.key === k) || {}).label).filter(Boolean).join(", "))
        + this.modalRow("Names sector infrastructure", it.stack ? "Yes. It names shared infrastructure our sectors run" : null, DEEPRED)
        + this.modalRow("CVEs named", it.cves ? it.cves.join(", ") : null)
        + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">'
        + (it.official
            ? "Published by the agency itself. Sector and threat tags come from this dashboard&rsquo;s keyword rules. The agency did not assign them."
            : "Trade press report. Useful early warning. Confirm with CISA, HC3, the vendor or Health-ISAC before acting on it.")
        + "</div>"
        + this.modalActions([
          { text: "Open the source", href: it.url },
          it.cves && it.cves[0] ? { text: "NVD · " + it.cves[0], href: "https://nvd.nist.gov/vuln/detail/" + it.cves[0] } : null
        ]);
      this.openModal(it.official ? "Official cybersecurity advisory" : "Sector cyber news report", it.title, body);
    }

    /* ---------- headline numbers and the composed note ------------------- */

    renderKpis() {
      const win = this.kevWindowRows();
      const relevant = win.filter(v => v.sectors.length);
      const veryHigh = relevant.filter(v => v.epss != null && v.epss >= 0.5);
      const ransom = relevant.filter(v => v.ransomware);
      const overdue = relevant.filter(v => { const d = daysUntil(v.due); return d != null && d < 0; });
      const news = this.news || [];
      const advisories = news.filter(i => i.official);
      const rw = this.ransom || [];

      const cells = [
        { l: "Exploited vulns in scope", v: relevant.length ? String(relevant.length) : this.kevAll ? "0" : "—",
          s: this.kevWindow < 365 ? "added in " + this.kevWindow + " days" : "added in the last year",
          d: this.kevAll ? win.length + " total added in window" : "list unavailable", tone: MUTED },
        { l: "EPSS very high", v: this.kevAll ? String(veryHigh.length) : "—",
          s: "≥50% chance of exploitation in 30 days", d: veryHigh.length ? "act on these first" : "none in scope", tone: veryHigh.length ? DEEPRED : MUTED },
        { l: "Ransomware-linked", v: this.kevAll ? String(ransom.length) : "—",
          s: "CISA confirms ransomware use", d: "of " + relevant.length + " in scope", tone: ransom.length ? DEEPRED : MUTED },
        { l: "Past CISA due date", v: this.kevAll ? String(overdue.length) : "—",
          s: "CISA's fix-by date for federal agencies", d: "a sector-wide clock", tone: overdue.length ? DEEPRED : MUTED },
        { l: "Official advisories", v: advisories.length ? String(advisories.length) : news.length ? "0" : "—",
          s: "CISA and HC3, " + (this.newsHours < 100 ? this.newsHours + " h" : this.newsHours / 24 + " d"),
          d: news.length ? "plus " + (news.length - advisories.length) + " press reports" : "feed unavailable", tone: MUTED },
        { l: "Sector ransomware claims", v: rw.length ? String(rw.length) : this.ransomMeta ? "0" : "—",
          s: "leak-site listings, 30 days", d: rw.length ? "unconfirmed group claims" : "feed unavailable", tone: MUTED }
      ];

      this.q("[data-kpis]").innerHTML = cells.map((c, i) =>
        '<div style="padding:16px 20px;border-right:' + (i === cells.length - 1 ? "none" : "2px solid " + RULE) + ';display:flex;flex-direction:column;gap:6px;'
        + (i === 0 ? "padding-left:32px;" : "") + '">'
        + '<span style="' + label() + '">' + esc(c.l) + "</span>"
        + '<span style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:26px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">' + esc(c.v) + "</span>"
        + '<span style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + c.tone + ';">' + esc(c.d) + "</span>"
        + '<span style="font-size:11px;color:' + MUTED + ';">' + esc(c.s) + "</span></div>").join("");
    }

    renderNote() {
      const bits = [];
      const win = this.kevWindowRows();
      const relevant = win.filter(v => v.sectors.length);
      const winLabel = this.kevWindow < 365 ? this.kevWindow + " days" : "year";

      if (this.kevAll) {
        const veryHigh = relevant.filter(v => v.epss != null && v.epss >= 0.5).sort((a, b) => b.epss - a.epss);
        bits.push("CISA's exploited-vulnerability list (version " + this.kevVersion + ") added " + win.length
          + " entries in the last " + winLabel + ". " + relevant.length + " name technology this sector runs.");
        if (veryHigh.length) {
          const top = veryHigh[0];
          bits.push(veryHigh.length + " ha" + (veryHigh.length === 1 ? "s" : "ve") + " an EPSS above 50%. The highest is "
            + top.cve + " in " + top.vendor + " " + top.product + " at " + (top.epss * 100).toFixed(0) + "%.");
        } else if (relevant.length) {
          bits.push("None score above 50% on EPSS. The queue can be patched on schedule. This is not an emergency.");
        }
        const overdue = relevant.filter(v => { const d = daysUntil(v.due); return d != null && d < 0; });
        if (overdue.length) bits.push(overdue.length + " are past the fix-by date CISA set.");
      } else {
        bits.push("The CISA exploited-vulnerability list did not load, so the exposure queue is unavailable. This is a feed problem. The list itself is not empty.");
      }

      const byS = SECTORS.map(s => ({ label: s.label.toLowerCase(), n: relevant.filter(v => v.sectors.includes(s.key)).length }))
        .filter(x => x.n).sort((a, b) => b.n - a.n);
      if (byS.length) bits.push("By sector: " + byS.map(x => x.label + " " + x.n).join(", ") + ".");

      const news = this.news || [];
      if (news.length) {
        const official = news.filter(i => i.official).length;
        const stack = news.filter(i => i.stack).length;
        bits.push(news.length + " advisories and reports in the news window. " + official + " are official."
          + (stack ? " " + stack + " name infrastructure our sectors run." : ""));
      }
      const rw = this.ransom || [];
      if (rw.length) {
        const c = (this.ransomMeta || {}).counts || {};
        bits.push(rw.length + " sector organisations were named on ransomware leak sites in the last 30 days"
          + (c.health ? " (" + c.health + " healthcare" + (c.education ? ", " + c.education + " education" : "") + ")" : "")
          + ". These are claims. None is a confirmed breach.");
      }
      const dev = (this.devices || []).filter(d => d.cyber);
      if (dev.length) bits.push(dev.length + " recent medical device recalls caused by software mention access, authentication, encryption or network behaviour.");

      bits.push("Nothing on this page watches WashU's own network.");
      this.q("[data-note]").textContent = bits.join(" ");
    }

    publish() {
      if (typeof window === "undefined") return;
      window.__omContext = window.__omContext || {};
      const win = this.kevWindowRows();
      const relevant = win.filter(v => v.sectors.length);
      const veryHigh = relevant.filter(v => v.epss != null && v.epss >= 0.5);
      window.__omContext.cyber = {
        kevCatalogVersion: this.kevVersion || null,
        kevWindowDays: this.kevWindow,
        kevAddedInWindow: this.kevAll ? win.length : null,
        kevSectorRelevant: this.kevAll ? relevant.length : null,
        kevEpssVeryHigh: this.kevAll ? veryHigh.length : null,
        kevTopExposures: veryHigh.slice(0, 5).map(v => ({ cve: v.cve, vendor: v.vendor, product: v.product, epss: v.epss, ransomware: v.ransomware, sectors: v.sectors })),
        kevPastDueDate: this.kevAll ? relevant.filter(v => { const d = daysUntil(v.due); return d != null && d < 0; }).length : null,
        officialAdvisories: (this.news || []).filter(i => i.official).length || null,
        advisoryWindowHours: this.newsHours,
        sectorRansomwareClaims30d: this.ransomMeta ? (this.ransom || []).length : null,
        deviceSoftwareRecalls: (this.devices || []).length || null,
        unavailableFeeds: this.failures.length ? this.failures : null,
        caveat: "External exposure reporting only. No visibility into WashU networks, endpoints or accounts; internal detection lives with IT Security.",
        sources: "CISA KEV catalogue, FIRST EPSS, NVD CVE API, openFDA device recalls, CISA/HC3 advisory RSS, ransomware.live leak-site listings",
        updated: new Date().toISOString()
      };
      window.dispatchEvent(new Event("om-context"));
    }
  }

  if (!customElements.get("cyber-watch")) customElements.define("cyber-watch", CyberWatch);
})();

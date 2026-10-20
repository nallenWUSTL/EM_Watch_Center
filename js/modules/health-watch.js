/* National public health picture. Registers <health-watch>.
   Requires Leaflet on the page (loaded in the DC helmet).

   Five feeds, all public, all CORS-open, no credentials:
     · CDC ILINet outpatient influenza-like illness, via the Delphi Epidata API
     · CDC weekly hospital respiratory reporting (flu / COVID / RSV admissions,
       inpatient and ICU occupancy) from data.cdc.gov
     · openFDA food recall enforcement reports
     · openFDA current drug shortages
     · Open-Meteo air quality (CAMS) US AQI for major metros

   Nothing here is a substitute for a health department notification. These are
   surveillance datasets: they lag by days to weeks, and every panel states its
   own reporting week so the desk can see how stale a number is. */
(function () {
  const DELPHI = "https://api.delphi.cmu.edu/epidata/";
  const CDC = "https://data.cdc.gov/resource/";
  const HOSP_SET = "mpgq-jmmr.json";
  const FDA = "https://api.fda.gov/";
  const AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const STATES_GEO = "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json";

  const INK = "#201e1d", RULE = "rgba(32,30,29,0.4)", MUTED = "#605d5d", HAIR = "#d7d3d3",
        GROUND = "#f3f2f2", SURFACE = "#eae9e9", RED = "#ec3013", DEEPRED = "#ae1800";
  const label = extra => "font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:" + MUTED + ";" + (extra || "");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* A single-hue sequential ramp off the system accent: the map stays mono, and a
     darker cell always means more disease. Six steps, lightest for the lowest
     class, plus a distinct no-data fill that reads as absent, not as zero. */
  const RAMP = ["#efe9e7", "#f6cec5", "#f1a693", "#e97a5d", "#d8482a", "#a81400"];
  const NO_DATA = "#dcd9d8";

  const FIPS = {
    "01": ["AL", "Alabama"], "02": ["AK", "Alaska"], "04": ["AZ", "Arizona"], "05": ["AR", "Arkansas"],
    "06": ["CA", "California"], "08": ["CO", "Colorado"], "09": ["CT", "Connecticut"], "10": ["DE", "Delaware"],
    "11": ["DC", "District of Columbia"], "12": ["FL", "Florida"], "13": ["GA", "Georgia"], "15": ["HI", "Hawaii"],
    "16": ["ID", "Idaho"], "17": ["IL", "Illinois"], "18": ["IN", "Indiana"], "19": ["IA", "Iowa"],
    "20": ["KS", "Kansas"], "21": ["KY", "Kentucky"], "22": ["LA", "Louisiana"], "23": ["ME", "Maine"],
    "24": ["MD", "Maryland"], "25": ["MA", "Massachusetts"], "26": ["MI", "Michigan"], "27": ["MN", "Minnesota"],
    "28": ["MS", "Mississippi"], "29": ["MO", "Missouri"], "30": ["MT", "Montana"], "31": ["NE", "Nebraska"],
    "32": ["NV", "Nevada"], "33": ["NH", "New Hampshire"], "34": ["NJ", "New Jersey"], "35": ["NM", "New Mexico"],
    "36": ["NY", "New York"], "37": ["NC", "North Carolina"], "38": ["ND", "North Dakota"], "39": ["OH", "Ohio"],
    "40": ["OK", "Oklahoma"], "41": ["OR", "Oregon"], "42": ["PA", "Pennsylvania"], "44": ["RI", "Rhode Island"],
    "45": ["SC", "South Carolina"], "46": ["SD", "South Dakota"], "47": ["TN", "Tennessee"], "48": ["TX", "Texas"],
    "49": ["UT", "Utah"], "50": ["VT", "Vermont"], "51": ["VA", "Virginia"], "53": ["WA", "Washington"],
    "54": ["WV", "West Virginia"], "55": ["WI", "Wisconsin"], "56": ["WY", "Wyoming"], "72": ["PR", "Puerto Rico"]
  };
  const POSTAL_FIPS = {};
  Object.keys(FIPS).forEach(f => { POSTAL_FIPS[FIPS[f][0]] = f; });
  const STATE_CODES = Object.keys(FIPS).map(f => FIPS[f][0].toLowerCase());

  const HOME = "MO"; // the desk's own state gets called out everywhere

  /* Census Bureau resident population estimates, vintage 2023. Admission counts
     are meaningless across states without them: an unnormalized ranking is just a
     ranking of California, Texas, Florida and New York. */
  const POP = {
    AL: 5108468, AK: 733406, AZ: 7431344, AR: 3067732, CA: 38965193, CO: 5877610, CT: 3617176,
    DE: 1031890, DC: 678972, FL: 22610726, GA: 11029227, HI: 1435138, ID: 1964726, IL: 12549689,
    IN: 6862199, IA: 3207004, KS: 2940546, KY: 4526154, LA: 4573749, ME: 1395722, MD: 6180253,
    MA: 7001399, MI: 10037261, MN: 5737915, MS: 2939690, MO: 6196156, MT: 1132812, NE: 1978379,
    NV: 3194176, NH: 1402054, NJ: 9290841, NM: 2114371, NY: 19571216, NC: 10835491, ND: 783926,
    OH: 11785935, OK: 4053824, OR: 4233358, PA: 12961683, RI: 1095962, SC: 5373555, SD: 919318,
    TN: 7126489, TX: 30503301, UT: 3417734, VT: 647464, VA: 8715698, WA: 7812880, WV: 1770071,
    WI: 5910955, WY: 584057, PR: 3205691, USA: 334914895
  };

  // The lower-48 envelope. Alaska, Hawaii and Puerto Rico stay reachable by
  // zooming out; framing to include them would shrink the contiguous states.
  const US_BOUNDS = [[25.2, -124.6], [48.9, -67.0]];
  // fitBounds needs a measured container; setView does not. These are the
  // equivalent view for the envelope above, so the initial framing is
  // deterministic even while the tab is hidden.
  const US_CENTER = [37.8, -96.0], US_ZOOM = 4.35;

  const METRICS = [
    { key: "ili", label: "Weighted ILI", short: "ILI %", unit: "%", dec: 2,
      note: "Share of outpatient visits for influenza-like illness · CDC ILINet, by reporting week" },
    { key: "flu", label: "Influenza admissions", short: "Flu adm.", unit: "", dec: 0, rate: true,
      note: "New laboratory-confirmed influenza inpatient admissions in the reporting week" },
    { key: "covid", label: "COVID-19 admissions", short: "COVID adm.", unit: "", dec: 0, rate: true,
      note: "New laboratory-confirmed COVID-19 inpatient admissions in the reporting week" },
    { key: "rsv", label: "RSV admissions", short: "RSV adm.", unit: "", dec: 0, rate: true,
      note: "New laboratory-confirmed RSV inpatient admissions in the reporting week" },
    { key: "occ", label: "Inpatient bed occupancy", short: "Beds occ.", unit: "%", dec: 1,
      note: "Occupied inpatient beds as a share of staffed inpatient beds, weekly average" },
    { key: "icu", label: "ICU bed occupancy", short: "ICU occ.", unit: "%", dec: 1,
      note: "Occupied ICU beds as a share of staffed ICU beds, weekly average" }
  ];

  // EPA's published AQI breakpoints and colors. Color carries the meaning in this
  // one standard, so the official values are used rather than the system ramp.
  const AQI_BANDS = [
    { max: 50, name: "Good", bg: "#00e400", fg: INK },
    { max: 100, name: "Moderate", bg: "#ffff00", fg: INK },
    { max: 150, name: "Unhealthy for sensitive groups", bg: "#ff7e00", fg: INK },
    { max: 200, name: "Unhealthy", bg: "#ff0000", fg: GROUND },
    { max: 300, name: "Very unhealthy", bg: "#8f3f97", fg: GROUND },
    { max: 1e6, name: "Hazardous", bg: "#7e0023", fg: GROUND }
  ];
  const aqiBand = v => AQI_BANDS.find(b => v <= b.max) || AQI_BANDS[AQI_BANDS.length - 1];

  const CDC_MEDIA = "https://tools.cdc.gov/api/v2/resources/media?max=100&sort=";
  const WHO_DON = "https://www.who.int/api/news/diseaseoutbreaknews?$orderby=PublicationDateAndTime%20desc&$top=25&$select=Title,PublicationDateAndTime,ItemDefaultUrl,Summary";

  // Same resolution the rest of the dashboard uses: a saved override beats the
  // default Worker host, so a blocked managed network can be pointed elsewhere.
  const PROXY_STORE = "wuem-proxy-origin";
  const PROXY_DEFAULT = (window.WUEM_CONFIG || {}).workerOrigin || "https://washu-em-ameren.washu-em.workers.dev";
  const proxyOrigin = () => {
    try {
      const raw = (localStorage.getItem(PROXY_STORE) || "").trim();
      if (raw) return new URL(raw).origin;
    } catch (e) { /* fall through to the default */ }
    return PROXY_DEFAULT;
  };

  /* Threat classes for the news feed, mirroring the Worker's own list so an item
     is filed the same whether it arrived direct or through the proxy. Coarse on
     purpose: the desk wants to know what KIND of threat a headline is about, and
     a keyword rule can be audited where a confidence score cannot. */
  const NEWS_CATS = [
    { key: "outbreak", label: "Outbreak", full: "Outbreak & infectious disease",
      re: /\b(outbreak|epidemic|pandemic|cluster of cases|measles|mumps|rubella|pertussis|whooping cough|polio|mpox|monkeypox|ebola|marburg|hantavirus|dengue|malaria|zika|chikungunya|cholera|typhoid|meningitis|meningococcal|hepatitis [ab]|tuberculosis|rabies|anthrax|plague|nipah|lassa|candida auris|carbapenem|drug[- ]resistant|superbug|legionnaire|legionella)\b/i },
    { key: "respiratory", label: "Respiratory", full: "Respiratory illness",
      re: /\b(influenza|\bflu\b|h5n1|h5n5|h7n9|avian influenza|bird flu|covid|sars-cov-2|coronavirus|\brsv\b|respiratory syncytial|pneumonia|mycoplasma|variant|wastewater (levels|surveillance))\b/i },
    { key: "foodborne", label: "Foodborne", full: "Foodborne illness & recalls",
      re: /\b(recall(ed|s)?|salmonella|listeria|e\.? ?coli|botulism|campylobacter|norovirus|cyclospora|foodborne|food safety|contaminat\w+|undeclared allergen)\b/i },
    { key: "water", label: "Water", full: "Water & sanitation",
      re: /\b(boil (water )?(order|advisory)|drinking water|water main|water quality|\bpfas\b|forever chemical|lead in (the )?water|sewage|cryptosporidium|naegleria)\b/i },
    { key: "environment", label: "Environmental", full: "Environmental & heat",
      re: /\b(air quality|wildfire smoke|ozone|pm2\.?5|particulate|heat (wave|advisory|warning|emergency|illness|stroke)|extreme heat|carbon monoxide|asbestos|radon|chemical (spill|release|plume)|hazmat|radiation)\b/i },
    { key: "drugs", label: "Drugs & vaccines", full: "Drugs, vaccines & supply",
      re: /\b(shortage|drug supply|vaccin\w+|immuniz\w+|booster|antiviral|paxlovid|naloxone|narcan|fentanyl|xylazine|overdose|opioid|counterfeit (pill|drug)|adverse event)\b/i },
    { key: "system", label: "Health system", full: "Health system & preparedness",
      re: /\b(public health emergency|state of emergency|emergency declaration|hospital (capacity|diversion|surge|strike)|health department|cdc (warns|advises|issues|reports)|health advisory|\bhan\b advisory|quarantine|isolation order|mass casualty|blood (supply|shortage))\b/i }
  ];
  const NEWS_NOISE = /\b(recipe|diet plan|weight loss|horoscope|celebrity|fashion|box office|super bowl|earnings (call|beat)|best (deals|sunscreen)|editorial board)\b|staff$/i;
  // CDC's media API also indexes its own YouTube playlists, training courses and
  // IT-standards documentation. Those are assets, not health-threat reporting.
  const CDC_ASSET_NOISE = /youtube\.com|\/training\/|\/phin\/|\/staff\/|\/vocabulary\/|\/podcast|soundcloud|\.mp[34]$|playlist_id=/i;
  const classifyNews = text => NEWS_CATS.filter(c => c.re.test(text)).map(c => c.key);
  const catLabel = key => (NEWS_CATS.find(c => c.key === key) || {}).label || key;

  const MIDWEST = /\b(missouri|st\.? louis|kansas city|illinois|midwest|iowa|kansas|arkansas|tennessee|kentucky|indiana)\b/i;
  const NEWS_WINDOWS = [24, 72, 168];

  const relHours = h => h == null ? "—"
    : h < 1 ? Math.max(1, Math.round(h * 60)) + " min ago"
    : h < 48 ? Math.round(h) + " h ago"
    : Math.round(h / 24) + " d ago";

  const METROS = [
    { name: "St. Louis", lat: 38.6482, lon: -90.3056, home: true },
    { name: "Kansas City", lat: 39.0997, lon: -94.5786 },
    { name: "Chicago", lat: 41.8781, lon: -87.6298 },
    { name: "Memphis", lat: 35.1495, lon: -90.049 },
    { name: "Minneapolis", lat: 44.9778, lon: -93.265 },
    { name: "Denver", lat: 39.7392, lon: -104.9903 },
    { name: "Dallas", lat: 32.7767, lon: -96.797 },
    { name: "Phoenix", lat: 33.4484, lon: -112.074 },
    { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
    { name: "Seattle", lat: 47.6062, lon: -122.3321 },
    { name: "Atlanta", lat: 33.749, lon: -84.388 },
    { name: "New York", lat: 40.7128, lon: -74.006 }
  ];

  const RECALL_CLASS = {
    "Class I": { color: RED, note: "reasonable probability of serious health consequences or death" },
    "Class II": { color: "#e0700b", note: "may cause temporary or medically reversible harm" },
    "Class III": { color: MUTED, note: "unlikely to cause adverse health consequences" }
  };

  const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
  const fmtNum = (v, dec) => v == null ? "—" : (dec ? v.toFixed(dec) : Math.round(v).toLocaleString("en-US"));
  const pad2 = n => (n < 10 ? "0" : "") + n;
  const ymd = d => d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  const fmtDate = v => {
    const d = new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  };
  const fmtFdaDate = v => {
    const s = String(v || "");
    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return fmtDate(m[1] + "-" + m[2] + "-" + m[3]);
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return fmtDate(m[3] + "-" + m[1] + "-" + m[2]);
    return s || "—";
  };
  const titleCase = s => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());

  // Epiweeks are YYYYWW. Stepping back naively can land on week 00 or 53; the
  // Epidata range query simply ignores weeks that do not exist, so an approximate
  // start week is safe and keeps this arithmetic short.
  const epiRange = (latest, back) => {
    let y = Math.floor(latest / 100), w = (latest % 100) - back;
    while (w <= 0) { y -= 1; w += 52; }
    return (y * 100 + w) + "-" + latest;
  };
  const epiLabel = ew => {
    const y = Math.floor(ew / 100), w = ew % 100;
    // Week 1 ends on the first Saturday of the year with at least 4 days in it.
    const jan4 = Date.UTC(y, 0, 4);
    const dow = new Date(jan4).getUTCDay();
    const week1End = jan4 + (6 - dow) * 86400000;
    return fmtDate(new Date(week1End + (w - 1) * 604800000).toISOString());
  };

  /* ---------- tiny chart builders --------------------------------------- */

  const sparkline = (vals, w, h, color) => {
    const v = vals.filter(x => x != null);
    if (v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * w, h - ((x - lo) / span) * (h - 2) - 1]);
    const d = pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const last = pts[pts.length - 1];
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" style="display:block;overflow:visible;">'
      + '<polyline points="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5"></polyline>'
      + '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.2" fill="' + color + '"></circle></svg>';
  };

  // A ruled area chart: gridlines, area under the curve, latest value called out.
  const areaChart = (series, opts) => {
    const o = opts || {};
    const w = o.w || 520, h = o.h || 132, pad = 30, base = h - 18, top = 8;
    const v = series.map(s => s.v).filter(x => x != null);
    if (v.length < 2) return '<div style="' + label() + '">Not enough reported weeks to chart.</div>';
    const hi = Math.max(...v), lo = Math.min(0, Math.min(...v)), span = (hi - lo) || 1;
    const x = i => pad + (i / (series.length - 1)) * (w - pad - 8);
    const y = val => base - ((val - lo) / span) * (base - top);
    const pts = series.map((s, i) => [x(i), y(s.v == null ? lo : s.v)]);
    const line = pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const area = pad + "," + base + " " + line + " " + (w - 8) + "," + base;
    const color = o.color || INK;
    const ticks = [0, Math.floor(series.length / 2), series.length - 1];
    const fmtV = val => o.dec ? val.toFixed(o.dec) : Math.round(val).toLocaleString("en-US");
    // Peak of the plotted window: the number an analyst reaches for next.
    let pi = 0;
    series.forEach((s, i) => { if (s.v != null && s.v >= (series[pi].v == null ? -1 : series[pi].v)) pi = i; });
    const peak = series[pi];
    return '<svg width="100%" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="display:block;">'
      + [0.5, 1].map(f => '<line x1="' + pad + '" x2="' + (w - 8) + '" y1="' + y(lo + span * f).toFixed(1) + '" y2="' + y(lo + span * f).toFixed(1)
          + '" stroke="' + INK + '" stroke-opacity="0.12" stroke-width="1"></line>').join("")
      + '<polygon points="' + area + '" fill="' + color + '" opacity="0.13"></polygon>'
      + '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="2"></polyline>'
      + (o.baseline != null && o.baseline <= hi
          ? '<line x1="' + pad + '" x2="' + (w - 8) + '" y1="' + y(o.baseline).toFixed(1) + '" y2="' + y(o.baseline).toFixed(1)
            + '" stroke="' + RED + '" stroke-width="1.5" stroke-dasharray="6,4"></line>'
            + '<text x="' + (pad + 4) + '" y="' + (y(o.baseline) - 5).toFixed(1) + '" font-family="Archivo,system-ui,sans-serif" font-size="9" font-weight="800" letter-spacing="1" fill="' + RED + '">NATIONAL BASELINE ' + o.baseline + '%</text>'
          : "")
      + '<line x1="' + pad + '" x2="' + (w - 8) + '" y1="' + base + '" y2="' + base + '" stroke="' + INK + '" stroke-width="1.5"></line>'
      + (o.markPeak && pi !== series.length - 1
          ? '<line x1="' + x(pi).toFixed(1) + '" x2="' + x(pi).toFixed(1) + '" y1="' + y(peak.v).toFixed(1) + '" y2="' + base
            + '" stroke="' + INK + '" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="2,3"></line>'
            + '<circle cx="' + x(pi).toFixed(1) + '" cy="' + y(peak.v).toFixed(1) + '" r="2.4" fill="none" stroke="' + INK + '" stroke-width="1.5"></circle>'
          : "")
      + '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" r="3" fill="' + color + '"></circle>'
      + '<text x="2" y="12" font-family="Archivo,system-ui,sans-serif" font-size="9" font-weight="800" fill="' + MUTED + '">' + fmtV(hi) + "</text>"
      + '<text x="2" y="' + (y(lo + span * 0.5) + 3).toFixed(1) + '" font-family="Archivo,system-ui,sans-serif" font-size="9" font-weight="700" fill="' + MUTED + '" opacity="0.75">' + fmtV(lo + span * 0.5) + "</text>"
      + ticks.map(i => '<text x="' + x(i).toFixed(1) + '" y="' + (h - 5) + '" text-anchor="' + (i === 0 ? "start" : i === series.length - 1 ? "end" : "middle")
          + '" font-family="Archivo,system-ui,sans-serif" font-size="9" font-weight="700" fill="' + MUTED + '">' + esc(series[i].t) + "</text>").join("")
      + "</svg>";
  };

  const TEMPLATE = `
    <div style="display:flex;align-items:center;gap:14px;padding:10px 32px;background:${INK};color:${GROUND};border-bottom:2px solid ${INK};">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;padding:4px 8px;background:${GROUND};color:${INK};">Live Public Health Feeds</span>
      <span style="font-size:12px;font-weight:600;">Surveillance data, not notification. CDC outpatient and hospital reporting run a week or more behind; openFDA recalls and shortages update daily. Every panel states its own reporting week.</span>
    </div>

    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:22px 32px 18px;border-bottom:2px solid ${RULE};">
      <div>
        <div style="${label("margin-bottom:6px;")}">National Public Health Picture</div>
        <div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:30px;line-height:1.05;letter-spacing:-0.025em;">Health Watch</div>
        <div data-status style="font-size:12px;color:${MUTED};margin-top:7px;max-width:920px;line-height:1.5;">Querying CDC ILINet, CDC hospital respiratory reporting, openFDA and air quality&hellip;</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
        <div data-updated style="${label()}"></div>
        <button data-refresh style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:8px 13px;border:2px solid ${INK};background:transparent;color:${INK};cursor:pointer;">Refresh feeds</button>
      </div>
    </div>

    <div data-kpis style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-bottom:2px solid ${RULE};"></div>

    <div style="padding:18px 32px;border-bottom:2px solid ${RULE};background:${SURFACE};">
      <div style="${label("margin-bottom:6px;")}">Situation note &middot; composed from the live feeds</div>
      <div data-note style="font-size:14px;font-weight:600;line-height:1.55;max-width:1180px;text-wrap:pretty;">Reading the feeds&hellip;</div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(0,1fr) 400px;align-items:start;border-bottom:2px solid ${RULE};">
      <div style="border-right:2px solid ${RULE};">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px 14px 32px;border-bottom:2px solid ${RULE};">
          <div style="${label()}">State choropleth &middot; pick a measure</div>
          <div style="display:flex;align-items:center;gap:14px;">
            <div data-scale-seg style="display:flex;border:2px solid ${RULE};">
              <button data-scale="count" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;background:${INK};color:${GROUND};cursor:pointer;">Counts</button>
              <button data-scale="rate" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;border-left:2px solid ${RULE};background:transparent;color:${INK};cursor:pointer;">Per 100k</button>
            </div>
            <div data-metric-week style="${label()}"></div>
          </div>
        </div>
        <div data-metrics style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:2px solid ${RULE};"></div>
        <div data-map-shell style="position:relative;">
          <div data-map style="height:560px;background:${GROUND};"></div>
          <button data-fullscreen style="position:absolute;top:16px;left:58px;z-index:1001;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${INK};background:${GROUND};color:${INK};cursor:pointer;">&#10529; Full screen</button>
          <div data-legend style="position:absolute;bottom:16px;left:16px;z-index:1001;background:${GROUND};border:2px solid ${INK};padding:10px 12px;"></div>
        </div>
      </div>

      <aside>
        <div data-detail style="padding:20px 32px 20px 20px;border-bottom:2px solid ${RULE};min-height:180px;">
          <div style="${label()}">Click a state for its full reporting row</div>
        </div>
        <div style="padding:20px 32px 20px 20px;">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px;">
            <div style="${label()}">Highest reporting states</div>
            <div data-rank-metric style="${label()}"></div>
          </div>
          <div data-ranks style="display:flex;flex-direction:column;"></div>
        </div>
      </aside>
    </div>

    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-bottom:2px solid ${RULE};">
      <div style="border-right:2px solid ${RULE};padding:20px 24px 24px 32px;">
        <div style="${label("margin-bottom:4px;")}">Outpatient influenza-like illness &middot; national</div>
        <div style="font-size:11px;color:${MUTED};margin-bottom:12px;">CDC ILINet weighted percentage of visits, last 52 reporting weeks, against the national baseline</div>
        <div data-ili-chart></div>
      </div>
      <div style="padding:20px 32px 24px 24px;">
        <div style="${label("margin-bottom:4px;")}">Respiratory inpatient admissions &middot; national</div>
        <div style="font-size:11px;color:${MUTED};margin-bottom:12px;">New confirmed admissions per week, CDC hospital respiratory reporting</div>
        <div data-resp-charts style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;"></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-bottom:2px solid ${RULE};">
      <div style="border-right:2px solid ${RULE};padding:20px 24px 24px 32px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px;">
          <div style="${label()}">Food recall enforcement &middot; openFDA</div>
          <div data-recall-filters style="display:flex;border:2px solid ${RULE};"></div>
        </div>
        <div data-recall-note style="font-size:11px;color:${MUTED};margin-bottom:12px;">Reading the enforcement report feed&hellip;</div>
        <div data-recalls style="display:flex;flex-direction:column;max-height:520px;overflow-y:auto;padding-right:6px;"></div>
      </div>
      <div style="padding:20px 32px 24px 24px;">
        <div style="${label("margin-bottom:4px;")}">Current drug shortages &middot; openFDA</div>
        <div data-shortage-note style="font-size:11px;color:${MUTED};margin-bottom:12px;">Reading the shortage feed&hellip;</div>
        <div data-shortages style="display:flex;flex-direction:column;max-height:520px;overflow-y:auto;padding-right:6px;"></div>
      </div>
    </div>

    <div style="border-bottom:2px solid ${RULE};">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:20px 32px 16px;">
        <div>
          <div style="${label("margin-bottom:4px;")}">Public health in the news</div>
          <div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:20px;line-height:1.1;letter-spacing:-0.02em;">National media &amp; official postings</div>
          <div data-news-note style="font-size:11px;color:${MUTED};margin-top:6px;max-width:820px;line-height:1.5;">Reading CDC postings, WHO Disease Outbreak News and the national outlet feeds&hellip;</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
          <div data-news-window-seg style="display:flex;border:2px solid ${RULE};">
            ${NEWS_WINDOWS.map((h, i) => '<button data-news-window="' + h + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;' + (i ? "border-left:2px solid " + RULE + ";" : "") + "background:" + (h === 24 ? INK : "transparent") + ";color:" + (h === 24 ? GROUND : INK) + ';cursor:pointer;">' + (h < 48 ? h + " H" : h / 24 + " D") + "</button>").join("")}
          </div>
          <div data-news-counts style="${label()}"></div>
        </div>
      </div>
      <div data-news-cats style="display:flex;flex-wrap:wrap;gap:0;border-top:2px solid ${RULE};border-bottom:2px solid ${RULE};"></div>
      <div data-news style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));"></div>
    </div>

    <div data-hw-modal style="display:none;position:fixed;inset:0;z-index:5200;background:rgba(32,30,29,0.6);align-items:center;justify-content:center;padding:24px;">
      <div style="background:${GROUND};border:2px solid ${INK};width:min(620px,100%);max-height:88vh;overflow-y:auto;">
        <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:2px solid ${INK};background:${SURFACE};">
          <div>
            <div data-hw-modal-kicker style="${label()}"></div>
            <div data-hw-modal-title style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:19px;line-height:1.18;letter-spacing:-0.01em;margin-top:4px;"></div>
          </div>
          <button data-hw-modal-close style="background:none;border:none;padding:0;font-size:18px;line-height:1;color:${MUTED};cursor:pointer;">&#10005;</button>
        </div>
        <div data-hw-modal-body style="padding:18px 20px 22px;font-size:12px;line-height:1.55;"></div>
      </div>
    </div>

    <div style="padding:20px 32px 26px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px;">
        <div style="${label()}">Air quality &middot; US AQI by metro</div>
        <div data-aqi-note style="${label()}"></div>
      </div>
      <div style="font-size:11px;color:${MUTED};margin-bottom:14px;">Open-Meteo air-quality model (Copernicus CAMS). EPA AQI bands and colors.</div>
      <div data-aqi style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:2px solid ${RULE};border-left:2px solid ${RULE};"></div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px;font-size:11px;font-weight:600;align-items:center;">
        ${AQI_BANDS.map(b => '<span style="display:flex;align-items:center;gap:6px;"><span style="width:14px;height:10px;background:' + b.bg + ';border:1px solid ' + INK + ';box-sizing:border-box;"></span>' + b.name + " (&le;" + (b.max > 1000 ? "300+" : b.max) + ")</span>").join("")}
      </div>
      <div style="font-size:11px;color:${MUTED};margin-top:18px;line-height:1.6;max-width:1180px;">Sources: CDC ILINet via the Delphi Epidata API (Carnegie Mellon) &middot; CDC weekly hospital respiratory reporting, data.cdc.gov <b>mpgq-jmmr</b> &middot; openFDA food enforcement reports and drug shortage database &middot; Open-Meteo air quality (CAMS) &middot; CDC media postings API and WHO Disease Outbreak News, both read directly &middot; national public health outlet RSS through the dashboard Worker &middot; state polygons from the public MappingAPI GeoJSON. Alaska, Hawaii and Puerto Rico are on the map &mdash; zoom out to reach them. Hospital rows for HHS regions and the nation are excluded from the state map and rankings.</div>
    </div>
  `;

  class HealthWatch extends HTMLElement {
    connectedCallback() {
      if (this._booted) return this.resume();
      this._booted = true;
      this.metric = "ili";
      this.scale = "count";
      this.newsHours = 24;
      this.newsCat = null;
      this.newsFailures = [];
      this.recallClass = "Class I";
      this.stateTrendCache = {};
      this.innerHTML = TEMPLATE;
      this.boot();
    }

    q(sel) { return this.querySelector(sel); }

    boot() {
      this.renderMetricSwitch();
      this.initMap();
      this.q("[data-refresh]").onclick = () => this.load();
      this.q("[data-metrics]").addEventListener("click", e => {
        const b = e.target.closest("[data-metric]");
        if (b) this.setMetric(b.getAttribute("data-metric"));
      });
      this.q("[data-scale-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-scale]");
        if (b) this.setScale(b.getAttribute("data-scale"));
      });
      this.q("[data-recall-filters]").addEventListener("click", e => {
        const b = e.target.closest("[data-recall-class]");
        if (!b) return;
        this.recallClass = b.getAttribute("data-recall-class");
        this.renderRecallFilters();
        this.renderRecalls();
      });
      this.q("[data-ranks]").addEventListener("click", e => {
        const r = e.target.closest("[data-rank-fips]");
        if (r) this.selectState(r.getAttribute("data-rank-fips"), true);
      });
      this.q("[data-fullscreen]").onclick = () => this.toggleFullscreen();
      this.q("[data-recalls]").addEventListener("click", e => {
        const r = e.target.closest("[data-recall-idx]");
        if (r) this.showRecall(Number(r.getAttribute("data-recall-idx")));
      });
      this.q("[data-shortages]").addEventListener("click", e => {
        const r = e.target.closest("[data-short-idx]");
        if (r) this.showShortage(Number(r.getAttribute("data-short-idx")));
      });
      this.q("[data-news-window-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-news-window]");
        if (b) this.setNewsWindow(Number(b.getAttribute("data-news-window")));
      });
      this.q("[data-news-cats]").addEventListener("click", e => {
        const b = e.target.closest("[data-news-cat]");
        if (!b) return;
        this.newsCat = b.getAttribute("data-news-cat") || null;
        this.renderNewsCats();
        this.renderNews();
      });
      this.q("[data-news" + "]").addEventListener("click", e => {
        const r = e.target.closest("[data-news-idx]");
        if (r) this.showNews(Number(r.getAttribute("data-news-idx")));
      });
      const hwModal = this.q("[data-hw-modal]");
      this.q("[data-hw-modal-close]").onclick = () => this.closeModal();
      hwModal.addEventListener("click", e => { if (e.target === hwModal) this.closeModal(); });
      document.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        if (this.q("[data-hw-modal]").style.display === "flex") return this.closeModal();
        if (this.q("[data-map-shell]").getAttribute("data-expanded") === "1") this.toggleFullscreen();
      });
      this.renderRecallFilters();

      // The tab is hidden at first paint, so the map measures zero until shown.
      this.fitUs();

      // Staggered so six views do not fire every feed at once on mount.

      this._bootT = setTimeout(() => this.load(), 2600);

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
      if (this.map) this.fitUs();
      this.startTimers();
    }

    startTimers() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.load(), 900000);
      // Housekeeping: keeps re-arming the size watchdog until the map measures,
      // so recovery never waits on the feed refresh cadence.
      clearInterval(this._hkTimer);
      this._hkTimer = setInterval(() => {
        if (this._fitted) { clearInterval(this._hkTimer); this._hkTimer = null; return; }
        this.fitUs();
      }, 2000);
    }

    status(msg) { this.q("[data-status]").innerHTML = msg; }

    /* ---------- map ------------------------------------------------------ */

    initMap() {
      // No basemap tiles: the states carry all the ink, drawn on the system ground.
      const map = L.map(this.q("[data-map]"), {
        // zoomSnap 0 lets fitBounds land on a fractional zoom, so the lower-48 fills
        // the frame exactly instead of rounding down to the next snap step.
        zoomSnap: 0, attributionControl: false, minZoom: 2, maxZoom: 8
      });
      this.map = map;
      // Deterministic initial view: works on a 0x0 container, unlike fitBounds.
      map.setView(US_CENTER, US_ZOOM);
      this.fitUs();
      this.statesLayer = L.geoJSON(null, {
        style: f => this.styleState(f),
        onEachFeature: (f, layer) => {
          layer.on("mouseover", () => layer.setStyle({ weight: 3, color: INK }));
          layer.on("mouseout", () => this.statesLayer.resetStyle(layer));
          layer.on("click", () => this.selectState(f.id, false));
          layer.bindTooltip(() => this.tooltipFor(f.id), { sticky: true });
        }
      }).addTo(map);
      map.on("zoomstart dragstart", () => { if (this._fitted) this._userMoved = true; });
      fetch(STATES_GEO).then(r => r.json()).then(gj => {
        this.geo = gj;
        this.statesLayer.addData(gj);
        this.paintMap();
        this.fitUs();
      }).catch(() => { this.status("State polygons could not be loaded; the map is unavailable. Every other panel is unaffected."); });
    }

    /* Built while the tab is hidden, the map measures 0x0 and the fit lands at the
       world view. A geometry observer is the wrong tool: a ResizeObserver on the
       container would see its own invalidateSize() as a resize and loop. This
       watcher only READS clientWidth, never expires while the tab sits unopened,
       and cancels itself for good once a fit succeeds. */
    /* The interval owns its own lifecycle: armed at most once, cleared only by
       its own success branch. Clearing it here and returning early on a
       synchronous success destroyed the watchdog without reassigning it, which
       left the map unmeasured whenever the tab was opened later. */
    fitUs(force) {
      if (this._userMoved && !force) return;
      if (force && this.map) this.map.setView(US_CENTER, US_ZOOM, { animate: false });
      if (this.tryFitUs()) return;
      // setInterval, not rAF: rAF is suspended in this hidden document.
      clearInterval(this._fitTimer);
      this._fitTimer = setInterval(() => {
        if (this.tryFitUs()) { clearInterval(this._fitTimer); this._fitTimer = null; }
      }, 300);
    }

    /* The view is already set from setView, so this only has to tell Leaflet the
       container gained size, which makes it draw. Reads clientWidth only. */
    tryFitUs() {
      const el = this.q("[data-map]");
      if (!this.map || !el || !el.clientWidth) return false;
      this.map.invalidateSize();
      if (this.map.getSize().x === 0) return false;
      this._fitted = true;
      return true;
    }

    toggleFullscreen() {
      const shell = this.q("[data-map-shell]"), btn = this.q("[data-fullscreen]"), mapEl = this.q("[data-map]");
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
      setTimeout(() => { this.map.invalidateSize(); this.map.fitBounds(US_BOUNDS, { padding: [16, 16], animate: false }); this._fitted = true; }, 60);
    }

    metricDef() { return METRICS.find(m => m.key === this.metric) || METRICS[0]; }

    // Admission counts are per-population when the rate scale is on; percentages
    // and ILI shares are already normalized and ignore the switch.
    rateOn() { return this.scale === "rate" && (this.metricDef() || {}).rate; }

    valueFor(fips, key, opts) {
      const o = opts || {};
      const postal = (FIPS[fips] || [])[0];
      if (!postal) return null;
      if (key === "ili") return (this.iliStates || {})[postal.toLowerCase()];
      const source = o.prior ? (this.hospPrior || {}) : (this.hospStates || {});
      const row = source[postal];
      if (!row) return null;
      const raw = this.valueForRow(row, key);
      if (raw == null) return null;
      const def = METRICS.find(m => m.key === key) || {};
      if (this.scale === "rate" && def.rate && POP[postal]) return (raw / POP[postal]) * 100000;
      return raw;
    }

    // Unit and precision both change with the scale: a per-100k admission rate
    // needs two decimals where a raw count needs none.
    unitFor(key) {
      const m = METRICS.find(x => x.key === key) || {};
      if (this.scale === "rate" && m.rate) return { unit: " / 100k", dec: 2 };
      return { unit: m.unit, dec: m.dec };
    }

    fmtMetric(v, key) {
      const u = this.unitFor(key || this.metric);
      return v == null ? "—" : fmtNum(v, u.dec) + u.unit;
    }

    setScale(scale) {
      this.scale = scale;
      this.querySelectorAll("[data-scale]").forEach(b => {
        const on = b.getAttribute("data-scale") === scale;
        b.style.background = on ? INK : "transparent";
        b.style.color = on ? GROUND : INK;
      });
      this.renderMetricSwitch();
      this.paintMap();
    }

    // Class breaks come from the data itself: quintiles of the reporting states, so
    // an off-season week still separates the states that are carrying disease.
    breaks() {
      const vals = Object.keys(FIPS).map(f => this.valueFor(f, this.metric)).filter(v => v != null).sort((a, b) => a - b);
      if (vals.length < 5) return null;
      const at = p => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
      return [at(0.2), at(0.4), at(0.6), at(0.8), at(0.95)];
    }

    classOf(v) {
      const b = this._breaks;
      if (v == null || !b) return -1;
      for (let i = 0; i < b.length; i++) if (v <= b[i]) return i;
      return RAMP.length - 1;
    }

    styleState(f) {
      const v = this.valueFor(f.id, this.metric);
      const ci = this.classOf(v);
      const home = (FIPS[f.id] || [])[0] === HOME;
      const sel = this.selected === f.id;
      return {
        fillColor: ci < 0 ? NO_DATA : RAMP[ci],
        fillOpacity: ci < 0 ? 0.5 : 0.92,
        color: sel ? RED : home ? INK : "rgba(32,30,29,0.55)",
        weight: sel ? 3.5 : home ? 2.5 : 0.8,
        dashArray: ci < 0 ? "3,4" : null
      };
    }

    paintMap() {
      if (!this.statesLayer) return;
      this._breaks = this.breaks();
      this.statesLayer.setStyle(f => this.styleState(f));
      this.renderLegend();
      this.renderRanks();
      if (this.selected) this.renderDetail(this.selected);
    }

    tooltipFor(fips) {
      const info = FIPS[fips];
      if (!info) return "";
      const m = this.metricDef();
      const v = this.valueFor(fips, m.key);
      const d = this.deltaFor(fips, m.key);
      const rank = this.rankOf(fips);
      return '<b style="font-family:Archivo,system-ui,sans-serif;">' + esc(info[1]) + "</b><br>"
        + esc(m.label) + ": " + (v == null ? "not reported" : this.fmtMetric(v, m.key))
        + (rank ? "<br>" + rank.pos + " of " + rank.total + " reporting states" : "")
        + (d ? "<br>" + d.text + " on the prior week" : "");
    }

    rankOf(fips) {
      const rows = this.rankRows();
      const i = rows.findIndex(r => r.f === fips);
      return i < 0 ? null : { pos: "#" + (i + 1), total: rows.length };
    }

    // Week-over-week change per state, from the prior hospital reporting week.
    deltaFor(fips, key) {
      if (key === "ili") return null;
      const now = this.valueFor(fips, key), prev = this.valueFor(fips, key, { prior: true });
      if (now == null || prev == null || !prev) return null;
      const pct = ((now - prev) / prev) * 100;
      return {
        pct: pct,
        text: (pct > 0.5 ? "\u25b2 " : pct < -0.5 ? "\u25bc " : "\u2014 ") + Math.abs(pct).toFixed(0) + "%",
        tone: pct > 15 ? DEEPRED : pct < -15 ? MUTED : MUTED
      };
    }

    renderMetricSwitch() {
      this.q("[data-metrics]").innerHTML = METRICS.map((m, i) => {
        const on = m.key === this.metric;
        return '<button data-metric="' + m.key + '" style="text-align:left;padding:11px 14px;border:none;border-right:'
          + (i % 3 === 2 ? "none" : "2px solid " + RULE) + ";border-bottom:" + (i < 3 ? "2px solid " + RULE : "none")
          + ";background:" + (on ? INK : "transparent") + ";color:" + (on ? GROUND : INK)
          + ';cursor:pointer;font-family:Archivo,system-ui,sans-serif;">'
          + '<div style="font-size:12px;font-weight:800;letter-spacing:-0.01em;">' + esc(m.label) + "</div>"
          + '<div data-metric-val style="font-size:11px;font-weight:600;opacity:0.72;margin-top:3px;font-variant-numeric:tabular-nums;">'
          + esc(this.nationalFor(m.key)) + "</div></button>";
      }).join("");
    }

    nationalFor(key) {
      if (key === "ili") {
        const n = (this.iliNat || []).slice(-1)[0];
        return n && n.v != null ? "US " + n.v.toFixed(2) + "% of visits" : "—";
      }
      const row = (this.hospStates || {}).USA || this.hospUsaLatest;
      if (!row) return "—";
      const raw = this.valueForRow(row, key);
      if (raw == null) return "—";
      const def = METRICS.find(x => x.key === key) || {};
      const v = this.scale === "rate" && def.rate ? (raw / POP.USA) * 100000 : raw;
      return "US " + this.fmtMetric(v, key);
    }

    valueForRow(row, key) {
      if (key === "flu") return num(row.totalconfflunewadm);
      if (key === "covid") return num(row.totalconfc19newadm);
      if (key === "rsv") return num(row.totalconfrsvnewadm);
      if (key === "occ") { const a = num(row.numinptbedsocc), b = num(row.numinptbeds); return a != null && b ? (a / b) * 100 : null; }
      if (key === "icu") { const a = num(row.numicubedsocc), b = num(row.numicubeds); return a != null && b ? (a / b) * 100 : null; }
      return null;
    }

    setMetric(key) {
      this.metric = key;
      this.renderMetricSwitch();
      const rateable = (this.metricDef() || {}).rate;
      this.q("[data-scale-seg]").style.opacity = rateable ? "1" : "0.35";
      this.q("[data-scale-seg]").title = rateable ? "" : "This measure is already a percentage";
      this.q("[data-metric-week]").textContent = key === "ili"
        ? (this.iliWeekLabel ? "ILINet week ending " + this.iliWeekLabel : "")
        : (this.hospWeek ? "Hospital week ending " + fmtDate(this.hospWeek) : "");
      this.paintMap();
    }

    renderLegend() {
      const m = this.metricDef(), b = this._breaks;
      const u = this.unitFor(m.key);
      const box = this.q("[data-legend]");
      if (!b) {
        const refused = m.key === "ili" && this.iliError;
        box.innerHTML = '<div style="' + label() + '">' + esc(m.label) + " &middot; "
          + esc(refused ? this.iliError.short : "awaiting data") + "</div>"
          + (refused ? '<div style="font-size:10px;font-weight:600;color:' + DEEPRED + ';margin-top:5px;max-width:250px;line-height:1.5;">Feed refused the request — not an empty week.</div>' : "");
        return;
      }
      const edges = [null].concat(b);
      // Count the states in each class, so the ramp doubles as a distribution.
      const counts = RAMP.map(() => 0);
      Object.keys(FIPS).forEach(f => { const c = this.classOf(this.valueFor(f, m.key)); if (c >= 0) counts[c]++; });
      const maxCount = Math.max(1, ...counts);
      box.innerHTML = '<div style="' + label("margin-bottom:7px;") + '">' + esc(m.label) + (u.unit ? " (" + u.unit.trim() + ")" : "") + "</div>"
        + '<div style="display:flex;align-items:flex-end;gap:0;">'
        + RAMP.map((c, i) => {
          const lo = i === 0 ? null : edges[i];
          return '<div style="width:46px;">'
            + '<div style="height:22px;display:flex;align-items:flex-end;">'
            + '<div title="' + counts[i] + ' states" style="width:100%;height:' + Math.max(2, (counts[i] / maxCount) * 22).toFixed(1) + "px;background:" + INK + ';opacity:' + (counts[i] ? 0.45 : 0.12) + ';"></div></div>'
            + '<div style="font-size:8px;font-weight:800;color:' + MUTED + ';margin-bottom:2px;font-variant-numeric:tabular-nums;">' + (counts[i] || "") + "</div>"
            + '<div style="height:13px;background:' + c + ';border:1px solid ' + INK + ';border-right:' + (i === RAMP.length - 1 ? "1px" : "0") + ' solid ' + INK + ';box-sizing:border-box;"></div>'
            + '<div style="font-size:9px;font-weight:700;color:' + MUTED + ';margin-top:3px;font-variant-numeric:tabular-nums;">'
            + (lo == null ? "low" : fmtNum(lo, u.dec)) + "</div></div>";
        }).join("")
        + "</div>"
        + '<div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:10px;font-weight:700;color:' + MUTED + ';">'
        + '<span style="width:14px;height:10px;background:' + NO_DATA + ';border:1px dashed ' + INK + ';box-sizing:border-box;"></span>Not reported'
        + '<span style="width:14px;height:10px;background:transparent;border:2px solid ' + INK + ';box-sizing:border-box;margin-left:8px;"></span>Missouri</div>'
        + '<div style="' + label("margin-top:7px;max-width:290px;line-height:1.5;letter-spacing:0.1em;") + '">Class breaks are quintiles of the reporting states &middot; bars above the ramp are how many states fall in each class</div>';
    }

    rankRows() {
      const m = this.metricDef();
      return Object.keys(FIPS).map(f => ({ f: f, name: FIPS[f][1], postal: FIPS[f][0], v: this.valueFor(f, m.key) }))
        .filter(r => r.v != null).sort((a, b) => b.v - a.v);
    }

    renderRanks() {
      const m = this.metricDef();
      this.q("[data-rank-metric]").textContent = m.label + (this.rateOn() ? " · per 100k" : "");
      const rows = this.rankRows();
      if (!rows.length) {
        // A refused feed and an empty reporting week must not read the same.
        const refused = m.key === "ili" && this.iliError;
        this.q("[data-ranks]").innerHTML = '<div style="font-size:12px;line-height:1.55;color:' + (refused ? DEEPRED : MUTED) + ';">'
          + esc(refused ? this.iliError.panel : "No state rows in this reporting week.") + "</div>";
        return;
      }
      const top = rows.slice(0, 10);
      const mo = rows.find(r => r.postal === HOME);
      const moRank = mo ? rows.indexOf(mo) + 1 : null;
      const max = top[0].v || 1;
      const row = (r, rank) => {
        const home = r.postal === HOME;
        const d = this.deltaFor(r.f, m.key);
        return '<div data-rank-fips="' + r.f + '" style="display:grid;grid-template-columns:22px 1fr 78px;gap:9px;align-items:center;padding:8px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;'
          + (home ? "background:" + SURFACE + ";" : "") + '">'
          + '<span style="' + label() + 'font-variant-numeric:tabular-nums;">' + rank + "</span>"
          + '<span style="min-width:0;"><span style="font-size:12px;font-weight:' + (home ? 800 : 600) + ';display:block;">' + esc(r.name) + "</span>"
          + '<span style="display:block;height:5px;margin-top:4px;background:' + RAMP[Math.max(0, this.classOf(r.v))] + ';width:' + Math.max(3, (r.v / max) * 100).toFixed(1) + '%;"></span></span>'
          + '<span style="text-align:right;"><span style="font-size:13px;font-weight:800;display:block;font-variant-numeric:tabular-nums;">' + this.fmtMetric(r.v, m.key) + "</span>"
          + (d ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.06em;color:' + d.tone + ';display:block;margin-top:2px;">' + d.text + " wk</span>" : "")
          + "</span></div>";
      };
      this.q("[data-ranks]").innerHTML = top.map((r, i) => row(r, i + 1)).join("")
        + (mo && moRank > 10 ? '<div style="' + label("margin:10px 0 4px;") + '">Missouri, for reference</div>' + row(mo, moRank) : "")
        + '<div style="' + label("margin-top:10px;") + '">' + rows.length + " reporting states &middot; click a row to select it on the map</div>";
    }

    selectState(fips, fly) {
      this.selected = fips;
      this.statesLayer.setStyle(f => this.styleState(f));
      this.renderDetail(fips);
      if (fly && this.geo) {
        const f = this.geo.features.find(x => x.id === fips);
        if (f) this.map.fitBounds(L.geoJSON(f).getBounds(), { maxZoom: 6, padding: [24, 24] });
      }
      this.loadStateTrend(fips);
    }

    renderDetail(fips) {
      const info = FIPS[fips];
      const box = this.q("[data-detail]");
      if (!info) { box.innerHTML = '<div style="' + label() + '">Click a state for its full reporting row</div>'; return; }
      const row = (m) => {
        const v = this.valueFor(fips, m.key);
        const d = this.deltaFor(fips, m.key);
        const natRow = (this.hospStates || {}).USA;
        let vsNat = "";
        if (m.key === "ili") {
          const nat = (this.iliNat || []).slice(-1)[0];
          if (v != null && nat) vsNat = (v > nat.v ? "above" : "below") + " US " + nat.v.toFixed(2) + "%";
        } else if (natRow && v != null) {
          const raw = this.valueForRow(natRow, m.key);
          if (raw != null) {
            const natV = this.scale === "rate" && m.rate ? (raw / POP.USA) * 100000 : raw;
            // Counts against the national total read as a share; rates compare directly.
            vsNat = this.rateOn() || !m.rate
              ? (v > natV ? "above" : "below") + " US " + this.fmtMetric(natV, m.key)
              : ((v / natV) * 100).toFixed(1) + "% of the US total";
          }
        }
        return '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid ' + HAIR + ';">'
          + '<span style="min-width:0;"><span style="font-size:12px;font-weight:600;display:block;">' + esc(m.label) + "</span>"
          + (vsNat ? '<span style="' + label("margin-top:2px;display:block;") + '">' + esc(vsNat) + "</span>" : "") + "</span>"
          + '<span style="text-align:right;"><span style="font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;display:block;color:' + (v == null ? MUTED : INK) + ';">'
          + (v == null ? "not reported" : this.fmtMetric(v, m.key)) + "</span>"
          + (d ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.06em;color:' + d.tone + ';display:block;margin-top:2px;">' + d.text + " wk/wk</span>" : "")
          + "</span></div>";
      };
      const trend = this.stateTrendCache[fips];
      box.innerHTML = '<div style="' + label("margin-bottom:4px;") + '">Selected state</div>'
        + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:22px;line-height:1.1;letter-spacing:-0.02em;margin-bottom:12px;">' + esc(info[1])
        + (info[0] === HOME ? ' <span style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:' + DEEPRED + ';">home state</span>' : "") + "</div>"
        + METRICS.map(row).join("")
        + '<div style="' + label("margin:14px 0 6px;") + '">ILINet, last 52 weeks &middot; ring marks the window peak</div>'
        + (trend === undefined ? '<div style="font-size:11px;color:' + MUTED + ';">Loading the state series&hellip;</div>'
            : trend && trend.length > 2 ? areaChart(trend, { w: 340, h: 96, color: INK, dec: 2, markPeak: true })
            + this.trendFooter(trend)
            : '<div style="font-size:11px;color:' + (this.iliError ? DEEPRED : MUTED) + ';line-height:1.5;">'
              + esc(this.iliError ? this.iliError.short + " — the state series could not be requested." : "This state does not report to ILINet, or has no weeks in range.") + "</div>");
    }

    // Where the current week sits inside its own 52-week distribution — the number
    // that separates “low but climbing” from “near the seasonal ceiling”.
    trendFooter(trend) {
      const vals = trend.map(x => x.v).filter(x => x != null);
      if (vals.length < 5) return "";
      const now = vals[vals.length - 1];
      const sorted = vals.slice().sort((a, b) => a - b);
      const pctile = Math.round((sorted.filter(x => x <= now).length / sorted.length) * 100);
      const peak = Math.max(...vals);
      return '<div style="font-size:11px;color:' + MUTED + ';margin-top:7px;line-height:1.5;">Latest week is at the '
        + pctile + 'th percentile of its own 52 weeks, ' + ((now / peak) * 100).toFixed(0)
        + '% of the window peak of ' + peak.toFixed(2) + '%.</div>';
    }

    async loadStateTrend(fips) {
      const postal = (FIPS[fips] || [])[0];
      if (!postal || !this.iliLatestWeek) return;
      if (this.stateTrendCache[fips] !== undefined) return;
      if (this.iliCoolOffUntil && Date.now() < this.iliCoolOffUntil) { this.stateTrendCache[fips] = []; return; }
      try {
        const j = await this.delphi("fluview/?regions=" + postal.toLowerCase() + "&epiweeks=" + epiRange(this.iliLatestWeek, 51));
        const rows = (j.epidata || []).filter(x => x.wili != null)
          .sort((a, b) => a.epiweek - b.epiweek)
          .map(x => ({ t: epiLabel(x.epiweek).replace(/, \d{4}$/, ""), v: Number(x.wili) }));
        this.stateTrendCache[fips] = rows;
      } catch (e) {
        if (e.rateLimited) this.iliCoolOffUntil = Date.now() + 1800000;
        this.stateTrendCache[fips] = [];
      }
      if (this.selected === fips) this.renderDetail(fips);
    }

    /* ---------- loading -------------------------------------------------- */

    async load() {
      if (this.map) this.fitUs();
      this.status("Querying CDC ILINet, CDC hospital respiratory reporting, openFDA and air quality…");
      const results = await Promise.allSettled([
        this.loadIli(), this.loadHospital(), this.loadRecalls(), this.loadShortages(), this.loadAir(), this.loadNews()
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") console.warn("[" + this.tagName.toLowerCase() + "] feed " + i + " failed:", r.reason);
      });
      const names = ["ILINet", "hospital reporting", "food recalls", "drug shortages", "air quality", "health news"];
      const failed = results.map((r, i) => r.status === "rejected" ? names[i] : null).filter(Boolean);
      this.q("[data-updated]").textContent = "Retrieved " + new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }) + " CT";
      this.status(failed.length
        ? "Six public feeds, " + (6 - failed.length) + " answering. Unavailable: " + failed.join(", ") + ". "
          + (this.iliError ? this.iliError.status : "Panels for those feeds stay empty rather than showing stale numbers.")
        : "Six public feeds answering: CDC ILINet outpatient surveillance, CDC weekly hospital respiratory reporting, openFDA food recall enforcement, openFDA drug shortages, Open-Meteo air quality, and the national public health news feed.");
      // If ILI could not load, land the map on a measure that did.
      if (!Object.keys(this.iliStates || {}).length && this.metric === "ili" && Object.keys(this.hospStates || {}).length) {
        this.metric = "flu";
      }
      this.renderIliChart();
      this.renderMetricSwitch();
      this.setMetric(this.metric);
      this.renderKpis();
      this.renderNote();
      this.publish();
    }

    /* Delphi's Epidata API rate-limits anonymous callers. When it refuses, that is
       a refused request, not an empty reporting week — the two must never read the
       same on screen. Metadata and the national series are cached for the session
       so a refresh costs one request instead of five, and a 429 sets a cool-off
       that the interval respects rather than hammering the limit again. */
    async delphi(path) {
      const res = await fetch(DELPHI + path);
      const text = await res.text();
      if (res.status === 429 || /rate limit/i.test(text)) {
        const e = new Error("delphi-rate-limited");
        e.rateLimited = true;
        throw e;
      }
      try {
        return JSON.parse(text);
      } catch (err) {
        const e = new Error("delphi-bad-response");
        e.badResponse = true;
        throw e;
      }
    }

    async loadIli() {
      if (this.iliCoolOffUntil && Date.now() < this.iliCoolOffUntil) {
        throw Object.assign(new Error("delphi-cooling-off"), { rateLimited: true });
      }
      try {
        if (!this.iliNat || !this.iliNat.length) {
          const meta = await this.delphi("fluview_meta/");
          const latest = (meta.epidata && meta.epidata[0] && meta.epidata[0].latest_issue) || null;
          if (!latest) throw new Error("no ILINet metadata");
          const natRes = await this.delphi("fluview/?regions=nat&epiweeks=" + epiRange(latest, 51));
          const nat = (natRes.epidata || []).filter(x => x.wili != null).sort((a, b) => a.epiweek - b.epiweek);
          this.iliLatestWeek = nat.length ? nat[nat.length - 1].epiweek : latest;
          this.iliNat = nat.map(x => ({ t: epiLabel(x.epiweek).replace(/, \d{4}$/, ""), v: Number(x.wili), ew: x.epiweek }));
          this.iliWeekLabel = epiLabel(this.iliLatestWeek);
        }

        // One state-week request. If coverage is thin, the week is reported as thin
        // rather than spending three more requests probing backwards.
        const r = await this.delphi("fluview/?regions=" + STATE_CODES.join(",") + "&epiweeks=" + this.iliLatestWeek);
        const rows = (r.epidata || []).filter(x => x.wili != null);
        const states = {};
        rows.forEach(x => { states[x.region] = Number(x.wili); });
        this.iliStates = states;
        this.iliError = null;
        this.iliCoolOffUntil = 0;
      } catch (e) {
        this.iliStates = {};
        this.iliError = e.rateLimited
          ? {
              kind: "rate",
              short: "CDC ILINet is rate-limited",
              status: "CDC ILINet is rate-limited for anonymous queries by the Delphi Epidata API; a free Delphi API key removes the limit. Retrying in 30 minutes.",
              panel: "CDC ILINet did not answer: the Delphi Epidata API rate-limits anonymous queries. This is a refused request, not an empty reporting week. A free API key from api.delphi.cmu.edu removes the limit; the dashboard will retry in 30 minutes."
            }
          : {
              kind: "error",
              short: "CDC ILINet unavailable",
              status: "CDC ILINet did not return usable data. This is a feed failure, not an empty reporting week.",
              panel: "CDC ILINet did not return usable data. This is a feed failure, not an empty reporting week — outpatient figures are unavailable until it answers."
            };
        if (e.rateLimited) this.iliCoolOffUntil = Date.now() + 1800000;
        throw e;
      }
    }

    renderIliChart() {
      const s = this.iliNat || [];
      const box = this.q("[data-ili-chart]");
      if (s.length > 2) {
        box.innerHTML = areaChart(s, { w: 560, h: 180, color: INK, dec: 2, baseline: 3, markPeak: true })
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:8px;line-height:1.5;">Latest reported week ends '
          + esc(this.iliWeekLabel || "—") + " at " + s[s.length - 1].v.toFixed(2)
          + "% of outpatient visits. The dashed rule is the CDC national baseline; weeks above it are the working definition of an active flu season. The ring marks the peak of this 52-week window.</div>"
          + this.trendFooter(s)
          + (this.iliError ? '<div style="font-size:11px;color:' + DEEPRED + ';margin-top:8px;line-height:1.5;">State-level rows: ' + esc(this.iliError.panel) + "</div>" : "");
        return;
      }
      box.innerHTML = '<div style="border:2px solid ' + RULE + ';padding:16px;background:' + SURFACE + ';">'
        + '<div style="' + label("margin-bottom:6px;") + '">' + esc(this.iliError ? this.iliError.short : "Awaiting CDC ILINet") + "</div>"
        + '<div style="font-size:12px;line-height:1.55;max-width:520px;">'
        + esc(this.iliError ? this.iliError.panel : "The outpatient influenza-like illness series has not loaded yet.") + "</div>"
        + (this.iliError && this.iliError.kind === "rate"
            ? '<a href="https://api.delphi.cmu.edu/epidata/admin/registration_form" target="_blank" rel="noopener" style="display:inline-block;margin-top:12px;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:9px 13px;border:2px solid ' + INK + ";background:" + INK + ";color:" + GROUND + ';text-decoration:none;">Request a free Delphi key</a>'
            : "")
        + "</div>";
    }

    async loadHospital() {
      const latest = await (await fetch(CDC + HOSP_SET + "?$select=weekendingdate&$order=weekendingdate%20DESC&$limit=1")).json();
      const week = latest[0] && latest[0].weekendingdate;
      if (!week) throw new Error("no hospital week");
      this.hospWeek = week;
      const fields = "weekendingdate,jurisdiction,totalconfflunewadm,totalconfc19newadm,totalconfrsvnewadm,numinptbeds,numinptbedsocc,numicubeds,numicubedsocc";
      const rows = await (await fetch(CDC + HOSP_SET + "?$where=weekendingdate='" + week + "'&$limit=200&$select=" + fields)).json();
      const byState = {};
      rows.forEach(r => { byState[r.jurisdiction] = r; });
      this.hospStates = byState;
      this.hospUsaLatest = byState.USA || null;

      const trend = await (await fetch(CDC + HOSP_SET + "?jurisdiction=USA&$order=weekendingdate%20DESC&$limit=52&$select=" + fields)).json();
      this.hospNat = trend.slice().reverse();

      // The prior week, for per-state week-over-week change.
      const prevWeek = await (await fetch(CDC + HOSP_SET + "?$select=weekendingdate&$where=weekendingdate<'" + week + "'&$order=weekendingdate%20DESC&$limit=1")).json();
      const pw = prevWeek[0] && prevWeek[0].weekendingdate;
      if (pw) {
        const prior = await (await fetch(CDC + HOSP_SET + "?$where=weekendingdate='" + pw + "'&$limit=200&$select=" + fields)).json();
        const byPrior = {};
        prior.forEach(r => { byPrior[r.jurisdiction] = r; });
        this.hospPrior = byPrior;
        this.hospPriorWeek = pw;
      }
      this.renderRespCharts();
    }

    renderRespCharts() {
      const rows = this.hospNat || [];
      const box = this.q("[data-resp-charts]");
      if (rows.length < 3) { box.innerHTML = '<div style="' + label() + '">Hospital reporting unavailable.</div>'; return; }
      const spec = [["Influenza", "totalconfflunewadm"], ["COVID-19", "totalconfc19newadm"], ["RSV", "totalconfrsvnewadm"]];
      box.innerHTML = spec.map(([name, field]) => {
        const series = rows.map(r => ({ t: fmtDate(r.weekendingdate).replace(/, \d{4}$/, ""), v: num(r[field]) }));
        const vals = series.map(s => s.v).filter(v => v != null);
        const last = series.filter(s => s.v != null).slice(-1)[0];
        const prev = series.filter(s => s.v != null).slice(-2)[0];
        const delta = last && prev && prev.v ? ((last.v - prev.v) / prev.v) * 100 : null;
        const peak = vals.length ? Math.max(...vals) : null;
        return "<div>"
          + '<div style="font-size:12px;font-weight:800;margin-bottom:2px;">' + name + "</div>"
          + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:24px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">'
          + (last ? Math.round(last.v).toLocaleString("en-US") : "—") + "</div>"
          + '<div style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + (delta > 0 ? DEEPRED : MUTED) + ';margin:4px 0 8px;">'
          + (delta == null ? "no prior week" : (delta > 0 ? "\u25b2 " : delta < 0 ? "\u25bc " : "\u2014 ") + Math.abs(delta).toFixed(0) + "% wk/wk") + "</div>"
          + areaChart(series, { w: 200, h: 92, color: INK, markPeak: true })
          + (peak && last
              ? '<div style="font-size:10px;color:' + MUTED + ';margin-top:6px;line-height:1.45;font-variant-numeric:tabular-nums;">'
                + ((last.v / peak) * 100).toFixed(0) + "% of the 52-week peak (" + Math.round(peak).toLocaleString("en-US") + ") · "
                + Math.round(((last.v / POP.USA) * 100000) * 100) / 100 + " per 100k</div>"
              : "")
          + "</div>";
      }).join("");
    }

    async loadRecalls() {
      const now = new Date(), from = new Date(now.getTime() - 120 * 86400000);
      const base = FDA + "food/enforcement.json?search=report_date:[" + ymd(from) + "+TO+" + ymd(now) + "]";
      const res = await (await fetch(base + "&sort=report_date:desc&limit=100")).json();
      this.recalls = res.results || [];
      this.recallMeta = (res.meta && res.meta.results) || null;
      this.recallUpdated = res.meta && res.meta.last_updated;
      this.recallWindow = fmtDate(from.toISOString()) + " to " + fmtDate(now.toISOString());
      this.renderRecalls();
    }

    renderRecallFilters() {
      this.q("[data-recall-filters]").innerHTML = ["Class I", "Class II", "Class III", "All"].map((c, i) => {
        const on = c === this.recallClass;
        return '<button data-recall-class="' + c + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border:none;'
          + (i ? "border-left:2px solid " + RULE + ";" : "") + "background:" + (on ? INK : "transparent") + ";color:" + (on ? GROUND : INK) + ';cursor:pointer;">'
          + esc(c) + "</button>";
      }).join("");
    }

    renderRecalls() {
      const all = this.recalls || [];
      const box = this.q("[data-recalls]");
      const note = this.q("[data-recall-note]");
      if (!all.length) {
        note.textContent = "Food recall enforcement feed unavailable.";
        box.innerHTML = "";
        return;
      }
      const counts = { "Class I": 0, "Class II": 0, "Class III": 0 };
      all.forEach(r => { if (counts[r.classification] != null) counts[r.classification]++; });
      const mo = all.filter(r => /\bMO\b|Missouri/i.test([r.state, r.distribution_pattern].join(" ")));
      note.innerHTML = "Enforcement reports posted " + esc(this.recallWindow) + " &middot; "
        + Object.keys(counts).map(k => counts[k] + " " + k).join(" &middot; ")
        + (mo.length ? ' &middot; <b style="color:' + DEEPRED + ';">' + mo.length + " distributed in Missouri or nationwide from a Missouri firm</b>" : "")
        + (this.recallUpdated ? " &middot; feed updated " + esc(fmtDate(this.recallUpdated)) : "");

      const rows = this.recallClass === "All" ? all : all.filter(r => r.classification === this.recallClass);
      if (!rows.length) { box.innerHTML = '<div style="' + label("padding:10px 0;") + '">No ' + esc(this.recallClass) + " recalls in this window.</div>"; return; }
      this.recallRows = rows.slice(0, 40);
      box.innerHTML = this.recallRows.map((r, i) => {
        const cls = RECALL_CLASS[r.classification] || RECALL_CLASS["Class III"];
        const inMo = /\bMO\b|Missouri/i.test([r.state, r.distribution_pattern].join(" "));
        return '<div data-recall-idx="' + i + '" title="Open the enforcement report details" style="display:grid;grid-template-columns:auto 1fr;gap:10px;padding:11px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;">'
          + '<span style="width:9px;height:9px;margin-top:5px;background:' + cls.color + ';"></span>'
          + '<div style="min-width:0;">'
          + '<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:3px;">'
          + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:' + cls.color + ';">' + esc(r.classification || "Unclassified") + "</span>"
          + '<span style="' + label() + '">' + esc(r.status || "") + " &middot; " + esc(fmtFdaDate(r.report_date)) + " &middot; " + esc(r.recall_number || "") + "</span>"
          + (inMo ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:2px 5px;">Missouri</span>' : "")
          + "</div>"
          + '<div style="font-size:12px;font-weight:700;line-height:1.4;border-bottom:1px solid ' + INK + ';display:inline;">' + esc(String(r.reason_for_recall || "Reason not published").slice(0, 190)) + "</div>"
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:4px;line-height:1.45;">'
          + esc(titleCase(r.recalling_firm || "")) + (r.city ? " &middot; " + esc(titleCase(r.city)) + ", " + esc(r.state || "") : "")
          + (r.distribution_pattern ? " &middot; " + esc(String(r.distribution_pattern).slice(0, 110)) : "") + "</div>"
          + '<div style="font-size:11px;color:' + INK + ';margin-top:4px;line-height:1.45;opacity:0.8;">' + esc(String(r.product_description || "").slice(0, 180)) + "</div>"
          + "</div></div>";
      }).join("");
    }

    async loadShortages() {
      const res = await (await fetch(FDA + 'drug/shortages.json?search=status:"Current"&sort=update_date:desc&limit=50')).json();
      this.shortages = res.results || [];
      this.shortageTotal = res.meta && res.meta.results && res.meta.results.total;
      this.shortageUpdated = res.meta && res.meta.last_updated;
      this.renderShortages();
    }

    renderShortages() {
      const rows = this.shortages || [];
      const note = this.q("[data-shortage-note]");
      const box = this.q("[data-shortages]");
      if (!rows.length) { note.textContent = "Drug shortage feed unavailable."; box.innerHTML = ""; return; }
      note.innerHTML = (this.shortageTotal || rows.length).toLocaleString("en-US") + " product records currently in shortage status"
        + (this.shortageUpdated ? " &middot; feed updated " + esc(fmtDate(this.shortageUpdated)) : "")
        + " &middot; showing the " + Math.min(50, rows.length) + " most recently updated";
      box.innerHTML = rows.map((r, i) => {
        const avail = String(r.availability || "").trim();
        const tight = /limited|allocation|depleted|no |unavailable/i.test(avail);
        return '<div data-short-idx="' + i + '" title="Open the shortage record details" style="display:grid;grid-template-columns:auto 1fr;gap:10px;padding:11px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;">'
          + '<span style="width:9px;height:9px;margin-top:5px;background:' + (tight ? RED : MUTED) + ';"></span>'
          + '<div style="min-width:0;">'
          + '<div style="font-size:12px;font-weight:700;line-height:1.4;border-bottom:1px solid ' + INK + ';display:inline;">' + esc(titleCase(r.generic_name || "Unnamed product")) + "</div>"
          + '<div style="' + label("margin-top:4px;") + '">'
          + esc(r.therapeutic_category || (r.openfda && r.openfda.manufacturer_name && r.openfda.manufacturer_name[0]) || "Manufacturer not listed")
          + " &middot; updated " + esc(fmtFdaDate(r.update_date || r.initial_posting_date)) + "</div>"
          + (avail ? '<div style="font-size:11px;color:' + (tight ? DEEPRED : MUTED) + ';margin-top:4px;line-height:1.45;">' + esc(avail.slice(0, 170)) + "</div>" : "")
          + (r.shortage_reason ? '<div style="font-size:11px;color:' + MUTED + ';margin-top:3px;">' + esc(String(r.shortage_reason).slice(0, 130)) + "</div>" : "")
          + "</div></div>";
      }).join("");
    }

    async loadAir() {
      const url = AQ_URL + "?latitude=" + METROS.map(m => m.lat).join(",")
        + "&longitude=" + METROS.map(m => m.lon).join(",")
        + "&current=us_aqi,pm2_5,ozone&timezone=auto";
      const res = await (await fetch(url)).json();
      const arr = Array.isArray(res) ? res : [res];
      this.air = METROS.map((m, i) => {
        const cur = arr[i] && arr[i].current;
        return { name: m.name, home: m.home, aqi: cur ? num(cur.us_aqi) : null, pm: cur ? num(cur.pm2_5) : null, o3: cur ? num(cur.ozone) : null };
      });
      this.renderAir();
    }

    renderAir() {
      const rows = this.air || [];
      const box = this.q("[data-aqi]");
      if (!rows.length) { box.innerHTML = '<div style="' + label("padding:14px;") + '">Air quality unavailable.</div>'; return; }
      const worst = rows.filter(r => r.aqi != null).sort((a, b) => b.aqi - a.aqi)[0];
      this.q("[data-aqi-note]").textContent = worst ? "Highest of the twelve: " + worst.name + " at " + Math.round(worst.aqi) : "";
      box.innerHTML = rows.map(r => {
        const b = r.aqi == null ? null : aqiBand(r.aqi);
        return '<div style="border-right:2px solid ' + RULE + ";border-bottom:2px solid " + RULE + ';padding:12px 14px;'
          + (r.home ? "background:" + SURFACE + ";" : "") + '">'
          + '<div style="font-size:11px;font-weight:' + (r.home ? 800 : 700) + ';margin-bottom:8px;">' + esc(r.name)
          + (r.home ? ' <span style="' + label() + '">campus</span>' : "") + "</div>"
          + '<div style="display:flex;align-items:center;gap:8px;">'
          + '<span style="width:12px;height:20px;background:' + (b ? b.bg : NO_DATA) + ';border:1px solid ' + INK + ';box-sizing:border-box;"></span>'
          + '<span style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:26px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">'
          + (r.aqi == null ? "—" : Math.round(r.aqi)) + "</span></div>"
          + '<div style="font-size:10px;font-weight:700;letter-spacing:0.04em;color:' + MUTED + ';margin-top:6px;line-height:1.35;">'
          + esc(b ? b.name : "not modelled") + "</div>"
          + '<div style="font-size:10px;color:' + MUTED + ';margin-top:4px;font-variant-numeric:tabular-nums;">PM2.5 '
          + (r.pm == null ? "—" : r.pm.toFixed(1)) + " &micro;g/m&sup3;</div></div>";
      }).join("");
    }

    /* ---------- public health news --------------------------------------

       Three sources, kept distinguishable in the list because their standing
       differs: CDC's own postings and WHO Disease Outbreak News are official and
       read directly (both send CORS headers); the national outlet feeds are media
       reporting, arrive through the dashboard Worker, and are labelled as such.
       A story often breaks in the trade press days before an official notice. */

    async loadNews() {
      const hours = this.newsHours || 24;
      const note = this.q("[data-news-note]");
      note.textContent = "Reading CDC postings, WHO Disease Outbreak News and the national outlet feeds…";
      const cutoff = Date.now() - hours * 3600000;
      const results = await Promise.allSettled([this.loadCdcPostings(cutoff), this.loadWhoDon(cutoff), this.loadOutletNews(hours)]);
      const [cdc, who, outlets] = results.map(r => r.status === "fulfilled" ? r.value : null);

      const seen = new Set();
      const items = [];
      [].concat(cdc || [], who || [], (outlets && outlets.items) || []).forEach(it => {
        const key = String(it.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push(it);
      });
      items.sort((a, b) => (a.ageHours == null ? 1 : b.ageHours == null ? -1 : a.ageHours - b.ageHours));
      this.news = items;
      this.newsOutletStatus = outlets;
      this.newsFailures = [
        results[0].status === "rejected" ? "CDC postings" : null,
        results[1].status === "rejected" ? "WHO outbreak news" : null,
        results[2].status === "rejected" ? "national outlets" : null
      ].filter(Boolean);
      this.renderNewsCats();
      this.renderNews();
      this.publish();
    }

    /* CDC posts new material in bursts but refreshes its surveillance pages daily,
       and for a watch desk the refresh IS the news: “Measles Cases and Outbreaks
       updated three hours ago” is the signal, not the original posting date. Both
       orderings are queried and each item states which date it is showing. */
    async loadCdcPostings(cutoff) {
      const [pub, mod] = await Promise.all([
        fetch(CDC_MEDIA + "-datePublished").then(r => r.json()),
        fetch(CDC_MEDIA + "-dateModified").then(r => r.json())
      ]);
      const out = new Map();
      [].concat(pub.results || [], mod.results || []).forEach(r => {
        const posted = Date.parse(r.datePublished);
        const updated = Date.parse(r.dateModified);
        const when = Math.max(isNaN(posted) ? 0 : posted, isNaN(updated) ? 0 : updated);
        if (!when || when < cutoff) return;
        const title = String(r.name || "").replace(/<[^>]+>/g, "").trim();
        const summary = String(r.description || "").replace(/<[^>]+>/g, "").trim();
        const text = title + " " + summary;
        const src = String(r.sourceUrl || "");
        if (CDC_ASSET_NOISE.test(src) || CDC_ASSET_NOISE.test(title)) return;
        if (NEWS_NOISE.test(text)) return;
        const cats = classifyNews(text);
        if (!cats.length) return;
        // A page refreshed well after posting is an update, not a new posting.
        const isUpdate = !isNaN(posted) && updated - posted > 3600000;
        const key = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
        const age = Math.round(((Date.now() - when) / 3600000) * 10) / 10;
        if (out.has(key) && out.get(key).ageHours <= age) return;
        out.set(key, {
          title: title,
          // Feed-import records point at raw XML; prefer a human page when there is one.
          url: /\.(xml|json|rss)(\?|$)/i.test(src) ? (r.targetUrl || r.persistentUrl || src) : (src || r.targetUrl || r.persistentUrl),
          outlet: /mmwr/i.test(r.sourceUrl || "") ? "CDC · MMWR" : "CDC",
          official: true,
          kind: isUpdate ? "updated" : "posted",
          postedAt: isNaN(posted) ? null : new Date(posted).toISOString(),
          published: new Date(when).toISOString(),
          ageHours: age,
          categories: cats,
          midwest: MIDWEST.test(text) || null,
          summary: summary.slice(0, 400) || null
        });
      });
      return this.collapseCdcTopics([...out.values()]);
    }

    /* CDC republishes a whole topic section at once, so one review of the
       Campylobacter pages arrives as five rows with the same timestamp. They are
       collapsed to the most substantive page, which carries the count of the rest
       rather than hiding that they existed. */
    collapseCdcTopics(items) {
      const groups = new Map();
      items.forEach(it => {
        const disease = (it.title.toLowerCase().match(/\b(campylobacter|salmonella|listeria|measles|mpox|influenza|covid|rsv|dengue|malaria|hepatitis|tuberculosis|legionella|norovirus|e\. coli|botulism)\b/) || [])[1];
        const key = disease ? it.published.slice(0, 13) + "|" + disease : null;
        if (!key) { groups.set(it.title, [it]); return; }
        groups.set(key, (groups.get(key) || []).concat(it));
      });
      return [...groups.values()].map(g => {
        if (g.length === 1) return g[0];
        // Prefer the page a duty officer would open: data, outbreak or overview.
        const rank = t => /data|outbreak|cases|clinical overview/i.test(t) ? 0 : /about|overview/i.test(t) ? 1 : 2;
        const pick = g.slice().sort((a, b) => rank(a.title) - rank(b.title))[0];
        return Object.assign({}, pick, {
          alsoUpdated: g.filter(x => x !== pick).map(x => x.title),
          categories: [...new Set([].concat(...g.map(x => x.categories)))]
        });
      });
    }

    // WHO outbreak notices are international, and included because an outbreak
    // abroad is a travel-and-screening question on a campus this size.
    async loadWhoDon(cutoff) {
      const res = await fetch(WHO_DON);
      const j = await res.json();
      return (j.value || []).map(d => {
        const when = Date.parse(d.PublicationDateAndTime);
        if (isNaN(when) || when < cutoff) return null;
        const summary = String(d.Summary || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const cats = classifyNews(d.Title + " " + summary);
        return {
          title: d.Title,
          url: "https://www.who.int/emergencies/disease-outbreak-news/item" + (d.ItemDefaultUrl || ""),
          outlet: "WHO · Disease Outbreak News",
          official: true,
          kind: "posted",
          international: true,
          published: new Date(when).toISOString(),
          ageHours: Math.round(((Date.now() - when) / 3600000) * 10) / 10,
          categories: cats.length ? cats : ["outbreak"],
          summary: summary.slice(0, 400) || null
        };
      }).filter(Boolean);
    }

    async loadOutletNews(hours) {
      const origin = proxyOrigin();
      const res = await fetch(origin + "/healthnews?hours=" + hours, { signal: AbortSignal.timeout(30000) });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      return j;
    }

    setNewsWindow(hours) {
      this.newsHours = hours;
      this.querySelectorAll("[data-news-window]").forEach(b => {
        const on = Number(b.getAttribute("data-news-window")) === hours;
        b.style.background = on ? INK : "transparent";
        b.style.color = on ? GROUND : INK;
      });
      this.loadNews();
    }

    renderNewsCats() {
      const items = this.news || [];
      const active = this.newsCat;
      const cells = [{ key: null, label: "All threats", n: items.length }]
        .concat(NEWS_CATS.map(c => ({ key: c.key, label: c.label, n: items.filter(i => i.categories.includes(c.key)).length })));
      this.q("[data-news-cats]").innerHTML = cells.map((c, i) => {
        const on = active === c.key || (!active && c.key === null);
        return '<button data-news-cat="' + (c.key || "") + '" style="flex:1 1 0;min-width:0;text-align:left;padding:10px 14px;border:none;border-right:'
          + (i === cells.length - 1 ? "none" : "2px solid " + RULE) + ";background:" + (on ? INK : "transparent") + ";color:" + (on ? GROUND : INK)
          + ';cursor:' + (c.n || c.key === null ? "pointer" : "default") + ';opacity:' + (c.n || c.key === null ? 1 : 0.45) + ';font-family:Archivo,system-ui,sans-serif;">'
          + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:19px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">' + c.n + "</div>"
          + '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-top:5px;opacity:0.85;">' + esc(c.label) + "</div></button>";
      }).join("");
    }

    renderNews() {
      const all = this.news || [];
      const box = this.q("[data-news" + "]");
      const note = this.q("[data-news-note]");
      const os = this.newsOutletStatus;
      const hours = this.newsHours || 24;
      const win = hours < 48 ? "last " + hours + " hours" : "last " + hours / 24 + " days";

      const parts = [];
      const official = all.filter(i => i.official).length;
      parts.push(all.length + " item" + (all.length === 1 ? "" : "s") + " in the " + win
        + " · " + official + " official posting" + (official === 1 ? "" : "s") + ", " + (all.length - official) + " media report" + ((all.length - official) === 1 ? "" : "s"));
      if (os) parts.push(os.outletsAnswering + " of " + os.outletsTotal + " national outlets answering");
      if (this.newsFailures.length) {
        parts.push("unavailable: " + this.newsFailures.join(", ")
          + (this.newsFailures.includes("national outlets") && /\.workers\.dev$/.test(proxyOrigin())
              ? " (managed WashU devices block *.workers.dev — set an allowed proxy origin in the Outages tab)" : ""));
      }
      note.innerHTML = esc(parts.join(" · ")) + '. <span style="color:' + MUTED + ';">Classification is keyword-based and shown on each item. Media reports are not official notification.</span>';

      const mw = all.filter(i => i.midwest).length;
      const fresh = all.filter(i => i.ageHours != null && i.ageHours <= 6).length;
      this.q("[data-news-counts]").textContent = fresh + " in the last 6 h" + (mw ? " · " + mw + " name the Midwest" : "");

      const rows = this.newsCat ? all.filter(i => i.categories.includes(this.newsCat)) : all;
      this.newsRows = rows.slice(0, 40);
      if (!this.newsRows.length) {
        box.innerHTML = '<div style="padding:22px 32px;font-size:12px;color:' + MUTED + ';line-height:1.55;">'
          + (all.length ? "No items in this threat class for the selected window."
            : this.newsFailures.length === 3 ? "No feed answered. The two official sources are read directly and need only network access; the outlet feeds need the dashboard Worker."
            : "No public health items matched in the " + win + ". Widen the window above.") + "</div>";
        return;
      }

      box.innerHTML = this.newsRows.map((it, i) => {
        const catChips = it.categories.slice(0, 3).map(k =>
          '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:2px 5px;border:1px solid ' + INK + ';">' + esc(catLabel(k)) + "</span>").join("");
        return '<div data-news-idx="' + i + '" title="Open the item details" style="padding:14px 20px 14px ' + (i % 2 === 0 ? "32px" : "20px")
          + ';border-right:' + (i % 2 === 0 ? "2px solid " + RULE : "none") + ';border-bottom:1px solid ' + HAIR + ';cursor:pointer;'
          + (it.official ? "background:" + SURFACE + ";" : "") + '">'
          + '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:6px;">'
          + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:' + (it.official ? DEEPRED : MUTED) + ';">'
          + esc(it.outlet) + "</span>"
          + (it.official ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:2px 5px;">' + (it.kind === "updated" ? "Official · updated" : "Official") + "</span>" : "")
          + (it.midwest ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + INK + ';padding:1px 4px;">Midwest</span>' : "")
          + (it.international ? '<span style="' + label() + '">international</span>' : "")
          + '<span style="' + label() + 'margin-left:auto;font-variant-numeric:tabular-nums;">' + esc(relHours(it.ageHours)) + "</span></div>"
          + '<div style="font-size:13px;font-weight:700;line-height:1.4;border-bottom:1px solid ' + INK + ';display:inline;">' + esc(it.title) + "</div>"
          + (it.summary ? '<div style="font-size:11px;color:' + MUTED + ';margin-top:7px;line-height:1.5;">' + esc(it.summary.slice(0, 170)) + (it.summary.length > 170 ? "…" : "") + "</div>" : "")
          + (it.alsoUpdated && it.alsoUpdated.length ? '<div style="' + label("margin-top:7px;") + '">+ ' + it.alsoUpdated.length + " related page" + (it.alsoUpdated.length === 1 ? "" : "s") + " refreshed in the same review</div>" : "")
          + '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:9px;">' + catChips + "</div></div>";
      }).join("");
    }

    showNews(i) {
      const it = (this.newsRows || [])[i];
      if (!it) return;
      const body =
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;">'
        + (it.official
            ? '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:3px 6px;">Official posting</span>'
            : '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;border:2px solid ' + MUTED + ';color:' + MUTED + ';padding:2px 5px;">Media report · unverified</span>')
        + it.categories.map(k => '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:3px 6px;border:1px solid ' + INK + ';">' + esc(catLabel(k)) + "</span>").join("")
        + "</div>"
        + (it.summary ? '<div style="font-size:13px;font-weight:600;line-height:1.55;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">' + esc(it.summary) + "</div>" : "")
        + '<div style="margin-top:6px;">'
        + this.modalRow("Source", it.outlet)
        + this.modalRow("Retrieved via", it.via || (it.official ? "read directly — source sends CORS headers" : "dashboard Worker"))
        + this.modalRow(it.kind === "updated" ? "Updated" : "Published", it.published ? new Date(it.published).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT" : "not stated")
        + this.modalRow(it.kind === "updated" ? "Originally posted" : null, it.postedAt ? new Date(it.postedAt).toLocaleDateString("en-US", { timeZone: "America/Chicago", dateStyle: "medium" }) : null)
        + this.modalRow("Age", relHours(it.ageHours))
        + this.modalRow("Threat classes", it.categories.map(catLabel).join(", "))
        + this.modalRow("Names the Midwest", it.midwest ? "yes — flagged for the desk" : null, DEEPRED)
        + this.modalRow("Scope", it.international ? "international" : "United States")
        + "</div>"
        + (it.alsoUpdated && it.alsoUpdated.length
            ? '<div style="' + label("margin:16px 0 6px;") + '">Refreshed in the same review</div><ul style="margin:0;padding-left:18px;font-size:11px;color:' + MUTED + ';line-height:1.6;">'
              + it.alsoUpdated.map(t => "<li>" + esc(t) + "</li>").join("") + "</ul>"
            : "")
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">'
        + (it.official
            ? "Published by the agency itself. CDC refreshes its surveillance pages as figures change, so an item marked <b>updated</b> carries new numbers on an existing page rather than a new notice. Threat classes are assigned by keyword in this dashboard, not by the agency."
            : "Media reporting, not official notification. Treat as a lead to confirm against a CDC, WHO, FDA or state health department source.")
        + "</div>"
        + this.modalActions([{ text: "Open the source", href: it.url }]);
      this.openModal(it.official ? "Official public health posting" : "Public health in the news", it.title, body);
    }

    /* ---------- record pop-ups -------------------------------------------
       openFDA publishes no per-record permalink, so each pop-up carries the
       whole record and links out to the FDA page that lists it — the recall
       number and the generic name are what an analyst searches on there. */

    closeModal() { this.q("[data-hw-modal]").style.display = "none"; }

    openModal(kicker, title, body) {
      this.q("[data-hw-modal]").style.display = "flex";
      this.q("[data-hw-modal-kicker]").textContent = kicker;
      this.q("[data-hw-modal-title]").textContent = title;
      this.q("[data-hw-modal-body]").innerHTML = body;
    }

    modalRow(k, v, tone) {
      if (v == null || v === "") return "";
      return '<div style="display:grid;grid-template-columns:38% 1fr;gap:12px;padding:8px 0;border-bottom:1px solid ' + HAIR + ';align-items:baseline;">'
        + '<span style="' + label() + '">' + esc(k) + "</span>"
        + '<span style="font-weight:600;color:' + (tone || INK) + ';">' + esc(v) + "</span></div>";
    }

    modalActions(links) {
      return '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:16px;">'
        + links.map((l, i) => '<a href="' + esc(l.href) + '" target="_blank" rel="noopener" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:9px 13px;text-decoration:none;border:2px solid '
            + INK + ";background:" + (i === 0 ? INK : "transparent") + ";color:" + (i === 0 ? GROUND : INK) + ';">' + esc(l.text) + "</a>").join("")
        + "</div>";
    }

    showRecall(i) {
      const r = (this.recallRows || [])[i];
      if (!r) return;
      const cls = RECALL_CLASS[r.classification] || RECALL_CLASS["Class III"];
      const inMo = /\bMO\b|Missouri/i.test([r.state, r.distribution_pattern].join(" "));
      const body =
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:14px;flex-wrap:wrap;">'
        + '<span style="width:11px;height:11px;background:' + cls.color + ';"></span>'
        + '<span style="font-size:13px;font-weight:800;color:' + cls.color + ';">' + esc(r.classification || "Unclassified") + "</span>"
        + '<span style="font-size:11px;color:' + MUTED + ';">' + esc(cls.note) + "</span>"
        + (inMo ? '<span style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;background:' + INK + ";color:" + GROUND + ';padding:3px 6px;">Missouri distribution</span>' : "")
        + "</div>"
        + '<div style="font-size:13px;font-weight:700;line-height:1.5;padding-bottom:14px;border-bottom:2px solid ' + INK + ';">'
        + esc(r.reason_for_recall || "Reason not published") + "</div>"
        + '<div style="margin-top:6px;">'
        + this.modalRow("Recall number", r.recall_number)
        + this.modalRow("Status", r.status, /ongoing/i.test(r.status || "") ? DEEPRED : INK)
        + this.modalRow("Report date", fmtFdaDate(r.report_date))
        + this.modalRow("Recall initiated", fmtFdaDate(r.recall_initiation_date))
        + this.modalRow("Terminated", fmtFdaDate(r.termination_date))
        + this.modalRow("Recalling firm", titleCase(r.recalling_firm || ""))
        + this.modalRow("Firm location", [titleCase(r.city || ""), r.state, r.country].filter(Boolean).join(", "))
        + this.modalRow("Initiated by", r.voluntary_mandated)
        + this.modalRow("Firm notification", r.initial_firm_notification)
        + this.modalRow("Quantity in commerce", r.product_quantity)
        + this.modalRow("Distribution", r.distribution_pattern, inMo ? DEEPRED : INK)
        + this.modalRow("Event id", r.event_id)
        + "</div>"
        + '<div style="' + label("margin:16px 0 6px;") + '">Product description</div>'
        + '<div style="font-size:12px;line-height:1.55;">' + esc(r.product_description || "Not published") + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">openFDA enforcement report, drawn from FDA\u2019s weekly Enforcement Report. openFDA publishes no per-record page \u2014 search FDA on recall number '
        + esc(r.recall_number || "") + " to reach the official listing.</div>"
        + this.modalActions([
          { text: "FDA recall search", href: "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts?search_api_fulltext=" + encodeURIComponent(r.recall_number || r.recalling_firm || "") },
          { text: "openFDA record", href: FDA + "food/enforcement.json?search=recall_number:%22" + encodeURIComponent(r.recall_number || "") + "%22" }
        ]);
      this.openModal("Food recall enforcement report", titleCase(r.recalling_firm || "Recalling firm not named"), body);
    }

    showShortage(i) {
      const r = (this.shortages || [])[i];
      if (!r) return;
      const avail = String(r.availability || "").trim();
      const tight = /limited|allocation|depleted|no |unavailable/i.test(avail);
      const of = r.openfda || {};
      const first = k => (Array.isArray(of[k]) ? of[k][0] : of[k]) || "";
      const body =
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:14px;flex-wrap:wrap;">'
        + '<span style="width:11px;height:11px;background:' + (tight ? RED : MUTED) + ';"></span>'
        + '<span style="font-size:13px;font-weight:800;color:' + (tight ? DEEPRED : INK) + ';">' + esc(r.status || "Current shortage") + "</span>"
        + (r.update_type ? '<span style="' + label() + '">' + esc(r.update_type) + "</span>" : "")
        + "</div>"
        + (avail ? '<div style="font-size:13px;font-weight:700;line-height:1.5;padding-bottom:14px;border-bottom:2px solid ' + INK + ';color:' + (tight ? DEEPRED : INK) + ';">' + esc(avail) + "</div>" : "")
        + '<div style="margin-top:6px;">'
        + this.modalRow("Generic name", titleCase(r.generic_name || ""))
        + this.modalRow("Brand name", titleCase(first("brand_name")))
        + this.modalRow("Dosage form", r.dosage_form)
        + this.modalRow("Strength", Array.isArray(r.strength) ? r.strength.join(", ") : r.strength)
        + this.modalRow("Presentation", r.presentation)
        + this.modalRow("Manufacturer", titleCase(first("manufacturer_name")))
        + this.modalRow("Therapeutic category", r.therapeutic_category)
        + this.modalRow("Reason", r.shortage_reason)
        + this.modalRow("Package NDC", r.package_ndc)
        + this.modalRow("Application number", first("application_number"))
        + this.modalRow("First posted", fmtFdaDate(r.initial_posting_date))
        + this.modalRow("Last updated", fmtFdaDate(r.update_date))
        + this.modalRow("Change date", fmtFdaDate(r.change_date))
        + this.modalRow("Discontinued", fmtFdaDate(r.discontinued_date))
        + this.modalRow("Manufacturer contact", r.contact_info)
        + "</div>"
        + (r.related_info ? '<div style="' + label("margin:16px 0 6px;") + '">Related information</div><div style="font-size:12px;line-height:1.55;">' + esc(r.related_info) + "</div>" : "")
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:14px;line-height:1.5;">openFDA drug shortage record. FDA\u2019s own shortage database is the authoritative listing and carries any therapeutic alternatives.</div>'
        + this.modalActions([
          { text: "FDA shortage database", href: "https://dps.fda.gov/drugshortages/search?query=" + encodeURIComponent(r.generic_name || "") },
          { text: "openFDA record", href: FDA + "drug/shortages.json?search=generic_name:%22" + encodeURIComponent(r.generic_name || "") + "%22" }
        ]);
      this.openModal("Current drug shortage", titleCase(r.generic_name || "Unnamed product"), body);
    }

    /* ---------- headline numbers and the composed note ------------------- */

    renderKpis() {
      const nat = this.iliNat || [];
      const iliNow = nat.length ? nat[nat.length - 1].v : null;
      const iliPrev = nat.length > 1 ? nat[nat.length - 2].v : null;
      const usa = this.hospUsaLatest;
      const usaPrev = (this.hospNat || []).slice(-2)[0];
      const recalls = this.recalls || [];
      const class1 = recalls.filter(r => r.classification === "Class I").length;
      const moState = (this.iliStates || {})[HOME.toLowerCase()];

      const delta = (now, prev) => {
        if (now == null || prev == null || !prev) return { text: "no prior week", tone: MUTED };
        const d = ((now - prev) / prev) * 100;
        return {
          text: (d > 0.5 ? "\u25b2 " : d < -0.5 ? "\u25bc " : "\u2014 ") + Math.abs(d).toFixed(0) + "% wk/wk",
          tone: d > 5 ? DEEPRED : MUTED
        };
      };

      const cells = [
        { l: "Weighted ILI · US", v: iliNow == null ? "—" : iliNow.toFixed(2) + "%", d: iliNow == null && this.iliError ? { text: this.iliError.short, tone: DEEPRED } : delta(iliNow, iliPrev),
          n: iliNow != null ? (this.iliWeekLabel ? "week ending " + this.iliWeekLabel : "") : "feed refused, not zero", spark: nat.map(x => x.v) },
        { l: "Weighted ILI · Missouri", v: moState == null ? "—" : moState.toFixed(2) + "%",
          d: moState == null && this.iliError
              ? { text: this.iliError.short, tone: DEEPRED }
              : { text: iliNow != null && moState != null ? (moState > iliNow ? "above national" : "below national") : "", tone: moState != null && iliNow != null && moState > iliNow ? DEEPRED : MUTED },
          n: moState != null ? "same ILINet week" : "feed refused, not zero", spark: (this.stateTrendCache[POSTAL_FIPS[HOME]] || []).map(x => x.v) },
        { l: "Influenza admissions", v: usa ? Math.round(num(usa.totalconfflunewadm) || 0).toLocaleString("en-US") : "—",
          d: delta(usa && num(usa.totalconfflunewadm), usaPrev && num(usaPrev.totalconfflunewadm)),
          n: this.hospWeek ? "week ending " + fmtDate(this.hospWeek) : "", spark: (this.hospNat || []).map(r => num(r.totalconfflunewadm)) },
        { l: "COVID-19 admissions", v: usa ? Math.round(num(usa.totalconfc19newadm) || 0).toLocaleString("en-US") : "—",
          d: delta(usa && num(usa.totalconfc19newadm), usaPrev && num(usaPrev.totalconfc19newadm)),
          n: "confirmed, national", spark: (this.hospNat || []).map(r => num(r.totalconfc19newadm)) },
        { l: "Class I food recalls", v: class1 ? String(class1) : recalls.length ? "0" : "—",
          d: { text: recalls.length + " of all classes", tone: MUTED }, n: "last 120 days", spark: [] },
        { l: "Drug shortages", v: this.shortageTotal ? this.shortageTotal.toLocaleString("en-US") : "—",
          d: { text: "openFDA current status", tone: MUTED }, n: this.shortageUpdated ? "as of " + fmtDate(this.shortageUpdated) : "", spark: [] }
      ];

      this.q("[data-kpis]").innerHTML = cells.map((c, i) =>
        '<div style="padding:16px 20px;border-right:' + (i === cells.length - 1 ? "none" : "2px solid " + RULE) + ';display:flex;flex-direction:column;gap:6px;'
        + (i === 0 ? "padding-left:32px;" : "") + '">'
        + '<span style="' + label() + '">' + esc(c.l) + "</span>"
        + '<span style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:26px;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">' + esc(c.v) + "</span>"
        + '<span style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + c.d.tone + ';">' + esc(c.d.text) + "</span>"
        + (c.spark && c.spark.filter(x => x != null).length > 2 ? '<div style="margin-top:2px;">' + sparkline(c.spark, 96, 24, INK) + "</div>" : "")
        + '<span style="font-size:11px;color:' + MUTED + ';">' + esc(c.n) + "</span></div>").join("");
    }

    renderNote() {
      const bits = [];
      const nat = this.iliNat || [];
      const iliNow = nat.length ? nat[nat.length - 1].v : null;
      const iliPrev = nat.length > 1 ? nat[nat.length - 2].v : null;
      if (this.iliError) bits.push(this.iliError.panel);
      if (iliNow != null) {
        const dir = iliPrev == null ? "" : iliNow > iliPrev * 1.05 ? " and rising" : iliNow < iliPrev * 0.95 ? " and falling" : " and flat";
        bits.push("National outpatient ILI is " + iliNow.toFixed(2) + "% of visits for the week ending " + this.iliWeekLabel + dir
          + ", " + (iliNow >= 3 ? "above" : "below") + " the CDC national baseline of 3%.");
      }
      const mo = (this.iliStates || {})[HOME.toLowerCase()];
      if (mo != null && iliNow != null) {
        bits.push("Missouri reports " + mo.toFixed(2) + "%, " + (mo > iliNow ? "above" : "below") + " the national figure.");
      }
      const usa = this.hospUsaLatest;
      if (usa) {
        const f = num(usa.totalconfflunewadm), c = num(usa.totalconfc19newadm), r = num(usa.totalconfrsvnewadm);
        bits.push("Hospitals reported " + [["influenza", f], ["COVID-19", c], ["RSV", r]].filter(x => x[1] != null)
          .map(x => Math.round(x[1]).toLocaleString("en-US") + " " + x[0]).join(", ")
          + " admissions nationally in the week ending " + fmtDate(this.hospWeek) + ".");
        const moRow = (this.hospStates || {})[HOME];
        if (moRow) {
          const occ = this.valueForRow(moRow, "occ"), icu = this.valueForRow(moRow, "icu");
          if (occ != null) bits.push("Missouri inpatient beds are " + occ.toFixed(0) + "% occupied"
            + (icu != null ? " and ICU beds " + icu.toFixed(0) + "%" : "") + " on the same week.");
        }
      }
      const recalls = this.recalls || [];
      const c1 = recalls.filter(x => x.classification === "Class I");
      const moRecalls = recalls.filter(x => /\bMO\b|Missouri/i.test([x.state, x.distribution_pattern].join(" ")));
      if (c1.length) {
        bits.push(c1.length + " Class I food recall" + (c1.length === 1 ? "" : "s") + " — the tier FDA reserves for a reasonable probability of serious harm or death — "
          + (c1.length === 1 ? "was" : "were") + " posted in the last 120 days"
          + (moRecalls.length ? "; " + moRecalls.length + " recall" + (moRecalls.length === 1 ? "" : "s") + " in the window name Missouri distribution" : "") + ".");
      }
      if (this.shortageTotal) {
        bits.push(this.shortageTotal.toLocaleString("en-US") + " drug product records sit in current shortage status with FDA.");
      }
      const air = (this.air || []).filter(a => a.aqi != null);
      if (air.length) {
        const home = air.find(a => a.home), worst = air.slice().sort((a, b) => b.aqi - a.aqi)[0];
        const unhealthy = air.filter(a => a.aqi > 100);
        bits.push("Air quality over St. Louis is " + (home ? Math.round(home.aqi) + " AQI (" + aqiBand(home.aqi).name.toLowerCase() + ")" : "not modelled")
          + (unhealthy.length
              ? "; " + unhealthy.length + " of the twelve monitored metros exceed 100, highest " + worst.name + " at " + Math.round(worst.aqi) + "."
              : "; no monitored metro exceeds 100."));
      }
      const news = this.news || [];
      if (news.length) {
        const top = NEWS_CATS.map(c => ({ label: c.label.toLowerCase(), n: news.filter(i => i.categories.includes(c.key)).length }))
          .filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 3);
        const mw = news.filter(i => i.midwest);
        bits.push(news.length + " public health item" + (news.length === 1 ? "" : "s") + " in the news window"
          + (top.length ? ", led by " + top.map(t => t.label + " (" + t.n + ")").join(", ") : "")
          + (mw.length ? "; " + mw.length + " name the Midwest" : "") + ".");
      }
      this.q("[data-note]").textContent = bits.length ? bits.join(" ") : "No feed has answered yet.";
    }

    publish() {
      if (typeof window === "undefined") return;
      window.__omContext = window.__omContext || {};
      const nat = this.iliNat || [];
      const usa = this.hospUsaLatest;
      const recalls = this.recalls || [];
      const air = (this.air || []).find(a => a.home);
      window.__omContext.health = {
        iliNational: nat.length ? nat[nat.length - 1].v : null,
        iliMissouri: (this.iliStates || {})[HOME.toLowerCase()] ?? null,
        iliUnavailable: this.iliError ? this.iliError.short : null,
        iliWeekEnding: this.iliWeekLabel || null,
        iliBaseline: 3,
        hospitalWeekEnding: this.hospWeek || null,
        fluAdmissionsUS: usa ? num(usa.totalconfflunewadm) : null,
        covidAdmissionsUS: usa ? num(usa.totalconfc19newadm) : null,
        rsvAdmissionsUS: usa ? num(usa.totalconfrsvnewadm) : null,
        missouriBedOccupancy: (this.hospStates || {})[HOME] ? this.valueForRow((this.hospStates || {})[HOME], "occ") : null,
        classIRecalls120d: recalls.filter(r => r.classification === "Class I").length,
        missouriRecalls120d: recalls.filter(r => /\bMO\b|Missouri/i.test([r.state, r.distribution_pattern].join(" "))).length,
        drugShortages: this.shortageTotal || null,
        campusAqi: air ? air.aqi : null,
        newsItems24h: (this.news || []).filter(i => i.ageHours != null && i.ageHours <= 24).length || null,
        newsOfficial24h: (this.news || []).filter(i => i.official && i.ageHours != null && i.ageHours <= 24).length || null,
        newsMidwest: (this.news || []).filter(i => i.midwest).slice(0, 5).map(i => ({ title: i.title, outlet: i.outlet, url: i.url, categories: i.categories })),
        newsTopThreatClasses: NEWS_CATS.map(c => ({ label: c.label, n: (this.news || []).filter(i => i.categories.includes(c.key)).length }))
          .filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 3),
        sources: "CDC ILINet (Delphi Epidata), CDC hospital respiratory reporting, openFDA recalls and shortages, Open-Meteo air quality, CDC media postings, WHO Disease Outbreak News, national outlet RSS",
        updated: new Date().toISOString()
      };
      window.dispatchEvent(new Event("om-context"));
    }
  }

  if (!customElements.get("health-watch")) customElements.define("health-watch", HealthWatch);
})();

/**
 * Ameren outage scraper (Cloudflare Worker)
 *
 * Ameren's public outage map is a KUBRA StormCenter instance. It ships no API,
 * no CORS headers and no stable file names: every publish writes a new
 * deployment id, and the report/summary file names are GUIDs that change when
 * Ameren redeploys the map. This worker therefore *discovers* the current file
 * layout on each run instead of hardcoding paths, then reduces the raw payloads
 * to the handful of facts an emergency-management watch desk needs.
 *
 * Discovery chain (each step's output names the next step's URL):
 *   1. outagemap.ameren.com/external/default.html   → instanceId + viewId
 *   2. /stormcenters/{instance}/views/{view}/currentState → deployment + data paths
 *   3. .../configuration/{deployment}               → report + summary file names
 *   4. data/{gen}/public/...                        → the actual numbers
 *
 * Routes:
 *   /ameren            campus snapshot: totals, nearby outages, county rows
 *   /ameren/raw        the discovered file layout (for debugging a redeploy)
 *   /stlwater          City of St. Louis Water Division outages + repairs, parsed
 *   /localnews         St. Louis outlet RSS, merged and hazard-filtered
 *   /metro             Metro Transit GTFS-RT: alerts, delays, vehicles near campus
 *   /health            liveness + which discovery steps succeeded
 *
 * Query params on /ameren:
 *   radius   miles around Brookings Hall for the outage ring   (default 10)
 *   lat,lon  override the ring centre
 *   counties comma-separated county names for the table        (default STL metro)
 *
 * Deploy:  npx wrangler deploy
 * No API keys are required — everything here is public, so the routes are
 * CORS-open and need no origin configuration.
 */

// This worker holds no credentials and reads only data Ameren already publishes
// to the open web, so it is CORS-open. An allowlist here would add a silent
// failure mode (every unlisted origin sees "Failed to fetch") while protecting
// nothing. Lock it down only if you later add a keyed route.
const ALLOW_ORIGIN = "*";

const BOOTSTRAP = "https://outagemap.ameren.com/external/default.html";
const KUBRA = "https://kubra.io";
const CAMPUS = { lat: 38.6488, lon: -90.3108, label: "Brookings Hall" };

// Counties Ameren serves that matter to campus operations and commuting staff.
const DEFAULT_COUNTIES = [
  "Missouri|St. Louis city",
  "Missouri|St. Louis",
  "Missouri|St. Charles",
  "Missouri|Jefferson",
  "Missouri|Franklin",
  "Illinois|Madison",
  "Illinois|St. Clair",
  "Illinois|Monroe"
];

// The map's own zoom-10 tiles carry individual (unclustered) outages in this
// region, so one zoom level is enough to cover a campus-scale ring.
const TILE_ZOOM = 10;

const EDGE_TTL = 120;      // seconds to cache the reduced snapshot
const LAYOUT_TTL = 900;    // file layout changes only on redeploy

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "public, max-age=" + EDGE_TTL
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json" }
      });

    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health") {
        const layout = await discover().catch(e => ({ error: String(e.message || e) }));
        return json({
          ok: !layout.error,
          discovery: layout.error ? "failed: " + layout.error : "ok",
          deployment: layout.deploymentId || null,
          generatedFrom: layout.generationPath || null,
          files: layout.error ? null : {
            summary: !!layout.summary,
            countyReport: !!layout.reports.county,
            zipReport: !!layout.reports.zip,
            clusterTiles: !!layout.clusterTemplate
          },
          checkedAt: new Date().toISOString()
        }, layout.error ? 502 : 200);
      }

      if (path === "/ameren/raw") {
        return json(await discover());
      }

      if (path === "/cybernews") {
        const hours = clamp(parseFloat(url.searchParams.get("hours")) || 48, 1, 336);
        return json(await cyberNews(hours));
      }

      if (path === "/ransomware") {
        const days = clamp(parseFloat(url.searchParams.get("days")) || 30, 1, 180);
        const scope = url.searchParams.get("scope") === "all" ? "all" : "sectors";
        return json(await ransomwareVictims(days, scope));
      }

      if (path === "/healthnews") {
        const hours = clamp(parseFloat(url.searchParams.get("hours")) || 24, 1, 336);
        return json(await healthNews(hours));
      }

      if (path === "/crashes") {
        const troop = (url.searchParams.get("troop") || "C").toUpperCase().slice(0, 1);
        const counties = (url.searchParams.get("counties") || "ST. LOUIS,ST. LOUIS CITY,ST. CHARLES,JEFFERSON,FRANKLIN")
          .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
        const days = clamp(parseFloat(url.searchParams.get("days")) || 7, 1, 29);
        const geo = url.searchParams.get("geocode") !== "0";
        return json(await mshpCrashes(troop, counties, days, geo));
      }

      if (path === "/stlwater") {
        return json(await stlWater());
      }

      if (path === "/metro") {
        const radius = clamp(parseFloat(url.searchParams.get("radius")) || 3, 0.5, 25);
        const lat = parseFloat(url.searchParams.get("lat"));
        const lon = parseFloat(url.searchParams.get("lon"));
        return json(await metro(
          isFinite(lat) && isFinite(lon) ? { lat, lon } : CAMPUS,
          radius
        ));
      }

      if (path === "/localnews") {
        const hours = clamp(parseFloat(url.searchParams.get("hours")) || 24, 1, 72);
        return json(await localNews(hours));
      }

      if (path === "/ameren") {
        const radius = clamp(parseFloat(url.searchParams.get("radius")) || 10, 1, 60);
        const lat = parseFloat(url.searchParams.get("lat"));
        const lon = parseFloat(url.searchParams.get("lon"));
        const centre = isFinite(lat) && isFinite(lon)
          ? { lat, lon, label: "custom point" }
          : CAMPUS;
        const counties = (url.searchParams.get("counties") || "")
          .split(",").map(s => s.trim()).filter(Boolean);
        return json(await snapshot({
          centre,
          radius,
          counties: counties.length ? counties : DEFAULT_COUNTIES
        }));
      }

      // The bare origin is what a browser or the dashboard preview hits first;
      // answer it with an index rather than an error.
      if (path === "/") {
        return json({
          service: "WashU EM — utility outage scraper",
          routes: {
            "/ameren": "campus snapshot (params: radius, lat, lon, counties)",
            "/ameren/raw": "discovered KUBRA file layout",
            "/stlwater": "City of St. Louis Water Division outages and repairs",
            "/localnews": "St. Louis outlet RSS, merged and hazard-filtered (params: hours)",
            "/healthnews": "national public health outlet RSS, merged and threat-classified (params: hours)",
            "/cybernews": "CISA advisories, HC3 and security press RSS, merged and sector-classified (params: hours)",
            "/ransomware": "ransomware.live victims filtered to healthcare, research and education (params: days)",
            "/metro": "Metro Transit GTFS-RT decoded (params: radius, lat, lon)",
            "/health": "liveness + discovery status"
          }
        });
      }

      return json({ error: "Unknown route", routes: ["/ameren", "/ameren/raw", "/health"] }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  }
};

/* ---------- discovery ---------------------------------------------------- */

async function discover() {
  const cached = await fromCache("layout");
  if (cached) return cached;

  // 1. The map shell carries the tenant ids in an inline BOOTSTRAP_CONFIG.
  const shell = await text(BOOTSTRAP);
  const instanceId = (shell.match(/instanceId:\s*'([0-9a-f-]{36})'/) || [])[1];
  const viewId = (shell.match(/viewId:\s*'([0-9a-f-]{36})'/) || [])[1];
  if (!instanceId || !viewId) throw new Error("Could not read instanceId/viewId from the map shell");

  // 2. Current state names the live data generation and the deployment config.
  const stateUrl = `${KUBRA}/stormcenter/api/v1/stormcenters/${instanceId}/views/${viewId}/currentState?preview=false`;
  const state = await json(stateUrl);
  const generationPath = state.data && state.data.interval_generation_data;
  const clusterPath = state.data && state.data.cluster_interval_generation_data;
  if (!generationPath) throw new Error("currentState carried no interval_generation_data");

  // 3. The deployment config names the report and summary files (GUIDs that
  //    change on redeploy), plus the cluster tile template.
  const cfgUrl = `${KUBRA}/stormcenter/api/v1/stormcenters/${instanceId}/views/${viewId}/configuration/${state.stormcenterDeploymentId}?preview=false`;
  const cfgText = await text(cfgUrl);

  const sources = [...cfgText.matchAll(/"source"\s*:\s*(?:\[\s*)?"([^"]+)"/g)].map(m => m[1]);
  const reportFiles = sources.filter(s => /^public\/reports\/.+_report\.json$/.test(s));
  const summaryFile = sources.find(s => /^public\/summary-\d+\/data\.json$/.test(s));
  const clusterFile = sources.find(s => /\{q\}/.test(s)) || "public/cluster-1/{q}.json";

  // Report files are only distinguishable by their internal file_title, so read
  // the titles rather than assuming an order.
  const reports = {};
  await Promise.all(reportFiles.map(async f => {
    const body = await json(`${KUBRA}/${generationPath}/${f}`).catch(() => null);
    if (!body) return;
    const title = String(body.file_title || "");
    if (/county/i.test(title)) reports.county = f;
    else if (/zip/i.test(title)) reports.zip = f;
  }));

  const layout = {
    instanceId,
    viewId,
    deploymentId: state.stormcenterDeploymentId,
    generationPath,
    clusterBase: clusterPath || null,
    clusterTemplate: clusterFile,
    summary: summaryFile || null,
    reports,
    updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    discoveredAt: new Date().toISOString()
  };
  await toCache("layout", layout, LAYOUT_TTL);
  return layout;
}

/* ---------- snapshot ------------------------------------------------------ */

async function snapshot(opts) {
  const layout = await discover();
  const base = `${KUBRA}/${layout.generationPath}/`;

  const [summary, county, outages] = await Promise.all([
    layout.summary ? json(base + layout.summary).catch(() => null) : null,
    layout.reports.county ? json(base + layout.reports.county).catch(() => null) : null,
    clusterOutages(layout, opts.centre, opts.radius).catch(e => ({ error: String(e.message || e) }))
  ]);

  /* System totals. Ameren publishes one total per operating company; label them
     by the state that dominates the matching report tree rather than guessing. */
  const totals = [];
  const sd = summary && summary.summaryFileData;
  if (sd && Array.isArray(sd.totals)) {
    sd.totals.forEach(t => totals.push({
      id: t.summaryTotalId,
      customersOut: num(t.total_cust_a),
      customersServed: t.total_cust_s || null,
      percentOut: num(t.total_percent_cust_a),
      outages: t.total_outages || 0
    }));
  }

  /* County rows, flattened out of the state → county tree. */
  const byKey = new Map();
  if (county && county.file_data && Array.isArray(county.file_data.areas)) {
    county.file_data.areas.forEach(state => {
      (state.areas || []).forEach(c => {
        // Ameren publishes some counties twice (separate operating divisions),
        // so accumulate rather than overwrite.
        const key = (state.name + "|" + c.name).toLowerCase();
        const row = byKey.get(key) || {
          county: c.name, state: state.name,
          customersOut: 0, customersServed: 0, outages: 0, etr: null, rows: 0
        };
        row.customersOut += num(c.cust_a);
        row.customersServed += c.cust_s || 0;
        row.outages += c.n_out || 0;
        row.etr = row.etr || cleanEtr(c.etr);
        row.rows++;
        byKey.set(key, row);
      });
    });
  }
  const countyRows = [...byKey.values()].map(r => ({
    county: r.county,
    state: r.state,
    customersOut: r.customersOut,
    customersServed: r.customersServed,
    percentOut: r.customersServed ? round(100 * r.customersOut / r.customersServed, 3) : 0,
    outages: r.outages,
    etr: r.etr,
    mergedDivisions: r.rows > 1 ? r.rows : undefined
  }));

  const watched = opts.counties.map(spec => {
    // Accept "State|County" or a bare county name (first match wins on a bare
    // name, which is why the defaults are all state-qualified).
    const [a, b] = spec.includes("|") ? spec.split("|") : [null, spec];
    const hit = countyRows.find(r => b.toLowerCase() === r.county.toLowerCase()
      && (!a || a.toLowerCase() === r.state.toLowerCase()));
    return hit || {
      county: b, state: a, customersOut: 0, customersServed: 0,
      percentOut: 0, outages: 0, etr: null, notFound: true
    };
  });

  const near = Array.isArray(outages) ? outages : [];
  const causes = {};
  near.forEach(o => { if (o.cause) causes[o.cause] = (causes[o.cause] || 0) + 1; });

  const etrs = near.map(o => o.etr).filter(e => e && /^\d{4}-/.test(e)).sort();

  return {
    source: "Ameren public outage map (KUBRA StormCenter)",
    attribution: "outagemap.ameren.com",
    mode: sd && sd.page_mode ? sd.page_mode.mode : null,          // BLUESKY | STORM
    publishPaused: !!(sd && sd.page_mode && sd.page_mode.pausePublish),
    dataGeneratedAt: sd ? sd.date_generated : null,
    mapUpdatedAt: layout.updatedAt,
    fetchedAt: new Date().toISOString(),
    ring: {
      centre: opts.centre,
      radiusMiles: opts.radius,
      outages: near.length,
      customersOut: near.reduce((n, o) => n + (o.customersOut || 0), 0),
      largest: near.reduce((m, o) => Math.max(m, o.customersOut || 0), 0),
      nearestMiles: near.length ? near[0].miles : null,
      causeCounts: Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([cause, n]) => ({ cause, n })),
      earliestEtr: etrs[0] || null,
      latestEtr: etrs[etrs.length - 1] || null,
      expiredEtrs: near.filter(o => o.etr === "past estimate").length
    },
    systemTotals: totals,
    countiesWatched: watched,
    worstCounties: countyRows
      .filter(r => r.customersOut > 0)
      .sort((a, b) => b.customersOut - a.customersOut)
      .slice(0, 8),
    outages: near,
    notes: Array.isArray(outages) ? [] : ["Outage tiles unavailable: " + outages.error]
  };
}

/* ---------- cluster tiles ------------------------------------------------ */

async function clusterOutages(layout, centre, radiusMiles) {
  if (!layout.clusterBase) throw new Error("currentState carried no cluster data path");

  const tiles = tilesForRadius(centre, radiusMiles, TILE_ZOOM);
  const results = await Promise.all(tiles.map(async q => {
    // The cluster path is templated on {qkh} — the last three characters of the
    // quadkey, reversed — which shards the bucket. The map's own code derives it
    // exactly this way.
    const dir = layout.clusterBase.replace("{qkh}", q.slice(-3).split("").reverse().join(""));
    const file = layout.clusterTemplate.replace("{q}", q);
    const body = await json(`${KUBRA}/${dir}/${file}`).catch(() => null);
    return body && Array.isArray(body.file_data) ? body.file_data : [];
  }));

  const seen = new Set();
  const out = [];
  results.flat().forEach(f => {
    const d = f.desc || {};
    const pt = f.geom && Array.isArray(f.geom.p) && f.geom.p.length
      ? decodePolyline(f.geom.p[0])[0]
      : null;
    if (!pt) return;
    const [lat, lon] = pt;
    const miles = haversineMiles(centre.lat, centre.lon, lat, lon);
    if (miles > radiusMiles) return;
    const key = f.id + "|" + lat.toFixed(5) + "," + lon.toFixed(5);
    if (seen.has(key)) return;                 // tiles overlap at their edges
    seen.add(key);
    out.push({
      id: f.id,
      lat: round(lat, 5),
      lon: round(lon, 5),
      miles: round(miles, 2),
      bearing: bearing(centre.lat, centre.lon, lat, lon),
      customersOut: num(d.cust_a),
      outageCount: d.n_out || 1,
      isCluster: !!d.cluster,
      cause: pick(d.cause),
      crewStatus: pick(d.crew_status),
      etr: cleanEtr(d.etr),
      startedAt: d.start_time || null,
      durationHours: d.start_time ? round((Date.now() - Date.parse(d.start_time)) / 3600000, 1) : null,
      comments: d.comments || null
    });
  });

  return out.sort((a, b) => a.miles - b.miles);
}

/* ---------- City of St. Louis Water Division ----------------------------- */

/* The Water Division publishes two tables on one Elementor page and no feed of
   any kind. Column headers identify which table is which — position is not
   reliable, since the "Current Advisories" block appears and disappears. */
async function stlWater() {
  const res = await fetch("https://www.stlwater.com/outages/", {
    headers: { "User-Agent": "WashU-EM-Dashboard/1.0 (situational awareness)" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!res.ok) throw new Error(res.status + " from stlwater.com");

  const tables = [];
  let cur = null, row = null, cell = null, inHead = false;
  let updatedText = "", stampFound = null;

  const rewriter = new HTMLRewriter()
    .on("table", {
      element(el) {
        cur = { headers: [], rows: [] };
        tables.push(cur);
        el.onEndTag(() => { cur = null; });
      }
    })
    .on("th", {
      element() { inHead = true; cell = ""; },
      text(t) { if (cell !== null) cell += t.text; }
    })
    .on("tr", {
      element(el) {
        row = [];
        el.onEndTag(() => {
          if (!cur || !row) return;
          if (inHead && !cur.headers.length) cur.headers = row.map(clean);
          else if (row.some(c => clean(c))) cur.rows.push(row.map(clean));
          row = null;
          inHead = false;
        });
      }
    })
    .on("td", {
      element() { cell = ""; },
      text(t) { if (cell !== null) cell += t.text; }
    })
    // Cells close before their row does, so push on the cell's end tag.
    .on("td, th", {
      element(el) {
        el.onEndTag(() => { if (row && cell !== null) row.push(cell); cell = null; });
      }
    })
    // "Last Updated" and its timestamp sit in separate inline elements, so keep a
    // short rolling tail of page text and match across the boundary.
    .on("*", {
      text(t) {
        updatedText = (updatedText + t.text).slice(-400);
        if (!stampFound) {
          const m = updatedText.match(/Last Updated\s*(\d{1,2}:\d{2}\s*[ap]m,?\s*[A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
          if (m) stampFound = clean(m[1]);
        }
      }
    });

  await rewriter.transform(res).arrayBuffer();

  const find = re => tables.find(t => t.headers.some(h => re.test(h)));
  const outageTable = find(/taken out of service/i);
  const repairTable = find(/work order/i);

  const outages = (outageTable ? outageTable.rows : []).map(r => ({
    outSince: r[0] || null,
    estimatedRestore: r[1] || null,
    location: r[2] || null,
    hoursOut: hoursSince(r[0]),
    overdue: isPast(r[1])
  })).filter(o => o.location);

  const repairs = (repairTable ? repairTable.rows : []).map(r => ({
    initiated: r[0] || null,
    work: r[1] || null,
    location: r[2] || null,
    daysAgo: daysSince(r[0])
  })).filter(o => o.location);

  const stamp = stampFound;

  return {
    source: "City of St. Louis Water Division",
    attribution: "stlwater.com/outages",
    pageUpdated: stamp,
    fetchedAt: new Date().toISOString(),
    tablesSeen: tables.length,
    outages,
    repairs,
    counts: {
      outages: outages.length,
      overdueRestores: outages.filter(o => o.overdue).length,
      repairs: repairs.length,
      repairsLast48h: repairs.filter(r => r.daysAgo != null && r.daysAgo <= 2).length
    },
    emergencyLine: "(314) 771-4880"
  };
}

// Dates on the page are local Central wall-clock with no zone marker; treat them
// as Central rather than letting the runtime assume UTC.
function parseCentral(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let hour = parseInt(m[4], 10) % 12;
  if (/pm/i.test(m[6])) hour += 12;
  // Central is UTC-5 in daylight time, UTC-6 in standard time; the page only
  // ever shows recent dates, so pick by month rather than a full tz library.
  const month = parseInt(m[1], 10);
  const offset = month >= 4 && month <= 10 ? 5 : 6;
  return Date.UTC(+m[3], month - 1, +m[2], hour + offset, +m[5]);
}

function hoursSince(s) {
  const t = parseCentral(s);
  return t == null ? null : round((Date.now() - t) / 3600000, 1);
}

function daysSince(s) {
  const t = parseCentral(s);
  return t == null ? null : round((Date.now() - t) / 86400000, 1);
}

function isPast(s) {
  const t = parseCentral(s);
  return t == null ? false : Date.now() > t;
}

const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/* ---------- Metro Transit GTFS-RT --------------------------------------- */

/* Metro publishes three protobuf feeds and no JSON equivalent, so the payload
   has to be decoded on the wire. Rather than bundle protobufjs, this reads the
   protobuf wire format directly against the GTFS-RT schema: the format is
   self-describing enough that a field-number walk is short, exact, and has no
   dependency to keep current. Field numbers below are from gtfs-realtime.proto. */

const GTFS = {
  trips: "https://www.metrostlouis.org/RealTimeData/StlRealTimeTrips.pb",
  vehicles: "https://www.metrostlouis.org/RealTimeData/StlRealTimeVehicles.pb",
  alerts: "https://www.metrostlouis.org/RealTimeData/StlRealTimeAlerts.pb"
};

const CAUSE = [null, "Unknown cause", "Other cause", "Technical problem", "Strike",
  "Demonstration", "Accident", "Holiday", "Weather", "Maintenance", "Construction",
  "Police activity", "Medical emergency"];
const EFFECT = [null, "No service", "Reduced service", "Significant delays", "Detour",
  "Additional service", "Modified service", "Other effect", "Unknown effect", "Stop moved"];
const VEHICLE_STATUS = ["Approaching stop", "Stopped at stop", "In transit to stop"];
const OCCUPANCY = ["Empty", "Many seats available", "Few seats available",
  "Standing room only", "Crushed standing room", "Full", "Not accepting passengers"];

// Reads one length-delimited protobuf message into { fieldNumber: [values] }.
// Varints stay as BigInt-free numbers (GTFS-RT never exceeds 2^53 in practice).
function pbParse(bytes) {
  const out = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const varint = () => {
    let result = 0, shift = 0, b;
    do {
      b = bytes[i++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b & 0x80 && i < bytes.length);
    return result;
  };
  const push = (f, v) => { (out[f] = out[f] || []).push(v); };
  while (i < bytes.length) {
    const key = varint();
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) push(field, varint());
    else if (wire === 1) { push(field, dv.getFloat64(i, true)); i += 8; }
    else if (wire === 2) {
      const len = varint();
      push(field, bytes.subarray(i, i + len));
      i += len;
    }
    else if (wire === 5) { push(field, dv.getFloat32(i, true)); i += 4; }
    else if (wire === 3 || wire === 4) { /* groups: not used by GTFS-RT */ }
    else break;
  }
  return out;
}

const pbOne = (m, f) => (m[f] && m[f][0] !== undefined) ? m[f][0] : null;
const pbMsg = (m, f) => { const v = pbOne(m, f); return v instanceof Uint8Array ? pbParse(v) : null; };
const pbAll = (m, f) => (m[f] || []).filter(v => v instanceof Uint8Array).map(pbParse);
const pbStr = (m, f) => { const v = pbOne(m, f); return v instanceof Uint8Array ? new TextDecoder().decode(v) : null; };
// int32 fields carry negative values as two's complement in a 64-bit varint.
const pbInt = (m, f) => { const v = pbOne(m, f); return typeof v === "number" ? (v > 2147483647 ? v - 4294967296 : v) : null; };

// TranslatedString → the English text, or the first translation offered.
function pbText(m, f) {
  const ts = pbMsg(m, f);
  if (!ts) return null;
  const translations = pbAll(ts, 1);
  const en = translations.find(t => /^en/i.test(pbStr(t, 2) || "en"));
  return pbStr(en || translations[0] || {}, 1);
}

async function pbFetch(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "WashU-EM-Dashboard/1.0 (situational awareness)" },
    cf: { cacheTtl: 20, cacheEverything: true }
  });
  if (!r.ok) throw new Error(r.status + " from " + new URL(url).pathname);
  return pbParse(new Uint8Array(await r.arrayBuffer()));
}

async function metro(centre, radiusMiles) {
  const [alertsFeed, tripsFeed, vehiclesFeed] = await Promise.all([
    pbFetch(GTFS.alerts).catch(e => ({ __err: String(e.message || e) })),
    pbFetch(GTFS.trips).catch(e => ({ __err: String(e.message || e) })),
    pbFetch(GTFS.vehicles).catch(e => ({ __err: String(e.message || e) }))
  ]);

  const errors = {};
  const feedStamp = f => { const h = pbMsg(f, 1); const t = h ? pbOne(h, 3) : null; return t ? new Date(t * 1000).toISOString() : null; };

  /* Service alerts — the only feed with human-written text, and the one a watch
     desk reads first. */
  const alerts = [];
  if (alertsFeed.__err) errors.alerts = alertsFeed.__err;
  else pbAll(alertsFeed, 2).forEach(entity => {
    const a = pbMsg(entity, 5);
    if (!a) return;
    const routes = pbAll(a, 5).map(sel => pbStr(sel, 2)).filter(Boolean);
    const stops = pbAll(a, 5).map(sel => pbStr(sel, 4)).filter(Boolean);
    const periods = pbAll(a, 1).map(tr => ({
      start: pbOne(tr, 1) ? new Date(pbOne(tr, 1) * 1000).toISOString() : null,
      end: pbOne(tr, 2) ? new Date(pbOne(tr, 2) * 1000).toISOString() : null
    }));
    const active = !periods.length || periods.some(p =>
      (!p.start || Date.parse(p.start) <= Date.now()) &&
      (!p.end || Date.parse(p.end) >= Date.now()));
    alerts.push({
      id: pbStr(entity, 1),
      header: pbText(a, 10),
      description: pbText(a, 11),
      url: pbText(a, 8),
      cause: CAUSE[pbOne(a, 6)] || null,
      effect: EFFECT[pbOne(a, 7)] || null,
      routes: [...new Set(routes)],
      stops: [...new Set(stops)],
      activePeriods: periods,
      active: active
    });
  });

  /* Trip updates → delay, aggregated by route. A single late bus is noise; a
     route running consistently late is the signal. */
  const byRoute = new Map();
  let tripsSeen = 0;
  if (tripsFeed.__err) errors.trips = tripsFeed.__err;
  else pbAll(tripsFeed, 2).forEach(entity => {
    const tu = pbMsg(entity, 3);
    if (!tu) return;
    tripsSeen++;
    const trip = pbMsg(tu, 1);
    const route = (trip && pbStr(trip, 2)) || "unknown";
    // Prefer the trip-level delay; fall back to the next stop's arrival delay.
    let delay = pbInt(tu, 5);
    if (delay === null) {
      const stu = pbAll(tu, 3)[0];
      const ev = stu && (pbMsg(stu, 2) || pbMsg(stu, 3));
      if (ev) delay = pbInt(ev, 1);
    }
    if (delay === null) return;
    const r = byRoute.get(route) || { route: route, trips: 0, delays: [] };
    r.trips++;
    r.delays.push(delay);
    byRoute.set(route, r);
  });

  const routeDelays = [...byRoute.values()].map(r => {
    const sorted = r.delays.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      route: r.route,
      trips: r.trips,
      medianDelayMin: round(median / 60, 1),
      worstDelayMin: round(sorted[sorted.length - 1] / 60, 1),
      lateTrips: r.delays.filter(d => d >= 300).length      // 5 minutes or more
    };
  }).sort((a, b) => b.medianDelayMin - a.medianDelayMin);

  /* Vehicle positions → what is actually near campus right now. */
  const vehicles = [];
  let vehiclesSeen = 0;
  if (vehiclesFeed.__err) errors.vehicles = vehiclesFeed.__err;
  else pbAll(vehiclesFeed, 2).forEach(entity => {
    const vp = pbMsg(entity, 4);
    if (!vp) return;
    vehiclesSeen++;
    const pos = pbMsg(vp, 2);
    if (!pos) return;
    const lat = pbOne(pos, 1), lon = pbOne(pos, 2);
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const miles = haversineMiles(centre.lat, centre.lon, lat, lon);
    if (miles > radiusMiles) return;
    const trip = pbMsg(vp, 1);
    const desc = pbMsg(vp, 8);
    const ts = pbOne(vp, 5);
    vehicles.push({
      id: (desc && (pbStr(desc, 2) || pbStr(desc, 1))) || pbStr(entity, 1),
      route: trip ? pbStr(trip, 2) : null,
      lat: round(lat, 5),
      lon: round(lon, 5),
      miles: round(miles, 2),
      bearing: bearing(centre.lat, centre.lon, lat, lon),
      headingDeg: typeof pbOne(pos, 3) === "number" ? Math.round(pbOne(pos, 3)) : null,
      speedMph: typeof pbOne(pos, 5) === "number" ? round(pbOne(pos, 5) * 2.23694, 1) : null,
      status: VEHICLE_STATUS[pbOne(vp, 4)] || null,
      occupancy: OCCUPANCY[pbOne(vp, 9)] || null,
      stopId: pbStr(vp, 7),
      reportedAt: ts ? new Date(ts * 1000).toISOString() : null,
      staleSeconds: ts ? Math.round(Date.now() / 1000 - ts) : null
    });
  });
  vehicles.sort((a, b) => a.miles - b.miles);

  const activeAlerts = alerts.filter(a => a.active);
  const allDelays = [...byRoute.values()].flatMap(r => r.delays);
  const lateCount = allDelays.filter(d => d >= 300).length;

  return {
    source: "Metro Transit (Bi-State Development) GTFS-RT",
    attribution: "metrostlouis.org/developer-resources",
    decoded: "protobuf read on the wire — Metro publishes no JSON feed",
    fetchedAt: new Date().toISOString(),
    feedTimestamps: {
      alerts: alertsFeed.__err ? null : feedStamp(alertsFeed),
      trips: tripsFeed.__err ? null : feedStamp(tripsFeed),
      vehicles: vehiclesFeed.__err ? null : feedStamp(vehiclesFeed)
    },
    ring: {
      centre: centre,
      radiusMiles: radiusMiles,
      vehicles: vehicles.length,
      nearestMiles: vehicles.length ? vehicles[0].miles : null,
      routes: [...new Set(vehicles.map(v => v.route).filter(Boolean))].sort()
    },
    counts: {
      activeAlerts: activeAlerts.length,
      alertsTotal: alerts.length,
      tripsReporting: tripsSeen,
      tripsLate5Min: lateCount,
      vehiclesReporting: vehiclesSeen,
      medianSystemDelayMin: allDelays.length
        ? round(allDelays.slice().sort((a, b) => a - b)[Math.floor(allDelays.length / 2)] / 60, 1)
        : null
    },
    alerts: activeAlerts,
    routeDelays: routeDelays.slice(0, 12),
    vehicles: vehicles.slice(0, 25),
    notes: Object.keys(errors).length
      ? Object.entries(errors).map(([k, v]) => k + " feed unavailable: " + v)
      : []
  };
}

/* ---------- local outlet RSS -------------------------------------------- */

/* GDELT's corpus is global, so a KSDK or St. Louis Public Radio story can break
   without ever entering it. These are the outlets a watch desk would actually
   have open. None send CORS headers, so the browser cannot read them directly —
   hence this route. Feeds are fetched in parallel and one failure never sinks
   the rest; the response reports which outlets answered. */
const OUTLETS = [
  { name: "KSDK (NBC 5)", url: "https://www.ksdk.com/feeds/syndication/rss/news/local" },
  { name: "St. Louis Public Radio", url: "https://www.stlpr.org/news.rss" },
  { name: "Fox 2 / KPLR", url: "https://fox2now.com/feed/" },
  { name: "KMOV (News 4)", url: "https://www.kmov.com/arc/outboundfeeds/rss/?outputType=xml" },
  { name: "First Alert 4 (KMOV)", url: "https://www.firstalert4.com/arc/outboundfeeds/rss/?outputType=xml" },
  { name: "St. Louis Post-Dispatch", url: "https://www.stltoday.com/search/?f=rss&t=article&c=news/local&l=50" },
  { name: "Riverfront Times", url: "https://www.riverfronttimes.com/stlouis/rss.html" },
  { name: "St. Louis Business Journal", url: "https://www.bizjournals.com/stlouis/news/rss.xml" },
  { name: "City of St. Louis newsroom", url: "https://www.stlouis-mo.gov/rss/news.cfm" },
  { name: "NWS St. Louis (LSX)", url: "https://api.weather.gov/alerts/active.atom?area=MO" }
];

// Two tiers, mirroring the ngrams monitor: a hazard term, or a campus-area
// reference that matters regardless of hazard wording.
const NEWS_HAZARD = /\b(tornado|flood(ing|ed)?|flash flood|storm|hail|severe weather|evacuat\w*|shelter in place|outage|power out|wildfire|brush fire|hazmat|gas leak|water main|boil (order|advisory)|shooting|shots fired|active shooter|standoff|lockdown|protest\w*|road closed|closure|derail\w*|crash|fatal|emergency|heat advisory|air quality|state of emergency|mass casualty|building collapse)\b/i;
const NEWS_CAMPUS = /\b(washington university|washu|wustl|barnes[- ]jewish|siteman|danforth|delmar loop|the loop|forest park|central west end|cwe|university city|u\. ?city|skinker|debaliviere|clayton|forest park (parkway|ave))\b/i;

async function localNews(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;

  const settled = await Promise.all(OUTLETS.map(async o => {
    try {
      const r = await fetch(o.url, {
        headers: {
          "User-Agent": "WashU-EM-Dashboard/1.0 (situational awareness)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (!r.ok) return { outlet: o.name, ok: false, detail: "HTTP " + r.status, items: [] };
      return { outlet: o.name, ok: true, items: parseFeed(await r.text(), o.name) };
    } catch (e) {
      return { outlet: o.name, ok: false, detail: String(e.message || e).slice(0, 60), items: [] };
    }
  }));

  const seen = new Set();
  const items = [];
  settled.forEach(s => s.items.forEach(it => {
    const when = Date.parse(it.published);
    if (!isNaN(when) && when < cutoff) return;
    // Outlets syndicate each other; key on the headline, not the URL.
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
    if (!key || seen.has(key)) return;
    seen.add(key);

    const text = it.title + " " + (it.summary || "");
    const hazard = NEWS_HAZARD.test(text);
    const campus = NEWS_CAMPUS.test(text);
    if (!hazard && !campus) return;

    items.push({
      title: it.title,
      url: it.url,
      outlet: s.outlet,
      published: isNaN(when) ? null : new Date(when).toISOString(),
      ageHours: isNaN(when) ? null : round((Date.now() - when) / 3600000, 1),
      why: [campus ? "campus area" : null, hazard ? "hazard term" : null].filter(Boolean).join(" · "),
      // Campus-area mentions outrank generic metro hazard coverage.
      rank: (campus ? 2 : 0) + (hazard ? 1 : 0),
      summary: (it.summary || "").slice(0, 300) || null
    });
  }));

  items.sort((a, b) => b.rank - a.rank || (a.ageHours == null ? 1 : b.ageHours == null ? -1 : a.ageHours - b.ageHours));

  const ok = settled.filter(s => s.ok);
  return {
    source: "St. Louis outlet RSS, merged",
    windowHours: hours,
    fetchedAt: new Date().toISOString(),
    outlets: settled.map(s => ({ outlet: s.outlet, ok: s.ok, items: s.items.length, detail: s.detail || null })),
    outletsAnswering: ok.length,
    outletsTotal: OUTLETS.length,
    itemsScanned: settled.reduce((n, s) => n + s.items.length, 0),
    counts: {
      relevant: items.length,
      campusArea: items.filter(i => /campus area/.test(i.why)).length,
      lastSixHours: items.filter(i => i.ageHours != null && i.ageHours <= 6).length
    },
    items: items.slice(0, 30)
  };
}

/* ---------- cybersecurity advisories, press and ransomware --------------

   CISA's own advisory feeds, HHS HC3 health-sector alerts and the security trade
   press all refuse CORS, which is what this route is for. The sector tagging is
   the point: a watch desk at an academic medical centre needs to know whether an
   item touches patient care, a research environment, or campus IT — those are
   three different escalation paths with three different owners.

   Classification is keyword-based and reported as such, never as a verdict. */
const CYBER_SOURCES = [
  { name: "CISA · advisories", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml", official: true },
  { name: "CISA · ICS & medical devices", url: "https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml", official: true, ics: true },
  { name: "CISA · ICS medical advisories", url: "https://www.cisa.gov/cybersecurity-advisories/ics-medical-advisories.xml", official: true, ics: true },
  { name: "HHS HC3 · health sector", url: "https://www.hhs.gov/sites/default/files/rss/hc3.xml", official: true },
  { name: "The Record", url: "https://therecord.media/feed" },
  { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/" },
  { name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/" },
  { name: "SecurityWeek", url: "https://www.securityweek.com/feed/" },
  { name: "HealthTech Security", url: "https://www.techtarget.com/healthtechsecurity/rss/all" },
  { name: "EDUCAUSE Review", url: "https://er.educause.edu/rss" },
  { name: "Higher-ed incidents", url: "https://news.google.com/rss/search?q=when:3d+(university+OR+college+OR+%22higher+education%22)+(ransomware+OR+%22data+breach%22+OR+cyberattack+OR+%22network+outage%22)&hl=en-US&gl=US&ceid=US:en" },
  { name: "Health system incidents", url: "https://news.google.com/rss/search?q=when:3d+(hospital+OR+%22health+system%22+OR+clinic)+(ransomware+OR+%22data+breach%22+OR+cyberattack+OR+%22EHR+downtime%22)&hl=en-US&gl=US&ceid=US:en" },
  { name: "Research security incidents", url: "https://news.google.com/rss/search?q=when:3d+(%22research+institution%22+OR+laboratory+OR+biotech)+(ransomware+OR+%22data+breach%22+OR+%22intellectual+property+theft%22+OR+espionage)&hl=en-US&gl=US&ceid=US:en" }
];

const CYBER_SECTORS = [
  { key: "health", label: "Healthcare delivery",
    re: /\b(hospital|health system|healthcare|health care|patient|clinic|\behr\b|electronic health record|epic systems|cerner|oracle health|meditech|\bhipaa\b|\bphi\b|protected health information|medical device|infusion pump|ventilator|\bpacs\b|radiology|imaging system|pharmacy|dialysis|ambulance|\bems\b|nurse|physician|hc3|health-isac|change healthcare|ascension|kaiser|providence)\b/i },
  { key: "research", label: "Medical research",
    re: /\b(research (institution|university|lab|laboratory|data|computing)|laboratory|clinical trial|genomic|sequencing|biobank|redcap|\bhpc\b|high[- ]performance computing|supercomput\w+|illumina|thermo fisher|agilent|bruker|qiagen|benchling|labvantage|labarchives|globus|jupyter|intellectual property theft|espionage|\bnih\b|grant data|biotech|pharmaceutical)\b/i },
  { key: "education", label: "Higher education",
    re: /\b(universit\w+|college|campus|higher education|student (data|record|information)|\bsis\b|ellucian|banner|colleague|workday|peoplesoft|canvas|instructure|blackboard|moodle|brightspace|d2l|\blms\b|\bferpa\b|registrar|financial aid|admissions|shibboleth|\bincommon\b|\beduroam\b|ren-isac|educause|k-12|school district)\b/i }
];

// The technology families that actually sit between a hospital, a research
// environment and the internet. An advisory naming one of these is escalated
// regardless of which sector the prose happens to mention.
const CYBER_STACK = /\b(citrix|netscaler|vmware|esxi|vcenter|horizon|fortinet|fortigate|fortios|ivanti|pulse secure|connect secure|palo alto|globalprotect|pan-os|cisco (asa|ios|anyconnect|secure firewall|ise)|sonicwall|barracuda|\bf5\b|big-ip|progress|moveit|goanywhere|accellion|kiteworks|exchange server|active directory|azure ad|entra|microsoft 365|sharepoint|okta|duo security|manageengine|zoho|solarwinds|kaseya|connectwise|screenconnect|papercut|atlassian|confluence|jira|veeam|commvault|rubrik|vpn appliance|firewall|log4j|apache (struts|tomcat|http))\b/i;

const CYBER_THREATS = [
  { key: "exploited", label: "Actively exploited", re: /\b(actively exploited|exploited in the wild|zero[- ]day|0[- ]day|in[- ]the[- ]wild|under active (attack|exploitation)|\bkev\b|known exploited)\b/i },
  { key: "ransomware", label: "Ransomware", re: /\b(ransomware|ransom|encrypt\w+ (files|systems)|double extortion|data leak site|lockbit|clop|blackcat|alphv|akira|rhysida|inc ransom|interlock|qilin|medusa|play ransomware|hunters international)\b/i },
  { key: "breach", label: "Data breach", re: /\b(data breach|breach notification|exposed (records|data)|data (theft|stolen|leak)|exfiltrat\w+|unauthorized access|\bpii\b|credential (dump|theft|stuffing))\b/i },
  { key: "vuln", label: "Vulnerability & patching", re: /\b(vulnerabilit\w+|\bcve-\d{4}-\d+|patch(es|ed|ing)?|security update|advisory|hotfix|out[- ]of[- ]band update|critical flaw|rce\b|remote code execution|privilege escalation|authentication bypass)\b/i },
  { key: "phishing", label: "Phishing & social engineering", re: /\b(phish\w+|smish\w+|vish\w+|social engineering|business email compromise|\bbec\b|help ?desk (scam|impersonation)|mfa fatigue|push bombing|deepfake|impersonat\w+)\b/i },
  { key: "thirdparty", label: "Third party & supply chain", re: /\b(third[- ]party|supply chain|vendor (breach|incident|compromise)|business associate|managed service provider|\bmsp\b|software supply|dependency|upstream compromise|\bsbom\b)\b/i },
  { key: "ot", label: "OT, ICS & devices", re: /\b(\bics\b|\bot\b security|operational technology|scada|building (automation|management)|\bhvac\b|physical access control|iot|medical device|firmware|plc\b|modbus)\b/i }
];

const CYBER_NOISE = /\b(webinar|sponsored|whitepaper download|buyer'?s guide|best (vpn|antivirus|password manager)|coupon|black friday|hiring|job posting|conference registration|podcast episode \d+)\b/i;

async function cyberNews(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;

  const settled = await Promise.all(CYBER_SOURCES.map(async s => {
    try {
      const r = await fetch(s.url, {
        headers: {
          "User-Agent": "WashU-EM-Dashboard/1.0 (situational awareness)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        },
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      if (!r.ok) return { src: s, ok: false, detail: "HTTP " + r.status, items: [] };
      return { src: s, ok: true, items: parseFeed(await r.text(), s.name) };
    } catch (e) {
      return { src: s, ok: false, detail: String(e.message || e).slice(0, 60), items: [] };
    }
  }));

  const seen = new Set();
  const items = [];
  settled.forEach(s => s.items.forEach(it => {
    const when = Date.parse(it.published);
    if (!isNaN(when) && when < cutoff) return;
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
    if (!key || seen.has(key)) return;

    const text = it.title + " " + (it.summary || "");
    if (CYBER_NOISE.test(text)) return;

    const sectors = CYBER_SECTORS.filter(c => c.re.test(text)).map(c => c.key);
    const threats = CYBER_THREATS.filter(c => c.re.test(text)).map(c => c.key);
    const stack = CYBER_STACK.test(text);
    // An item earns its place by naming a sector, or by naming infrastructure the
    // sector runs. Generic security news with neither is dropped.
    if (!sectors.length && !stack && !s.src.official) return;
    if (!threats.length && !s.src.official) return;
    seen.add(key);

    const gnews = it.title.match(/^(.*)\s+-\s+([^-]{3,40})$/);
    const cves = [...new Set((text.match(/CVE-\d{4}-\d{4,7}/gi) || []).map(c => c.toUpperCase()))];
    items.push({
      title: gnews ? gnews[1].trim() : it.title,
      url: it.url,
      outlet: gnews ? gnews[2].trim() : s.src.name,
      via: gnews ? s.src.name : null,
      official: s.src.official || false,
      ics: s.src.ics || false,
      published: isNaN(when) ? null : new Date(when).toISOString(),
      ageHours: isNaN(when) ? null : round((Date.now() - when) / 3600000, 1),
      sectors, threats,
      stack: stack || null,
      cves: cves.length ? cves.slice(0, 6) : null,
      summary: (it.summary || "").slice(0, 400) || null
    });
  }));

  items.sort((a, b) => (a.ageHours == null ? 1 : b.ageHours == null ? -1 : a.ageHours - b.ageHours));

  const counts = { relevant: items.length, official: items.filter(i => i.official).length, stack: items.filter(i => i.stack).length };
  CYBER_SECTORS.forEach(c => { counts[c.key] = items.filter(i => i.sectors.includes(c.key)).length; });
  CYBER_THREATS.forEach(c => { counts[c.key] = items.filter(i => i.threats.includes(c.key)).length; });

  return {
    source: "CISA advisories, HHS HC3 and security trade press RSS, merged and sector-classified",
    note: "Advisories are official; press items are reporting, not notification. Sector and threat tags are keyword-based and shown so they can be judged.",
    windowHours: hours,
    fetchedAt: new Date().toISOString(),
    sectors: CYBER_SECTORS.map(c => ({ key: c.key, label: c.label })),
    threats: CYBER_THREATS.map(c => ({ key: c.key, label: c.label })),
    sources: settled.map(s => ({ outlet: s.src.name, ok: s.ok, items: s.items.length, detail: s.detail || null })),
    sourcesAnswering: settled.filter(s => s.ok).length,
    sourcesTotal: CYBER_SOURCES.length,
    counts,
    items: items.slice(0, 80)
  };
}

/* ransomware.live publishes a public victim feed built from the gangs' own leak
   sites. It is adversary-sourced: a listing means the group CLAIMS the victim,
   not that a breach is confirmed. That distinction is carried through to the UI.
   Sector is inferred from the victim's own description text, because the feed
   itself does not classify. */
/* The feed carries its own `activity` label ("Healthcare", "Education"). That is a
   far better sector signal than pattern-matching prose, so it is tried first and
   the description is only a fallback — recorded per victim as sectorSource, since
   a description match is a weaker claim than the feed's own classification. */
const RW_ACTIVITY = {
  health: /health|medical|hospital|pharma|dental|biotech|life scien|nursing|clinic/i,
  research: /research|laborator|scien|biotech|pharmaceutic/i,
  education: /education|academi|school|universit|college/i
};
const RW_SECTOR = {
  health: /\b(hospital|health|medical|clinic|patient|dental|pharmacy|surgery|physician|nursing|hospice|radiolog\w+|oncolog\w+|pediatric|orthopedic)\b/i,
  research: /\b(research institut\w+|research cent\w+|laborator\w+|biotech|genomic|clinical trial|pharmaceutical)\b/i,
  education: /\b(universit\w+|college|school district|academy|higher education|campus)\b/i
};

async function ransomwareVictims(days, scope) {
  const cutoff = Date.now() - days * 86400000;
  const headers = { "User-Agent": "WashU-EM-Dashboard/1.0", Accept: "application/json" };
  const cf = { cacheTtl: 1800, cacheEverything: true };
  const pull = async u => {
    try {
      const r = await fetch(u, { headers, cf });
      if (!r.ok) return { u, error: "HTTP " + r.status };
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.data || j.victims || []);
      return Array.isArray(arr) ? { u, arr } : { u, error: "unexpected shape" };
    } catch (e) { return { u, error: String(e.message || e).slice(0, 60) }; }
  };

  /* recentvictims is capped at roughly the last hundred listings regardless of the
     window asked for, which is far too thin to map. The monthly archives carry the
     full set, so the months the window touches are pulled and merged with recent. */
  const months = [];
  for (let d = new Date(); months.length < 7; d.setUTCMonth(d.getUTCMonth() - 1)) {
    months.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
    if (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) < cutoff) break;
  }
  const urls = ["https://api.ransomware.live/v2/recentvictims"]
    .concat(months.map(([y, m]) => "https://api.ransomware.live/v2/victims/" + y + "/" + m));
  const pulls = await Promise.all(urls.map(pull));
  const ok = pulls.filter(p => p.arr && p.arr.length);
  if (!ok.length) {
    return {
      error: "ransomware.live did not answer",
      detail: pulls.map(p => p.error).filter(Boolean)[0] || "no records",
      source: "ransomware.live"
    };
  }

  const seen = new Set(), items = [];
  ok.forEach(p => p.arr.forEach(v => {
    const when = Date.parse(v.published || v.discovered || v.attackdate || v.date);
    if (isNaN(when) || when < cutoff || when > Date.now() + 86400000) return;
    const victim = v.victim || v.post_title || "unnamed";
    const group = v.group_name || v.group || "unattributed";
    const key = (victim + "|" + group + "|" + new Date(when).toISOString().slice(0, 10)).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const activity = v.activity || v.sector || null;
    const desc = String(v.description || "").replace(/\s+/g, " ");
    let sectors = activity ? Object.keys(RW_ACTIVITY).filter(k => RW_ACTIVITY[k].test(activity)) : [];
    let sectorSource = sectors.length ? "activity" : null;
    if (!sectors.length) {
      sectors = Object.keys(RW_SECTOR).filter(k => RW_SECTOR[k].test([victim, desc].join(" ")));
      if (sectors.length) sectorSource = "description";
    }
    if (scope !== "all" && !sectors.length) return;

    items.push({
      victim, group,
      country: (v.country || "").toUpperCase().slice(0, 2) || null,
      activity,
      claimedAt: new Date(when).toISOString(),
      ageDays: round((Date.now() - when) / 86400000, 1),
      sectors, sectorSource,
      url: v.post_url || null,
      screenshot: v.screenshot || null,
      description: desc.slice(0, 300) || null
    });
  }));
  items.sort((a, b) => a.ageDays - b.ageDays);

  const tally = (arr, keyFn) => {
    const m = {};
    arr.forEach(x => { const k = keyFn(x); if (k) m[k] = (m[k] || 0) + 1; });
    return m;
  };
  const sectorItems = items.filter(i => i.sectors.length);
  const byCountry = tally(items, i => i.country);
  const byGroup = tally(items, i => i.group);

  // Daily claim volume across the window, so the client can chart or animate it
  // without re-deriving buckets from timestamps.
  const dayKeys = {};
  items.forEach(i => {
    const d = i.claimedAt.slice(0, 10);
    dayKeys[d] = dayKeys[d] || { date: d, total: 0, sector: 0 };
    dayKeys[d].total++;
    if (i.sectors.length) dayKeys[d].sector++;
  });

  return {
    source: "ransomware.live public victim feed (adversary leak-site listings)",
    note: "A listing is the group's own CLAIM, not a confirmed breach, and appears only after the victim is posted to a leak site — typically well after the intrusion. Country is the feed's own field; sector comes from the feed's activity label where it has one, otherwise inferred from the victim description.",
    endpoints: ok.map(p => p.u),
    failedEndpoints: pulls.filter(p => p.error).map(p => ({ url: p.u, error: p.error })),
    scope, windowDays: days,
    fetchedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      sectorTotal: sectorItems.length,
      health: items.filter(i => i.sectors.includes("health")).length,
      research: items.filter(i => i.sectors.includes("research")).length,
      education: items.filter(i => i.sectors.includes("education")).length,
      unitedStates: items.filter(i => i.country === "US").length,
      countries: Object.keys(byCountry).length,
      groups: Object.keys(byGroup).length,
      unlocated: items.filter(i => !i.country).length,
      fromActivityLabel: items.filter(i => i.sectorSource === "activity").length
    },
    byCountry: Object.entries(byCountry).sort((a, b) => b[1] - a[1])
      .map(([c, n]) => ({
        country: c, victims: n,
        sectorVictims: sectorItems.filter(i => i.country === c).length
      })),
    topGroups: Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => ({
      group: g, victims: n,
      sectorVictims: sectorItems.filter(i => i.group === g).length
    })),
    daily: Object.values(dayKeys).sort((a, b) => a.date.localeCompare(b.date)),
    items: items.slice(0, 900)
  };
}

/* ---------- national public health outlet RSS ---------------------------

   CDC's own media API and WHO's outbreak feeds send CORS headers, so the browser
   reads those two directly. Everything below does not, which is the whole reason
   for this route: the trade press and wire services that report a threat days
   before it reaches an official posting.

   Classification is deliberately coarse. A watch desk wants to know which KIND of
   threat a headline is about — respiratory, foodborne, waterborne, environmental —
   not a confidence score it cannot audit. Anything matching no category is
   dropped rather than filed under “other”. */
const HEALTH_OUTLETS = [
  { name: "CIDRAP (U. Minnesota)", url: "https://www.cidrap.umn.edu/news/rss.xml" },
  { name: "ProMED-mail", url: "https://promedmail.org/feed/" },
  { name: "STAT News", url: "https://www.statnews.com/feed/" },
  { name: "NPR Health", url: "https://feeds.npr.org/1128/rss.xml" },
  { name: "HHS newsroom", url: "https://www.hhs.gov/rss/news.xml" },
  { name: "FDA food safety", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/food-safety/rss.xml" },
  { name: "FDA recalls", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml" },
  { name: "EPA newsroom", url: "https://www.epa.gov/newsreleases/search/rss" },
  { name: "Missouri DHSS", url: "https://health.mo.gov/news/rss.xml" },
  { name: "Reuters health", url: "https://news.google.com/rss/search?q=when:2d+allinurl:reuters.com+health+outbreak&hl=en-US&gl=US&ceid=US:en" },
  { name: "AP health", url: "https://news.google.com/rss/search?q=when:2d+allinurl:apnews.com+(outbreak+OR+%22public+health%22)&hl=en-US&gl=US&ceid=US:en" }
];

const HEALTH_CATEGORIES = [
  { key: "outbreak", label: "Outbreak & infectious disease",
    re: /\b(outbreak|epidemic|pandemic|cluster of cases|measles|mumps|rubella|pertussis|whooping cough|polio|mpox|monkeypox|ebola|marburg|hantavirus|dengue|malaria|zika|chikungunya|cholera|typhoid|meningitis|meningococcal|hepatitis [ab]|tuberculosis|\btb\b|rabies|anthrax|plague|nipah|lassa|candida auris|c\.? ?auris|carbapenem|drug[- ]resistant|superbug|legionnaire|legionella)\b/i },
  { key: "respiratory", label: "Respiratory",
    re: /\b(influenza|\bflu\b|h5n1|h5n5|h7n9|avian influenza|bird flu|covid|sars-cov-2|coronavirus|rsv|respiratory syncytial|pneumonia|walking pneumonia|mycoplasma|variant|wastewater (levels|surveillance)|hospitaliz\w+ (surge|rise|increase))\b/i },
  { key: "foodborne", label: "Foodborne & recalls",
    re: /\b(recall(ed|s)?|salmonella|listeria|e\.? ?coli|botulism|campylobacter|norovirus|cyclospora|foodborne|food safety|contaminat\w+|undeclared allergen|adulterated)\b/i },
  { key: "water", label: "Water & sanitation",
    re: /\b(boil (water )?(order|advisory)|drinking water|water main|water quality|\bpfas\b|forever chemical|lead in (the )?water|sewage|wastewater (spill|overflow)|cryptosporidium|naegleria)\b/i },
  { key: "environment", label: "Environmental & heat",
    re: /\b(air quality|smoke|wildfire smoke|ozone|pm2\.?5|particulate|heat (wave|advisory|warning|emergency|illness|stroke)|extreme heat|carbon monoxide|mold|asbestos|radon|chemical (spill|release|plume)|hazmat|toxic|superfund|radiation)\b/i },
  { key: "drugs", label: "Drugs, vaccines & supply",
    re: /\b(shortage|drug supply|vaccin\w+|immuniz\w+|booster|antiviral|tamiflu|paxlovid|naloxone|narcan|fentanyl|xylazine|overdose|opioid|counterfeit (pill|drug)|adverse event|black box warning|fda (approv|clear|authoriz)\w*)\b/i },
  { key: "system", label: "Health system & preparedness",
    re: /\b(public health emergency|state of emergency|emergency declaration|hospital (capacity|diversion|surge|strike)|\bems\b|nursing shortage|health department|cdc (warns|advises|issues|reports)|health advisory|\bhan\b advisory|quarantine|isolation order|mass casualty|blood supply|blood shortage)\b/i }
];

const HEALTH_NOISE = /\b(recipe|diet plan|weight loss tips|horoscope|celebrity|red carpet|fashion|movie|album|box office|nfl|nba|super bowl|stock (price|split)|earnings (call|beat)|black friday|deal of the day|best (deals|mattress|sunscreen)|review:)\b/i;

async function healthNews(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;

  const settled = await Promise.all(HEALTH_OUTLETS.map(async o => {
    try {
      const r = await fetch(o.url, {
        headers: {
          "User-Agent": "WashU-EM-Dashboard/1.0 (situational awareness)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        },
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      if (!r.ok) return { outlet: o.name, ok: false, detail: "HTTP " + r.status, items: [] };
      return { outlet: o.name, ok: true, items: parseFeed(await r.text(), o.name) };
    } catch (e) {
      return { outlet: o.name, ok: false, detail: String(e.message || e).slice(0, 60), items: [] };
    }
  }));

  const seen = new Set();
  const items = [];
  settled.forEach(s => s.items.forEach(it => {
    const when = Date.parse(it.published);
    if (!isNaN(when) && when < cutoff) return;
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
    if (!key || seen.has(key)) return;

    const text = it.title + " " + (it.summary || "");
    if (HEALTH_NOISE.test(text)) return;
    const cats = HEALTH_CATEGORIES.filter(c => c.re.test(text)).map(c => c.key);
    if (!cats.length) return;
    seen.add(key);

    // Google News wraps the publisher name into the title after a trailing dash.
    const gnews = it.title.match(/^(.*)\s+-\s+([^-]{3,40})$/);
    items.push({
      title: gnews ? gnews[1].trim() : it.title,
      url: it.url,
      outlet: gnews ? gnews[2].trim() : s.outlet,
      via: gnews ? s.outlet : null,
      published: isNaN(when) ? null : new Date(when).toISOString(),
      ageHours: isNaN(when) ? null : round((Date.now() - when) / 3600000, 1),
      categories: cats,
      missouri: /\b(missouri|\bmo\.?\b|st\.? louis|kansas city|illinois|midwest)\b/i.test(text) || null,
      summary: (it.summary || "").slice(0, 400) || null
    });
  }));

  items.sort((a, b) => (a.ageHours == null ? 1 : b.ageHours == null ? -1 : a.ageHours - b.ageHours));

  const ok = settled.filter(s => s.ok);
  const counts = {};
  HEALTH_CATEGORIES.forEach(c => { counts[c.key] = items.filter(i => i.categories.includes(c.key)).length; });
  return {
    source: "national public health outlet RSS, merged and threat-classified",
    note: "Media reporting, not official notification. Classification is keyword-based and shown so it can be judged.",
    windowHours: hours,
    fetchedAt: new Date().toISOString(),
    categories: HEALTH_CATEGORIES.map(c => ({ key: c.key, label: c.label })),
    outlets: settled.map(s => ({ outlet: s.outlet, ok: s.ok, items: s.items.length, detail: s.detail || null })),
    outletsAnswering: ok.length,
    outletsTotal: HEALTH_OUTLETS.length,
    itemsScanned: settled.reduce((n, s) => n + s.items.length, 0),
    counts: Object.assign({ relevant: items.length, lastSixHours: items.filter(i => i.ageHours != null && i.ageHours <= 6).length, midwest: items.filter(i => i.missouri).length }, counts),
    items: items.slice(0, 60)
  };
}

/* RSS 2.0 and Atom in one pass. Regex is acceptable here in a way it is not for
   HTML: feed bodies are machine-generated, shallow, and the fields wanted are
   flat children of <item>/<entry>. */
function parseFeed(xml, outlet) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) || [];
  return blocks.slice(0, 60).map(b => {
    const tag = name => {
      const m = b.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
      // Strip raw tags, decode entities, then strip the tags decoding revealed:
      // CISA and Google News send descriptions as entity-encoded HTML.
      return m ? stripTags(decodeXml(stripTags(m[1]))) : "";
    };
    // Atom puts the link in an attribute rather than element text.
    let url = tag("link");
    if (!url) {
      const m = b.match(/<link[^>]*rel=["']?alternate["']?[^>]*href=["']([^"']+)/i)
        || b.match(/<link[^>]*href=["']([^"']+)/i);
      url = m ? decodeXml(m[1]) : "";
    }
    return {
      title: tag("title"),
      url: url,
      published: tag("pubDate") || tag("published") || tag("updated") || tag("dc:date") || "",
      summary: tag("description") || tag("summary") || "",
      outlet: outlet
    };
  }).filter(x => x.title && x.url);
}

const stripTags = s => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const decodeXml = s => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#8217;|&rsquo;/g, "\u2019").replace(/&#8216;|&lsquo;/g, "\u2018")
  .replace(/&#8220;|&ldquo;/g, "\u201c").replace(/&#8221;|&rdquo;/g, "\u201d")
  .replace(/&#8212;|&mdash;/g, "\u2014").replace(/&#8211;|&ndash;/g, "\u2013")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, "&")
  .trim();

/* ---------- geometry ----------------------------------------------------- */

// Quadkeys whose tiles intersect the bounding box of the ring.
function tilesForRadius(centre, radiusMiles, z) {
  const dLat = radiusMiles / 69;
  const dLon = radiusMiles / (69 * Math.cos(centre.lat * Math.PI / 180));
  const n = Math.pow(2, z);
  const xOf = lon => Math.floor(((lon + 180) / 360) * n);
  const yOf = lat => {
    const s = Math.sin(lat * Math.PI / 180);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  };
  const x0 = xOf(centre.lon - dLon), x1 = xOf(centre.lon + dLon);
  const y0 = yOf(centre.lat + dLat), y1 = yOf(centre.lat - dLat);
  const out = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      let q = "";
      for (let i = z; i > 0; i--) {
        let d = 0, mask = 1 << (i - 1);
        if (x & mask) d++;
        if (y & mask) d += 2;
        q += d;
      }
      out.push(q);
    }
  }
  return out;
}

// Google encoded polyline, precision 5 (verified against known outage points).
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0, byte = 0, shift, result;
  const coords = [];
  while (index < str.length) {
    shift = 0; result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

function haversineMiles(la1, lo1, la2, lo2) {
  const R = 3958.8, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearing(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

/* ---------- helpers ------------------------------------------------------ */

// KUBRA wraps display numbers as {val: n} and can overwrite them with strings.
function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v.val != null) return typeof v.val === "number" ? v.val : parseFloat(v.val) || 0;
  return parseFloat(v) || 0;
}

// Localised label objects: {"EN-US": "...", orig: "..."}.
function pick(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v["EN-US"] || v.orig || null;
}

// ETR sentinels are not timestamps and must not be rendered as dates.
function cleanEtr(etr) {
  if (!etr) return null;
  if (etr === "ETR-NULL") return "being assessed";
  if (etr === "ETR-EXP") return "past estimate";
  if (etr === "ETR-EMG") return "emergency conditions";
  return etr;
}

/* ---------- MSHP online crash reports ------------------------------------

   The Patrol posts every injury/fatal crash it investigates to an HTML search
   page (one row per person involved, rolling ~29 days). There is no API and no
   CORS, so the table is fetched and parsed here, then reduced to one record per
   crash report. Person-level fields the page carries — age, home city — are
   deliberately dropped: an EM desk needs where, when and how severe, not who.
   Crashes investigated by municipal police are NOT in this dataset. */

const INJURY_RANK = { "FATAL": 4, "SERIOUS": 3, "MODERATE": 2, "MINOR": 1, "NO INJURY": 0 };

async function mshpCrashes(troop, counties, days, geocode) {
  const html = await text("https://www.mshp.dps.mo.gov/HP68/SearchAction?searchTroop=" + encodeURIComponent(troop));
  const strip = s => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();

  const rows = (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []);
  const byReport = new Map();
  const cutoff = Date.now() - days * 86400000;

  rows.forEach(tr => {
    const idm = tr.match(/ACC_RPT_NUM=(\d+)/i);
    if (!idm) return;
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(strip);
    if (cells.length < 11) return;
    // Report | Person type | Age | Person city | Injury | Safety device | Date | Time | County | Location | Troop
    const injury = (cells[4] || "").toUpperCase();
    const date = cells[6], time = cells[7];
    const county = (cells[8] || "").toUpperCase();
    const location = cells[9];
    if (counties.length && !counties.includes(county)) return;

    const when = parseCrashTime(date, time);
    if (when && when < cutoff) return;

    const id = idm[1];
    const rec = byReport.get(id) || {
      report: id, county, location, troop: cells[10] || troop,
      date, time, at: when ? new Date(when).toISOString() : null,
      involved: 0, worstInjury: "NO INJURY", fatal: false, injured: 0,
      url: "https://www.mshp.dps.mo.gov/HP68/AccidentDetailsAction?ACC_RPT_NUM=" + id
    };
    rec.involved++;
    if ((INJURY_RANK[injury] || 0) > (INJURY_RANK[rec.worstInjury] || 0)) rec.worstInjury = injury;
    if (injury === "FATAL") rec.fatal = true;
    if (INJURY_RANK[injury] > 0) rec.injured++;
    byReport.set(id, rec);
  });

  const crashes = [...byReport.values()].sort((a, b) => (b.at || "").localeCompare(a.at || ""));

  let geocoded = 0;
  if (geocode) {
    for (const c of crashes.slice(0, 12)) {
      const point = await geocodeCrash(c.location, c.county);
      if (point) { c.lat = point.lat; c.lon = point.lon; c.locationSource = "geocoded"; geocoded++; }
    }
  }

  return {
    source: "Missouri State Highway Patrol · online traffic crash reports (preliminary, unofficial)",
    note: "MSHP-investigated injury and fatal crashes only — crashes handled by municipal police are not published here. Coordinates are geocoded from the Patrol's text location and are approximate.",
    troop, counties, windowDays: days,
    total: crashes.length,
    geocoded,
    fatalCount: crashes.filter(c => c.fatal).length,
    crashes,
    fetchedAt: new Date().toISOString()
  };
}

function parseCrashTime(date, time) {
  const d = String(date || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!d) return null;
  const t = String(time || "").match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
  let hh = t ? Number(t[1]) % 12 : 12, mm = t ? Number(t[2]) : 0;
  if (t && /P/i.test(t[3])) hh += 12;
  // Page times are Central wall clock; CDT for the months this window can span.
  return Date.UTC(Number(d[3]), Number(d[1]) - 1, Number(d[2]), hh + 5, mm);
}

/* Nominatim, used sparingly and cached: only locations naming an intersection
   are attempted, because a bare route name geocodes to the centroid of the whole
   highway and would put a crash tens of miles from where it happened. */
async function geocodeCrash(location, county) {
  const loc = String(location || "").trim();
  const m = loc.match(/^(.{3,60}?)\s*(?:,\s*)?(?:\bAT\b|&|\bAND\b)\s+(.{3,60})$/i);
  if (!m) return null;
  const place = county === "ST. LOUIS CITY" ? "St. Louis, Missouri" : titleish(county) + " County, Missouri";
  const q = m[1].trim() + " & " + m[2].trim() + ", " + place;
  const key = "geo:" + q.toLowerCase();
  const hit = await fromCache(key);
  if (hit) return hit.point;

  try {
    const body = await text("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q="
      + encodeURIComponent(q));
    const arr = JSON.parse(body);
    const point = arr && arr[0] ? { lat: Number(arr[0].lat), lon: Number(arr[0].lon) } : null;
    await toCache(key, { point }, 604800);
    await new Promise(r => setTimeout(r, 1100)); // Nominatim asks for ≤1 req/s
    return point;
  } catch (e) {
    return null;
  }
}

const titleish = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, p) => Math.round(v * 10 ** p) / 10 ** p;

async function text(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "WashU-EM-Dashboard/1.0 (situational awareness)" },
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).pathname}`);
  return r.text();
}

async function json(url) {
  return JSON.parse(await text(url));
}

/* Keeps the discovery chain off the critical path between publishes. Scoped to
   the isolate rather than the edge cache: the Cache API requires a URL on a
   hostname the account owns and is bypassed on workers.dev, so using it here
   risked failing the whole response for no benefit. */
const MEMO = new Map();

async function fromCache(key) {
  const hit = MEMO.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { MEMO.delete(key); return null; }
  return hit.value;
}

async function toCache(key, value, ttl) {
  MEMO.set(key, { value, expires: Date.now() + ttl * 1000 });
}

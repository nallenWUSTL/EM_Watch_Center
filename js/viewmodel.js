/* View model for the All-Hazards and Outages views: turns the shell's state
   into display-ready values. Pure apart from reading the proxy override and
   the context the background tabs publish on window.__omContext. */
(function () {
  const W = (window.WUEM = window.WUEM || {});
  const { DANFORTH, MEDICAL, TZ, round1, tzAbbr, fmtTime, fmtZoned, isoOffsetMin, campusOffsetMin, officeClock, fmtDay, c2f, kmh2mph } = W;

  const FLOOD_CATEGORY = {
    no_flooding: { label: "No flooding", tone: "#605d5d" },
    low_threshold: { label: "Below action", tone: "#605d5d" },
    fcst_not_current: { label: "No current forecast", tone: "#605d5d" },
    action: { label: "Action stage", tone: "#b8860b" },
    minor: { label: "Minor flooding", tone: "#ec3013" },
    moderate: { label: "Moderate flooding", tone: "#ec3013" },
    major: { label: "Major flooding", tone: "#ae1800" }
  };

  function campusAlerts(s) {
    const map = new Map();
    s.alertsD.forEach(f => map.set(f.id, { f, campuses: ["Danforth"] }));
    s.alertsM.forEach(f => {
      const e = map.get(f.id);
      if (e) e.campuses.push("Medical");
      else map.set(f.id, { f, campuses: ["Medical"] });
    });
    return [...map.values()];
  }

  function buildView(s) {
    const err = s.errors;
    const ca = campusAlerts(s);
    const hasAlerts = ca.length > 0;
    const retrieved = s.retrieved ? fmtZoned(s.retrieved.toISOString()) : "loading…";

    const alerts = ca.map(({ f, campuses }) => {
      const p = f.properties;
      return {
        event: p.event,
        headline: p.headline || p.parameters && p.parameters.NWSheadline && p.parameters.NWSheadline[0] || "",
        area: p.areaDesc,
        severity: p.severity || "—",
        urgency: p.urgency || "—",
        sender: p.senderName || "NWS",
        onset: fmtZoned(p.onset || p.effective),
        expires: fmtZoned(p.ends || p.expires),
        issuedZone: (function () {
          const iso = p.sent || p.onset || p.effective;
          const a = isoOffsetMin(iso), b = campusOffsetMin(iso);
          return a !== null && b !== null && a !== b ? "Issued " + officeClock(iso) + " at the office" : "Issued in campus time zone";
        })(),
        campus: campuses.join(" + ") + " in polygon"
      };
    });

    const alertHeadCount = s.loading ? "Loading NWS CAP" : hasAlerts ? alerts.length + (alerts.length === 1 ? " Active Alert" : " Active Alerts") : "No Active Alerts";
    const alertHeadLine = s.loading ? "Querying api.weather.gov for both campus coordinates…"
      : err.alertsD || err.alertsM ? "NWS alerts endpoint unreachable (" + (err.alertsD || err.alertsM) + ") — treat as unknown, not as all-clear."
      : hasAlerts ? "NWS CAP polygons currently cover a Washington University campus." : "No NWS CAP product currently covers either campus coordinate. " + s.moAlerts.length + " alert(s) active statewide in Missouri.";

    const bandRed = hasAlerts || !!(err.alertsD || err.alertsM);

    const o = s.obs || {};
    const t = c2f(o.temperature && o.temperature.value);
    const hi = c2f(o.heatIndex && o.heatIndex.value);
    const dew = c2f(o.dewpoint && o.dewpoint.value);
    const wind = kmh2mph(o.windSpeed && o.windSpeed.value);
    const gust = kmh2mph(o.windGust && o.windGust.value);
    const vis = o.visibility && o.visibility.value !== null ? Math.round(o.visibility.value / 1609.34 * 10) / 10 + " mi" : "—";
    const observation = err.obs ? [{ name: "Station unreachable", value: "—", tone: "#ae1800" }] : [
      { name: "Conditions", value: o.textDescription || "—", tone: "#201e1d" },
      { name: "Temperature", value: t === null ? "—" : t + "°F", tone: t !== null && t >= 90 ? "#ae1800" : "#201e1d" },
      { name: "Heat index", value: hi === null ? "n/a" : hi + "°F", tone: hi !== null && hi >= 100 ? "#ae1800" : "#201e1d" },
      { name: "Dewpoint", value: dew === null ? "—" : dew + "°F", tone: "#201e1d" },
      { name: "Wind", value: wind === null ? "—" : wind + " mph" + (gust ? " g" + gust : ""), tone: gust && gust >= 35 ? "#ae1800" : "#201e1d" },
      { name: "Visibility", value: vis, tone: "#201e1d" },
      { name: "Relative humidity", value: o.relativeHumidity && o.relativeHumidity.value !== null ? Math.round(o.relativeHumidity.value) + "%" : "—", tone: "#201e1d" }
    ];

    // Distance from a site to the nearer campus, so the county sweep is ranked by
    // relevance to WashU rather than by USGS site number.
    const milesToCampus = (lat, lon) => {
      if (typeof lat !== "number" || typeof lon !== "number") return 9999;
      return Math.min(...[DANFORTH, MEDICAL].map(c => {
        const dy = (lat - c.lat) * 69, dx = (lon - c.lon) * 69 * Math.cos(c.lat * Math.PI / 180);
        return Math.sqrt(dx * dx + dy * dy);
      }));
    };
    const readSeries = (payload, tag) => {
      const out = [];
      const seen = new Set();
      const series = payload && payload.value && payload.value.timeSeries || [];
      series.forEach(ts => {
        if (ts.variable.variableCode[0].value !== "00065") return;
        const site = ts.sourceInfo.siteCode[0].value;
        if (seen.has(site)) return;
        const v = ts.values[0] && ts.values[0].value[0];
        if (!v || v.value === "-999999") return;
        seen.add(site);
        const g = ts.sourceInfo.geoLocation && ts.sourceInfo.geoLocation.geogLocation || {};
        const miles = milesToCampus(g.latitude, g.longitude);
        out.push({
          key: site,
          name: ts.sourceInfo.siteName.replace(/,\s*MO$/i, ""),
          site: "USGS " + site + (tag ? " · " + tag : miles < 900 ? " · " + miles.toFixed(1) + " mi from campus" : ""),
          time: fmtZoned(v.dateTime),
          value: parseFloat(v.value).toFixed(2) + " ft",
          miles
        });
      });
      return out;
    };

    const mainGauge = readSeries(s.gaugeMain, "Mississippi mainstem")[0];
    const nearby = readSeries(s.gauges).sort((a, b) => a.miles - b.miles).filter(g => !mainGauge || g.key !== mainGauge.key).slice(0, 5);
    let gauges = (mainGauge ? [mainGauge] : []).concat(nearby);
    if (!gauges.length) gauges = [{ name: err.gauges && err.gaugeMain ? "USGS NWIS unreachable" : "No active gage-height sites returned", site: "sites=07010000 · countyCd 29189, 29510", time: "—", value: "—" }];

    const a = s.air || {};
    const aqi = a.us_aqi;
    const air = err.air ? [{ name: "Air-quality service unreachable", value: "—", tone: "#ae1800" }] : [
      { name: "US AQI", value: aqi === undefined ? "—" : String(Math.round(aqi)), tone: aqi >= 101 ? "#ae1800" : "#201e1d" },
      { name: "PM2.5", value: a.pm2_5 === undefined ? "—" : Math.round(a.pm2_5) + " µg/m³", tone: "#201e1d" },
      { name: "PM10", value: a.pm10 === undefined ? "—" : Math.round(a.pm10) + " µg/m³", tone: "#201e1d" },
      { name: "Ozone", value: a.ozone === undefined ? "—" : Math.round(a.ozone) + " µg/m³", tone: "#201e1d" }
    ];

    const quakes = (s.quakes || []).slice(0, 4).map(q => ({ mag: "M" + q.properties.mag.toFixed(1), place: q.properties.place, time: fmtDay(new Date(q.properties.time).toISOString()) }));
    if (!quakes.length) quakes.push({ mag: "—", place: err.quakes ? "USGS event service unreachable" : "No M2.5+ events in the box in 30 days", time: "" });

    const temps = s.hourly.map(h => h.temperature).filter(v => typeof v === "number");
    const tmin = temps.length ? Math.min(...temps) : 0;
    const tmax = temps.length ? Math.max(...temps) : 1;
    // ---- Hourly forecast chart -------------------------------------------------
    const mode = s.chartMode || "temp";
    const H = s.hourly;
    const parseMph = str => { const m = String(str || "").match(/(\d+)(?!.*\d)/); return m ? Number(m[1]) : 0; };
    const rows = H.map(h => ({
      t: h.temperature,
      pop: (h.probabilityOfPrecipitation && h.probabilityOfPrecipitation.value) || 0,
      rh: (h.relativeHumidity && h.relativeHumidity.value) || 0,
      dew: c2f(h.dewpoint && h.dewpoint.value),
      wind: parseMph(h.windSpeed),
      gust: h.windGust ? parseMph(h.windGust) : 0,
      night: h.isDaytime === false,
      start: h.startTime,
      label: fmtTime(h.startTime),
      zoned: fmtZoned(h.startTime)
    }));

    const SERIES = {
      temp: { primary: r => r.t, secondary: r => r.dew, unit: "°F", pLabel: "Temperature", sLabel: "Dewpoint",
        stroke: "#ec3013", fill: "rgba(236,48,19,0.12)", stroke2: "#2f6fb2" },
      wind: { primary: r => r.wind, secondary: r => (r.gust || r.wind), unit: " mph", pLabel: "Sustained wind", sLabel: "Gust",
        stroke: "#2f6fb2", fill: "rgba(47,111,178,0.12)", stroke2: "#ec3013" },
      humidity: { primary: r => r.rh, secondary: r => r.dew, unit: "%", pLabel: "Relative humidity", sLabel: "Dewpoint",
        stroke: "#17806b", fill: "rgba(23,128,107,0.12)", stroke2: "#2f6fb2" }
    };
    const ser = SERIES[mode] || SERIES.temp;

    const X0 = 52, X1 = 988, Y0 = 30, Y1 = 232, BASE = 262;
    const vals = rows.map(ser.primary).filter(v => typeof v === "number");
    const vals2 = rows.map(ser.secondary).filter(v => typeof v === "number");
    const sMin = vals.concat(vals2).length ? Math.min(...vals.concat(vals2)) : 0;
    const sMax = vals.concat(vals2).length ? Math.max(...vals.concat(vals2)) : 1;
    const sPad = Math.max(2, Math.round((sMax - sMin) * 0.15));
    const vLo = mode === "humidity" ? 0 : Math.floor((sMin - sPad) / 5) * 5;
    const vHi = mode === "humidity" ? 100 : Math.ceil((sMax + sPad) / 5) * 5;
    const yOf = v => Y1 - ((v - vLo) / Math.max(1, vHi - vLo)) * (Y1 - Y0);
    const xOf = i => rows.length < 2 ? (X0 + X1) / 2 : X0 + (i / (rows.length - 1)) * (X1 - X0);

    const tickCount = 5;
    const grid = Array.from({ length: tickCount }, (_, k) => {
      const v = vLo + (k / (tickCount - 1)) * (vHi - vLo);
      const y = yOf(v);
      return { y: Math.round(y), ty: Math.round(y + 4), top: (y / 300 * 100).toFixed(2) + "%", label: Math.round(v) + ser.unit };
    });

    // Comfort/severity bands give the plot a read at a glance.
    const bandDefs = mode === "temp"
      ? [[95, 200, "rgba(236,48,19,0.10)"], [85, 95, "rgba(236,48,19,0.05)"], [-100, 32, "rgba(32,30,29,0.07)"]]
      : mode === "wind"
        ? [[40, 200, "rgba(236,48,19,0.10)"], [25, 40, "rgba(236,48,19,0.05)"]]
        : [[80, 200, "rgba(32,30,29,0.05)"]];
    const bands = bandDefs.map(([a, b, fill]) => {
      const yTop = Math.max(Y0, Math.min(Y1, yOf(Math.min(b, vHi))));
      const yBot = Math.max(Y0, Math.min(Y1, yOf(Math.max(a, vLo))));
      return { y: Math.round(yTop), h: Math.max(0, Math.round(yBot - yTop)), fill };
    }).filter(b => b.h > 1);

    /* Two independent scales share the plot. The primary series (°F, mph or %RH)
       reads against the left axis; precipitation probability is always 0-100% and
       reads against the right. Bars therefore span the full plot height rather than
       a cramped 30px strip, and each axis carries its own unit so neither number
       can be read off the wrong scale. */
    const popOf = p => BASE - 2 - Math.round((p / 100) * (BASE - 2 - Y0));
    const barW = rows.length ? Math.max(3, (X1 - X0) / rows.length - 3) : 0;
    const bars = rows.map((r, i) => {
      const y = popOf(r.pop);
      const h = Math.max(0, BASE - 2 - y) + (r.pop > 0 ? 1 : 0);
      return {
        x: Math.round(xOf(i) - barW / 2), w: Math.round(barW),
        y: Math.round(y), h: h,
        fill: r.pop >= 50 ? "rgba(236,48,19,0.32)" : "rgba(236,48,19,0.16)"
      };
    });

    const gridRight = [0, 25, 50, 75, 100].map(p => ({
      label: p + "%",
      top: (popOf(p) / 300 * 100).toFixed(2) + "%"
    }));

    const nightRuns = [];
    rows.forEach((r, i) => {
      if (!r.night) return;
      const last = nightRuns[nightRuns.length - 1];
      if (last && last.end === i - 1) last.end = i;
      else nightRuns.push({ startIdx: i, end: i });
    });
    const night = nightRuns.map(run => ({
      x: Math.round(xOf(run.startIdx) - barW / 2),
      w: Math.round(xOf(run.end) - xOf(run.startIdx) + barW),
      h: BASE - 18
    }));

    const pts = rows.map((r, i) => Math.round(xOf(i)) + "," + Math.round(yOf(ser.primary(r))));
    const pts2 = rows.map((r, i) => Math.round(xOf(i)) + "," + Math.round(yOf(ser.secondary(r))));
    const line = pts.join(" ");
    const secondary = pts2.join(" ");
    const area = rows.length ? [Math.round(X0) + "," + Y1].concat(pts).concat([Math.round(xOf(rows.length - 1)) + "," + Y1]).join(" ") : "";

    // A marker and a value label on every hour; labels alternate above/below the
    // line so neighbouring values never collide.
    const dots = rows.map((r, i) => {
      const x = xOf(i), y = yOf(ser.primary(r));
      const above = i % 2 === 0;
      const ly = above ? y - 15 : y + 20;
      return {
        x: Math.round(x - 3.5), y: Math.round(y - 3.5),
        left: (x / 1000 * 100).toFixed(2) + "%", top: (ly / 300 * 100).toFixed(2) + "%",
        label: Math.round(ser.primary(r)) + (mode === "temp" ? "°" : "")
      };
    });

    const dots2 = rows.map((r, i) => {
      const x = xOf(i), y = yOf(ser.secondary(r));
      return { cx: Math.round(x), cy: Math.round(y) };
    });

    const lastIdx = rows.length - 1;
    const axisIdx = rows.map((r, i) => i).filter(i => i % 3 === 0);
    // Only add the final hour if it clears the previous tick by at least three hours.
    if (lastIdx > 0 && lastIdx - axisIdx[axisIdx.length - 1] >= 3) axisIdx.push(lastIdx);
    const axis = axisIdx.map(i => ({
      x: Math.round(xOf(i)),
      left: (xOf(i) / 1000 * 100).toFixed(2) + "%",
      label: rows[i].label
    }));

    const chart = {
      grid, gridRight, bands, bars, night, line, secondary, area, dots, dots2, axis,
      leftAxisTitle: ser.pLabel + " (" + ser.unit.trim() + ")",
      primaryLabel: ser.pLabel, secondaryLabel: ser.sLabel,
      stroke: ser.stroke, stroke2: ser.stroke2, fill: ser.fill
    };

    const chartModes = [["temp", "Temp"], ["wind", "Wind"], ["humidity", "Humidity"]].map(([k, lbl]) => ({
      label: lbl,
      bg: mode === k ? "#201e1d" : "transparent",
      fg: mode === k ? "#f3f2f2" : "#201e1d",
      key: k
    }));

    const peakPop = rows.length ? Math.max(...rows.map(r => r.pop)) : 0;
    const peakPopZoned = rows.length ? (rows.find(r => r.pop === peakPop) || {}).zoned : "";
    const maxGust = rows.length ? Math.max(...rows.map(r => r.gust || r.wind)) : 0;
    const maxGustZoned = rows.length ? (rows.find(r => (r.gust || r.wind) === maxGust) || {}).zoned : "";
    const hourlyStats = rows.length ? [
      { label: "High", value: Math.max(...rows.map(r => r.t)) + "°F", note: (rows.find(r => r.t === Math.max(...rows.map(x => x.t))) || {}).zoned, tone: Math.max(...rows.map(r => r.t)) >= 90 ? "#ae1800" : "#201e1d" },
      { label: "Low", value: Math.min(...rows.map(r => r.t)) + "°F", note: (rows.find(r => r.t === Math.min(...rows.map(x => x.t))) || {}).zoned, tone: "#201e1d" },
      { label: "Peak precip. chance", value: peakPop + "%", note: peakPop > 0 ? "at " + peakPopZoned : "dry window", tone: peakPop >= 50 ? "#ae1800" : "#201e1d" },
      { label: "Max wind", value: maxGust + " mph", note: "at " + maxGustZoned, tone: maxGust >= 25 ? "#ae1800" : "#201e1d" },
      { label: "Min humidity", value: Math.min(...rows.map(r => r.rh)) + "%", note: "Max " + Math.max(...rows.map(r => r.rh)) + "%", tone: "#201e1d" }
    ] : [{ label: "Hourly forecast", value: "—", note: "No periods returned", tone: "#605d5d" }];

    const events = {};
    s.moAlerts.forEach(f => {
      const p = f.properties;
      const k = p.event;
      events[k] = events[k] || { count: 0, sev: [], campus: false };
      events[k].count++;
      events[k].sev.push(p.severity);
      if (ca.some(x => x.f.properties.event === k)) events[k].campus = true;
    });
    const sevRank = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];
    const inventory = Object.entries(events).sort((x, y) => y[1].count - x[1].count).slice(0, 8).map(([event, v]) => ({
      event, count: String(v.count),
      severity: sevRank.find(r => v.sev.includes(r)) || "Unknown",
      campus: v.campus ? "Yes — campus in polygon" : "No",
      tone: v.campus ? "#ae1800" : "#605d5d"
    }));
    if (!inventory.length) inventory.push({ event: s.loading ? "Querying api.weather.gov…" : err.moAlerts ? "NWS alerts endpoint unreachable" : "No active alerts in Missouri", count: s.loading ? "—" : "0", severity: "—", campus: s.loading ? "—" : "No", tone: "#605d5d" });

    const gk = s.gkg || {};
    const gkgMax = (gk.themes || []).reduce((m, t) => Math.max(m, t.count), 0) || 1;
    const gkgShowBars = gkgMax > 1;
    const gkgDenom = Math.max(gkgMax, 5);
    const gkgThemes = (gk.themes || []).map(t => ({
      label: t.label,
      count: t.count,
      code: t.code,
      width: Math.max(3, Math.round((t.count / gkgDenom) * 100)) + "%"
    }));
    const gkgRecords = (gk.records || []).map(r => ({
      slug: r.slug,
      url: r.url,
      source: r.outlets > 1 ? r.source + " +" + (r.outlets - 1) + " outlets" : r.source,
      themes: r.themes.join(" · "),
      place: r.named ? r.place : r.place + " · " + r.dist.toFixed(0) + " mi from campus",
      tone: r.tone === null ? "tone —" : (r.tone > 0 ? "tone +" : "tone ") + r.tone.toFixed(1),
      toneColor: r.tone === null ? "#605d5d" : r.tone <= -5 ? "#ec3013" : r.tone < 0 ? "#8a5a1a" : "#605d5d"
    }));
    const gkgNote = s.gkgScanning
      ? "Inflating the 15-minute GKG files…"
      : gk.error
        ? "GKG unavailable: " + gk.error
        : gk.files
          ? "GDELT GKG 2.0 · " + gk.files + " files to " + gk.latest + " · " + gk.rows + " records, " + gk.mb + " MB inflated · " + gk.matched + " tagged to St. Louis or within 90 mi"
          : "Not yet scanned";
    const gkgSingleNote = !!(gk.themes || []).length && !gkgShowBars;
    const gkgEmpty = !s.gkgScanning && !gk.error && gk.files && !gkgRecords.length;

    const pw = s.power || {};
    const ring = pw.ring || {};
    const powerErrorRaw = pw.error || null;
    const powerError = powerErrorRaw;
    const proxyOrigin = W.proxyOrigin();
    const proxyHost = (function () { try { return new URL(proxyOrigin).hostname; } catch (e) { return proxyOrigin; } })();
    const proxyBad = W.proxyInvalid();
    const proxyBlocked = !!proxyBad || (!!powerErrorRaw && /failed to fetch|networkerror|load failed/i.test(powerErrorRaw));
    const proxyOverridden = proxyOrigin !== W.WORKER_DEFAULT;
    const proxyPanel = proxyBlocked || proxyOverridden;
    const proxyPanelNote = proxyBad
      ? "The saved value \u201c" + proxyBad + "\u201d is not an origin. Enter a full host including https://, or Reset to return to the default."
      : proxyBlocked
      ? "Put the Worker behind a hostname your network allows — a custom domain on the same Cloudflare account works, and needs no code change. Saved in this browser only."
      : "This browser is pointed at an origin other than the default. Saved locally; Reset returns to " + W.WORKER_DEFAULT.replace(/^https:\/\//, "") + ".";
    const powerNote = proxyBad
      ? "\u201c" + proxyBad + "\u201d is not a valid origin — include the full https:// host, e.g. https://feeds.example.org. Falling back to " + proxyHost + " until it is corrected."
      : s.powerLoading
      ? "Reading the Ameren outage map via " + proxyHost + "…"
      : proxyBlocked
      ? /\.workers\.dev$/.test(proxyHost)
        ? "Cannot reach " + proxyHost + ". Managed WashU devices block *.workers.dev at the network layer — put the Worker behind an allowed hostname below."
        : "Cannot reach " + proxyHost + ". The request never completed, which does not say why: the hostname may not resolve, the network may block it, or no Worker may be bound to that domain yet."
      : powerError
      ? "Ameren scraper unavailable: " + powerError
      : "Ameren public outage map, scraped via the KUBRA StormCenter file layout · generated "
        + (pw.dataGeneratedAt ? fmtZoned(pw.dataGeneratedAt) : "—")
        + " · map mode " + (pw.mode === "STORM" ? "STORM" : pw.mode === "BLUESKY" ? "normal operations" : "—");
    const powerReady = !s.powerLoading && !powerError && !!pw.ring;
    const powerStorm = pw.mode === "STORM";

    const powerStats = powerReady ? [
      { label: "Outages within " + (ring.radiusMiles || 10) + " mi", value: String(ring.outages || 0), note: (ring.customersOut || 0) + " customers affected" },
      { label: "Nearest outage", value: ring.nearestMiles == null ? "—" : ring.nearestMiles + " mi", note: ring.nearestMiles == null ? "None in ring" : "From Brookings Hall" },
      { label: "Largest in ring", value: String(ring.largest || 0), note: "Customers on one outage" },
      { label: "Past estimated restore", value: String(ring.expiredEtrs || 0), note: "ETR already lapsed" }
    ] : [];

    const powerOutages = powerReady ? (pw.outages || []).slice(0, 8).map(o => ({
      headline: o.customersOut + (o.customersOut === 1 ? " customer" : " customers") + " · " + o.miles + " mi " + o.bearing,
      cause: o.cause || "Cause not stated",
      crew: o.crewStatus || "Crew status not stated",
      etr: o.etr && /^\d{4}-/.test(o.etr) ? "Restore est. " + fmtZoned(o.etr) : o.etr ? "Restore " + o.etr : "No estimate",
      etrTone: o.etr === "past estimate" ? "#ec3013" : "#605d5d",
      duration: o.durationHours == null ? "" : o.durationHours < 24
        ? "Out " + o.durationHours + " h"
        : "Out " + Math.round(o.durationHours / 24) + " d"
    })) : [];

    const powerCounties = powerReady ? (pw.countiesWatched || []).filter(c => !c.notFound).map(c => ({
      name: c.county + (c.state === "Illinois" ? ", IL" : ", MO"),
      out: String(c.customersOut),
      served: c.customersServed ? c.customersServed.toLocaleString() + " served" : "—",
      pct: c.percentOut ? c.percentOut.toFixed(2) + "%" : "0%",
      tone: c.customersOut > 500 ? "#ec3013" : "#201e1d"
    })) : [];

    const powerCauses = powerReady
      ? (ring.causeCounts || []).map(c => c.cause + " (" + c.n + ")").join(" · ") || "No outages in the ring"
      : "";

    /* Flood stages. The number that matters is not the stage but its distance
       from the action threshold, and whether the forecast crosses it. */
    const nwps = s.nwps || null;
    const floodReady = Array.isArray(nwps);
    const floodRows = floodReady ? nwps.map(g => {
      if (!g.ok) return { label: g.label, note: g.note, failed: true, stage: "—", category: "Unavailable", categoryTone: "#ae1800", barWidth: "0%", barTone: "#eae9e9", actionMark: null, minorMark: null, majorMark: null, scaleLabel: "", observedAt: "", headroom: "", headroomTone: "#605d5d", forecast: "", forecastTone: "#605d5d", crossing: false, detail: " · " + g.detail };
      const d = g.data || {};
      const obs = (d.status && d.status.observed) || {};
      const fc = (d.status && d.status.forecast) || {};
      const cats = (d.flood && d.flood.categories) || {};
      const stageOf = k => cats[k] && cats[k].stage > -9000 ? cats[k].stage : null;
      const action = stageOf("action"), minor = stageOf("minor"), moderate = stageOf("moderate"), major = stageOf("major");
      // Sentinel values share the -999 family with the threshold fields above.
      const real = v => typeof v === "number" && v > -900 ? v : null;
      const stage = real(obs.primary);
      const fcStage = real(fc.primary);
      const cat = FLOOD_CATEGORY[obs.floodCategory] || { label: obs.floodCategory || "—", tone: "#605d5d" };
      const fcCat = FLOOD_CATEGORY[fc.floodCategory] || null;
      const unit = obs.primaryUnit || "ft";

      // Scale the bar to major stage so gauges stay comparable to their own risk,
      // not to each other's datum — stage values are not comparable across sites.
      const top = major || moderate || minor || action || (stage ? stage * 2 : 1);
      const pct = v => v == null ? null : Math.max(0, Math.min(100, (v / top) * 100)) + "%";

      const headroom = action != null && stage != null ? round1(action - stage) : null;
      const rising = stage != null && fcStage != null ? round1(fcStage - stage) : null;

      return {
        label: g.label,
        note: g.note,
        failed: false,
        stage: stage == null ? "—" : stage.toFixed(2) + " " + unit,
        category: cat.label,
        categoryTone: cat.tone,
        observedAt: obs.validTime ? fmtDay(obs.validTime) : "",
        barWidth: pct(stage) || "0%",
        barTone: cat.tone === "#605d5d" ? "#201e1d" : cat.tone,
        actionMark: pct(action),
        minorMark: pct(minor),
        majorMark: pct(major),
        scaleLabel: (action != null ? "Action " + action + unit : "") + (major != null ? " · Major " + major + unit : ""),
        headroom: headroom == null ? "" : headroom > 0
          ? headroom + " " + unit + " below action stage"
          : Math.abs(headroom) + " " + unit + " above action stage",
        headroomTone: headroom != null && headroom <= 0 ? "#ec3013" : "#605d5d",
        forecast: fcStage == null
          ? (fc.floodCategory === "fcst_not_current" ? "No current forecast issued" : "No forecast issued")
          : "Forecast " + fcStage.toFixed(1) + " " + unit
            + (fc.validTime ? " by " + fmtDay(fc.validTime) : "")
            + (rising == null ? "" : rising > 0 ? " (rising " + rising + " " + unit + ")" : rising < 0 ? " (falling " + Math.abs(rising) + " " + unit + ")" : " (steady)"),
        forecastTone: fcCat && fcCat.tone !== "#605d5d" ? fcCat.tone : "#605d5d",
        detail: "",
        // A forecast that crosses action while the observation has not is the
        // single most decision-relevant state this feed produces.
        crossing: !!(action != null && stage != null && fcStage != null && stage < action && fcStage >= action)
      };
    }) : [];

    const floodAlerting = floodRows.filter(r => !r.failed && r.categoryTone !== "#605d5d");
    const floodCrossing = floodRows.filter(r => r.crossing);
    const floodDown = floodRows.filter(r => r.failed);
    const floodNote = !floodReady
      ? "Reading the NOAA National Water Prediction Service gauges…"
      : "NOAA National Water Prediction Service (formerly AHPS) · " + (floodRows.length - floodDown.length) + " of "
        + floodRows.length + " gauges reporting · stage shown against each site's own action and flood thresholds"
        + (floodDown.length ? " · " + floodDown.length + " unavailable" : "");
    const floodHeadline = !floodReady ? "" : floodCrossing.length
      ? floodCrossing.length + " gauge" + (floodCrossing.length === 1 ? "" : "s") + " forecast to cross action stage"
      : floodAlerting.length
      ? floodAlerting.length + " gauge" + (floodAlerting.length === 1 ? " is" : "s are") + " at or above action stage"
      : "";
    const floodQuiet = floodReady && !floodAlerting.length && !floodCrossing.length;

    const mt = s.metro || {};
    const metroError = mt.error || null;
    const metroReady = !s.metroLoading && !metroError && !!mt.counts;
    const metroNote = s.metroLoading || !s.metro
      ? "Decoding the Metro Transit GTFS-RT feeds…"
      : proxyBad
      ? "The saved proxy origin \u201c" + proxyBad + "\u201d is not a valid host. Correct it in the Outages tab."
      : metroError
      ? "Metro feeds need the proxy origin set in the Outages tab — " + proxyHost + " is not answering. Metro publishes protobuf only, so the payload must be decoded server-side."
      : "Bi-State Development GTFS-RT, decoded on the wire · " + mt.counts.vehiclesReporting + " vehicles and "
        + mt.counts.tripsReporting + " trips reporting · feed stamped "
        + (mt.feedTimestamps && mt.feedTimestamps.vehicles ? fmtZoned(mt.feedTimestamps.vehicles) : "—");

    const metroStats = metroReady ? [
      { label: "Active service alerts", value: String(mt.counts.activeAlerts), note: mt.counts.alertsTotal + " in the feed" },
      { label: "Trips 5+ min late", value: String(mt.counts.tripsLate5Min), note: "of " + mt.counts.tripsReporting + " reporting" },
      { label: "Median system delay", value: mt.counts.medianSystemDelayMin == null ? "—" : mt.counts.medianSystemDelayMin + " min", note: "Across all reporting trips" },
      { label: "Vehicles within " + (mt.ring ? mt.ring.radiusMiles : 3) + " mi", value: String(mt.ring ? mt.ring.vehicles : 0), note: mt.ring && mt.ring.nearestMiles != null ? "Nearest " + mt.ring.nearestMiles + " mi" : "None in ring" }
    ] : [];

    const metroAlerts = metroReady ? (mt.alerts || []).slice(0, 6).map(a => ({
      header: a.header || "Service alert",
      description: a.description || "",
      tag: [a.effect, a.cause].filter(Boolean).join(" · "),
      tagTone: /no service|significant delays/i.test(a.effect || "") ? "#ec3013" : "#605d5d",
      routes: a.routes && a.routes.length ? "Routes: " + a.routes.slice(0, 8).join(", ") : ""
    })) : [];

    const metroDelays = metroReady ? (mt.routeDelays || []).filter(r => r.medianDelayMin >= 1).slice(0, 8).map(r => ({
      route: r.route,
      median: (r.medianDelayMin > 0 ? "+" : "") + r.medianDelayMin + " min",
      tone: r.medianDelayMin >= 5 ? "#ec3013" : "#201e1d",
      detail: r.trips + " trip" + (r.trips === 1 ? "" : "s") + (r.lateTrips ? " · " + r.lateTrips + " late" : "")
    })) : [];

    const metroQuiet = metroReady && !metroAlerts.length && !metroDelays.length;
    const metroNotes = metroReady && mt.notes && mt.notes.length ? mt.notes.join(" · ") : "";

    const lc = s.local || {};
    const localError = lc.error || null;
    const localReady = !s.localLoading && !localError && Array.isArray(lc.items);
    const localNote = s.localLoading || !s.local
      ? "Merging the St. Louis outlet feeds…"
      : proxyBad
      ? "The saved proxy origin \u201c" + proxyBad + "\u201d is not a valid host. Correct it in the Outages tab — these feeds cannot be read without a proxy."
      : localError
      ? "Local outlet feeds need the proxy origin set in the Outages tab — " + proxyHost + " is not answering. None of these outlets send CORS headers, so a browser cannot read them directly."
      : lc.outletsAnswering + " of " + lc.outletsTotal + " outlets answering · " + lc.itemsScanned
        + " headlines scanned over " + lc.windowHours + " h · " + lc.counts.relevant + " matched a hazard term or campus-area reference";
    const localItems = localReady ? lc.items.slice(0, 12).map(i => ({
      title: i.title,
      url: i.url,
      why: i.why,
      whyTone: /campus area/.test(i.why) ? "#ec3013" : "#605d5d",
      meta: [i.outlet, i.ageHours == null ? "" : i.ageHours < 1
        ? Math.max(1, Math.round(i.ageHours * 60)) + " min ago"
        : Math.round(i.ageHours) + " h ago"].filter(Boolean).join(" · ")
    })) : [];
    const localEmpty = localReady && !lc.items.length;
    const localQuiet = localReady && lc.outletsAnswering < lc.outletsTotal
      ? (lc.outlets || []).filter(o => !o.ok).map(o => o.outlet).join(", ")
      : "";

    const scan = s.newsScan || {};
    const scanArticles = scan.articles || [];
    const news = scanArticles.map(a => ({
      title: a.title,
      url: a.url,
      domain: (function () { try { return new URL(a.url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } })(),
      why: a.where.join(" · "),
      meta: (function () {
        const domain = (function () { try { return new URL(a.url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } })();
        const time = a.date ? fmtZoned(a.date) : "";
        const t = Date.parse(a.date);
        const age = isNaN(t) ? "" : ((Date.now() - t) / 3600000 < 1
          ? Math.max(1, Math.round((Date.now() - t) / 60000)) + " min ago"
          : Math.round((Date.now() - t) / 3600000) + " h ago");
        return [domain, time, age].filter(Boolean).join(" · ");
      })()
    }));
    const newsConnected = !!scan.stamp;
    const newsRelevant = scanArticles;
    const newsRaw = { length: scan.corpus || 0 };
    if (!news.length) news.push({
      title: s.newsScanning
        ? "Scanning the GDELT Web NGrams minute files… the rest of the dashboard is already live."
        : scan.error
        ? "GDELT ngrams unavailable: " + scan.error
        : "No St. Louis hazard or campus coverage in the last 24 hours (" + (scan.corpus || 0) + " English articles across " + (scan.minutes || 1) + " minute files).",
      url: "https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/",
      meta: "gdeltproject.org",
      why: ""
    });

    const st = (ok, okLabel) => ok
      ? { status: okLabel || "Live", dot: "#201e1d", chipBg: "#201e1d", chipFg: "#f3f2f2", tone: "#605d5d" }
      : { status: "Not connected", dot: "#ec3013", chipBg: "#ffe0d9", chipFg: "#7c1405", tone: "#ae1800" };

    const registry = [
      { name: "NWS active alerts (CAP)", endpoint: "api.weather.gov/alerts/active?point=…", detail: err.alertsD ? err.alertsD : ca.length + " covering campus · " + s.moAlerts.length + " statewide", ...st(!err.alertsD) },
      { name: "NWS hourly forecast", endpoint: "api.weather.gov/gridpoints/LSX/…", detail: err.hourly || err.points ? (err.hourly || err.points) : s.hourly.length + " hourly periods", ...st(s.hourly.length > 0) },
      { name: "ASOS observations · KSTL", endpoint: "api.weather.gov/stations/KSTL/observations/latest", detail: err.obs ? err.obs : "Observed " + fmtZoned(o.timestamp), ...st(!err.obs) },
      { name: "USGS NWIS river gauges", endpoint: "waterservices.usgs.gov/nwis/iv/ · sites=07010000 + countyCd=29189,29510", detail: err.gauges || err.gaugeMain ? (err.gaugeMain || err.gauges) : "Mississippi mainstem + " + Math.max(0, gauges.length - 1) + " nearest county sites", ...st(!err.gauges || !err.gaugeMain) },
      { name: "Air quality (CAMS via Open-Meteo)", endpoint: "air-quality-api.open-meteo.com/v1/air-quality", detail: err.air ? err.air : "AQI " + (aqi === undefined ? "—" : Math.round(aqi)), ...st(!err.air) },
      { name: "USGS seismic events", endpoint: "earthquake.usgs.gov/fdsnws/event/1/query", detail: err.quakes ? err.quakes : (s.quakes || []).length + " events, 30 days, M2.5+", ...st(!err.quakes) },
      { name: "GDELT GKG 2.0 themes", endpoint: "storage.googleapis.com/data.gdeltproject.org/gdeltv2 · *.gkg.csv.zip", detail: gk.files ? gk.matched + (gk.matched === 1 ? " geo-tagged record" : " geo-tagged records") + " from " + gk.rows + " across " + gk.files + (gk.files === 1 ? " file (" : " files (") + gk.mb + " MB inflated)" : (gk.error || "not scanned"), ...st(!!gk.files, gkgRecords.length ? "Live" : "Live · 0 hits") },
      { name: "Ameren outage map (via Worker)", endpoint: proxyHost + "/ameren", detail: s.powerLoading ? "Scraping the KUBRA file layout…" : (s.power && s.power.error) ? s.power.error : powerReady ? (ring.outages || 0) + " outages within 10 mi · " + (ring.customersOut || 0) + " customers out" : "Not yet fetched", ...st(powerReady) },
      { name: "NOAA NWPS flood stages", endpoint: "api.water.noaa.gov/nwps/v1/gauges", detail: floodReady ? (floodRows.length - floodRows.filter(r => r.failed).length) + " of " + floodRows.length + " gauges with action/flood thresholds" : "Not yet fetched", ...st(floodReady) },
      { name: "Metro Transit GTFS-RT (via proxy)", endpoint: proxyHost + "/metro", detail: s.metroLoading ? "Decoding the protobuf feeds…" : metroError ? metroError : metroReady ? mt.counts.activeAlerts + " active alerts · " + mt.counts.tripsLate5Min + " trips 5+ min late · " + (mt.ring ? mt.ring.vehicles : 0) + " vehicles near campus" : "Not yet fetched", ...st(metroReady) },
      { name: "St. Louis outlet RSS (via proxy)", endpoint: proxyHost + "/localnews", detail: s.localLoading ? "Merging the outlet feeds…" : localError ? localError : localReady ? lc.counts.relevant + " relevant of " + lc.itemsScanned + " headlines · " + lc.outletsAnswering + "/" + lc.outletsTotal + " outlets" : "Not yet fetched", ...st(localReady) },
      { name: "GDELT Web NGrams", endpoint: "storage.googleapis.com/data.gdeltproject.org/gdeltv5/weblegacy/ngrams", detail: newsConnected ? newsRelevant.length + " relevant in the 24 h window · " + (scan.corpus || 0) + " articles across " + (scan.minutes || 1) + " minute files" : (scan.error || "not scanned"), ...st(newsConnected, newsRelevant.length ? "Live" : "Live · 0 hits") },
      { name: "EPA AirNow (official AQI)", endpoint: "airnowapi.org/aq/observation", detail: "Requires free API key", ...st(false) },
      { name: "X / Bluesky / Reddit listening", endpoint: "platform APIs", detail: "Requires authenticated app credentials", ...st(false) },
      { name: "WUPD CAD / WashU Alert", endpoint: "internal systems", detail: "Internal integration — not open-source data", ...st(false) }
    ];

    const connected = registry.filter(r => r.status === "Live").length;

    const kpis = [
      { label: "Alerts covering campus", value: s.loading ? "…" : String(ca.length), note: ca.length ? alerts.map(x => x.event).join(", ") : "None at retrieval time", tone: ca.length ? "#ae1800" : "#201e1d" },
      { label: "Missouri alerts active", value: s.loading ? "…" : String(s.moAlerts.length), note: "All NWS CAP products, statewide", tone: "#201e1d" },
      { label: "Temperature · KSTL", value: t === null ? "—" : t + "°F", note: hi === null ? (o.textDescription || "—") : "Heat index " + hi + "°F", tone: t !== null && t >= 90 ? "#ae1800" : "#201e1d" },
      { label: "US AQI", value: aqi === undefined ? "—" : String(Math.round(aqi)), note: aqi === undefined ? "—" : aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" : "Unhealthy for sensitive groups", tone: aqi >= 101 ? "#ae1800" : "#201e1d" },
      { label: "Peak PoP next 24h", value: s.hourly.length ? Math.max(...s.hourly.map(h => (h.probabilityOfPrecipitation && h.probabilityOfPrecipitation.value) || 0)) + "%" : "—", note: "NWS hourly forecast", tone: "#201e1d" },
      { label: "Feeds connected", value: connected + " / " + registry.length, note: (registry.length - connected) + " need a key or proxy", tone: "#201e1d" }
    ];

    const envBits = [];
    if (t !== null) envBits.push("KSTL reports " + t + "°F" + (o.textDescription ? ", " + o.textDescription.toLowerCase() : "") + (wind ? ", wind " + wind + " mph" + (gust ? " gusting " + gust : "") : "") + ".");
    if (aqi !== undefined) envBits.push("US AQI " + Math.round(aqi) + ".");
    if (floodReady) {
      const reporting = floodRows.filter(r => !r.failed);
      const miss = floodRows.find(r => r.label === "Mississippi at St. Louis" && !r.failed);
      if (floodCrossing.length) {
        envBits.push("NWPS forecasts " + floodCrossing.map(r => r.label).join(" and ") + " to cross action stage: "
          + floodCrossing.map(r => r.forecast.replace(/^Forecast /, "")).join("; ") + ".");
      } else if (floodAlerting.length) {
        envBits.push(floodAlerting.map(r => r.label + " at " + r.stage + " (" + r.category.toLowerCase() + ")").join("; ") + ".");
      } else if (miss) {
        envBits.push("Mississippi at St. Louis " + miss.stage + ", " + miss.headroom
          + "; all " + reporting.length + " NWPS gauges below action stage.");
      }
    } else if (mainGauge) {
      envBits.push("Mississippi River at St. Louis gage height " + mainGauge.value + " (USGS stage; NWPS thresholds still loading).");
    } else if (gauges[0] && gauges[0].value !== "—") {
      envBits.push("Nearest reporting gauge: " + gauges[0].name + " at " + gauges[0].value + ".");
    }

    /* Feeds that reach the summary only when they actually returned data, so the
       paragraph never implies coverage the desk does not have. */
    const opsBits = [];
    if (powerReady) {
      opsBits.push(ring.outages
        ? "Ameren reports " + ring.outages + " outage" + (ring.outages === 1 ? "" : "s") + " within " + (ring.radiusMiles || 10)
          + " miles affecting " + (ring.customersOut || 0) + " customers"
          + (ring.expiredEtrs ? ", " + ring.expiredEtrs + " past estimated restore" : "") + "."
        : "No Ameren outages within " + (ring.radiusMiles || 10) + " miles of campus.");
    }
    if (metroReady) {
      opsBits.push(mt.counts.activeAlerts || mt.counts.tripsLate5Min
        ? "Metro has " + mt.counts.activeAlerts + " active service alert" + (mt.counts.activeAlerts === 1 ? "" : "s")
          + " and " + mt.counts.tripsLate5Min + " trip" + (mt.counts.tripsLate5Min === 1 ? "" : "s") + " running 5 or more minutes late."
        : "Metro is running to schedule with no active service alerts.");
    }
    if (localReady) {
      opsBits.push(lc.counts.relevant
        ? lc.counts.relevant + " St. Louis outlet " + (lc.counts.relevant === 1 ? "story" : "stories") + " matched a hazard or campus term in the last "
          + lc.windowHours + " hours" + (lc.counts.campusArea ? ", " + lc.counts.campusArea + " naming the campus area" : "") + "."
        : "No St. Louis outlet published a hazard or campus story in the last " + lc.windowHours + " hours.");
    }
    if (floodReady && floodRows.some(r => r.failed)) {
      opsBits.push(floodRows.filter(r => r.failed).length + " NWPS gauge(s) did not answer.");
    }

    /* Crash reporting published by the Road Conditions tab. Only surfaced when
       that tab has actually loaded the feed, so the paragraph never implies
       coverage the desk does not have. */
    const rc = (typeof window !== "undefined" && window.__omContext && window.__omContext.roads) || null;
    const nearCrashes = (rc && rc.crashesWithin5Miles) || [];
    if (nearCrashes.length) {
      const fatal = nearCrashes.filter(x => String(x.severity || "").toUpperCase() === "FATAL").length;
      const closest = nearCrashes.slice().sort((a, b) => (a.miles || 99) - (b.miles || 99))[0];
      opsBits.push(nearCrashes.length + " Highway Patrol crash report" + (nearCrashes.length === 1 ? "" : "s")
        + " within 5 miles of campus in the last 7 days" + (fatal ? ", " + fatal + " fatal" : "")
        + (closest && closest.location ? "; nearest " + closest.miles + " mi at " + String(closest.location).toLowerCase() : "") + ".");
    } else if (rc && rc.crashReports === 0) {
      opsBits.push("No Highway Patrol crash reports in the St. Louis-area counties over the last 7 days.");
    }
    if (rc && rc.crashNews && rc.crashNews.length) {
      opsBits.push(rc.crashNews.length + " local outlet " + (rc.crashNews.length === 1 ? "story" : "stories")
        + " report a crash near campus — unverified until matched to a Patrol or police record.");
    }

    /* Public health, published by the Health Watch tab. Only the two figures a
       campus desk would act on: whether Missouri ILI is above the CDC baseline,
       and whether a Class I food recall names Missouri distribution. */
    const hw = (typeof window !== "undefined" && window.__omContext && window.__omContext.health) || null;
    if (hw && hw.iliMissouri != null) {
      const hot = hw.iliMissouri >= (hw.iliBaseline || 3);
      opsBits.push("Missouri outpatient influenza-like illness is " + hw.iliMissouri.toFixed(2) + "% of visits for the week ending "
        + hw.iliWeekEnding + ", " + (hot ? "above" : "below") + " the CDC national baseline"
        + (hw.missouriBedOccupancy != null ? "; Missouri inpatient beds " + hw.missouriBedOccupancy.toFixed(0) + "% occupied" : "") + ".");
    }
    if (hw && hw.missouriRecalls120d) {
      opsBits.push(hw.missouriRecalls120d + " FDA food recall" + (hw.missouriRecalls120d === 1 ? "" : "s")
        + " in the last 120 days name Missouri distribution" + (hw.classIRecalls120d ? ", of " + hw.classIRecalls120d + " Class I recalls nationally" : "") + ".");
    }

    const summary = s.loading ? "Querying connected feeds…"
      : hasAlerts
        ? alerts.length + " active NWS product" + (alerts.length === 1 ? "" : "s") + " cover" + (alerts.length === 1 ? "s" : "") + " a Washington University campus: " + alerts.map(x => x.event + " (" + x.campus.replace(" in polygon", "") + ", to " + x.expires + ")").join("; ") + "."
        : "No NWS alert polygon currently covers the Danforth or Medical campus coordinate. " + s.moAlerts.length + " alert" + (s.moAlerts.length === 1 ? "" : "s") + " active elsewhere in Missouri; " + (temps.length ? "forecast high of " + tmax + "°F and peak precipitation probability of " + Math.max(...s.hourly.map(h => (h.probabilityOfPrecipitation && h.probabilityOfPrecipitation.value) || 0)) + "% in the next 24 hours." : "hourly forecast unavailable.");

    const views = [["hazards", "All-Hazards Picture"], ["weather", "Weather Monitoring"], ["roads", "Road Conditions"], ["outages", "Outages"], ["health", "Health Watch"], ["cyber", "Cyber Watch"]].map(([k, label]) => ({
      label,
      bg: (s.view || "hazards") === k ? "#201e1d" : "transparent",
      fg: (s.view || "hazards") === k ? "#f3f2f2" : "#201e1d",
      key: k
    }));

    return {
      views,
      isHazards: (s.view || "hazards") === "hazards",
      isWeather: s.view === "weather",
      weatherDisplay: s.view === "weather" ? "block" : "none",
      roadsDisplay: s.view === "roads" ? "block" : "none",
      outagesDisplay: s.view === "outages" ? "block" : "none",
      healthDisplay: s.view === "health" ? "block" : "none",
      cyberDisplay: s.view === "cyber" ? "block" : "none",
      isOutages: s.view === "outages",
      isRoads: s.view === "roads",
      pageTitle: s.view === "weather" ? "Weather Monitoring" : s.view === "roads" ? "Road Conditions & Traffic Cameras" : s.view === "outages" ? "Utility Outages · Power and Water" : s.view === "health" ? "Health Watch · National Public Health Picture" : s.view === "cyber" ? "Cyber Watch · Healthcare, Research & Higher Education" : "All-Hazards Common Operating Picture",
      retrieved,
      retrievedFull: s.retrieved ? "Retrieved " + s.retrieved.toLocaleString("en-US", { timeZone: TZ }) + " CT" : "",
      liveDot: s.loading ? "#9b9797" : "#ec3013",
      liveLabel: s.loading ? "Fetching" : "Snapshot at " + retrieved,
      alertBandBg: bandRed ? "#ec3013" : "#eae9e9",
      alertBandFg: bandRed ? "#f3f2f2" : "#201e1d",
      alertBandRule: bandRed ? "rgba(243,242,242,0.5)" : "rgba(32,30,29,0.4)",
      alertHeadCount, alertHeadLine, hasAlerts, alerts, kpis,
      obsStation: err.obs ? "KSTL — unreachable" : "KSTL Lambert Field ASOS · observed " + fmtZoned(o.timestamp),
      observation, gauges, air, quakes,
      summary,
      summaryBasis: connected + " of " + registry.length + " feeds connected",
      summaryAlerts: hasAlerts ? alerts.map(x => x.event + " — " + (x.headline || x.area)).join(" · ") : "No campus-covering NWS product at retrieval time. Statewide count: " + s.moAlerts.length + ".",
      summaryEnv: envBits.length ? envBits.join(" ") : "Environmental feeds returned no values.",
      summaryOps: opsBits.length ? opsBits.join(" ") : "",
      summaryHasOps: !!opsBits.length,
      summaryCols: opsBits.length ? "repeat(4, 1fr)" : "repeat(3, 1fr)",
      summaryGaps: (function () {
        const absent = ["social-platform", "campus-CAD"];
        const pending = [];
        if (!powerReady) pending.push("electric-utility outages");
        if (!metroReady) pending.push("transit");
        if (!localReady) pending.push("local outlet news");
        return "No " + absent.slice(0, -1).join(", ") + " or " + absent[absent.length - 1] + " data is present in this snapshot — those feeds are not connected."
          + (pending.length ? " " + (pending.length === 1 ? pending[0] : pending.slice(0, -1).join(", ") + " and " + pending[pending.length - 1]).replace(/^./, c => c.toUpperCase())
            + (pending.length === 1 ? " is" : " are") + " read through the proxy, which is not answering, so "
            + (pending.length === 1 ? "it is" : "they are") + " absent here too." : "")
          + " MoDOT roadway conditions are live on the Road Conditions tab.";
      })(),
      hourlySource: err.hourly || err.points ? "Unavailable" : "api.weather.gov",
      hourlyRange: s.hourly.length ? "Periods " + fmtTime(s.hourly[0].startTime) + " to " + fmtTime(s.hourly[s.hourly.length - 1].startTime) + " " + tzAbbr(s.hourly[0].startTime) + " · " + s.hourly.length + " hours" : "No hourly periods returned",
      hourlyCols: String(Math.max(1, s.hourly.length)),
      chart, chartModes, hourlyStats,
      tempRange: temps.length ? tmin + "–" + tmax + "°F" : "—",
      inventory,
      inventoryNote: err.moAlerts ? "Statewide query failed: " + err.moAlerts : "Grouped from " + s.moAlerts.length + " active CAP products for area=MO. Campus column tests the same alert IDs against both campus point queries.",
      newsSource: newsConnected
        ? "GDELT Web NGrams · rolling 24 h to " + scan.stamp + " · " + (scan.minutes || 1) + " minute files swept, " + (scan.corpus || 0) + " English articles" + (scan.retained ? ", " + scan.retained + " retained in window" : "")
          + (scan.deep ? ", quadgram body scan" + (scan.scannedMB ? " of " + scan.scannedMB + " MB" : "") + (scan.partial ? " (capped)" : "") : ", headline scan only")
          + " · " + newsRelevant.length + " relevant: hazard co-occurrence or campus mention (Minnesota's St. Louis County excluded)"
        : "GDELT Web NGrams · " + (s.newsScanning ? "scanning minute files…" : (scan.error || "not yet scanned")),
      news, registry,
      localNote, localItems, localReady, localEmpty, localQuiet,
      metroNote, metroStats, metroAlerts, metroDelays, metroReady, metroQuiet, metroNotes,
      floodNote, floodRows, floodReady, floodHeadline, floodQuiet,
      powerNote, powerStats, powerOutages, powerCounties, powerCauses, powerReady, powerStorm,
      proxyOrigin, proxyBlocked, proxyPanel, proxyPanelNote, proxyHost, proxyBad,
      proxyDraft: s.proxyDraft === undefined ? proxyOrigin : s.proxyDraft,
      gkgNote, gkgThemes, gkgRecords, gkgEmpty, gkgShowBars, gkgSingleNote,
      registryNote: connected + " live · " + (registry.length - connected) + " require credentials or a proxy"
    };
  }

  W.buildView = buildView;
})();

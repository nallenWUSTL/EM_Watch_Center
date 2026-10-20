/* Dashboard shell controller: owns the All-Hazards and Outages state, loads
   their feeds, paints the dynamic regions and switches tabs. The four map tabs
   are custom elements that run themselves; they stay mounted while hidden so
   they keep publishing context to the situation summary. */
(function () {
  const W = window.WUEM;
  const { CFG, DANFORTH, MEDICAL, ENDPOINT_STORE, normalizeOrigin } = W;

  let state = { view: "hazards", chartMode: "temp", loading: true, retrieved: null, alertsD: [], alertsM: [], moAlerts: [], obs: null, hourly: [], gauges: null, gaugeMain: null, air: null, quakes: null, news: null, errors: {} };
  let lastPowerAt = 0;
  let lastNewsAt = 0;

  /* setState merges and repaints once per tick, however many updates land in
     it; callbacks run after the paint, as the prototype's runtime did. */
  let paintQueued = false;
  let afterPaint = [];
  function setState(patch, cb) {
    state = Object.assign({}, state, patch);
    if (cb) afterPaint.push(cb);
    if (paintQueued) return;
    paintQueued = true;
    queueMicrotask(() => {
      paintQueued = false;
      paint();
      const cbs = afterPaint; afterPaint = [];
      cbs.forEach(f => f());
    });
  }

  // NOAA's National Water Prediction Service (the successor to AHPS) is CORS-open,
  // so these are read straight from the browser — no proxy, which means this panel
  // keeps working on managed devices where *.workers.dev is blocked.
  // Ordered upstream-to-downstream where it matters: an upstream gauge is a lead
  // indicator for the one below it.
  const NWPS_GAUGES = [
    { id: "eadm7", label: "Mississippi at St. Louis", note: "Downtown and Medical Campus exposure" },
    { id: "sclm7", label: "Missouri at St. Charles", note: "West county commute routes" },
    { id: "arnm7", label: "Meramec at Arnold", note: "South county commute routes" },
    { id: "pcfm7", label: "Meramec near Pacific", note: "Upstream of Arnold — lead indicator" },
    { id: "grfi2", label: "Mississippi at Grafton", note: "Upstream of St. Louis — lead indicator" },
    { id: "alni2", label: "Mississippi at Mel Price", note: "Alton lock and dam" }
  ];

  async function load() {
    setState({ loading: true, errors: {} });
    const errors = {};
    const j = async (key, url, opts) => {
      try {
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) { errors[key] = e.message || String(e); return null; }
    };

    const nws = { headers: { Accept: "application/geo+json" } };
    if (!lastPowerAt || Date.now() - lastPowerAt >= 120000) {
      lastPowerAt = Date.now();
      setState({ powerLoading: true });
      const origin = W.proxyOrigin();
      setState({ metroLoading: true });
      fetch(origin + "/metro?radius=3", { signal: AbortSignal.timeout(25000) })
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then(metro => setState({ metro, metroLoading: false }))
        .catch(e => setState({ metro: { error: e && e.message ? e.message : String(e) }, metroLoading: false }));
      setState({ localLoading: true });
      fetch(origin + "/localnews?hours=24", { signal: AbortSignal.timeout(25000) })
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then(local => setState({ local, localLoading: false }))
        .catch(e => setState({ local: { error: e && e.message ? e.message : String(e) }, localLoading: false }));
      const radius = Math.max(2, Math.min(30, CFG.ringRadiusMiles || 10));
      fetch(origin + "/ameren?radius=" + radius, { signal: AbortSignal.timeout(25000) })
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then(power => setState({ power, powerLoading: false }))
        .catch(e => setState({ power: { error: e && e.message ? e.message : String(e) }, powerLoading: false }));
    }
    const NEWS_MIN_INTERVAL = 900000; // ngrams publish on a 15-minute heartbeat
    const newsDue = !lastNewsAt || Date.now() - lastNewsAt >= NEWS_MIN_INTERVAL;
    if (newsDue) {
      lastNewsAt = Date.now();
      // Detached: the ngrams scan streams tens of megabytes and must never gate
      // first paint of the alert band, observations or forecast.
      setState({ newsScanning: true });
      W.newsScan(state.newsDeep !== false)
        .then(scan => setState({ newsScan: scan, newsScanning: false }))
        .catch(e => setState({ newsScan: { error: e && e.message ? e.message : String(e) }, newsScanning: false }));
      setState({ gkgScanning: true });
      W.gkgScan()
        .then(gkg => setState({ gkg: gkg, gkgScanning: false }))
        .catch(e => setState({ gkg: { error: e && e.message ? e.message : String(e) }, gkgScanning: false }));
    }

    const [alertsD, alertsM, moAlerts, points, obs, gauges, gaugeMain, air, quakes, news] = await Promise.all([
      j("alertsD", "https://api.weather.gov/alerts/active?point=" + DANFORTH.lat + "," + DANFORTH.lon, nws),
      j("alertsM", "https://api.weather.gov/alerts/active?point=" + MEDICAL.lat + "," + MEDICAL.lon, nws),
      j("moAlerts", "https://api.weather.gov/alerts/active?area=MO", nws),
      j("points", "https://api.weather.gov/points/" + DANFORTH.lat + "," + DANFORTH.lon, nws),
      j("obs", "https://api.weather.gov/stations/KSTL/observations/latest", nws),
      j("gauges", "https://waterservices.usgs.gov/nwis/iv/?format=json&countyCd=29189,29510&parameterCd=00065&siteStatus=active"),
      j("gaugeMain", "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=07010000&parameterCd=00065,00060&siteStatus=active"),
      j("air", "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + DANFORTH.lat + "&longitude=" + DANFORTH.lon + "&current=us_aqi,pm2_5,pm10,ozone&timezone=America%2FChicago"),
      j("quakes", "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=" + new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) + "&minmagnitude=2.5&minlatitude=34.5&maxlatitude=39.5&minlongitude=-92&maxlongitude=-87.5&orderby=time"),
      Promise.resolve(null)
    ]);

    Promise.all(NWPS_GAUGES.map(async g => {
      try {
        const r = await fetch("https://api.water.noaa.gov/nwps/v1/gauges/" + g.id, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        return { ...g, ok: true, data: d };
      } catch (e) { return { ...g, ok: false, detail: e && e.message ? e.message : String(e) }; }
    })).then(nwps => setState({ nwps }));

    let hourly = [];
    if (points && points.properties && points.properties.forecastHourly) {
      const h = await j("hourly", points.properties.forecastHourly, nws);
      if (h && h.properties) hourly = h.properties.periods.slice(0, 24);
    }

    setState({ loading: false, retrieved: new Date(), alertsD: (alertsD && alertsD.features) || [], alertsM: (alertsM && alertsM.features) || [], moAlerts: (moAlerts && moAlerts.features) || [], obs: obs && obs.properties, hourly, gauges, gaugeMain, air: air && air.current, quakes: quakes && quakes.features, newsSkipped: !newsDue, errors });
  }

  function saveProxyOrigin(value) {
    const raw = String(value || "").trim();
    const v = normalizeOrigin(raw);
    try {
      if (!raw) localStorage.removeItem(ENDPOINT_STORE);
      else localStorage.setItem(ENDPOINT_STORE, v || raw);   // keep the bad value visible so the message can name it
    } catch (e) {}
    lastPowerAt = 0;
    setState({ proxyDraft: v, power: null }, () => load());
  }

  const TITLES = {
    hazards: "All-Hazards Common Operating Picture",
    weather: "Weather Monitoring",
    roads: "Road Conditions & Traffic Cameras",
    outages: "Utility Outages · Power and Water",
    health: "Health Watch · National Public Health Picture",
    cyber: "Cyber Watch · Healthcare, Research & Higher Education",
    briefing: "Daily Intelligence Briefing"
  };

  // The briefing lives on claude.ai (the scheduled task writes to its store),
  // so this tab only links out. The address comes from config.js.
  (function wireBriefingLink() {
    const url = W.normalizeOrigin(CFG.briefingUrl) ? String(CFG.briefingUrl).trim() : "";
    const link = document.querySelector("[data-briefing-link]");
    const missing = document.querySelector("[data-briefing-missing]");
    if (link) { link.hidden = !url; if (url) link.href = url; }
    if (missing) missing.hidden = !!url;
  })();

  const $ = sel => document.querySelector(sel);
  const views = {};
  document.querySelectorAll("[data-view]").forEach(el => { views[el.getAttribute("data-view")] = el; });

  /* innerHTML replacement would drop focus and the caret from the proxy field
     whenever a feed lands mid-edit, so its value and selection are carried
     across the repaint. */
  function paintRegion(el, markup) {
    const next = String(markup);
    if (el.__last === next) return;
    const active = document.activeElement;
    const keep = active && el.contains(active) && active.matches("[data-proxy-input]")
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
    el.innerHTML = next;
    el.__last = next;
    if (keep) {
      const input = el.querySelector("[data-proxy-input]");
      if (input) { input.value = keep.value; input.focus(); try { input.setSelectionRange(keep.start, keep.end); } catch (e) {} }
    }
  }

  function paint() {
    const v = W.buildView(state);
    const view = state.view || "hazards";
    const isHazards = view === "hazards";
    $("[data-title]").textContent = TITLES[view] || TITLES.hazards;
    document.title = (TITLES[view] || TITLES.hazards) + " · WashU EOC Watch Desk";
    const actions = $("[data-header-actions]");
    actions.hidden = !isHazards;
    if (isHazards) paintRegion(actions, W.render.headerActions(v));
    paintRegion($("[data-tabs]"), W.render.tabs(v));
    Object.keys(views).forEach(k => { views[k].hidden = k !== view; });
    // The All-Hazards view is only built while it is showing, as before.
    if (isHazards) paintRegion(views.hazards, W.render.hazards(v));
    paintRegion($("[data-power]"), W.render.power(v));
    $("[data-retrieved-full]").textContent = v.retrievedFull;
  }

  document.addEventListener("click", e => {
    const el = e.target.closest("[data-action]");
    if (!el || el.tagName === "FORM") return;
    const action = el.getAttribute("data-action");
    if (action === "view") {
      setState({ view: el.getAttribute("data-key") });
      // Leaflet maps inside a tab that was display:none measured 0x0; nudge them.
      setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
    }
    else if (action === "chart-mode") setState({ chartMode: el.getAttribute("data-key") });
    else if (action === "refresh") load();
    else if (action === "proxy-reset") saveProxyOrigin("");
  });
  document.addEventListener("input", e => {
    if (e.target.matches("[data-proxy-input]")) state.proxyDraft = e.target.value;
  });
  document.addEventListener("submit", e => {
    const form = e.target.closest("[data-action='proxy-save']");
    if (!form) return;
    e.preventDefault();
    saveProxyOrigin(form.querySelector("[data-proxy-input]").value);
  });

  // Background tabs publish their context asynchronously; repaint when they do.
  window.addEventListener("om-context", () => setState({}));

  paint();
  load();
})();

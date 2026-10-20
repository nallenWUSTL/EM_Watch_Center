/* MoDOT road conditions view. Registers <road-conditions>.
   Requires Leaflet + esri-leaflet on the page (loaded in the DC helmet). */
(function () {
  /* CARTO now throttles anonymous basemap tiles and stamps an "API key required"
     watermark on them, so tile URLs carry the account key.

     Two guards matter here. Leaflet runs tile URLs through L.Util.template, which
     treats {name} as a variable, so a key holding braces (an unsubstituted secret
     placeholder, say) makes Leaflet THROW while building the first tile URL. And a
     throw on the basemap line would abort the rest of map setup, taking the hazard
     layers with it. So the key is validated before use, passed as a named Leaflet
     option rather than interpolated, and the basemap is added inside a try/catch
     after the data layers exist. */
  const CARTO_KEY_RAW = String((window.WUEM_CONFIG || {}).cartoKey || "");
  const CARTO_KEY = /^[A-Za-z0-9_-]+$/.test(CARTO_KEY_RAW) ? CARTO_KEY_RAW : null;
  const CARTO_URL = style => "https://{s}.basemaps.cartocdn.com/" + style + "/{z}/{x}/{y}{r}.png"
    + (CARTO_KEY ? "?key={key}" : "");
  const cartoBasemap = (map, style) => {
    try {
      const opts = { attribution: "&copy; OpenStreetMap contributors &copy; CARTO", subdomains: "abcd", maxZoom: 20 };
      if (CARTO_KEY) opts.key = CARTO_KEY;
      return L.tileLayer(CARTO_URL(style), opts).addTo(map);
    } catch (e) {
      return null; // a basemap is scenery; the data layers must still load
    }
  };

  const ROADS_URL = "https://mapping.modot.org/arcgis/rest/services/TravelerInformation/RoadConditions/MapServer";
  const CAMERAS_URL = "https://services2.arcgis.com/jWXb6JPWtBjOCalT/ArcGIS/rest/services/MODOT_Traffic_Cameras/FeatureServer/1";
  const TRAVELER_URL = "https://mapping.modot.org/arcgis/rest/services/TravelerInformation/TravelerInformationData/MapServer";
  const ASSET_COORD = [38.6482, -90.3056];
  const MED_COORD = [38.6353, -90.2636]; // Medical Campus · Euclid at Barnes-Jewish
  const SITES = [
    { key: "danforth", label: "Danforth · Brookings Hall", coord: ASSET_COORD },
    { key: "medical", label: "Medical Campus", coord: MED_COORD }
  ];
  const WALL_RADIUS_MI = 3;
  // Short buffers: a wall of a dozen live feeds must not hold minutes of video.
  const WALL_HLS_CONFIG = { lowLatencyMode: false, maxBufferLength: 12, maxMaxBufferLength: 24, backBufferLength: 4,
    manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 2 };
  const FEED_CONNECT_TIMEOUT_MS = 20000;
  const FEED_STALL_MS = 12000;
  const FEED_DEAD_MS = 30000;

  /* Diagnoses a live HLS feed instead of letting it sit black. Reports through
     onState(state, text): connecting | buffering | live | stale (the playlist
     answers but has not advanced in several reloads — the camera is down while
     the server is up) | timeout (connected, no frame in 20 s) | stopped (was
     playing, frozen 30 s) | decode (media error survived one recovery) |
     failed (network or other fatal error). Returns { stop() }. */
  function watchFeed(hls, video, url, onState) {
    const H = window.Hls;
    const started = Date.now();
    let lastSN = null, sameSN = 0, lastPdt = null;
    let lastProgressAt = 0, lastTime = -1, playing = false, recovered = false, parseErrors = 0, done = false;
    let state = "connecting";
    const fmtClock = ms => { try { return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };
    const set = (st, text) => { if (done) return; state = st; onState(st, text); };
    const end = (st, text) => { if (done) return; set(st, text); stop(); };

    hls.on(H.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.on(H.Events.LEVEL_LOADED, (ev, data) => {
      const d = data && data.details;
      if (!d || !d.live) return;
      if (!d.fragments || !d.fragments.length) { end("stale", "Feed empty"); return; }
      const last = d.fragments[d.fragments.length - 1];
      if (last && last.programDateTime) lastPdt = last.programDateTime;
      if (d.endSN === lastSN) sameSN++; else { sameSN = 0; lastSN = d.endSN; }
      // Three reloads without a new segment: the encoder behind this playlist
      // has stopped. Stop loading so the slot and the bandwidth go elsewhere.
      if (sameSN >= 3 && !playing) end("stale", lastPdt ? "Not updating since " + fmtClock(lastPdt) : "Not updating");
    });
    hls.on(H.Events.ERROR, (ev, data) => {
      if (!data) return;
      if (data.details === H.ErrorDetails.FRAG_PARSING_ERROR || data.details === H.ErrorDetails.BUFFER_APPEND_ERROR) {
        if (++parseErrors >= 4 && !data.fatal) { end("decode", "Cannot decode video"); return; }
      }
      if (!data.fatal) {
        if (data.details === H.ErrorDetails.BUFFER_STALLED_ERROR && playing) set("buffering", "Buffering…");
        return;
      }
      if (data.type === H.ErrorTypes.MEDIA_ERROR) {
        if (!recovered) { recovered = true; set("buffering", "Recovering…"); try { hls.recoverMediaError(); } catch (e) { end("decode", "Decode error"); } return; }
        end("decode", "Decode error");
        return;
      }
      end("failed", data.type === H.ErrorTypes.NETWORK_ERROR ? "Feed unavailable" : "Feed error");
    });
    hls.loadSource(url);
    hls.attachMedia(video);

    const onPlaying = () => { playing = true; lastProgressAt = Date.now(); set("live", "Live"); };
    const onWaiting = () => { if (playing) set("buffering", "Buffering…"); };
    const onError = () => end("decode", "Decode error");
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("error", onError);

    // The watchdog is what catches a connected feed that never shows a frame,
    // and a frame that froze: currentTime stops moving while nothing errors.
    const timer = setInterval(() => {
      if (done) return;
      const now = Date.now();
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; if (playing) lastProgressAt = now; if (state === "buffering" && playing) set("live", "Live"); }
      if (!playing) {
        if (now - started > FEED_CONNECT_TIMEOUT_MS) end("timeout", lastPdt ? "No video · last frame " + fmtClock(lastPdt) : "No video after " + Math.round(FEED_CONNECT_TIMEOUT_MS / 1000) + " s");
        return;
      }
      const frozen = now - lastProgressAt;
      if (frozen > FEED_DEAD_MS) end("stopped", "Video stopped " + Math.round(frozen / 1000) + " s ago");
      else if (frozen > FEED_STALL_MS && state !== "buffering") set("buffering", "Stalled " + Math.round(frozen / 1000) + " s");
    }, 2000);

    function stop() {
      if (done) return;
      done = true;
      clearInterval(timer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("error", onError);
      try { hls.stopLoad(); } catch (e) {}
    }
    return { stop: stop, state: () => state };
  }
  const FIVE_MILE_METERS = 8046.72;

  const INK = "#201e1d", RULE = "rgba(32,30,29,0.4)", MUTED = "#605d5d", HAIR = "#d7d3d3", GROUND = "#f3f2f2", SURFACE = "#eae9e9", RED = "#ec3013", DEEPRED = "#ae1800";
  const label = extra => "font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:" + MUTED + ";" + (extra || "");

  // MoDOT Traveler Information legend, transcribed from the published map legend.
  // Line colors follow MoDOT's own encoding; the service's legend JSON is not
  // readable from a browser (no CORS headers), so it is declared here.
  const LEGEND = [
    { group: "Incident", items: [["Closed", "#e01b1b"], ["Expect delays", "#f59a0b"], ["Possible delays", "#f2e60c"]] },
    { group: "Flooding", items: [["Closed", "#e01b1b"], ["Expect delays", "#f59a0b"]] },
    { group: "Work zone", items: [["Closed", "#e01b1b"], ["Expect delays", "#f59a0b"], ["Possible delays", "#f2e60c"], ["Future work", "#1f4fd0"]] },
    { group: "Planned event", items: [["Closed", "#e01b1b"], ["Expect delays", "#f59a0b"], ["Possible delays", "#f2e60c"]] },
    { group: "Winter weather", items: [["Closed", "#e01b1b"]] },
    { group: "Road conditions", items: [["Closed", "#e01b1b"], ["Covered", "#8b2fb5"], ["Partly covered", "#1f6fd0"], ["Mostly clear", "#8aa398"], ["Clear", "#cfcfcf"]] },
    { group: "Real-time traffic", items: [["Slow", "#e01b1b"], ["Medium", "#f2e60c"], ["Normal", "#17a815"], ["Data unavailable", "#9b9797"]] }
  ];

  // Point events drawn by the TravelerInformationData service. MoDOT encodes these
  // by SEVERITY, not by category — the same three-step scale applies to every event
  // type, so the categories are listed without inventing a per-category hue.
  const EVENT_TYPES = ["Flooding", "Incident (closed / high / medium / planned)", "Work zone (closed / high / medium / future)", "Winter weather (closed)"];
  const EVENT_SEVERITY = [["Closed", "#e01b1b"], ["Expect delays", "#f59a0b"], ["Possible delays", "#f2e60c"], ["Future work", "#1f4fd0"]];

  // Sublayer ids from the TravelerInformationData MapServer directory, paired so
  // each toggle carries both the point symbol and its line geometry.
  const TI_GROUPS = [
    { key: "flood", label: "Flooding", ids: [0, 10], on: true },
    { key: "inc_closed", label: "Incident · closed", ids: [21, 12], on: true },
    { key: "inc_high", label: "Incident · high", ids: [24, 31], on: true },
    { key: "inc_med", label: "Incident · medium", ids: [25, 32], on: true },
    { key: "inc_planned", label: "Incident · planned", ids: [1, 11], on: true },
    { key: "wz_closed", label: "Work zone · closed", ids: [22, 29], on: true },
    { key: "wz_high", label: "Work zone · high", ids: [26, 33], on: true },
    { key: "wz_med", label: "Work zone · medium", ids: [27, 34], on: true },
    { key: "wz_future", label: "Work zone · future", ids: [28, 35], on: true },
    { key: "winter", label: "Winter weather · closed", ids: [23, 30], on: true }
  ];

  // MoDOT names a road as DESIGNATION + TRAVELWAY_NAME (IS 64, US 67, MO 100),
  // with ramps and connectors carrying the parent route inside their description.
  const CORRIDORS = [
    { key: "i64",   label: "I-64 / US-40",        re: /\b(IS|OR|RV|RP)\s*64\b|IS\s?64|\bUS\s*40\b|FOREST PARK/i },
    { key: "i170",  label: "I-170",               re: /\b(IS|OR|RV|RP)\s*170\b|IS\s?170/i },
    { key: "i270",  label: "I-270",               re: /\b(IS|OR|RV|RP)\s*270\b|IS\s?270/i },
    { key: "i44",   label: "I-44",                re: /\b(IS|OR|RV|RP)\s*44\b|IS\s?44/i },
    { key: "i55",   label: "I-55",                re: /\b(IS|OR|RV|RP)\s*55\b|IS\s?55/i },
    { key: "i70",   label: "I-70",                re: /\b(IS|OR|RV|RP)\s*70\b|IS\s?70/i },
    { key: "mo100", label: "MO-100 · Manchester",  re: /\bMO\s*100\b|MANCHESTER/i },
    { key: "us67",  label: "US-67 · Lindbergh",    re: /\bUS\s*67\b|LINDBERGH/i }
  ];

  const MONTH_ABBR = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

  // The traveler layers mix epoch milliseconds with "25-AUG-2025" strings.
  const parseTiDate = v => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return v > 0 ? v : null;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return Number(s) > 0 ? Number(s) : null;
    const m = s.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})/i);
    if (m) return Date.UTC(Number(m[3]), MONTH_ABBR[m[2].toUpperCase()] || 0, Number(m[1]), 12);
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  };

  const SCAN_OPTIONS = [5, 10, 25];

  // Same resolution the dashboard shell uses: a locally saved override wins over
  // the default Worker host, so a blocked network can be pointed elsewhere.
  const PROXY_STORE = "wuem-proxy-origin";
  const PROXY_DEFAULT = (window.WUEM_CONFIG || {}).workerOrigin || "https://washu-em-ameren.washu-em.workers.dev";
  const proxyOrigin = () => {
    try {
      const raw = (localStorage.getItem(PROXY_STORE) || "").trim();
      if (raw) return new URL(raw).origin;
    } catch (e) { /* fall through to the default */ }
    return PROXY_DEFAULT;
  };

  const CRASH_SEVERITY = {
    "FATAL":     { color: "#ec3013", label: "Fatal",    rank: 4 },
    "SERIOUS":   { color: "#e0700b", label: "Serious",  rank: 3 },
    "MODERATE":  { color: "#f2b705", label: "Moderate", rank: 2 },
    "MINOR":     { color: "#8f8b8b", label: "Minor",    rank: 1 },
    "NO INJURY": { color: "#bab6b6", label: "No injury", rank: 0 }
  };

  // Balanced matching: a crash word plus either a road word or a campus-area
  // place name. Crash words alone pull in national wire copy.
  const NEWS_CRASH = /\b(crash(ed|es)?|collision|wreck|rollover|pile[- ]?up|struck by|hit[- ]and[- ]run|fatal(ity|ities)?|killed in|injured in)\b/i;
  const NEWS_ROAD = /\b(i-?\d{2,3}|interstate|highway|hwy|route \w+|ramp|overpass|boulevard|blvd|avenue|ave\.?|street|st\.?|road|rd\.?|lane|bridge|intersection)\b/i;
  const NEWS_PLACE = /\b(washington university|washu|wustl|forest park|central west end|delmar|skinker|clayton|university city|u\. ?city|kingshighway|hanley|brentwood|maplewood|richmond heights|ladue|st\.? louis)\b/i;

  const TEMPLATE = `
    <div style="display:flex;align-items:center;gap:14px;padding:10px 32px;background:${INK};color:${GROUND};border-bottom:2px solid ${INK};">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;padding:4px 8px;background:${GROUND};color:${INK};">Live MoDOT Services</span>
      <span style="font-size:12px;font-weight:600;">Road conditions and events from MoDOT. Traffic cameras from the MoDOT camera layer. Click any road or camera for details.</span>
    </div>

    <div style="display:grid;grid-template-columns:320px minmax(0,1fr);align-items:start;">
      <aside style="border-right:2px solid ${RULE};">
        <div style="padding:20px 20px 20px 32px;border-bottom:2px solid ${RULE};">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px;">
            <div style="${label()}">Events within scan radius</div>
            <div data-scan-seg style="display:flex;border:2px solid ${RULE};">
              ${SCAN_OPTIONS.map(function (mi, i) {
                return '<button data-scan="' + mi + '" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;padding:5px 8px;border:none;' + (i ? "border-left:2px solid " + RULE + ";" : "") + 'background:' + (mi === 5 ? INK : "transparent") + ';color:' + (mi === 5 ? GROUND : INK) + ';cursor:pointer;">' + mi + ' MI</button>';
              }).join("")}
            </div>
          </div>
          <div data-ring-count style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:44px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;">&mdash;</div>
          <div data-ring-note style="font-size:11px;color:${MUTED};margin-top:4px;">Loading MoDOT events&hellip;</div>
          <div data-ring-breakdown style="display:flex;flex-direction:column;margin-top:12px;"></div>
        </div>
        <div style="padding:20px 20px 20px 32px;border-bottom:2px solid ${RULE};">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px;">
            <div style="${label()}">Crash reports</div>
            <button data-crash-refresh style="background:none;border:none;padding:0;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${DEEPRED};cursor:pointer;">Refresh</button>
          </div>
          <div data-crash-note style="font-size:11px;color:${MUTED};line-height:1.45;margin-bottom:10px;">Loading Highway Patrol crash reports…</div>
          <div data-crash-list style="display:flex;flex-direction:column;max-height:300px;overflow-y:auto;padding-right:6px;"></div>
          <div style="${label("margin:16px 0 6px;")}">Crashes in the news</div>
          <div data-crash-news style="display:flex;flex-direction:column;max-height:240px;overflow-y:auto;padding-right:6px;font-size:12px;color:${MUTED};">Checking local news…</div>
        </div>

        <div style="padding:20px 20px 20px 32px;border-bottom:2px solid ${RULE};">
          <div style="${label("margin-bottom:6px;")}">Cameras in view</div>
          <div data-cam-count style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:44px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;">—</div>
          <div style="font-size:11px;color:${MUTED};margin-top:4px;">MoDOT traffic camera layer</div>
        </div>
        <div style="padding:20px 20px 20px 32px;border-bottom:2px solid ${RULE};">
          <div style="${label("margin-bottom:4px;")}">Cameras within 5 miles of campus</div>
          <div data-nearby-count style="font-size:11px;color:${MUTED};margin-bottom:10px;">Loading cameras…</div>
          <div data-nearby style="display:flex;flex-direction:column;max-height:420px;overflow-y:auto;padding-right:6px;">
            <span style="font-size:12px;color:${MUTED};">Loading cameras…</span>
          </div>
        </div>
        <div style="padding:20px 20px 20px 32px;border-bottom:2px solid ${RULE};">
          <div style="${label("margin-bottom:6px;")}">Service status</div>
          <div data-status style="display:flex;flex-direction:column;gap:8px;font-size:12px;"></div>
        </div>
        <div style="padding:20px 20px 28px 32px;">
          <div style="${label("margin-bottom:12px;")}">Map legend</div>
          <div data-legend style="display:flex;flex-direction:column;gap:14px;font-size:12px;"></div>
        </div>
      </aside>

      <div style="padding:20px 32px 28px;">
        <div style="border:2px solid ${RULE};margin-bottom:20px;">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:2px solid ${RULE};background:${SURFACE};">
            <div style="${label()}">Campus access corridors · live MoDOT events</div>
            <div data-corridor-note style="${label()}">Scanning…</div>
          </div>
          <div data-corridors style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));"></div>
        </div>

        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px;">
          <div style="${label()}">Statewide road conditions &amp; traffic cameras · 5-mile ring, Brookings Hall</div>
          <div style="${label()}">Click a road or camera</div>
        </div>
        <div data-map-shell style="position:relative;border:2px solid ${RULE};">
          <div data-map style="height:720px;background:${SURFACE};cursor:crosshair;"></div>
          <button data-fullscreen style="position:absolute;top:16px;left:58px;z-index:1001;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${INK};background:${GROUND};color:${INK};cursor:pointer;">⤡ Full screen</button>
          <div data-crash-modal style="display:none;position:fixed;inset:0;z-index:4000;background:rgba(32,30,29,0.55);align-items:center;justify-content:center;padding:24px;">
            <div style="background:${GROUND};border:2px solid ${INK};width:min(520px,100%);max-height:86vh;overflow-y:auto;">
              <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:2px solid ${INK};background:${SURFACE};">
                <div data-crash-modal-title style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:18px;line-height:1.15;letter-spacing:-0.01em;">MSHP crash report</div>
                <button data-crash-modal-close style="background:none;border:none;padding:0;font-size:18px;line-height:1;color:${MUTED};cursor:pointer;">✕</button>
              </div>
              <div data-crash-modal-body style="padding:18px 20px 22px;font-size:12px;line-height:1.55;"></div>
            </div>
          </div>
          <div data-detail style="display:none;position:absolute;top:16px;right:16px;z-index:1000;width:380px;max-height:660px;overflow-y:auto;background:${GROUND};border:2px solid ${INK};padding:18px;">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:12px;">
              <div data-detail-title style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:17px;line-height:1.15;letter-spacing:-0.01em;">Details</div>
              <button data-close style="background:none;border:none;padding:0;font-size:16px;line-height:1;color:${MUTED};cursor:pointer;">✕</button>
            </div>
            <div data-detail-body style="font-size:12px;line-height:1.55;"></div>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;font-size:11px;font-weight:600;">
          <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;background:${INK};border:2px solid ${GROUND};"></span>Traffic camera</span>
          <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;border-radius:50%;background:#ec3013;border:2px solid ${INK};box-sizing:border-box;"></span>Fatal crash</span>
          <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;border-radius:50%;background:#e0700b;border:2px solid ${INK};box-sizing:border-box;"></span>Serious injury</span>
          <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;border-radius:50%;background:#f2b705;border:2px solid ${INK};box-sizing:border-box;"></span>Moderate / minor</span>
          <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:2px;background:${INK};"></span>5-mile ring, Brookings Hall</span>
          <button data-refresh class="btn btn-secondary" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;">Reload map data</button>
        </div>
        <div data-timeline-wrap style="display:none;margin-top:20px;border:2px solid ${RULE};">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:2px solid ${RULE};background:${SURFACE};">
            <div style="${label()}">Event timeline · nearest events · campus time</div>
            <div data-timeline-window style="${label()}"></div>
          </div>
          <div data-timeline style="padding:10px 16px 14px;"></div>
        </div>

        <div data-wall-wrap style="display:none;margin-top:20px;border:2px solid ${RULE};">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:2px solid ${RULE};background:${SURFACE};">
            <div>
              <div style="${label()}">Camera wall · MoDOT feeds within 3 miles of campus</div>
              <div data-wall-count style="font-size:11px;color:${MUTED};margin-top:3px;"></div>
            </div>
            <div style="display:flex;gap:8px;">
              <button data-wall-play style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${INK};background:transparent;color:${INK};cursor:pointer;">▶ Play all</button>
              <button data-wall-stop style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${RULE};background:transparent;color:${DEEPRED};cursor:pointer;">■ Stop all</button>
              <button data-wall-popout title="Open the camera wall in its own window" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${INK};background:${INK};color:${GROUND};cursor:pointer;">⧉ Pop out</button>
            </div>
          </div>
          <div data-wall></div>
        </div>

        <div data-cam-modal style="display:none;position:fixed;inset:0;z-index:4000;background:rgba(32,30,29,0.82);align-items:center;justify-content:center;padding:28px;">
          <div style="background:${GROUND};border:2px solid ${INK};width:min(1180px,100%);max-height:92vh;display:flex;flex-direction:column;">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:2px solid ${INK};background:${SURFACE};">
              <div>
                <div data-cam-modal-title style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:18px;line-height:1.15;letter-spacing:-0.01em;">Traffic camera</div>
                <div data-cam-modal-meta style="font-size:11px;color:${MUTED};margin-top:3px;"></div>
              </div>
              <button data-cam-modal-close style="background:none;border:none;padding:0;font-size:18px;line-height:1;color:${MUTED};cursor:pointer;">✕</button>
            </div>
            <div style="background:${INK};position:relative;">
              <video data-cam-modal-video muted playsinline controls style="width:100%;max-height:74vh;display:block;background:${INK};"></video>
              <div data-cam-modal-status style="position:absolute;bottom:10px;left:12px;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${GROUND};background:rgba(32,30,29,0.7);padding:4px 8px;"></div>
            </div>
          </div>
        </div>

        <div style="font-size:11px;color:${MUTED};margin-top:10px;">Sources: MoDOT road conditions and traveler information maps (mapping.modot.org) &nbsp;·&nbsp; MoDOT traffic cameras (services2.arcgis.com) &nbsp;·&nbsp; basemap CARTO/OpenStreetMap</div>
      </div>
    </div>
  `;

  // mapping.modot.org sends no CORS headers, but ArcGIS Server supports JSONP,
  // which is not subject to them — this is how the event layers stay queryable.
  let jsonpSeq = 0;
  const jsonp = (url, timeoutMs) => new Promise(resolve => {
    const cb = "__modotJsonp" + (++jsonpSeq) + "_" + Date.now();
    const script = document.createElement("script");
    const done = value => {
      clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs || 9000);
    window[cb] = data => done(data);
    script.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "callback=" + cb;
    script.onerror = () => done(null);
    document.head.appendChild(script);
  });

  const CAMPUS_TZ = "America/Chicago";
  const fmtEpoch = ms => {
    if (!ms && ms !== 0) return null;
    const d = new Date(Number(ms));
    if (isNaN(d)) return null;
    const abbr = (() => { try { return new Intl.DateTimeFormat("en-US", { timeZone: CAMPUS_TZ, timeZoneName: "short" }).formatToParts(d).find(p => p.type === "timeZoneName").value; } catch (e) { return "CT"; } })();
    return d.toLocaleString("en-US", { timeZone: CAMPUS_TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") + " " + abbr;
  };
  const fmtEpochDay = ms => {
    const d = new Date(Number(ms));
    if (isNaN(d)) return "—";
    return d.toLocaleString("en-US", { timeZone: CAMPUS_TZ, month: "short", day: "numeric", year: "numeric" });
  };

  const titleCase = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\((\w)\)/g, (m, c) => "(" + c.toLowerCase() + ")");

  // Fields worth an analyst's attention, in reading order. Everything else in the
  // layer (internal ids, edit stamps, linear-referencing offsets) is suppressed.
  const TI_FIELDS = [
    ["LEVEL_OF_IMPACT_CODE", "Impact", titleCase],
    ["TYPE_CODE", "Cause", titleCase],
    ["ROUTE", "Route", null],
    ["TRAVELWAY_NAME", "Travelway", titleCase],
    ["DIRECTION", "Direction", d => ({ N: "Northbound", S: "Southbound", E: "Eastbound", W: "Westbound" }[d] || d)],
    ["BEGIN_DESCRIPTION", "From", titleCase],
    ["END_DESCRIPTION", "To", titleCase],
    ["COUNTY_NAME", "County", titleCase],
    ["DISTRICT_ABBR", "MoDOT district", null],
    ["RIVER_NAME", "River", titleCase],
    ["DEPTH", "Water depth", v => v + " ft"],
    ["START_DATE", "Started", fmtEpoch],
    ["ACTIVATION_DATE", "Activated", fmtEpoch],
    ["END_DATE", "Ends", fmtEpoch],
    ["ESTIMATED_HOUR_DURATION", "Estimated duration", v => v + " h"],
    ["STATUS_CODE", "Status", titleCase],
    ["LAST_CHANGED_DATE", "Last updated", fmtEpoch]
  ];

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const isImgUrl = v => typeof v === "string" && /^https?:\/\/\S+\.(jpe?g|png)(\?\S*)?$/i.test(v.trim());
  const isStreamUrl = v => typeof v === "string" && /^https?:\/\/\S+\.m3u8(\?\S*)?$/i.test(v.trim());
  const isUrl = v => typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());
  const isEmpty = v => v === null || v === undefined || v === "" || String(v).trim() === "" || /^<?null>?$/i.test(String(v).trim());

  // Readable labels for the MoDOT camera attribute columns.
  const FIELD_LABELS = {
    CAM_ID__: "Camera ID", CAM_ID: "Camera ID", DESCRIPTION: "Location",
    URL1: "Backup video", URL2: "Live video", REFR_RATE_MS: "Refresh rate",
    STREAM_ERROR: "Feed status", ROADWAY: "Roadway", DISTRICT: "District",
    COUNTY: "County", DIRECTION: "Direction"
  };
  const SKIP_FIELDS = /^(objectid|globalid|shape|x|y|lat|lon|longitude|latitude|esri)/i;
  const prettyValue = (k, v) => {
    if (/^STREAM_ERROR$/i.test(k)) return String(v).toUpperCase() === "Y" ? "Offline" : "Online";
    if (/^REFR_RATE_MS$/i.test(k)) return Number(v) > 0 ? Number(v) + " ms" : "Continuous video";
    return v;
  };

  class RoadConditions extends HTMLElement {
    connectedCallback() {
      // Re-attach fires disconnectedCallback first, clearing every timer; re-arm
      // instead of bailing out. See the note in weather-monitor.js.
      if (this._booted) return this.resume();
      this._booted = true;
      this.style.display = "block";
      this.innerHTML = TEMPLATE;
      this.waitForLibs();
    }
    /* The map is deliberately NOT removed here: a detach is usually a
       reconciliation, the element's DOM survives it, and destroying the map left
       nothing for connectedCallback to re-arm. */
    disconnectedCallback() {
      if (this._ro) this._ro.disconnect();
      /* The size watcher is deliberately NOT cleared on detach. It is the only
         trigger that does not depend on a lifecycle callback firing: while
         detached it reads a null container and does nothing, and it clears itself
         the moment the map measures. Clearing it here is what left three maps at a
         zero-area viewport. */
      clearInterval(this.crashTimer);
      (this._bootT || []).forEach(clearTimeout);
      this.stopWall();
      this.closeCamModalStream();
    }

    resume() {
      if (!this.map) return;
      this.armMapSize();
      if (this._ro) this._ro.observe(this);
      this.startTimers();
    }

    startTimers() {
      clearInterval(this.crashTimer);
      this.crashTimer = setInterval(() => this.loadCrashes(), 300000);
      // Housekeeping: keeps re-arming the size watchdog until the map measures,
      // so recovery never waits on the feed refresh cadence.
      clearInterval(this._hkTimer);
      this._hkTimer = setInterval(() => {
        if (this._sized) { clearInterval(this._hkTimer); this._hkTimer = null; return; }
        this.armMapSize();
      }, 2000);
    }
    q(s) { return this.querySelector(s); }

    waitForLibs() {
      if (window.L && window.L.esri) return this.boot();
      this._waited = (this._waited || 0) + 1;
      if (this._waited > 200) {
        this.q("[data-status]").innerHTML = '<span style="color:' + DEEPRED + ';">The map library did not load. Cameras cannot be shown. Reload the page.</span>';
        return;
      }
      setTimeout(() => this.waitForLibs(), 100);
    }

    setStatus(key, text, ok) {
      this.status = this.status || {};
      this.status[key] = { text, ok };
      this.q("[data-status]").innerHTML = Object.values(this.status).map(s =>
        '<div style="display:grid;grid-template-columns:10px 1fr;gap:10px;align-items:start;">'
        + '<span style="width:10px;height:10px;margin-top:4px;background:' + (s.ok ? INK : RED) + ';"></span>'
        + '<span style="color:' + (s.ok ? INK : DEEPRED) + ';">' + esc(s.text) + "</span></div>").join("");
    }

    boot() {
      const map = L.map(this.q("[data-map]"), { zoomSnap: 0.5 }).setView(ASSET_COORD, 10);
      this.map = map;

      cartoBasemap(map, "light_all");

      // mapping.modot.org serves no CORS headers, so the JSON a dynamicMapLayer
      // needs is blocked from the browser. Images are exempt from CORS, so each
      // layer is drawn from the MapServer's own export endpoint — but tiled rather
      // than as one viewport-sized image: Leaflet then owns zoom animation, keeps
      // already-fetched tiles on screen while new ones load, and reuses them when
      // panning back, which is what makes the render continuous instead of a
      // full-frame redraw after every gesture settles.
      const ExportTileLayer = L.TileLayer.extend({
        initialize: function (serviceUrl, options) {
          this._serviceUrl = serviceUrl;
          L.TileLayer.prototype.initialize.call(this, "", options);
        },
        getTileUrl: function (coords) {
          const nw = this._map.unproject(coords.scaleBy(this.getTileSize()), coords.z);
          const se = this._map.unproject(coords.add([1, 1]).scaleBy(this.getTileSize()), coords.z);
          const p1 = L.CRS.EPSG3857.project(nw);
          const p2 = L.CRS.EPSG3857.project(se);
          const size = this.getTileSize();
          return this._serviceUrl + "/export?bbox=" + [p1.x, p2.y, p2.x, p1.y].join(",")
            + "&bboxSR=3857&imageSR=3857&size=" + size.x + "," + size.y
            + (this.options.subLayers ? "&layers=show:" + this.options.subLayers.join(",") : "")
            + "&format=png32&transparent=true&dpi=96&f=image";
        }
      });

      const makeExportLayer = (key, serviceUrl, statusName, opacity, subLayers, startVisible) => {
        if (statusName) this.setStatus(key, statusName + ": loading…", true);
        const layer = new ExportTileLayer(serviceUrl, {
          opacity: opacity,
          subLayers: subLayers,
          tileSize: 512,          // fewer, larger requests than the 256 default
          updateWhenZooming: false,
          keepBuffer: 3,          // hold a ring of off-screen tiles so panning is filled
          crossOrigin: false,
          errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        });
        if (statusName) {
          layer.on("load", () => this.setStatus(key, statusName + ": shown", true));
          layer.on("tileerror", () => this.setStatus(key, statusName + " did not return a map image.", false));
        }
        // A layer group keeps the rest of the component's API (hasLayer, control
        // entries, per-group toggling) unchanged.
        const group = L.layerGroup([layer]);
        if (startVisible !== false) group.addTo(map);
        return { group: group, draw: () => layer.redraw() };
      };

      const roadsLayer = makeExportLayer("roads", ROADS_URL, "MoDOT road layer", 0.9);
      this.roadGroup = roadsLayer.group;
      this.tiLayers = TI_GROUPS.map(g => Object.assign({}, g,
        makeExportLayer("ti_" + g.key, TRAVELER_URL, null, 1, g.ids, g.on)));
      this.setStatus("traveler", "MoDOT events: " + TI_GROUPS.filter(g => g.on).length + " of " + TI_GROUPS.length + " layers shown", true);
      this.drawRoads = () => { roadsLayer.draw(); this.tiLayers.forEach(l => l.draw()); };

      map.createPane("assetPane");
      map.getPane("assetPane").style.zIndex = 450;
      map.getPane("assetPane").style.pointerEvents = "none";
      L.circle(ASSET_COORD, {
        radius: FIVE_MILE_METERS, color: INK, weight: 3, opacity: 0.85,
        fillColor: INK, fillOpacity: 0.05, dashArray: "6, 8", pane: "assetPane", interactive: false
      }).addTo(map);
      L.marker(ASSET_COORD, {
        icon: L.divIcon({ className: "", html: '<div style="width:12px;height:12px;background:' + RED + ';border:2px solid ' + GROUND + ';"></div>', iconSize: [12, 12], iconAnchor: [6, 6] })
      }).addTo(map).bindTooltip("Brookings Hall", { direction: "top" });

      const cameras = L.esri.featureLayer({
        url: CAMERAS_URL,
        pointToLayer: (geojson, latlng) => L.marker(latlng, {
          icon: L.divIcon({ className: "", html: '<div style="width:11px;height:11px;background:' + INK + ';border:2px solid ' + GROUND + ';box-shadow:0 0 0 1px ' + INK + ';"></div>', iconSize: [11, 11], iconAnchor: [6, 6] })
        })
      }).addTo(map);
      this.cameras = cameras;
      this.setStatus("cameras", "MoDOT cameras: loading…", true);
      cameras.on("load", () => {
        let n = 0;
        const nearby = [];
        const nearbyRefs = [];
        cameras.eachFeature(l => {
          n++;
          const p = (l.feature && l.feature.properties) || {};
          const ll = l.getLatLng && l.getLatLng();
          if (!ll) return;
          const dy = (ll.lat - ASSET_COORD[0]) * 69;
          const dx = (ll.lng - ASSET_COORD[1]) * 69 * Math.cos(ASSET_COORD[0] * Math.PI / 180);
          const miles = Math.sqrt(dx * dx + dy * dy);
          if (miles <= 5) {
            const offline = String(p.STREAM_ERROR || "").toUpperCase() === "Y";
            nearby.push({ description: p.DESCRIPTION, miles: Number(miles.toFixed(1)), offline: offline });
            nearbyRefs.push({ props: p, latlng: ll, miles: Number(miles.toFixed(1)), offline: offline });
          }
        });
        this.q("[data-cam-count]").textContent = n;
        this.setStatus("cameras", "MoDOT cameras: " + n + " on the map", true);
        this.publishRoads({ camerasInViewport: n });
      });
      cameras.on("requesterror", e => this.setStatus("cameras", "MoDOT cameras did not load: " + (e.message || "no answer"), false));
      cameras.on("click", e => {
        const p = (e.layer && e.layer.feature && e.layer.feature.properties) || {};
        this.showDetail("Traffic camera", p);
      });

      this.crashLayer = L.layerGroup().addTo(map);
      const overlays = { "Road conditions": this.roadGroup, "Traffic cameras": cameras, "Crash reports · MSHP": this.crashLayer };
      this.tiLayers.forEach(l => { overlays[l.label] = l.group; });
      L.control.layers(null, overlays, { collapsed: false, position: "bottomleft" }).addTo(map);
      map.on("overlayadd overlayremove", () => {
        const shown = this.tiLayers.filter(l => map.hasLayer(l.group)).length;
        this.setStatus("traveler", "MoDOT events: " + shown + " of " + this.tiLayers.length + " layers shown", true);
      });

      map.on("click", e => this.queryAtPoint(e.latlng));

      this.q("[data-close]").onclick = () => { this.q("[data-detail]").style.display = "none"; };
      this.q("[data-fullscreen]").onclick = () => this.toggleFullscreen();
      this.q("[data-refresh]").onclick = () => { this.drawRoads(); cameras.refresh(); this.loadRingEvents(); };
      this.scanMi = 5;
      this.q("[data-scan-seg]").addEventListener("click", e => {
        const b = e.target.closest("[data-scan]");
        if (b) this.setScan(Number(b.getAttribute("data-scan")));
      });
      this.q("[data-corridors]").addEventListener("click", e => {
        const t = e.target.closest("[data-corridor]");
        if (t) this.focusCorridor(t.getAttribute("data-corridor"));
      });
      this.q("[data-timeline]").addEventListener("click", e => {
        const r = e.target.closest("[data-ev-lat]");
        if (!r) return;
        const ll = L.latLng(Number(r.getAttribute("data-ev-lat")), Number(r.getAttribute("data-ev-lng")));
        this.map.setView(ll, 15);
        this.queryAtPoint(ll);
      });
      this.q("[data-wall]").addEventListener("click", e => {
        const x = e.target.closest("[data-wall-expand]");
        if (x) return this.expandWallTile(Number(x.getAttribute("data-wall-expand")));
        const t = e.target.closest("[data-wall-tile]");
        if (t) this.playWallTile(Number(t.getAttribute("data-wall-tile")));
      });
      const camModal = this.q("[data-cam-modal]");
      this.q("[data-cam-modal-close]").onclick = () => this.closeCamModal();
      camModal.addEventListener("click", e => { if (e.target === camModal) this.closeCamModal(); });
      this.q("[data-wall-play]").onclick = () => (this.wallCams || []).forEach((c, i) => this.playWallTile(i));
      this.q("[data-wall-stop]").onclick = () => this.stopWall();
      // The wall in its own window: drag it to a second screen, go full screen there.
      this.q("[data-wall-popout]").onclick = () => {
        const w = window.open("wall.html", "wuem-camera-wall", "popup=yes,width=1600,height=920");
        if (!w) window.open("wall.html", "_blank");
      };

      // The element may be mounted while its tab is hidden (display:none), which
      // leaves Leaflet at zero size; re-measure as soon as it gains width.
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          if (this.offsetWidth <= 0) return;
          map.invalidateSize();
          // Redraw once the new size has settled, so every export layer requests
          // at the real dimensions rather than mid-transition.
          clearTimeout(this._drawT);
          this._drawT = setTimeout(() => { if (this.drawRoads) this.drawRoads(); }, 250);
        });
        this._ro.observe(this);
      }
      this.armMapSize();
      this.q("[data-crash-refresh]").onclick = () => this.loadCrashes();
      this.q("[data-crash-list]").addEventListener("click", e => {
        const loc = e.target.closest("[data-crash-lat]");
        if (loc) {
          this.map.setView(L.latLng(Number(loc.getAttribute("data-crash-lat")), Number(loc.getAttribute("data-crash-lng"))), 15);
          return;
        }
        const row = e.target.closest("[data-crash-idx]");
        if (!row) return;
        e.preventDefault();
        const c = (this.crashes || [])[Number(row.getAttribute("data-crash-idx"))];
        if (c) this.showCrashDetail(c);
      });
      const modal = this.q("[data-crash-modal]");
      this.q("[data-crash-modal-close]").onclick = () => this.closeCrashModal();
      modal.addEventListener("click", e => {
        if (e.target === modal) return this.closeCrashModal();
        if (e.target.closest("[data-crash-modal-locate]") && this._modalCrash) {
          this.closeCrashModal();
          this.map.setView(L.latLng(this._modalCrash.lat, this._modalCrash.lon), 15);
        }
      });
      this.addEventListener("keydown", e => { if (e.key === "Escape") { this.closeCrashModal(); this.closeCamModal(); } });
      document.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        if (this.q("[data-map-shell]").getAttribute("data-expanded") === "1") this.toggleFullscreen();
      });
      this.loadLegend();
      // Staggered: six views firing every feed at mount wedges the main thread.
      this._bootT = [
        setTimeout(() => this.loadNearbyCameras(), 400),
        setTimeout(() => this.loadRingEvents(), 1100),
        setTimeout(() => this.loadCrashes(), 1900)
      ];
      this.startTimers();
    }

    /* ---------- crash reporting ------------------------------------------
       Two independent sources, kept visibly separate: the Highway Patrol's own
       crash log (authoritative but MSHP-investigated only, so highways rather
       than city streets), and crash reporting in the local news feeds (fast and
       broad, but unverified). Neither is a substitute for the other. */
    async loadCrashes() {
      this.armMapSize();
      const note = this.q("[data-crash-note]");
      const origin = proxyOrigin();
      note.textContent = "Loading Highway Patrol crash reports…";
      try {
        const res = await fetch(origin + "/crashes?troop=C&days=7", { signal: AbortSignal.timeout(30000) });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const crashes = (data.crashes || []).map(c => {
          if (typeof c.lat === "number" && typeof c.lon === "number") {
            const dy = (c.lat - ASSET_COORD[0]) * 69;
            const dx = (c.lon - ASSET_COORD[1]) * 69 * Math.cos(ASSET_COORD[0] * Math.PI / 180);
            c.miles = Number(Math.sqrt(dx * dx + dy * dy).toFixed(1));
          }
          return c;
        }).sort((a, b) => {
          if (a.miles != null && b.miles != null) return a.miles - b.miles;
          if (a.miles != null) return -1;
          if (b.miles != null) return 1;
          return String(b.at || "").localeCompare(String(a.at || ""));
        });
        this.crashes = crashes;
        const near = crashes.filter(c => c.miles != null && c.miles <= 5);
        note.innerHTML = crashes.length
          ? crashes.length + " MSHP crash report" + (crashes.length === 1 ? "" : "s") + " in Troop C over 7 days · "
            + data.fatalCount + " fatal · " + near.length + " within 5 mi of campus. "
            + '<span style="color:' + MUTED + ';">Highway Patrol crashes only. City and county police crashes are not included. Map points are placed from the written location and are approximate.</span>'
          : "No MSHP crash reports in the St. Louis area in the last 7 days.";
        this.renderCrashList(crashes);
        this.plotCrashes(crashes);
        this.publishRoads({
          crashReports: crashes.length,
          crashFatalities: data.fatalCount,
          crashesWithin5Miles: near.map(c => ({ location: c.location, county: c.county, at: c.at, severity: c.worstInjury, miles: c.miles })),
          crashSource: "MSHP online crash reports, rolling 7 days, via the dashboard Worker"
        });
        if (this.ringList) this.renderCorridors(this.ringList, this.scanMi || 5);
      } catch (e) {
        this.crashes = [];
        note.innerHTML = 'Crash reports unavailable. The feed needs the dashboard Worker at <b>' + esc(new URL(origin).hostname) + '</b>. '
          + (/\.workers\.dev$/.test(origin) ? "Managed WashU devices block this address. Set an allowed Worker address on the Outages tab." : "The Worker is not answering.");
        this.q("[data-crash-list]").innerHTML = "";
        this.plotCrashes([]);
      }
      this.loadCrashNews();
    }

    async loadCrashNews() {
      const box = this.q("[data-crash-news]");
      try {
        const res = await fetch(proxyOrigin() + "/localnews?hours=48", { signal: AbortSignal.timeout(25000) });
        const data = await res.json();
        const items = (data.items || data.articles || []).filter(it => {
          const t = [it.title, it.summary, it.description].filter(Boolean).join(" ");
          return NEWS_CRASH.test(t) && (NEWS_ROAD.test(t) || NEWS_PLACE.test(t));
        }).slice(0, 8);
        this.crashNews = items;
        box.innerHTML = items.length
          ? items.map(it => '<a href="' + esc(it.link || it.url || "#") + '" target="_blank" rel="noopener" style="display:block;padding:8px 0;border-bottom:1px solid ' + HAIR + ';color:' + INK + ';text-decoration:none;">'
              + '<span style="font-size:12px;font-weight:700;line-height:1.35;display:block;">' + esc(it.title || "Untitled") + "</span>"
              + '<span style="' + label("margin-top:3px;display:block;") + '">' + esc(it.outlet || it.source || "Local outlet")
              + (it.published || it.date ? " · " + esc(fmtEpoch(Date.parse(it.published || it.date)) || "") : "") + " · unverified</span></a>").join("")
          : "No crash stories in local news in the last 48 hours.";
        this.publishRoads({ crashNews: items.slice(0, 5).map(it => ({ title: it.title, outlet: it.outlet || it.source, link: it.link || it.url })) });
      } catch (e) {
        box.textContent = "Local news unavailable. The feed needs the dashboard Worker.";
      }
    }

    renderCrashList(crashes) {
      const box = this.q("[data-crash-list]");
      if (!crashes.length) { box.innerHTML = ""; return; }
      box.innerHTML = crashes.slice(0, 25).map((c, i) => {
        const sev = CRASH_SEVERITY[c.worstInjury] || CRASH_SEVERITY["NO INJURY"];
        const when = c.at ? fmtEpoch(Date.parse(c.at)) : (c.date + " " + c.time);
        const dist = c.miles != null ? c.miles + " mi" : "not on map";
        return '<div data-crash-idx="' + i + '" title="Open crash details" style="display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:baseline;padding:9px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;">'
          + '<span style="width:9px;height:9px;border-radius:50%;background:' + sev.color + ';"></span>'
          + '<span style="min-width:0;">'
          + '<span style="font-size:12px;font-weight:700;line-height:1.35;display:block;color:' + INK + ';border-bottom:1px solid ' + INK + ';width:fit-content;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(titleCase(c.location || "Location not given")) + "</span>"
          + '<span style="font-size:11px;color:' + MUTED + ';">' + esc(sev.label) + " · " + esc(titleCase(c.county)) + " · " + esc(when || "")
          + (c.involved > 1 ? " · " + c.involved + " involved" : "")
          + ' · <span style="color:' + DEEPRED + ';font-weight:700;">Report ' + esc(c.report) + "</span></span></span>"
          + (c.lat
              ? '<button data-crash-lat="' + c.lat + '" data-crash-lng="' + c.lon + '" title="Show on map" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:4px 7px;border:2px solid ' + RULE + ';background:transparent;color:' + (c.miles <= 5 ? DEEPRED : MUTED) + ';cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;">' + dist + "</button>"
              : '<span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + MUTED + ';white-space:nowrap;">' + dist + "</span>")
          + "</div>";
      }).join("");
    }

    plotCrashes(crashes) {
      if (!this.crashLayer) return;
      this.crashLayer.clearLayers();
      crashes.filter(c => typeof c.lat === "number").forEach(c => {
        const sev = CRASH_SEVERITY[c.worstInjury] || CRASH_SEVERITY["NO INJURY"];
        L.circleMarker([c.lat, c.lon], {
          radius: 6 + sev.rank, fillColor: sev.color, fillOpacity: 0.9,
          color: INK, weight: 2
        }).addTo(this.crashLayer).bindTooltip(
          titleCase(c.location) + " · " + sev.label + (c.at ? " · " + fmtEpoch(Date.parse(c.at)) : ""),
          { direction: "top" }
        ).on("click", () => this.showCrashDetail(c));
      });
    }

    closeCrashModal() { this.q("[data-crash-modal]").style.display = "none"; }

    showCrashDetail(c) {
      const sev = CRASH_SEVERITY[c.worstInjury] || CRASH_SEVERITY["NO INJURY"];
      this.q("[data-crash-modal]").style.display = "flex";
      this.q("[data-crash-modal-title]").textContent = "MSHP crash report " + (c.report || "");
      const row = (k, v) => '<div style="display:grid;grid-template-columns:40% 1fr;gap:10px;padding:7px 0;border-bottom:1px solid ' + HAIR + ';">'
        + '<span style="' + label() + '">' + k + "</span><span style=\"font-weight:600;\">" + esc(v) + "</span></div>";
      this.q("[data-crash-modal-body]").innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span style="width:12px;height:12px;border-radius:50%;background:' + sev.color + ';"></span>'
        + '<span style="font-size:13px;font-weight:800;">' + esc(sev.label) + " crash</span></div>"
        + row("Location", titleCase(c.location || "—"))
        + row("County", titleCase(c.county || "—"))
        + row("When", c.at ? fmtEpoch(Date.parse(c.at)) : (c.date + " " + c.time))
        + row("People involved", c.involved)
        + row("Injured", c.injured)
        + (c.miles != null ? row("From Brookings Hall", c.miles + " mi") : "")
        + row("Troop", c.troop || "C")
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:12px;line-height:1.5;">Preliminary and unofficial. Source: Missouri State Highway Patrol. Names and ages are left out on purpose. '
        + "</div>"
        + '<div style="display:flex;gap:10px;margin-top:14px;">'
        + '<a href="' + esc(c.url) + '" target="_blank" rel="noopener" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:9px 13px;border:2px solid ' + INK + ';background:' + INK + ';color:' + GROUND + ';text-decoration:none;">Open MSHP report</a>'
        + (c.lat ? '<button data-crash-modal-locate="1" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:9px 13px;border:2px solid ' + INK + ';background:transparent;color:' + INK + ';cursor:pointer;">Show on map</button>' : "")
        + "</div>";
      this._modalCrash = c;
    }

    publishRoads(patch) {
      window.__omContext = window.__omContext || {};
      const base = window.__omContext.roads || {
        camerasWithin5Miles: [],
        camerasNearbyCount: 0,
        camerasInViewport: null,
        services: {
          roadConditions: "MapServer image export (attributes not readable — no CORS headers)",
          travelerInformation: "MapServer image export (attributes not readable — no CORS headers)",
          cameras: "Feature service, fully queryable"
        },
        note: "From the Road Conditions tab. Cameras near campus are queried directly from the MoDOT feature service, independent of the map viewport. MoDOT's two map services send no CORS headers, so incident, work-zone and road-condition attributes cannot be read in the browser — only their rendered imagery is available."
      };
      if (this.ringEvents) base.eventsWithin5Miles = this.ringEvents;
      window.__omContext.roads = Object.assign(base, patch, { updated: new Date().toISOString() });
      window.dispatchEvent(new CustomEvent("om-context"));
    }

    async loadRingEvents() {
      const RING_MI = this.scanMi || 5;
      const dLat = (RING_MI + 1) / 69;
      const dLon = (RING_MI + 1) / 53;   // miles per degree of longitude at 38.6N
      const env = [ASSET_COORD[1] - dLon, ASSET_COORD[0] - dLat, ASSET_COORD[1] + dLon, ASSET_COORD[0] + dLat].join(",");
      const noteEl = this.q("[data-ring-note]");
      const countEl = this.q("[data-ring-count]");
      const listEl = this.q("[data-ring-breakdown]");

      const jobs = TI_GROUPS.map(g => {
        const url = TRAVELER_URL + "/" + g.ids[0] + "/query?f=pjson&where=1%3D1&outFields=*&returnGeometry=true&inSR=4326&outSR=4326"
          + "&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&resultRecordCount=200&geometry=" + encodeURIComponent(env);
        return jsonp(url).then(res => ({ group: g, features: (res && res.features) || [] })).catch(() => ({ group: g, features: [], failed: true }));
      });
      this.drawScanRing(RING_MI);

      const results = await Promise.all(jobs);
      if (results.every(x => x.failed)) {
        countEl.textContent = "—";
        noteEl.textContent = "MoDOT event layers did not answer. Click Reload map data to retry.";
        listEl.innerHTML = "";
        return;
      }

      const seen = new Set();
      const events = [];
      results.forEach(({ group, features }) => {
        features.forEach(ft => {
          const g = ft.geometry;
          if (!g || typeof g.y !== "number") return;
          const dx = (g.x - ASSET_COORD[1]) * 53.0;   // miles per degree lon at 38.6N
          const dy = (g.y - ASSET_COORD[0]) * 69.0;
          const miles = Math.sqrt(dx * dx + dy * dy);
          if (miles > RING_MI) return;
          const a = ft.attributes || {};
          const key = a.DATA_ID || group.key + ":" + g.x.toFixed(5) + "," + g.y.toFixed(5);
          if (seen.has(key)) return;
          seen.add(key);
          events.push({
            group: group.label,
            closed: /closed/i.test(String(a.LEVEL_OF_IMPACT || "")) || /closed/i.test(group.label),
            where: [a.DESIGNATION, a.TRAVELWAY_NAME].filter(Boolean).join(" ") || a.COUNTY_NAME || group.label,
            detail: a.BEG_REF_PT || a.WORK_TYPE || a.LEVEL_OF_IMPACT || "",
            dir: a.DIRECTION || "",
            props: a,
            latlng: L.latLng(g.y, g.x),
            miles: Number(miles.toFixed(1))
          });
        });
      });
      events.sort((a, b) => a.miles - b.miles);
      const total = events.length;
      const nearest = total ? events[0].miles : null;
      this.ringList = events;

      const partial = results.filter(x => x.failed).length;
      countEl.textContent = String(total);
      noteEl.textContent = total === 0
        ? "No MoDOT events inside the ring. The layers answered. This is a confirmed reading."
        : "Nearest " + nearest.toFixed(1) + " mi from Brookings Hall · click any event to zoom"
          + (partial ? " · " + partial + " layer" + (partial === 1 ? "" : "s") + " did not answer" : "");

      listEl.innerHTML = "";
      listEl.style.maxHeight = "300px";
      listEl.style.overflowY = "auto";
      listEl.style.paddingRight = "6px";
      events.forEach(ev => {
        const row = document.createElement("button");
        row.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;text-align:left;padding:9px 0;border:none;border-bottom:1px solid " + HAIR
          + ";background:transparent;font-family:Archivo,system-ui,sans-serif;font-size:12px;cursor:pointer;color:" + INK + ";";
        const head = ev.where + (ev.dir ? " " + ev.dir : "");
        row.innerHTML = '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">'
          + '<span style="font-weight:700;line-height:1.35;">' + esc(head) + '<span style="font-weight:600;color:' + (ev.closed ? DEEPRED : MUTED) + ';"> · ' + esc(ev.group) + "</span></span>"
          + (ev.detail ? '<span style="font-size:11px;color:' + MUTED + ';line-height:1.35;">' + esc(titleCase(ev.detail)) + "</span>" : "")
          + "</span>"
          + '<span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + MUTED + ';white-space:nowrap;font-variant-numeric:tabular-nums;">' + ev.miles + " mi</span>";
        row.onmouseenter = () => { row.style.background = "rgba(32,30,29,0.05)"; };
        row.onmouseleave = () => { row.style.background = "transparent"; };
        row.onclick = () => { this.map.setView(ev.latlng, 15); this.queryAtPoint(ev.latlng); };
        listEl.appendChild(row);
      });

      const byGroup = events.reduce((m, e) => Object.assign(m, { [e.group]: (m[e.group] || 0) + 1 }), {});
      this.ringEvents = { total: total, nearestMiles: nearest, byGroup: byGroup, radiusMiles: RING_MI };
      this.renderCorridors(events, RING_MI);
      this.renderEventTimeline(events);
      this.publishRoads({});
    }

    drawScanRing(mi) {
      if (!this.scanRings) this.scanRings = L.layerGroup().addTo(this.map);
      this.scanRings.clearLayers();
      if (mi === 5) return; // the standing 5-mile ring is already drawn
      L.circle(ASSET_COORD, {
        radius: mi * 1609.34, color: INK, weight: 2, opacity: 0.55,
        fill: false, dashArray: "3, 7", pane: "assetPane", interactive: false
      }).addTo(this.scanRings);
    }

    setScan(mi) {
      this.scanMi = mi;
      this.querySelectorAll("[data-scan]").forEach(b => {
        const on = Number(b.getAttribute("data-scan")) === mi;
        b.style.background = on ? INK : "transparent";
        b.style.color = on ? GROUND : INK;
      });
      this.loadRingEvents();
    }

    // Are the roads campus actually depends on open? Events are matched to named
    // corridors on their route text, then reduced to one status per corridor.
    renderCorridors(events, radiusMi) {
      const box = this.q("[data-corridors]");
      const buckets = CORRIDORS.map(c => Object.assign({ c: c, items: [] }));
      events.forEach(ev => {
        const a = ev.props || {};
        const hay = [(a.DESIGNATION || "") + " " + (a.TRAVELWAY_NAME || ""), a.ROUTE, a.TRAVELWAY_NAME, a.BEGIN_DESCRIPTION, a.END_DESCRIPTION, ev.where].filter(Boolean).join(" | ");
        buckets.forEach(b => { if (b.c.re.test(hay)) b.items.push(ev); });
      });

      const impacted = buckets.filter(b => b.items.length).length;
      const recentCrashes = (this.crashes || []).filter(c => c.at && Date.now() - Date.parse(c.at) < 86400000);
      buckets.forEach(b => {
        b.crashes = recentCrashes.filter(c => b.c.re.test(String(c.location || "").replace(/\bI-/gi, "IS ")));
      });
      this.q("[data-corridor-note]").textContent = impacted
        ? impacted + " of " + CORRIDORS.length + " corridors have events · " + radiusMi + " mi scan"
        : "All clear within " + radiusMi + " miles";

      box.innerHTML = buckets.map((b, i) => {
        const closed = b.items.filter(x => x.closed).length;
        const delays = b.items.filter(x => !x.closed && /high|medium/i.test(String((x.props || {}).LEVEL_OF_IMPACT_CODE || ""))).length;
        const crashes = (b.crashes || []).length;
        const state = closed ? "Closure" : crashes ? "Crash" : b.items.length ? (delays ? "Delays" : "Events") : "Clear";
        const tone = closed ? RED : crashes ? "#e0700b" : delays ? "#f59a0b" : b.items.length ? MUTED : INK;
        const nearest = b.items.length ? Math.min(...b.items.map(x => x.miles)) : null;
        return '<div data-corridor="' + b.c.key + '" style="padding:14px 16px;border-right:' + (i % 4 === 3 ? "none" : "2px solid " + RULE)
          + ";border-bottom:" + (i < 4 ? "2px solid " + RULE : "none") + ";cursor:" + (b.items.length ? "pointer" : "default") + ";"
          + (closed ? "background:rgba(236,48,19,0.07);" : "") + '">'
          + '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px;">'
          + '<span style="width:9px;height:9px;background:' + tone + ';' + (b.items.length || crashes ? "" : "opacity:0.25;") + '"></span>'
          + '<span style="font-size:12px;font-weight:800;">' + esc(b.c.label) + "</span></div>"
          + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:20px;line-height:1;letter-spacing:-0.02em;color:' + (closed ? DEEPRED : INK) + ';">' + esc(state) + "</div>"
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:5px;line-height:1.35;">'
          + (b.items.length
              ? b.items.length + " event" + (b.items.length === 1 ? "" : "s") + " · nearest " + nearest.toFixed(1) + " mi"
              : "No MoDOT events")
          + (crashes ? '<br><span style="color:' + DEEPRED + ';">' + crashes + " MSHP crash" + (crashes === 1 ? "" : "es") + " in 24 h</span>" : "")
          + "</div></div>";
      }).join("");

      this._corridorBuckets = buckets;
    }

    focusCorridor(key) {
      const b = (this._corridorBuckets || []).find(x => x.c.key === key);
      if (!b || !b.items.length) return;
      const ev = b.items.slice().sort((x, y) => x.miles - y.miles)[0];
      this.map.setView(ev.latlng, 14);
      this.queryAtPoint(ev.latlng);
    }

    renderEventTimeline(events) {
      const wrap = this.q("[data-timeline-wrap]");
      const box = this.q("[data-timeline]");
      const now = Date.now();
      const items = events.map(ev => {
        const a = ev.props || {};
        const start = parseTiDate(a.START_DATE) || parseTiDate(a.ACTIVATION_DATE);
        const end = parseTiDate(a.END_DATE);
        return { ev: ev, start: start, end: end, open: !end };
      }).filter(x => x.start && (!x.end || x.end > x.start));

      // A fixed operational window: a month out, a week back. Multi-year work zones
      // would otherwise compress every live incident into an unreadable sliver.
      const t0 = now - 7 * 86400000;
      const t1 = now + 30 * 86400000;
      const inWindow = items.filter(x => x.start <= t1 && (x.open || x.end >= t0)).slice(0, 10);

      if (!inWindow.length) { wrap.style.display = "none"; return; }
      wrap.style.display = "block";
      const span = Math.max(1, t1 - t0);
      const pct = t => ((t - t0) / span) * 100;
      const nowPct = pct(now);
      this.q("[data-timeline-window]").textContent = fmtEpochDay(t0) + " → " + fmtEpochDay(t1) + " · 37-day window";

      box.innerHTML = inWindow.map(x => {
        const a = x.ev.props || {};
        const closed = x.ev.closed;
        const tone = closed ? RED : /high/i.test(String(a.LEVEL_OF_IMPACT_CODE || "")) ? "#f59a0b" : "#8f8b8b";
        const realEnd = x.open ? null : x.end;
        const clipL = x.start < t0, clipR = x.open || x.end > t1;
        const left = Math.max(0, pct(x.start));
        const right = Math.min(100, pct(realEnd == null ? t1 : realEnd));
        const width = Math.max(1.2, right - left);
        const hours = realEnd ? (realEnd - x.start) / 3600000 : null;
        const dur = x.open ? "Open" : hours >= 48 ? Math.round(hours / 24) + " d" : Math.round(hours) + " h";
        const range = fmtEpochDay(x.start) + " → " + (realEnd ? fmtEpochDay(realEnd) : "no end date");
        const edge = (side, on) => on
          ? '<div style="position:absolute;' + side + ':' + (side === "left" ? left : 100 - right) + "%;top:0;bottom:0;width:4px;background:" + INK + ';"></div>'
          : "";
        return '<div title="' + esc(range) + '" data-ev-lat="' + x.ev.latlng.lat + '" data-ev-lng="' + x.ev.latlng.lng + '" style="display:grid;grid-template-columns:210px minmax(0,1fr) 64px;gap:12px;align-items:center;padding:5px 0;cursor:pointer;">'
          + '<div style="overflow:hidden;"><div style="font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:' + (closed ? DEEPRED : INK) + ';white-space:nowrap;text-overflow:ellipsis;overflow:hidden;">' + esc(x.ev.where) + "</div>"
          + '<div style="font-size:10px;color:' + MUTED + ';white-space:nowrap;text-overflow:ellipsis;overflow:hidden;">' + esc(x.ev.group) + " · " + x.ev.miles + " mi · from " + esc(fmtEpochDay(x.start)) + "</div></div>"
          + '<div style="position:relative;height:16px;background:' + SURFACE + ';">'
          + '<div style="position:absolute;left:' + left + "%;width:" + width + "%;top:0;bottom:0;background:" + tone + ";" + (x.open ? "opacity:0.55;" : "") + '"></div>'
          + edge("left", clipL) + edge("right", clipR)
          + '<div style="position:absolute;left:' + nowPct + "%;top:-3px;bottom:-3px;width:2px;background:" + INK + ';"></div></div>'
          + '<div style="font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;color:' + MUTED + ';">' + dur + "</div></div>";
      }).join("")
        + '<div style="' + label("margin-top:8px;") + '">Bars run from start to scheduled end · vertical line is now · solid end caps mean the event runs past the window · faded bars have no end date · click a row to open the event</div>';
    }

    renderCamWall(cams) {
      const wrap = this.q("[data-wall-wrap]");
      const box = this.q("[data-wall]");
      const picks = [];
      // Each camera appears once, under the campus it is nearer to, so a feed
      // between the two never takes two tiles or two decoder slots.
      SITES.forEach(s => {
        (cams || []).filter(c => !c.offline && c.site === s.key && c.bySite[s.key] <= WALL_RADIUS_MI)
          .sort((a, b) => a.bySite[s.key] - b.bySite[s.key])
          .forEach(c => picks.push(Object.assign({}, c, { wallSite: s })));
      });
      if (!picks.length) { wrap.style.display = "none"; return; }
      wrap.style.display = "block";
      this.wallCams = picks;

      const head = this.q("[data-wall-count]");
      if (head) {
        head.textContent = picks.length + " feeds · "
          + SITES.map(s => s.label.split(" · ")[0] + " " + picks.filter(p => p.wallSite.key === s.key).length).join(" · ");
      }

      box.innerHTML = SITES.map(s => {
        const mine = picks.map((p, i) => ({ p: p, i: i })).filter(x => x.p.wallSite.key === s.key);
        if (!mine.length) return "";
        return '<div>'
          + '<div style="' + label("padding:10px 16px;background:" + SURFACE + ";border-bottom:2px solid " + RULE + ";border-top:2px solid " + RULE + ";") + '">'
          + esc(s.label) + " · within " + WALL_RADIUS_MI + " miles · " + mine.length + " feed" + (mine.length === 1 ? "" : "s") + "</div>"
          + '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));">'
          + mine.map(x => {
            const c = x.p, i = x.i;
            return '<div data-wall-cell="' + i + '" style="border-right:2px solid ' + RULE + ';border-bottom:1px solid ' + HAIR + ';">'
              + '<div style="position:relative;background:' + INK + ';aspect-ratio:16/9;">'
              + '<video data-wall-video="' + i + '" muted playsinline style="width:100%;height:100%;display:block;object-fit:cover;"></video>'
              + '<button data-wall-tile="' + i + '" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(32,30,29,0.55);border:none;color:' + GROUND + ';font-family:Archivo,system-ui,sans-serif;font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;">▶ Play feed</button>'
              + '<button data-wall-expand="' + i + '" title="Expand in full color" style="position:absolute;top:6px;right:6px;z-index:2;font-family:Archivo,system-ui,sans-serif;font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:4px 7px;border:2px solid ' + GROUND + ';background:rgba(32,30,29,0.75);color:' + GROUND + ';cursor:pointer;">Expand</button>'
              + '<span data-wall-status="' + i + '" style="position:absolute;left:6px;bottom:6px;z-index:2;display:none;max-width:calc(100% - 12px);font-family:Archivo,system-ui,sans-serif;font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:4px 7px;background:rgba(32,30,29,0.75);color:' + GROUND + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>'
              + "</div>"
              + '<div style="padding:9px 12px;display:flex;align-items:baseline;justify-content:space-between;gap:8px;">'
              + '<span style="font-size:11px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(titleCase(c.props.DESCRIPTION || "Camera")) + "</span>"
              + '<span style="' + label() + '">' + c.bySite[s.key] + " mi</span></div></div>";
          }).join("")
          + "</div></div>";
      }).join("");
      this.armWallObserver();
    }

    // The expanded view is the one place video runs in true color — an operator
    // reading brake lights, standing water or emergency lighting needs the hue.
    expandWallTile(i) {
      const cam = (this.wallCams || [])[i];
      if (!cam) return;
      const modal = this.q("[data-cam-modal]");
      const video = this.q("[data-cam-modal-video]");
      const status = this.q("[data-cam-modal-status]");
      modal.style.display = "flex";
      this.q("[data-cam-modal-title]").textContent = titleCase(cam.props.DESCRIPTION || "Traffic camera");
      this.q("[data-cam-modal-meta]").textContent = cam.wallSite.label + " · " + cam.bySite[cam.wallSite.key] + " mi from campus"
        + (cam.props.ROUTE ? " · " + cam.props.ROUTE : "") + " · full color";
      this.closeCamModalStream();
      const url = [cam.props.URL2, cam.props.URL1].find(isStreamUrl);
      if (!url) { status.textContent = "This camera has no live video."; return; }
      status.textContent = "Connecting…";
      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls(WALL_HLS_CONFIG);
        this.camModalHls = hls;
        this.camModalFeed = watchFeed(hls, video, url, (state, text) => {
          status.textContent = text;
          status.style.color = state === "live" ? MUTED : state === "connecting" || state === "buffering" ? MUTED : DEEPRED;
        });
      } else {
        video.src = url;
        video.play().then(() => { status.textContent = "Live"; }).catch(() => { status.textContent = "Feed unavailable."; });
      }
    }

    closeCamModalStream() {
      if (this.camModalFeed) { this.camModalFeed.stop(); this.camModalFeed = null; }
      if (this.camModalHls) { this.camModalHls.destroy(); this.camModalHls = null; }
      const v = this.q("[data-cam-modal-video]");
      if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
    }

    closeCamModal() {
      this.closeCamModalStream();
      this.q("[data-cam-modal]").style.display = "none";
    }

    /* Camera wall playback.

       A black tile used to mean one of two unrelated things: a camera that is
       down at MoDOT while its playlist still answers (hls.js waits forever for a
       segment that never comes, and never calls it fatal), or a browser that has
       run out of video decoders because every feed started at once. Each tile
       now carries a state badge from watchFeed(), and only tiles on screen play;
       the desk chose no cap on how many stream at once, so a machine short of
       decoders reports it per tile as a decode error rather than quietly. */
    wallEntry(i) {
      this.wallState = this.wallState || {};
      return this.wallState[i] || (this.wallState[i] = { wanted: false, visible: false, feed: null, hls: null, state: "idle" });
    }

    setWallBadge(i, state, text) {
      const badge = this.q('[data-wall-status="' + i + '"]');
      const btn = this.q('[data-wall-tile="' + i + '"]');
      const e = this.wallEntry(i);
      e.state = state;
      if (badge) {
        const show = state !== "idle" && state !== "live";
        badge.style.display = show ? "inline-block" : "none";
        badge.textContent = text || "";
        badge.style.color = /^(stale|failed|decode|timeout|stopped)$/.test(state) ? "#ff9783" : GROUND;
      }
      if (btn) {
        const stopped = /^(idle|stale|failed|decode|timeout|stopped|offscreen|nostream)$/.test(state);
        btn.style.display = stopped ? "flex" : "none";
        btn.textContent = state === "idle" ? "▶ Play feed"
          : state === "offscreen" ? "▶ Play feed"
          : state === "nostream" ? "No live video"
          : (text || "Feed unavailable") + " · retry";
        // A stopped tile that failed shows only the badge text once, on the button.
        if (stopped && state !== "idle" && state !== "offscreen" && badge) badge.style.display = "none";
      }
    }

    // The desk asked for this tile (or Play all did). Starts it if it is on
    // screen; otherwise it starts when it scrolls into view.
    playWallTile(i) {
      const e = this.wallEntry(i);
      e.wanted = true;
      this.startWallTile(i);
      this.publishWallHealth();
    }

    startWallTile(i) {
      const cam = (this.wallCams || [])[i];
      const video = this.q('[data-wall-video="' + i + '"]');
      const e = this.wallEntry(i);
      if (!cam || !video || !e.wanted || e.hls) return;
      const url = [cam.props.URL2, cam.props.URL1].find(isStreamUrl);
      if (!url) { e.wanted = false; this.setWallBadge(i, "nostream"); return; }
      if (!e.visible) { this.setWallBadge(i, "offscreen"); return; }
      if (!(window.Hls && window.Hls.isSupported())) {
        video.src = url; // Safari plays HLS natively
        video.play().catch(() => {});
        this.setWallBadge(i, "live");
        return;
      }
      const hls = new window.Hls(WALL_HLS_CONFIG);
      e.hls = hls;
      e.feed = watchFeed(hls, video, url, (state, text) => {
        this.setWallBadge(i, state, text);
        if (/^(stale|failed|decode|timeout|stopped)$/.test(state)) {
          // Stop loading; the button keeps the reason and offers a retry.
          this.stopWallTile(i, state, text);
          this.publishWallHealth();
        }
      });
      this.setWallBadge(i, "connecting", "Connecting…");
    }

    stopWallTile(i, state, text) {
      const e = this.wallEntry(i);
      if (e.feed) { e.feed.stop(); e.feed = null; }
      if (e.hls) { e.hls.destroy(); e.hls = null; }
      const v = this.q('[data-wall-video="' + i + '"]');
      if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
      this.setWallBadge(i, state || "idle", text);
    }

    // Start wanted tiles that have scrolled into view.
    fillWallSlots() {
      (this.wallCams || []).forEach((c, i) => {
        const e = this.wallEntry(i);
        if (e.wanted && !e.hls && e.visible && !/^(stale|failed|decode|timeout|stopped|nostream)$/.test(e.state)) this.startWallTile(i);
      });
    }

    // Tiles only stream while they are on screen. Leaving the viewport (or the
    // tab) releases the decoder; returning restarts the feed if it was wanted.
    armWallObserver() {
      if (this._wallIO) this._wallIO.disconnect();
      this.wallState = {};
      if (!("IntersectionObserver" in window)) {
        (this.wallCams || []).forEach((c, i) => { this.wallEntry(i).visible = true; });
        return;
      }
      this._wallIO = new IntersectionObserver(entries => {
        entries.forEach(en => {
          const i = Number(en.target.getAttribute("data-wall-cell"));
          const e = this.wallEntry(i);
          e.visible = en.isIntersecting;
          if (!e.visible && e.hls) this.stopWallTile(i, "offscreen");
        });
        this.fillWallSlots();
      }, { rootMargin: "200px 0px" });
      Array.from(this.querySelectorAll("[data-wall-cell]")).forEach(el => this._wallIO.observe(el));
    }

    stopWall() {
      (this.wallCams || []).forEach((c, i) => {
        const e = this.wallEntry(i);
        e.wanted = false;
        this.stopWallTile(i, "idle");
      });
      this.publishWallHealth();
    }

    // Cameras that answered but produced no video are a finding in their own
    // right: the situation summary should know the wall is thinner than it looks.
    publishWallHealth() {
      const dead = (this.wallCams || []).map((c, i) => ({ c: c, e: this.wallEntry(i) }))
        .filter(x => /^(stale|timeout|failed|decode)$/.test(x.e.state))
        .map(x => titleCase(x.c.props.DESCRIPTION || "Camera"));
      this.publishRoads({ cameraFeedsNotUpdating: dead.length, cameraFeedsNotUpdatingNames: dead.slice(0, 8) });
    }

    async loadNearbyCameras() {
      const d = 0.12; // ~8 miles of latitude, comfortably wider than the 5-mile ring
      const env = [ASSET_COORD[1] - d, ASSET_COORD[0] - d, ASSET_COORD[1] + d, ASSET_COORD[0] + d].join(",");
      const url = CAMERAS_URL + "/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true&inSR=4326&outSR=4326"
        + "&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&geometry=" + encodeURIComponent(env);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const gj = await res.json();
        const items = (gj.features || []).map(ft => {
          const c = ft.geometry && ft.geometry.coordinates;
          if (!c) return null;
          const p = ft.properties || {};
          const to = coord => {
            const dy = (c[1] - coord[0]) * 69;
            const dx = (c[0] - coord[1]) * 69 * Math.cos(coord[0] * Math.PI / 180);
            return Number(Math.sqrt(dx * dx + dy * dy).toFixed(1));
          };
          const bySite = {};
          SITES.forEach(s => { bySite[s.key] = to(s.coord); });
          const nearest = SITES.slice().sort((a, b) => bySite[a.key] - bySite[b.key])[0];
          return {
            props: p, latlng: L.latLng(c[1], c[0]),
            miles: bySite.danforth, bySite: bySite,
            site: nearest.key, siteMiles: bySite[nearest.key],
            offline: String(p.STREAM_ERROR || "").toUpperCase() === "Y"
          };
        }).filter(x => x && (x.miles <= 5 || x.siteMiles <= WALL_RADIUS_MI)).sort((a, b) => a.siteMiles - b.siteMiles);

        this.nearbyCams = items;
        this.renderNearby(items.filter(x => x.miles <= 5));
        this.renderCamWall(items);
        this.publishRoads({
          camerasNearbyCount: items.filter(x => x.miles <= 5).length,
          camerasOfflineNearby: items.filter(x => x.offline && x.miles <= 5).length,
          camerasWithin5Miles: items.filter(x => x.miles <= 5).slice(0, 12).map(x => ({ description: x.props.DESCRIPTION, miles: x.miles, offline: x.offline }))
        });
      } catch (e) {
        this.renderNearby([]);
      }
    }

    /* Mounted inside a hidden tab, Leaflet caches a 0x0 size: setView keeps the
       centre and zoom, but tiles and getBounds() are computed for a zero-area
       viewport, so the basemap stays blank and bounds-driven queries hit a single point. The host
       ResizeObserver does not reliably fire on tab activation, so this watcher
       reads clientWidth on a tick until the size sticks, then stops for good. */
    /* setInterval, not requestAnimationFrame: this document runs hidden
       (visibilityState "hidden"), and browsers suspend rAF entirely for hidden
       documents while still running throttled timers — a rAF watchdog here is
       scheduled and never invoked. Clear and reassign on the same path so no id
       value, stale or live, can block a re-arm. */
    armMapSize() {
      if (this.trySize()) return;
      clearInterval(this._sizeTimer);
      this._sizeTimer = setInterval(() => {
        if (this.trySize()) { clearInterval(this._sizeTimer); this._sizeTimer = null; }
      }, 300);
    }

    trySize() {
      const el = this.q("[data-map]");
      if (!this.map || !el || !el.clientWidth) return false;
      this.map.invalidateSize();
      if (this.map.getSize().x === 0) return false;
      this._sized = true;
      if (this.drawRoads) this.drawRoads();
      if (this.loadNearbyCameras) this.loadNearbyCameras();
      return true;
    }

    // Expanded view is a fixed overlay rather than the Fullscreen API: the API is
    // unavailable inside embedded frames, and the overlay behaves identically.
    toggleFullscreen() {
      const shell = this.q("[data-map-shell]");
      const btn = this.q("[data-fullscreen]");
      const mapEl = this.q("[data-map]");
      if (shell.getAttribute("data-expanded") === "1") {
        shell.removeAttribute("data-expanded");
        shell.style.cssText = "position:relative;border:2px solid " + RULE + ";";
        mapEl.style.height = "720px";
        btn.textContent = "⤡ Full screen";
      } else {
        shell.setAttribute("data-expanded", "1");
        shell.style.cssText = "position:fixed;inset:0;z-index:5000;border:none;background:" + GROUND + ";";
        mapEl.style.height = "100%";
        btn.textContent = "✕ Exit full screen";
      }
      setTimeout(() => { this.map.invalidateSize(); if (this.drawRoads) this.drawRoads(); }, 60);
    }

    async queryAtPoint(latlng) {
      const panel = this.q("[data-detail]");
      panel.style.display = "block";
      this.q("[data-detail-title]").textContent = "Checking MoDOT events…";
      this.q("[data-detail-body]").innerHTML = '<span style="color:' + MUTED + ';">Looking for events at this point.</span>';
      const coords = this.q("[data-coords]");
      if (coords) coords.textContent = latlng.lat.toFixed(4) + ", " + latlng.lng.toFixed(4);

      // Search radius scales with zoom so a click is forgiving at any scale.
      const z = this.map.getZoom();
      const pad = Math.max(0.0008, 0.06 / Math.pow(2, z - 9));
      const env = [latlng.lng - pad, latlng.lat - pad, latlng.lng + pad, latlng.lat + pad].join(",");

      const visible = (this.tiLayers || []).filter(l => this.map.hasLayer(l.group));
      if (!visible.length) {
        this.q("[data-detail-title]").textContent = "No event layers shown";
        this.q("[data-detail-body]").innerHTML = '<span style="color:' + MUTED + ';">Turn on an event layer in the map layer list to check it.</span>';
        return;
      }

      const jobs = [];
      visible.forEach(group => group.ids.forEach(id => {
        const url = TRAVELER_URL + "/" + id + "/query?f=pjson&where=1%3D1&outFields=*&returnGeometry=false&inSR=4326"
          + "&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&resultRecordCount=5&geometry=" + encodeURIComponent(env);
        jobs.push(jsonp(url).then(d => ({ group: group.label, id: id, features: (d && d.features) || [] })));
      }));

      const results = (await Promise.all(jobs)).filter(x => x.features.length);
      if (!results.length) {
        this.q("[data-detail-title]").textContent = "No events at this point";
        this.q("[data-detail-body]").innerHTML = '<div style="font-size:12px;line-height:1.55;">No events in the ' + visible.length
          + ' visible layers within ' + (pad * 69).toFixed(1) + ' miles of this point.'
          + ' Road condition shading is a map image. It cannot be clicked.</div>';
        return;
      }

      const hits = results.reduce((n, x) => n + x.features.length, 0);
      const seen = new Set();
      const cards = [];
      results.forEach(res => res.features.forEach(ft => {
        const a = ft.attributes || {};
        const key = a.DATA_ID || a.OBJECT_ID || JSON.stringify(a).slice(0, 80);
        if (seen.has(key)) return;
        seen.add(key);

        const rows = TI_FIELDS.map(([field, labelText, fmt]) => {
          const raw = a[field];
          if (raw === null || raw === undefined || raw === "" || String(raw).trim() === "") return "";
          const val = fmt ? fmt(raw) : raw;
          if (val === null || val === undefined || val === "") return "";
          return '<div style="display:grid;grid-template-columns:42% 1fr;gap:10px;padding:6px 0;border-bottom:1px solid ' + HAIR + ';">'
            + '<span style="' + label() + '">' + esc(labelText) + "</span>"
            + '<span style="font-weight:600;">' + esc(val) + "</span></div>";
        }).join("");

        const impact = String(a.LEVEL_OF_IMPACT_CODE || "").toUpperCase();
        const tone = impact === "CLOSED" ? RED : impact.indexOf("HIGH") >= 0 ? "#f59a0b" : MUTED;

        cards.push('<div style="border:2px solid ' + RULE + ';margin-bottom:14px;">'
          + '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:2px solid ' + RULE + ';background:' + SURFACE + ';">'
          + '<span style="width:9px;height:9px;background:' + tone + ';"></span>'
          + '<span style="font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;">' + esc(res.group) + "</span></div>"
          + '<div style="padding:12px;">'
          + (a.EXT_COMMENT ? '<div style="font-size:13px;font-weight:700;line-height:1.4;margin-bottom:10px;">' + esc(titleCase(a.EXT_COMMENT)) + "</div>" : "")
          + rows + "</div></div>");
      }));

      this.q("[data-detail-title]").textContent = cards.length + (cards.length === 1 ? " event here" : " events here");
      this.q("[data-detail-body]").innerHTML = cards.join("")
        + '<div style="font-size:11px;color:' + MUTED + ';">' + cards.length + " event" + (cards.length === 1 ? "" : "s")
        + " from " + hits + " layer match" + (hits === 1 ? "" : "es")
        + ". Each event appears as a point and a line, so matches can outnumber events. Live from MoDOT. Times are campus time.</div>";
    }

    renderNearby(list) {
      const box = this.q("[data-nearby]");
      if (!box) return;
      const sorted = (list || []).slice().sort((a, b) => a.miles - b.miles);
      const head = this.q("[data-nearby-count]");
      if (head) head.textContent = sorted.length ? sorted.length + " cameras · nearest first" : "";
      if (!sorted.length) {
        box.innerHTML = '<span style="font-size:12px;color:' + MUTED + ';">No cameras within 5 miles of Brookings Hall.</span>';
        return;
      }
      box.innerHTML = "";
      sorted.forEach(item => {
        const row = document.createElement("button");
        row.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;text-align:left;padding:9px 0;border:none;border-bottom:1px solid " + HAIR
          + ";background:transparent;font-family:Archivo,system-ui,sans-serif;font-size:12px;cursor:pointer;color:" + INK + ";";
        row.innerHTML = '<span style="font-weight:600;line-height:1.35;">' + esc(item.props.DESCRIPTION || "Camera") + "</span>"
          + '<span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + (item.offline ? DEEPRED : MUTED) + ';white-space:nowrap;">'
          + (item.offline ? "Offline" : item.miles + " mi") + "</span>";
        row.onclick = () => { this.map.setView(item.latlng, 14); this.showDetail("Traffic camera", item.props); };
        box.appendChild(row);
      });
    }

    showDetail(title, props) {
      this.q("[data-detail]").style.display = "block";
      this.q("[data-detail-title]").textContent = title;

      const entries = Object.entries(props).filter(([k, v]) => !isEmpty(v) && !SKIP_FIELDS.test(k));
      const img = entries.find(([, v]) => isImgUrl(v));
      const stream = entries.find(([, v]) => isStreamUrl(v));
      const offline = entries.some(([k, v]) => /^STREAM_ERROR$/i.test(k) && String(v).toUpperCase() === "Y");

      const rows = entries
        .filter(([, v]) => !isStreamUrl(v))
        .map(([k, v]) => {
          const name = FIELD_LABELS[k] || k.replace(/_+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          const val = prettyValue(k, v);
          return '<div style="display:grid;grid-template-columns:40% 1fr;gap:10px;padding:7px 0;border-bottom:1px solid ' + HAIR + ';">'
            + '<span style="' + label() + '">' + esc(name) + "</span>"
            + '<span style="font-weight:600;' + (/^STREAM_ERROR$/i.test(k) && String(v).toUpperCase() === "Y" ? "color:" + DEEPRED + ";" : "") + '">'
            + (isUrl(val) ? '<a href="' + esc(val) + '" target="_blank" rel="noopener">Open</a>' : esc(val)) + "</span></div>";
        }).join("");

      let media = "";
      if (img) {
        media = '<img src="' + esc(img[1]) + '" alt="Camera still" style="width:100%;display:block;border:2px solid ' + RULE + ';margin-bottom:12px;filter:grayscale(1);">';
      } else if (stream && offline) {
        media = '<div style="border:2px solid ' + RULE + ';padding:16px;margin-bottom:12px;background:' + SURFACE + ';">'
          + '<div style="' + label("margin-bottom:4px;") + '">Feed offline</div>'
          + '<div style="font-size:12px;">MoDOT reports this camera is offline. No video to show.</div></div>';
      } else if (stream) {
        media = '<div style="margin-bottom:12px;"><video data-stream-player controls muted playsinline'
          + ' style="width:100%;display:block;border:2px solid ' + RULE + ';background:' + INK + ';"></video>'
          + '<div style="' + label("margin-top:6px;") + '">Live video · MoDOT</div></div>';
      }

      this.q("[data-detail-body]").innerHTML = media + (rows || '<span style="color:' + MUTED + ';">No details available.</span>');
      if (stream && !offline && !img) this.attachStream(stream[1]);
    }

    attachStream(url) {
      const video = this.q("[data-stream-player]");
      if (!video) return;
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ lowLatencyMode: true });
        this.hls = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        hls.on(window.Hls.Events.ERROR, (evt, data) => {
          if (!data.fatal) return;
          hls.destroy();
          this.hls = null;
          video.outerHTML = '<div style="border:2px solid ' + RULE + ';padding:16px;background:' + SURFACE + ';">'
            + '<div style="' + label("margin-bottom:4px;") + '">Video unavailable</div>'
            + '<div style="font-size:12px;">' + esc(data.details || "The camera feed did not start.") + '</div>'
            + '<div style="margin-top:8px;"><a href="' + esc(url) + '" target="_blank" rel="noopener">Open the feed in a new tab</a></div></div>';
        });
      } else {
        video.src = url; // Safari plays HLS natively
        video.play().catch(() => {});
      }
    }

    loadLegend() {
      const eventBlock = "<div>"
        + '<div style="' + label("margin-bottom:7px;") + '">Event severity · all event types</div>'
        + EVENT_SEVERITY.map(function (pair) {
            return '<div style="display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:center;padding:3px 0;">'
              + '<span style="height:4px;background:' + pair[1] + ';"></span>'
              + '<span style="font-weight:600;">' + esc(pair[0]) + "</span></div>";
          }).join("")
        + '<div style="' + label("margin:14px 0 7px;") + '">Event types shown as icons</div>'
        + '<div style="font-size:12px;line-height:1.6;">' + EVENT_TYPES.map(esc).join(" · ") + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:8px;">Each hazard and severity is a separate toggle in the map layer list. Each toggle shows both the point and the road line. All event layers are on by default.</div>'
        + "</div>";
      this.q("[data-legend]").innerHTML = eventBlock + LEGEND.map(g =>
        "<div>"
        + '<div style="' + label("margin-bottom:7px;") + '">' + esc(g.group) + "</div>"
        + g.items.map(function (pair) {
            return '<div style="display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:center;padding:3px 0;">'
              + '<span style="height:4px;background:' + pair[1] + ';"></span>'
              + '<span style="font-weight:600;">' + esc(pair[0]) + "</span></div>";
          }).join("")
        + "</div>").join("");
    }
  }

  // Shared with wall.html, the pop-out camera wall, so it plays feeds the same way.
  window.WUEM = window.WUEM || {};
  window.WUEM.roads = { CAMERAS_URL, SITES, WALL_RADIUS_MI, WALL_HLS_CONFIG, watchFeed, isStreamUrl, titleCase };

  if (!window.customElements.get("road-conditions")) window.customElements.define("road-conditions", RoadConditions);
})();

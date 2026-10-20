/* Weather Operations view — provided dashboard logic, restyled onto the Modernist tokens.
   Registers <weather-monitor>. Requires Leaflet + Turf on the page (loaded in the DC helmet). */
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

  const API_URL = "https://api.weather.gov/alerts/active";
  const COUNTY_GEO_URL = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
  const RADAR_URL = "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi";
  const DAT_URL = "https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/FeatureServer";
  const DAT_LAYERS = [
    { id: 0, name: "Damage points", geom: "point" },
    { id: 1, name: "Damage paths", geom: "line" },
    { id: 2, name: "Damage areas", geom: "polygon" }
  ];

  const STATE_FIPS = { "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY","72":"PR" };

  const ASSET_COORD = [38.6482, -90.3056];
  const ASSET_LNG_LAT = [-90.3056, 38.6482];
  const FIVE_MILE_METERS = 8046.72;

  /* EXERCISE ONLY. A fictitious tornado warning drawn as a southwest-to-northeast
     swath whose northeast edge clips the 5-mile ring about 1.3 miles southwest of
     Brookings Hall without covering it — the geometry that should trip the
     intersection alarm without reading as a direct hit. Injected on demand, never
     from a feed, and labelled EXERCISE in every field a human sees. */
  const DRILL_POLYGON = [[
    [-90.42, 38.55], [-90.38, 38.52], [-90.26, 38.60], [-90.30, 38.63], [-90.42, 38.55]
  ]];
  const DRILL_ID = "urn:washu-em:drill:tornado-warning";

  const PULSE_EVENTS = ["Tornado Warning", "Tornado Watch", "Severe Thunderstorm Warning", "Severe Thunderstorm Watch", "Flash Flood Warning", "Flood Warning"];

  // The four convective products the team acts on. Warnings read as solid heavy
  // outlines, watches as dashed — so warning/watch is legible before colour is.
  const PRIORITY_STYLE = {
    "Tornado Warning":             { color: "#ec3013", stroke: "#a5170a", dash: null,     fill: 0.34, weight: 2.5, short: "TOR WRN" },
    "Severe Thunderstorm Warning": { color: "#e0700b", stroke: "#9a4a05", dash: null,     fill: 0.28, weight: 2.5, short: "SVR WRN" },
    "Tornado Watch":               { color: "#f2b705", stroke: "#8a6702", dash: "10, 7",  fill: 0.14, weight: 2,   short: "TOR WTC" },
    "Severe Thunderstorm Watch":   { color: "#8f6b12", stroke: "#5d450a", dash: "10, 7",  fill: 0.12, weight: 2,   short: "SVR WTC" }
  };
  const PRIORITY_EVENTS = Object.keys(PRIORITY_STYLE);

  const EXCLUDED_EVENTS = [
    "Small Craft Advisory", "Gale Warning", "Gale Warnings", "Heavy Freezing Spray Warning",
    "Heavy Freezing Spray", "Brisk Wind Advisory", "Special Marine Warning",
    "Rip Current Statement", "High Surf Advisory", "Lake Wind Advisory", "Gale Watch",
    "Marine Weather Statement", "Low Water Advisory", "Lakeshore Flood Advisory",
    "Lakeshow Flood Advisory", "Coastal Flood Advisory", "Lake Effect Snow Warning",
    "Lakeshore Flood Warning", "Beach Hazards Statement", "Coastal Flood Statement",
    "Coastal Flood Warning", "Coastal Flood Watch", "Hydrologic Outlook", "Hazardous Seas Warning"
  ];

  // Operational color convention for hazard polygons — data encoding, not decoration.
  const EVENT_PALETTE = {
    "Tornado Warning": "#ec3013",
    "Severe Thunderstorm Warning": "#e0700b",
    "Tornado Watch": "#f2b705",
    "Severe Thunderstorm Watch": "#8f6b12",
    "Flash Flood Warning": "#9e3526",
    "Flood Warning": "#605d5d",
    "Blizzard Warning": "#444141",
    "Winter Storm Warning": "#7d7979",
    "High Wind Warning": "#9b9797",
    "Default": "#bab6b6"
  };

  const EVENT_PRIORITY = { "Tornado Warning": 1, "Severe Thunderstorm Warning": 2, "Tornado Watch": 3, "Severe Thunderstorm Watch": 4, "Flash Flood Warning": 5, "Flood Warning": 6 };

  const INK = "#201e1d", RULE = "rgba(32,30,29,0.4)", MUTED = "#605d5d", HAIR = "#d7d3d3", GROUND = "#f3f2f2", SURFACE = "#eae9e9", RED = "#ec3013", DEEPRED = "#ae1800";

  const label = (extra) => "font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:" + MUTED + ";" + (extra || "");

  const TEMPLATE = `
    <div data-emergency style="display:none;position:fixed;inset:0;z-index:9999;align-items:center;justify-content:center;padding:48px;background:rgba(32,30,29,0.86);">
      <div style="max-width:1000px;width:100%;background:${RED};color:${GROUND};border:2px solid ${INK};padding:56px;">
        <div data-emergency-exercise style="display:none;margin-bottom:24px;padding:12px 16px;background:${INK};color:${GROUND};font-family:Archivo,system-ui,sans-serif;font-size:15px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;">Exercise &middot; exercise &middot; exercise. Drill product. Take no action.</div>
        <div style="${label("color:rgba(243,242,242,0.85);margin-bottom:20px;")}">Automatic alarm · 5-mile ring</div>
        <h2 style="margin:0 0 20px;font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:52px;line-height:1.02;letter-spacing:-0.02em;">Tornado Warning issued within 5 miles of WashU</h2>
        <p style="margin:0 0 32px;font-size:20px;font-weight:700;line-height:1.35;max-width:46ch;">Follow emergency notification procedures now.</p>
        <div style="display:flex;gap:12px;">
          <a href="https://alert.wustl.edu/AlertusWeb/Login" target="_blank" rel="noopener noreferrer" style="background:${GROUND};color:${INK};border:2px solid ${GROUND};padding:14px 22px;font-family:Archivo,system-ui,sans-serif;font-size:13px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;text-decoration:none;">Launch Alertus</a>
          <button data-dismiss style="background:transparent;color:${GROUND};border:2px solid ${GROUND};padding:14px 22px;font-family:Archivo,system-ui,sans-serif;font-size:13px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;">Acknowledge &amp; close</button>
        </div>
      </div>
    </div>

    <div data-drill-banner style="display:none;align-items:center;gap:14px;padding:10px 32px;background:${INK};color:${GROUND};border-bottom:2px solid ${INK};">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;padding:4px 8px;background:${GROUND};color:${INK};">Exercise in progress</span>
      <span style="font-size:12px;font-weight:600;">This is an exercise. A drill Tornado Warning is shown on the map, in the alert list, the timeline and the 5-mile alarm. It is not an NWS product. Take no protective action. Clear it with the Clear drill button above.</span>
    </div>

    <div style="display:flex;align-items:stretch;border-bottom:2px solid ${RULE};background:${SURFACE};">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 20px;background:${RED};color:${GROUND};font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;white-space:nowrap;">
        <span style="width:7px;height:7px;background:${GROUND};animation:wmPulse 1.4s infinite;"></span>Critical alerts · campus time
      </div>
      <div style="flex:1;overflow:hidden;position:relative;height:38px;">
        <div data-ticker style="position:absolute;top:0;bottom:0;display:flex;align-items:center;white-space:nowrap;animation:wmTicker 40s linear infinite;">
          <span style="font-size:11px;font-weight:600;color:${MUTED};padding:0 24px;">Connecting to NWS alert feed…</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;padding:10px 24px;border-left:2px solid ${RULE};">
        <div style="display:flex;flex-direction:column;text-align:right;">
          <span style="${label()}">Last update · campus time</span>
          <span data-sync style="font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;">—</span>
        </div>
        <button data-sync-btn class="btn btn-secondary" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;">Refresh now</button>
        <button data-drill class="btn btn-secondary" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;" title="Add a drill Tornado Warning that touches the 5-mile ring. For exercises and display checks only.">Start drill warning</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:320px minmax(0,1fr);align-items:start;">
      <aside style="border-right:2px solid ${RULE};">
        <div style="padding:20px 20px 20px 32px;border-bottom:2px solid ${RULE};display:flex;flex-direction:column;gap:18px;">
          <div>
            <div style="${label("margin-bottom:6px;")}">Warnings, watches &amp; advisories</div>
            <div data-stat-visible style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:44px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;">0</div>
            <div style="font-size:11px;color:${MUTED};margin-top:4px;">Missouri &amp; Illinois · shown on the map</div>
          </div>
          <div style="border-top:2px solid ${RULE};padding-top:18px;">
            <div style="${label("margin-bottom:6px;")}">Alerts nationwide</div>
            <div data-stat-national style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:28px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;color:${MUTED};">0</div>
            <div style="font-size:11px;color:${MUTED};margin-top:4px;">Whole NWS alert feed, marine alerts excluded. For context.</div>
          </div>
          <div style="border-top:2px solid ${RULE};padding-top:18px;">
            <div style="${label("margin-bottom:6px;")}">Critical alerts</div>
            <div data-stat-high style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:44px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;color:${DEEPRED};">0</div>
            <div style="font-size:11px;color:${MUTED};margin-top:4px;">Tornado and severe thunderstorm warnings and watches. Flash flood and flood warnings.</div>
          </div>
        </div>
        <div style="padding:20px 20px 28px 32px;">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;">
            <div style="${label()}">Filter by alert type</div>
            <button data-clear style="background:none;border:none;padding:0;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${DEEPRED};cursor:pointer;">Reset</button>
          </div>
          <div data-filters style="display:flex;flex-direction:column;max-height:360px;overflow-y:auto;">
            <div style="font-size:12px;color:${MUTED};padding:12px 0;">Connecting to NWS alert feed…</div>
          </div>
        </div>

        <div style="padding:20px 20px 28px 32px;border-top:2px solid ${RULE};">
          <div style="${label("margin-bottom:4px;")}">NWS Damage Assessment Toolkit</div>
          <div style="font-size:11px;color:${MUTED};line-height:1.45;margin-bottom:14px;">Past storm damage surveys: points, paths and areas. Search by storm date, event ID or county.</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
            <label style="display:block;"><span style="${label("display:block;margin-bottom:4px;")}">From</span><input data-dat-from type="date" style="width:100%;box-sizing:border-box;font-family:Archivo,system-ui,sans-serif;font-size:12px;padding:7px 8px;border:2px solid ${RULE};border-radius:0;background:${GROUND};color:${INK};"></label>
            <label style="display:block;"><span style="${label("display:block;margin-bottom:4px;")}">To</span><input data-dat-to type="date" style="width:100%;box-sizing:border-box;font-family:Archivo,system-ui,sans-serif;font-size:12px;padding:7px 8px;border:2px solid ${RULE};border-radius:0;background:${GROUND};color:${INK};"></label>
          </div>
          <label style="display:block;margin-bottom:8px;"><span style="${label("display:block;margin-bottom:4px;")}">Event ID</span><input data-dat-event type="text" placeholder="e.g. 2025-03-14 or MAY2019" style="width:100%;box-sizing:border-box;font-family:Archivo,system-ui,sans-serif;font-size:12px;padding:7px 8px;border:2px solid ${RULE};border-radius:0;background:${GROUND};color:${INK};"></label>
          <label style="display:block;margin-bottom:8px;"><span style="${label("display:block;margin-bottom:4px;")}">County</span><input data-dat-county type="text" list="wm-county-list" placeholder="St. Louis, MO" style="width:100%;box-sizing:border-box;font-family:Archivo,system-ui,sans-serif;font-size:12px;padding:7px 8px;border:2px solid ${RULE};border-radius:0;background:${GROUND};color:${INK};"><datalist id="wm-county-list"></datalist></label>
          <label style="display:block;margin-bottom:12px;"><span style="${label("display:block;margin-bottom:4px;")}">Radius from Brookings Hall</span><select data-dat-radius style="width:100%;box-sizing:border-box;font-family:Archivo,system-ui,sans-serif;font-size:12px;padding:7px 8px;border:2px solid ${RULE};border-radius:0;background:${GROUND};color:${INK};"><option value="">Off · county or nationwide</option><option value="10">Within 10 miles</option><option value="25">Within 25 miles</option><option value="50">Within 50 miles</option><option value="100">Within 100 miles</option></select></label>

          <div style="display:flex;gap:8px;">
            <button data-dat-run class="btn btn-primary" style="flex:1;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;">Search</button>
            <button data-dat-clear class="btn btn-secondary" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;">Clear</button>
          </div>

          <div data-dat-status style="font-size:11px;color:${MUTED};line-height:1.45;margin-top:12px;">No search run yet.</div>
          <div style="${label("margin-top:14px;margin-bottom:6px;")}">Quick searches</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            <button data-preset="campus" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:6px 9px;border:2px solid ${RULE};background:transparent;color:${INK};cursor:pointer;">Campus · 25 mi · all time</button>
            <button data-preset="region" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:6px 9px;border:2px solid ${RULE};background:transparent;color:${INK};cursor:pointer;">Region · 100 mi · 10 yr</button>
            <button data-preset="recent" style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:6px 9px;border:2px solid ${RULE};background:transparent;color:${INK};cursor:pointer;">National · last 30 days</button>
          </div>
          <div data-dat-legend style="margin-top:14px;display:flex;flex-direction:column;gap:6px;"></div>
        </div>
      </aside>

      <div style="padding:20px 32px 28px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;">
          <div style="${label()}">NWS alerts &amp; NEXRAD radar · Brookings Hall 5-mile ring</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span data-radar-frame style="${label()}">Radar · live</span>
            <button data-radar-play style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${INK};background:transparent;color:${INK};cursor:pointer;">▶ Loop last hour</button>
          </div>
        </div>
        <div data-map-shell style="position:relative;border:2px solid ${RULE};">
          <div data-map style="height:720px;background:${SURFACE};cursor:crosshair;"></div>
          <button data-fullscreen style="position:absolute;top:16px;left:58px;z-index:1001;font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:7px 11px;border:2px solid ${INK};background:${GROUND};color:${INK};cursor:pointer;">⤡ Full screen</button>
          <div data-detail style="display:none;position:absolute;top:16px;right:16px;z-index:1000;width:360px;max-height:660px;overflow-y:auto;background:${GROUND};border:2px solid ${INK};padding:18px;">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:12px;">
              <div data-detail-title style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:17px;line-height:1.15;letter-spacing:-0.01em;">Point details</div>
              <button data-close style="background:none;border:none;padding:0;font-size:16px;line-height:1;color:${MUTED};cursor:pointer;">✕</button>
            </div>
            <div data-forecast-section style="display:none;border-top:2px solid ${RULE};padding-top:12px;margin-bottom:14px;">
              <div style="${label("margin-bottom:6px;")}">Forecast at this point</div>
              <div data-forecast style="font-size:12px;line-height:1.5;"></div>
            </div>
            <div style="${label("margin-bottom:6px;")}">Alert details</div>
            <div data-detail-body style="font-size:12px;line-height:1.55;"></div>
            <div data-coords style="${label("margin-top:14px;text-align:right;")}"></div>
          </div>
        </div>
        <div data-timeline-wrap style="display:none;margin-top:18px;border:2px solid ${RULE};">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:2px solid ${RULE};background:${SURFACE};">
            <div style="${label()}">Active alert timeline · within 50 miles of Brookings Hall · campus time</div>
            <div data-timeline-window style="${label()}"></div>
          </div>
          <div data-timeline style="padding:10px 16px 14px;"></div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px;font-size:11px;font-weight:700;align-items:center;">
          <span style="display:flex;align-items:center;gap:7px;"><span style="width:20px;height:12px;background:rgba(236,48,19,0.34);border:2px solid #a5170a;box-sizing:border-box;"></span>Tornado warning</span>
          <span style="display:flex;align-items:center;gap:7px;"><span style="width:20px;height:12px;background:rgba(224,112,11,0.3);border:2px solid #9a4a05;box-sizing:border-box;"></span>Severe thunderstorm warning</span>
          <span style="display:flex;align-items:center;gap:7px;"><span style="width:20px;height:12px;background:rgba(242,183,5,0.18);border:2px dashed #8a6702;box-sizing:border-box;"></span>Tornado watch</span>
          <span style="display:flex;align-items:center;gap:7px;"><span style="width:20px;height:12px;background:rgba(143,107,18,0.16);border:2px dashed #5d450a;box-sizing:border-box;"></span>Severe thunderstorm watch</span>
          <span style="width:2px;height:16px;background:${HAIR};"></span>
          <span style="display:flex;align-items:center;gap:7px;font-weight:600;"><span style="width:16px;height:9px;background:rgba(158,53,38,0.16);border:1px solid #9e3526;box-sizing:border-box;"></span>Flash flood warning</span>
          <span style="display:flex;align-items:center;gap:7px;font-weight:600;"><span style="width:16px;height:9px;background:rgba(96,93,93,0.16);border:1px solid ${MUTED};box-sizing:border-box;"></span>Flood warning</span>
          <span style="display:flex;align-items:center;gap:7px;font-weight:600;"><span style="width:16px;height:9px;background:rgba(186,182,182,0.3);border:1px solid #bab6b6;box-sizing:border-box;"></span>Other alerts</span>
          <span style="display:flex;align-items:center;gap:7px;font-weight:600;"><span style="width:16px;height:2px;background:${INK};"></span>5-mile ring, Brookings Hall</span>
        </div>
        <div style="font-size:11px;color:${MUTED};margin-top:10px;">Sources: NWS active alerts nationwide, marine alerts excluded. County outlines from a public US county map. Radar from Iowa State Mesonet. Basemap from CARTO and OpenStreetMap. Updates every 30 s.</div>

        <div data-dock style="display:none;margin-top:24px;border-top:2px solid ${RULE};padding-top:18px;">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:14px;">
            <div>
              <div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:22px;line-height:1.1;letter-spacing:-0.02em;">Damage survey analysis</div>
              <div data-dock-scope style="font-size:11px;color:${MUTED};margin-top:4px;"></div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button data-play style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:8px 12px;border:2px solid ${INK};background:transparent;color:${INK};cursor:pointer;">▶ Play years</button>
              <button data-facet-reset style="font-family:Archivo,system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:8px 12px;border:2px solid ${RULE};background:transparent;color:${DEEPRED};cursor:pointer;">Reset selection</button>
            </div>
          </div>

          <div data-kpis style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:2px solid ${RULE};border-bottom:none;"></div>

          <div style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr) minmax(0,1fr);border:2px solid ${RULE};">
            <div style="border-right:2px solid ${RULE};padding:16px;">
              <div style="${label("margin-bottom:12px;")}">Surveys by year · click to filter</div>
              <div data-hist style="display:flex;align-items:flex-end;gap:2px;height:150px;"></div>
              <div data-hist-axis style="display:flex;justify-content:space-between;margin-top:6px;${label()}"></div>
            </div>
            <div style="border-right:2px solid ${RULE};padding:16px;">
              <div style="${label("margin-bottom:12px;")}">EF rating · click to filter</div>
              <div data-efbars style="display:flex;flex-direction:column;gap:7px;"></div>
            </div>
            <div style="padding:16px;">
              <div style="${label("margin-bottom:12px;")}">Closest to Brookings Hall</div>
              <div data-notable style="display:flex;flex-direction:column;"></div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,2fr);border:2px solid ${RULE};border-top:none;">
            <div style="border-right:2px solid ${RULE};padding:16px;">
              <div style="${label("margin-bottom:12px;")}">Direction storms arrived from</div>
              <div style="display:flex;align-items:center;gap:18px;">
                <div data-rose></div>
                <div data-rose-note style="font-size:11px;color:${MUTED};line-height:1.5;"></div>
              </div>
            </div>
            <div style="padding:16px;">
              <div style="${label("margin-bottom:12px;")}">Surveys by month</div>
              <div data-season style="display:flex;align-items:flex-end;gap:6px;height:120px;"></div>
              <div data-season-axis style="display:flex;gap:6px;margin-top:6px;"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const CAMPUS_TZ = "America/Chicago";

  const campusAbbr = iso => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: CAMPUS_TZ, timeZoneName: "short" })
        .formatToParts(new Date(iso)).find(p => p.type === "timeZoneName").value;
    } catch (e) { return "CT"; }
  };

  const fmtCampus = (iso, withDate) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const opts = { timeZone: CAMPUS_TZ, hour: "2-digit", minute: "2-digit", hour12: false };
    if (withDate) { opts.month = "short"; opts.day = "numeric"; }
    return d.toLocaleString("en-US", opts).replace(",", "") + " " + campusAbbr(iso);
  };

  // Offset embedded in the timestamp, e.g. "-05:00" or "Z".
  const isoOffsetMinutes = iso => {
    const m = String(iso || "").match(/(Z|[+-]\d{2}:?\d{2})$/);
    if (!m) return null;
    if (m[1] === "Z") return 0;
    const sign = m[1][0] === "-" ? -1 : 1;
    const parts = m[1].slice(1).replace(":", "");
    return sign * (parseInt(parts.slice(0, 2), 10) * 60 + parseInt(parts.slice(2), 10));
  };

  const campusOffsetMinutes = iso => {
    try {
      const d = new Date(iso);
      const tz = new Date(d.toLocaleString("en-US", { timeZone: CAMPUS_TZ }));
      const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
      return Math.round((tz - utc) / 60000);
    } catch (e) { return null; }
  };

  // The office's own wall-clock reading, taken from the offset in the timestamp.
  const fmtAsIssued = iso => {
    const off = isoOffsetMinutes(iso);
    if (off === null) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const shifted = new Date(d.getTime() + off * 60000);
    const hh = String(shifted.getUTCHours()).padStart(2, "0");
    const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
    const sign = off < 0 ? "-" : "+";
    const abs = Math.abs(off);
    return hh + ":" + mm + " UTC" + sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
  };

  const relativeTo = iso => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const mins = Math.round((d - Date.now()) / 60000);
    const mag = Math.abs(mins);
    const unit = mag >= 120 ? Math.round(mag / 60) + " h" : mag + " min";
    return mins >= 0 ? "in " + unit : unit + " ago";
  };

  const isPolygonBased = f => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon");

  function isMoIlAlert(alert) {
    const p = alert.properties;
    if (!p) return false;
    if (p.geocode && p.geocode.SAME) {
      return p.geocode.SAME.some(code => {
        const s = String(code).padStart(6, "0").substring(1, 3);
        return s === "29" || s === "17";
      });
    }
    if (p.geocode && p.geocode.UGC) {
      return p.geocode.UGC.some(c => { const s = String(c).toUpperCase(); return s.startsWith("MO") || s.startsWith("IL"); });
    }
    if (p.areaDesc) {
      return [", MO", " MO;", ", IL", " IL;"].some(t => p.areaDesc.includes(t)) || /\sMO$|\sIL$/.test(p.areaDesc);
    }
    return false;
  }

  const RADAR_FRAMES = [
    { layer: "nexrad-n0q-900913-m50m", mins: 50 },
    { layer: "nexrad-n0q-900913-m40m", mins: 40 },
    { layer: "nexrad-n0q-900913-m30m", mins: 30 },
    { layer: "nexrad-n0q-900913-m20m", mins: 20 },
    { layer: "nexrad-n0q-900913-m10m", mins: 10 },
    { layer: "nexrad-n0q-900913", mins: 0 }
  ];

  const TIMELINE_RADIUS_MI = 50;

  const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

  const EF_ORDER = ["N/A", "UNKNOWN", "TROPICAL", "WIND", "TSTM/WIND", "EFU", "EF0", "EF1", "EF2", "EF3", "EF3+", "EF4", "EF5"];

  const validDate = v => {
    if (v == null || v === 0 || v === "") return null;
    const d = new Date(typeof v === "number" ? v : Date.parse(v));
    return (isNaN(d) || d.getUTCFullYear() < 1950) ? null : d;
  };

  const featYear = p => {
    const d = validDate(p && p.stormdate);
    return d ? String(d.getUTCFullYear()) : null;
  };

  const surveyLabel = p => p.event_id || p.damage_txt
    || ((p.efscale ? p.efscale + " " : "") + "damage survey" + (p.office || p.wfo ? " · " + (p.office || p.wfo) : ""));

  const fmtDay = v => {
    const d = validDate(v);
    return d ? d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }) : "Date unknown";
  };

  // Straight-line miles from campus to the nearest vertex of a survey geometry.
  const minDistMiles = feature => {
    const g = feature && feature.geometry;
    if (!g) return null;
    let best = Infinity;
    const walk = c => {
      if (typeof c[0] === "number") {
        const dx = (c[0] - ASSET_LNG_LAT[0]) * 69.17 * Math.cos(ASSET_LNG_LAT[1] * Math.PI / 180);
        const dy = (c[1] - ASSET_LNG_LAT[1]) * 69.17;
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
      } else c.forEach(walk);
    };
    try { walk(g.coordinates); } catch (e) { return null; }
    return isFinite(best) ? best : null;
  };

  const esriColor = (c, fallback) => (!c || c.length < 3)
    ? (fallback || "transparent")
    : "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + ((c[3] == null ? 255 : c[3]) / 255) + ")";

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  class WeatherMonitor extends HTMLElement {
    connectedCallback() {
      // The runtime detaches and re-attaches this element during reconciliation,
      // which fires disconnectedCallback and clears every timer. Re-arm rather
      // than bailing out, or the size watcher and the 30-second refresh are gone
      // for good after the first re-attach.
      if (this._booted) return this.resume();
      this._booted = true;
      this.style.display = "block";
      this.innerHTML = TEMPLATE;
      this.raw = [];
      this.activeFilters = new Set();
      this.knownEmergencyIds = new Set();
      this.counties = null;
      this.pulseOpacity = 0.8;
      this.pulseUp = false;
      this.waitForLibs();
    }

    stopDrillTimer() { clearInterval(this.drillTimer); this.drillTimer = null; }

    disconnectedCallback() {
      this.stopDrillTimer();
      /* The size watcher is deliberately NOT cleared on detach. It is the only
         trigger that does not depend on a lifecycle callback firing: while
         detached it reads a null container and does nothing, and it clears itself
         the moment the map measures. Clearing it here is what left three maps at a
         zero-area viewport. */
      if (this._ro) this._ro.disconnect();
      clearInterval(this.playTimer);
      clearInterval(this.radarTimer);
      clearInterval(this.pulseTimer);
      clearInterval(this.refreshTimer);
    }

    // Everything torn down on detach, restarted. Safe to call repeatedly.
    resume() {
      if (!this.map) return;
      this.armMapSize();
      if (this._ro) this._ro.observe(this);
      this.startTimers();
    }

    /* The pulse restyles live SVG paths, and the national feed can carry a
       hundred-plus alerts with dissolved multi-county geometry. Run it only while
       this tab is actually on screen, only over the warning layers that breathe
       (cached per redraw rather than re-scanned every frame), and at 100ms rather
       than 60 — the animation reads the same and the main thread stays free. */
    startPulse() {
      clearInterval(this.pulseTimer);
      this.pulseTimer = setInterval(() => {
        if (!this.offsetWidth || !this.map) return;
        this.pulseOpacity = this.pulseUp ? this.pulseOpacity + 0.08 : this.pulseOpacity - 0.08;
        if (this.pulseOpacity >= 0.9 || this.pulseOpacity <= 0.2) this.pulseUp = !this.pulseUp;
        const o = this.pulseOpacity;
        if (this.map.hasLayer(this.assetBuffer)) this.assetBuffer.setStyle({ opacity: 0.6 + o * 0.4, weight: 3 + o * 3 });
        (this._pulseLayers || []).forEach(x => {
          x.layer.setStyle({ weight: x.pri.weight + o * 1.6, opacity: Math.min(1, 0.7 + o * 0.3) });
        });
      }, 100);
    }

    // Recomputed when the alert layer is redrawn, so the pulse never walks the
    // whole national feed on every frame.
    cachePulseLayers() {
      const out = [];
      if (this.alertsLayer) {
        this.alertsLayer.eachLayer(layer => {
          const pri = PRIORITY_STYLE[(layer.feature.properties || {}).event];
          if (pri && !pri.dash) out.push({ layer: layer, pri: pri });
        });
      }
      this._pulseLayers = out;
    }

    startTimers() {
      clearInterval(this.refreshTimer);
      this.refreshTimer = setInterval(() => this.fetchData(), 30000);
      this.startPulse();
    }

    q(sel) { return this.querySelector(sel); }

    waitForLibs() {
      if (window.L && window.turf) return this.boot();
      if (this._waited > 200) return;
      this._waited = (this._waited || 0) + 1;
      setTimeout(() => this.waitForLibs(), 100);
    }

    boot() {
      this.initMap();
      this.q("[data-sync-btn]").onclick = () => this.fetchData();
      this.q("[data-fullscreen]").onclick = () => this.toggleFullscreen();
      this.q("[data-drill]").onclick = () => this.toggleDrill();
      document.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        if (this.q("[data-map-shell]").getAttribute("data-expanded") === "1") this.toggleFullscreen();
      });
      this.q("[data-close]").onclick = () => { this.q("[data-detail]").style.display = "none"; };
      this.q("[data-dismiss]").onclick = () => { this.q("[data-emergency]").style.display = "none"; };
      this.q("[data-clear]").onclick = () => { this.activeFilters.clear(); this.applyFilters(); this.renderFilterList(); this.updateTicker(); };
      this.q("[data-ticker]").addEventListener("click", e => {
        const item = e.target.closest("[data-alert-id]");
        if (item) this.focusOnAlert(item.getAttribute("data-alert-id"));
      });
      this.q("[data-dat-run]").onclick = () => this.runDatQuery();
      this.q("[data-dat-clear]").onclick = () => this.clearDat();
      ["[data-dat-event]", "[data-dat-county]"].forEach(sel => {
        this.q(sel).addEventListener("keydown", e => { if (e.key === "Enter") this.runDatQuery(); });
      });
      this.q("[data-radar-play]").onclick = () => this.toggleRadarLoop();
      this.q("[data-timeline]").addEventListener("click", e => {
        const row = e.target.closest("[data-alert-id]");
        if (row) this.focusOnAlert(row.getAttribute("data-alert-id"));
      });
      this.loadDatRenderers();
      ["campus", "region", "recent"].forEach(k => {
        this.querySelector('[data-preset="' + k + '"]').onclick = () => this.runPreset(k);
      });
      this.q("[data-play]").onclick = () => this.togglePlay();
      this.q("[data-facet-reset]").onclick = () => {
        if (this.playTimer) this.togglePlay();
        this.datFacet = { ef: null, year: null };
        this.applyDatFacets(false);
      };
      this.q("[data-hist]").addEventListener("click", e => {
        const bar = e.target.closest("[data-year]");
        if (!bar) return;
        if (this.playTimer) this.togglePlay();
        this.setFacet("year", bar.getAttribute("data-year"));
      });
      this.q("[data-efbars]").addEventListener("click", e => {
        const row = e.target.closest("[data-ef]");
        if (row) this.setFacet("ef", row.getAttribute("data-ef"));
      });
      this.q("[data-notable]").addEventListener("click", e => {
        const row = e.target.closest("[data-oid]");
        if (row) this.zoomToDatRecord(row.getAttribute("data-oid"));
      });
      this.fetchData();
      this.startTimers();
    }

    // Expanded view is a fixed overlay rather than the Fullscreen API: the API is
    // unavailable inside embedded frames, and the overlay behaves identically.
    toggleFullscreen() {
      const shell = this.q("[data-map-shell]");
      const btn = this.q("[data-fullscreen]");
      const mapEl = this.q("[data-map]");
      const on = shell.getAttribute("data-expanded") === "1";
      if (on) {
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
      setTimeout(() => { this.map.invalidateSize(); this.unstickControls(); }, 60);
    }


    /* Mounted inside a hidden tab, Leaflet caches a 0x0 size: setView keeps the
       centre and zoom, but tiles and getBounds() are computed for a zero-area
       viewport, so the basemap stays blank. The host
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
      if (this.unstickControls) this.unstickControls();
      return true;
    }

    initMap() {
      const map = L.map(this.q("[data-map]"), { zoomSnap: 0.5 }).setView(ASSET_COORD, 9);
      this.map = map;
      this.armMapSize();
      map.createPane("assetPane");
      map.getPane("assetPane").style.zIndex = 450;
      map.getPane("assetPane").style.pointerEvents = "none";

      cartoBasemap(map, "light_all");

      this.radarLayer = L.tileLayer.wms(RADAR_URL, {
        layers: "nexrad-n0q-900913", format: "image/png", transparent: true, opacity: 0.45,
        attribution: "Radar © Iowa Environmental Mesonet", t: Date.now()
      });

      const assetIcon = L.divIcon({
        className: "", html: '<div style="width:12px;height:12px;background:' + INK + ';border:2px solid ' + GROUND + ';"></div>',
        iconSize: [12, 12], iconAnchor: [6, 6]
      });
      L.marker(ASSET_COORD, { icon: assetIcon }).addTo(map).bindTooltip("Brookings Hall", { direction: "top" });

      this.assetBuffer = L.circle(ASSET_COORD, {
        radius: FIVE_MILE_METERS, color: INK, weight: 3, opacity: 0.85,
        fillColor: INK, fillOpacity: 0.06, dashArray: "6, 8", pane: "assetPane", interactive: false
      }).addTo(map);

      this.alertsLayer = L.geoJSON(null, {
        style: feature => {
          const p = feature.properties;
          const pri = PRIORITY_STYLE[p.event];
          if (pri) {
            return {
              fillColor: pri.color, fillOpacity: pri.fill, color: pri.stroke,
              weight: pri.weight, opacity: 0.95, dashArray: pri.dash,
              lineJoin: "round", interactive: true
            };
          }
          const color = EVENT_PALETTE[p.event] || EVENT_PALETTE.Default;
          return {
            fillColor: color, color: color, weight: 1, opacity: 0.5,
            fillOpacity: 0.12, dashArray: null, lineJoin: "round", interactive: true
          };
        },
        onEachFeature: (feature, layer) => {
          layer.on("click", e => {
            L.DomEvent.stopPropagation(e);
            this.decodeAlertDetail(feature.properties);
            this.fetchPointForecast(e.latlng.lat.toFixed(4), e.latlng.lng.toFixed(4));
          });
        }
      }).addTo(map);

      map.createPane("datPane");
      map.getPane("datPane").style.zIndex = 460;

      this.datLayers = {};
      DAT_LAYERS.forEach(cfg => {
        const layer = L.geoJSON(null, {
          pane: "datPane",
          pointToLayer: (feature, latlng) => this.datPointMarker(cfg, feature, latlng),
          style: feature => this.datVectorStyle(cfg, feature),
          onEachFeature: (feature, lyr) => {
            lyr.on("click", e => { L.DomEvent.stopPropagation(e); this.showDatDetail(cfg, feature.properties); });
          }
        });
        this.datLayers[cfg.id] = layer;
      });

      this.layerControl = L.control.layers(null, {
        "Live radar · NEXRAD": this.radarLayer,
        "5-mile ring": this.assetBuffer,
        "Warnings, watches, advisories": this.alertsLayer
      }, { collapsed: false, position: "bottomleft" }).addTo(map);

      this.radarLayer.addTo(map);

      // Loop frames sit under the live layer; only one is opaque at a time.
      map.createPane("radarLoopPane");
      map.getPane("radarLoopPane").style.zIndex = 250;
      this.radarFrames = RADAR_FRAMES.map(f => L.tileLayer.wms(RADAR_URL, {
        layers: f.layer, format: "image/png", transparent: true, opacity: 0, pane: "radarLoopPane"
      }));

      this.datRings = L.layerGroup().addTo(map);

      map.on("click", e => {
        const { lat, lng } = e.latlng;
        this.q("[data-detail]").style.display = "block";
        this.q("[data-detail-title]").textContent = "Point details";
        this.q("[data-detail-body]").innerHTML = '<div style="color:' + MUTED + ';">No active alert at this point.</div>';
        this.q("[data-coords]").textContent = lat.toFixed(4) + ", " + lng.toFixed(4);
        this.fetchPointForecast(lat.toFixed(4), lng.toFixed(4));
      });

      // The element may be mounted while its tab is hidden (display:none), which
      // leaves Leaflet at zero size; re-measure as soon as it gains width.
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          if (this.offsetWidth > 0) {
            map.invalidateSize();
            this.unstickControls();
            if (this.drawRoads) this.drawRoads();
          }
        });
        this._ro.observe(this);
      }
      this.startPulse();
    }

    async fetchData() {
      this.armMapSize();
      try {
        if (!this.counties) {
          const r = await fetch(COUNTY_GEO_URL);
          this.counties = await r.json();
          this.populateCountyList();
        }
        const res = await fetch(API_URL, { headers: { Accept: "application/geo+json" } });
        const data = await res.json();
        this.raw = (data.features || []).filter(f => !EXCLUDED_EVENTS.includes(f.properties.event));
        if (this.drillOn) this.raw.unshift(this.drillFeature());
        this.checkEmergencyIntersections();
        this.updateTicker();
        this.applyFilters();
        this.renderFilterList();
        this.q("[data-sync]").textContent = fmtCampus(new Date().toISOString());
        this.publishContext();
      } catch (e) {
        this.q("[data-sync]").textContent = "Update failed. Retry in 30 s.";
        console.error("Sync error", e);
      }
    }

    /* ---------- exercise injection ---------------------------------------
       A drill warning has to travel the same path as a real one — map styling,
       filter list, timeline, intersection alarm, ticker, shared context — or the
       exercise proves nothing about the display. So it is a normal CAP-shaped
       feature pushed into the same array, distinguishable only by its EXERCISE
       labelling.

       The feature is built ONCE per injection and cached. A real warning carries
       fixed issue and expiry stamps that the display counts down against; if the
       drill rebuilt its timestamps on every 30-second sync the timeline bar would
       never move, which is exactly the behaviour under test. */
    drillFeature() {
      if (this._drillFeature) return this._drillFeature;
      const now = Date.now();
      const issued = new Date(now).toISOString();
      const ends = new Date(now + 30 * 60000).toISOString();
      this._drillFeature = {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: DRILL_POLYGON },
        properties: {
          id: DRILL_ID,
          event: "Tornado Warning",
          areaDesc: "EXERCISE · Southwestern St. Louis County; St. Louis City (drill)",
          headline: "EXERCISE EXERCISE EXERCISE · Tornado Warning for exercise purposes only",
          description: "THIS IS AN EXERCISE. No tornado warning is in effect. This drill warning was added from the dashboard to test the map, alarm and timeline. Its area touches the 5-mile ring southwest of Brookings Hall. EXERCISE EXERCISE EXERCISE.",
          instruction: "EXERCISE ONLY. Take no protective action. Clear it with the Clear drill button.",
          severity: "Extreme",
          certainty: "Observed",
          urgency: "Immediate",
          senderName: "WashU EM dashboard (exercise)",
          status: "Exercise",
          messageType: "Alert",
          sent: issued,
          effective: issued,
          onset: issued,
          expires: ends,
          ends: ends,
          geocode: { SAME: ["029189", "029510"], UGC: ["MOC189", "MOC510"] },
          parameters: { NWSheadline: ["EXERCISE · DRILL PRODUCT"] },
          drill: true
        }
      };
      return this._drillFeature;
    }

    toggleDrill() {
      this.drillOn = !this.drillOn;
      const btn = this.q("[data-drill]");
      if (this.drillOn) {
        this._drillFeature = null; // a fresh injection issues a fresh 30-minute product
        this.raw = [this.drillFeature()].concat(this.raw.filter(a => a.properties.id !== DRILL_ID));
        btn.textContent = "Clear drill";
        btn.className = "btn btn-primary";
        // Re-render on a cadence so the countdown and the now-rule visibly move,
        // rather than only stepping when the 30-second feed sync lands.
        clearInterval(this.drillTimer);
        this.drillTimer = setInterval(() => {
          const f = this._drillFeature;
          if (!f) return;
          // Let it lapse like a real product: it falls out of the timeline and the
          // alarm does not re-fire, but the injection stays visible as expired.
          if (Date.parse(f.properties.ends) <= Date.now()) {
            const b = this.q("[data-drill-banner]");
            if (b) b.setAttribute("data-lapsed", "1");
          }
          this.renderTimeline();
          this.updateTicker();
        }, 15000);
      } else {
        clearInterval(this.drillTimer);
        this.drillTimer = null;
        this._drillFeature = null;
        this.knownEmergencyIds.delete(DRILL_ID);
        this.raw = this.raw.filter(a => a.properties.id !== DRILL_ID);
        btn.textContent = "Start drill warning";
        btn.className = "btn btn-secondary";
        const xb = this.q("[data-emergency-exercise]");
        if (xb) xb.style.display = "none";
      }
      this.q("[data-drill-banner]").style.display = this.drillOn ? "flex" : "none";
      this.checkEmergencyIntersections();
      this.updateTicker();
      this.applyFilters();
      this.renderFilterList();
      this.renderTimeline();
      this.publishContext();
      if (this.drillOn) {
        const b = L.geoJSON(this.drillFeature()).getBounds().extend(L.latLng(ASSET_COORD));
        this.map.fitBounds(b, { padding: [40, 40] });
      }
    }

    // Shared registry read by the dashboard's analyst assistant.
    publishContext() {
      const counts = {};
      this.raw.forEach(a => { counts[a.properties.event] = (counts[a.properties.event] || 0) + 1; });
      const moIl = this.raw.filter(isMoIlAlert);
      const critical = moIl.filter(a => PULSE_EVENTS.includes(a.properties.event)).map(a => ({
        event: a.properties.event,
        area: a.properties.areaDesc,
        ends: a.properties.ends || a.properties.expires,
        severity: a.properties.severity
      }));
      window.__omContext = window.__omContext || {};
      window.__omContext.weather = {
        updated: new Date().toISOString(),
        nationalAlertCount: this.raw.length,
        moIlAlertCount: moIl.length,
        criticalMoIl: critical,
        eventTypeCounts: counts,
        tornadoWithin5Miles: this.knownEmergencyIds.size > 0,
        exerciseInjected: this.drillOn ? "A fictitious Tornado Warning is injected for exercise purposes. Any tornado-within-5-miles condition reported here may be the drill product, not a National Weather Service warning." : null,
        note: "From the Weather Monitoring tab: national NWS CAP feed, marine products excluded, polled every 30 s."
      };
      window.dispatchEvent(new CustomEvent("om-context"));
    }

    checkEmergencyIntersections() {
      let trigger = false, drill = false;
      const buffer = turf.buffer(turf.point(ASSET_LNG_LAT), 5, { units: "miles" });
      this.raw.forEach(alert => {
        if (alert.properties.event !== "Tornado Warning" || !isPolygonBased(alert)) return;
        try {
          if (turf.booleanIntersects(buffer, alert.geometry) && !this.knownEmergencyIds.has(alert.properties.id)) {
            trigger = true;
            if (alert.properties.drill) drill = true;
            this.knownEmergencyIds.add(alert.properties.id);
          }
        } catch (e) { console.error("Intersection check failed", e); }
      });
      if (trigger) {
        const banner = this.q("[data-emergency-exercise]");
        if (banner) banner.style.display = drill ? "block" : "none";
        this.q("[data-emergency]").style.display = "flex";
      }
    }

    updateTicker() {
      const track = this.q("[data-ticker]");
      const seen = new Set();
      const items = [];
      this.raw.forEach(a => {
        const p = a.properties;
        if (this.activeFilters.size > 0 && !this.activeFilters.has(p.event)) return;
        if (!PULSE_EVENTS.includes(p.event)) return;
        const key = p.event + "|" + (p.areaDesc || "").split(";").map(s => s.trim()).sort().join("|");
        if (seen.has(key)) return;
        seen.add(key);
        items.push(a);
      });

      if (!items.length) {
        track.innerHTML = '<span style="font-size:11px;font-weight:600;color:' + MUTED + ';padding:0 24px;">No critical alerts active nationwide</span>';
        return;
      }

      track.innerHTML = items.map(a => {
        const p = a.properties;
        const time = p.sent ? fmtCampus(p.sent) : "--:--";
        return '<span data-alert-id="' + esc(p.id) + '" style="display:inline-flex;align-items:center;gap:8px;padding:0 20px;border-right:1px solid ' + HAIR + ';cursor:pointer;">'
          + '<b style="font-size:12px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:' + DEEPRED + ';">' + esc(p.event) + '</b>'
          + '<span style="font-size:12px;">' + esc(p.areaDesc) + '</span>'
          + '<span style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:' + MUTED + ';">Issued ' + esc(time) + '</span></span>';
      }).join("");
      track.style.animationDuration = Math.max(30, items.length * 10) + "s";
    }

    focusOnAlert(id) {
      this.alertsLayer.eachLayer(layer => {
        if (layer.feature.properties.id !== id) return;
        const bounds = layer.getBounds();
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
        this.decodeAlertDetail(layer.feature.properties);
        const c = bounds.getCenter();
        this.fetchPointForecast(c.lat.toFixed(4), c.lng.toFixed(4));
      });
    }

    // County-based products arrive as a list of FIPS codes. Drawing one polygon per
    // county fills the map with shared borders, so each alert is dissolved into a
    // single outline and cached — the union only changes when the alert set does.
    // Built once per counties payload; a linear find() per SAME code per alert
    // was millions of comparisons of blocking work on the national feed.
    countyById(fips) {
      if (!this.counties) return null;
      if (!this._countyIndex) {
        this._countyIndex = new Map();
        this.counties.features.forEach(f => this._countyIndex.set(String(f.id), f));
      }
      return this._countyIndex.get(String(fips)) || null;
    }

    countyShape(alert) {
      const id = alert.properties.id;
      this._dissolveCache = this._dissolveCache || new Map();
      if (this._dissolveCache.has(id)) return this._dissolveCache.get(id);
      const parts = ((alert.properties.geocode && alert.properties.geocode.SAME) || []).map(code => {
        const fips = String(code).length === 6 ? String(code).substring(1) : String(code);
        const shape = this.countyById(fips);
        return shape ? { type: "Feature", properties: {}, geometry: shape.geometry } : null;
      }).filter(Boolean);
      let merged = null;
      if (parts.length) {
        merged = parts[0];
        for (let i = 1; i < parts.length; i++) {
          try { merged = turf.union(merged, parts[i]) || merged; } catch (e) { /* keep what merged */ }
        }
      }
      const out = merged ? merged.geometry : null;
      this._dissolveCache.set(id, out);
      return out;
    }

    applyFilters() {
      const processed = [];
      this.raw.forEach(alert => {
        if (this.activeFilters.size > 0 && !this.activeFilters.has(alert.properties.event)) return;
        if (alert.geometry) { processed.push(alert); return; }
        if (!this.counties) return;
        const geom = this.countyShape(alert);
        if (geom) processed.push({ type: "Feature", geometry: geom, properties: Object.assign({}, alert.properties) });
      });

      processed.sort((a, b) => (EVENT_PRIORITY[b.properties.event] || 9) - (EVENT_PRIORITY[a.properties.event] || 9));
      this.alertsLayer.clearLayers().addData({ type: "FeatureCollection", features: processed });
      this.cachePulseLayers();
      // Convective products sit above everything else on the map.
      [...PRIORITY_EVENTS].reverse().forEach(ev => {
        this.alertsLayer.eachLayer(l => { if (l.feature.properties.event === ev && l.bringToFront) l.bringToFront(); });
      });

      const nat = this.q("[data-stat-national]");
      if (nat) nat.textContent = this.raw.length;
      this.q("[data-stat-visible]").textContent = processed.filter(isMoIlAlert).length;
      this.q("[data-stat-high]").textContent = this.raw.filter(a => PULSE_EVENTS.includes(a.properties.event) && isMoIlAlert(a)).length;
      this.renderTimeline();
    }

    // Geometry for an alert: its own polygon, or the county shapes it names.
    alertGeometries(alert) {
      if (alert.geometry) return [alert];
      if (!this.counties) return [];
      return ((alert.properties.geocode && alert.properties.geocode.SAME) || []).map(code => {
        const fips = String(code).length === 6 ? String(code).substring(1) : String(code);
        const shape = this.countyById(fips);
        return shape ? { type: "Feature", geometry: shape.geometry, properties: {} } : null;
      }).filter(Boolean);
    }

    withinMiles(alert, miles) {
      this._nearCache = this._nearCache || new Map();
      const key = alert.properties.id + "|" + miles;
      if (this._nearCache.has(key)) return this._nearCache.get(key);
      let hit = false;
      this.alertGeometries(alert).forEach(f => {
        if (hit) return;
        const d = minDistMiles(f);
        if (d != null && d <= miles) { hit = true; return; }
        try {
          if ((f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
            && turf.booleanPointInPolygon(turf.point(ASSET_LNG_LAT), f)) hit = true;
        } catch (e) { /* malformed geometry */ }
      });
      this._nearCache.set(key, hit);
      return hit;
    }

    // Issue-to-expiry bars for the regional alerts, against a live “now” line.
    renderTimeline() {
      const wrap = this.q("[data-timeline-wrap]");
      const box = this.q("[data-timeline]");
      const now = Date.now();
      const items = this.raw.filter(a => isMoIlAlert(a) && this.withinMiles(a, TIMELINE_RADIUS_MI) &&
        (this.activeFilters.size === 0 || this.activeFilters.has(a.properties.event)))
        .map(a => {
          const p = a.properties;
          const start = Date.parse(p.onset || p.effective || p.sent);
          const end = Date.parse(p.ends || p.expires);
          return { p, start, end };
        })
        .filter(x => x.end && x.end > now && !isNaN(x.start))
        .sort((a, b) => (EVENT_PRIORITY[a.p.event] || 9) - (EVENT_PRIORITY[b.p.event] || 9) || a.end - b.end)
        .slice(0, 10);

      if (!items.length) { wrap.style.display = "none"; return; }
      wrap.style.display = "block";

      const t0 = Math.min(now, ...items.map(x => x.start));
      const t1 = Math.max(...items.map(x => x.end));
      const span = Math.max(1, t1 - t0);
      const pct = t => ((t - t0) / span) * 100;
      const nowPct = pct(now);

      this.q("[data-timeline-window]").textContent = fmtCampus(new Date(t0).toISOString()) + " → " + fmtCampus(new Date(t1).toISOString());

      box.innerHTML = items.map(x => {
        const p = x.p;
        const pri = PRIORITY_STYLE[p.event];
        const color = EVENT_PALETTE[p.event] || EVENT_PALETTE.Default;
        const left = Math.max(0, pct(x.start));
        const width = Math.max(1.2, pct(x.end) - left);
        const area = String(p.areaDesc || "").split(";")[0].trim();
        return '<div data-alert-id="' + esc(p.id) + '" style="display:grid;grid-template-columns:210px minmax(0,1fr) 74px;gap:12px;align-items:center;padding:5px 0;cursor:pointer;">'
          + '<div style="display:flex;align-items:center;gap:7px;overflow:hidden;">'
          + (pri ? '<span style="flex:0 0 auto;width:12px;height:12px;background:' + pri.color + ';border:' + (pri.dash ? "2px dashed " : "2px solid ") + INK + ';box-sizing:border-box;"></span>' : "")
          + '<div style="overflow:hidden;"><div style="font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:' + (pri ? DEEPRED : INK) + ';white-space:nowrap;text-overflow:ellipsis;overflow:hidden;">' + esc(p.event) + "</div>"
          + '<div style="font-size:10px;color:' + MUTED + ';white-space:nowrap;text-overflow:ellipsis;overflow:hidden;">' + esc(area) + "</div></div></div>"
          + '<div style="position:relative;height:16px;background:' + SURFACE + ';">'
          + '<div style="position:absolute;left:' + left + "%;width:" + width + "%;top:0;bottom:0;background:" + color + ";border:" + (pri ? "2px " + (pri.dash ? "dashed " : "solid ") + INK : "none") + ';box-sizing:border-box;"></div>'
          + '<div style="position:absolute;left:' + nowPct + "%;top:-3px;bottom:-3px;width:2px;background:" + INK + ';"></div></div>'
          + '<div style="font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;color:' + MUTED + ';">' + esc(relativeTo(new Date(x.end).toISOString())) + "</div></div>";
      }).join("")
        + '<div style="' + label("margin-top:8px;") + '">Bars run from issue to expiry · the line marks now · right column is time left · click a row to zoom to it</div>';
    }

    toggleRadarLoop() {
      const btn = this.q("[data-radar-play]");
      const stamp = this.q("[data-radar-frame]");
      if (this.radarTimer) {
        clearInterval(this.radarTimer); this.radarTimer = null;
        this.radarFrames.forEach(l => { l.setOpacity(0); this.map.removeLayer(l); });
        if (!this.map.hasLayer(this.radarLayer)) this.radarLayer.addTo(this.map);
        this.radarLayer.setOpacity(0.45);
        btn.textContent = "▶ Loop last hour";
        btn.style.background = "transparent"; btn.style.color = INK;
        stamp.textContent = "Radar · live";
        return;
      }
      this.radarLayer.setOpacity(0);
      this.radarFrames.forEach(l => { if (!this.map.hasLayer(l)) l.addTo(this.map); });
      btn.textContent = "■ Stop loop";
      btn.style.background = INK; btn.style.color = GROUND;
      let i = 0;
      const step = () => {
        this.radarFrames.forEach((l, n) => l.setOpacity(n === i ? 0.5 : 0));
        const mins = RADAR_FRAMES[i].mins;
        stamp.textContent = "Radar · " + fmtCampus(new Date(Date.now() - mins * 60000).toISOString())
          + (mins ? " · −" + mins + " min" : " · latest");
        i = (i + 1) % this.radarFrames.length;
      };
      step();
      this.radarTimer = setInterval(step, 700);
    }

    drawDatRings(radius) {
      this.datRings.clearLayers();
      if (!radius) return;
      [10, 25, 50, 100].filter(r => r <= Number(radius)).forEach(r => {
        L.circle(ASSET_COORD, {
          radius: r * 1609.34, color: INK, weight: r === Number(radius) ? 2 : 1,
          opacity: r === Number(radius) ? 0.75 : 0.3, fill: false,
          dashArray: "3, 7", interactive: false
        }).addTo(this.datRings);
      });
    }

    renderRose(feats) {
      const box = this.q("[data-rose]");
      const note = this.q("[data-rose-note]");
      const bins = new Array(16).fill(0);
      let n = 0;
      feats.forEach(f => {
        const p = f.properties || {};
        if (p.startlat == null || p.endlat == null || p.startlon == null || p.endlon == null) return;
        const dy = p.endlat - p.startlat;
        const dx = (p.endlon - p.startlon) * Math.cos(p.startlat * Math.PI / 180);
        if (!dx && !dy) return;
        // Direction of travel, reversed to give the direction the storm came from.
        const from = (Math.atan2(dx, dy) * 180 / Math.PI + 360 + 180) % 360;
        bins[Math.round(from / 22.5) % 16]++;
        n++;
      });

      if (!n) {
        box.innerHTML = "";
        note.textContent = "No damage paths with start and end points in this search. Widen the radius or date range to see storm directions.";
        return;
      }

      const max = Math.max(...bins);
      const cx = 82, cy = 82, R = 70;
      const petals = bins.map((v, i) => {
        if (!v) return "";
        const r = 12 + (Math.sqrt(v / max)) * (R - 12);
        const a0 = (i * 22.5 - 9 - 90) * Math.PI / 180;
        const a1 = (i * 22.5 + 9 - 90) * Math.PI / 180;
        const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
        const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
        const fill = v === max ? RED : INK;
        return '<path d="M' + cx + " " + cy + " L" + x0.toFixed(1) + " " + y0.toFixed(1)
          + " A" + r.toFixed(1) + " " + r.toFixed(1) + " 0 0 1 " + x1.toFixed(1) + " " + y1.toFixed(1)
          + ' Z" fill="' + fill + '" fill-opacity="' + (v === max ? 0.9 : 0.65) + '"></path>';
      }).join("");

      const rings = [0.5, 1].map(k => '<circle cx="' + cx + '" cy="' + cy + '" r="' + (12 + k * (R - 12)) + '" fill="none" stroke="' + HAIR + '" stroke-width="1"></circle>').join("");
      const ticks = [["N", cx, 10], ["E", cx + R + 8, cy + 4], ["S", cx, cy + R + 14], ["W", cx - R - 12, cy + 4]]
        .map(t => '<text x="' + t[1] + '" y="' + t[2] + '" text-anchor="middle" font-family="Archivo,system-ui,sans-serif" font-size="10" font-weight="800" fill="' + MUTED + '">' + t[0] + "</text>").join("");

      box.innerHTML = '<svg width="172" height="172" viewBox="0 0 164 172" role="img" aria-label="Storm approach directions">'
        + rings + petals + ticks
        + '<circle cx="' + cx + '" cy="' + cy + '" r="3" fill="' + INK + '"></circle></svg>';

      const top = bins.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0])[0];
      const quadrant = bins.slice(8, 13).reduce((s, v) => s + v, 0); // S through W
      note.innerHTML = "<b>" + Math.round(top[0] / n * 100) + "%</b> of " + n + " surveyed paths arrived from the <b>" + COMPASS[top[1]]
        + "</b>.<br>" + Math.round(quadrant / n * 100) + "% came from the south or west.";
    }

    renderSeason(feats) {
      const bins = new Array(12).fill(0);
      feats.forEach(f => {
        const d = validDate((f.properties || {}).stormdate);
        if (d) bins[d.getUTCMonth()]++;
      });
      const max = Math.max(1, ...bins);
      const peak = bins.indexOf(Math.max(...bins));
      this.q("[data-season]").innerHTML = bins.map((v, i) =>
        '<div title="' + v + ' records" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;">'
        + '<div style="' + label("text-align:center;margin-bottom:4px;") + '">' + (v || "") + "</div>"
        + '<div style="flex:0 0 auto;height:' + Math.max(2, (v / max) * 96) + "px;background:" + (i === peak && v ? RED : INK) + ';opacity:' + (v ? 1 : 0.15) + ';"></div></div>').join("");
      this.q("[data-season-axis]").innerHTML = MONTHS.map((m, i) =>
        '<div style="flex:1;text-align:center;' + label() + "color:" + (i === peak ? DEEPRED : MUTED) + ';">' + m + "</div>").join("");
    }

    /* ---------- NWS Damage Assessment Toolkit ---------- */

    renderFilterList() {
      const container = this.q("[data-filters]");
      container.innerHTML = "";
      const counts = {};
      this.raw.forEach(f => { counts[f.properties.event] = (counts[f.properties.event] || 0) + 1; });
      const entries = Object.entries(counts).sort((a, b) => {
        const pa = EVENT_PRIORITY[a[0]] || 9, pb = EVENT_PRIORITY[b[0]] || 9;
        return pa !== pb ? pa - pb : a[0].localeCompare(b[0]);
      });
      if (!entries.length) {
        container.innerHTML = '<div style="font-size:12px;color:' + MUTED + ';padding:12px 0;">No active alerts in the NWS feed.</div>';
        return;
      }
      entries.forEach(([event, count]) => {
        const active = this.activeFilters.has(event);
        const pri = PRIORITY_STYLE[event];
        const row = document.createElement("button");
        row.style.cssText = "display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;text-align:left;padding:9px 10px;border:none;border-bottom:1px solid " + HAIR
          + ";font-family:Archivo,system-ui,sans-serif;font-size:12px;cursor:pointer;background:" + (active ? INK : (pri ? SURFACE : "transparent")) + ";color:" + (active ? GROUND : INK) + ";";
        const chip = pri
          ? '<span style="width:14px;height:11px;background:' + pri.color + ';border:' + (pri.dash ? "2px dashed " : "2px solid ") + (active ? GROUND : INK) + ';box-sizing:border-box;"></span>'
          : '<span style="width:14px;height:11px;background:' + (EVENT_PALETTE[event] || EVENT_PALETTE.Default) + ';opacity:0.55;"></span>';
        row.innerHTML = chip + '<span style="font-weight:' + (pri ? 800 : 600) + ';">' + esc(event) + '</span><span style="font-weight:800;font-variant-numeric:tabular-nums;">' + count + "</span>";
        row.onclick = () => {
          active ? this.activeFilters.delete(event) : this.activeFilters.add(event);
          this.applyFilters(); this.renderFilterList(); this.updateTicker();
        };
        container.appendChild(row);
      });
    }

    async fetchPointForecast(lat, lon) {
      const section = this.q("[data-forecast-section]");
      const content = this.q("[data-forecast]");
      section.style.display = "block";
      content.innerHTML = '<span style="color:' + MUTED + ';">Loading forecast…</span>';
      try {
        const meta = await (await fetch("https://api.weather.gov/points/" + lat + "," + lon, { headers: { Accept: "application/geo+json" } })).json();
        const rel = meta.properties.relativeLocation.properties;
        const fc = await (await fetch(meta.properties.forecast, { headers: { Accept: "application/geo+json" } })).json();
        const p = fc.properties.periods[0];
        content.innerHTML = '<div style="font-weight:800;margin-bottom:4px;">' + esc(rel.city) + ", " + esc(rel.state) + "</div>"
          + '<div style="line-height:1.5;"><b>' + esc(p.name) + ":</b> " + esc(p.detailedForecast) + "</div>";
      } catch (e) {
        content.innerHTML = '<span style="color:' + DEEPRED + ';">NWS forecast not available for this point.</span>';
      }
    }

    /* ---------- NWS Damage Assessment Toolkit ---------- */

    // Renderers are read from the service itself so the map carries the DAT's own
    // symbology (EF-scale picture markers, path and polygon fills) rather than a copy.
    async loadDatRenderers() {
      this.datRenderers = this.datRenderers || {};
      await Promise.all(DAT_LAYERS.map(async cfg => {
        try {
          const meta = await (await fetch(DAT_URL + "/" + cfg.id + "?f=json")).json();
          this.datRenderers[cfg.id] = (meta.drawingInfo || {}).renderer || null;
        } catch (e) { this.datRenderers[cfg.id] = null; }
      }));
    }

    datSymbol(cfg, props) {
      const r = (this.datRenderers || {})[cfg.id];
      if (!r) return null;
      if (r.type === "simple") return r.symbol;
      if (r.type !== "uniqueValue") return r.symbol || null;
      const raw = props[r.field1];
      const val = raw == null ? "" : String(raw);
      const hit = (r.uniqueValueInfos || []).find(u => String(u.value) === val)
        || (r.uniqueValueInfos || []).find(u => String(u.value).toUpperCase() === val.toUpperCase());
      return (hit && hit.symbol) || r.defaultSymbol || null;
    }

    datPointMarker(cfg, feature, latlng) {
      const sym = this.datSymbol(cfg, feature.properties || {});
      const px = v => Math.round((v || 0) * 4 / 3);
      if (!document.getElementById("wm-dat-icon-css")) {
        const s = document.createElement("style");
        s.id = "wm-dat-icon-css";
        s.textContent = ".wm-dat-icon{max-width:none !important;max-height:none !important;}";
        document.head.appendChild(s);
      }
      if (sym && sym.type === "esriPMS" && sym.imageData) {
        const w = px(sym.width) || 20, h = px(sym.height) || 20;
        return L.marker(latlng, {
          pane: "datPane",
          icon: L.icon({
            className: "wm-dat-icon",
            iconUrl: "data:" + (sym.contentType || "image/png") + ";base64," + sym.imageData,
            iconSize: [w, h], iconAnchor: [w / 2, h / 2]
          })
        });
      }
      const size = px(sym && sym.size) || 10;
      return L.circleMarker(latlng, {
        pane: "datPane", radius: size / 2,
        fillColor: esriColor(sym && sym.color, RED), fillOpacity: 1,
        color: esriColor(sym && sym.outline && sym.outline.color, INK),
        weight: (sym && sym.outline && sym.outline.width) || 1
      });
    }

    datVectorStyle(cfg, feature) {
      const sym = this.datSymbol(cfg, feature.properties || {}) || {};
      if (cfg.geom === "line") {
        return { color: esriColor(sym.color, INK), weight: Math.max(2, (sym.width || 3)), opacity: 1 };
      }
      const outline = sym.outline || {};
      return {
        color: esriColor(outline.color, INK), weight: outline.width || 1.5,
        fillColor: esriColor(sym.color, "rgba(32,30,29,0.3)"),
        fillOpacity: sym.color ? (sym.color[3] == null ? 0.6 : sym.color[3] / 255) : 0.35
      };
    }

    populateCountyList() {
      const list = this.querySelector("#wm-county-list");
      if (!list || !this.counties) return;
      const names = this.counties.features.map(f => {
        const st = STATE_FIPS[f.properties.STATE];
        return st ? f.properties.NAME + ", " + st : null;
      }).filter(Boolean).sort();
      list.innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join("");
    }

    findCounty(input) {
      if (!this.counties) return null;
      const parts = String(input).split(",");
      const name = parts[0].trim().toLowerCase();
      const st = (parts[1] || "").trim().toUpperCase();
      return this.counties.features.find(f =>
        f.properties.NAME.toLowerCase() === name && (!st || STATE_FIPS[f.properties.STATE] === st)) || null;
    }

    datStatus(text, tone) {
      const el = this.q("[data-dat-status]");
      el.style.color = tone || MUTED;
      el.innerHTML = text;
    }

    clearDat() {
      DAT_LAYERS.forEach(cfg => this.datLayers[cfg.id].clearLayers());
      this.q("[data-dat-legend]").innerHTML = "";
      ["[data-dat-from]", "[data-dat-to]", "[data-dat-event]", "[data-dat-county]", "[data-dat-radius]"].forEach(s => { this.q(s).value = ""; });
      if (this.playTimer) this.togglePlay();
      this.datRings.clearLayers();
      this.syncDatControl(null);
      DAT_LAYERS.forEach(cfg => this.map.removeLayer(this.datLayers[cfg.id]));
      this.datAll = { 0: [], 1: [], 2: [] };
      this.q("[data-dock]").style.display = "none";
      this.datStatus("No search run yet.");
    }

    async runDatQuery() {
      const from = this.q("[data-dat-from]").value;
      const to = this.q("[data-dat-to]").value;
      const event = this.q("[data-dat-event]").value.trim();
      const countyInput = this.q("[data-dat-county]").value.trim();

      let county = null;
      if (countyInput) {
        county = this.findCounty(countyInput);
        if (!county) return this.datStatus("County not found. Enter it as St. Louis, MO.", DEEPRED);
      }

      const clauses = [];
      if (from) clauses.push("stormdate >= timestamp '" + from + " 00:00:00'");
      if (to) clauses.push("stormdate <= timestamp '" + to + " 23:59:59'");
      if (event) clauses.push("UPPER(event_id) LIKE UPPER('%" + event.replace(/'/g, "''") + "%')");
      let scopeNote = "";
      if (!clauses.length && !county && !this.q("[data-dat-radius]").value) {
        const d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        clauses.push("stormdate >= timestamp '" + d + " 00:00:00'");
        scopeNote = " No filters set. Showing the last 90 days.";
      }
      const where = clauses.join(" AND ") || "1=1";

      let bbox = null;
      if (county) {
        const b = turf.bbox(county);
        bbox = b.join(",");
      }

      const radius = this.q("[data-dat-radius]").value;

      this.datStatus("Searching the Damage Assessment Toolkit…");
      DAT_LAYERS.forEach(cfg => this.datLayers[cfg.id].clearLayers());

      const results = {};
      let truncated = false;
      try {
        await Promise.all(DAT_LAYERS.map(async cfg => {
          const params = new URLSearchParams({
            where, outFields: "*", f: "geojson", returnGeometry: "true",
            outSR: "4326", resultRecordCount: "2000"
          });
          if (radius) {
            params.set("geometry", ASSET_LNG_LAT[0] + "," + ASSET_LNG_LAT[1]);
            params.set("geometryType", "esriGeometryPoint");
            params.set("inSR", "4326");
            params.set("distance", radius);
            params.set("units", "esriSRUnit_StatuteMile");
            params.set("spatialRel", "esriSpatialRelIntersects");
          } else if (bbox) {
            params.set("geometry", bbox);
            params.set("geometryType", "esriGeometryEnvelope");
            params.set("inSR", "4326");
            params.set("spatialRel", "esriSpatialRelIntersects");
          }
          const res = await fetch(DAT_URL + "/" + cfg.id + "/query?" + params.toString());
          const data = await res.json();
          if (data.error) throw new Error(data.error.message || "Search rejected");
          let feats = (data.features || []).filter(f => f.geometry);
          if (county && !radius) {
            feats = feats.filter(f => { try { return turf.booleanIntersects(county, f); } catch (e) { return true; } });
          }
          if (feats.length >= 2000) truncated = true;
          feats.forEach(f => { f.properties.__dist = minDistMiles(f); });
          results[cfg.id] = feats;
        }));
      } catch (e) {
        return this.datStatus("Damage survey search failed: " + esc(e.message) + ". The DAT may be down or blocked on this network. Try again.", DEEPRED);
      }

      const total = DAT_LAYERS.reduce((n, cfg) => n + (results[cfg.id] || []).length, 0);
      this.datAll = results;
      this.datFacet = { ef: null, year: null };
      if (!total) {
        this.q("[data-dock]").style.display = "none";
        this.q("[data-dat-legend]").innerHTML = "";
        this.datRings.clearLayers();
        this.syncDatControl(null);
        return this.datStatus("No damage surveys matched this search." + scopeNote);
      }

      const scope = [
        radius ? "Within " + radius + " miles of Brookings Hall" : (county ? county.properties.NAME + " County, " + STATE_FIPS[county.properties.STATE] : "National"),
        event ? "event ID matching “" + event + "”" : null,
        from || to ? (from || "earliest") + " to " + (to || "present") : (scopeNote ? "last 90 days" : "all dates")
      ].filter(Boolean).join(" · ");
      this.datScope = scope;

      DAT_LAYERS.forEach(cfg => { if ((results[cfg.id] || []).length) this.datLayers[cfg.id].addTo(this.map); });
      this.drawDatRings(radius);
      this.syncDatControl(results);
      this.applyDatFacets(true);

      this.datStatus(total + " record" + (total === 1 ? "" : "s") + " found: "
        + DAT_LAYERS.map(cfg => (results[cfg.id] || []).length + " " + cfg.name.replace("Damage ", "")).join(", ")
        + "." + scopeNote + (truncated ? " The DAT returns at most 2,000 records per layer. Narrow the search to see them all." : ""));
      this.renderDatLegend(results);
    }

    // Controls created while the tab is hidden measure a 0px map and get stuck with
    // Leaflet's scrollbar treatment; re-size them once the view actually has height.
    unstickControls() {
      [this.layerControl, this.datControl].forEach(c => {
        if (!c || !c.getContainer) return;
        const list = c.getContainer().querySelector(".leaflet-control-layers-list");
        if (!list) return;
        list.classList.remove("leaflet-control-layers-scrollbar");
        list.style.height = "";
        list.style.maxHeight = "";
        if (c.expand) c.expand();
      });
    }

    // The survey layers get their own control, present only while a query holds results.
    syncDatControl(results) {
      if (this.datControl) { this.map.removeControl(this.datControl); this.datControl = null; }
      const overlays = {};
      DAT_LAYERS.forEach(cfg => {
        const n = (results && results[cfg.id] || []).length;
        if (n) overlays["Survey · " + cfg.name.replace("Damage ", "") + " (" + n.toLocaleString("en-US") + ")"] = this.datLayers[cfg.id];
      });
      if (this.datRings.getLayers().length) overlays["Survey · distance rings"] = this.datRings;
      if (!Object.keys(overlays).length) return;
      this.datControl = L.control.layers(null, overlays, { collapsed: false, position: "bottomright" }).addTo(this.map);
      const el = this.datControl.getContainer();
      el.style.border = "2px solid " + INK;
      el.style.borderRadius = "0";
      el.insertAdjacentHTML("afterbegin",
        '<div style="' + label("padding:8px 10px 6px;") + '">Damage Assessment Toolkit</div>');
      this.unstickControls();
    }

    datVisible() {
      const f = this.datFacet || { ef: null, year: null };
      const out = {};
      DAT_LAYERS.forEach(cfg => {
        out[cfg.id] = (this.datAll[cfg.id] || []).filter(ft => {
          const p = ft.properties || {};
          if (f.ef && String(p.efscale || "N/A").toUpperCase() !== f.ef) return false;
          if (f.year && featYear(p) !== f.year) return false;
          return true;
        });
      });
      return out;
    }

    applyDatFacets(fit) {
      const vis = this.datVisible();
      DAT_LAYERS.forEach(cfg => {
        const l = this.datLayers[cfg.id];
        l.clearLayers();
        if (vis[cfg.id].length) l.addData({ type: "FeatureCollection", features: vis[cfg.id] });
      });
      if (fit) {
        const b = L.latLngBounds([]);
        DAT_LAYERS.forEach(cfg => { const l = this.datLayers[cfg.id]; if (l.getLayers().length) b.extend(l.getBounds()); });
        if (b.isValid()) this.map.fitBounds(b, { padding: [40, 40], maxZoom: 12 });
      }
      this.renderDock(vis);
    }

    setFacet(key, value) {
      this.datFacet = this.datFacet || { ef: null, year: null };
      this.datFacet[key] = this.datFacet[key] === value ? null : value;
      this.applyDatFacets(false);
    }

    renderDock(vis) {
      const dock = this.q("[data-dock]");
      dock.style.display = "block";
      const all = [].concat(vis[0], vis[1], vis[2]);
      const allUnfiltered = [].concat(this.datAll[0] || [], this.datAll[1] || [], this.datAll[2] || []);
      const f = this.datFacet || {};
      this.q("[data-dock-scope]").textContent = this.datScope
        + (f.ef ? " · filtered to " + f.ef : "") + (f.year ? " · filtered to " + f.year : "");

      const num = n => n.toLocaleString("en-US");
      const events = new Set(all.map(x => (x.properties || {}).event_id).filter(Boolean));
      const sum = k => all.reduce((n, x) => n + (Number((x.properties || {})[k]) > 0 ? Number(x.properties[k]) : 0), 0);
      const rank = s => EF_ORDER.indexOf(String(s || "").toUpperCase());
      const strongest = all.map(x => (x.properties || {}).efscale).filter(Boolean)
        .sort((a, b) => rank(b) - rank(a))[0] || "—";
      const maxWind = Math.max(0, ...all.map(x => Number((x.properties || {}).maxwind) || 0));
      const nearest = all.filter(x => (x.properties || {}).__dist != null)
        .sort((a, b) => a.properties.__dist - b.properties.__dist)[0];

      const kpi = (t, v, sub, tone) => '<div style="padding:14px 16px;border-right:2px solid ' + RULE + ';">'
        + '<div style="' + label("margin-bottom:6px;") + '">' + t + "</div>"
        + '<div style="font-family:Archivo,system-ui,sans-serif;font-weight:800;font-size:30px;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;color:' + (tone || INK) + ';">' + v + "</div>"
        + '<div style="font-size:11px;color:' + MUTED + ';margin-top:5px;line-height:1.35;">' + sub + "</div></div>";

      this.q("[data-kpis]").innerHTML =
        kpi("Survey records", num(all.length), num(vis[0].length) + " points · " + num(vis[1].length) + " paths · " + num(vis[2].length) + " areas")
        + kpi("Separate events", num(events.size), "Different event IDs in this search")
        + kpi("Strongest rating", esc(strongest), maxWind > 0 ? "Top surveyed wind " + maxWind + " mph" : "Rated on the EF scale", DEEPRED)
        + kpi("Casualties", num(sum("deaths") + sum("fatalities")) + " / " + num(sum("injuries")), "Deaths / injuries in survey records", DEEPRED)
        + kpi("Closest to campus", nearest ? nearest.properties.__dist.toFixed(1) + " mi" : "—",
              nearest ? esc(surveyLabel(nearest.properties)) + " · " + fmtDay(nearest.properties.stormdate) : "No mapped records in this search");

      // Year histogram — built from the unfiltered result so the scale holds while faceting.
      const byYear = {};
      allUnfiltered.forEach(x => { const y = featYear(x.properties || {}); if (y) byYear[y] = (byYear[y] || 0) + 1; });
      const years = Object.keys(byYear).sort();
      this.datYears = years;
      const peak = Math.max(1, ...years.map(y => byYear[y]));
      this.q("[data-hist]").innerHTML = years.map(y => {
        const on = !f.year || f.year === y;
        return '<div data-year="' + y + '" title="' + y + " · " + byYear[y] + ' records" style="flex:1;min-width:3px;height:' + Math.max(2, (byYear[y] / peak) * 100) + "%;background:" + (f.year === y ? DEEPRED : INK) + ";opacity:" + (on ? 1 : 0.18) + ';cursor:pointer;"></div>';
      }).join("");
      this.q("[data-hist-axis]").innerHTML = years.length
        ? "<span>" + years[0] + "</span><span>" + num(allUnfiltered.length) + " records · " + years.length + " years</span><span>" + years[years.length - 1] + "</span>"
        : "";

      // Intensity distribution, coloured from the service's own line renderer.
      const byEf = {};
      allUnfiltered.forEach(x => { const e = String((x.properties || {}).efscale || "N/A").toUpperCase(); byEf[e] = (byEf[e] || 0) + 1; });
      const efKeys = Object.keys(byEf).sort((a, b) => EF_ORDER.indexOf(b) - EF_ORDER.indexOf(a));
      const efPeak = Math.max(1, ...efKeys.map(k => byEf[k]));
      this.q("[data-efbars]").innerHTML = efKeys.map(k => {
        const sym = this.datSymbol(DAT_LAYERS[1], { efscale: k });
        const c = esriColor(sym && sym.color, INK);
        const on = !f.ef || f.ef === k;
        return '<div data-ef="' + esc(k) + '" style="cursor:pointer;opacity:' + (on ? 1 : 0.25) + ';">'
          + '<div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin-bottom:3px;"><span>' + esc(k) + '</span><span style="font-variant-numeric:tabular-nums;color:' + MUTED + ';">' + num(byEf[k]) + "</span></div>"
          + '<div style="height:12px;background:' + SURFACE + ';"><div style="height:100%;width:' + (byEf[k] / efPeak) * 100 + "%;background:" + c + ";border-right:2px solid " + (f.ef === k ? INK : "transparent") + ';"></div></div></div>';
      }).join("");

      // One row per incident — the closest surveyed record from each storm day.
      const byIncident = new Map();
      all.filter(x => (x.properties || {}).__dist != null).forEach(x => {
        const p = x.properties;
        const key = (p.event_id || "") + "|" + fmtDay(p.stormdate);
        const prev = byIncident.get(key);
        if (!prev || p.__dist < prev.properties.__dist) byIncident.set(key, x);
      });
      const near = [...byIncident.values()].sort((a, b) => a.properties.__dist - b.properties.__dist).slice(0, 6);
      this.renderRose(vis[1]);
      this.renderSeason(all);
      this.q("[data-notable]").innerHTML = near.length ? near.map((x, i) => {
        const p = x.properties;
        return '<div data-oid="' + esc(p.objectid) + '" style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid ' + HAIR + ';cursor:pointer;">'
          + '<span style="font-size:11px;font-weight:800;color:' + MUTED + ';font-variant-numeric:tabular-nums;">' + (i + 1) + "</span>"
          + '<span><span style="font-size:12px;font-weight:700;display:block;">' + esc(surveyLabel(p)) + "</span>"
          + '<span style="font-size:11px;color:' + MUTED + ';">' + fmtDay(p.stormdate) + (p.efscale ? " · " + esc(p.efscale) : "") + "</span></span>"
          + '<span style="font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;color:' + DEEPRED + ';">' + p.__dist.toFixed(1) + " mi</span></div>";
      }).join("") : '<div style="font-size:12px;color:' + MUTED + ';">No mapped records in this search.</div>';
    }

    zoomToDatRecord(oid) {
      DAT_LAYERS.forEach(cfg => {
        this.datLayers[cfg.id].eachLayer(layer => {
          const p = layer.feature && layer.feature.properties;
          if (!p || String(p.objectid) !== String(oid)) return;
          const b = layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng(), layer.getLatLng()]);
          this.map.fitBounds(b, { padding: [60, 60], maxZoom: 13 });
          this.showDatDetail(cfg, p);
        });
      });
    }

    togglePlay() {
      const btn = this.q("[data-play]");
      if (this.playTimer) {
        clearInterval(this.playTimer); this.playTimer = null;
        btn.textContent = "▶ Play years";
        btn.style.background = "transparent"; btn.style.color = INK;
        return;
      }
      const years = this.datYears || [];
      if (years.length < 2) return;
      let i = 0;
      btn.textContent = "■ Stop";
      btn.style.background = INK; btn.style.color = GROUND;
      const step = () => {
        this.datFacet.year = years[i];
        this.applyDatFacets(false);
        i = (i + 1) % years.length;
      };
      step();
      this.playTimer = setInterval(step, 900);
    }

    runPreset(kind) {
      const set = (sel, v) => { this.q(sel).value = v; };
      set("[data-dat-event]", ""); set("[data-dat-county]", "");
      const iso = d => new Date(d).toISOString().slice(0, 10);
      if (kind === "campus") {
        set("[data-dat-radius]", "25"); set("[data-dat-from]", ""); set("[data-dat-to]", "");
      } else if (kind === "region") {
        set("[data-dat-radius]", "100");
        set("[data-dat-from]", iso(Date.now() - 3650 * 86400000)); set("[data-dat-to]", "");
      } else {
        set("[data-dat-radius]", "");
        set("[data-dat-from]", iso(Date.now() - 30 * 86400000)); set("[data-dat-to]", "");
      }
      this.runDatQuery();
    }

    renderDatLegend(results) {
      const box = this.q("[data-dat-legend]");
      const rows = [];
      DAT_LAYERS.forEach(cfg => {
        const feats = results[cfg.id] || [];
        if (!feats.length) return;
        const r = (this.datRenderers || {})[cfg.id];
        const seen = new Map();
        feats.forEach(f => {
          const key = r && r.field1 ? String((f.properties || {})[r.field1] ?? "N/A") : cfg.name;
          if (!seen.has(key)) seen.set(key, { sym: this.datSymbol(cfg, f.properties || {}), n: 0 });
          seen.get(key).n++;
        });
        rows.push('<div style="' + label("margin-top:4px;") + '">' + esc(cfg.name) + "</div>");
        [...seen.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([key, v]) => {
          rows.push('<div style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;">'
            + this.datSwatch(cfg, v.sym) + '<span style="flex:1;">' + esc(key) + '</span>'
            + '<span style="font-variant-numeric:tabular-nums;color:' + MUTED + ';">' + v.n + "</span></div>");
        });
      });
      box.innerHTML = rows.join("");
    }

    datSwatch(cfg, sym) {
      if (sym && sym.type === "esriPMS" && sym.imageData) {
        return '<img src="data:' + (sym.contentType || "image/png") + ";base64," + sym.imageData + '" style="width:14px;height:14px;object-fit:contain;" alt="">';
      }
      if (cfg.geom === "line") {
        return '<span style="width:14px;height:3px;background:' + esriColor(sym && sym.color, INK) + ';"></span>';
      }
      return '<span style="width:14px;height:10px;background:' + esriColor(sym && sym.color, INK)
        + ";border:1px solid " + esriColor(sym && sym.outline && sym.outline.color, INK) + ';"></span>';
    }

    showDatDetail(cfg, props) {
      const p = props || {};
      this.q("[data-detail]").style.display = "block";
      this.q("[data-forecast-section]").style.display = "none";
      const named = !!(p.event_id || p.damage_txt);
      this.q("[data-detail-title]").textContent = surveyLabel(p) + (named && p.efscale ? " · " + p.efscale : "");

      const skip = new Set(["objectid", "globalid", "shape__length", "shape__area", "path_guid", "device_id", "image", "edit_user", "created_user", "last_edited_user"]);
      const dateFields = new Set(["stormdate", "surveydate", "starttime", "endtime", "edit_time", "created_date", "last_edited_date"]);
      const rows = Object.keys(p).filter(k => !skip.has(k.toLowerCase())).map(k => {
        let v = p[k];
        if (v == null || v === "" || v === -99) return "";
        if (dateFields.has(k.toLowerCase())) {
          const d = validDate(v);
          if (!d) return "";
          v = d.toLocaleString("en-US", { timeZone: CAMPUS_TZ, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") + " " + campusAbbr(d.toISOString());
        }
        return '<div style="display:grid;grid-template-columns:120px 1fr;gap:10px;padding:5px 0;border-bottom:1px solid ' + HAIR + ';">'
          + '<span style="' + label() + '">' + esc(k) + "</span>"
          + '<span style="font-size:12px;font-weight:600;word-break:break-word;">' + esc(v) + "</span></div>";
      }).join("");

      this.q("[data-detail-body]").innerHTML =
        '<div style="' + label("margin-bottom:10px;") + '">NWS Damage Assessment Toolkit · ' + esc(cfg.name) + " · preliminary</div>" + rows;
      this.q("[data-coords]").textContent = "DAT survey record";
    }

    decodeAlertDetail(props) {
      this.q("[data-detail]").style.display = "block";
      this.q("[data-forecast-section]").style.display = "none";
      this.q("[data-detail-title]").textContent = props.event;

      // CAP gives ISO timestamps with the issuing office's UTC offset. Convert to
      // campus time for comparability and keep the office's own reading beside it.
      const endsIso = props.ends || props.expires;
      const sentCampus = fmtCampus(props.sent, true);
      const endsCampus = endsIso ? fmtCampus(endsIso, true) : "—";
      const sentOffice = fmtAsIssued(props.sent);
      const endsOffice = endsIso ? fmtAsIssued(endsIso) : null;
      const sentOff = isoOffsetMinutes(props.sent);
      const campusOff = campusOffsetMinutes(props.sent);
      const foreignZone = sentOff !== null && campusOff !== null && sentOff !== campusOff;
      const expiresRel = endsIso ? relativeTo(endsIso) : "";

      const cell = (t, v, tone) => '<div style="border:2px solid ' + RULE + ';padding:10px;">'
        + '<div style="' + label("margin-bottom:4px;") + '">' + t + "</div>"
        + '<div style="font-size:12px;font-weight:700;color:' + tone + ';">' + esc(v) + "</div></div>";

      this.q("[data-detail-body]").innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">'
        + cell("Issued · campus time", sentCampus, INK)
        + cell("Expires · campus time", endsCampus + (expiresRel ? " (" + expiresRel + ")" : ""), DEEPRED)
        + "</div>"
        + (foreignZone
            ? '<div style="border:2px solid ' + RULE + ';padding:10px;margin-bottom:14px;background:' + SURFACE + ';">'
              + '<div style="' + label("margin-bottom:4px;") + '">Issued outside campus time zone</div>'
              + '<div style="font-size:12px;line-height:1.5;">Issuing office local time: ' + esc(sentOffice || "—")
              + (endsOffice ? ' · expires ' + esc(endsOffice) : "")
              + '. Times above are shown in ' + esc(campusAbbr(props.sent)) + '.</div></div>'
            : '<div style="' + label("margin-bottom:14px;") + '">Issued in campus time zone (' + esc(campusAbbr(props.sent)) + ')</div>')
        + '<div style="font-weight:800;font-size:13px;line-height:1.35;margin-bottom:10px;">' + esc(props.headline || "") + "</div>"
        + '<div style="white-space:pre-wrap;color:#444141;">' + esc(props.description || "NWS gave no details for this alert.") + "</div>"
        + (props.instruction ? '<div style="margin-top:14px;border-top:2px solid ' + RULE + ';padding-top:12px;"><b>Instructions:</b><br>' + esc(props.instruction) + "</div>" : "");
    }
  }

  if (!window.customElements.get("weather-monitor")) window.customElements.define("weather-monitor", WeatherMonitor);
})();

/**
 * WashU EM dashboard — feed proxy (Cloudflare Worker)
 *
 * Purpose: hold API keys server-side and add CORS headers, so the GitHub Pages
 * dashboard can read feeds that the browser cannot fetch directly.
 *
 * Routes (all return JSON, all CORS-open to ALLOWED_ORIGINS):
 *   /airnow      EPA AirNow current observation (official AQI)     [needs AIRNOW_KEY]
 *   /ahps        NOAA NWPS gauge + flood-stage thresholds          [no key]
 *   /modot       MoDOT traveler information incidents              [needs MODOT_KEY]
 *   /modot-legend    MoDOT RoadConditions legend (CORS shim)       [no key]
 *   /modot-identify  MoDOT RoadConditions identify at a point      [no key]
 *   /bluesky     Bluesky public post search, geo/keyword           [no key]
 *   /reddit      r/StLouis new posts                               [needs REDDIT_* app creds]
 *   /health      which routes are configured
 *
 * Deploy: see the walkthrough. Secrets go in `wrangler secret put NAME`,
 * never in this file.
 */

// CORS is open because it protects nothing here. API keys live in Worker secrets
// and never leave the server: an allowlist only decides which *browsers* may read
// the already-sanitised JSON, and getting it wrong (the default placeholder did)
// makes every route fail with an unexplained "Failed to fetch". Rate limiting or
// Cloudflare Access is the right control if these routes ever need protecting.
const ALLOW_ORIGIN = "*";

const CAMPUS = { lat: 38.6488, lon: -90.3108 };
const CACHE_SECONDS = 120;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "public, max-age=" + CACHE_SECONDS
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    try {
      switch (url.pathname.replace(/\/$/, "")) {
        case "/health":
          return json({
            ok: true,
            cors: "open",
            routes: {
              airnow: !!env.AIRNOW_KEY,
              ahps: true,
              modot: !!env.MODOT_KEY,
              bluesky: true,
              reddit: !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)
            }
          });

        /* ---- EPA AirNow: official AQI, the regulatory number ---- */
        case "/airnow": {
          if (!env.AIRNOW_KEY) return json({ error: "AIRNOW_KEY not set" }, 501);
          const q = new URL("https://www.airnowapi.org/aq/observation/latLong/current/");
          q.search = new URLSearchParams({
            format: "application/json",
            latitude: String(CAMPUS.lat),
            longitude: String(CAMPUS.lon),
            distance: "25",
            API_KEY: env.AIRNOW_KEY
          }).toString();
          const r = await fetch(q, { cf: { cacheTtl: CACHE_SECONDS } });
          if (!r.ok) return json({ error: "airnow " + r.status }, 502);
          const rows = await r.json();
          return json({
            source: "EPA AirNow",
            observed: rows[0] && rows[0].DateObserved + " " + rows[0].HourObserved + ":00 " + rows[0].LocalTimeZone,
            parameters: rows.map(x => ({
              parameter: x.ParameterName,
              aqi: x.AQI,
              category: x.Category && x.Category.Name,
              reportingArea: x.ReportingArea
            }))
          });
        }

        /* ---- NOAA NWPS: river stage WITH action/flood thresholds ---- */
        case "/ahps": {
          const gauge = url.searchParams.get("gauge") || "eadm7"; // St. Louis, Mississippi R.
          const r = await fetch("https://api.water.noaa.gov/nwps/v1/gauges/" + encodeURIComponent(gauge), {
            cf: { cacheTtl: CACHE_SECONDS }
          });
          if (!r.ok) return json({ error: "nwps " + r.status }, 502);
          const g = await r.json();
          const fl = g.flood || {};
          return json({
            source: "NOAA National Water Prediction Service",
            gauge: g.lid,
            name: g.name,
            observed: g.status && g.status.observed,
            forecast: g.status && g.status.forecast,
            thresholds: {
              action: fl.categories && fl.categories.action && fl.categories.action.stage,
              minor: fl.categories && fl.categories.minor && fl.categories.minor.stage,
              moderate: fl.categories && fl.categories.moderate && fl.categories.moderate.stage,
              major: fl.categories && fl.categories.major && fl.categories.major.stage
            }
          });
        }

        /* ---- MoDOT traveler information: roadway incidents ---- */
        case "/modot": {
          if (!env.MODOT_KEY) return json({ error: "MODOT_KEY not set" }, 501);
          const r = await fetch(env.MODOT_URL || "https://data.modot.mo.gov/api/incidents", {
            headers: { Authorization: "Bearer " + env.MODOT_KEY },
            cf: { cacheTtl: CACHE_SECONDS }
          });
          if (!r.ok) return json({ error: "modot " + r.status }, 502);
          return json({ source: "MoDOT traveler information", data: await r.json() });
        }

        /* ---- MoDOT RoadConditions: CORS shim. The host sends no CORS headers, so
               the dashboard cannot read its legend or run identify directly. ---- */
        case "/modot-legend": {
          const r = await fetch("https://mapping.modot.org/arcgis/rest/services/TravelerInformation/RoadConditions/MapServer/legend?f=json", { cf: { cacheTtl: 3600 } });
          if (!r.ok) return json({ error: "modot legend " + r.status }, 502);
          return json(await r.json());
        }

        case "/modot-identify": {
          const p = url.searchParams;
          const q = new URLSearchParams({
            geometry: p.get("geometry") || "",            // "lon,lat"
            geometryType: "esriGeometryPoint",
            sr: "4326",
            tolerance: p.get("tolerance") || "6",
            mapExtent: p.get("mapExtent") || "",
            imageDisplay: p.get("imageDisplay") || "800,600,96",
            layers: "all",
            returnGeometry: "false",
            f: "json"
          });
          const r = await fetch("https://mapping.modot.org/arcgis/rest/services/TravelerInformation/RoadConditions/MapServer/identify?" + q, { cf: { cacheTtl: 30 } });
          if (!r.ok) return json({ error: "modot identify " + r.status }, 502);
          return json(await r.json());
        }

        /* ---- Bluesky: free, no key, useful for geo/keyword chatter ---- */
        case "/bluesky": {
          const q = url.searchParams.get("q") || "\"St. Louis\" (tornado OR flooding OR outage OR evacuation)";
          const r = await fetch(
            "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?limit=25&sort=latest&q=" + encodeURIComponent(q),
            { cf: { cacheTtl: 60 } }
          );
          if (!r.ok) return json({ error: "bluesky " + r.status }, 502);
          const d = await r.json();
          return json({
            source: "Bluesky public search",
            query: q,
            posts: (d.posts || []).map(p => ({
              text: p.record && p.record.text,
              author: p.author && p.author.handle,
              createdAt: p.record && p.record.createdAt,
              likes: p.likeCount,
              uri: p.uri
            }))
          });
        }

        /* ---- Reddit: needs an app registration (script type, client credentials) ---- */
        case "/reddit": {
          if (!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)) return json({ error: "REDDIT credentials not set" }, 501);
          const tok = await fetch("https://www.reddit.com/api/v1/access_token", {
            method: "POST",
            headers: {
              Authorization: "Basic " + btoa(env.REDDIT_CLIENT_ID + ":" + env.REDDIT_CLIENT_SECRET),
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "washu-em-dashboard/1.0"
            },
            body: "grant_type=client_credentials"
          });
          if (!tok.ok) return json({ error: "reddit auth " + tok.status }, 502);
          const { access_token } = await tok.json();
          const sub = url.searchParams.get("sub") || "StLouis";
          const r = await fetch("https://oauth.reddit.com/r/" + sub + "/new?limit=25", {
            headers: { Authorization: "Bearer " + access_token, "User-Agent": "washu-em-dashboard/1.0" }
          });
          if (!r.ok) return json({ error: "reddit " + r.status }, 502);
          const d = await r.json();
          return json({
            source: "Reddit r/" + sub,
            posts: (d.data.children || []).map(c => ({
              title: c.data.title, author: c.data.author, created: c.data.created_utc,
              score: c.data.score, comments: c.data.num_comments, url: "https://reddit.com" + c.data.permalink
            }))
          });
        }

        default:
          return json({ error: "unknown route", try: ["/health", "/airnow", "/ahps", "/modot", "/modot-legend", "/modot-identify", "/bluesky", "/reddit"] }, 404);
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

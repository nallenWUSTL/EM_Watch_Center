/* Deployment settings for the EOC Watch Desk dashboard.

   Every value here is delivered to the browser, so nothing secret belongs in
   this file. The CARTO basemap key is a public, domain-restricted client key;
   keyed feeds (AirNow, MoDOT, Reddit) stay in the Cloudflare Worker as
   `wrangler secret`s and never appear here. */
window.WUEM_CONFIG = {
  // CARTO raster basemap key (carto.com/basemaps/apikey). Without it CARTO
  // stamps an "API key required" watermark on the tiles. Leave empty to load
  // keyless tiles.
  cartoKey: "cb1_2v33_1_c6e658f8a62965c4fbbd89a9",

  // Default origin of the dashboard Worker (workers/ameren-outage-worker),
  // which serves /ameren, /metro, /localnews, /crashes, /healthnews,
  // /cybernews and /ransomware. Managed WashU devices block *.workers.dev, so
  // point this at a custom domain once one is bound to the Worker. A desk can
  // also override it per browser from the Proxy origin field on the Outages tab.
  workerOrigin: "https://washu-em-ameren.washu-em.workers.dev",

  // Radius around Brookings Hall for the Ameren outage ring, in miles (2–30).
  ringRadiusMiles: 10,

  // Point queries for NWS alerts, the hourly forecast and air quality.
  campuses: {
    danforth: { lat: 38.6488, lon: -90.3108, name: "Danforth Campus" },
    medical: { lat: 38.6362, lon: -90.2636, name: "Medical Campus" }
  }
};

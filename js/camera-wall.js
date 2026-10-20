/* The pop-out camera wall (wall.html). Every MoDOT camera within 3 miles of
   the nearer campus, each listed once, all playing, sized so the whole wall
   fits the window without scrolling where the count allows. Feed diagnostics
   come from the Roads module (window.WUEM.roads.watchFeed), so a dead camera
   reads the same here as on the dashboard. */
(function () {
  const R = window.WUEM && window.WUEM.roads;
  const grid = document.querySelector("[data-grid]");
  const sub = document.querySelector("[data-sub]");
  if (!R || !grid) return;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const danforth = R.SITES[0];
  let cams = [];        // the wall, in display order
  let tiles = {};       // index -> { hls, feed, state }
  let loadError = null;

  async function loadCameras() {
    const d = 0.12;
    const env = [danforth.coord[1] - d, danforth.coord[0] - d, danforth.coord[1] + d, danforth.coord[0] + d].join(",");
    const url = R.CAMERAS_URL + "/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true&inSR=4326&outSR=4326"
      + "&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&geometry=" + encodeURIComponent(env);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("MoDOT camera layer answered HTTP " + res.status);
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
      R.SITES.forEach(s => { bySite[s.key] = to(s.coord); });
      const site = R.SITES.slice().sort((a, b) => bySite[a.key] - bySite[b.key])[0];
      const url = [p.URL2, p.URL1].find(R.isStreamUrl);
      return { props: p, site: site, miles: bySite[site.key], url: url, offline: String(p.STREAM_ERROR || "").toUpperCase() === "Y" };
    }).filter(x => x && !x.offline && x.url && x.miles <= R.WALL_RADIUS_MI);
    // Each camera once, under its nearer campus, nearest first.
    const order = {}; R.SITES.forEach((s, i) => { order[s.key] = i; });
    items.sort((a, b) => order[a.site.key] - order[b.site.key] || a.miles - b.miles);
    return items;
  }

  function render() {
    grid.innerHTML = cams.map((c, i) => '<div class="tile" data-tile="' + i + '">'
      + '<video data-video="' + i + '" muted playsinline></video>'
      + '<span class="badge" data-badge="' + i + '"></span>'
      + '<button type="button" class="retry" data-retry="' + i + '">▶ Play feed</button>'
      + '<div class="tile-label"><span class="tile-name">' + esc(R.titleCase(c.props.DESCRIPTION || "Camera")) + "</span>"
      + "<span>" + esc(c.site.label.split(" · ")[0]) + " · " + c.miles + " mi</span></div>"
      + "</div>").join("");
    fit();
    status();
  }

  /* Fill the window in both directions. Each column count is scored by the
     video it actually shows: cell area, less what a 16:9 picture loses to
     cropping when the cell is not 16:9, less the empty cells of a short last
     row. The best score wins; rows then stretch to the full height and the
     video covers its cell, so the only black left is in an incomplete row. */
  function fit() {
    const n = cams.length;
    if (!n) return;
    const GAP = 2;
    const W = grid.clientWidth - 2 * GAP, H = grid.clientHeight - 2 * GAP;
    let best = { cols: 1, rows: n, score: -1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (W - (cols - 1) * GAP) / cols, ch = (H - (rows - 1) * GAP) / rows;
      if (cw <= 0 || ch <= 0) continue;
      const ratio = (cw / ch) / (16 / 9);
      const kept = ratio >= 1 ? 1 / ratio : ratio;   // share of the picture that survives the crop
      const score = n * cw * ch * kept;
      if (score > best.score) best = { cols: cols, rows: rows, score: score };
    }
    grid.style.gridTemplateColumns = "repeat(" + best.cols + ", minmax(0, 1fr))";
    grid.style.gridTemplateRows = "repeat(" + best.rows + ", minmax(0, 1fr))";
  }

  function status() {
    const dead = Object.values(tiles).filter(t => /^(stale|timeout|failed|decode|stopped)$/.test(t.state)).length;
    const live = Object.values(tiles).filter(t => t.state === "live").length;
    sub.textContent = loadError ? loadError
      : cams.length + " feeds within " + R.WALL_RADIUS_MI + " miles · " + R.SITES.map(s => s.label.split(" · ")[0] + " " + cams.filter(c => c.site.key === s.key).length).join(" · ")
        + (live ? " · " + live + " live" : "") + (dead ? " · " + dead + " not updating" : "");
  }

  function setBadge(i, state, text) {
    const badge = grid.querySelector('[data-badge="' + i + '"]');
    const retry = grid.querySelector('[data-retry="' + i + '"]');
    const t = tiles[i] || (tiles[i] = {});
    t.state = state;
    const bad = /^(stale|failed|decode|timeout|stopped)$/.test(state);
    if (badge) {
      badge.style.display = state !== "idle" && state !== "live" && !bad ? "inline-block" : "none";
      badge.textContent = text || "";
      badge.classList.toggle("is-bad", bad);
    }
    if (retry) {
      retry.style.display = state === "idle" || bad ? "flex" : "none";
      retry.textContent = state === "idle" ? "▶ Play feed" : (text || "Feed unavailable") + " · retry";
    }
    status();
  }

  function play(i) {
    const c = cams[i];
    const video = grid.querySelector('[data-video="' + i + '"]');
    if (!c || !video) return;
    stop(i, "connecting");
    if (!(window.Hls && window.Hls.isSupported())) {
      video.src = c.url; video.play().catch(() => {}); setBadge(i, "live", "Live"); return;
    }
    const hls = new window.Hls(R.WALL_HLS_CONFIG);
    tiles[i].hls = hls;
    tiles[i].feed = R.watchFeed(hls, video, c.url, (state, text) => {
      setBadge(i, state, text);
      if (/^(stale|failed|decode|timeout|stopped)$/.test(state)) { tiles[i].feed = null; hls.destroy(); tiles[i].hls = null; }
    });
    setBadge(i, "connecting", "Connecting…");
  }

  function stop(i, state) {
    const t = tiles[i] || (tiles[i] = {});
    if (t.feed) { t.feed.stop(); t.feed = null; }
    if (t.hls) { t.hls.destroy(); t.hls = null; }
    const v = grid.querySelector('[data-video="' + i + '"]');
    if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
    setBadge(i, state || "idle");
  }

  const playAll = () => cams.forEach((c, i) => play(i));
  const stopAll = () => cams.forEach((c, i) => stop(i, "idle"));

  async function boot() {
    stopAll();
    tiles = {};
    loadError = null;
    sub.textContent = "Loading cameras…";
    try {
      cams = await loadCameras();
      if (!cams.length) { grid.innerHTML = '<div class="empty"><strong>No cameras returned</strong> within ' + R.WALL_RADIUS_MI + " miles. Reload to try again.</div>"; status(); return; }
      render();
      playAll();
    } catch (e) {
      cams = [];
      loadError = "Camera list unavailable. " + (e && e.message ? e.message : String(e));
      grid.innerHTML = '<div class="empty"><strong>Camera list unavailable.</strong> ' + esc(e && e.message ? e.message : String(e)) + " Reload to try again.</div>";
      status();
    }
  }

  document.querySelector("[data-play]").onclick = playAll;
  document.querySelector("[data-stop]").onclick = stopAll;
  document.querySelector("[data-reload]").onclick = boot;
  document.querySelector("[data-fullscreen]").onclick = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  };
  document.addEventListener("fullscreenchange", () => {
    document.querySelector("[data-fullscreen]").textContent = document.fullscreenElement ? "⤡ Exit full screen" : "⤢ Full screen";
    fit();
  });
  grid.addEventListener("click", e => {
    const b = e.target.closest("[data-retry]");
    if (b) play(Number(b.getAttribute("data-retry")));
  });
  window.addEventListener("resize", fit);

  const clock = document.querySelector("[data-clock]");
  const tick = () => { try { clock.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }); } catch (e) {} };
  tick(); setInterval(tick, 15000);

  boot();
})();

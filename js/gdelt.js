/* Open-source news scanners for the All-Hazards view: GDELT Web NGrams (rolling
   24 h, quadgram co-occurrence) and GDELT GKG 2.0 thematic classification.
   Both read CORS-open Cloud Storage objects directly, so no proxy is needed. */
(function () {
  const W = (window.WUEM = window.WUEM || {});

  // GDELT asked researchers to stop hitting the DOC API and use the minute-level
  // Web NGrams dataset instead (blog.gdeltproject.org, 30 Jun 2026). Each minute
  // publishes a quadgram histogram plus a TOC of article ids, titles and URLs.
  // We scan the TOC titles always, and optionally stream the quadgram file to
  // catch body mentions, cross-referencing DOCIDs back to the TOC.
  async function newsScan(deep) {
    const BASE = "https://storage.googleapis.com/data.gdeltproject.org/gdeltv5/weblegacy/ngrams/";
    const pad = n => String(n).padStart(2, "0");
    const stampAt = d => "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00";

    // Files publish on a 15-minute heartbeat at fixed clock minutes, for a few
    // consecutive minutes each. Sampling by a fixed offset keeps the same phase
    // mod 15 and can miss every file, so align to the quarter hour and try the
    // first few minutes of each one, newest first.
    const quarterStart = Math.floor((Date.now() - 4 * 60000) / (15 * 60000)) * (15 * 60000);
    const quarters = [];
    for (let i = 0; i < 96; i++) quarters.push(quarterStart - i * 15 * 60000);

    const tocs = [];
    const MAX_FILES = 26, BATCH = 3;
    const tryQuarter = async q => {
      for (let m = 0; m < 3; m++) {
        const s = stampAt(new Date(q + m * 60000));
        try {
          const r = await fetch(BASE + s + ".toc.json.gz", { signal: AbortSignal.timeout(10000) });
          if (!r.ok) continue;
          return { stamp: s, text: await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text() };
        } catch (e) { /* next minute */ }
      }
      return null;
    };
    for (let i = 0; i < quarters.length && tocs.length < MAX_FILES; i += BATCH) {
      const got = await Promise.all(quarters.slice(i, i + BATCH).map(tryQuarter));
      got.filter(Boolean).forEach(t => tocs.push(t));
    }
    if (!tocs.length) return { error: "GDELT published no news files in the last 24 hours." };
    tocs.sort((a, b) => b.stamp.localeCompare(a.stamp));
    const stamp = tocs[0].stamp;
    const tocText = tocs.map(t => t.text).join("\n");

    const docs = new Map();
    const latestIds = new Map(); // DOCIDs are only meaningful within their own minute
    const stampIso = stamp.slice(0, 4) + "-" + stamp.slice(4, 6) + "-" + stamp.slice(6, 8) + "T" + stamp.slice(8, 10) + ":" + stamp.slice(10, 12);
    tocText.split("\n").forEach(line => {
      if (!line) return;
      try {
        const d = JSON.parse(line);
        if (d.lang && d.lang !== "en") return;
        if (!d.url || docs.has(d.url)) return;
        docs.set(d.url, { id: d.ID, title: d.title || "", url: d.url, date: d.date, hits: 0, where: [] });
        if (d.date && d.date.slice(0, 16) === stampIso) latestIds.set(d.ID, d.url);
      } catch (e) {}
    });

    const PLACE = /\b(st\.? ?louis|saint louis)\b/i;
    const MN = /\b(duluth|boundary waters|carlton county|hibbing|iron range|minnesota|two harbors|virginia mn)\b/i;
    const HAZARD = /\b(tornado|flood|flooding|storm|hail|evacuat\w*|outage|wildfire|hazmat|lockdown|standoff|derail\w*|shooting|shooter|protest\w*|emergency|closure|road closed|water main|gas leak|heat advisory|boil order)\b/i;
    const OTHER_WASH = /\b((eastern|central|western|george) washington university|washington state university|university of washington|washington univ(ersity)? of)\b/i;
    const CAMPUS_STRICT = /\b(washu|wustl|barnes[- ]jewish|siteman|danforth campus|washington university in st\.? ?louis)\b/i;
    const CAMPUS_LOOSE = /\bwashington university\b/i;
    const isCampus = t => CAMPUS_STRICT.test(t) || (CAMPUS_LOOSE.test(t) && !OTHER_WASH.test(t));
    const NEARBY = /\b(delmar loop|forest park|central west end|university city|clayton, ?mo|skinker|debaliviere|the loop)\b/i;
    const PHRASE = /\b(tornado (warning|watch|touchdown)|flash flood|shelter in place|state of emergency|boil (order|advisory)|power outage|water main break|active shooter|mass casualty|hazmat (spill|incident)|building collapse|shots fired|evacuation order|heat emergency)\b/i;

    // Title pass — cheap, always runs.
    docs.forEach(d => {
      if (MN.test(d.title)) { d.excluded = true; return; }
      if (PLACE.test(d.title) && (HAZARD.test(d.title) || PHRASE.test(d.title))) { d.hits += 12; d.where.push("hazard headline"); }
      else if (isCampus(d.title)) { d.hits += 10; d.where.push("campus mention"); }
      else if (NEARBY.test(d.title) && (HAZARD.test(d.title) || PHRASE.test(d.title))) { d.hits += 7; d.where.push("adjacent neighbourhood + hazard"); }
    });

    let scannedBytes = 0, partial = false, quadgramHits = 0;
    if (deep) {
      try {
        const r = await fetch(BASE + stamp + ".ngrams.txt.gz", { signal: AbortSignal.timeout(45000) });
        if (r.ok) {
          const reader = r.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
          const strong = new Map();   // place AND hazard inside one quadgram
          const phrase = new Map();   // unambiguous hazard phrase on its own
          const placeOnly = new Map();
          const campus = new Map();
          const otherWash = new Set(); // Eastern/Central/State etc., seen anywhere in the doc
          let tail = "";
          const CAP = 45 * 1024 * 1024;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            scannedBytes += value.length;
            const lines = (tail + value).split("\n");
            tail = lines.pop();
            for (const line of lines) {
              const tab1 = line.indexOf("\t");
              if (tab1 < 0) continue;
              const tab2 = line.indexOf("\t", tab1 + 1);
              const id = +line.slice(0, tab1);
              const gram = line.slice(tab1 + 1, tab2 < 0 ? undefined : tab2);
              const url = latestIds.get(id);
              if (!url) continue;
              if (MN.test(gram)) { const d = docs.get(url); if (d) d.excluded = true; continue; }
              const hasPlace = PLACE.test(gram);
              if (OTHER_WASH.test(gram)) { otherWash.add(url); campus.delete(url); continue; }
              if (isCampus(gram)) { if (!otherWash.has(url)) campus.set(url, (campus.get(url) || 0) + 1); continue; }
              if (NEARBY.test(gram) && HAZARD.test(gram)) { strong.set(url, (strong.get(url) || 0) + 1); continue; }
              if (hasPlace && HAZARD.test(gram)) { strong.set(url, (strong.get(url) || 0) + 1); continue; }
              if (PHRASE.test(gram)) { phrase.set(url, (phrase.get(url) || 0) + 1); continue; }
              if (hasPlace) placeOnly.set(url, (placeOnly.get(url) || 0) + 1);
            }
            if (scannedBytes > CAP) { partial = true; await reader.cancel(); break; }
          }
          docs.forEach((d, key) => {
            if (d.excluded) return;
            const sc = strong.get(key) || 0;
            const ph = phrase.get(key) || 0;
            const pl = placeOnly.get(key) || 0;
            // A document qualifies only on co-occurrence, or on an unambiguous
            // hazard phrase in an article that also names the place.
            if (sc) {
              d.hits += 10 * Math.min(sc, 5);
              d.where.push(sc + " co-occurring quadgram" + (sc === 1 ? "" : "s"));
              quadgramHits++;
            } else if (ph && (pl || PLACE.test(d.title))) {
              d.hits += 4 * Math.min(ph, 4);
              d.where.push(ph + " hazard phrase" + (ph === 1 ? "" : "s") + " + place");
              quadgramHits++;
            } else if (campus.get(key) >= 2 && !otherWash.has(key)) {
              const cc = campus.get(key);
              d.hits += 3 * Math.min(cc, 4);
              d.where.push(cc + " campus quadgram" + (cc === 1 ? "" : "s"));
              quadgramHits++;
            }
          });
        }
      } catch (e) { partial = true; }
    }

    const CUTOFF = Date.now() - 24 * 3600 * 1000;
    const STORE = "wuem-news-24h-v3"; // bumped when matching rules change
    let retained = {};
    try { retained = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (e) { retained = {}; }
    [...docs.values()].filter(d => !d.excluded && d.hits > 0).forEach(d => {
      const prev = retained[d.url];
      if (!prev || d.hits > prev.hits) retained[d.url] = { title: d.title, date: d.date, hits: d.hits, where: d.where };
    });
    Object.keys(retained).forEach(url => {
      const t = Date.parse(retained[url].date);
      if (!isNaN(t) && t < CUTOFF) delete retained[url];
    });
    try { localStorage.setItem(STORE, JSON.stringify(retained)); } catch (e) {}

    const articles = Object.entries(retained)
      .map(([url, v]) => ({ url, title: v.title, date: v.date, hits: v.hits, where: v.where || [] }))
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.hits - a.hits)
      .slice(0, 12);

    return {
      stamp, articles,
      minutes: tocs.length,
      window: "24 h rolling",
      retained: Object.keys(retained).length,
      corpus: docs.size,
      deep: !!deep,
      partial,
      quadgramHits,
      scannedMB: scannedBytes ? (scannedBytes / 1048576).toFixed(1) : null
    };
  }


  // GDELT GKG 2.0 — a 15-minute file of themes, tone and geocoded locations per
  // article. The zips are plain Cloud Storage objects (CORS-open) and are
  // inflated here with deflate-raw after reading the exact compressed length out
  // of the zip's central directory; the archive's trailing bytes break a naive
  // stream. Gives thematic classification the ngrams histogram cannot.
  function gkgThemeLabel(code) {
    const map = {
      NATURAL_DISASTER: "Natural disaster", MANMADE_DISASTER: "Man-made disaster",
      EVACUATION: "Evacuation", DISPLACED: "Displacement", POWER_OUTAGE: "Power outage",
      TERROR: "Terrorism", ARMEDCONFLICT: "Armed conflict", PROTEST: "Protest",
      KILL: "Fatalities", WOUND: "Injuries", KILL_IMPLIED: "Fatalities", DISEASE: "Disease", EPIDEMIC: "Epidemic",
      SHORTAGE: "Shortage", FIRE: "Fire",
      CRISISLEX_T03_DEAD: "Fatalities", CRISISLEX_T01_CAUTION_ADVICE: "Caution or advice",
      CRISISLEX_C07_SAFETY: "Safety", CRISISLEX_O01_WEATHER: "Weather",
      CRISISLEX_T11_UPDATESSYMPATHY: "Updates", CRISISLEX_C03_WELLBEING_HEALTH: "Wellbeing"
    };
    if (map[code]) return map[code];
    if (code === "MANMADE_DISASTER_IMPLIED") return "Man-made disaster (implied)";
    if (code === "NATURAL_DISASTER_IMPLIED") return "Natural disaster (implied)";
    if (/^KILL/.test(code)) return "Fatalities";
    if (/^WOUND/.test(code)) return "Injuries";
    let c = code.replace(/^CRISISLEX_[A-Z0-9]+_/, "").replace(/^TAX_[A-Z]+_/, "").replace(/^WB_\d+_/, "").replace(/^EPU_[A-Z]+_/, "");
    c = c.replace(/^NATURAL_DISASTER_/, "").replace(/^MANMADE_DISASTER_/, "").replace(/^UNGP_/, "");
    return c.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
  }

  async function gkgScan() {
    const GCS = "https://storage.googleapis.com/data.gdeltproject.org/gdeltv2/";
    let latest = null;
    try {
      const lu = await (await fetch(GCS + "lastupdate.txt", { signal: AbortSignal.timeout(12000) })).text();
      latest = (lu.match(/(\d{14})\.export\.CSV\.zip/) || [])[1];
    } catch (e) { return { error: "GDELT not reachable" }; }
    if (!latest) return { error: "GDELT did not give a current file time." };

    // Walk back in 15-minute steps from the published stamp.
    const stamps = [];
    const y = +latest.slice(0, 4), mo = +latest.slice(4, 6) - 1, d = +latest.slice(6, 8);
    const hh = +latest.slice(8, 10), mi = +latest.slice(10, 12);
    let cur = Date.UTC(y, mo, d, hh, mi, 0);
    const pad = n => String(n).padStart(2, "0");
    for (let i = 0; i < 4; i++) {
      const t = new Date(cur - i * 15 * 60000);
      stamps.push("" + t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate()) + pad(t.getUTCHours()) + pad(t.getUTCMinutes()) + "00");
    }

    const unzipFirst = async buf => {
      const u8 = new Uint8Array(buf), dv = new DataView(buf);
      let eocd = -1;
      for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw new Error("no central directory");
      const cd = dv.getUint32(eocd + 16, true);
      const compSize = dv.getUint32(cd + 20, true);
      const lho = dv.getUint32(cd + 42, true);
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const body = u8.slice(start, start + compSize);
      return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    };

    const PRIMARY_THEME = /^(NATURAL_DISASTER|MANMADE_DISASTER|EVACUATION|DISPLACED|POWER_OUTAGE|TERROR|ARMEDCONFLICT|PROTEST|FIRE|SHORTAGE|EPIDEMIC|CRISISLEX_[A-Z0-9]+_(EVACUATION|SHELTER|INFRASTRUCTURE|UTILITIES|FIRE|FLOOD))/;
    const HAZARD_THEME = /^(NATURAL_DISASTER|MANMADE_DISASTER|CRISISLEX_[A-Z0-9]+_(DEAD|INJURED|MISSING|DISPLACED|EVACUATION|SHELTER|INFRASTRUCTURE|UTILITIES|WATER|FIRE|FLOOD|CAUTION_ADVICE)|EVACUATION|DISPLACED|POWER_OUTAGE|TERROR|ARMEDCONFLICT|PROTEST|KILL|WOUND|EPIDEMIC|SHORTAGE|FIRE|SECURITY_SERVICES_[A-Z_]*(POLICE|EMERGENCY))/;
    const CAMPUS = [38.6488, -90.3108];
    const miles = (a, b, c, d2) => {
      const R = 3958.8, p = Math.PI / 180;
      const dLat = (c - a) * p, dLon = (d2 - b) * p;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };

    const records = [];
    const themeCounts = new Map();
    let files = 0, rows = 0, mb = 0;

    for (const stamp of stamps) {
      let text;
      try {
        const r = await fetch(GCS + stamp + ".gkg.csv.zip", { signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        text = await unzipFirst(await r.arrayBuffer());
      } catch (e) { continue; }
      files++;
      mb += text.length / 1048576;

      for (const line of text.split("\n")) {
        if (!line) continue;
        rows++;
        // Cheap pre-filter before splitting 27 fields.
        if (line.indexOf("USMO") < 0 && line.indexOf("USIL") < 0 && !/st\.? ?louis|saint louis/i.test(line)) continue;
        const fl = line.split("\t");
        if (fl.length < 16) continue;

        // Locations: type#name#cc#adm1#lat#lon#featureid
        let best = null;
        (fl[9] || "").split(";").forEach(loc => {
          const p = loc.split("#");
          if (p.length < 6) return;
          const lat = parseFloat(p[4]), lon = parseFloat(p[5]);
          if (isNaN(lat) || isNaN(lon)) return;
          const dist = miles(CAMPUS[0], CAMPUS[1], lat, lon);
          const adm1 = p[3] || "";
          if (adm1 === "USMN") return; // Saint Louis Park, MN and St. Louis County, MN
          const inRegion = adm1 === "USMO" || adm1 === "USIL";
          const named = inRegion && /st\.? ?louis|saint louis/i.test(p[1] || "");
          const score = (named ? 0 : 400) + dist;
          if (!best || score < best.score) best = { name: p[1], adm1: adm1, lat, lon, dist, named, score, inRegion: inRegion };
        });
        if (!best) continue;
        // Keep St. Louis-named places, or anything inside the metro radius.
        if (best.dist > 90 && !best.named) continue;
        if (!best.inRegion && best.dist > 90) continue;

        const url = fl[4] || "";
        const rawThemes = (fl[7] || "").split(";").filter(Boolean);
        if (!rawThemes.some(t => PRIMARY_THEME.test(t))) continue;
        const themes = [...new Set(rawThemes.filter(t => HAZARD_THEME.test(t) || PRIMARY_THEME.test(t)))];
        if (!themes.length) continue;
        // Obituaries and memorials carry casualty vocabulary but are not incidents.
        if (/obitu|death.?notice|in.?memoriam|funeral|memorial.?service/i.test(url + " " + (fl[3] || ""))) continue;
        [...new Set(themes.map(t => gkgThemeLabel(t)))].forEach(lbl => themeCounts.set(lbl, (themeCounts.get(lbl) || 0) + 1));

        let slug = "";
        try {
          const path = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
          slug = path.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, m => m.toUpperCase());
        } catch (e) {}
        const tone = parseFloat((fl[15] || "").split(",")[0]);

        records.push({
          source: fl[3] || "",
          url,
          slug: slug.length > 12 ? slug : (fl[3] || "Article"),
          tone: isNaN(tone) ? null : tone,
          themes: [...new Set(themes.map(t => gkgThemeLabel(t)))].slice(0, 6),
          place: best.name,
          dist: best.dist,
          named: best.named,
          date: fl[1] || stamp
        });
      }
    }

    if (!files) return { error: "No GDELT theme files could be read." };

    // The same wire story appears on many station sites; collapse by headline slug.
    const bySlug = new Map();
    records.forEach(r => {
      const key = (r.slug || r.url).toLowerCase().slice(0, 60);
      const prev = bySlug.get(key);
      if (prev) { prev.outlets++; return; }
      r.outlets = 1;
      bySlug.set(key, r);
    });
    const unique = [...bySlug.values()]
      .sort((a, b) => (b.named - a.named) || (b.themes.length - a.themes.length) || (a.dist - b.dist))
      .slice(0, 12);

    const themes = [...themeCounts.entries()]
      .map(([label, count]) => ({ code: label, label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { latest, files, rows, mb: mb.toFixed(1), records: unique, matched: records.length, themes };
  }

  W.newsScan = newsScan;
  W.gkgScan = gkgScan;
})();

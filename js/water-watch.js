/* Water Outages strip on the Outages tab. Renders what the hourly Water
   Utility Incident Watch task is tracking, from data/water_watch.json, which
   the task commits to this repository after each run (contract in
   data/README.md). Same origin as the page, so no proxy and no sign-in.
   Rechecks every five minutes while the page is visible. */
(function () {
  const W = window.WUEM;
  const { html, raw, safeUrl, fmtZoned, fmtDay } = W;
  const POLL_MS = 5 * 60 * 1000;
  /* 72-hour rule. The watch task tracks incidents until a source confirms
     they are resolved, and many sources never say so, so the file keeps
     growing. The strip therefore ages reports out on its own:
       - any report the watch has not re-confirmed (last_updated) in 72 hours
         is hidden, whatever its status;
       - a routine report (Ring 2-3, WashU impact none) is also hidden 72
         hours after it was first seen, even if the watch keeps touching it.
     Ring 1 and possible/likely/confirmed-impact reports stay as long as the
     watch keeps re-confirming them. Resolved reports never show. Hidden
     reports stay in the file; nothing is deleted. */
  const MAX_AGE_H = 72;
  const el = document.querySelector("[data-water]");
  if (!el) return;

  let data = null, lastChecked = null, lastError = null, noneYet = false, timer = null;

  const bust = u => u + (u.includes("?") ? "&" : "?") + "t=" + Date.now();
  const lower = v => String(v == null ? "" : v).toLowerCase();

  const chip = (cls, text) => html`<span class="bw-chip ${cls}">${text}</span>`;
  const levelChip = lvl => {
    const k = lower(lvl);
    return html`<span class="bw-chip ${k === "alert" ? "bw-chip--high" : k === "watch" ? "bw-chip--watch" : "bw-chip--normal"}"><span class="bw-chip-dot"></span>${lvl || "normal"}</span>`;
  };
  const statusChip = s => chip(lower(s) === "resolved" ? "bw-chip--quiet" : "bw-chip--watch", s || "open");
  const impactChip = v => { const k = lower(v); return chip(k === "likely" || k === "confirmed" ? "bw-chip--high" : k === "possible" ? "bw-chip--watch" : "bw-chip--quiet", "Impact " + (v || "none")); };
  const levelMeaning = { normal: "Nothing affecting WashU", watch: "Possible impact or Ring 1 item", alert: "Likely or confirmed impact, or a boil order touching an asset" };

  const firstSentence = s => { const m = String(s || "").match(/^.*?[.!?](\s|$)/); return m ? m[0].trim() : String(s || ""); };
  const mentionsBoil = r => /boil[- ](water )?(order|advisory|notice)/i.test([r.title, r.assessment].join(" ")) && !/no boil/i.test([r.title, r.assessment].join(" "));
  // The run note carries an "Unreachable: a, b, c." clause; surface it on its own.
  const unreachableOf = note => { const m = String(note || "").match(/Unreachable:\s*([^.]+)\./i); return m ? m[1].split(/,\s*/).map(s => s.trim()).filter(Boolean) : []; };
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

  const hoursSince = iso => { const t = Date.parse(iso || ""); return isNaN(t) ? NaN : (Date.now() - t) / 36e5; };
  const isPriority = r => Number(r.ring) === 1 || /^(possible|likely|confirmed)$/.test(lower(r.washu_impact));
  const isOpen = r => lower(r.status) !== "resolved";
  // A report with no parseable timestamp cannot be aged, so it stays visible.
  const isExpired = r => hoursSince(r.last_updated || r.first_seen) > MAX_AGE_H
    || (!isPriority(r) && hoursSince(r.first_seen) > MAX_AGE_H);
  const visibleIncidents = rows => rows.filter(r => isOpen(r) && !isExpired(r));

  async function fetchJson(path) {
    const r = await fetch(bust(path), { cache: "no-store" });
    if (!r.ok) { const e = new Error(path + " answered HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  async function check() {
    try {
      const d = await fetchJson("data/water_watch.json");
      if (!d || !d.latest) throw new Error("data/water_watch.json has no latest run");
      data = { latest: d.latest, incidents: Array.isArray(d.incidents) ? d.incidents : [] };
      lastError = null; noneYet = false;
    } catch (e) {
      if (e && e.status === 404 && !data) { noneYet = true; lastError = null; }
      else lastError = e && e.message ? e.message : String(e);
    }
    lastChecked = new Date();
    render();
    publish();
  }

  function render() {
    const latest = data && data.latest;
    const rows = data ? data.incidents.slice() : [];
    const active = visibleIncidents(rows)
      .sort((a, b) => String(b.last_updated || "").localeCompare(String(a.last_updated || "")) || String(b.id || "").localeCompare(String(a.id || "")));
    const aged = rows.filter(r => isOpen(r) && isExpired(r)).length;
    const ring1 = active.filter(r => Number(r.ring) === 1 || /^(possible|likely|confirmed)$/.test(lower(r.washu_impact))).length;
    const boil = active.filter(mentionsBoil).length;
    const unreachable = latest ? unreachableOf(latest.note) : [];
    const checked = lastChecked ? fmtZoned(lastChecked.toISOString()) : "";

    const subline = !data
      ? (lastError ? "Water watch unavailable. " + lastError : noneYet ? "No water watch run yet. It runs hourly." : "Reading the water watch…")
      : "Hourly water incident watch · generated " + fmtZoned(latest.run_at) + " · alert level " + lower(latest.alert_level || "normal");

    el.innerHTML = String(html`
      <div class="eyebrow mb-4">Water · Missouri American Water and City of St. Louis Water Division</div>
      <div class="sub mb-18">${subline}</div>
      ${data ? html`
      <div class="metric-strip">
        <div class="metric">
          <span class="meta-caps">Alert level</span>
          <span class="metric-value ww-tile-chip">${levelChip(latest.alert_level)}</span>
          <span class="sub">${levelMeaning[lower(latest.alert_level)] || "From the latest run"}</span>
        </div>
        <div class="metric">
          <span class="meta-caps">Open incidents</span>
          <span class="metric-value">${String(active.length)}</span>
          <span class="sub">${aged ? "Open or monitoring · " + aged + " older than " + MAX_AGE_H + " h hidden" : "Open or monitoring"}</span>
        </div>
        <div class="metric">
          <span class="meta-caps">Ring 1 / possible+</span>
          <span class="metric-value">${String(ring1)}</span>
          <span class="sub">Could touch a WashU asset</span>
        </div>
        <div class="metric">
          <span class="meta-caps">Boil orders</span>
          <span class="metric-value" style="color: ${boil ? "#ec3013" : "#201e1d"};">${String(boil)}</span>
          <span class="sub">St. Louis City and County</span>
        </div>
      </div>
      <div class="two-col two-col--power">
        <div class="col">
          <div class="list-head">Tracked incidents</div>
          ${aged ? html`<div class="sub" style="padding-bottom: 8px;">Reports not re-confirmed by the watch in ${String(MAX_AGE_H)} hours are dropped from this list (${String(aged)} today). They stay in the archive file.</div>` : ""}
          ${active.length ? active.map(r => html`
          <div class="item">
            <span class="item-title">${r.title || r.id}</span>
            <span class="sub">${[r.location, r.ring ? "Ring " + r.ring : "", r.first_seen ? "first seen " + fmtDay(r.first_seen) : ""].filter(Boolean).join(" · ")}</span>
            <span class="ww-meta">${statusChip(r.status)}${impactChip(r.washu_impact)}<span class="caps-sm">${[r.confidence ? "Confidence " + r.confidence : "", r.single_source ? "single-source" : ""].filter(Boolean).join(" · ")}</span></span>
            ${r.assessment ? html`<span class="item-desc">${firstSentence(r.assessment)}</span>` : ""}
            ${Array.isArray(r.affected_assets) && r.affected_assets.length ? html`<span class="caps-sm">Assets: ${r.affected_assets.join(", ")}</span>` : ""}
            ${Array.isArray(r.sources) && safeUrl(r.sources[0]) !== "#" ? html`<a class="sec-link" href="${safeUrl(r.sources[0])}" target="_blank" rel="noopener noreferrer">${hostOf(r.sources[0]) || "Source"} ↗</a>` : ""}
          </div>`) : html`<div class="quiet" style="padding-top: 12px;">No water utility incidents being tracked. Last run ${fmtZoned(latest.run_at)}.</div>`}
        </div>
        <div class="col">
          <div class="list-head">Run note</div>
          ${latest.top_incident ? html`<div class="item"><span class="item-title">${latest.top_incident}</span></div>` : ""}
          ${latest.note ? html`<div class="item"><span class="ww-note">${latest.note}</span></div>` : ""}
          ${unreachable.length ? html`<div class="item"><span class="caps-sm">Unreachable this run</span><span class="sub">${unreachable.join(" · ")}</span></div>` : ""}
        </div>
      </div>` : ""}
      <div class="bw-source" style="padding-left: 0; padding-right: 0;">
        <span>${checked ? "Checked " + checked + " · rechecks every 5 minutes" : ""}${lastError && data ? raw(' · <span style="color: #ae1800;">Last check failed. Showing the run from ' + W.html`${fmtZoned(latest.run_at)}` + ".</span>") : ""}</span>
        <span class="sub">Missouri American Water's advisory map is below</span>
      </div>`);
  }

  // The All-Hazards situation summary reads this, like the other tabs' context.
  function publish() {
    window.__omContext = window.__omContext || {};
    window.__omContext.water = data ? {
      latest: data.latest,
      tracked: visibleIncidents(data.incidents).length,
      updated: new Date().toISOString()
    } : null;
    window.dispatchEvent(new CustomEvent("om-context"));
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (document.visibilityState !== "hidden") check(); schedule(); }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && lastChecked && Date.now() - lastChecked.getTime() > POLL_MS) check();
  });

  render();
  check();
  schedule();
})();

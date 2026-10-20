/* Daily Intelligence Briefing — markup builders shared by the dashboard tab
   (js/briefing-watch.js) and the claude.ai artifact page (artifact/build.js
   inlines this file). Pure functions from a briefing record to an escaped
   HTML string; no DOM, no fetching. The record shape is documented in
   data/README.md. */
(function () {
  const TZ = "America/Chicago";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => { try { const p = new URL(String(u)); return /^https?:$/.test(p.protocol) ? p.href : ""; } catch (e) { return ""; } };
  const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  // "2026-10-20" is a Central calendar date; pin it to noon so no time zone
  // shifts it to the day before.
  const pin = iso => new Date(String(iso) + "T12:00:00");
  const dayLong = iso => { const d = pin(iso); return isNaN(d) ? String(iso || "") : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }); };
  const dayShort = iso => { const d = pin(iso); return isNaN(d) ? String(iso || "") : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  const dayMd = iso => { const d = pin(iso); return isNaN(d) ? String(iso || "") : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  const filedAt = iso => { const d = new Date(iso); if (!iso || isNaN(d)) return ""; try { return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short" }); } catch (e) { return ""; } };

  const postureChip = (p, big) => {
    const k = slug(p);
    const cls = k === "high" ? "bw-chip--high" : k === "elevated" ? "bw-chip--elevated" : "bw-chip--normal";
    return '<span class="bw-chip ' + cls + '"><span class="bw-chip-dot"></span>' + esc(p || "Normal") + (big ? " posture" : "") + "</span>";
  };
  const statusChip = s => { const k = slug(s); const cls = k === "active" ? "bw-chip--active" : k === "watch" ? "bw-chip--watch" : "bw-chip--quiet"; return '<span class="bw-chip ' + cls + '">' + esc(s || "quiet") + "</span>"; };
  const sevChip = n => { const v = Math.max(1, Math.min(5, Number(n) || 1)); return '<span class="bw-chip bw-chip--sev bw-chip--sev' + v + '">Sev ' + v + "</span>"; };
  const ttdChip = t => { const now = /^now$/i.test(String(t || "")); return '<span class="bw-chip ' + (now ? "bw-chip--now" : "bw-chip--today") + '">' + esc(t || "Today") + "</span>"; };
  const linkOut = (url, text, cls) => { const u = safeUrl(url); return u ? '<a class="' + (cls || "bw-arch-link") + '" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + "</a>" : ""; };

  // The five-field summary the task writes to meta/latest and data/latest.json;
  // derived from a full record when no summary is at hand.
  const headOf = d => d ? { date: d.date, posture: d.posture, top_item: d.top_item, briefing_url: d.briefing_url, published_at: d.published_at } : null;

  /* Inner markup of the posture strip. */
  function latestStrip(head) {
    if (!head) return "";
    const filed = filedAt(head.published_at);
    return '<div class="bw-latest-posture">' + postureChip(head.posture, true) +
        '<span class="bw-caps bw-tnum">' + esc(dayLong(head.date)) + (filed ? " · filed " + esc(filed) : "") + "</span></div>" +
      '<div class="bw-latest-top"><span class="bw-eyebrow">Top item</span><span class="bw-latest-top-text">' + esc(head.top_item || "") + "</span></div>" +
      (safeUrl(head.briefing_url) ? '<a class="bw-btn bw-btn--link" href="' + esc(safeUrl(head.briefing_url)) + '" target="_blank" rel="noopener noreferrer">Open full briefing ↗</a>' : "<span></span>");
  }

  /* Inner markup of the empty state. kind: pending | none | absent | error. */
  function emptyState(kind, detail) {
    if (kind === "absent") return '<div class="bw-empty-title">Sign in to claude.ai to read the briefing.</div>' +
      '<p class="bw-empty-body">The briefing is stored on claude.ai and needs your sign-in.</p>';
    if (kind === "error") return '<div class="bw-empty-title">The briefing could not be read.</div>' +
      '<p class="bw-empty-body">' + esc(detail || "The briefing did not answer.") + " Try again in a few minutes.</p>";
    if (kind === "pending") return '<div class="bw-empty-title">Reading the briefing…</div>' +
      '<p class="bw-empty-body">The briefing is filed each morning at 5:52 AM Central.</p>';
    return '<div class="bw-empty-title">No briefing filed yet.</div>' +
      '<p class="bw-empty-body">The first briefing is filed at 5:52 AM Central.</p>';
  }

  /* The body of one briefing: BLUF, decisions, PIRs, lookahead, method. */
  function body(d) {
    if (!d) return "";
    const items = Array.isArray(d.today_items) ? d.today_items.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99)) : [];
    const pirs = Array.isArray(d.pirs) ? d.pirs.slice().sort((a, b) => (a.pir || 99) - (b.pir || 99)) : [];
    const days = Array.isArray(d.lookahead) ? d.lookahead : [];
    const dissents = Array.isArray(d.dissents) ? d.dissents : [];
    const quiet = Array.isArray(d.lanes_quiet) ? d.lanes_quiet : [];
    const unreachable = Array.isArray(d.unreachable) ? d.unreachable : [];
    const stacked = days.filter(x => x.stacked).length;

    return '<section class="bw-sec bw-band">' +
        '<div class="bw-sec-head"><span class="bw-eyebrow">Bottom line up front · ' + esc(d.title || dayLong(d.date)) + "</span>" +
          (d.run_note ? '<span class="bw-sub">' + esc(d.run_note) + "</span>" : "") + "</div>" +
        '<p class="bw-lede">' + esc(d.bluf || "") + "</p>" +
      "</section>" +

      '<section class="bw-sec bw-band">' +
        '<div class="bw-sec-head"><span class="bw-eyebrow">Decisions today · ' + items.length + (items.length === 1 ? " item" : " items") + '</span><span class="bw-sub">Ranked by urgency. Sev 1 to 5. Now or Today is when to decide.</span></div>' +
        (items.length ? '<div class="bw-dec" role="table" aria-label="Decisions today">' +
          '<div class="bw-dec-h" role="row"><span>#</span><span>Item</span><span>Sev</span><span>Likelihood</span><span>Confidence</span><span>Action</span><span>Owner</span></div>' +
          items.map(it => '<div class="bw-dec-r" role="row">' +
            '<div class="bw-dec-c-rank"><span class="bw-dec-rank bw-tnum">' + esc(it.rank) + "</span></div>" +
            '<div><div class="bw-dec-title">' + (safeUrl(it.source) ? '<a href="' + esc(safeUrl(it.source)) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + "</a>" : esc(it.title)) + "</div>" +
              '<div class="bw-dec-meta">' + ttdChip(it.ttd) + (it.pir ? '<span class="bw-caps">PIR ' + esc(it.pir) + "</span>" : "") + "</div></div>" +
            '<div class="bw-dec-c-sev"><span class="bw-dec-label">Severity</span>' + sevChip(it.severity) + "</div>" +
            '<div><span class="bw-dec-label">Likelihood</span><span class="bw-caps bw-caps--ink">' + esc(it.likelihood || "—") + "</span></div>" +
            '<div><span class="bw-dec-label">Confidence</span><span class="bw-caps bw-caps--ink">' + esc(it.confidence || "—") + "</span></div>" +
            '<div><span class="bw-dec-label">Action</span><div class="bw-dec-action">' + esc(it.action || "") + "</div></div>" +
            '<div><span class="bw-dec-label">Owner</span><div class="bw-dec-owner">' + esc(it.owner || "") + "</div></div>" +
          "</div>").join("") + "</div>"
        : '<p class="bw-sub">No decision items filed for this day.</p>') +
      "</section>" +

      '<section class="bw-sec bw-band">' +
        '<div class="bw-sec-head"><span class="bw-eyebrow">Priority intelligence requirements</span><span class="bw-sub">' + (quiet.length ? "Lanes " + quiet.map(esc).join(", ") + ": nothing to report" : "") + "</span></div>" +
        '<div class="bw-pirs">' + pirs.map(p => '<div class="bw-pir">' +
          '<span class="bw-pir-n">PIR ' + esc(p.pir) + "</span>" +
          '<span class="bw-pir-name">' + esc(p.name) + "</span>" +
          '<span class="bw-pir-status">' + statusChip(p.status) + "</span>" +
          '<span class="bw-pir-sum">' + esc(p.summary || "") + "</span>" +
        "</div>").join("") + "</div>" +
      "</section>" +

      '<section class="bw-sec bw-band">' +
        '<div class="bw-sec-head"><span class="bw-eyebrow">Seven-day lookahead</span><span class="bw-sub">' + (stacked ? stacked + (stacked === 1 ? " stacked day" : " stacked days") + " this week" : "No stacked days this week") + "</span></div>" +
        '<div class="bw-days">' + days.map(x => '<div class="bw-day' + (x.stacked ? " bw-day--stacked" : "") + '">' +
          '<div><div class="bw-day-dow">' + esc(x.dow) + '</div><div class="bw-day-date bw-tnum">' + esc(dayMd(x.date)) + "</div></div>" +
          '<div class="bw-day-wx">' + esc(x.wx || "") + "</div>" +
          '<div class="bw-day-loads">' + esc(x.loads || "") + "</div>" +
          (x.stacked ? '<div class="bw-day-flag">Stacked</div>' : "") +
        "</div>").join("") + "</div>" +
        '<div class="bw-days-legend"><span><span class="bw-sw"></span>Stacked: several events on the same day</span></div>' +
      "</section>" +

      '<details class="bw-method bw-band"><summary><span class="bw-sum-mark"></span><span class="bw-eyebrow bw-caps--ink">How this was judged · dissents, quiet lanes, unreachable sources</span></summary>' +
        '<div class="bw-method-body">' +
          '<div><div class="bw-mh">Dissents · ' + dissents.length + "</div>" +
            (dissents.length ? dissents.map(x => '<div class="bw-dis"><span class="bw-dis-title">' + esc(x.title) + '</span><span class="bw-dis-verdict">' + esc(x.verdict) + '</span><span class="bw-dis-note">' + esc(x.note) + "</span></div>").join("") : '<div class="bw-plain bw-plain--muted">No dissents recorded.</div>') +
          "</div>" +
          "<div>" +
            '<div class="bw-mh">Lanes quiet</div><div class="bw-plain">' + (quiet.length ? quiet.map(n => "PIR " + esc(n)).join(" · ") : "None") + "</div>" +
            '<div class="bw-mh bw-mh--spaced">Unreachable this run · ' + unreachable.length + "</div>" +
            (unreachable.length ? unreachable.map(u => '<div class="bw-plain bw-plain--muted">' + esc(u) + "</div>").join("") : '<div class="bw-plain bw-plain--muted">Every source answered.</div>') +
          "</div>" +
        "</div>" +
      "</details>";
  }

  /* The "showing an older day" bar; empty when the newest is showing. */
  function viewingBar(d, newest) {
    if (!d || !newest || d === newest) return "";
    return '<span class="bw-viewing-text">Showing the briefing for ' + esc(dayShort(d.date)) + "</span>" +
      '<button type="button" class="bw-linkbtn" data-select="">Back to newest ↗</button>';
  }

  /* Inner markup of the archive section. */
  function archive(docs, currentDate) {
    if (!docs || !docs.length) return "";
    return '<div class="bw-sec-head"><span class="bw-eyebrow">Archive · ' + docs.length + (docs.length === 1 ? " briefing" : " briefings") + '</span><span class="bw-sub">Select a day to read it. Newest 30 shown.</span></div>' +
      '<div class="bw-arch">' + docs.map(d => '<button type="button" class="bw-arch-row" data-select="' + esc(d.date) + '"' + (d.date === currentDate ? ' aria-current="true"' : "") + ">" +
        '<span class="bw-arch-date bw-tnum">' + esc(dayShort(d.date)) + "</span>" +
        "<span>" + postureChip(d.posture) + "</span>" +
        '<span class="bw-arch-top">' + esc(d.top_item || "") + "</span>" +
        "<span>" + linkOut(d.briefing_url, "Full briefing ↗") + "</span>" +
      "</button>").join("") + "</div>";
  }

  window.BriefingRender = { esc, safeUrl, dayLong, dayShort, dayMd, filedAt, headOf, postureChip, statusChip, sevChip, latestStrip, emptyState, body, viewingBar, archive };
})();

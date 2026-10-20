/* Daily Briefing tab: renders the latest briefing from the JSON files the
   scheduled briefing task commits to this repository (see data/README.md).
   Same origin as the page, so no proxy, no sign-in, and it works on managed
   devices. Rechecks data/latest.json every five minutes while the page is
   visible and swaps in a new day when the record changes. */
(function () {
  const R = window.BriefingRender;
  const CFG = window.WUEM_CONFIG || {};
  const TZ = "America/Chicago";
  const POLL_MS = 5 * 60 * 1000;
  const $ = s => document.querySelector(s);
  const els = { latest: $("[data-bw-latest]"), empty: $("[data-bw-empty]"), body: $("[data-bw-body]"), source: $("[data-bw-source]") };
  if (!R || !els.body) return;

  let head = null, doc = null, lastChecked = null, lastError = null, noneYet = false, timer = null;

  const bust = u => u + (u.includes("?") ? "&" : "?") + "t=" + Date.now();
  const clock = d => { try { return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short" }); } catch (e) { return ""; } };

  async function fetchJson(path) {
    const r = await fetch(bust(path), { cache: "no-store" });
    if (!r.ok) { const e = new Error(path + " answered HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  async function check() {
    try {
      const latest = await fetchJson("data/latest.json");
      if (!latest || !latest.date) throw new Error("data/latest.json carries no date");
      // Only fetch the full record when the summary says it changed.
      if (!doc || doc.date !== latest.date || (latest.published_at && doc.published_at !== latest.published_at)) {
        doc = await fetchJson("data/briefings/" + encodeURIComponent(String(latest.date)) + ".json");
      }
      head = latest; lastError = null; noneYet = false;
    } catch (e) {
      // A missing latest.json means the task has not filed yet, not a fault.
      if (e && e.status === 404 && !doc) { noneYet = true; lastError = null; }
      else lastError = e && e.message ? e.message : String(e);
    }
    lastChecked = new Date();
    render();
    publish();
  }

  function render() {
    els.latest.hidden = !head;
    if (head) els.latest.innerHTML = R.latestStrip(head);

    els.empty.hidden = !!doc;
    if (!doc) els.empty.innerHTML = R.emptyState(lastError ? "error" : noneYet ? "none" : "pending", lastError);

    els.body.innerHTML = doc ? R.body(doc) : "";

    const link = R.safeUrl(CFG.briefingUrl);
    const parts = [];
    parts.push("Read from <code>data/latest.json</code>" + (doc ? " and <code>data/briefings/" + R.esc(doc.date) + ".json</code>" : "") + " in this site");
    if (lastChecked) parts.push("checked " + R.esc(clock(lastChecked)) + " · rechecks every 5 min while open");
    if (lastError && doc) parts.push('<span style="color: var(--bw-red-ink);">Last check failed (' + R.esc(lastError) + "); showing the briefing from " + R.esc(R.dayShort(doc.date)) + "</span>");
    els.source.innerHTML = "<span>" + parts.join(" · ") + "</span>" +
      (link ? '<a class="bw-btn bw-btn--link" href="' + R.esc(link) + '" target="_blank" rel="noopener noreferrer">Archive and full briefings on claude.ai ↗</a>' : "");
  }

  // The All-Hazards situation summary reads this, like the other tabs' context.
  function publish() {
    if (typeof window === "undefined") return;
    window.__omContext = window.__omContext || {};
    window.__omContext.briefing = doc ? { date: doc.date, posture: doc.posture, top_item: doc.top_item, published_at: doc.published_at, updated: new Date().toISOString() } : null;
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

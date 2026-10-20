/* Markup for the shell's dynamic regions. Each function takes the view model
   from buildView() and returns escaped HTML; app.js decides when to paint. */
(function () {
  const W = (window.WUEM = window.WUEM || {});
  const { html, safeUrl } = W;

  const ext = (url, cls, text) => html`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" class="${cls}">${text}</a>`;

  function headerActions(v) {
    return html`
      <div class="hdr-stamp">
        <span class="hdr-stamp-label">Data retrieved · campus time</span>
        <span class="hdr-stamp-value">${v.retrieved}</span>
      </div>
      <div class="live-chip">
        <span class="live-dot" style="background: ${v.liveDot};"></span>
        <span>${v.liveLabel}</span>
      </div>
      <button type="button" class="btn btn-secondary btn-refresh" data-action="refresh">Refresh feeds</button>`;
  }

  function tabs(v) {
    return html`${v.views.map(t => html`<button type="button" class="tab${t.bg === "transparent" ? "" : " is-active"}" data-action="view" data-key="${t.key}">${t.label}</button>`)}`;
  }

  function alertBand(v) {
    return html`
      <div class="alert-band${v.alertBandBg === "#ec3013" ? " is-red" : ""}">
        <div class="alert-band-head">
          <div class="alert-band-count">${v.alertHeadCount}</div>
          <div class="alert-band-line">${v.alertHeadLine}</div>
        </div>
        ${v.hasAlerts ? html`
        <div class="alert-list">
          ${v.alerts.map(a => html`
          <div class="alert-row">
            <div class="alert-col">
              <span class="ar-sev">${a.severity} · ${a.urgency}</span>
              <span class="ar-sender">${a.sender}</span>
            </div>
            <div class="alert-col alert-col--main">
              <span class="ar-event">${a.event}</span>
              <span class="ar-headline">${a.headline}</span>
              <span class="ar-area">${a.area}</span>
            </div>
            <div class="alert-col alert-col--times">
              <span>Effective ${a.onset}</span>
              <span>Expires ${a.expires}</span>
              <span class="o-8">${a.campus}</span>
              <span class="o-7">${a.issuedZone}</span>
            </div>
          </div>`)}
        </div>` : ""}
      </div>`;
  }

  const kvRows = rows => rows.map(r => html`
    <div class="kv-row">
      <span class="kv-name">${r.name}</span>
      <span class="kv-value" style="color: ${r.tone};">${r.value}</span>
    </div>`);

  function leftRail(v) {
    return html`
      <div class="side-block">
        <div class="eyebrow mb-4">Current Observation</div>
        <div class="sub mb-14">${v.obsStation}</div>
        <div class="kv-list">${kvRows(v.observation)}</div>
      </div>
      <div class="side-block">
        <div class="eyebrow mb-4">River &amp; Stream Gauges</div>
        <div class="sub mb-14">USGS gauges · Mississippi at St. Louis first, then the nearest county sites</div>
        <div class="kv-list">
          ${v.gauges.map(g => html`
          <div class="kv-row">
            <div class="kv-stack">
              <span class="kv-name">${g.name}</span>
              <span class="caps-sm">${g.site} · ${g.time}</span>
            </div>
            <span class="kv-value">${g.value}</span>
          </div>`)}
        </div>
      </div>
      <div class="side-block">
        <div class="eyebrow mb-4">Air Quality</div>
        <div class="sub mb-14">Open-Meteo · campus location</div>
        <div class="kv-list">${kvRows(v.air)}</div>
      </div>
      <div class="side-block side-block--last">
        <div class="eyebrow mb-4">Seismic · New Madrid &amp; Wabash Valley</div>
        <div class="sub mb-14">USGS · last 30 days, M2.5 and above</div>
        <div class="kv-list">
          ${v.quakes.map(q => html`
          <div class="quake-row">
            <span class="quake-mag">${q.mag}</span>
            <div class="kv-stack">
              <span class="kv-name">${q.place}</span>
              <span class="caps-sm">${q.time}</span>
            </div>
          </div>`)}
        </div>
      </div>`;
  }

  function summary(v) {
    return html`
      <section class="sec sec--summary">
        <div class="sec-head mb-12">
          <div class="eyebrow">Situation Summary · Connected feeds only</div>
          <div class="meta-caps">${v.summaryBasis}</div>
        </div>
        <p class="summary-lede">${v.summary}</p>
        <div class="summary-cols" style="grid-template-columns: ${v.summaryCols};">
          <div class="summary-col">
            <div class="summary-col-title">Active NWS alerts</div>
            <p>${v.summaryAlerts}</p>
          </div>
          <div class="summary-col">
            <div class="summary-col-title">Environment</div>
            <p>${v.summaryEnv}</p>
          </div>
          ${v.summaryHasOps ? html`
          <div class="summary-col">
            <div class="summary-col-title">Utilities, transit &amp; media</div>
            <p>${v.summaryOps}</p>
          </div>` : ""}
          <div class="summary-col">
            <div class="summary-col-title">Coverage gaps</div>
            <p>${v.summaryGaps}</p>
          </div>
        </div>
      </section>`;
  }

  function forecast(v) {
    const c = v.chart;
    return html`
      <section class="sec">
        <div class="sec-head mb-6">
          <div class="eyebrow">Next 24 Hours · NWS Hourly Forecast, Danforth Campus</div>
          <div class="meta-caps">${v.hourlySource}</div>
        </div>
        <div class="chart-toolbar">
          <div class="sub">${v.hourlyRange}</div>
          <div class="seg-ctl">
            ${v.chartModes.map(m => html`<button type="button" class="seg-btn${m.bg === "transparent" ? "" : " is-active"}" data-action="chart-mode" data-key="${m.key}">${m.label}</button>`)}
          </div>
        </div>

        <div class="stats">
          ${v.hourlyStats.map(s => html`
          <div class="stat">
            <span class="stat-label">${s.label}</span>
            <span class="stat-value" style="color: ${s.tone};">${s.value}</span>
            <span class="sub">${s.note}</span>
          </div>`)}
        </div>

        <div class="chart-wrap">
          <div class="chart-axes">
            <span>Left axis · ${c.leftAxisTitle}</span>
            <span class="chart-axes-right">Right axis · Chance of precipitation (%)</span>
          </div>
          <svg class="chart-svg" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
            ${c.bands.map(b => html`<rect x="52" y="${b.y}" width="936" height="${b.h}" fill="${b.fill}"></rect>`)}
            ${c.grid.map(g => html`<line x1="52" y1="${g.y}" x2="988" y2="${g.y}" stroke="#d7d3d3" stroke-width="1"></line>`)}
            ${c.night.map(n => html`<rect x="${n.x}" y="18" width="${n.w}" height="${n.h}" fill="rgba(32,30,29,0.05)"></rect>`)}
            ${c.bars.map(b => html`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${b.fill}"></rect>`)}
            <polyline points="${c.secondary}" fill="none" stroke="${c.stroke2}" stroke-width="2.5" stroke-dasharray="7 5" stroke-linejoin="round"></polyline>
            ${c.dots2.map(d => html`<circle cx="${d.cx}" cy="${d.cy}" r="2.5" fill="${c.stroke2}"></circle>`)}
            <polygon points="${c.area}" fill="${c.fill}"></polygon>
            <polyline points="${c.line}" fill="none" stroke="${c.stroke}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
            ${c.dots.map(d => html`<rect x="${d.x}" y="${d.y}" width="7" height="7" fill="${c.stroke}" stroke="#f3f2f2" stroke-width="1.5"></rect>`)}
            <line x1="52" y1="262" x2="988" y2="262" stroke="#201e1d" stroke-width="2"></line>
            ${c.axis.map(a => html`<line x1="${a.x}" y1="262" x2="${a.x}" y2="268" stroke="#201e1d" stroke-width="2"></line>`)}
          </svg>
          ${c.grid.map(g => html`<span class="chart-ylab" style="top: ${g.top};">${g.label}</span>`)}
          ${c.gridRight.map(g => html`<span class="chart-ylab-r" style="top: ${g.top};">${g.label}</span>`)}
          ${c.dots.map(d => html`<span class="chart-val" style="left: ${d.left}; top: ${d.top};">${d.label}</span>`)}
          ${c.axis.map(a => html`<span class="chart-xlab" style="left: ${a.left};">${a.label}</span>`)}
        </div>

        <div class="legend">
          <span class="legend-item"><span class="sw-line" style="background: ${c.stroke};"></span>${c.primaryLabel}</span>
          <span class="legend-item"><span class="sw-dash" style="border-top-color: ${c.stroke2};"></span>${c.secondaryLabel}</span>
          <span class="legend-item"><span class="sw-box" style="background: #ec3013;"></span>Chance of precipitation</span>
          <span class="legend-item"><span class="sw-box" style="background: rgba(32,30,29,0.05); border: 1px solid #d7d3d3;"></span>Overnight hours</span>
        </div>
      </section>`;
  }

  function inventory(v) {
    return html`
      <section class="sec">
        <div class="eyebrow mb-16">Missouri Alert Inventory · NWS Alerts Statewide</div>
        <table class="table">
          <thead>
            <tr>
              <th class="ta-left">Event</th>
              <th class="ta-right">Active</th>
              <th class="ta-left">Highest severity</th>
              <th class="ta-left">Covers campus</th>
            </tr>
          </thead>
          <tbody>
            ${v.inventory.map(i => html`
            <tr>
              <td class="td-strong">${i.event}</td>
              <td class="ta-right tnum">${i.count}</td>
              <td class="td-muted">${i.severity}</td>
              <td class="td-strong" style="color: ${i.tone};">${i.campus}</td>
            </tr>`)}
          </tbody>
        </table>
        <div class="inv-note">${v.inventoryNote}</div>
      </section>`;
  }

  const mark = (cls, left) => left ? html`<span class="flood-mark ${cls}" style="left: ${left};"></span>` : "";

  function flood(v) {
    return html`
      <section class="sec sec--tall">
        <div class="sec-head sec-head--wrap mb-4">
          <div class="eyebrow">Flood Stages · NOAA NWPS</div>
          ${ext("https://water.noaa.gov/wfo/LSX", "sec-link", "Open water.noaa.gov ↗")}
        </div>
        <div class="note mb-6">${v.floodNote}</div>
        ${v.floodHeadline ? html`<div class="flood-headline">${v.floodHeadline}</div>` : ""}
        ${v.floodQuiet ? html`<div class="quiet mb-14">All reporting gauges are below action stage. No forecast crosses it.</div>` : ""}
        ${v.floodReady ? html`
        <div class="flood-grid">
          ${v.floodRows.map(g => html`
          <div class="flood-row">
            <div class="flood-top">
              <span class="flood-name">
                <span class="flood-label">${g.label}</span>
                <span class="caps-sm">${g.note}</span>
              </span>
              <span class="flood-reading">
                <span class="flood-stage">${g.stage}</span>
                <span class="flood-cat" style="color: ${g.categoryTone};">${g.category}</span>
              </span>
            </div>
            <div class="flood-bar">
              <span class="flood-fill" style="width: ${g.barWidth}; background: ${g.barTone};"></span>
              ${mark("mark-action", g.actionMark)}
              ${mark("mark-minor", g.minorMark)}
              ${mark("mark-major", g.majorMark)}
            </div>
            <div class="flood-foot">
              <span class="fw-600" style="color: ${g.headroomTone};">${g.headroom}</span>
              <span style="color: ${g.forecastTone};">${g.forecast}</span>
            </div>
            <div class="caps-sm">${g.scaleLabel} · Observed ${g.observedAt}${g.detail}</div>
          </div>`)}
        </div>
        <div class="flood-legend">
          <span class="legend-item"><span class="sw-tick mark-action"></span>Action stage</span>
          <span class="legend-item"><span class="sw-tick mark-minor"></span>Minor flood stage</span>
          <span class="legend-item"><span class="sw-tick mark-major"></span>Major flood stage</span>
          <span>Each bar is scaled to that site's major flood stage. Do not compare stage values between gauges.</span>
        </div>` : ""}
      </section>`;
  }

  function news(v) {
    return html`
      <section class="sec sec--tall sec--plain">
        <div class="eyebrow mb-4">News Monitor · GDELT</div>
        <div class="sub mb-16">${v.newsSource}</div>
        <div class="kv-list">
          ${v.news.map(n => html`
          <div class="news-row">
            ${ext(n.url, "news-link", n.title)}
            <span class="news-meta">
              <span>${n.meta}</span>
              <span class="news-why">${n.why}</span>
            </span>
          </div>`)}
        </div>
      </section>`;
  }

  function metro(v) {
    return html`
      <section class="sec sec--tall sec--topped">
        <div class="sec-head sec-head--wrap mb-4">
          <div class="eyebrow">Transit · Metro</div>
          ${ext("https://www.metrostlouis.org/rider-alerts/", "sec-link", "Open metrostlouis.org ↗")}
        </div>
        <div class="note mb-18">${v.metroNote}</div>
        ${v.metroReady ? html`
        <div class="metric-strip">
          ${v.metroStats.map(m => html`
          <div class="metric">
            <span class="meta-caps">${m.label}</span>
            <span class="metric-value">${m.value}</span>
            <span class="sub">${m.note}</span>
          </div>`)}
        </div>
        ${v.metroQuiet ? html`<div class="quiet">No active service alerts. No route is running a minute or more late. Metro is on schedule.</div>` : ""}
        <div class="two-col">
          <div class="col">
            ${v.metroAlerts.length ? html`<div class="list-head">Service alerts</div>` : ""}
            ${v.metroAlerts.map(a => html`
            <div class="item">
              <span class="item-title">${a.header}</span>
              <span class="item-desc">${a.description}</span>
              <span class="item-tags">
                <span class="fw-700" style="color: ${a.tagTone};">${a.tag}</span>
                <span class="c-muted">${a.routes}</span>
              </span>
            </div>`)}
          </div>
          <div class="col">
            ${v.metroDelays.length ? html`<div class="list-head">Routes running late</div>` : ""}
            ${v.metroDelays.map(d => html`
            <div class="row-split">
              <span class="row-split-left">
                <span class="row-name">${d.route}</span>
                <span class="caps-sm">${d.detail}</span>
              </span>
              <span class="row-figure" style="color: ${d.tone};">${d.median}</span>
            </div>`)}
          </div>
        </div>
        ${v.metroNotes ? html`<div class="metro-notes">${v.metroNotes}</div>` : ""}` : ""}
      </section>`;
  }

  function localOutlets(v) {
    return html`
      <section class="sec sec--tall sec--topped">
        <div class="eyebrow mb-4">Local News · St. Louis Outlets</div>
        <div class="note mb-18">${v.localNote}</div>
        ${v.localEmpty ? html`<div class="quiet">No St. Louis outlet published a hazard or campus-area story in this window. The feeds answered.</div>` : ""}
        ${v.localReady ? html`
        <div class="local-grid">
          ${v.localItems.map(i => html`
          <div class="item">
            ${ext(i.url, "local-link", i.title)}
            <span class="local-meta">
              <span>${i.meta}</span>
              <span class="fw-700" style="color: ${i.whyTone};">${i.why}</span>
            </span>
          </div>`)}
        </div>
        ${v.localQuiet ? html`<div class="sub mt-12">Not answering: ${v.localQuiet}</div>` : ""}` : ""}
      </section>`;
  }

  function gkg(v) {
    return html`
      <section class="sec sec--tall sec--topped">
        <div class="eyebrow mb-4">News Themes · GDELT</div>
        <div class="sub mb-18">${v.gkgNote}</div>
        <div class="gkg-stack">
          <div class="gkg-themes">
            <div class="list-head">Hazard themes in this window</div>
            ${v.gkgSingleNote ? html`<div class="sub" style="padding-bottom: 2px;">Each theme appears once in this window. Counts are listed without bars.</div>` : ""}
            ${v.gkgThemes.map(t => html`
            <div class="gkg-theme">
              <div class="gkg-theme-body">
                <span class="gkg-theme-label">${t.label}</span>
                ${v.gkgShowBars ? html`<span class="gkg-bar" style="width: ${t.width};"></span>` : ""}
              </div>
              <span class="gkg-count">${t.count}</span>
            </div>`)}
          </div>
          <div class="col">
            <div class="list-head">Stories tagged to St. Louis</div>
            ${v.gkgRecords.map(g => html`
            <div class="gkg-record">
              ${ext(g.url, "gkg-link", g.slug)}
              <span class="item-desc">${g.themes}</span>
              <span class="gkg-meta">
                <span>${g.source}</span>
                <span class="gkg-meta-plain">${g.place}</span>
                <span class="gkg-meta-plain fw-700" style="color: ${g.toneColor};">${g.tone}</span>
              </span>
            </div>`)}
            ${v.gkgEmpty ? html`<div class="quiet" style="padding: 14px 0;">No hazard news tagged to the St. Louis region in this window. Only stories GDELT places here are counted.</div>` : ""}
          </div>
        </div>
      </section>`;
  }

  function registry(v) {
    return html`
      <div class="reg-head">
        <div class="eyebrow mb-4">Feed Registry</div>
        <div class="sub">${v.registryNote}</div>
      </div>
      <div>
        ${v.registry.map(r => html`
        <div class="reg-row">
          <span class="reg-dot" style="background: ${r.dot};"></span>
          <div class="reg-body">
            <span class="reg-name">${r.name}</span>
            <span class="reg-endpoint">${r.endpoint}</span>
            <span class="reg-detail" style="color: ${r.tone};">${r.detail}</span>
          </div>
          <span class="reg-chip" style="background: ${r.chipBg}; color: ${r.chipFg};">${r.status}</span>
        </div>`)}
      </div>
      <div class="reg-foot">
        <div class="eyebrow mb-8">To connect the remaining feeds</div>
        <p>Social platforms and campus CAD need credentials or block browser requests. Each needs a small server-side collector before it can appear here.</p>
        <p>Ameren and MoDOT use that method and are live above. Feeds marked Not connected show no data until a source is connected.</p>
      </div>`;
  }

  function hazards(v) {
    return html`
      <div class="strip">
        <span class="strip-tag">Live Public Data</span>
        <span class="strip-text">Every value below comes live from the named public source. Panels marked <strong>Not connected</strong> show no data.</span>
      </div>
      ${alertBand(v)}
      <div class="kpis">
        ${v.kpis.map(k => html`
        <div class="kpi">
          <span class="eyebrow">${k.label}</span>
          <span class="kpi-value" style="color: ${k.tone};">${k.value}</span>
          <span class="sub">${k.note}</span>
        </div>`)}
      </div>
      <div class="hz-grid">
        <aside class="hz-left">${leftRail(v)}</aside>
        <main>
          ${summary(v)}
          ${forecast(v)}
          ${inventory(v)}
          ${flood(v)}
          ${news(v)}
          ${metro(v)}
          ${localOutlets(v)}
          ${gkg(v)}
        </main>
        <aside class="hz-right">${registry(v)}</aside>
      </div>`;
  }

  function power(v) {
    return html`
      <div class="eyebrow mb-4">Power · Ameren Missouri and Ameren Illinois</div>
      <div class="sub mb-18">${v.powerNote}</div>
      ${v.powerStorm ? html`
      <div class="storm">
        <span class="storm-tag">Storm Mode</span>
        <span class="storm-text">Ameren has put its public map in storm mode. Restoration estimates are suspended or generalized.</span>
      </div>` : ""}
      ${v.proxyPanel ? html`
      <div class="proxy-panel">
        <span class="proxy-top">
          <span class="proxy-label">Worker address</span>
          <span class="sub">Currently ${v.proxyHost}</span>
        </span>
        <span class="proxy-note">${v.proxyPanelNote}</span>
        <form class="proxy-row" data-action="proxy-save">
          <input class="proxy-input" data-proxy-input type="text" inputmode="url" autocomplete="off" spellcheck="false" aria-label="Worker address" value="${v.proxyDraft || ""}" placeholder="https://feeds.example.org">
          <button type="submit" class="proxy-btn proxy-btn--save">Use this address</button>
          <button type="button" class="proxy-btn proxy-btn--reset" data-action="proxy-reset">Reset</button>
        </form>
      </div>` : ""}
      ${v.powerReady ? html`
      <div class="metric-strip">
        ${v.powerStats.map(p => html`
        <div class="metric">
          <span class="meta-caps">${p.label}</span>
          <span class="metric-value">${p.value}</span>
          <span class="sub">${p.note}</span>
        </div>`)}
      </div>
      <div class="two-col two-col--power">
        <div class="col">
          <div class="list-head">Nearest outages</div>
          ${v.powerOutages.map(o => html`
          <div class="item">
            <span class="item-head">${o.headline}</span>
            <span class="sub">${o.cause} — ${o.crew}</span>
            <span class="item-tags">
              <span class="fw-700" style="color: ${o.etrTone};">${o.etr}</span>
              <span class="c-muted">${o.duration}</span>
            </span>
          </div>`)}
          <div class="power-causes">Causes in ring: ${v.powerCauses}</div>
        </div>
        <div class="col">
          <div class="list-head">Metro counties</div>
          ${v.powerCounties.map(c => html`
          <div class="row-split">
            <span class="row-split-left">
              <span class="row-name row-name--600">${c.name}</span>
              <span class="caps-sm">${c.served}</span>
            </span>
            <span class="row-split-right">
              <span class="row-figure row-figure--plain" style="color: ${c.tone};">${c.out}</span>
              <span class="sub-xs">${c.pct}</span>
            </span>
          </div>`)}
        </div>
      </div>` : ""}`;
  }

  W.render = { headerActions, tabs, hazards, power };
})();

/* Enzo's Morning Dashboard — front-end
   Pulls everything from /api/bundle, then renders the brief and keeps the
   clocks & countdowns ticking. No build step, no framework. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const SERIES_META = {
  supercars: { label: "Supercars", color: "#00843d", flag: "🇦🇺" },
  wec:     { label: "WEC",     color: "#0066b1", flag: "🌍" },
  imsa:    { label: "IMSA",    color: "#d5001c", flag: "🇺🇸" },
  nascar:  { label: "NASCAR",  color: "#ffd200", flag: "🇺🇸" },
  indycar: { label: "IndyCar", color: "#3d8bff", flag: "🏁" },
  wrc:     { label: "WRC",     color: "#e60012", flag: "🌲" },
  f1:      { label: "F1",      color: "#e10600", flag: "🏎️" },
  all:     { label: "All",     color: "#9aa6bd", flag: "📡" },
};
const PALETTE = ["#f7931a", "#3d8bff", "#2bd47a", "#c06bff", "#ff5b4a", "#ffd700", "#19c0d8", "#ff9f1c"];

let BUNDLE = null;
let pointsChart = null, progressChart = null;
let sponCatChart = null, sponTierChart = null;
let countdownTargets = [];   // [{el, ts}] for the strip
let heroTarget = null;       // ms
let nascarTarget = null;     // ms

document.addEventListener("DOMContentLoaded", () => {
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(tickCountdowns, 1000);
  $("#refreshBtn").addEventListener("click", () => load(true));
  load(false);
});

async function load(isRefresh) {
  const btn = $("#refreshBtn");
  if (isRefresh) btn.classList.add("spin");
  try {
    const res = await fetch("bundle.json", { cache: "no-store" });
    BUNDLE = await res.json();
    renderAll();
  } catch (e) {
    console.error(e);
    $("#heroRace").textContent = "Could not reach the data server.";
  } finally {
    if (isRefresh) setTimeout(() => btn.classList.remove("spin"), 500);
  }
}

function renderAll() {
  renderGreeting();
  renderBizStrip();
  const events = buildEvents();
  renderHero();
  renderStrip(events);
  renderChartTabs();
  renderProgress();
  renderHQ();
  renderNewsTabs();
  renderLinks();
  renderMyRaces();
  renderOutreach();
  renderSponsors();
  renderDailyGrid();
  $("#footStamp").textContent =
    "Updated " + new Date().toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/* ---------- greeting ---------- */
function renderGreeting() {
  const cfg = BUNDLE.config || {};
  const h = new Date().getHours();
  const phase = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greetTime").textContent = phase + " · race brief";
  const name = (cfg.name || "").trim();
  $("#greetName").textContent = name ? `${phase}, ${name}` : "Welcome back, racer";
  if (cfg.tagline) $("#tagline").textContent = cfg.tagline;

}

/* ---------- hero business numbers ---------- */
function renderBizStrip() {
  const box = $("#bizStrip");
  if (!box) return;
  const { raised, backers, goal } = sponTotals();
  const goalPct = goal ? Math.round(raised / goal * 100) : 0;
  const fmt = n => "$" + Math.round(n).toLocaleString();
  box.innerHTML =
    `<div class="biz hot"><b>${fmt(raised)}</b><label>raised</label></div>
     <div class="biz"><b>${goalPct}%</b><label>to ${fmt(goal)} goal</label></div>
     <div class="biz"><b>${backers}</b><label>backers</label></div>
     <div class="biz"><b>${sentTotal()}</b><label>emails sent</label></div>`;
  popCounts(box, ".biz b");
}

function renderHQ() {
  const cfg = BUNDLE.config || {};
  const dr = cfg.driver, team = cfg.team || {};
  const box = $("#hqBox");
  if (!dr) { box.innerHTML = `<div class="news-empty">Add a "driver" block to config.json.</div>`; return; }
  const links = (cfg.links || []).filter(l => /saddington|bitcoin|youtube|tiktok/i.test(l.label))
    .map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("");
  box.innerHTML =
    `<div class="hq-hero">
       <div class="bignum">${esc(dr.number || "")}</div>
       <div class="htxt"><b>${esc(dr.nickname || dr.name)} ${dr.kanji ? esc(dr.kanji) : ""}</b>
         <span>${esc(dr.name || "")} · ${esc(team.name || "")}</span></div>
     </div>
     <div class="hq-spec">
       <div class="m"><label>Class</label><span>${esc(dr.carClass || "—")}</span></div>
       <div class="m"><label>Spec</label><span>${esc(dr.carSpec || "—")}</span></div>
       <div class="m"><label>Series</label><span>${esc(dr.series || "—")}</span></div>
       <div class="m"><label>Mission</label><span>${esc(team.motto || "—")}</span></div>
     </div>
     <div class="hq-links">${links}</div>`;
}

/* ---------- events / countdowns ---------- */
function buildEvents() {
  const out = [];
  const cal = (BUNDLE.calendar && BUNDLE.calendar.series) || {};
  for (const key of Object.keys(cal)) {
    const s = cal[key];
    (s.rounds || []).forEach(r => {
      const ts = Date.parse(r.start);
      if (!isFinite(ts)) return;
      out.push({
        series: key,
        seriesLabel: s.label || (SERIES_META[key] || {}).label || key,
        name: r.name,
        loc: [r.circuit, r.country].filter(Boolean).join(" · "),
        round: r.round,
        ts,
      });
    });
  }
  // fold in the live NASCAR next race
  const nx = BUNDLE.nascar && BUNDLE.nascar.next;
  if (nx && nx.ts) {
    out.push({
      series: "nascar",
      seriesLabel: "NASCAR Cup",
      name: nx.name,
      loc: nx.track,
      ts: nx.ts * 1000,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function renderHero() {
  // Big countdown = Joseph's OWN next race (from config.races), e.g. Daytona.
  const nr = nextRace();
  if (!nr) { $("#heroRace").textContent = "Season schedule TBA"; heroTarget = null; return; }
  $("#heroSeries").textContent = `🏁 ${nr.seriesTag || "Next race"}`;
  $("#heroRace").textContent = nr.name;
  const d = new Date(nr.ts);
  $("#heroMeta").textContent = [nr.track,
    nr.dateLabel || d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
  ].filter(Boolean).join("  ·  ");
  heroTarget = nr.ts;
}

function renderStrip(events) {
  const now = Date.now();
  const order = (BUNDLE.config && BUNDLE.config.seriesOrder) || ["wec", "imsa", "nascar", "indycar", "wrc"];
  countdownTargets = [];
  const cards = order.map(key => {
    const ev = events.find(e => e.series === key && e.ts > now)
            || events.filter(e => e.series === key).pop();
    const m = SERIES_META[key] || {};
    if (!ev) {
      return `<div class="cd-card"><span class="bar" style="background:${m.color}"></span>
        <div class="ser">${m.label || key}</div><div class="rnd">TBA</div>
        <div class="loc">schedule to come</div><div class="tmr">—</div></div>`;
    }
    const id = "cd_" + key;
    countdownTargets.push({ id, ts: ev.ts });
    return `<div class="cd-card"><span class="bar" style="background:${m.color}"></span>
      <div class="ser">${m.flag || ""} ${m.label || key}</div>
      <div class="rnd">${esc(ev.name)}</div>
      <div class="loc">${esc(ev.loc || "")}</div>
      <div class="tmr" id="${id}">—</div></div>`;
  });
  $("#countdownStrip").innerHTML = cards.join("");
}

function tickCountdowns() {
  const now = Date.now();
  if (heroTarget) {
    const d = Math.max(0, heroTarget - now);
    const p = parts(d);
    set("#cd-d", p.d); set("#cd-h", p.h); set("#cd-m", p.m); set("#cd-s", p.s);
  }
  countdownTargets.forEach(t => {
    const el = document.getElementById(t.id);
    if (!el) return;
    const d = t.ts - now;
    el.parentElement.classList.toggle("soon", d > 0 && d < 3 * 864e5);
    el.innerHTML = d <= 0 ? "<small>under way / done</small>" : compact(d);
  });
  if (nascarTarget) {
    const el = $("#nascarCd");
    if (el) { const d = nascarTarget - now; el.textContent = d <= 0 ? "Race weekend!" : "in " + compact(d, true); }
  }
}

function fullCount(ms) {
  const p = parts(ms);
  return `${+p.d}<small>d</small> ${+p.h}<small>h</small> ${+p.m}<small>m</small> ${p.s}<small>s</small>`;
}

function parts(ms) {
  const s = Math.floor(ms / 1000);
  return { d: String(Math.floor(s / 86400)).padStart(2, "0"),
           h: String(Math.floor(s % 86400 / 3600)).padStart(2, "0"),
           m: String(Math.floor(s % 3600 / 60)).padStart(2, "0"),
           s: String(s % 60).padStart(2, "0") };
}
function compact(ms, plain) {
  const p = parts(ms);
  if (+p.d > 0) return `${+p.d}<small>d</small> ${+p.h}<small>h</small>`;
  return plain ? `${+p.h}h ${+p.m}m` : `${+p.h}<small>h</small> ${+p.m}<small>m</small> ${p.s}<small>s</small>`;
}

/* ---------- championship chart + standings ----------
   Both views share one source: getRows() returns ranked {name,team,points}
   from the server's live ESPN table when present, else the editable JSON.   */
function getRows(key) {
  const data = (BUNDLE.standings.series || {})[key] || {};
  const live = data.live && data.live.table;
  if (live && live.length) {
    return {
      label: data.label, color: data.color,
      live: true, source: data.live.source || "ESPN", updatedAt: data.live.updatedAt,
      rows: live.map(r => ({ name: r.name, team: r.team || "", points: r.points })),
    };
  }
  const rows = (data.drivers || [])
    .map(d => ({ name: d.name, team: d.team || "", points: d.points }))
    .sort((a, b) => b.points - a.points);
  return { label: data.label, color: data.color, live: false,
           source: "manual", asOf: data.asOf, rows };
}

function renderChartTabs() {
  const st = (BUNDLE.standings && BUNDLE.standings.series) || {};
  const order = ((BUNDLE.config && BUNDLE.config.seriesOrder) || Object.keys(st)).filter(k => st[k]);
  const tabs = $("#chartTabs");
  tabs.innerHTML = order.map((k, i) =>
    `<button data-k="${k}" class="${i === 0 ? "on" : ""}">${(SERIES_META[k] || {}).label || k}</button>`).join("");
  $$("#chartTabs button").forEach(b => b.addEventListener("click", () => {
    $$("#chartTabs button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    drawChampionship(b.dataset.k);
  }));
  if (order[0]) drawChampionship(order[0]);
}

function drawChampionship(key) {
  const info = getRows(key);
  const top = info.rows.slice(0, 8);

  // --- bar chart of current points ---
  const base = info.color || (SERIES_META[key] || {}).color || "#f7931a";
  const colors = top.map((_, i) => i === 0 ? base : base + (i === 1 ? "cc" : i === 2 ? "99" : "66"));
  if (pointsChart) pointsChart.destroy();
  pointsChart = new Chart($("#pointsChart"), {
    type: "bar",
    data: {
      labels: top.map(r => shortName(r.name)),
      datasets: [{ label: "Points", data: top.map(r => r.points),
        backgroundColor: colors, borderRadius: 6, maxBarThickness: 30 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0a0d14", borderColor: "#2c2a26", borderWidth: 1, padding: 10,
          callbacks: { afterLabel: (c) => top[c.dataIndex].team || "" },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#c9c3b8", font: { weight: 600 }, maxRotation: 40, minRotation: 0 } },
        y: { grid: { color: "rgba(255,255,255,.05)" }, ticks: { color: "#9d978c" }, beginAtZero: true },
      },
    },
  });
  $("#chartLegend").innerHTML =
    `<span class="lg" style="color:#9d978c">${esc(info.label || "")} · current championship points` +
    (info.live ? ` · <span style="color:var(--green)">live ${esc(info.source)}</span>`
               : (info.asOf ? ` · <span style="color:#9d978c">${esc(info.asOf)}</span>` : "")) + `</span>`;

  drawStandings(key, info);
}

function drawStandings(key, info) {
  info = info || getRows(key);
  $("#standTitle").textContent = "🏆 " + (info.label || "Standings");
  const src = $("#standSrc");
  if (info.live) {
    src.textContent = "live · " + info.source;
    src.className = "src-badge live";
    src.title = "Updated " + (info.updatedAt || "");
  } else {
    src.textContent = "manual" + (info.asOf ? " · " + info.asOf : "");
    src.className = "src-badge manual";
    src.title = "Edit data/standings.json — no public live feed for this series";
  }
  const ranked = info.rows;
  const lead = ranked[0] ? ranked[0].points : 0;
  $("#standingsTable").innerHTML = ranked.slice(0, 10).map((d, i) =>
    `<div class="st-row p${i + 1}">
       <div class="pos">${i + 1}</div>
       <div class="who"><div class="nm">${esc(d.name)}</div><div class="tm">${esc(d.team || "")}</div></div>
       <div class="pts">${d.points}<small>pts ${i === 0 ? "" : "−" + (lead - d.points)}</small></div>
     </div>`).join("");
}

function shortName(n) {
  // "Alex Palou" -> "Palou"; "Frijns / Rast" -> "Frijns/Rast"
  if (n.includes("/")) return n.split("/").map(s => s.trim().split(" ").pop()).join("/");
  const parts = n.trim().split(" ");
  return parts.length > 1 ? parts[parts.length - 1] : n;
}

/* ---------- season progress ---------- */
function renderProgress() {
  const st = (BUNDLE.standings && BUNDLE.standings.series) || {};
  const order = ((BUNDLE.config && BUNDLE.config.seriesOrder) || Object.keys(st)).filter(k => st[k]);
  const keys = order;
  const labels = keys.map(k => (SERIES_META[k] || {}).label || k);
  const done = keys.map(k => st[k].roundsDone || 0);
  const totals = keys.map(k => st[k].roundsTotal || 10);
  const pct = done.map((d, i) => Math.round(d / totals[i] * 100));
  if (progressChart) progressChart.destroy();
  progressChart = new Chart($("#progressChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "% of season", data: pct,
        backgroundColor: keys.map(k => (SERIES_META[k] || {}).color || "#ff2b3e"),
        borderRadius: 6, barThickness: 20,
      }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.x}% (${done[c.dataIndex]}/${totals[c.dataIndex]} rounds)` },
          backgroundColor: "#0a0d14", borderColor: "#222a3a", borderWidth: 1 } },
      scales: {
        x: { max: 100, grid: { color: "rgba(255,255,255,.05)" }, ticks: { color: "#8995ad", callback: v => v + "%" } },
        y: { grid: { display: false }, ticks: { color: "#e9eef7", font: { weight: 600 } } },
      },
    },
  });
}

/* ---------- NASCAR widget ---------- */
function renderNascar() {
  const n = BUNDLE.nascar || {};
  const box = $("#nascarBox");
  const badge = $("#nascarBadge");
  if (!n.ok) { box.innerHTML = `<div class="ntrk">NASCAR feed offline right now.</div>`; badge.textContent = "offline"; badge.classList.add("stale"); return; }
  badge.textContent = n.stale ? "cached" : "live";
  badge.classList.toggle("stale", !!n.stale);
  const nx = n.next, last = n.last;
  let html = "";
  if (nx) {
    nascarTarget = nx.ts ? nx.ts * 1000 : null;
    html += `<div class="nx">${esc(nx.name || "Next race")}</div>
      <div class="ntrk">${esc(nx.track || "")}</div>
      <div class="nmeta">
        <div class="m"><label>Green flag</label><span>${nx.ts ? new Date(nx.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "TBA"}</span></div>
        <div class="m"><label>Laps</label><span>${nx.laps || "—"}</span></div>
        <div class="m"><label>TV</label><span>${esc(nx.tv || "—")}</span></div>
        <div class="m"><label>Countdown</label><span id="nascarCd">—</span></div>
      </div>`;
  }
  if (last) {
    html += `<div class="nlast">Last out: <b>${esc(last.name || "")}</b> — ${esc(last.track || "")}</div>`;
  }
  box.innerHTML = html || `<div class="ntrk">Schedule loading…</div>`;
}

/* ---------- news ---------- */
function renderNewsTabs() {
  const news = BUNDLE.news || {};
  const order = ((BUNDLE.config && BUNDLE.config.seriesOrder) || []).filter(k => news[k]);
  if (news.all) order.unshift("all");
  $("#newsTabs").innerHTML = order.map((k, i) =>
    `<button data-k="${k}" class="${i === 0 ? "on" : ""}">${(SERIES_META[k] || {}).label || k}</button>`).join("");
  $$("#newsTabs button").forEach(b => b.addEventListener("click", () => {
    $$("#newsTabs button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    drawNews(b.dataset.k);
  }));
  if (order[0]) drawNews(order[0]);
  // also fill the NASCAR widget once news ready (nascar bundle is separate)
  renderNascar();
}

function drawNews(key) {
  const feed = (BUNDLE.news || {})[key] || {};
  const items = (feed.items || []).slice(0, 12);
  const grid = $("#newsGrid");
  if (!items.length) {
    grid.innerHTML = `<div class="news-empty">No ${(SERIES_META[key] || {}).label || key} headlines right now${feed.stale ? " (offline)" : ""}.</div>`;
    return;
  }
  grid.innerHTML = items.map(it => {
    const thumb = it.image
      ? `style="background-image:url('${esc(it.image)}')"`
      : `style="background:linear-gradient(135deg,#161b27,#0a0d14)"`;
    return `<a class="news-card" href="${esc(it.link)}" target="_blank" rel="noopener">
      <div class="news-thumb" ${thumb}><span class="src">${esc(it.source || "News")}</span></div>
      <div class="news-body">
        <h4>${esc(it.title)}</h4>
        <p>${esc(it.summary || "")}</p>
        <div class="when">${timeAgo(it.date)}</div>
      </div></a>`;
  }).join("");
}

/* ---------- links ---------- */
function renderLinks() {
  const links = (BUNDLE.config && BUNDLE.config.links) || [];
  $("#linksRow").innerHTML = links.map(l =>
    `<a class="lnk" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("");
}

/* ---------- Joseph's 2026 season (personal race schedule) ---------- */
function renderMyRaces() {
  const races = (BUNDLE.config && BUNDLE.config.races) || [];
  const box = $("#myRaces");
  if (!races.length) { box.innerHTML = `<div class="news-empty">No races in config.json yet.</div>`; return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const dated = races.map(r => ({ ...r, ts: Date.parse(r.date + "T12:00:00") }))
    .sort((a, b) => a.ts - b.ts);
  const nextIdx = dated.findIndex(r => r.ts >= t0);

  box.innerHTML = dated.map((r, i) => {
    const d = new Date(r.ts);
    const past = r.ts < t0;
    const isNext = i === nextIdx;
    const dayN = Math.round((r.ts - t0) / 864e5);
    let stat;
    if (past) stat = "✓ done";
    else if (isNext) stat = `<span class="nx-badge">next · ${dayN === 0 ? "today" : "in " + dayN + "d"}</span>`;
    else stat = "in " + dayN + " days";
    const when = r.dateLabel
      ? `<b>${esc(r.dateLabel.replace(/^\w+ /, ""))}</b><span>${esc(r.dateLabel.split(" ")[0])}</span>`
      : `<b>${d.toLocaleDateString([], { day: "numeric" })} ${d.toLocaleDateString([], { month: "short" })}</b><span>${d.toLocaleDateString([], { weekday: "short" })}</span>`;
    return `<div class="race-row ${past ? "past" : ""} ${isNext ? "next" : ""}">
      <div class="race-when">${when}</div>
      <div class="race-info"><div class="rn">${esc(r.name)} <span class="task-tag">${esc(r.seriesTag || "")}</span></div>
        <div class="rt">${esc(r.track || "")}</div></div>
      <div class="race-stat">${stat}</div>
    </div>`;
  }).join("");

  const done = dated.filter(r => r.ts < t0).length;
  $("#myRacesCap").textContent =
    `${done} of ${dated.length} rounds complete · source: ${(BUNDLE.config && BUNDLE.config.racesSource) || "config.json"} · edit data/config.json`;
}

/* ---------- shared sponsor/race helpers ---------- */
function sponTotals() {
  const s = BUNDLE.sponsors || {};
  const tiers = (s.tiers || []).map(t => ({ ...t, revenue: (t.amount || 0) * (t.count || 0) }));
  return {
    raised: tiers.reduce((a, t) => a + t.revenue, 0),
    backers: tiers.reduce((a, t) => a + (t.count || 0), 0),
    goal: s.goal || 0,
  };
}
function nextRace() {
  const races = (BUNDLE.config && BUNDLE.config.races) || [];
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const dated = races.map(r => ({ ...r, ts: Date.parse(r.date + "T12:00:00") }))
    .filter(r => isFinite(r.ts)).sort((a, b) => a.ts - b.ts);
  return dated.find(r => r.ts >= t0.getTime()) || null;
}
function sentTotal() {
  const t = (BUNDLE.outreach && BUNDLE.outreach.totals) || {};
  return t.sent != null ? t.sent : (t.drafted || 0);
}

/* generic confetti burst on any element (reuses .confetti styles) */
function popConfetti(el, n) {
  if (!el) return;
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  const wrap = document.createElement("div");
  wrap.className = "confetti";
  for (let i = 0; i < (n || 30); i++) {
    const s = document.createElement("span");
    s.style.left = Math.random() * 100 + "%";
    s.style.setProperty("--i", i);
    s.style.setProperty("--h", Math.floor(Math.random() * 360));
    wrap.appendChild(s);
  }
  el.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2400);
}
/* fire confetti once whenever a new $10k milestone is crossed between visits */
function checkSponMilestone(raised, box) {
  const step = 10000;
  const ms = Math.floor(raised / step) * step;
  if (ms < step) return;
  let last = 0;
  try { last = parseInt(localStorage.getItem("enzo.spxMilestone") || "0", 10) || 0; } catch {}
  if (ms > last) {
    localStorage.setItem("enzo.spxMilestone", String(ms));
    setTimeout(() => popConfetti(box, 38), 450);
  }
}

/* ---------- Sponsor Pipeline (live from the Racing Contacts sheet) ---------- */
/* count-up animation for headline numbers (keeps any $ prefix) */
function popCounts(scope, sel) {
  scope.querySelectorAll(sel).forEach(el => {
    const raw = (el.textContent || "").trim();
    const money = raw.charAt(0) === "$";
    const target = parseInt(raw.replace(/[^0-9]/g, ""), 10);
    if (!isFinite(target) || target <= 0) return;
    el.classList.add("pop-num");
    const dur = 850, t0 = performance.now();
    function step(now) {
      const p = Math.min(1, (now - t0) / dur);
      const v = Math.round(target * (1 - Math.pow(1 - p, 3)));
      el.textContent = (money ? "$" : "") + v.toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

function renderOutreach() {
  const o = BUNDLE.outreach;
  const box = $("#sponsorBox");
  if (sponCatChart) { sponCatChart.destroy(); sponCatChart = null; }
  if (sponTierChart) { sponTierChart.destroy(); sponTierChart = null; }
  if (!o || !o.totals) {
    box.innerHTML = `<div class="news-empty">No outreach data yet — run outreach_stats.py.</div>`;
    return;
  }
  const t = o.totals;
  const sent = t.sent != null ? t.sent : t.drafted;
  const pct = t.emailable ? Math.round(sent / t.emailable * 100) : 0;
  const emRate = t.prospects ? Math.round(t.emailable / t.prospects * 100) : 0;
  const formRate = t.prospects ? Math.round(t.forms / t.prospects * 100) : 0;
  const ms = o.byMotorsport || {};
  const chips = (arr) => (arr && arr.length)
    ? arr.map(x => `<span class="spon-chip">${esc(x)}</span>`).join("")
    : `<span class="spon-chip muted">—</span>`;
  const today = o.today || [];
  const shown = today.slice(0, 8);
  const more = today.length - shown.length;
  const fst = [
    { k: "Prospects", v: t.prospects || 0, cls: "" },
    { k: "Emailable", v: t.emailable || 0, cls: "s2" },
    { k: "Sent", v: sent || 0, cls: "s3" },
  ];
  const fmax = fst[0].v || 1;
  let funnelHtml = `<div class="fnl">`;
  fst.forEach((st, i) => {
    if (i > 0) {
      const conv = fst[i - 1].v ? Math.round(st.v / fst[i - 1].v * 100) : 0;
      funnelHtml += `<div class="fnl-conv">▼ <b>${conv}%</b> ${i === 1 ? "reachable" : "contacted"}</div>`;
    }
    const w = Math.max(34, Math.round(st.v / fmax * 100));
    funnelHtml += `<div class="fnl-stage ${st.cls}" style="width:${w}%"><b>${st.v.toLocaleString()}</b><span>${st.k}</span></div>`;
  });
  funnelHtml += `</div>`;

  // momentum sparkline (cumulative sent over time, from data/sent_log.json)
  const log = (o.sentLog || []).filter(p => p && isFinite(p.total));
  let sparkHtml;
  if (log.length >= 2) {
    const vals = log.map(p => p.total);
    const mn = Math.min(...vals), mx = Math.max(...vals), span = (mx - mn) || 1;
    const W = 280, H = 44;
    const pts = log.map((p, i) => [
      (i / (log.length - 1)) * W,
      (H - 3) - ((p.total - mn) / span) * (H - 8),
    ]);
    const poly = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    const delta = vals[vals.length - 1] - vals[vals.length - 2];
    sparkHtml =
      `<div class="spark">
         <div class="spark-h"><span>📈 Sent momentum</span><em>${delta >= 0 ? "+" : ""}${delta} latest</em></div>
         <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark-svg">
           <polyline points="${poly}" fill="none" stroke="#2bd47a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
           <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="#2bd47a"/>
         </svg>
         <div class="spark-f"><span>${esc((log[0].date || "").slice(5))}</span><span>${esc((log[log.length - 1].date || "").slice(5))}</span></div>
       </div>`;
  } else {
    sparkHtml = `<div class="spark muted">📈 Sent momentum — <em>trend builds daily</em>${log.length ? ` · logging since ${esc(log[0].date.slice(5))}` : ""}</div>`;
  }
  const foot = [];
  if (o.sheetUrl) foot.push(`<a href="${esc(o.sheetUrl)}" target="_blank" rel="noopener">Open tracker ↗</a>`);
  if (o.draftsUrl) foot.push(`<a href="${esc(o.draftsUrl)}" target="_blank" rel="noopener">Review drafts in Gmail ↗</a>`);
  box.innerHTML =
    `<div class="spon-stats">
       <div class="spon-stat"><b>${t.prospects}</b><label>prospects</label></div>
       <div class="spon-stat"><b>${t.emailable}</b><label>emailable</label></div>
       <div class="spon-stat hot"><b>${sent}</b><label>sent</label></div>
       <div class="spon-stat"><b>${t.remaining}</b><label>to go</label></div>
       <div class="spon-stat"><b>${t.forms}</b><label>forms</label></div>
     </div>
     <div class="spon-pct">
       <span class="p"><b>${emRate}%</b> emailable</span>
       <span class="p"><b>${pct}%</b> of emailable contacted</span>
       <span class="p"><b>${formRate}%</b> form-only</span>
     </div>
     ${funnelHtml}
     ${sparkHtml}
     <div class="spon-charts">
       <div class="spon-donut"><canvas id="sponCatChart"></canvas><span class="spon-donut-cap">Prospects by category</span></div>
       <div class="spon-donut"><canvas id="sponTierChart"></canvas><span class="spon-donut-cap">Prospects by tier</span></div>
     </div>
     <div class="spon-rows">
       <div class="spon-line"><span class="spon-k">Motorsport</span><div class="spon-vals">
         <span class="spon-chip">🏁 <b>${ms.established || 0}</b> established</span>
         <span class="spon-chip new">🚀 <b>${ms.new || 0}</b> new to the sport</span></div></div>
       <div class="spon-line"><span class="spon-k">✅ Sent today</span><div class="spon-vals">${chips(shown)}${more > 0 ? `<span class="spon-chip muted">+${more}</span>` : ""}</div></div>
       <div class="spon-line"><span class="spon-k">⏭ Next up</span><div class="spon-vals">${chips(o.nextUp)}</div></div>
     </div>
     ${(foot.length || o.generatedAt) ? `<div class="spon-foot">${foot.join("")}
       <span class="spon-when">updated ${esc((o.generatedAt || "").replace("T", " ").slice(0, 16))}</span>
     </div>` : ""}`;

  const donutOpts = () => ({
    responsive: true, maintainAspectRatio: false, cutout: "58%",
    plugins: {
      legend: { position: "bottom", labels: { color: "#c9c3b8", boxWidth: 10, font: { size: 10 }, padding: 6 } },
      tooltip: {
        backgroundColor: "#0a0d14", borderColor: "#2c2a26", borderWidth: 1, padding: 8,
        callbacks: { label: (c) => ` ${c.label}: ${c.parsed}` },
      },
    },
  });
  const cat = (o.byCategory || []).slice(0, 7);
  if (cat.length) sponCatChart = new Chart($("#sponCatChart"), {
    type: "doughnut",
    data: { labels: cat.map(c => c.name), datasets: [{ data: cat.map(c => c.count), backgroundColor: PALETTE, borderWidth: 0 }] },
    options: donutOpts(),
  });
  const tier = (o.byTier || []).filter(x => x.count);
  if (tier.length) sponTierChart = new Chart($("#sponTierChart"), {
    type: "doughnut",
    data: { labels: tier.map(x => x.name), datasets: [{ data: tier.map(x => x.count), backgroundColor: ["#f7931a", "#3d8bff", "#2bd47a", "#c06bff"], borderWidth: 0 }] },
    options: donutOpts(),
  });
  popCounts(box, ".spon-stat b, .fnl-stage b");
}

/* ---------- Sponsorship Secured ---------- */
function renderSponsors() {
  const s = BUNDLE.sponsors;
  const box = $("#sponsorsBox");
  if (!box) return;
  if (!s || !s.tiers || !s.tiers.length) {
    box.innerHTML = `<div class="news-empty">No sponsorship data yet — edit data/sponsors.json.</div>`;
    return;
  }
  const fmt = n => "$" + Math.round(n).toLocaleString();
  const tiers = s.tiers.map(t => ({ ...t, revenue: (t.amount || 0) * (t.count || 0) }));
  const raised = tiers.reduce((a, t) => a + t.revenue, 0);
  const backers = tiers.reduce((a, t) => a + (t.count || 0), 0);
  const active = tiers.filter(t => t.count > 0).length;
  const avg = backers ? Math.round(raised / backers) : 0;
  const goal = s.goal || 0;
  const goalPct = goal ? Math.min(100, Math.round(raised / goal * 100)) : 0;
  const maxRev = Math.max(1, ...tiers.map(t => t.revenue));

  const tierBars = tiers.map(t =>
    `<div class="spx-bar">
       <div class="spx-bar-head"><span>${esc(t.name)}</span><b>${fmt(t.revenue)}</b></div>
       <div class="spx-track"><div class="spx-fill" style="width:${Math.round(t.revenue / maxRev * 100)}%;background:${esc(t.color || "#f7931a")}"></div></div>
       <div class="spx-sub">${t.count} × ${fmt(t.amount)}</div>
     </div>`).join("");

  const o = BUNDLE.outreach && BUNDLE.outreach.totals;
  let funnel = `<div class="news-empty">—</div>`;
  if (o) {
    const stages = [
      { k: "Prospects identified", v: o.prospects || 0 },
      { k: "Reachable (emailable)", v: o.emailable || 0 },
      { k: "Backers secured", v: backers },
    ];
    const top = stages[0].v || 1;
    funnel = `<div class="spx-funnel">` + stages.map((st, i) => {
      const w = Math.max(8, Math.round(st.v / top * 100));
      const conv = i > 0 && stages[i - 1].v ? Math.round(st.v / stages[i - 1].v * 100) : null;
      return `<div class="spx-fn-row">
        <div class="spx-fn-bar" style="width:${w}%">${st.v.toLocaleString()}</div>
        <div class="spx-fn-lbl">${esc(st.k)}${conv != null ? ` <em>${conv}%</em>` : ""}</div></div>`;
    }).join("") + `</div>`;
  }

  const marks = goal ? [0.25, 0.5, 0.75].map(f => ({ pct: f * 100, val: goal * f })) : [];
  const nextMs = marks.find(mk => mk.val > raised);
  const goalCap = goal
    ? (nextMs ? `next milestone: ${fmt(nextMs.val)} · ${fmt(nextMs.val - raised)} to go` : "🏆 goal smashed — set a stretch target!")
    : "";

  box.innerHTML =
    `<div class="spx-kpis">
       <div class="spx-kpi hot"><b>${fmt(raised)}</b><label>raised</label></div>
       <div class="spx-kpi"><b>${backers}</b><label>backers</label></div>
       <div class="spx-kpi"><b>${active}</b><label>active tiers</label></div>
       <div class="spx-kpi"><b>${fmt(avg)}</b><label>avg / backer</label></div>
     </div>
     ${goal ? `<div class="spx-goal">
       <div class="spx-goal-head"><span>🎯 Season goal</span><b>${fmt(raised)} / ${fmt(goal)} · ${goalPct}%</b></div>
       <div class="spx-track big">
         <div class="spx-fill spx-anim" data-w="${goalPct}" style="width:0;background:linear-gradient(90deg,#f7931a,#ffb84d)"></div>
         ${marks.map(mk => `<span class="spx-mark${mk.val <= raised ? " hit" : ""}" style="left:${mk.pct}%"></span>`).join("")}
       </div>
       <div class="spx-goal-cap">${esc(goalCap)}</div>
     </div>` : ""}
     <div class="spx-cols">
       <div><div class="spx-h">Revenue by tier</div>${tierBars}</div>
       <div><div class="spx-h">Sponsorship funnel</div>${funnel}</div>
     </div>
     ${s.source ? `<div class="spx-src">source: ${esc(s.source)}</div>` : ""}`;
  popCounts(box, ".spx-kpi b");
  setTimeout(() => { const f = box.querySelector(".spx-anim"); if (f) f.style.width = f.dataset.w + "%"; }, 80);
  checkSponMilestone(raised, box);
}

/* ---------- Daily Grid (recurring to-dos) ---------- */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function loadDaily() {
  try { return JSON.parse(localStorage.getItem("enzo.daily") || "{}"); }
  catch { return {}; }
}
function saveDaily(s) { localStorage.setItem("enzo.daily", JSON.stringify(s)); }

function renderDailyGrid() {
  const cfg = (BUNDLE.config && BUNDLE.config.dailyTasks) || {};
  const tasks = cfg.tasks || [];
  $("#dailyTitle").textContent = "✅ " + (cfg.title || "Daily Grid");
  $("#dailySub").textContent = cfg.subtitle || "";
  const grid = $("#dailyGrid");
  if (!tasks.length) { grid.innerHTML = `<div class="news-empty">Add tasks under "dailyTasks" in config.json.</div>`; return; }

  const state = loadDaily();
  const today = todayKey();
  if (state.day !== today) { state.day = today; state.checked = {}; saveDaily(state); }
  const checked = state.checked || {};

  grid.innerHTML = tasks.map(t => {
    const on = !!checked[t.id];
    const links = (t.links || []).map(l =>
      `<a href="${esc(l.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(l.label)} ↗</a>`).join("");
    return `<div class="task-card ${on ? "done" : ""}" data-id="${esc(t.id)}">
      <div class="task-check"></div>
      <div class="task-ico">${esc(t.icon || "•")}</div>
      <div class="task-main">
        <div class="task-top"><span class="task-title">${esc(t.title)}</span>${t.tag ? `<span class="task-tag">${esc(t.tag)}</span>` : ""}</div>
        <p class="task-desc">${esc(t.desc || "")}</p>
        ${links ? `<div class="task-links">${links}</div>` : ""}
      </div></div>`;
  }).join("");

  $$("#dailyGrid .task-card").forEach(card => {
    card.addEventListener("click", () => toggleTask(card.dataset.id, card));
  });
  $("#dailyReset").onclick = () => {
    const s = loadDaily(); s.checked = {}; s.day = todayKey(); saveDaily(s);
    renderDailyGrid();
  };
  updateDailyProgress(tasks);
}

function toggleTask(id, card) {
  const state = loadDaily();
  state.day = todayKey();
  state.checked = state.checked || {};
  state.checked[id] = !state.checked[id];
  saveDaily(state);
  card.classList.toggle("done", state.checked[id]);
  const tasks = (BUNDLE.config.dailyTasks || {}).tasks || [];
  updateDailyProgress(tasks);
  if (state.checked[id]) burstConfetti(card);
}

function updateDailyProgress(tasks) {
  const checked = (loadDaily().checked) || {};
  const done = tasks.filter(t => checked[t.id]).length;
  const total = tasks.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  $("#dailyBar").style.width = pct + "%";
  $("#dailyCount").textContent = `${done}/${total} done`;

  const cel = $("#dailyCelebrate");
  const complete = total > 0 && done === total;
  if (complete && !cel.classList.contains("show")) {
    cel.classList.add("show", "pop");
    setTimeout(() => cel.classList.remove("pop"), 650);
    bumpStreak();
    bigConfetti();
  } else if (!complete && cel.classList.contains("show")) {
    cel.classList.remove("show");
    unbumpStreak();
  }
  renderStreak();
}

/* streak: increments the first time a day is completed; the completion day is
   stored so re-renders don't double-count. */
function bumpStreak() {
  const s = loadDaily();
  if (s.completedOn === todayKey()) return;
  const streak = JSON.parse(localStorage.getItem("enzo.streak") || "{}");
  const y = new Date(Date.now() - 864e5);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  streak.count = (streak.lastDay === yKey) ? (streak.count || 0) + 1 : 1;
  streak.lastDay = todayKey();
  if (!streak.best || streak.count > streak.best) streak.best = streak.count;
  localStorage.setItem("enzo.streak", JSON.stringify(streak));
  s.completedOn = todayKey(); saveDaily(s);
}
function unbumpStreak() {
  const s = loadDaily();
  if (s.completedOn !== todayKey()) return;
  const streak = JSON.parse(localStorage.getItem("enzo.streak") || "{}");
  streak.count = Math.max(0, (streak.count || 1) - 1);
  if (streak.count === 0) streak.lastDay = "";
  localStorage.setItem("enzo.streak", JSON.stringify(streak));
  delete s.completedOn; saveDaily(s);
}
function renderStreak() {
  const streak = JSON.parse(localStorage.getItem("enzo.streak") || "{}");
  const n = streak.count || 0;
  const el = $("#dailyStreak");
  el.innerHTML = `🔥 <b>${n}</b> day${n === 1 ? "" : "s"}` + (streak.best ? ` · best ${streak.best}` : "");
}

function burstConfetti(card) {
  const wrap = document.createElement("div");
  wrap.className = "confetti";
  for (let i = 0; i < 14; i++) {
    const s = document.createElement("span");
    s.style.left = Math.random() * 100 + "%";
    s.style.setProperty("--i", i);
    s.style.setProperty("--h", Math.floor(Math.random() * 360));
    wrap.appendChild(s);
  }
  card.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2200);
}
function bigConfetti() {
  const cel = $("#dailyCelebrate");
  const wrap = document.createElement("div");
  wrap.className = "confetti";
  for (let i = 0; i < 40; i++) {
    const s = document.createElement("span");
    s.style.left = Math.random() * 100 + "%";
    s.style.setProperty("--i", i);
    s.style.setProperty("--h", Math.floor(Math.random() * 360));
    wrap.appendChild(s);
  }
  cel.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2400);
}

/* ---------- clock + utils ---------- */
function tickClock() {
  const now = new Date();
  $("#clock-time").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("#clock-date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
function set(sel, v) { const el = $(sel); if (el) el.textContent = v; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function timeAgo(str) {
  const t = Date.parse(str);
  if (!isFinite(t)) return str || "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + " min ago";
  if (diff < 86400) return Math.round(diff / 3600) + " hr ago";
  return Math.round(diff / 86400) + " d ago";
}

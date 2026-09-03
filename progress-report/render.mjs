// Turn progress-report/data/model.json into a static report page. The page is
// screenshotted to a PNG for Notion, so it carries direct labels rather than a
// hover layer.
import fs from "node:fs";
import path from "node:path";
import { dataDir, reportHtml } from "./options.mjs";
const m = JSON.parse(fs.readFileSync(path.join(dataDir, "model.json"), "utf8"));

const C = {
  done: "#2a78d6", skipped: "#eb6834", retired: "#1baf7a",
  p1: "#184f95", p2: "#2a78d6", p3: "#86b6ef", other: "#a8a79f",
};
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const label = (iso) => {
  const d = new Date(iso + "T12:00:00Z");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------------------------------------------------------------- burn-down
function burndown(w, h) {
  const pad = { t: 26, r: 118, b: 40, l: 52 };
  const actual = m.series.map((s) => ({ d: s.d, v: s.remaining }));
  const proj = m.projection.map((s) => ({ d: s.d, v: s.remaining }));
  const all = [...actual, ...proj.slice(1)];
  const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / (all.length - 1);
  const yMax = Math.ceil(actual[0].v / 100) * 100;
  const y = (v) => pad.t + (1 - v / yMax) * (h - pad.t - pad.b);
  const idx = (d) => all.findIndex((a) => a.d === d);

  let grid = "";
  for (let v = 0; v <= yMax; v += 100) {
    grid += `<line x1="${pad.l}" y1="${y(v)}" x2="${w - pad.r}" y2="${y(v)}" stroke="#e8e7e3" stroke-width="1"/>`
      + `<text x="${pad.l - 10}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#8a8980">${v}</text>`;
  }
  const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(idx(p.d))},${y(p.v)}`).join(" ");
  const areaPath = `${line(actual)} L${x(idx(actual.at(-1).d))},${y(0)} L${x(0)},${y(0)} Z`;

  let ticks = "";
  for (const a of all) {
    const i = idx(a.d);
    const last = a.d === m.today;
    if (i % 2 === 0 || last) {
      ticks += `<text x="${x(i)}" y="${h - pad.b + 18}" text-anchor="middle" font-size="10.5" `
        + `fill="${last ? "#0b0b0b" : "#8a8980"}" font-weight="${last ? 600 : 400}">${label(a.d)}</text>`;
    }
  }
  const dots = actual
    .map((a) => `<circle cx="${x(idx(a.d))}" cy="${y(a.v)}" r="4" fill="${C.done}" stroke="#fcfcfb" stroke-width="2"/>`)
    .join("");

  const tx = x(idx(m.today)), ty = y(m.left);
  const fx = x(all.length - 1), fy = y(0);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + grid
    + `<path d="${areaPath}" fill="${C.done}" opacity="0.07"/>`
    + `<path d="${line(proj)}" fill="none" stroke="${C.done}" stroke-width="2" stroke-dasharray="6 5" opacity="0.55"/>`
    + `<path d="${line(actual)}" fill="none" stroke="${C.done}" stroke-width="2.5"/>`
    + dots
    + `<circle cx="${tx}" cy="${ty}" r="5.5" fill="${C.done}" stroke="#fcfcfb" stroke-width="2.5"/>`
    + `<text x="${tx}" y="${ty - 16}" text-anchor="middle" font-size="13" font-weight="650" fill="#0b0b0b">${m.left} left</text>`
    + `<circle cx="${fx}" cy="${fy}" r="5" fill="#fcfcfb" stroke="${C.done}" stroke-width="2.5"/>`
    + `<text x="${fx - 6}" y="${fy - 26}" text-anchor="end" font-size="13" font-weight="650" fill="#0b0b0b">${label(m.finish)}</text>`
    + `<text x="${fx - 6}" y="${fy - 11}" text-anchor="end" font-size="11" fill="#8a8980">at ${Math.round(m.rate)}/day</text>`
    + ticks
    + `<text x="${pad.l}" y="${h - 6}" font-size="10.5" fill="#a8a79f">Working days only. Weekends are not shown.</text>`
    + `</svg>`;
}

// ------------------------------------------------------------ cleared per day
function perDay(w, h) {
  const rows = m.series.filter((s) => s.cleared > 0);
  const pad = { t: 22, r: 8, b: 34, l: 34 };
  const max = Math.max(...rows.map((r) => r.cleared));
  const step = (w - pad.l - pad.r) / rows.length;
  const bw = Math.min(46, step - 14);
  const y = (v) => pad.t + (1 - v / (max * 1.18)) * (h - pad.t - pad.b);
  // A day's weight in the rate. Faded bars are the days that count least.
  const weightOf = (d) => (m.weights.find((x) => x.d === d) || { weight: 1 }).weight;
  let out = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cx = pad.l + step * i + step / 2;
    const op = (0.3 + 0.7 * weightOf(r.d)).toFixed(2);
    let base = y(0);
    for (const [k, col] of [["Done", C.done], ["Skipped", C.skipped], ["Retired", C.retired]]) {
      if (!r[k]) continue;
      const hh = (r[k] / (max * 1.18)) * (h - pad.t - pad.b);
      // 2px surface gap between the stacked segments
      out += `<rect x="${cx - bw / 2}" y="${base - hh}" width="${bw}" height="${Math.max(1, hh - 2)}" fill="${col}" rx="3" opacity="${op}"/>`;
      base -= hh;
    }
    out += `<text x="${cx}" y="${base - 7}" text-anchor="middle" font-size="12" font-weight="650" fill="#0b0b0b" opacity="${op}">${r.cleared}</text>`
      + `<text x="${cx}" y="${h - pad.b + 16}" text-anchor="middle" font-size="10.5" fill="#8a8980">${label(r.d)}</text>`
      + `<text x="${cx}" y="${h - pad.b + 28}" text-anchor="middle" font-size="9.5" fill="#c2c1b8">&times;${weightOf(r.d).toFixed(2)}</text>`;
  }
  out += `<line x1="${pad.l}" y1="${y(0)}" x2="${w - pad.r}" y2="${y(0)}" stroke="#d6d5d0" stroke-width="1"/>`
    + `<line x1="${pad.l}" y1="${y(m.rate)}" x2="${w - pad.r}" y2="${y(m.rate)}" stroke="#52514e" stroke-width="1.5" stroke-dasharray="4 4"/>`
    + `<text x="${pad.l + 4}" y="${y(m.rate) - 7}" font-size="10.5" font-weight="600" fill="#52514e">weighted rate, ${Math.round(m.rate)} a day</text>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out}</svg>`;
}

// ------------------------------------------------------ remaining by priority
function priority(w, h) {
  const other = (m.priorityLeft.none || 0) + (m.priorityLeft.Obsolete || 0);
  const rows = [
    { n: "Priority 1", v: m.priorityLeft["1"] || 0, c: C.p1 },
    { n: "Priority 2", v: m.priorityLeft["2"] || 0, c: C.p2 },
    { n: "Priority 3", v: m.priorityLeft["3"] || 0, c: C.p3 },
    { n: "Unset", v: other, c: C.other },
  ].filter((r) => r.v > 0);
  const max = Math.max(...rows.map((r) => r.v));
  const bl = 82, bw = w - bl - 46, bh = 22, gap = 15;
  let out = "";
  rows.forEach((r, i) => {
    const yy = 18 + i * (bh + gap);
    const len = Math.max(2, (r.v / max) * bw);
    out += `<text x="${bl - 10}" y="${yy + 15}" text-anchor="end" font-size="12" fill="#52514e">${r.n}</text>`
      + `<rect x="${bl}" y="${yy}" width="${len}" height="${bh}" fill="${r.c}" rx="4"/>`
      + `<text x="${bl + len + 9}" y="${yy + 16}" font-size="12.5" font-weight="650" fill="#0b0b0b">${r.v}</text>`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out}</svg>`;
}

const pct = Math.round(((m.total - m.left) / m.total) * 100);
const tiles = [
  { v: m.total, l: `cards in ${m.run}` },
  { v: m.total - m.left, l: `cleared (${pct}%)`, c: C.done },
  { v: m.left, l: "still to do" },
  { v: Math.round(m.rate), l: "cards per working day, weighted" },
  { v: label(m.finish), l: `finish, ${m.daysLeft} working days`, small: true },
];

const html = `<title>Bloom ${m.run} Test Run Progress</title>
<style>
  body { margin:0; background:#fcfcfb; color:#0b0b0b;
         font: 14px/1.45 "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  .page { width:1240px; padding:30px 34px 26px; box-sizing:border-box; }
  h1 { margin:0; font-size:23px; font-weight:680; letter-spacing:-0.01em; }
  .sub { color:#8a8980; font-size:12.5px; margin-top:4px; }
  .tiles { display:flex; gap:11px; margin:20px 0 22px; }
  .tile { flex:1; background:#fff; border:1px solid #eae9e5; border-radius:9px; padding:12px 15px; }
  .tile .v { font-size:27px; font-weight:690; letter-spacing:-0.02em; line-height:1.1; }
  .tile .v.sm { font-size:22px; }
  .tile .l { font-size:11.5px; color:#8a8980; margin-top:3px; }
  .card { background:#fff; border:1px solid #eae9e5; border-radius:9px; padding:14px 16px 8px; }
  .card h2 { margin:0 0 2px; font-size:13.5px; font-weight:640; }
  .card .note { margin:0 0 6px; font-size:11.5px; color:#8a8980; }
  .row { display:flex; gap:12px; margin-top:12px; align-items:stretch; }
  .legend { display:flex; gap:14px; font-size:11.5px; color:#52514e; margin-top:2px; }
  .legend i { width:10px; height:10px; border-radius:3px; display:inline-block; margin-right:5px; }
  .foot { margin-top:14px; font-size:11px; color:#a8a79f; }
</style>
<div class="page">
  <h1>Bloom ${m.run} test run &mdash; progress</h1>
  <div class="sub">As of ${label(m.today)} ${m.today.slice(0, 4)}. Started ${label(m.firstOfPass)}; ${m.workDays} working days so far.${m.droppedToday ? ` Today is still in progress, so it does not count toward the rate.` : ""}</div>

  <div class="tiles">
    ${tiles.map((t) => `<div class="tile"><div class="v${t.small ? " sm" : ""}"${t.c ? ` style="color:${t.c}"` : ""}>${esc(t.v)}</div><div class="l">${t.l}</div></div>`).join("")}
  </div>

  <div class="card">
    <h2>Cards left to clear</h2>
    <p class="note">Solid line: what happened. Dashed line: ${Math.round(m.rate)} cards per working day, held to the end. The plain average over all ${m.workDays} days is ${Math.round(m.plainRate)}.</p>
    ${burndown(1160, 300)}
  </div>

  <div class="row">
    <div class="card" style="flex:1.75">
      <h2>Cleared each working day</h2>
      <p class="note">A card is cleared when it goes to Done, Skipped or Retired. The rate weights each day by the factor below it, which halves every ${m.halfLifeDays} working days. The first days of a pass have few testers, so they count least.</p>
      <div class="legend">
        <span><i style="background:${C.done}"></i>Done</span>
        <span><i style="background:${C.skipped}"></i>Skipped (left out of this pass)</span>
        <span><i style="background:${C.retired}"></i>Retired (out of the suite)</span>
      </div>
      ${perDay(690, 210)}
    </div>
    <div class="card" style="flex:1">
      <h2>The ${m.left} cards that are left</h2>
      <p class="note">By priority.</p>
      ${priority(400, 190)}
    </div>
  </div>

  <p class="foot">Done is dated by the Tested On property. Skipped and Retired have no date property, so the last edit to the card stands in for it.</p>
</div>
<script>
  // run.mjs reads this to size the screenshot window, so the PNG holds the
  // whole page and no blank strip below it.
  document.documentElement.setAttribute(
    "data-page-height",
    String(Math.ceil(document.querySelector(".page").getBoundingClientRect().height)),
  );
</script>`;
fs.writeFileSync(reportHtml, html);
console.log(`wrote ${reportHtml}`);

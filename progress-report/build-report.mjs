// Compute the progress statistics for one suite run from the local snapshot at
// progress-report/data/cards.json, and write progress-report/data/model.json.
// This step reads no network.
//
//   node build-report.mjs [--run 6.5] [--eod] [--half-life N] [--as-of YYYY-MM-DD]
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argFlag, argValue, dataDir } from "./options.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// The rate is an exponentially weighted average, not a plain one. A pass starts
// with two or three testers and reaches full strength days later, so the early
// days predict badly. Each working day counts half as much as the day after it,
// per this many working days. Lower it to follow recent days more closely.
const HALF_LIFE_DAYS = Number(argValue("--half-life") || 2);

// Where one pass ends and the next begins. Cards trickle in between passes, so
// the pass is taken to start after the last stretch of this many working days
// with nothing cleared.
const GAP_DAYS = 5;

// At the end of the workday the current day is complete and belongs in the rate.
// At the start of the workday it is empty or nearly so, and it would drag the
// rate toward zero at full weight, so it is left out by default.
// Report as of the end of an earlier day. Cards cleared after that day are
// treated as still open, and the day itself is taken as complete, so it counts
// in the rate as --eod would. Lets a report be rebuilt for a day that was missed.
const AS_OF = argValue("--as-of") || null;
if (AS_OF && !/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) throw new Error("--as-of wants a date as YYYY-MM-DD");
const endOfDay = argFlag("--eod") || Boolean(AS_OF);

const cards = JSON.parse(fs.readFileSync(path.join(dataDir, "cards.json"), "utf8"));

// ---------------------------------------------------------------- date helpers
const day = (iso) => iso.slice(0, 10);
const isWeekday = (iso) => {
  const d = new Date(iso + "T12:00:00Z").getUTCDay();
  return d >= 1 && d <= 5;
};
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const nextWorkday = (iso) => {
  let d = addDays(iso, 1);
  while (!isWeekday(d)) d = addDays(d, 1);
  return d;
};
const prevWorkday = (iso) => {
  let d = addDays(iso, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
};
const workdaysBetween = (from, to) => {
  let n = 0;
  for (let d = nextWorkday(from); d <= to; d = nextWorkday(d)) n += 1;
  return n;
};

// ------------------------------------------------------------ pick the run
// The newest suite run, unless one is named. Tags are version numbers, so they
// are compared part by part; a plain string sort would put 6.10 below 6.3.
const cmpVersion = (a, b) => {
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d;
  }
  return 0;
};
const tags = [...new Set(cards.map((c) => c["Test Suite Run"]).filter(Boolean))]
  .filter((t) => /^\d+(\.\d+)*$/.test(t))
  .sort(cmpVersion);
const RUN = argValue("--run") || tags.at(-1);
if (!RUN) throw new Error("no suite run found in the snapshot");
const run = cards.filter((c) => c["Test Suite Run"] === RUN);
if (!run.length) throw new Error(`suite run ${RUN} holds no cards`);

const TOTAL = run.length;

// --------------------------------------------------------- clearing events
// When each card left the queue. Done carries a real `Tested On` date; Skipped
// and Retired have no date property, so the last edit stands in for it.
const clearedOn = (c) => {
  if (c.Status === "Done" && c["Tested On"]) return day(c["Tested On"]);
  if (c.Status === "Skipped" || c.Status === "Retired") return day(c.lastEditedTime);
  return null;
};
// A card is cleared for this report if it cleared on or before the as-of day.
const isCleared = (c) => { const d = clearedOn(c); return Boolean(d) && (!AS_OF || d <= AS_OF); };
const events = [];
for (const c of run) if (isCleared(c)) events.push({ k: c.Status, d: clearedOn(c) });
if (!events.length) throw new Error(`suite run ${RUN} has cleared no cards yet`);
const KINDS = ["Done", "Skipped", "Retired"];
const perDay = new Map();
for (const e of events) {
  if (!perDay.has(e.d)) perDay.set(e.d, { Done: 0, Skipped: 0, Retired: 0 });
  perDay.get(e.d)[e.k] += 1;
}

// ------------------------------------------------------- find the pass start
// Walk back from the last active day. A stretch of GAP_DAYS working days with
// nothing cleared marks the end of the previous pass.
const activeDays = [...perDay.keys()].sort();
const lastActive = activeDays.at(-1);
let firstOfPass = lastActive;
for (let i = activeDays.length - 1; i > 0; i--) {
  const gap = workdaysBetween(activeDays[i - 1], activeDays[i]) - 1;
  if (gap >= GAP_DAYS) break;
  firstOfPass = activeDays[i - 1];
}
// The anchor is the working day before the first cleared card, so the burn-down
// starts from a full queue.
const anchor = prevWorkday(firstOfPass);

// The reporting day: the real date, pulled back to a working day.
let today = AS_OF || new Date().toISOString().slice(0, 10);
while (!isWeekday(today)) today = prevWorkday(today);
if (today < lastActive) today = lastActive;

const before = { Done: 0, Skipped: 0, Retired: 0 };
for (const [d, v] of perDay) if (d <= anchor) for (const k of KINDS) before[k] += v[k];
const beforeTotal = KINDS.reduce((s, k) => s + before[k], 0);

const days = [];
for (let d = anchor; d <= today; d = addDays(d, 1)) if (isWeekday(d)) days.push(d);

let remaining = TOTAL - beforeTotal;
const series = [];
for (const d of days) {
  const v = perDay.get(d) || { Done: 0, Skipped: 0, Retired: 0 };
  const cleared = KINDS.reduce((s, k) => s + v[k], 0);
  remaining -= cleared;
  series.push({ d, ...v, cleared, remaining });
}

// Status counts as of the reporting day: a card cleared after it is still open.
const status = {};
for (const c of run) {
  const k = isCleared(c) ? c.Status : clearedOn(c) ? "Open" : c.Status;
  status[k] = (status[k] || 0) + 1;
}
const left = run.filter((c) => !isCleared(c)).length;
const clearedInPass = series.reduce((s, r) => s + r.cleared, 0);

// --------------------------------------------------------------- the rate
// Weight each working day by 0.5 ^ (age / HALF_LIFE_DAYS), where the age counts
// working days back from the newest day in the rate. The result tracks the pace
// the team works at now, and it needs no hand-set start date.
let worked = series.slice(1);
const droppedToday = !endOfDay && worked.length > 1 && worked.at(-1).d === today;
if (droppedToday) worked = worked.slice(0, -1);
const weighted = worked.map((r, i) => ({
  ...r,
  weight: Math.pow(0.5, (worked.length - 1 - i) / HALF_LIFE_DAYS),
}));
const weightSum = weighted.reduce((s, r) => s + r.weight, 0);
const rate = weighted.reduce((s, r) => s + r.weight * r.cleared, 0) / weightSum;
const plainRate = worked.reduce((s, r) => s + r.cleared, 0) / worked.length;

const daysLeft = Math.ceil(left / rate);
let finish = today;
for (let i = 0; i < daysLeft; i++) finish = nextWorkday(finish);

// The projection: a straight line from today's remaining count to zero.
const projection = [{ d: today, remaining: left }];
let p = today, r = left;
for (let i = 0; i < daysLeft; i++) {
  p = nextWorkday(p);
  r = Math.max(0, r - rate);
  projection.push({ d: p, remaining: r });
}

const priorityLeft = {};
for (const c of run) {
  if (!isCleared(c)) {
    const k = c.Priority || "none";
    priorityLeft[k] = (priorityLeft[k] || 0) + 1;
  }
}

const model = {
  run: RUN, total: TOTAL, status, left, series, projection,
  anchor, firstOfPass, today, endOfDay, droppedToday, asOf: AS_OF,
  before, beforeTotal, clearedInPass, workDays: days.length - 1,
  halfLifeDays: HALF_LIFE_DAYS,
  weights: weighted.map((x) => ({ d: x.d, weight: Number(x.weight.toFixed(3)) })),
  plainRate: Number(plainRate.toFixed(1)),
  rate: Number(rate.toFixed(1)), daysLeft, finish, priorityLeft,
};
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "model.json"), JSON.stringify(model, null, 2) + "\n");
console.log(
  `run ${RUN}${AS_OF ? ` as of end of ${AS_OF}` : ""}: ${TOTAL} cards, ${left} left, ${model.rate}/day weighted, ` +
    `finish ${finish} (${daysLeft} working days)` +
    (droppedToday ? `; ${today} is left out of the rate (pass --eod to include it)` : ""),
);

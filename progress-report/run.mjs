// The one entry point. Pulls the live data, computes the statistics, builds the
// page, and writes the PNG for Notion.
//
//   node run.mjs [--eod] [--run 6.5] [--half-life N] [--no-fetch] [--open]
//
// Needs the Notion token in BLOOM_TESTCASE_NOTION (or NOTION_TOKEN).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argFlag, dataDir, reportHtml, outDir } from "./options.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const passThrough = process.argv.slice(2).filter((a) => a !== "--no-fetch" && a !== "--open");

function step(script, args = []) {
  const r = spawnSync(node, [path.join(here, script), ...args], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Chrome renders the page. CHROME overrides the search for it.
function findChrome() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error("no Chrome or Edge found; set the CHROME environment variable to the browser");
  }
  return found;
}

if (!argFlag("--no-fetch")) step("fetch-data.mjs");
step("build-report.mjs", passThrough);
step("render.mjs");

const model = JSON.parse(fs.readFileSync(path.join(dataDir, "model.json"), "utf8"));
fs.mkdirSync(outDir, { recursive: true });
// A dated copy keeps the history; progress.png is the one to upload.
const dated = path.join(outDir, `progress-${model.run}-${model.today}.png`);
const latest = path.join(outDir, "progress.png");

// The page is 1240 CSS px wide. The height must hold the whole page, and Chrome
// clips whatever does not fit, so it is measured from the rendered page first.
const chrome = findChrome();
const base = [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2",
];
const url = "file:///" + reportHtml.replace(/\\/g, "/");
const measured = spawnSync(chrome, [...base, "--window-size=1240,400",
  "--virtual-time-budget=2000", "--dump-dom", url], { encoding: "utf8" });
// The page height is fixed by its content, so a generous window plus a measured
// crop is not needed; the page reports its own height through a data attribute.
const heightMatch = /data-page-height="(\d+)"/.exec(measured.stdout || "");
const height = heightMatch ? Number(heightMatch[1]) : 950;

const shot = spawnSync(chrome, [...base, `--window-size=1240,${height}`,
  `--screenshot=${dated}`, url], { encoding: "utf8" });
if (shot.status !== 0 || !fs.existsSync(dated)) {
  console.error(shot.stderr || "the screenshot failed");
  process.exit(1);
}
fs.copyFileSync(dated, latest);
console.log(`wrote ${latest}`);
console.log(`      ${dated}`);

if (argFlag("--open")) spawnSync("cmd", ["/c", "start", "", latest], { stdio: "ignore" });

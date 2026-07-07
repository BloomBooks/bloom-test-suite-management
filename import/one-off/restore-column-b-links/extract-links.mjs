// One-off (2026-07): the "Pre-beta tests" sheet's column B contained hyperlinks
// (on text runs) that the CSV export dropped. This script parses an HTML export
// of that sheet (File > Download > Web Page) and records, for every row whose
// column B has links, the rendered cell text plus each link's anchor text,
// href, and character offsets within the cell text.
//
// Usage: node extract-links.mjs <path-to-Pre-Beta tests.html>
// Output: colB-links.json next to this script.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error("usage: node extract-links.mjs <Pre-Beta tests.html>");
  process.exit(1);
}
const html = readFileSync(htmlPath, "utf8");
const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "colB-links.json");

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Render an HTML fragment (with no <a> tags) to plain text.
function textify(fragment) {
  return decodeEntities(
    fragment.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, ""),
  );
}

// Render a cell to plain text while recording each http(s) anchor's span.
function parseCell(cellHtml) {
  let text = "";
  const links = [];
  const anchorRe = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let last = 0;
  let match;
  while ((match = anchorRe.exec(cellHtml))) {
    text += textify(cellHtml.slice(last, match.index));
    const href = decodeEntities(match[1]);
    const anchorText = textify(match[2]);
    if (/^https?:\/\//.test(href)) {
      links.push({
        text: anchorText,
        href,
        start: text.length,
        end: text.length + anchorText.length,
      });
    }
    text += anchorText;
    last = anchorRe.lastIndex;
  }
  text += textify(cellHtml.slice(last));
  return { text, links };
}

const rows = html.split(/<tr[ >]/).slice(1);
const out = [];
for (const row of rows) {
  const mNum = row.match(/<th[^>]*>(?:<div[^>]*>)?(\d+)/);
  if (!mNum) continue;
  const rowNum = Number(mNum[1]);
  const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  if (tds.length < 2) continue;
  const colA = textify(tds[0]).trim();
  const { text, links } = parseCell(tds[1]);
  if (!links.length) continue;
  out.push({ rowNum, colA, text, links });
}

writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`rows with column-B links: ${out.length} -> ${outPath}`);

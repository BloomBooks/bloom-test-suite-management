// One-off (2026-07): restore the column-B hyperlinks that the sheet->CSV
// export dropped (see extract-links.mjs / colB-links.json).
//
// For each linked sheet row that was imported as a test case:
//   - Links whose URL is already recoverable from the visible text are skipped:
//     a `BL-####` anchor pointing at that issue's standard YouTrack URL, or an
//     anchor that is the bare URL itself (the importer's linkifyRichText()
//     already renders those as links).
//   - For genuinely lost links ("VM notes", "this book", "Sample", ...):
//       * test-case-runs.json — every run record of the case gets the URL in
//         parens after the anchor text in originalDescription / description /
//         caseSnapshot; the checklist item corresponding to the linked
//         occurrence gets the same inline treatment; if no item mentions the
//         anchor, a "See <anchor> (<url>)." note is appended to stepNotes and
//         bodyChecklistItems.
//       * Notion (6.4 + 6.5 cards only) — the "Original Description" property
//         is rewritten with the anchor text as a real link; the body block
//         matching the edited checklist item is re-rendered with the anchor
//         linked; links with no matching block get a "See <anchor>." to-do
//         appended.
//   - Anything ambiguous is NOT changed; it is recorded in report.json for
//     manual evaluation.
//
// Usage: node restore-links.mjs [--dry-run]
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadJson,
  saveJson,
  execNotionJson,
  listChildren,
  updatePage,
  appendChildren,
  normalizePageId,
  linkifyRichText,
  pushTextFragments,
  toDoBlockFromRichText,
} from "../../../lib/notion.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RUNS_PATH = path.join(repoRoot, "import/output/test-case-runs.json");
const LINKS_PATH = path.join(here, "colB-links.json");
const REPORT_PATH = path.join(here, "report.json");
const CONFIG = loadJson(path.join(repoRoot, "notion-config.json"));
const DB_ID = normalizePageId(CONFIG.databases.testCaseRuns);

const PILOT_ROW = 8; // legacy 2005, restored by hand as the pilot
const YOUTRACK_ISSUE =
  /^https?:\/\/(?:issues\.bloomlibrary\.org|silbloom\.myjetbrains\.com)\/youtrack\/issue\/(BL-\d+)/i;

const rows = loadJson(LINKS_PATH);
const runs = loadJson(RUNS_PATH);
const byRow = new Map();
for (const r of runs) {
  if (typeof r.sourceRowNumber !== "number") continue;
  if (!byRow.has(r.sourceRowNumber)) byRow.set(r.sourceRowNumber, []);
  byRow.get(r.sourceRowNumber).push(r);
}

const report = { changedRows: [], coveredRows: [], flagged: [] };
const flag = (row, what) =>
  report.flagged.push({ row: row.rowNum, colA: row.colA, ...what });

// --- text helpers -----------------------------------------------------------
const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").replace(/ /g, " ");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWordChar = (c) => /[A-Za-z0-9]/.test(c || "");

// Map an index in the \r\n-normalized string back to the raw string.
function rawIndex(raw, normIdx) {
  let r = 0;
  let n = 0;
  while (n < normIdx && r < raw.length) {
    if (raw[r] === "\r" && raw[r + 1] === "\n") {
      r += 1; // the \r is invisible in the normalized string
      continue;
    }
    r += 1;
    n += 1;
  }
  return r;
}

function extendWordEnd(text, idx) {
  while (idx < text.length && isWordChar(text[idx])) idx += 1;
  return idx;
}

function countOccurrences(hay, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

function nthOccurrence(hay, needle, n) {
  let at = -1;
  let from = 0;
  for (let k = 0; k <= n; k += 1) {
    at = hay.indexOf(needle, from);
    if (at < 0) return -1;
    from = at + 1;
  }
  return at;
}

// Find `anchor` in `text`, requiring word boundaries and, between `minCtx`
// and `maxCtx`, the last words preceding the anchor in the source cell in
// front of it. Returns the anchor's index, or -1. Longer context wins.
function anchorPos(text, anchor, ctxWords, maxCtx, minCtx = 0) {
  for (let k = Math.min(maxCtx, ctxWords.length); k >= minCtx; k -= 1) {
    const ctx = ctxWords.slice(ctxWords.length - k);
    const tail = isWordChar(anchor[anchor.length - 1]) ? "(?![A-Za-z0-9])" : "";
    const head = k === 0 && isWordChar(anchor[0]) ? "(?<![A-Za-z0-9])" : "";
    const body =
      (k > 0 ? ctx.map(escapeRe).join("\\s+") + "\\s+" : "") +
      `(${escapeRe(anchor)})` +
      tail;
    const m = new RegExp(head + body).exec(text);
    if (m) return m.index + m[0].lastIndexOf(m[1]);
  }
  return -1;
}

// Rich text: linkified segments with explicit link spans layered on top.
// (linkifyRichText drops whitespace-only segments, so those are pushed raw.)
function buildRichWithSpans(textNorm, spans) {
  const fragments = [];
  let last = 0;
  const pushPlain = (segment) => {
    if (!segment) return;
    if (segment.trim()) fragments.push(...linkifyRichText(segment));
    else pushTextFragments(fragments, segment);
  };
  for (const span of spans) {
    pushPlain(textNorm.slice(last, span.start));
    pushTextFragments(fragments, textNorm.slice(span.start, span.end), span.href);
    last = span.end;
  }
  pushPlain(textNorm.slice(last));
  return fragments;
}

function insertAt(text, idx, insertion) {
  return text.slice(0, idx) + insertion + text.slice(idx);
}

const ITEM_ARRAYS = ["checklistSteps", "stepNotes", "bodyChecklistItems"];

// --- main -------------------------------------------------------------------
let jsonDirty = false;

for (const row of rows) {
  if (row.rowNum === PILOT_ROW) {
    report.changedRows.push({
      row: 8,
      colA: row.colA,
      note: "pilot (legacy 2005), done previously",
    });
    continue;
  }

  const cellNorm = norm(row.text);

  // Trim anchors (some carry trailing spaces/newlines from the sheet) and
  // classify each link.
  const restoreLinks = [];
  const covered = [];
  for (const rawLink of row.links) {
    const lead = rawLink.text.length - rawLink.text.trimStart().length;
    const trail = rawLink.text.length - rawLink.text.trimEnd().length;
    const link = {
      text: rawLink.text.trim(),
      href: rawLink.href,
      start: rawLink.start + lead,
      end: rawLink.end - trail,
    };
    if (!link.text) {
      flag(row, { link: rawLink, reason: "anchor has no visible text" });
      continue;
    }
    const yt = link.href.match(YOUTRACK_ISSUE);
    if (yt && cellNorm.toUpperCase().includes(yt[1].toUpperCase())) {
      covered.push({ text: link.text, href: link.href, why: "BL id visible in text (auto-linked)" });
      continue;
    }
    if (cellNorm.includes(link.href) || cellNorm.includes(link.href.replace(/\/$/, ""))) {
      covered.push({ text: link.text, href: link.href, why: "bare URL visible in text (auto-linked)" });
      continue;
    }
    restoreLinks.push(link);
  }

  if (!restoreLinks.length) {
    report.coveredRows.push({ row: row.rowNum, colA: row.colA, covered });
    continue;
  }

  const records = byRow.get(row.rowNum) || [];
  if (!records.length) {
    flag(row, {
      links: restoreLinks.map((l) => ({ text: l.text, href: l.href })),
      reason: "sheet row was not imported as a test case (header/context/ignored row)",
    });
    continue;
  }

  const rec0 = records[0];
  const origRaw = rec0.originalDescription;
  if (records.some((r) => r.originalDescription !== origRaw)) {
    flag(row, { reason: "run records of this case disagree on originalDescription" });
    continue;
  }
  if (restoreLinks.some((l) => origRaw.includes(l.href))) {
    flag(row, { reason: "originalDescription already contains a restored URL (already processed?)" });
    continue;
  }
  const origNorm = norm(origRaw);

  // Align the cell text with originalDescription (prepare-import trimmed it).
  const trimStart = cellNorm.length - cellNorm.trimStart().length;
  const aligned =
    cellNorm.slice(trimStart, trimStart + origNorm.length) === origNorm
      ? -trimStart
      : null;

  // Locate each restore anchor inside originalDescription (normalized), and
  // capture its left-context words for checklist-item disambiguation.
  const spans = [];
  for (const link of restoreLinks) {
    let at = -1;
    if (
      aligned !== null &&
      link.start + aligned >= 0 &&
      origNorm.slice(link.start + aligned, link.end + aligned) === link.text
    ) {
      at = link.start + aligned;
    } else {
      const before = countOccurrences(cellNorm.slice(0, link.start), link.text);
      at = nthOccurrence(origNorm, link.text, before);
      if (at < 0) at = origNorm.indexOf(link.text);
    }
    if (at < 0) {
      flag(row, {
        link: { text: link.text, href: link.href },
        reason: "anchor text not found in originalDescription",
      });
      continue;
    }
    const lineStart = origNorm.lastIndexOf("\n", at) + 1;
    const ctxWords = origNorm.slice(lineStart, at).trim().split(/\s+/).filter(Boolean);
    spans.push({
      start: at,
      end: at + link.text.length,
      text: link.text,
      href: link.href,
      ctxWords,
    });
  }
  if (!spans.length) continue;
  spans.sort((a, b) => a.start - b.start);

  const rowChange = {
    row: row.rowNum,
    colA: row.colA,
    testCaseId: rec0.testCaseId,
    title: rec0.title,
    suiteRuns: records.map((r) => r.suiteRunTag),
    links: [],
    covered,
    notion: [],
  };

  // --- resolve checklist-item edits against the PRE-edit items -------------
  const preItems = [...new Set(ITEM_ARRAYS.flatMap((a) => rec0[a] || []))];
  const editsByItem = new Map(); // preEditText -> [{pos, len, href}]
  const noteSpans = [];
  for (const span of spans) {
    if (preItems.some((item) => item.includes(span.href))) {
      rowChange.links.push({ text: span.text, href: span.href, action: "already present; skipped" });
      continue;
    }
    const candidates = preItems
      .map((item) => ({ item, pos: anchorPos(item, span.text, span.ctxWords, 0) }))
      .filter((c) => c.pos >= 0);
    let chosen = null;
    if (candidates.length === 1) {
      // Unique item: refine the position with context in case the anchor
      // occurs twice within it.
      chosen = {
        item: candidates[0].item,
        pos: anchorPos(candidates[0].item, span.text, span.ctxWords, 3),
      };
    } else if (candidates.length > 1) {
      // Require at least one matching context word to disambiguate.
      const contextual = preItems
        .map((item) => ({ item, pos: anchorPos(item, span.text, span.ctxWords, 3, 1) }))
        .filter((c) => c.pos >= 0);
      if (contextual.length === 1) {
        chosen = contextual[0];
      } else {
        flag(row, {
          link: { text: span.text, href: span.href },
          reason: `anchor matches ${candidates.length} checklist items and context cannot disambiguate; description/property linked, checklist/body left unchanged`,
        });
        rowChange.links.push({ text: span.text, href: span.href, action: "inline (description only; steps ambiguous, see flag)" });
        continue;
      }
    }
    if (chosen) {
      if (!editsByItem.has(chosen.item)) editsByItem.set(chosen.item, []);
      editsByItem.get(chosen.item).push({ pos: chosen.pos, len: span.text.length, href: span.href });
      rowChange.links.push({ text: span.text, href: span.href, action: "inline (description + step)" });
    } else {
      // No checklist item mentions the anchor: append a note (like the pilot),
      // unless the anchor has ragged (mid-word) boundaries in the source.
      const startRagged = span.start > 0 && isWordChar(origNorm[span.start - 1]);
      const endRagged = isWordChar(origNorm[span.end]);
      if (startRagged || endRagged) {
        flag(row, {
          link: { text: span.text, href: span.href },
          reason: "anchor has mid-word boundaries and no matching checklist item; appended note skipped (description/property still linked)",
        });
        rowChange.links.push({ text: span.text, href: span.href, action: "inline (description only; note skipped, see flag)" });
      } else {
        noteSpans.push(span);
        rowChange.links.push({ text: span.text, href: span.href, action: "appended note" });
      }
    }
  }

  // Materialize the item edits (insert right-to-left so positions stay valid).
  const editMap = new Map(); // preEditText -> newText
  const blockSpecs = new Map(); // preEditText -> ascending [{start,end,href}] for Notion
  for (const [item, edits] of editsByItem) {
    let newText = item;
    for (const e of [...edits].sort((a, b) => b.pos - a.pos)) {
      newText = insertAt(newText, extendWordEnd(item, e.pos + e.len), ` (${e.href})`);
    }
    editMap.set(item, newText);
    if (DRY_RUN) console.log(`row ${row.rowNum}:\n  - ${item}\n  + ${newText}`);
    blockSpecs.set(
      item,
      [...edits]
        .sort((a, b) => a.pos - b.pos)
        .map((e) => ({ start: e.pos, end: e.pos + e.len, href: e.href })),
    );
  }

  // --- apply to the json records --------------------------------------------
  let origNewRaw = origRaw;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const insNorm = extendWordEnd(origNorm, span.end);
    origNewRaw = insertAt(origNewRaw, rawIndex(origRaw, insNorm), ` (${span.href})`);
  }
  for (const rec of records) {
    rec.originalDescription = origNewRaw;
    for (const field of ["description", "caseSnapshot"]) {
      if (typeof rec[field] === "string" && rec[field].includes(origRaw)) {
        rec[field] = rec[field].replace(origRaw, origNewRaw);
      } else {
        flag(row, {
          reason: `field ${field} (run ${rec.suiteRunTag}) did not contain the original description verbatim; left unchanged`,
        });
      }
    }
    for (const arrName of ITEM_ARRAYS) {
      const arr = rec[arrName];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i += 1) {
        if (editMap.has(arr[i])) arr[i] = editMap.get(arr[i]);
      }
    }
    for (const span of noteSpans) {
      const note = `See ${span.text} (${span.href}).`;
      if (Array.isArray(rec.stepNotes) && !rec.stepNotes.includes(note)) rec.stepNotes.push(note);
      if (Array.isArray(rec.bodyChecklistItems) && !rec.bodyChecklistItems.includes(note)) {
        rec.bodyChecklistItems.push(note);
      }
    }
  }
  jsonDirty = true;

  // --- update the Notion 6.4 / 6.5 cards ------------------------------------
  if (!DRY_RUN) {
    const query = await execNotionJson("POST", `databases/${DB_ID}/query`, {
      filter: {
        and: [
          { property: "Test Case ID", number: { equals: rec0.testCaseId } },
          {
            or: [
              { property: "Test Suite Run", select: { equals: "6.4" } },
              { property: "Test Suite Run", select: { equals: "6.5" } },
            ],
          },
        ],
      },
    });
    const cards = query.results || [];
    if (!cards.length) {
      rowChange.notion.push({ note: "no 6.4/6.5 cards (case's runs predate 6.4); json updated only" });
    }
    for (const card of cards) {
      const tag = card.properties["Test Suite Run"]?.select?.name;
      const cardInfo = { tag, pageId: card.id, blocksLinked: 0, notesAppended: 0 };

      // Original Description property: pre-edit text with anchor spans linked.
      await updatePage(card.id, {
        "Original Description": { rich_text: buildRichWithSpans(origNorm, spans) },
      });

      // Body blocks: patch the blocks whose text equals an edited item.
      const children = await listChildren(card.id);
      if (children.has_more) {
        flag(row, { reason: `card ${tag} body has >100 blocks; not fully scanned` });
      }
      const blocks = (children.results || []).filter(
        (b) => b.type === "to_do" || b.type === "paragraph",
      );
      const matchedItems = new Set();
      for (const block of blocks) {
        const rt = block[block.type].rich_text || [];
        const plain = rt.map((t) => t.plain_text).join("");
        // Patching is idempotent: the rich text is rebuilt from the plain text
        // (which inline link edits never change) plus the anchor spans.
        const match = [...blockSpecs.keys()].find((item) => item.trim() === plain.trim());
        if (!match) continue;
        matchedItems.add(match);
        // items and blocks are both trimmed in practice; positions transfer 1:1
        await execNotionJson("PATCH", `blocks/${normalizePageId(block.id)}`, {
          [block.type]: { rich_text: buildRichWithSpans(plain, blockSpecs.get(match)) },
        });
        cardInfo.blocksLinked += 1;
      }
      for (const item of blockSpecs.keys()) {
        if (!matchedItems.has(item)) {
          flag(row, {
            reason: `card ${tag}: no body block matched the edited checklist item; body not updated for that item`,
            item,
          });
        }
      }

      // Appended notes for links no checklist item mentions.
      const toAppend = [];
      for (const span of noteSpans) {
        const notePlain = `See ${span.text}.`;
        const exists = blocks.some(
          (b) => (b[b.type].rich_text || []).map((t) => t.plain_text).join("").trim() === notePlain,
        );
        if (exists) continue;
        const fragments = [];
        pushTextFragments(fragments, "See ");
        pushTextFragments(fragments, span.text, span.href);
        pushTextFragments(fragments, ".");
        toAppend.push(toDoBlockFromRichText(fragments));
      }
      if (toAppend.length) {
        await appendChildren(card.id, toAppend);
        cardInfo.notesAppended = toAppend.length;
      }
      rowChange.notion.push(cardInfo);
      console.log(
        `row ${row.rowNum} [${row.colA || "-"}] ${tag}: property updated, ${cardInfo.blocksLinked} block(s) linked, ${cardInfo.notesAppended} note(s) appended`,
      );
    }
  }

  report.changedRows.push(rowChange);
}

if (jsonDirty && !DRY_RUN) {
  saveJson(RUNS_PATH, runs);
  console.log("test-case-runs.json saved");
}
saveJson(REPORT_PATH, report);
console.log(
  `done. changed rows: ${report.changedRows.length}, fully-covered rows: ${report.coveredRows.length}, flags: ${report.flagged.length}${DRY_RUN ? " (dry run, nothing written)" : ""}`,
);

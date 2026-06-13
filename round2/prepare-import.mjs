import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const round2Dir = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.resolve(
  process.argv[2] || path.join(round2Dir, "..", "Bloom Test Plan.csv"),
);
const outDir = path.resolve(process.argv[3] || path.join(round2Dir, "build"));
const caseLimit = Number(process.env.ROUND2_LIMIT_CASES || "10");

const ALLOWED_PRIORITIES = new Map([
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
  ["IGNORE", "Ignore"],
  ["DUP", "Duplicate"],
  ["DUPLICATE", "Duplicate"],
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(value);
      value = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function clean(value) {
  return (value ?? "").trim();
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Suite run display names drop the "BetaInternal" qualifier (e.g.
// "5.4 BetaInternal" -> "5.4"). The slugified key is recomputed from the
// normalized name so it stays consistent with the display tag.
function normalizeSuiteRunName(name) {
  return clean(name)
    .replace(/betainternal/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureWidth(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  for (const row of rows) {
    while (row.length < width) {
      row.push("");
    }
  }
  return width;
}

function ensureImportIdColumn(rows) {
  const headerRow = rows[1] ?? [];
  if (headerRow[0] === "Import ID") {
    return;
  }

  for (const row of rows) {
    row.unshift("");
  }
  rows[1][0] = "Import ID";
}

function normalizePriority(value) {
  const normalized = clean(value).toUpperCase();
  return ALLOWED_PRIORITIES.get(normalized) ?? "";
}

function looksImportableRow(row, baseIndex, runStart) {
  const priority = normalizePriority(row[baseIndex.priority]);
  const docId = clean(row[baseIndex.dokimion]);
  const description = clean(row[baseIndex.description]);
  const sourceRef = clean(row[baseIndex.legacyNumber]);
  const hasRunData = row.slice(runStart).some((cell) => clean(cell) !== "");

  if (!hasRunData && !priority && !docId && !description && !sourceRef) {
    return false;
  }

  if (priority || (docId && hasRunData) || (sourceRef && hasRunData)) {
    return true;
  }

  return false;
}

function buildImportId(row, rowNumber, baseIndex) {
  const sourceRef = clean(row[baseIndex.legacyNumber]);
  const docId = clean(row[baseIndex.dokimion]);

  if (sourceRef) {
    return `src-${slugify(sourceRef)}`;
  }

  if (docId) {
    return `src-${slugify(docId)}-r${rowNumber}`;
  }

  return `src-r${rowNumber}`;
}

// Cleaned form of the raw description that KEEPS line breaks: each line is
// trimmed, has any leading bullet dash removed, and its internal whitespace
// collapsed; empty lines are dropped. This is the card body (caseSnapshot).
function cleanSnapshot(text) {
  return clean(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-\s]+/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

// Extract the version label (e.g. "4.9 Spot Testing") used as a fallback
// suite-run name when a column group has no top-header label.
function extractVersionLabel(rawLabel, fieldLabel) {
  const source = clean(rawLabel) || clean(fieldLabel);
  const versionMatch = source.match(/\d+(?:\.\d+)?(?:\s+[A-Za-z][A-Za-z0-9]*)?/);
  return versionMatch ? versionMatch[0].trim() : source;
}

// Detection stops when it reaches this top-header label. Everything from the
// 4.7 FX column leftward (older, platform-split "Person testing" columns) is
// intentionally excluded -- that region's column layout is irregular and was
// mis-parsed, so we cut the import off before it. See round2/schema.md.
const STOP_AT_TOP_HEADER = "4.7 fx";

function detectSlots(headerTop, headerBottom, runStart) {
  const slots = [];
  let column = runStart;

  while (column < headerBottom.length) {
    const field = clean(headerBottom[column]);
    const top = clean(headerTop[column]);

    if (!field && !top) {
      column += 1;
      continue;
    }

    if (top.toLowerCase() === STOP_AT_TOP_HEADER) {
      break;
    }

    if (/^date this test last caught a problem anywhere$/i.test(field)) {
      break;
    }

    const quintet = headerBottom.slice(column, column + 5).map(clean);
    const isQuintet =
      /^person$/i.test(quintet[0] || "") &&
      /^date$/i.test(quintet[1] || "") &&
      /^build/i.test(quintet[2] || "") &&
      /^issue\(s\)$/i.test(quintet[3] || "") &&
      /^ok\?$/i.test(quintet[4] || "");

    if (isQuintet) {
      const labels = headerTop
        .slice(column, column + 5)
        .map(clean)
        .filter(Boolean);
      const headerLabel = labels[0] || "";
      const versionLabel = extractVersionLabel(headerLabel, field);
      slots.push({
        startColumn: column,
        headerLabel,
        suiteRunName: headerLabel || versionLabel || "Unknown Run",
        suiteRunKey: slugify(headerLabel || versionLabel || `slot-${column}`),
        personColumn: column,
        dateColumn: column + 1,
        buildColumn: column + 2,
        issueColumn: column + 3,
        okColumn: column + 4,
      });
      column += 5;
      continue;
    }

    if (
      /^issue\(s\)$/i.test(field) &&
      /^ok\?$/i.test(clean(headerBottom[column + 1] || ""))
    ) {
      const labels = headerTop
        .slice(column, column + 2)
        .map(clean)
        .filter(Boolean);
      const headerLabel = labels[0] || top;
      const versionLabel = extractVersionLabel(headerLabel, field);
      slots.push({
        startColumn: column,
        headerLabel,
        suiteRunName: headerLabel || versionLabel || "Unknown Run",
        suiteRunKey: slugify(headerLabel || versionLabel || `slot-${column}`),
        personColumn: null,
        dateColumn: null,
        buildColumn: null,
        issueColumn: column,
        okColumn: column + 1,
      });
      column += 2;
      continue;
    }

    column += 1;
  }

  return slots;
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw || /^n\/a$/i.test(raw)) {
    return { value: "", status: raw ? "not-applicable" : "blank" };
  }

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    return {
      value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      status: "ok",
    };
  }

  const textDate = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (textDate) {
    const months = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const month = months[textDate[2].slice(0, 3).toLowerCase()];
    if (month) {
      return {
        value: `${textDate[3]}-${String(month).padStart(2, "0")}-${String(Number(textDate[1])).padStart(2, "0")}`,
        status: "ok",
      };
    }
  }

  const slashDate = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const yearToken = slashDate[3];
    if (!yearToken) {
      return { value: "", status: "missing-year", raw };
    }

    let year = Number(yearToken);
    if (year < 100) {
      year += year >= 70 ? 1900 : 2000;
    }

    let month = first;
    let day = second;
    if (first > 12 && second <= 12) {
      month = second;
      day = first;
    }

    return {
      value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      status: "ok",
    };
  }

  return { value: "", status: "unparsed", raw };
}

function normalizeOk(value) {
  const raw = clean(value).toUpperCase();
  if (!raw) {
    return "";
  }
  if (raw === "TRUE") {
    return "__YES__";
  }
  if (raw === "FALSE" || raw === "N/A") {
    return "__NO__";
  }
  return "";
}

function parseNumber(value) {
  const raw = clean(value);
  if (!raw) {
    return null;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

// Canonical tester names. A Person cell is normalized against this list.
const CANONICAL_ASSIGNEES = [
  "Andrew",
  "Gordon",
  "Andy",
  "Bharani",
  "Dirk",
  "Hatton",
  "Jeffrey",
  "JohnT",
  "Samuel",
  "Sue",
  "Suzanne",
  "Steve",
  "Noel",
  "Marlon",
  "Heather",
  "Colin",
];

// Raw tokens (lowercased) that map onto a canonical name.
const ASSIGNEE_ALIASES = {
  stevemc: "Steve",
};

const CANONICAL_BY_LOWER = new Map(
  CANONICAL_ASSIGNEES.map((name) => [name.toLowerCase(), name]),
);

// Match strings for the "starts with one of those" rule: canonical names plus
// aliases, longest first so a longer name wins over a shorter prefix.
const ASSIGNEE_PREFIXES = [
  ...CANONICAL_ASSIGNEES.map((name) => ({ match: name.toLowerCase(), canonical: name })),
  ...Object.entries(ASSIGNEE_ALIASES).map(([alias, canonical]) => ({
    match: alias,
    canonical,
  })),
].sort((left, right) => right.match.length - left.match.length);

// Resolve a single token to a canonical name (exact name or alias), or "".
function resolveCanonical(token) {
  const key = clean(token).toLowerCase();
  if (!key) {
    return "";
  }
  return CANONICAL_BY_LOWER.get(key) || ASSIGNEE_ALIASES[key] || "";
}

// Does the value start with a canonical name (on a word boundary)?
function startsWithCanonical(value) {
  const lower = clean(value).toLowerCase();
  for (const { match, canonical } of ASSIGNEE_PREFIXES) {
    if (lower === match) {
      return { canonical, exact: true };
    }
    if (lower.startsWith(match) && !/[a-z0-9]/.test(lower.charAt(match.length))) {
      return { canonical, exact: false };
    }
  }
  return null;
}

// Classify one raw Person value into its contribution to a run card:
//   skip  -> Skipped status only (extra text dropped; no assignee, no note)
//   a/b   -> both assignees when every slash part is canonical
//   name… -> that canonical name is an assignee; if there is extra text, the
//            full original value is kept as a note
//   other -> the full value is kept as a note, no assignee
function classifyPerson(raw) {
  const value = clean(raw);
  if (!value) {
    return { skip: false, assignees: [], note: "" };
  }
  if (/skip/i.test(value)) {
    return { skip: true, assignees: [], note: "" };
  }

  if (value.includes("/")) {
    const parts = value.split("/").map((part) => clean(part));
    const resolved = parts.map(resolveCanonical);
    if (parts.length >= 2 && resolved.every(Boolean)) {
      return { skip: false, assignees: resolved, note: "" };
    }
  }

  const prefix = startsWithCanonical(value);
  if (prefix) {
    return {
      skip: false,
      assignees: [prefix.canonical],
      note: prefix.exact ? "" : value,
    };
  }

  return { skip: false, assignees: [], note: value };
}

// Derive a run card's assignees, notes, and status from its Person value and
// its OK? flag. Skipped wins over Done; assignees are cleared on Skipped runs.
function deriveAssignment(person, ok) {
  const classified = classifyPerson(person);
  if (classified.skip) {
    return { status: "Skipped", assignees: [], notes: "" };
  }
  return {
    status: ok === "__YES__" ? "Done" : "",
    assignees: classified.assignees,
    notes: classified.note,
  };
}

// Suite runs whose dates were recorded as a bare M/D with no year. The year
// was determined once from each run's fully-dated entries and is hard-coded
// here, keyed by suiteRunKey, so it is not re-derived. Applied inline in main().
const SUITE_RUN_YEARS = {
  "5-4": "2022",
  "5-3": "2022",
  "5-5": "2023",
  "4-9": "2020",
};

function dateFromMonthDay(rawDate, year) {
  const match = clean(rawDate).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) {
    return "";
  }
  let month = Number(match[1]);
  let day = Number(match[2]);
  if (month > 12 && day <= 12) {
    [month, day] = [day, month];
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function main() {
  const text = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  ensureWidth(rows);
  ensureImportIdColumn(rows);
  const width = ensureWidth(rows);

  const baseIndex = {
    importId: 0,
    legacyNumber: 1,
    description: 2,
    dokimion: 3,
    priority: 4,
    pastIssues: 5,
    timeToTest: 6,
  };
  const runStart = 7;
  const slots = detectSlots(rows[0], rows[1], runStart);
  for (const slot of slots) {
    slot.suiteRunName = normalizeSuiteRunName(slot.suiteRunName);
    slot.suiteRunKey = slugify(slot.suiteRunName) || slot.suiteRunKey;
  }

  // The model has a single Notion database: Test Case Runs. We still parse one
  // logical "case" per importable spreadsheet row so that every run card can
  // carry that case's durable metadata as its own properties. Suite runs are
  // no longer a database; each distinct suite-run name becomes a closed
  // `Test Suite Run` select tag, collected here for reference.
  const suiteRunTagMap = new Map();
  const testCaseRuns = [];
  const dateWarnings = [];
  let caseCount = 0;
  let inferredYearCount = 0;

  // Section-header rows (keyed by their description in area-mapping.json) set
  // the Area that carries forward to the test cases beneath them.
  const areaMapping = JSON.parse(
    fs.readFileSync(path.join(round2Dir, "area-mapping.json"), "utf8"),
  );
  let currentArea = "";

  // Hand-authored short titles, keyed by snapshot text. Missing entries leave
  // caseSummary blank (to be filled in later, reviewed in batches).
  const summariesPath = path.join(round2Dir, "case-summaries.json");
  const summaryEntries = fs.existsSync(summariesPath)
    ? JSON.parse(fs.readFileSync(summariesPath, "utf8"))
    : [];
  const summaryMap = new Map(
    summaryEntries.map((entry) => [entry.snapshot, entry.summary]),
  );
  const missingSummaries = new Set();

  for (let rowIndex = 5; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    while (row.length < width) {
      row.push("");
    }

    const areaEntry = areaMapping.rows[clean(row[baseIndex.description])];
    if (areaEntry && areaEntry.kind === "area") {
      currentArea = areaEntry.area || "";
    }

    if (!looksImportableRow(row, baseIndex, runStart)) {
      continue;
    }

    if (!clean(row[baseIndex.importId])) {
      row[baseIndex.importId] = buildImportId(row, rowIndex + 1, baseIndex);
    }

    const testCase = {
      importId: clean(row[baseIndex.importId]),
      sourceRowNumber: rowIndex + 1,
      legacyNumber: clean(row[baseIndex.legacyNumber]),
      dokimionId: clean(row[baseIndex.dokimion]),
      priority: normalizePriority(row[baseIndex.priority]),
      pastIssues: clean(row[baseIndex.pastIssues]),
      estTimeMin: parseNumber(row[baseIndex.timeToTest]),
    };
    caseCount += 1;

    // The cleaned, line-break-preserving snapshot is the card body. The card
    // title (caseSummary) is a short human-written summary looked up from
    // case-summaries.json by snapshot text; blank until authored.
    const caseSnapshot = cleanSnapshot(clean(row[baseIndex.description]));
    const caseSummary = summaryMap.get(caseSnapshot) || "";
    if (caseSnapshot && !caseSummary) {
      missingSummaries.add(caseSnapshot);
    }

    // One run card per suite-run slot that has execution data for this case.
    for (const slot of slots) {
      const person =
        slot.personColumn == null ? "" : clean(row[slot.personColumn]);
      const rawDate =
        slot.dateColumn == null ? "" : clean(row[slot.dateColumn]);
      const build =
        slot.buildColumn == null ? "" : clean(row[slot.buildColumn]);
      const issue =
        slot.issueColumn == null ? "" : clean(row[slot.issueColumn]);
      const ok = slot.okColumn == null ? "" : normalizeOk(row[slot.okColumn]);
      const hasData = Boolean(person || rawDate || build || issue || ok);

      if (!hasData) {
        continue;
      }

      const normalizedDate = normalizeDate(rawDate);
      let testedOn = normalizedDate.value;
      // Fill a bare M/D ("missing-year") using the hard-coded year for this
      // suite run, if we have one. Filled silently.
      if (!testedOn && normalizedDate.status === "missing-year") {
        const year = SUITE_RUN_YEARS[slot.suiteRunKey];
        if (year) {
          testedOn = dateFromMonthDay(rawDate, year);
          if (testedOn) {
            inferredYearCount += 1;
          }
        }
      }
      // A date that didn't resolve to a real value: a bare "ok" is noise (an
      // OK flag that landed in the date cell) and is dropped entirely; any
      // other leftover text is preserved as a note and recorded as a warning.
      let dateNote = "";
      if (rawDate && !testedOn && !/^ok$/i.test(rawDate)) {
        dateNote = rawDate;
        dateWarnings.push({
          importId: testCase.importId,
          suiteRunKey: slot.suiteRunKey,
          rawDate,
          status: normalizedDate.status,
        });
      }

      const runOrder = slot.startColumn - runStart + 1;
      const existingTag = suiteRunTagMap.get(slot.suiteRunKey);
      if (!existingTag) {
        suiteRunTagMap.set(slot.suiteRunKey, {
          tag: slot.suiteRunName,
          key: slot.suiteRunKey,
          runOrder,
        });
      } else if (runOrder < existingTag.runOrder) {
        existingTag.runOrder = runOrder;
      }

      const assignment = deriveAssignment(person, ok);
      // Combine the person-derived note and any leftover date text; multiple
      // notes are separated by "; ".
      const notes = [assignment.notes, dateNote]
        .filter((part) => part && part.trim() !== "")
        .join("; ");
      testCaseRuns.push({
        importRunId: `${testCase.importId}::${slot.suiteRunKey}`,
        suiteRunTag: slot.suiteRunName,
        suiteRunKey: slot.suiteRunKey,
        // Numeric test case ID, identical for every suite run of this case.
        // Currently the source CSV row number, which is unique per logical case.
        testCaseId: testCase.sourceRowNumber,
        sourceRowNumber: testCase.sourceRowNumber,
        caseSummary,
        caseSnapshot,
        area: currentArea,
        legacyNumber: testCase.legacyNumber,
        dokimionId: testCase.dokimionId,
        priority: testCase.priority,
        pastIssues: testCase.pastIssues,
        estTimeMin: testCase.estTimeMin,
        assignees: assignment.assignees,
        notes,
        testedOn,
        buildTested: build,
        issueLinks: issue,
        status: assignment.status,
      });
    }

    if (caseLimit > 0 && caseCount >= caseLimit) {
      break;
    }
  }

  const suiteRunTags = Array.from(suiteRunTagMap.values()).sort(
    (left, right) => left.runOrder - right.runOrder,
  );

  // importRunId must be unique: with one card per (case, suite-run key), a
  // duplicate would silently overwrite another on import. Surface any.
  const seenRunIds = new Set();
  const duplicateRunIds = [];
  for (const run of testCaseRuns) {
    if (seenRunIds.has(run.importRunId)) {
      duplicateRunIds.push(run.importRunId);
    } else {
      seenRunIds.add(run.importRunId);
    }
  }
  if (duplicateRunIds.length > 0) {
    console.warn(
      `WARNING: ${duplicateRunIds.length} duplicate importRunId(s): ` +
        duplicateRunIds.slice(0, 10).join(", "),
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "test-case-runs.json"),
    JSON.stringify(testCaseRuns, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "suite-run-tags.json"),
    JSON.stringify(suiteRunTags, null, 2) + "\n",
    "utf8",
  );
  const summary = {
    csvPath,
    outDir,
    caseLimit,
    slotCount: slots.length,
    caseCount,
    suiteRunTagCount: suiteRunTags.length,
    testCaseRunCount: testCaseRuns.length,
    dateWarningCount: dateWarnings.length,
    inferredYearCount,
    summarizedSnapshotCount: summaryMap.size,
    unsummarizedSnapshotCount: missingSummaries.size,
    duplicateRunIdCount: duplicateRunIds.length,
  };
  fs.writeFileSync(
    path.join(outDir, "prepare-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "date-warnings.json"),
    JSON.stringify(dateWarnings, null, 2) + "\n",
    "utf8",
  );

  console.log(JSON.stringify(summary, null, 2));
}

main();

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

function buildCaseTitle(row, baseIndex) {
  const description = clean(row[baseIndex.description]);
  const docId = clean(row[baseIndex.dokimion]);
  const normalized = description
    .replace(/^[\-\s]+/, "")
    .replace(/^--\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || docId || "Untitled Test Case";
}

function extractVersionInfo(rawLabel, fieldLabel) {
  const source = clean(rawLabel) || clean(fieldLabel);
  const versionMatch = source.match(
    /\d+(?:\.\d+)?(?:\s+[A-Za-z][A-Za-z0-9]*)?/,
  );
  const label = versionMatch ? versionMatch[0].trim() : source;
  let platform = source
    .replace(/^\d+(?:\.\d+)?(?:\s+[A-Za-z][A-Za-z0-9]*)?\s*/i, "")
    .trim();

  if (/^person testing\s+/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/^person testing\s+/i, ""));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  if (/^date this test last done in\s+/i.test(fieldLabel)) {
    platform = clean(
      fieldLabel.replace(/^date this test last done in\s+/i, ""),
    );
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  if (/^build tested in\s+/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/^build tested in\s+/i, ""));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  if (/issues found/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/issues found.*$/i, ""));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  return { testRunLabel: label, platform };
}

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
      const versionInfo = extractVersionInfo(headerLabel, field);
      slots.push({
        startColumn: column,
        headerLabel,
        suiteRunName: headerLabel || versionInfo.testRunLabel || "Unknown Run",
        suiteRunKey: slugify(
          headerLabel || versionInfo.testRunLabel || `slot-${column}`,
        ),
        testRunLabelHint: versionInfo.testRunLabel || "Unknown Run",
        platformHint: versionInfo.platform,
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
      const versionInfo = extractVersionInfo(headerLabel, field);
      slots.push({
        startColumn: column,
        headerLabel,
        suiteRunName: headerLabel || versionInfo.testRunLabel || "Unknown Run",
        suiteRunKey: slugify(
          headerLabel || versionInfo.testRunLabel || `slot-${column}`,
        ),
        testRunLabelHint: versionInfo.testRunLabel || "Unknown Run",
        platformHint: versionInfo.platform,
        personColumn: null,
        dateColumn: null,
        buildColumn: null,
        issueColumn: column,
        okColumn: column + 1,
      });
      column += 2;
      continue;
    }

    if (/^person testing\s+/i.test(field)) {
      const versionInfo = extractVersionInfo(top, field);
      slots.push({
        startColumn: column,
        headerLabel: field,
        suiteRunName: versionInfo.testRunLabel || "Unknown Run",
        suiteRunKey: slugify(versionInfo.testRunLabel || `slot-${column}`),
        testRunLabelHint: versionInfo.testRunLabel || "Unknown Run",
        platformHint: versionInfo.platform,
        personColumn: column,
        dateColumn: /^date this test last done in\s+/i.test(
          clean(headerBottom[column + 1] || ""),
        )
          ? column + 1
          : null,
        buildColumn: /^build tested in\s+/i.test(
          clean(headerBottom[column + 2] || ""),
        )
          ? column + 2
          : null,
        issueColumn: /issues found/i.test(clean(headerBottom[column + 3] || ""))
          ? column + 3
          : null,
        okColumn: null,
      });
      column += 4;
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

function uniqueJoined(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = clean(value);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result.join("\n");
}

function choosePrimaryExecution(entries) {
  return entries.find((entry) => !entry.platform) || entries[0] || null;
}

function buildCaseReference(testCase) {
  const dokimionMatch = clean(testCase.dokimionId).match(/^TC\d+/i);
  if (dokimionMatch) {
    return dokimionMatch[0].toUpperCase();
  }

  const dokimion = clean(testCase.dokimionId);
  if (dokimion) {
    return dokimion;
  }

  return clean(testCase.legacyNumber) || testCase.importId;
}

function buildRunCardTitle(testCase, suiteRunName) {
  return `${suiteRunName}/${buildCaseReference(testCase)}`.slice(0, 200);
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

  // The model has a single Notion database: Test Case Runs. We still parse one
  // logical "case" per importable spreadsheet row so that every run card can
  // carry that case's durable metadata as its own properties. Suite runs are
  // no longer a database; each distinct suite-run name becomes a closed
  // `Test Suite Run` select tag, collected here for reference.
  const suiteRunTagMap = new Map();
  const testCaseRuns = [];
  const dateWarnings = [];
  let caseCount = 0;

  for (let rowIndex = 5; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    while (row.length < width) {
      row.push("");
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
      title: buildCaseTitle(row, baseIndex),
      description: clean(row[baseIndex.description]),
      dokimionId: clean(row[baseIndex.dokimion]),
      priority: normalizePriority(row[baseIndex.priority]),
      pastIssues: clean(row[baseIndex.pastIssues]),
      estTimeMin: parseNumber(row[baseIndex.timeToTest]),
      active: true,
    };
    caseCount += 1;

    const groupedEntries = new Map();
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
      if (rawDate && normalizedDate.status !== "ok") {
        dateWarnings.push({
          importId: testCase.importId,
          suiteRunKey: slot.suiteRunKey,
          rawDate,
          status: normalizedDate.status,
        });
      }

      if (!groupedEntries.has(slot.suiteRunKey)) {
        groupedEntries.set(slot.suiteRunKey, []);
      }

      groupedEntries.get(slot.suiteRunKey).push({
        sourceLabel: slot.headerLabel || slot.suiteRunName,
        platform: slot.platformHint || "",
        person,
        rawDate,
        testedOn: normalizedDate.value,
        build,
        issue,
        ok,
      });

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
    }

    for (const [suiteRunKey, executionEntries] of groupedEntries.entries()) {
      const suiteRunTag = suiteRunTagMap.get(suiteRunKey);
      const suiteRunName = suiteRunTag?.tag || suiteRunKey;
      const primary = choosePrimaryExecution(executionEntries);
      testCaseRuns.push({
        importRunId: `${testCase.importId}::${suiteRunKey}`,
        suiteRunTag: suiteRunName,
        suiteRunKey,
        caseImportId: testCase.importId,
        sourceRowNumber: testCase.sourceRowNumber,
        title: buildRunCardTitle(testCase, suiteRunName),
        caseSummary: testCase.title,
        legacyNumber: testCase.legacyNumber,
        dokimionId: testCase.dokimionId,
        priority: testCase.priority,
        pastIssues: testCase.pastIssues,
        estTimeMin: testCase.estTimeMin,
        active: testCase.active,
        description: testCase.description,
        caseSnapshot: testCase.description,
        assignee: primary?.person || "",
        testedOn: primary?.testedOn || "",
        buildTested: primary?.build || "",
        issueLinks: uniqueJoined(executionEntries.map((entry) => entry.issue)),
        ok: primary?.ok || "",
        historicalImport: true,
        executionEntries,
      });
    }

    if (caseLimit > 0 && caseCount >= caseLimit) {
      break;
    }
  }

  const suiteRunTags = Array.from(suiteRunTagMap.values()).sort(
    (left, right) => left.runOrder - right.runOrder,
  );

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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(process.argv[2] || path.join(scriptDir, "output"));
const configPath = path.join(scriptDir, "notion-config.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const statePath = path.join(outputDir, "notion-state.json");
const failuresPath = path.join(outputDir, "notion-import-failures.json");
// Distinct areas in spreadsheet order (from prepare-import); used to declare
// the Areas multi-select options in that order on a freshly created database.
const orderedAreas = loadJson(path.join(outputDir, "areas.json"), []);

const DB_TITLE = "Test Case Runs";
const TITLE_PROPERTY = "Test Case Run";

// Resolved at runtime by ensureDatabase(): either the configured id, a
// previously created id from notion-state.json, or a freshly created database.
let databaseId = "";

const options = {
  reconcileSchema: process.env.IMPORT_RECONCILE_SCHEMA !== "0",
  resetExisting: process.env.IMPORT_RESET_EXISTING === "1",
  replaceBody: process.env.IMPORT_REPLACE_BODY === "1",
  retryCount: Number(process.env.IMPORT_RETRY_COUNT || "6"),
  retryDelayMs: Number(process.env.IMPORT_RETRY_DELAY_MS || "3000"),
  requestTimeoutMs: Number(process.env.IMPORT_REQUEST_TIMEOUT_MS || "45000"),
};

// Assignees are a closed set; the `Assignee` select offers exactly these
// options. prepare-import.mjs maps every tester cell to one of these names (or
// to "" when it does not match), so no other options are ever created.
const ASSIGNEE_OPTIONS = [
  "Andrew",
  "Bharani",
  "Hatton",
  "Jeffrey",
  "JohnT",
  "Steve",
  "Noel",
  "Heather",
  "Colin",
  "Gordon",
].map((name) => ({ name }));

// Properties the single Test Case Runs database needs. reconcileLiveSchema()
// adds any that are missing. The `Test Suite Run` tag is a closed select; its
// options are created on demand as run cards are written.
const REQUIRED_RUN_PROPERTIES = {
  "Test Case ID": { number: {} },
  "Test Suite Run": { select: {} },
  "Legacy Number": { rich_text: {} },
  "Dokimion ID": { rich_text: {} },
  "Past Issues": { rich_text: {} },
  "Est. Time (min)": { number: {} },
  Priority: { select: {} },
  // Folded test case definition: the steps summary, the raw source description,
  // and the functional areas the case belongs to. The step-by-step checklist
  // itself is rendered into the page body, not a property.
  "Step Description": { rich_text: {} },
  "Original Description": { rich_text: {} },
  // Options declared in spreadsheet order so the board's Area swimlanes sort
  // that way; falls back to on-demand creation if areas.json is absent.
  Areas: { multi_select: { options: orderedAreas.map((name) => ({ name: selectName(name) })) } },
  Assignee: { select: { options: ASSIGNEE_OPTIONS } },
  "Build Tested": { rich_text: {} },
  "Issue Links": { rich_text: {} },
  // Single run outcome (replaces the old OK / Skipped checkboxes). A native
  // status property so a board view can group cards into draggable columns;
  // arrange the options into To-do / In Progress / Complete groups in the UI.
  Status: {
    status: {
      options: [
        { name: "Not started", color: "default" },
        { name: "In Progress", color: "blue" },
        { name: "Problems", color: "red" },
        { name: "Skipped", color: "yellow" },
        { name: "Done", color: "green" },
      ],
    },
  },
  // Text, not number: main rows hold the numeric row, the YouTrack-only source
  // holds ids like "temp-dokimion-609".
  "Import Source Row Number": { rich_text: {} },
  "Tested On": { date: {} },
  // Raw source details that didn't normalize cleanly into the properties above.
  "Import Notes": { rich_text: {} },
};

// Properties to remove from an existing database during reconciliation:
// the `Test Case` relation from the old three-database model; `Active` and
// `Historical Import`, which were always true; the `Import ID` / `Import Run ID`
// upsert keys, which a one-and-done import does not need (case identity is
// `Test Case ID`); and the former `Source Row Number` (renamed to
// `Import Source Row Number`).
const OBSOLETE_RUN_PROPERTIES = [
  "Test Case",
  "Active",
  "Historical Import",
  "Import ID",
  "Import Run ID",
  "Source Row Number",
  // Replaced by the single Status select.
  "OK",
  "Skipped",
  // Redundant with the card title (which is the case summary).
  "Case Summary",
];

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function clean(value) {
  return (value ?? "").trim();
}

function issueUrl(issueId) {
  return `https://issues.bloomlibrary.org/youtrack/issue/${issueId.toUpperCase()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushTextFragments(target, value, link) {
  for (const chunk of chunkText(value)) {
    const fragment = {
      type: "text",
      text: {
        content: chunk,
      },
    };
    if (link) {
      fragment.text.link = { url: link };
    }
    target.push(fragment);
  }
}

function richText(value) {
  const content = clean(value);
  if (!content) {
    return [];
  }

  const fragments = [];
  pushTextFragments(fragments, content);
  return fragments;
}

function issueRichText(value) {
  const content = String(value ?? "");
  if (!clean(content)) {
    return [];
  }

  const fragments = [];
  const issuePattern = /BL-\d+/gi;
  let lastIndex = 0;

  for (const match of content.matchAll(issuePattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      pushTextFragments(fragments, content.slice(lastIndex, matchIndex));
    }

    const issueId = match[0].toUpperCase();
    pushTextFragments(fragments, issueId, issueUrl(issueId));
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < content.length) {
    pushTextFragments(fragments, content.slice(lastIndex));
  }

  return fragments;
}

function dokimionUrl(tcNumber) {
  return `https://github.com/BloomBooks/bloom-test-cases/blob/main/test%20cases/${tcNumber}.md`;
}

// Render the Dokimion ID as a link to its bloom-test-cases markdown file. The
// link target is the leading TC number (files are named `<number>.md`); the
// full label (e.g. "TC105 (steps 1 to 4)") is kept as the link text. Values
// without a TC number (e.g. "-") render as plain text.
function dokimionRichText(value) {
  const content = clean(value);
  if (!content) {
    return [];
  }
  const match = content.match(/TC\s*0*(\d+)/i);
  if (!match) {
    return richText(content);
  }
  const fragments = [];
  pushTextFragments(fragments, content, dokimionUrl(match[1]));
  return fragments;
}

function titleText(value) {
  const content = clean(value) || "Untitled";
  return [{ text: { content: content.slice(0, 2000) } }];
}

function selectName(value) {
  // Notion select option names cannot contain commas.
  return clean(value).replace(/,/g, " ").slice(0, 100);
}

function normalizePageId(id) {
  return (id || "").replace(/-/g, "");
}

function chunkText(value, size = 1800) {
  const text = String(value ?? "");
  if (!text) {
    return [];
  }
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function paragraphBlockFromRichText(richTextValue) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richTextValue,
    },
  };
}

function paragraphBlock(text) {
  return paragraphBlockFromRichText(richText(text));
}

function headingBlock(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: richText(text.slice(0, 2000)),
    },
  };
}

function toDoBlockFromRichText(richTextValue) {
  return {
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: richTextValue,
      checked: false,
    },
  };
}

function toDoBlock(text) {
  return toDoBlockFromRichText(richText(text));
}

function multiSelect(values) {
  return Array.from(
    new Set((values || []).map((value) => clean(value)).filter(Boolean)),
  ).map((value) => ({ name: selectName(value) }));
}

function buildCaseRunBlocks(record) {
  const blocks = [headingBlock("Test Steps")];

  // Prefer the parsed checklist (the test case definition). Each step becomes a
  // checkable to-do so a tester can work through the case. Fall back to the raw
  // snapshot paragraphs when no steps were derived.
  const bodyChecklistItems = Array.isArray(record.bodyChecklistItems)
    ? record.bodyChecklistItems.map((item) => clean(item)).filter(Boolean)
    : [];
  const checklistSteps = Array.isArray(record.checklistSteps)
    ? record.checklistSteps.map((step) => clean(step)).filter(Boolean)
    : [];
  const stepNotes = Array.isArray(record.stepNotes)
    ? record.stepNotes.map((note) => clean(note)).filter(Boolean)
    : [];

  if (bodyChecklistItems.length > 0) {
    for (const step of bodyChecklistItems) {
      blocks.push(toDoBlockFromRichText(issueRichText(step)));
    }
  } else if (checklistSteps.length > 0) {
    for (const step of checklistSteps) {
      blocks.push(toDoBlock(step));
    }
    for (const note of stepNotes) {
      blocks.push(toDoBlockFromRichText(issueRichText(note)));
    }
  } else if (record.caseSnapshot) {
    for (const line of String(record.caseSnapshot).split(/\r?\n/)) {
      const content = clean(line);
      if (content) {
        blocks.push(paragraphBlock(content));
      }
    }
  } else {
    blocks.push(
      paragraphBlock("No description was present in the source row."),
    );
  }

  // Optional curator notes, rendered last under their own heading.
  if (clean(record.notes)) {
    blocks.push(headingBlock("Notes"));
    for (const line of String(record.notes).split(/\r?\n/)) {
      const content = clean(line);
      if (content) {
        blocks.push(paragraphBlock(content));
      }
    }
  }

  return blocks;
}

async function execNotionJson(method, apiPath, body) {
  const token =
    process.env.BLOOM_TESTCASE_NOTION || process.env.NOTION_TOKEN || "";
  if (!token) {
    throw new Error("NOTION_TOKEN is not available.");
  }

  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.requestTimeoutMs,
    );

    try {
      const response = await fetch(`https://api.notion.com/v1/${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (response.ok) {
        return json;
      }

      if (
        (response.status === 429 || response.status === 503) &&
        attempt < options.retryCount
      ) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : options.retryDelayMs * (attempt + 1);
        await sleep(retryAfterMs);
        continue;
      }

      throw new Error(
        `Notion API Error (${response.status}): ${json.message || text}`,
      );
    } catch (error) {
      clearTimeout(timer);
      if (
        (error.name === "AbortError" ||
          /timed out/i.test(String(error.message || error))) &&
        attempt < options.retryCount
      ) {
        await sleep(options.retryDelayMs * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Notion API request exhausted retries.");
}

async function getDatabase(databaseId) {
  return execNotionJson("GET", `databases/${normalizePageId(databaseId)}`);
}

async function updateDatabase(databaseId, body) {
  return execNotionJson(
    "PATCH",
    `databases/${normalizePageId(databaseId)}`,
    body,
  );
}

async function queryDatabase(databaseId, startCursor) {
  const body = { page_size: 100 };
  if (startCursor) {
    body.start_cursor = startCursor;
  }
  return execNotionJson(
    "POST",
    `databases/${normalizePageId(databaseId)}/query`,
    body,
  );
}

async function listDatabasePages(databaseId) {
  const pages = [];
  let startCursor = "";

  while (true) {
    const response = await queryDatabase(databaseId, startCursor);
    pages.push(...(response.results || []));
    if (!response.has_more || !response.next_cursor) {
      return pages;
    }
    startCursor = response.next_cursor;
  }
}

async function archivePage(pageId) {
  await execNotionJson("PATCH", `pages/${normalizePageId(pageId)}`, {
    in_trash: true,
  });
}

async function createDatabase(parentPageId) {
  const properties = {
    [TITLE_PROPERTY]: { title: {} },
    ...REQUIRED_RUN_PROPERTIES,
  };
  return execNotionJson("POST", "databases", {
    parent: { type: "page_id", page_id: normalizePageId(parentPageId) },
    title: [{ type: "text", text: { content: DB_TITLE } }],
    properties,
  });
}

async function ensureDatabase(state) {
  if (clean(config.databases?.testCaseRuns)) {
    databaseId = config.databases.testCaseRuns;
    return { databaseId, created: false };
  }
  if (state.databaseId) {
    databaseId = state.databaseId;
    return { databaseId, created: false };
  }
  if (!clean(config.parentPageId)) {
    throw new Error(
      "No testCaseRuns database id configured and no parentPageId to create one in.",
    );
  }
  const database = await createDatabase(config.parentPageId);
  databaseId = database.id;
  state.databaseId = database.id;
  saveJson(statePath, state);
  return { databaseId, created: true };
}

async function reconcileLiveSchema() {
  // Operate only on the single Test Case Runs database. The old Test Cases and
  // Test Suite Runs databases are intentionally left untouched.
  const runs = await getDatabase(databaseId);
  const liveProps = runs.properties || {};

  // 1. Drop obsolete properties and any `Test Suite Run` that is still a
  //    relation (it is now a select tag). Removing the relation discards the
  //    historical link, which is expected for this migration.
  const removals = {};
  for (const name of OBSOLETE_RUN_PROPERTIES) {
    if (liveProps[name]) {
      removals[name] = null;
    }
  }
  if (liveProps["Test Suite Run"] && liveProps["Test Suite Run"].type !== "select") {
    removals["Test Suite Run"] = null;
  }
  // Assignee became a closed select; drop it if it still has another type so it
  // is re-added below with the fixed option set.
  if (liveProps["Assignee"] && liveProps["Assignee"].type !== "select") {
    removals["Assignee"] = null;
  }
  // Import Source Row Number became text (it now also holds youtrack-only ids);
  // drop a leftover number-typed one so it is re-added below as rich_text.
  if (
    liveProps["Import Source Row Number"] &&
    liveProps["Import Source Row Number"].type !== "rich_text"
  ) {
    removals["Import Source Row Number"] = null;
  }
  if (Object.keys(removals).length > 0) {
    await updateDatabase(databaseId, {
      properties: removals,
    });
  }

  // 2. Add any required property that is now missing (re-fetch so a removed
  //    `Test Suite Run` is seen as absent and re-added as a select).
  const afterRemoval =
    Object.keys(removals).length > 0
      ? (await getDatabase(databaseId)).properties || {}
      : liveProps;
  const additions = {};
  for (const [name, definition] of Object.entries(REQUIRED_RUN_PROPERTIES)) {
    if (!afterRemoval[name]) {
      additions[name] = definition;
    }
  }
  if (Object.keys(additions).length > 0) {
    await updateDatabase(databaseId, {
      properties: additions,
    });
  }

  return {
    removed: Object.keys(removals),
    added: Object.keys(additions),
  };
}

async function resetLiveData(state) {
  let archived = 0;
  const caseRunPages = await listDatabasePages(databaseId);
  for (const page of caseRunPages) {
    if (page.in_trash || page.archived) {
      continue;
    }
    await archivePage(page.id);
    archived += 1;
  }

  state.caseRuns = {};
  saveJson(statePath, state);

  return { caseRuns: archived };
}

async function createPage(parentDatabaseId, properties) {
  return execNotionJson("POST", "pages", {
    parent: { database_id: normalizePageId(parentDatabaseId) },
    properties,
  });
}

async function updatePage(pageId, properties) {
  return execNotionJson("PATCH", `pages/${normalizePageId(pageId)}`, {
    properties,
  });
}

async function listChildren(pageId) {
  return execNotionJson(
    "GET",
    `blocks/${normalizePageId(pageId)}/children?page_size=100`,
  );
}

async function appendChildren(pageId, children) {
  if (!children.length) {
    return;
  }
  await execNotionJson("PATCH", `blocks/${normalizePageId(pageId)}/children`, {
    children,
  });
}

async function deleteChildren(pageId) {
  const existing = await listChildren(pageId);
  for (const block of existing.results || []) {
    await execNotionJson("DELETE", `blocks/${normalizePageId(block.id)}`);
  }
}

async function writeBody(pageId, blocks) {
  if (!blocks.length) {
    return;
  }
  if (options.replaceBody) {
    await deleteChildren(pageId);
    await appendChildren(pageId, blocks);
    return;
  }
  const existing = await listChildren(pageId);
  if ((existing.results || []).length > 0) {
    return;
  }
  await appendChildren(pageId, blocks);
}

function buildCaseRunProperties(record) {
  const properties = {
    "Test Case Run": { title: titleText(record.title) },
    "Test Case ID": { number: record.testCaseId },
    "Legacy Number": { rich_text: richText(record.legacyNumber || "") },
    "Dokimion ID": { rich_text: dokimionRichText(record.dokimionId || "") },
    "Past Issues": { rich_text: issueRichText(record.pastIssues || "") },
    "Step Description": { rich_text: richText(record.stepDescription || "") },
    "Original Description": {
      rich_text: richText(record.originalDescription || ""),
    },
    Areas: { multi_select: multiSelect(record.areas) },
    "Build Tested": { rich_text: richText(record.buildTested || "") },
    "Issue Links": { rich_text: issueRichText(record.issueLinks || "") },
    Status: { status: { name: record.status || "Not started" } },
    "Import Source Row Number": {
      rich_text: richText(String(record.sourceRowNumber ?? "")),
    },
    "Import Notes": { rich_text: richText(record.importNotes || "") },
  };

  if (record.suiteRunTag) {
    properties["Test Suite Run"] = {
      select: { name: selectName(record.suiteRunTag) },
    };
  }
  // prepare-import already mapped the tester to a canonical name or "".
  if (record.assignee) {
    properties.Assignee = { select: { name: record.assignee } };
  }
  if (record.priority) {
    properties.Priority = { select: { name: record.priority } };
  }
  if (typeof record.estTimeMin === "number") {
    properties["Est. Time (min)"] = { number: record.estTimeMin };
  }
  if (record.testedOn) {
    properties["Tested On"] = { date: { start: record.testedOn } };
  }

  return properties;
}

function ensureFailures(reset = false) {
  const initial = reset
    ? { caseRuns: [] }
    : loadJson(failuresPath, { caseRuns: [] });
  saveJson(failuresPath, initial);
  return initial;
}

function recordFailure(failures, kind, key, errorMessage) {
  failures[kind].push({ key, error: errorMessage });
  saveJson(failuresPath, failures);
}

function pageIdFromState(entry) {
  return entry && entry.pageId ? entry.pageId : "";
}

async function importCaseRuns(records, state, failures) {
  let created = 0;
  let updated = 0;
  for (const record of records) {
    try {
      // One-and-done import: there is no live lookup by a Notion property. The
      // only "existing" pages are ones this run already created (tracked in
      // notion-state.json), which lets an interrupted run resume.
      const existingId = pageIdFromState(state.caseRuns[record.importRunId]);
      const properties = buildCaseRunProperties(record);
      if (existingId) {
        await updatePage(existingId, properties);
        await writeBody(existingId, buildCaseRunBlocks(record));
        updated += 1;
      } else {
        const page = await createPage(databaseId, properties);
        await writeBody(page.id, buildCaseRunBlocks(record));
        state.caseRuns[record.importRunId] = { pageId: page.id };
        saveJson(statePath, state);
        created += 1;
      }
    } catch (error) {
      recordFailure(
        failures,
        "caseRuns",
        record.importRunId,
        String(error.message || error),
      );
    }
  }
  return { created, updated };
}

async function main() {
  const caseRuns = loadJson(path.join(outputDir, "test-case-runs.json"), []);
  const state = loadJson(statePath, { caseRuns: {} });
  if (!state.caseRuns) {
    state.caseRuns = {};
  }
  const failures = ensureFailures(true);

  // Resolve (or create) the single Test Case Runs database first. A freshly
  // created database already has the full schema, so reconciliation is skipped.
  const databaseResult = await ensureDatabase(state);
  const schemaResult =
    options.reconcileSchema && !databaseResult.created
      ? await reconcileLiveSchema()
      : { removed: [], added: [] };
  const archivedCounts = options.resetExisting
    ? await resetLiveData(state)
    : { caseRuns: 0 };

  const caseRunResult = await importCaseRuns(caseRuns, state, failures);

  console.log(
    JSON.stringify(
      {
        databaseId,
        databaseCreated: databaseResult.created,
        schemaReconciled: schemaResult,
        archivedCounts,
        caseRunsCreated: caseRunResult.created,
        caseRunsUpdated: caseRunResult.updated,
        caseRunFailures: failures.caseRuns.length,
      },
      null,
      2,
    ),
  );
}

await main();

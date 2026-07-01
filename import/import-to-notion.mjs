// One-and-done historical import: transports the prepared records in
// ./output/test-case-runs.json into the single "Test Case Runs" Notion
// database. Generic Notion plumbing lives in ../lib/notion.mjs; this file holds
// the import-specific schema, database reconciliation, and record->page build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DB_TITLE,
  TITLE_PROPERTY,
  STATUS_OPTIONS,
  clean,
  loadJson,
  saveJson,
  normalizePageId,
  execNotionJson,
  getDatabase,
  updateDatabase,
  listDatabasePages,
  archivePage,
  createPage,
  updatePage,
  writeBody,
  titleText,
  richText,
  dokimionRichText,
  linkifyRichText,
  multiSelect,
  selectName,
  headingBlock,
  toDoBlock,
  toDoBlockFromRichText,
  paragraphBlock,
} from "../lib/notion.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(process.argv[2] || path.join(scriptDir, "output"));
// notion-config.json lives at the repo root (shared with the clone tool).
const configPath = path.join(scriptDir, "..", "notion-config.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const statePath = path.join(outputDir, "notion-state.json");
const failuresPath = path.join(outputDir, "notion-import-failures.json");
// Distinct areas in spreadsheet order (from prepare-import); used to declare
// the Areas multi-select options in that order on a freshly created database.
const orderedAreas = loadJson(path.join(outputDir, "areas.json"), []);

// Resolved at runtime by ensureDatabase(): either the configured id, a
// previously created id from notion-state.json, or a freshly created database.
let databaseId = "";

const options = {
  reconcileSchema: process.env.IMPORT_RECONCILE_SCHEMA !== "0",
  resetExisting: process.env.IMPORT_RESET_EXISTING === "1",
  replaceBody: process.env.IMPORT_REPLACE_BODY === "1",
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
  Summary: { rich_text: {} },
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
  Status: { status: { options: STATUS_OPTIONS } },
  // Text, not number: main rows hold the numeric row, the YouTrack-only source
  // holds ids like "temp-dokimion-609".
  "Import Source Row Number": { rich_text: {} },
  "Tested On": { date: {} },
  // Per-run notes: raw source details that didn't normalize cleanly on import,
  // and (going forward) tester notes about a specific run. Not carried to the
  // next suite run by the clone tool.
  "Run Notes": { rich_text: {} },
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
  // Renamed to `Summary`.
  "Step Description",
];

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
      blocks.push(toDoBlockFromRichText(linkifyRichText(step)));
    }
  } else if (checklistSteps.length > 0) {
    for (const step of checklistSteps) {
      blocks.push(toDoBlock(step));
    }
    for (const note of stepNotes) {
      blocks.push(toDoBlockFromRichText(linkifyRichText(note)));
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
    await updateDatabase(databaseId, { properties: removals });
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
    await updateDatabase(databaseId, { properties: additions });
  }

  return { removed: Object.keys(removals), added: Object.keys(additions) };
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

function buildCaseRunProperties(record) {
  const properties = {
    "Test Case Run": { title: titleText(record.title) },
    "Test Case ID": { number: record.testCaseId },
    "Legacy Number": { rich_text: richText(record.legacyNumber || "") },
    "Dokimion ID": { rich_text: dokimionRichText(record.dokimionId || "") },
    "Past Issues": { rich_text: linkifyRichText(record.pastIssues || "") },
    Summary: { rich_text: linkifyRichText(record.summary || "") },
    "Original Description": {
      rich_text: linkifyRichText(record.originalDescription || ""),
    },
    Areas: { multi_select: multiSelect(record.areas) },
    "Build Tested": { rich_text: richText(record.buildTested || "") },
    "Issue Links": { rich_text: linkifyRichText(record.issueLinks || "") },
    Status: { status: { name: record.status || "Not started" } },
    "Import Source Row Number": {
      rich_text: richText(String(record.sourceRowNumber ?? "")),
    },
    "Run Notes": { rich_text: linkifyRichText(record.runNotes || "") },
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
      const blocks = buildCaseRunBlocks(record);
      if (existingId) {
        await updatePage(existingId, properties);
        await writeBody(existingId, blocks, { replace: options.replaceBody });
        updated += 1;
      } else {
        const page = await createPage(databaseId, properties);
        await writeBody(page.id, blocks, { replace: options.replaceBody });
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

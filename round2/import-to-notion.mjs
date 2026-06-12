import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const round2Dir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(process.argv[2] || path.join(round2Dir, "build"));
const configPath = path.join(round2Dir, "notion-config.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const statePath = path.join(buildDir, "notion-state.json");
const failuresPath = path.join(buildDir, "notion-import-failures.json");

const DB_TITLE = "Test Case Runs";
const TITLE_PROPERTY = "Test Case Run";

// Resolved at runtime by ensureDatabase(): either the configured id, a
// previously created id from notion-state.json, or a freshly created database.
let databaseId = "";

const options = {
  allowLookup: process.env.ROUND2_ALLOW_LOOKUP !== "0",
  reconcileSchema: process.env.ROUND2_RECONCILE_SCHEMA !== "0",
  resetExisting: process.env.ROUND2_RESET_EXISTING === "1",
  replaceBody: process.env.ROUND2_REPLACE_BODY === "1",
  retryCount: Number(process.env.ROUND2_RETRY_COUNT || "6"),
  retryDelayMs: Number(process.env.ROUND2_RETRY_DELAY_MS || "3000"),
  requestTimeoutMs: Number(process.env.ROUND2_REQUEST_TIMEOUT_MS || "45000"),
};

// Properties the single Test Case Runs database needs. reconcileLiveSchema()
// adds any that are missing. The `Test Suite Run` tag is a closed select; its
// options are created on demand as run cards are written.
const REQUIRED_RUN_PROPERTIES = {
  "Import Run ID": { rich_text: {} },
  "Import ID": { rich_text: {} },
  "Test Suite Run": { select: {} },
  "Case Summary": { rich_text: {} },
  "Legacy Number": { rich_text: {} },
  "Dokimion ID": { rich_text: {} },
  "Past Issues": { rich_text: {} },
  "Est. Time (min)": { number: {} },
  Priority: { select: {} },
  Active: { checkbox: {} },
  Assignee: { rich_text: {} },
  "Build Tested": { rich_text: {} },
  "Issue Links": { rich_text: {} },
  OK: { checkbox: {} },
  "Historical Import": { checkbox: {} },
  "Source Row Number": { number: {} },
  "Tested On": { date: {} },
};

// Relation properties from the old three-database model. reconcileLiveSchema()
// drops them so suite-run / case membership lives entirely in the data folded
// onto each run card.
const OBSOLETE_RUN_RELATIONS = ["Test Case"];

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

function bulletBlockFromRichText(richTextValue) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richTextValue,
    },
  };
}

function formatOk(value) {
  if (value === "__YES__") {
    return "OK";
  }
  if (value === "__NO__") {
    return "Not OK";
  }
  return "No OK value";
}

function buildCaseRunBlocks(record) {
  const blocks = [headingBlock("Test Case Snapshot")];
  if (record.caseSnapshot) {
    for (const line of String(record.caseSnapshot).split(/\r?\n/)) {
      const content = clean(line);
      if (content) {
        blocks.push(paragraphBlock(content));
      }
    }
  } else {
    blocks.push(
      paragraphBlock("No snapshot text was present in the source row."),
    );
  }

  blocks.push(headingBlock("Imported Execution Details"));
  for (const entry of record.executionEntries || []) {
    const parts = [];
    if (entry.platform) {
      parts.push(entry.platform);
    }
    if (entry.person) {
      parts.push(`person: ${entry.person}`);
    }
    if (entry.testedOn || entry.rawDate) {
      parts.push(`date: ${entry.testedOn || entry.rawDate}`);
    }
    if (entry.build) {
      parts.push(`build: ${entry.build}`);
    }

    const fragments = richText(parts.join(" | "));
    if (entry.issue) {
      if (fragments.length > 0) {
        pushTextFragments(fragments, " | ");
      }
      pushTextFragments(fragments, "issues: ");
      fragments.push(...issueRichText(entry.issue));
    }
    if (fragments.length > 0) {
      pushTextFragments(fragments, " | ");
    }
    pushTextFragments(fragments, formatOk(entry.ok));
    blocks.push(bulletBlockFromRichText(fragments));
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

  // 1. Drop obsolete relations and any `Test Suite Run` that is still a
  //    relation (it is now a select tag). Removing the relation discards the
  //    historical link, which is expected for this migration.
  const removals = {};
  for (const name of OBSOLETE_RUN_RELATIONS) {
    if (liveProps[name]) {
      removals[name] = null;
    }
  }
  if (liveProps["Test Suite Run"] && liveProps["Test Suite Run"].type !== "select") {
    removals["Test Suite Run"] = null;
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

async function queryByTextId(databaseId, property, value) {
  const result = await execNotionJson(
    "POST",
    `databases/${normalizePageId(databaseId)}/query`,
    {
      filter: {
        property,
        rich_text: {
          equals: value,
        },
      },
      page_size: 2,
    },
  );
  return result.results || [];
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
    "Import Run ID": { rich_text: richText(record.importRunId) },
    "Import ID": { rich_text: richText(record.caseImportId || "") },
    "Case Summary": { rich_text: richText(record.caseSummary || "") },
    "Legacy Number": { rich_text: richText(record.legacyNumber || "") },
    "Dokimion ID": { rich_text: richText(record.dokimionId || "") },
    "Past Issues": { rich_text: issueRichText(record.pastIssues || "") },
    Assignee: { rich_text: richText(record.assignee || "") },
    "Build Tested": { rich_text: richText(record.buildTested || "") },
    "Issue Links": { rich_text: issueRichText(record.issueLinks || "") },
    OK: { checkbox: record.ok === "__YES__" },
    Active: { checkbox: Boolean(record.active) },
    "Historical Import": { checkbox: Boolean(record.historicalImport) },
    "Source Row Number": { number: record.sourceRowNumber },
  };

  if (record.suiteRunTag) {
    properties["Test Suite Run"] = {
      select: { name: selectName(record.suiteRunTag) },
    };
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

async function maybeLookupExistingPage(stateBucket, stateKey, value, state) {
  const current = pageIdFromState(stateBucket[stateKey]);
  if (current) {
    return current;
  }
  if (!options.allowLookup) {
    return "";
  }
  const matches = await queryByTextId(databaseId, "Import Run ID", value);
  if (matches.length > 0) {
    stateBucket[stateKey] = { pageId: matches[0].id };
    saveJson(statePath, state);
    return matches[0].id;
  }
  return "";
}

async function importCaseRuns(records, state, failures) {
  let created = 0;
  let updated = 0;
  for (const record of records) {
    try {
      const existingId = await maybeLookupExistingPage(
        state.caseRuns,
        record.importRunId,
        record.importRunId,
        state,
      );
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
  const caseRuns = loadJson(path.join(buildDir, "test-case-runs.json"), []);
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

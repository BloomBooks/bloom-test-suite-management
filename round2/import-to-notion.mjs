import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const round2Dir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(process.argv[2] || path.join(round2Dir, 'build'));
const configPath = path.join(round2Dir, 'notion-config.json');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const statePath = path.join(buildDir, 'notion-state.json');
const failuresPath = path.join(buildDir, 'notion-import-failures.json');

const options = {
  allowLookup: process.env.ROUND2_ALLOW_LOOKUP !== '0',
  skipSuiteRuns: process.env.ROUND2_SKIP_SUITE_RUNS === '1',
  skipCases: process.env.ROUND2_SKIP_CASES === '1',
  skipCaseRuns: process.env.ROUND2_SKIP_CASE_RUNS === '1',
  reconcileSchema: process.env.ROUND2_RECONCILE_SCHEMA !== '0',
  resetExisting: process.env.ROUND2_RESET_EXISTING === '1',
  replaceBody: process.env.ROUND2_REPLACE_BODY === '1',
  retryCount: Number(process.env.ROUND2_RETRY_COUNT || '6'),
  retryDelayMs: Number(process.env.ROUND2_RETRY_DELAY_MS || '3000'),
  requestTimeoutMs: Number(process.env.ROUND2_REQUEST_TIMEOUT_MS || '45000'),
};

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function clean(value) {
  return (value ?? '').trim();
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
      type: 'text',
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
  const content = String(value ?? '');
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
  const content = clean(value) || 'Untitled';
  return [{ text: { content: content.slice(0, 2000) } }];
}

function relation(pageId) {
  return pageId ? [{ id: pageId }] : [];
}

function normalizePageId(id) {
  return (id || '').replace(/-/g, '');
}

function chunkText(value, size = 1800) {
  const text = String(value ?? '');
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
    object: 'block',
    type: 'paragraph',
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
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: richText(text.slice(0, 2000)),
    },
  };
}

function bulletBlockFromRichText(richTextValue) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: richTextValue,
    },
  };
}

function bulletBlock(text) {
  return bulletBlockFromRichText(richText(text));
}

function toDoBlockFromRichText(richTextValue) {
  return {
    object: 'block',
    type: 'to_do',
    to_do: {
      rich_text: richTextValue,
      checked: false,
    },
  };
}

function toDoBlock(text) {
  return toDoBlockFromRichText(richText(text));
}

function deriveCaseRunStatus(record) {
  if (record.ok === '__YES__') {
    return 'Done';
  }
  if (!record.assignee) {
    return '';
  }
  if (record.issueLinks) {
    return 'Problems';
  }
  return 'In Progress';
}

function buildSuiteRunBlocks(record) {
  return [];
}

function buildCaseBlocks(record) {
  const blocks = [];
  if (record.description) {
    for (const line of String(record.description).split(/\r?\n/)) {
      const content = clean(line);
      if (content) {
        blocks.push(paragraphBlock(content));
      }
    }
  } else {
    blocks.push(paragraphBlock('No imported description was present in the spreadsheet.'));
  }
  return blocks;
}

function buildCaseRunBlocks(record) {
  const blocks = [];
  const bodyChecklistItems = Array.isArray(record.bodyChecklistItems) ? record.bodyChecklistItems.map((item) => clean(item)).filter(Boolean) : [];
  const checklistSteps = Array.isArray(record.checklistSteps) ? record.checklistSteps.map((step) => clean(step)).filter(Boolean) : [];
  const stepNotes = Array.isArray(record.stepNotes) ? record.stepNotes.map((note) => clean(note)).filter(Boolean) : [];

  if (bodyChecklistItems.length > 0) {
    for (const step of bodyChecklistItems) {
      blocks.push(toDoBlock(step));
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
  }

  if (blocks.length === 0) {
    blocks.push(paragraphBlock('No imported description was present in the spreadsheet.'));
  }

  return blocks;
}

async function execNotionJson(method, apiPath, body) {
  const token = process.env.BLOOM_TESTCASE_NOTION || process.env.NOTION_TOKEN || '';
  if (!token) {
    throw new Error('NOTION_TOKEN is not available.');
  }

  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);

    try {
      const response = await fetch(`https://api.notion.com/v1/${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const text = await response.text();
      let json = {};
      let parseFailed = false;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          parseFailed = true;
        }
      }
      if (response.ok) {
        if (parseFailed) {
          throw new Error(`Notion API returned a non-JSON success response: ${text.slice(0, 200)}`);
        }
        return json;
      }

      if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504 || parseFailed) && attempt < options.retryCount) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : options.retryDelayMs * (attempt + 1);
        await sleep(retryAfterMs);
        continue;
      }

      throw new Error(`Notion API Error (${response.status}): ${json.message || text}`);
    } catch (error) {
      clearTimeout(timer);
      if ((error.name === 'AbortError' || /timed out/i.test(String(error.message || error))) && attempt < options.retryCount) {
        await sleep(options.retryDelayMs * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Notion API request exhausted retries.');
}

async function getDatabase(databaseId) {
  return execNotionJson('GET', `databases/${normalizePageId(databaseId)}`);
}

async function updateDatabase(databaseId, body) {
  return execNotionJson('PATCH', `databases/${normalizePageId(databaseId)}`, body);
}

async function queryDatabase(databaseId, startCursor) {
  const body = { page_size: 100 };
  if (startCursor) {
    body.start_cursor = startCursor;
  }
  return execNotionJson('POST', `databases/${normalizePageId(databaseId)}/query`, body);
}

async function listDatabasePages(databaseId) {
  const pages = [];
  let startCursor = '';

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
  await execNotionJson('PATCH', `pages/${normalizePageId(pageId)}`, { in_trash: true });
}

async function reconcileLiveSchema() {
  const updates = { testCases: false, testSuiteRuns: false, testCaseRuns: false };
  const testCases = await getDatabase(config.databases.testCases);
  if (testCases.properties?.['Notes Link']) {
    await updateDatabase(config.databases.testCases, {
      properties: {
        'Notes Link': null,
      },
    });
    updates.testCases = true;
  }

  const testCaseRuns = await getDatabase(config.databases.testCaseRuns);
  const areaOptions = (testCaseRuns.properties?.Areas?.multi_select?.options || []).map((option) => ({
    name: option.name,
    color: option.color,
  }));

  if (!testCases.properties?.Areas) {
    await updateDatabase(config.databases.testCases, {
      properties: {
        Areas: {
          multi_select: areaOptions.length > 0 ? { options: areaOptions } : {},
        },
      },
    });
    updates.testCases = true;
  }

  if (testCases.properties?.['Historical Import']) {
    await updateDatabase(config.databases.testCases, {
      properties: {
        'Historical Import': null,
      },
    });
    updates.testCases = true;
  }

  if (!testCases.properties?.['Original Description']) {
    await updateDatabase(config.databases.testCases, {
      properties: {
        'Original Description': {
          rich_text: {},
        },
      },
    });
    updates.testCases = true;
  }

  const testSuiteRuns = await getDatabase(config.databases.testSuiteRuns);
  if (testSuiteRuns.properties?.['Historical Import']) {
    await updateDatabase(config.databases.testSuiteRuns, {
      properties: {
        'Historical Import': null,
      },
    });
    updates.testSuiteRuns = true;
  }

  const runPropertyUpdates = {};
  if (testCaseRuns.properties?.['Case Summary']) {
    runPropertyUpdates['Case Summary'] = null;
  }
  if (testCaseRuns.properties?.['Historical Import']) {
    runPropertyUpdates['Historical Import'] = null;
  }
  if (testCaseRuns.properties?.OK) {
    runPropertyUpdates.OK = null;
  }
  if (!testCaseRuns.properties?.Status) {
    runPropertyUpdates.Status = {
      select: {
        options: [
          { name: 'Done', color: 'green' },
          { name: 'In Progress', color: 'blue' },
          { name: 'Problems', color: 'red' },
        ],
      },
    };
  }
  if (!testCaseRuns.properties?.['Step Description']) {
    runPropertyUpdates['Step Description'] = {
      rich_text: {},
    };
  }
  if (Object.keys(runPropertyUpdates).length > 0) {
    await updateDatabase(config.databases.testCaseRuns, {
      properties: runPropertyUpdates,
    });
    updates.testCaseRuns = true;
  }

  return updates;
}

async function resetLiveData(state) {
  const archivedCounts = {
    caseRuns: 0,
    cases: 0,
    suiteRuns: 0,
  };

  const caseRunPages = await listDatabasePages(config.databases.testCaseRuns);
  for (const page of caseRunPages) {
    if (page.in_trash || page.archived) {
      continue;
    }
    await archivePage(page.id);
    archivedCounts.caseRuns += 1;
  }

  const casePages = await listDatabasePages(config.databases.testCases);
  for (const page of casePages) {
    if (page.in_trash || page.archived) {
      continue;
    }
    await archivePage(page.id);
    archivedCounts.cases += 1;
  }

  const suiteRunPages = await listDatabasePages(config.databases.testSuiteRuns);
  for (const page of suiteRunPages) {
    if (page.in_trash || page.archived) {
      continue;
    }
    await archivePage(page.id);
    archivedCounts.suiteRuns += 1;
  }

  state.suiteRuns = {};
  state.cases = {};
  state.caseRuns = {};
  saveJson(statePath, state);

  return archivedCounts;
}

async function queryByTextId(databaseId, property, value) {
  const result = await execNotionJson('POST', `databases/${normalizePageId(databaseId)}/query`, {
    filter: {
      property,
      rich_text: {
        equals: value,
      },
    },
    page_size: 2,
  });
  return result.results || [];
}

async function createPage(parentDatabaseId, properties) {
  return execNotionJson('POST', 'pages', {
    parent: { database_id: normalizePageId(parentDatabaseId) },
    properties,
  });
}

async function updatePage(pageId, properties) {
  return execNotionJson('PATCH', `pages/${normalizePageId(pageId)}`, { properties });
}

async function listChildren(pageId, startCursor = '') {
  const query = startCursor ? `?page_size=100&start_cursor=${encodeURIComponent(startCursor)}` : '?page_size=100';
  return execNotionJson('GET', `blocks/${normalizePageId(pageId)}/children${query}`);
}

async function appendChildren(pageId, children) {
  if (!children.length) {
    return;
  }
  await execNotionJson('PATCH', `blocks/${normalizePageId(pageId)}/children`, { children });
}

async function listAllChildren(pageId) {
  const children = [];
  let cursor = '';

  while (true) {
    const response = await listChildren(pageId, cursor);
    children.push(...(response.results || []));
    if (!response.has_more || !response.next_cursor) {
      return children;
    }
    cursor = response.next_cursor;
  }
}

async function deleteBlock(blockId) {
  return execNotionJson('DELETE', `blocks/${normalizePageId(blockId)}`);
}

async function syncBody(pageId, blocks, replaceExisting = false) {
  if (!blocks.length) {
    return;
  }

  if (!replaceExisting) {
    const existing = await listChildren(pageId);
    if ((existing.results || []).length > 0) {
      return;
    }
    await appendChildren(pageId, blocks);
    return;
  }

  const existing = await listAllChildren(pageId);
  for (const block of existing) {
    await deleteBlock(block.id);
  }
  await appendChildren(pageId, blocks);
}

function buildSuiteRunProperties(record) {
  return {
    'Test Suite Run': { title: titleText(record.name) },
    'Import Run Key': { rich_text: richText(record.importRunKey) },
  };
}

function multiSelect(values) {
  return Array.from(new Set((values || []).map((value) => clean(value)).filter(Boolean))).map((value) => ({ name: value }));
}

function buildCaseProperties(record) {
  const properties = {
    'Test Case': { title: titleText(record.title) },
    'Import ID': { rich_text: richText(record.importId) },
    'Original Description': { rich_text: richText(record.originalDescription || '') },
    'Source Row Number': { number: record.sourceRowNumber },
    'Legacy Number': { rich_text: richText(record.legacyNumber || '') },
    'Dokimion ID': { rich_text: richText(record.dokimionId || '') },
    'Past Issues': { rich_text: issueRichText(record.pastIssues || '') },
    Areas: { multi_select: multiSelect(record.areas) },
    Active: { checkbox: Boolean(record.active) },
  };

  if (record.priority) {
    properties.Priority = { select: { name: record.priority } };
  }
  if (typeof record.estTimeMin === 'number') {
    properties['Est. Time (min)'] = { number: record.estTimeMin };
  }

  return properties;
}

function buildCaseRunProperties(record, casePageId, suiteRunPageId) {
  const properties = {
    'Test Case Run': { title: titleText(record.title) },
    'Import Run ID': { rich_text: richText(record.importRunId) },
    'Step Description': { rich_text: richText(record.stepDescription || '') },
    Areas: { multi_select: multiSelect(record.areas) },
    'Test Suite Run': { relation: relation(suiteRunPageId) },
    'Test Case': { relation: relation(casePageId) },
    'Build Tested': { rich_text: richText(record.buildTested || '') },
    'Issue Links': { rich_text: issueRichText(record.issueLinks || '') },
    'Source Row Number': { number: record.sourceRowNumber },
  };

  if (record.assignee) {
    properties.Assignee = { select: { name: record.assignee } };
  }

  const status = deriveCaseRunStatus(record);
  if (status) {
    properties.Status = { status: { name: status } };
  }

  if (record.testedOn) {
    properties['Tested On'] = { date: { start: record.testedOn } };
  }

  return properties;
}

function ensureFailures(reset = false) {
  const initial = reset ? { suiteRuns: [], cases: [], caseRuns: [] } : loadJson(failuresPath, { suiteRuns: [], cases: [], caseRuns: [] });
  saveJson(failuresPath, initial);
  return initial;
}

function recordFailure(failures, kind, key, errorMessage) {
  failures[kind].push({ key, error: errorMessage });
  saveJson(failuresPath, failures);
}

function pageIdFromState(entry) {
  return entry && entry.pageId ? entry.pageId : '';
}

async function maybeLookupExistingPage(stateBucket, stateKey, databaseId, propertyName, value, state) {
  const current = pageIdFromState(stateBucket[stateKey]);
  if (current) {
    return current;
  }
  if (!options.allowLookup) {
    return '';
  }
  const matches = await queryByTextId(databaseId, propertyName, value);
  if (matches.length > 0) {
    stateBucket[stateKey] = { pageId: matches[0].id };
    saveJson(statePath, state);
    return matches[0].id;
  }
  return '';
}

async function importSuiteRuns(records, state, failures) {
  let created = 0;
  let updated = 0;
  for (const record of records) {
    try {
      const existingId = await maybeLookupExistingPage(
        state.suiteRuns,
        record.importRunKey,
        config.databases.testSuiteRuns,
        'Import Run Key',
        record.importRunKey,
        state,
      );
      const properties = buildSuiteRunProperties(record);
      if (existingId) {
        await updatePage(existingId, properties);
        await syncBody(existingId, buildSuiteRunBlocks(record));
        updated += 1;
      } else {
        const page = await createPage(config.databases.testSuiteRuns, properties);
        await syncBody(page.id, buildSuiteRunBlocks(record));
        state.suiteRuns[record.importRunKey] = { pageId: page.id };
        saveJson(statePath, state);
        created += 1;
      }
    } catch (error) {
      recordFailure(failures, 'suiteRuns', record.importRunKey, String(error.message || error));
    }
  }
  return { created, updated };
}

async function importCases(records, state, failures) {
  let created = 0;
  let updated = 0;
  for (const record of records) {
    try {
      const existingId = await maybeLookupExistingPage(
        state.cases,
        record.importId,
        config.databases.testCases,
        'Import ID',
        record.importId,
        state,
      );
      const properties = buildCaseProperties(record);
      if (existingId) {
        await updatePage(existingId, properties);
        await syncBody(existingId, buildCaseBlocks(record));
        updated += 1;
      } else {
        const page = await createPage(config.databases.testCases, properties);
        await syncBody(page.id, buildCaseBlocks(record));
        state.cases[record.importId] = { pageId: page.id };
        saveJson(statePath, state);
        created += 1;
      }
    } catch (error) {
      recordFailure(failures, 'cases', record.importId, String(error.message || error));
    }
  }
  return { created, updated };
}

async function importCaseRuns(records, state, failures) {
  let created = 0;
  let updated = 0;
  for (const record of records) {
    try {
      const casePageId = pageIdFromState(state.cases[record.caseImportId]);
      const suiteRunPageId = pageIdFromState(state.suiteRuns[record.importRunKey]);
      if (!casePageId || !suiteRunPageId) {
        throw new Error('Required relation target is missing from state.');
      }

      const existingId = await maybeLookupExistingPage(
        state.caseRuns,
        record.importRunId,
        config.databases.testCaseRuns,
        'Import Run ID',
        record.importRunId,
        state,
      );
      const properties = buildCaseRunProperties(record, casePageId, suiteRunPageId);
      if (existingId) {
        await updatePage(existingId, properties);
        await syncBody(existingId, buildCaseRunBlocks(record), options.replaceBody);
        updated += 1;
      } else {
        const page = await createPage(config.databases.testCaseRuns, properties);
        await syncBody(page.id, buildCaseRunBlocks(record));
        state.caseRuns[record.importRunId] = { pageId: page.id };
        saveJson(statePath, state);
        created += 1;
      }
    } catch (error) {
      recordFailure(failures, 'caseRuns', record.importRunId, String(error.message || error));
    }
  }
  return { created, updated };
}

async function main() {
  const suiteRuns = loadJson(path.join(buildDir, 'test-suite-runs.json'), []);
  const cases = loadJson(path.join(buildDir, 'test-cases.json'), []);
  const caseRuns = loadJson(path.join(buildDir, 'test-case-runs.json'), []);
  const state = loadJson(statePath, { suiteRuns: {}, cases: {}, caseRuns: {} });
  const failures = ensureFailures(true);
  const schemaResult = options.reconcileSchema ? await reconcileLiveSchema() : { testCases: false, testCaseRuns: false };
  const archivedCounts = options.resetExisting ? await resetLiveData(state) : { suiteRuns: 0, cases: 0, caseRuns: 0 };

  const suiteRunResult = options.skipSuiteRuns ? { created: 0, updated: 0 } : await importSuiteRuns(suiteRuns, state, failures);
  const caseResult = options.skipCases ? { created: 0, updated: 0 } : await importCases(cases, state, failures);
  const caseRunResult = options.skipCaseRuns ? { created: 0, updated: 0 } : await importCaseRuns(caseRuns, state, failures);

  console.log(
    JSON.stringify(
      {
        schemaUpdated: schemaResult,
        archivedCounts,
        suiteRunsCreated: suiteRunResult.created,
        suiteRunsUpdated: suiteRunResult.updated,
        casesCreated: caseResult.created,
        casesUpdated: caseResult.updated,
        caseRunsCreated: caseRunResult.created,
        caseRunsUpdated: caseRunResult.updated,
        suiteRunFailures: failures.suiteRuns.length,
        caseFailures: failures.cases.length,
        caseRunFailures: failures.caseRuns.length,
      },
      null,
      2,
    ),
  );
}

await main();
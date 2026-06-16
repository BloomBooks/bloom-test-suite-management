import fs from 'node:fs';
import path from 'node:path';

const workspaceDir = path.resolve(process.argv[2] || '.');
const buildDir = path.join(workspaceDir, 'build');
const casesPath = path.join(buildDir, 'bloom-cases.json');
const runsPath = path.join(buildDir, 'bloom-runs.json');
const statePath = path.join(buildDir, 'notion-state.json');
const failuresPath = path.join(buildDir, 'notion-import-failures.json');
const sanityPath = path.join(buildDir, 'notion-post-import-sanity.json');

const caseDatabaseId = '3304bb19df1280528bb1c14eb9148029';
const runDatabaseId = '3304bb19df1280eab05bd2e727e4454d';

const options = {
  limitCases: Number(process.env.IMPORT_LIMIT_CASES || '0'),
  limitRuns: Number(process.env.IMPORT_LIMIT_RUNS || '0'),
  caseOffset: Number(process.env.IMPORT_CASE_OFFSET || '0'),
  runOffset: Number(process.env.IMPORT_RUN_OFFSET || '0'),
  skipCases: process.env.IMPORT_SKIP_CASES === '1',
  skipRuns: process.env.IMPORT_SKIP_RUNS === '1',
  sanitySample: Number(process.env.IMPORT_SANITY_SAMPLE || '20'),
  concurrency: Number(process.env.IMPORT_CONCURRENCY || '6'),
  retryCount: Number(process.env.IMPORT_RETRY_COUNT || '6'),
  retryDelayMs: Number(process.env.IMPORT_RETRY_DELAY_MS || '3000'),
  requestTimeoutMs: Number(process.env.IMPORT_REQUEST_TIMEOUT_MS || '45000'),
  allowLookup: process.env.IMPORT_ALLOW_LOOKUP === '1',
  onlyCaseIds: (process.env.IMPORT_ONLY_CASE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
  onlyRunIds: (process.env.IMPORT_ONLY_RUN_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function richText(value) {
  if (!value) {
    return [];
  }
  return [{ text: { content: value } }];
}

function titleText(value) {
  return [{ text: { content: value } }];
}

function relation(pageId) {
  if (!pageId) {
    return [];
  }
  return [{ id: pageId }];
}

function pageIdFromState(entry) {
  return entry && entry.pageId ? entry.pageId : '';
}

function normalizePageId(id) {
  return (id || '').replace(/-/g, '');
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
      const json = text ? JSON.parse(text) : {};
      if (response.ok) {
        return json;
      }

      if ((response.status === 429 || response.status === 503) && attempt < options.retryCount) {
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

async function getPage(pageId) {
  return execNotionJson('GET', `pages/${normalizePageId(pageId)}`);
}

function buildCaseProperties(record) {
  const properties = {
    'Test Case': { title: titleText(record.name) },
    'Import ID': { rich_text: richText(record.importId) },
    'Case Code': { rich_text: richText(record.caseCode || '') },
    Steps: { rich_text: richText(record.steps || '') },
    'Past Issues': { rich_text: richText(record.pastIssues || '') },
  };
  if (record.priority) {
    properties.Priority = { select: { name: record.priority } };
  }
  return properties;
}

function buildRunProperties(record, casePageId) {
  const properties = {
    Run: { title: titleText(record.run) },
    'Import Run ID': { rich_text: richText(record.importRunId) },
    'Case Import ID': { rich_text: richText(record.caseImportId) },
    Person: { rich_text: richText(record.person || '') },
    Build: { rich_text: richText(record.build || '') },
    'Issue(s)': { rich_text: richText(record.issue || '') },
    OK: { checkbox: record.ok === '__YES__' },
    'Test Run Label': { rich_text: richText(record.testRunLabel || '') },
    Platform: { rich_text: richText(record.platform || '') },
  };

  if (record.date) {
    properties.Date = { date: { start: record.date } };
  }
  if (casePageId) {
    properties.Case = { relation: relation(casePageId) };
  }
  return properties;
}

function pickItems(items, limit) {
  if (!limit || limit < 1) {
    return items;
  }
  return items.slice(0, limit);
}

function applyOffset(items, offset) {
  if (!offset || offset < 1) {
    return items;
  }
  return items.slice(offset);
}

function ensureFailureStore() {
  return loadJson(failuresPath, { cases: [], runs: [], system: [] });
}

function recordFailure(failures, kind, key, errorMessage) {
  failures[kind].push({ key, error: errorMessage });
  saveJson(failuresPath, failures);
}

async function maybeLookupExistingCaseId(state, importId) {
  const current = pageIdFromState(state.cases[importId]);
  if (current) {
    return current;
  }
  if (!options.allowLookup) {
    return '';
  }
  const matches = await queryByTextId(caseDatabaseId, 'Import ID', importId);
  if (matches.length > 0) {
    state.cases[importId] = { pageId: matches[0].id };
    saveJson(statePath, state);
    return matches[0].id;
  }
  return '';
}

async function maybeLookupExistingRunId(state, importRunId) {
  const current = pageIdFromState(state.runs[importRunId]);
  if (current) {
    return current;
  }
  if (!options.allowLookup) {
    return '';
  }
  const matches = await queryByTextId(runDatabaseId, 'Import Run ID', importRunId);
  if (matches.length > 0) {
    state.runs[importRunId] = { pageId: matches[0].id };
    saveJson(statePath, state);
    return matches[0].id;
  }
  return '';
}

async function processWithConcurrency(items, label, failureKey, handler, failureStore, allFailures) {
  let processed = 0;
  const total = items.length;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= total) {
        return;
      }

      await handler(items[currentIndex], currentIndex);
      processed += 1;
      if (processed % 100 === 0 || processed === total) {
        console.log(`[${label}] processed ${processed}/${total} created=${failureStore.created} updated=${failureStore.updated} failures=${allFailures[failureKey].length}`);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, () => worker());
  await Promise.all(workers);
}

async function importCases(allCases, state, failures) {
  let created = 0;
  let updated = 0;
  const filteredCases = options.onlyCaseIds.length > 0 ? allCases.filter((record) => options.onlyCaseIds.includes(record.importId)) : allCases;
  const cases = pickItems(applyOffset(filteredCases, options.caseOffset), options.limitCases);

  const stats = { created: 0, updated: 0 };
  await processWithConcurrency(
    cases,
    'cases',
    'cases',
    async (record) => {
      try {
        const existingId = await maybeLookupExistingCaseId(state, record.importId);
        const properties = buildCaseProperties(record);
        if (existingId) {
          await updatePage(existingId, properties);
          updated += 1;
          stats.updated = updated;
        } else {
          const page = await createPage(caseDatabaseId, properties);
          state.cases[record.importId] = { pageId: page.id };
          saveJson(statePath, state);
          created += 1;
          stats.created = created;
        }
      } catch (error) {
        recordFailure(failures, 'cases', record.importId, String(error.message || error));
      }
    },
    stats,
    failures,
  );

  return { created, updated };
}

async function importRuns(allRuns, state, failures) {
  let created = 0;
  let updated = 0;
  const filteredRuns = options.onlyRunIds.length > 0 ? allRuns.filter((record) => options.onlyRunIds.includes(record.importRunId)) : allRuns;
  const runs = pickItems(applyOffset(filteredRuns, options.runOffset), options.limitRuns);

  const stats = { created: 0, updated: 0 };
  await processWithConcurrency(
    runs,
    'runs',
    'runs',
    async (record) => {
      try {
        const casePageId = await maybeLookupExistingCaseId(state, record.caseImportId);
        const properties = buildRunProperties(record, casePageId);
        const existingId = await maybeLookupExistingRunId(state, record.importRunId);
        if (existingId) {
          await updatePage(existingId, properties);
          updated += 1;
          stats.updated = updated;
        } else {
          const page = await createPage(runDatabaseId, properties);
          state.runs[record.importRunId] = { pageId: page.id };
          saveJson(statePath, state);
          created += 1;
          stats.created = created;
        }
      } catch (error) {
        recordFailure(failures, 'runs', record.importRunId, String(error.message || error));
      }
    },
    stats,
    failures,
  );

  return { created, updated };
}

function extractPlainText(property) {
  if (!property) {
    return '';
  }
  if (property.type === 'title') {
    return (property.title || []).map((item) => item.plain_text || '').join('');
  }
  if (property.type === 'rich_text') {
    return (property.rich_text || []).map((item) => item.plain_text || '').join('');
  }
  if (property.type === 'select') {
    return property.select?.name || '';
  }
  if (property.type === 'checkbox') {
    return property.checkbox ? '__YES__' : '__NO__';
  }
  if (property.type === 'date') {
    return property.date?.start || '';
  }
  if (property.type === 'relation') {
    return JSON.stringify((property.relation || []).map((entry) => entry.id));
  }
  return '';
}

function sampleRecords(records, count) {
  if (records.length <= count) {
    return records;
  }
  const result = [];
  const step = records.length / count;
  for (let index = 0; index < count; index += 1) {
    result.push(records[Math.floor(index * step)]);
  }
  return result;
}

async function runSanity(cases, runs, state) {
  const caseSamples = sampleRecords(cases, Math.min(options.sanitySample, cases.length));
  const runSamples = sampleRecords(runs, Math.min(options.sanitySample, runs.length));

  const caseChecks = [];
  for (const record of caseSamples) {
    const pageId = pageIdFromState(state.cases[record.importId]);
    if (!pageId) {
      caseChecks.push({ importId: record.importId, status: 'missing-state' });
      continue;
    }
    const page = await getPage(pageId);
    caseChecks.push({
      importId: record.importId,
      status: 'checked',
      expected: {
        name: record.name,
        caseCode: record.caseCode || '',
        steps: record.steps || '',
        priority: record.priority,
        pastIssues: record.pastIssues || '',
      },
      actual: {
        name: extractPlainText(page.properties['Test Case']),
        caseCode: extractPlainText(page.properties['Case Code']),
        steps: extractPlainText(page.properties.Steps),
        priority: extractPlainText(page.properties.Priority),
        pastIssues: extractPlainText(page.properties['Past Issues']),
      },
    });
  }

  const runChecks = [];
  for (const record of runSamples) {
    const pageId = pageIdFromState(state.runs[record.importRunId]);
    if (!pageId) {
      runChecks.push({ importRunId: record.importRunId, status: 'missing-state' });
      continue;
    }
    const page = await getPage(pageId);
    runChecks.push({
      importRunId: record.importRunId,
      status: 'checked',
      expected: {
        run: record.run,
        person: record.person || '',
        build: record.build || '',
        issue: record.issue || '',
        ok: record.ok || '__NO__',
        testRunLabel: record.testRunLabel || '',
        platform: record.platform || '',
        caseImportId: record.caseImportId,
      },
      actual: {
        run: extractPlainText(page.properties.Run),
        person: extractPlainText(page.properties.Person),
        build: extractPlainText(page.properties.Build),
        issue: extractPlainText(page.properties['Issue(s)']),
        ok: extractPlainText(page.properties.OK),
        testRunLabel: extractPlainText(page.properties['Test Run Label']),
        platform: extractPlainText(page.properties.Platform),
        caseImportId: extractPlainText(page.properties['Case Import ID']),
      },
    });
  }

  const mismatches = [];
  for (const check of [...caseChecks, ...runChecks]) {
    if (check.status !== 'checked') {
      mismatches.push(check);
      continue;
    }
    const diffs = [];
    for (const key of Object.keys(check.expected)) {
      if ((check.expected[key] || '') !== (check.actual[key] || '')) {
        diffs.push(key);
      }
    }
    if (diffs.length > 0) {
      mismatches.push({ ...check, mismatchedFields: diffs });
    }
  }

  const report = {
    sampledCases: caseChecks.length,
    sampledRuns: runChecks.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
  saveJson(sanityPath, report);
  return report;
}

async function main() {
  const cases = loadJson(casesPath, []);
  const runs = loadJson(runsPath, []);
  const state = loadJson(statePath, { cases: {}, runs: {} });
  const failures = ensureFailureStore();

  let caseResult = { created: 0, updated: 0 };
  let runResult = { created: 0, updated: 0 };

  if (!options.skipCases) {
    caseResult = await importCases(cases, state, failures);
  }
  if (!options.skipRuns) {
    runResult = await importRuns(runs, state, failures);
  }

  const sanity = await runSanity(cases, runs, state);

  console.log(
    JSON.stringify(
      {
        casesCreated: caseResult.created,
        casesUpdated: caseResult.updated,
        runsCreated: runResult.created,
        runsUpdated: runResult.updated,
        caseFailures: failures.cases.length,
        runFailures: failures.runs.length,
        sanityMismatchCount: sanity.mismatchCount,
      },
      null,
      2,
    ),
  );
}

await main();
import fs from 'node:fs';
import path from 'node:path';

const buildDir = path.resolve(process.argv[2] || 'build');
const batchSize = Number(process.argv[3] || 100);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function writeBatchFiles(targetDir, prefix, records) {
  fs.mkdirSync(targetDir, { recursive: true });
  const batches = chunk(records, batchSize);
  batches.forEach((batch, index) => {
    const fileName = `${prefix}-${String(index + 1).padStart(3, '0')}.json`;
    fs.writeFileSync(path.join(targetDir, fileName), JSON.stringify(batch, null, 2) + '\n', 'utf8');
  });
  return batches.length;
}

function main() {
  const cases = readJson(path.join(buildDir, 'bloom-cases.json'));
  const runs = readJson(path.join(buildDir, 'bloom-runs.json'));
  const existing = readJson(path.join(buildDir, 'existing-notion-ids.json'));

  const existingCaseIds = new Set(Object.keys(existing.cases || {}));
  const existingRunIds = new Set(Object.keys(existing.runs || {}));

  const casePayloads = cases
    .filter((record) => !existingCaseIds.has(record.importId))
    .map((record) => ({
      importId: record.importId,
      properties: {
        'Import ID': record.importId,
        'Test Case': record.name,
        'Case Code': record.caseCode || '',
        Steps: record.steps || '',
        Priority: record.priority,
        'Past Issues': record.pastIssues,
      },
    }));

  const runPayloads = runs
    .filter((record) => !existingRunIds.has(record.importRunId))
    .map((record) => {
      const properties = {
        'Import Run ID': record.importRunId,
        'Case Import ID': record.caseImportId,
        Run: record.run,
        Person: record.person,
        Build: record.build,
        'Issue(s)': record.issue,
        OK: record.ok || '__NO__',
        'Test Run Label': record.testRunLabel,
        Platform: record.platform,
      };
      if (record.date) {
        properties['date:Date:start'] = record.date;
      }
      return {
        importRunId: record.importRunId,
        caseImportId: record.caseImportId,
        properties,
      };
    });

  const caseBatchCount = writeBatchFiles(path.join(buildDir, 'notion-case-batches'), 'cases', casePayloads);
  const runBatchCount = writeBatchFiles(path.join(buildDir, 'notion-run-batches'), 'runs', runPayloads);

  fs.writeFileSync(
    path.join(buildDir, 'notion-batch-summary.json'),
    JSON.stringify(
      {
        caseCount: casePayloads.length,
        runCount: runPayloads.length,
        caseBatchCount,
        runBatchCount,
        batchSize,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(
    JSON.stringify(
      {
        caseCount: casePayloads.length,
        runCount: runPayloads.length,
        caseBatchCount,
        runBatchCount,
      },
      null,
      2,
    ),
  );
}

main();
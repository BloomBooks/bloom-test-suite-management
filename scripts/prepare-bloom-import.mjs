import fs from 'node:fs';
import path from 'node:path';

const csvPath = path.resolve(process.argv[2] || 'Bloom Test Plan.csv');
const outDir = path.resolve(process.argv[3] || 'build');

const ALLOWED_PRIORITIES = new Map([
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['IGNORE', 'Ignore'],
  ['DUP', 'Duplicate'],
  ['DUPLICATE', 'Duplicate'],
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
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

    if (char === ',') {
      row.push(value);
      value = '';
      continue;
    }

    if (char === '\r') {
      continue;
    }

    if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
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

function encodeCsvValue(value) {
  const stringValue = value ?? '';
  if (/[",\n\r]/.test(stringValue)) {
    return '"' + stringValue.replace(/"/g, '""') + '"';
  }
  return stringValue;
}

function serializeCsv(rows) {
  return rows.map((row) => row.map(encodeCsvValue).join(',')).join('\r\n') + '\r\n';
}

function clean(value) {
  return (value ?? '').trim();
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function ensureWidth(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  for (const row of rows) {
    while (row.length < width) {
      row.push('');
    }
  }
  return width;
}

function ensureImportIdColumn(rows) {
  const headerRow = rows[1] ?? [];
  if (headerRow[0] === 'Import ID') {
    return 0;
  }

  for (const row of rows) {
    row.unshift('');
  }
  rows[1][0] = 'Import ID';
  return 0;
}

function normalizePriority(value) {
  const normalized = clean(value).toUpperCase();
  return ALLOWED_PRIORITIES.get(normalized) ?? '';
}

function looksImportableRow(row, baseIndex, runStart) {
  const priority = normalizePriority(row[baseIndex.priority]);
  const docId = clean(row[baseIndex.dokimion]);
  const description = clean(row[baseIndex.description]);
  const sourceRef = clean(row[baseIndex.sourceRef]);
  const hasRunData = row.slice(runStart).some((cell) => clean(cell) !== '');

  if (!hasRunData && !priority && !docId && !description && !sourceRef) {
    return false;
  }

  if (priority) {
    return true;
  }

  if (docId && hasRunData) {
    return true;
  }

  if (sourceRef && hasRunData) {
    return true;
  }

  return false;
}

function buildImportId(row, rowNumber, baseIndex) {
  const sourceRef = clean(row[baseIndex.sourceRef]);
  const docId = clean(row[baseIndex.dokimion]);

  if (sourceRef) {
    return `src-${slugify(sourceRef)}`;
  }

  if (docId) {
    return `src-${slugify(docId)}-r${rowNumber}`;
  }

  return `src-r${rowNumber}`;
}

function buildCaseName(row, baseIndex) {
  const description = clean(row[baseIndex.description]);
  const docId = clean(row[baseIndex.dokimion]);
  const normalized = description
    .replace(/^[\-\s]+/, '')
    .replace(/^--\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || docId || 'Untitled Test Case';
}

function buildCaseSteps(row, baseIndex) {
  return clean(row[baseIndex.description]);
}

function extractVersionInfo(rawLabel, fieldLabel) {
  const source = clean(rawLabel) || clean(fieldLabel);
  const versionMatch = source.match(/\d+(?:\.\d+)?/);
  const label = versionMatch ? versionMatch[0] : source;
  let platform = source.replace(/^\d+(?:\.\d+)?\s*/i, '').trim();

  if (/^person testing\s+/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/^person testing\s+/i, ''));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  if (/^date this test last done in\s+/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/^date this test last done in\s+/i, ''));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  if (/^build tested in\s+/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/^build tested in\s+/i, ''));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  if (/issues found/i.test(fieldLabel)) {
    platform = clean(fieldLabel.replace(/issues found.*$/i, ''));
    const embedded = platform.match(/^(\d+(?:\.\d+)?)\s+(.*)$/i);
    if (embedded) {
      return { testRunLabel: embedded[1], platform: embedded[2].trim() };
    }
  }

  return { testRunLabel: label, platform };
}

function detectSlots(headerTop, headerBottom, runStart) {
  const slots = [];
  const width = headerBottom.length;
  let column = runStart;

  while (column < width) {
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
      /^person$/i.test(quintet[0] || '') &&
      /^date$/i.test(quintet[1] || '') &&
      /^build/i.test(quintet[2] || '') &&
      /^issue\(s\)$/i.test(quintet[3] || '') &&
      /^ok\?$/i.test(quintet[4] || '');

    if (isQuintet) {
      const labels = headerTop.slice(column, column + 5).map(clean).filter(Boolean);
      const headerLabel = labels[0] || '';
      const versionInfo = extractVersionInfo(headerLabel, field);
      slots.push({
        startColumn: column,
        headerLabel,
        keyHint: headerLabel,
        testRunLabelHint: versionInfo.testRunLabel || 'unknown',
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

    if (/^issue\(s\)$/i.test(field) && /^ok\?$/i.test(clean(headerBottom[column + 1] || ''))) {
      const labels = headerTop.slice(column, column + 2).map(clean).filter(Boolean);
      const headerLabel = labels[0] || top;
      const versionInfo = extractVersionInfo(headerLabel, field);
      slots.push({
        startColumn: column,
        headerLabel,
        keyHint: headerLabel,
        testRunLabelHint: versionInfo.testRunLabel || 'unknown',
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
        keyHint: field,
        testRunLabelHint: versionInfo.testRunLabel || 'unknown',
        platformHint: versionInfo.platform,
        personColumn: column,
        dateColumn: /^date this test last done in\s+/i.test(clean(headerBottom[column + 1] || '')) ? column + 1 : null,
        buildColumn: /^build tested in\s+/i.test(clean(headerBottom[column + 2] || '')) ? column + 2 : null,
        issueColumn: /issues found/i.test(clean(headerBottom[column + 3] || '')) ? column + 3 : null,
        okColumn: null,
      });
      column += 4;
      continue;
    }

    column += 1;
  }

  for (const slot of slots) {
    slot.key = slugify(`${slot.testRunLabelHint} ${slot.platformHint}`) || `slot-${slot.startColumn}`;
  }

  return slots;
}

function deriveRunMetadata(slot, build) {
  const buildMatch = clean(build).match(/(\d+\.\d+)/);
  const headerInfo = extractVersionInfo(slot.headerLabel || slot.keyHint, slot.headerLabel || slot.keyHint);
  return {
    testRunLabel: buildMatch ? buildMatch[1] : (slot.testRunLabelHint || headerInfo.testRunLabel || 'unknown'),
    platform: slot.platformHint || headerInfo.platform || '',
  };
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw || /^n\/a$/i.test(raw)) {
    return { value: '', status: raw ? 'not-applicable' : 'blank' };
  }

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return { value: `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, status: 'ok' };
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
        value: `${textDate[3]}-${String(month).padStart(2, '0')}-${String(Number(textDate[1])).padStart(2, '0')}`,
        status: 'ok',
      };
    }
  }

  const slashDate = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const yearToken = slashDate[3];
    if (!yearToken) {
      return { value: '', status: 'missing-year', raw };
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
      value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      status: 'ok',
    };
  }

  return { value: '', status: 'unparsed', raw };
}

function normalizeOk(value) {
  const raw = clean(value).toUpperCase();
  if (!raw) {
    return '';
  }
  if (raw === 'TRUE') {
    return '__YES__';
  }
  if (raw === 'FALSE' || raw === 'N/A') {
    return '__NO__';
  }
  return '';
}

function createRunTitle(caseRow, slot, baseIndex) {
  const metadata = deriveRunMetadata(slot, slot.buildValue || '');
  const docId = clean(caseRow[baseIndex.dokimion]);
  const sourceRef = clean(caseRow[baseIndex.sourceRef]);
  const primary = docId || sourceRef || 'Case';
  const pieces = [primary, metadata.testRunLabel];
  if (metadata.platform) {
    pieces.push(metadata.platform);
  }
  return pieces.join(' / ');
}

function main() {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  ensureWidth(rows);
  ensureImportIdColumn(rows);
  const width = ensureWidth(rows);

  const baseIndex = {
    importId: 0,
    sourceRef: 1,
    description: 2,
    dokimion: 3,
    priority: 4,
    pastIssues: 5,
    timeToTest: 6,
  };
  const runStart = 7;
  const slots = detectSlots(rows[0], rows[1], runStart);

  const cases = [];
  const runs = [];
  const sanity = {
    caseCount: 0,
    runCount: 0,
    slots: slots.map((slot) => ({
      key: slot.key,
      testRunLabel: slot.testRunLabelHint,
      platform: slot.platformHint,
      columns: {
        person: slot.personColumn,
        date: slot.dateColumn,
        build: slot.buildColumn,
        issue: slot.issueColumn,
        ok: slot.okColumn,
      },
    })),
    dateWarnings: [],
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex < 5) {
      continue;
    }

    const row = rows[rowIndex];
    while (row.length < width) {
      row.push('');
    }

    if (!looksImportableRow(row, baseIndex, runStart)) {
      continue;
    }

    if (!clean(row[baseIndex.importId])) {
      row[baseIndex.importId] = buildImportId(row, rowIndex + 1, baseIndex);
    }

    const importId = clean(row[baseIndex.importId]);
    const priority = normalizePriority(row[baseIndex.priority]);
    const testCase = {
      importId,
      sourceRef: clean(row[baseIndex.sourceRef]),
      dokimion: clean(row[baseIndex.dokimion]),
      name: buildCaseName(row, baseIndex),
      caseCode: clean(row[baseIndex.dokimion]),
      steps: buildCaseSteps(row, baseIndex),
      priority,
      pastIssues: clean(row[baseIndex.pastIssues]),
      rowNumber: rowIndex + 1,
    };
    cases.push(testCase);

    for (const slot of slots) {
      const person = slot.personColumn == null ? '' : clean(row[slot.personColumn]);
      const rawDate = slot.dateColumn == null ? '' : clean(row[slot.dateColumn]);
      const build = slot.buildColumn == null ? '' : clean(row[slot.buildColumn]);
      const issue = slot.issueColumn == null ? '' : clean(row[slot.issueColumn]);
      const ok = slot.okColumn == null ? '' : normalizeOk(row[slot.okColumn]);
      const date = normalizeDate(rawDate);
      const hasData = Boolean(person || rawDate || build || issue);
      const metadata = deriveRunMetadata(slot, build);

      if (!hasData) {
        continue;
      }

      if (date.status !== 'ok' && rawDate) {
        sanity.dateWarnings.push({
          importId,
          runKey: slot.key,
          rawDate,
          status: date.status,
        });
      }

      runs.push({
        importRunId: `${importId}::${slot.key}`,
        caseImportId: importId,
        run: createRunTitle(row, { ...slot, buildValue: build }, baseIndex),
        testRunLabel: metadata.testRunLabel,
        platform: metadata.platform,
        person,
        date: date.value,
        build,
        issue,
        ok,
        rowNumber: rowIndex + 1,
      });
    }
  }

  sanity.caseCount = cases.length;
  sanity.runCount = runs.length;

  fs.mkdirSync(outDir, { recursive: true });
  const csvOutput = serializeCsv(rows);
  const fallbackCsvPath = path.join(outDir, path.basename(csvPath, path.extname(csvPath)) + '.with-import-id.csv');

  fs.writeFileSync(path.join(outDir, 'bloom-cases.json'), JSON.stringify(cases, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'bloom-runs.json'), JSON.stringify(runs, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'bloom-sanity.json'), JSON.stringify(sanity, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'bloom-headers.json'), JSON.stringify(rows[0].map((top, index) => ({ index, top: clean(top), field: clean(rows[1][index]) })), null, 2) + '\n', 'utf8');

  let csvWriteTarget = csvPath;
  try {
    fs.writeFileSync(csvPath, csvOutput, 'utf8');
  } catch (error) {
    if (error && error.code === 'EBUSY') {
      fs.writeFileSync(fallbackCsvPath, csvOutput, 'utf8');
      csvWriteTarget = fallbackCsvPath;
    } else {
      throw error;
    }
  }

  console.log(JSON.stringify({
    csvPath: csvWriteTarget,
    outDir,
    caseCount: cases.length,
    runCount: runs.length,
    slotCount: slots.length,
    dateWarningCount: sanity.dateWarnings.length,
  }, null, 2));
}

main();
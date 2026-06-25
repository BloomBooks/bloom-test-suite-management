import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.resolve(process.argv[2] || path.join(scriptDir, 'Bloom Test Plan.csv'));
const outDir = path.resolve(process.argv[3] || path.join(scriptDir, 'output'));
const areaMappingPath = path.join(scriptDir, 'area-mapping.json');
const titleMappingPath = path.join(scriptDir, 'title-mapping.json');
const stepOverridePath = path.join(scriptDir, 'step-overrides.json');
const curationPath = path.join(scriptDir, 'curation.json');
// Source of Dokimion cases. Rows 507-567 and 592-608 have run data (6.3 / 6.4
// quintets); rows 609+ are YouTrack-only issues with no run data. See
// buildTempDokimionRecords and buildYouTrackOnlyRecords.
const tempDokimionPath = path.join(scriptDir, 'Bloom Test Plan - temp Dokimion cases.csv');
const caseOffset = Number(process.env.IMPORT_CASE_OFFSET || '0');
const caseLimit = Number(process.env.IMPORT_LIMIT_CASES || '10');
const areaMapping = JSON.parse(fs.readFileSync(areaMappingPath, 'utf8'));
const titleMapping = JSON.parse(fs.readFileSync(titleMappingPath, 'utf8'));
const stepOverrides = fs.existsSync(stepOverridePath) ? JSON.parse(fs.readFileSync(stepOverridePath, 'utf8')) : {};
// Manual curation keyed by normalized test description (the same key
// `area-mapping.json` uses, so it survives row reordering). Each entry is
// either `{ "kind": "instruction" }` — dropped as a test case, with its text
// prepended to the following tests — or `{ "priority": "<label>" }`, which
// forces that priority (used to mark rows "Ignore" whose source priority cell
// is blank).
const curation = fs.existsSync(curationPath) ? JSON.parse(fs.readFileSync(curationPath, 'utf8')) : { rows: {} };
const curationRows = curation.rows || {};

const ALLOWED_PRIORITIES = new Map([
  ['0', 'Ignore'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['IGNORE', 'Ignore'],
  ['DEPRECATED', 'Ignore'],
  ['DUP', 'Duplicate'],
  ['DUPLICATE', 'Duplicate'],
]);

const TITLE_OVERRIDES = [
  {
    pattern: /latest version installs on standard user account with no admin privileges/i,
    title: 'Install as Standard User',
  },
  {
    pattern: /in environment variables, try a new machine install with feedback set to false/i,
    title: 'Install with Feedback Off',
  },
  {
    pattern: /latest version installs on a clean machine.*smoke test/i,
    title: 'Clean Install Smoke Test',
  },
  {
    pattern: /latest version installs on admin account with user account control/i,
    title: 'Install with UAC',
  },
  {
    pattern: /check for new version.*your bloom is up to date/i,
    title: 'Check for New Version -- up to date',
  },
  {
    pattern: /check for updates gives proper response when offline/i,
    title: 'Check Updates Offline',
  },
  {
    pattern: /can'?t check for new version offline.*after reconnect/i,
    title: 'Reconnect after Offline Check',
  },
  {
    pattern: /install next to last version of bloom.*updates itself/i,
    title: 'Update from Previous Version',
  },
  {
    pattern: /updates" or "applying updates" does not get lost behind other windows/i,
    title: 'Keep Update Dialog Visible',
  },
];

const AREA_NOTE_PREFIXES = [
  /^n\.b\./i,
  /^see heading/i,
  /^please test this area/i,
];

const VERIFY_PATTERNS = [
  /^verify\b/i,
  /^ensure\b/i,
  /^expect\b/i,
  /^confirm\b/i,
  /^the message should\b/i,
  /^message (?:says|should)\b/i,
  /^bloom should\b/i,
  /^we should(?: not|n't)\b/i,
  /^there is no\b/i,
  /^reports?\b/i,
  /^response shows up\b/i,
  /^error handling works\b/i,
];

const NOTE_PATTERNS = [
  /^note:\s*/i,
  /^n\.b\.\s*/i,
  /^update:\s*/i,
  /^currently\b/i,
  /^this is currently\b/i,
  /^jt\s+/i,
  /^vm notes\b/i,
  /^may not work\b/i,
  /^bloom 6\.3\b/i,
];

const ACTION_VERB_PATTERN = '(?:Open|Select|Close|Delete|Restart|Install|Check|Choose|Turn|Start|Approve|Disconnect|Reconnect|Respond|Submit|Set|Sign|Attempt|Wait|Use|Edit|Try|Make|Unzip|Zip|Report|Register|Upgrade|Navigate|Boot|Copy|Take|Setup|Recover|Click|Remove|Go|Launch|Fill|Send|Return|Watch|Review|Directly\s+open|Test)';
const ACTION_COMMA_SPLIT_RE = new RegExp(`,\\s+(?=(?:then\\s+)?${ACTION_VERB_PATTERN}\\b)`, 'i');
const ACTION_AND_SPLIT_RE = new RegExp(`\\s+(?:and|then)\\s+(?=${ACTION_VERB_PATTERN}\\b)`, 'i');
const MIXED_SEGMENT_SPLIT_RE = /\s+(?=(?:Ensure|Verify|Expect|Confirm|The message should|Message (?:says|should)|Bloom should|We should(?: not|n't)|There is no|Reports?\b|Response shows up|Error handling works)\b)/i;

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

function clean(value) {
  return (value ?? '').trim();
}

// Suite runs older than this (major.minor) are not imported.
const MIN_SUITE_RUN = { major: 5, minor: 5 };

// Strip the "BetaInternal" qualifier from a suite-run name (e.g.
// "5.4 BetaInternal" -> "5.4") and collapse the leftover whitespace.
function cleanSuiteRunName(name) {
  return clean(String(name ?? '').replace(/\bBetaInternal\b/gi, '')).replace(/\s+/g, ' ');
}

// Keep only suite runs at or after MIN_SUITE_RUN. The version is the leading
// `major.minor` of the name; majors/minors compare as integers so a future
// two-digit minor (e.g. 5.10) is not misordered against 5.9. Names without a
// parseable version are kept.
function suiteRunInRange(name) {
  const match = String(name ?? '').match(/^(\d+)(?:\.(\d+))?/);
  if (!match) {
    return true;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  return (
    major > MIN_SUITE_RUN.major ||
    (major === MIN_SUITE_RUN.major && minor >= MIN_SUITE_RUN.minor)
  );
}

// A run was deliberately skipped when the tester/assignee cell starts with
// "skip" (e.g. "skip", "SKIP (AP)", "Skip: fix in 5.5").
function isSkippedAssignee(value) {
  return /^\s*skip/i.test(String(value ?? ''));
}

// Assignees are a closed set. A tester cell is mapped to one of these canonical
// names (case-insensitive), with SteveMc treated as Steve. Anything else
// (e.g. "Future", a review comment typed into the cell, an unknown name) maps
// to "" — the raw text is still preserved in the run's importNotes.
const ASSIGNEES = [
  'Andrew',
  'Bharani',
  'Hatton',
  'Jeffrey',
  'JohnT',
  'Steve',
  'Noel',
  'Heather',
  'Colin',
  'Gordon',
];
const ASSIGNEE_BY_LOWER = new Map(ASSIGNEES.map((name) => [name.toLowerCase(), name]));
const ASSIGNEE_ALIASES = new Map([['stevemc', 'Steve']]);

function normalizeAssignee(value) {
  const key = clean(value).toLowerCase();
  if (!key) {
    return '';
  }
  return ASSIGNEE_BY_LOWER.get(key) || ASSIGNEE_ALIASES.get(key) || '';
}

// Capture raw execution details that don't survive normalization into the
// clean run properties, so nothing from the source is silently dropped:
// a tester cell that mapped to no assignee (a skip reason, "Future", a review
// comment, an unknown name), an unparsable date, or a platform hint.
function buildImportNotes(primary, assignee) {
  if (!primary) {
    return '';
  }
  const parts = [];
  const rawPerson = clean(primary.person);
  if (rawPerson && !assignee) {
    parts.push(rawPerson);
  }
  if (clean(primary.rawDate) && !clean(primary.testedOn)) {
    parts.push(`Unparsed date: ${clean(primary.rawDate)}`);
  }
  if (clean(primary.platform)) {
    parts.push(`Platform: ${clean(primary.platform)}`);
  }
  return parts.join('\n');
}

function textList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => clean(value)).filter(Boolean);
}

function stripListMarker(value) {
  return clean(value)
    .replace(/^[-*]+\s*/, '')
    .replace(/^\d+\)\s*/, '')
    .replace(/^[A-Za-z]\)\s*/, '');
}

function finalizeStepText(value) {
  const content = clean(value).replace(/\s+/g, ' ');
  if (!content) {
    return '';
  }
  if (/[.!?]$/.test(content) || /"$/.test(content)) {
    return content;
  }
  return `${content}.`;
}

function dedupeText(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const content = finalizeStepText(value);
    const key = content.toLowerCase();
    if (!content || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(content);
  }
  return result;
}

function sentenceParts(value) {
  const content = clean(value).replace(/\s+/g, ' ');
  if (!content) {
    return [];
  }
  return content
    .split(/(?<=[.!?])\s+(?=(?:[A-Z"(]|\d+\)|BL-\d+))/)
    .map((part) => clean(part))
    .filter(Boolean);
}

function splitMixedSegment(value) {
  const segments = [];
  let remaining = clean(value);

  while (remaining) {
    const match = remaining.match(MIXED_SEGMENT_SPLIT_RE);
    if (!match || match.index == null || match.index === 0) {
      segments.push(remaining);
      break;
    }
    segments.push(clean(remaining.slice(0, match.index)));
    remaining = clean(remaining.slice(match.index));
  }

  return segments.filter(Boolean);
}

function isVerificationText(value) {
  const content = stripListMarker(value);
  return VERIFY_PATTERNS.some((pattern) => pattern.test(content));
}

function isNoteText(value) {
  const content = stripListMarker(value);
  return NOTE_PATTERNS.some((pattern) => pattern.test(content));
}

function splitActionText(value) {
  const base = stripListMarker(value)
    .replace(/\s+--\s+/g, '. ')
    .replace(/\s+/g, ' ');

  if (!base) {
    return [];
  }

  return base
    .split(ACTION_COMMA_SPLIT_RE)
    .flatMap((part) => part.split(ACTION_AND_SPLIT_RE))
    .map((part) => clean(part).replace(/^then\s+/i, ''))
    .filter(Boolean)
    .map(finalizeStepText);
}

function compactPhrase(value) {
  return clean(value)
    .replace(/[.!?]$/, '')
    .replace(/^Set OS culture to\s+/i, 'Set ')
    .replace(/^In\s+/i, '')
    .replace(/^Directly\s+/i, 'Directly ');
}

function buildStepDescription(checklistSteps, fallbackTitle) {
  const phrases = [];
  let wordCount = 0;

  for (const step of checklistSteps) {
    const words = compactPhrase(step).split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      continue;
    }
    const limited = words.slice(0, 6).join(' ');
    const nextCount = wordCount + limited.split(/\s+/).length;
    if (nextCount > 20 && phrases.length > 0) {
      break;
    }
    phrases.push(limited);
    wordCount = nextCount;
    if (phrases.length >= 4) {
      break;
    }
  }

  const summary = phrases.join(', ') || clean(fallbackTitle);
  return finalizeStepText(summary);
}

function inferProcessedContent(title, description) {
  const checklistSteps = [];
  const stepNotes = [];

  for (const rawLine of String(description || '').split(/\r?\n/)) {
    const line = stripListMarker(rawLine);
    if (!line) {
      continue;
    }

    for (const sentence of sentenceParts(line)) {
      for (const segment of splitMixedSegment(sentence)) {
        if (isNoteText(segment) || isVerificationText(segment)) {
          stepNotes.push(segment);
          continue;
        }
        checklistSteps.push(...splitActionText(segment));
      }
    }
  }

  const dedupedSteps = dedupeText(checklistSteps);
  const dedupedNotes = dedupeText(stepNotes);

  if (dedupedSteps.length === 0 && clean(title)) {
    dedupedSteps.push(finalizeStepText(title));
  }

  return {
    stepDescription: buildStepDescription(dedupedSteps, title),
    checklistSteps: dedupedSteps,
    stepNotes: dedupedNotes,
  };
}

function buildProcessedContent(title, description, override) {
  const inferred = inferProcessedContent(title, description);
  const checklistSteps = textList(override?.checklistSteps).length > 0 ? dedupeText(textList(override.checklistSteps)) : inferred.checklistSteps;
  const stepNotes = textList(override?.stepNotes).length > 0 ? dedupeText(textList(override.stepNotes)) : inferred.stepNotes;
  const stepDescription = clean(override?.stepDescription) || inferred.stepDescription;

  return {
    stepDescription,
    checklistSteps,
    stepNotes,
    bodyChecklistItems: dedupeText([...checklistSteps, ...stepNotes]),
  };
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
    return;
  }

  for (const row of rows) {
    row.unshift('');
  }
  rows[1][0] = 'Import ID';
}

function normalizePriority(value) {
  const normalized = clean(value).toUpperCase();
  return ALLOWED_PRIORITIES.get(normalized) ?? '';
}

function normalizeDescription(value) {
  return clean(value)
    .replace(/^[\-\s]+/, '')
    .replace(/^--\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectSlotColumns(slots) {
  const columns = new Set();
  for (const slot of slots) {
    for (const column of [slot.personColumn, slot.dateColumn, slot.buildColumn, slot.issueColumn, slot.okColumn]) {
      if (column != null) {
        columns.add(column);
      }
    }
  }
  return [...columns].sort((left, right) => left - right);
}

function isMeaningfulSlotValue(kind, value) {
  const content = clean(value);
  if (!content || content.toUpperCase() === 'FALSE' || /^total:?$/i.test(content)) {
    return false;
  }

  if (kind === 'person') {
    return /[A-Za-z]/.test(content);
  }

  if (kind === 'date') {
    return normalizeDate(content).status === 'ok';
  }

  if (kind === 'build') {
    return /[A-Za-z]/.test(content) || /\d+\.\d+/.test(content);
  }

  if (kind === 'issue') {
    return !/^\d+$/.test(content);
  }

  if (kind === 'ok') {
    return normalizeOk(content) === '__YES__';
  }

  return false;
}

function hasMeaningfulRunData(row, slots) {
  return slots.some((slot) => {
    return (
      (slot.personColumn != null && isMeaningfulSlotValue('person', row[slot.personColumn])) ||
      (slot.dateColumn != null && isMeaningfulSlotValue('date', row[slot.dateColumn])) ||
      (slot.buildColumn != null && isMeaningfulSlotValue('build', row[slot.buildColumn])) ||
      (slot.issueColumn != null && isMeaningfulSlotValue('issue', row[slot.issueColumn])) ||
      (slot.okColumn != null && isMeaningfulSlotValue('ok', row[slot.okColumn]))
    );
  });
}

function looksLikeAreaHeading(text) {
  const value = normalizeDescription(text);
  if (!value) {
    return false;
  }

  if (AREA_NOTE_PREFIXES.some((pattern) => pattern.test(value))) {
    return false;
  }

  if (value.length > 90) {
    return false;
  }

  if (/[.!?]$/.test(value) && !/:$/.test(value) && value.split(/\s+/).length > 6) {
    return false;
  }

  return true;
}

function isMajorAreaHeading(text) {
  const value = normalizeDescription(text);
  if (!value) {
    return false;
  }

  const wordCount = value.split(/\s+/).length;
  return !/[:(]/.test(value) && wordCount <= 5;
}

function getMappedRow(text) {
  return areaMapping.rows[normalizeDescription(text)] || null;
}

function appendUniqueInstruction(instructions, instruction) {
  const content = clean(instruction);
  if (!content) {
    return instructions;
  }

  if (instructions.some((entry) => entry.toLowerCase() === content.toLowerCase())) {
    return instructions;
  }

  return [...instructions, content];
}

function prependInstruction(description, instructions) {
  const details = clean(description);
  const prefix = (instructions || []).map((instruction) => clean(instruction)).filter(Boolean).join('\n\n');

  if (!prefix) {
    return details;
  }

  if (!details) {
    return prefix;
  }

  if (details.toLowerCase().startsWith(prefix.toLowerCase())) {
    return details;
  }

  return `${prefix}\n\n${details}`;
}

function resolveAreaHeading(activeContext, text) {
  const heading = normalizeDescription(text);
  if (!heading) {
    return activeContext;
  }

  const mapped = getMappedRow(heading);
  const area = mapped?.area || heading;
  const previousAreas = activeContext?.areas || [];
  const instructions = mapped?.instruction ? [mapped.instruction] : [];

  if (isMajorAreaHeading(area) || previousAreas.length === 0 || mapped?.kind === 'area') {
    return {
      areas: [area],
      instructions,
    };
  }

  return {
    areas: Array.from(new Set([previousAreas[0], area])),
    instructions,
  };
}

function resolveInstructionRow(activeContext, text) {
  const mapped = getMappedRow(text);
  if (mapped?.kind !== 'instruction') {
    return activeContext;
  }

  return {
    ...activeContext,
    instructions: appendUniqueInstruction(activeContext.instructions || [], mapped.instruction),
  };
}

function isContextOnlyRow(row, baseIndex) {
  const description = normalizeDescription(row[baseIndex.description]);
  if (!description) {
    return false;
  }

  const importId = clean(row[baseIndex.importId]);
  const sourceRef = clean(row[baseIndex.legacyNumber]);
  const docId = clean(row[baseIndex.dokimion]);
  const priority = normalizePriority(row[baseIndex.priority]);
  const estTime = parseNumber(row[baseIndex.timeToTest]);

  return !importId && !sourceRef && !docId && !priority && estTime == null;
}

function isAreaRow(row, baseIndex, slots) {
  const description = normalizeDescription(row[baseIndex.description]);
  if (!description) {
    return false;
  }

  const importId = clean(row[baseIndex.importId]);
  const sourceRef = clean(row[baseIndex.legacyNumber]);
  const docId = clean(row[baseIndex.dokimion]);
  const priority = normalizePriority(row[baseIndex.priority]);
  const estTime = parseNumber(row[baseIndex.timeToTest]);

  if (importId || sourceRef || docId || priority || estTime != null) {
    return false;
  }

  if (hasMeaningfulRunData(row, slots)) {
    return false;
  }

  return looksLikeAreaHeading(description);
}

function looksImportableRow(row, baseIndex, slotColumns) {
  const priority = normalizePriority(row[baseIndex.priority]);
  const docId = clean(row[baseIndex.dokimion]);
  const description = clean(row[baseIndex.description]);
  const sourceRef = clean(row[baseIndex.legacyNumber]);
  const hasRunData = slotColumns.some((column) => clean(row[column]) !== '');

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
  const mappedTitle = titleMapping.sourceRows?.[String(row.sourceRowNumber || '')];
  if (mappedTitle) {
    return mappedTitle;
  }

  const description = normalizeDescription(row[baseIndex.description]);
  const docId = clean(row[baseIndex.dokimion]);

  for (const override of TITLE_OVERRIDES) {
    if (override.pattern.test(description)) {
      return override.title;
    }
  }

  const normalized = description
    .replace(/^in helps, select\s+/i, '')
    .replace(/^try\s+/i, '')
    .replace(/^ensure\s+/i, '')
    .replace(/^check\s+/i, 'Check ')
    .replace(/reports?\s+/i, '')
    .replace(/"your bloom is up to date"/i, 'up to date')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();

  const tokens = normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !/^(the|a|an|and|or|to|of|for|with|on|in|it|this|that|does|not|should|where|from)$/i.test(token));

  if (tokens.length > 0) {
    return tokens.slice(0, 6).join(' ');
  }

  return normalized || docId || 'Untitled Test Case';
}

function extractVersionInfo(rawLabel, fieldLabel) {
  const source = clean(rawLabel) || clean(fieldLabel);
  const versionMatch = source.match(/\d+(?:\.\d+)?(?:\s+[A-Za-z][A-Za-z0-9]*)?/);
  const label = versionMatch ? versionMatch[0].trim() : source;
  let platform = source.replace(/^\d+(?:\.\d+)?(?:\s+[A-Za-z][A-Za-z0-9]*)?\s*/i, '').trim();

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
        suiteRunName: headerLabel || versionInfo.testRunLabel || 'Unknown Run',
        suiteRunKey: slugify(headerLabel || versionInfo.testRunLabel || `slot-${column}`),
        testRunLabelHint: versionInfo.testRunLabel || 'Unknown Run',
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
        suiteRunName: headerLabel || versionInfo.testRunLabel || 'Unknown Run',
        suiteRunKey: slugify(headerLabel || versionInfo.testRunLabel || `slot-${column}`),
        testRunLabelHint: versionInfo.testRunLabel || 'Unknown Run',
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
        suiteRunName: versionInfo.testRunLabel || 'Unknown Run',
        suiteRunKey: slugify(versionInfo.testRunLabel || `slot-${column}`),
        testRunLabelHint: versionInfo.testRunLabel || 'Unknown Run',
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

  return slots;
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw || /^n\/a$/i.test(raw)) {
    return { value: '', status: raw ? 'not-applicable' : 'blank' };
  }

  const isoLike = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoLike) {
    const [, year, month, day] = isoLike;
    return {
      value: `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      status: 'ok',
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
  return result.join('\n');
}

function choosePrimaryExecution(entries) {
  return entries.find((entry) => !entry.platform) || entries[0] || null;
}

function buildRunCardTitle(testCase) {
  // The card name is simply the case summary. Runs of one case share the same
  // name and are distinguished by their `Test Suite Run` tag.
  return clean(testCase.title).slice(0, 200);
}

// Extract the distinct `BL-####` issue ids from a cell (e.g. an issue URL),
// dropping everything else. The importer renders these as full links.
function extractIssueIds(value) {
  const matches = String(value ?? '').match(/BL-\d+/gi) || [];
  const seen = new Set();
  const ids = [];
  for (const match of matches) {
    const id = match.toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.join('\n');
}

// Strip leading bracketed tags like "[6.2 regression]" from a description.
function stripBracketPrefixes(value) {
  return clean(value).replace(/^(?:\s*\[[^\]]*\]\s*)+/, '').trim();
}

// Strip leading prefixes from a YouTrack issue title that don't belong in the
// card name: bracketed tags and a redundant leading "BL-####:" (the card name
// already begins with the BL id).
function stripTitlePrefixes(value) {
  return stripBracketPrefixes(value)
    .replace(/^BL-\d+\s*:\s*/i, '')
    .trim();
}

// Build run cards from the YouTrack-only rows of the temp-Dokimion source:
// rows 609+, which have no run data. One card each, no suite-run tag. The card
// name is the BL id followed by " - " and the (prefix-stripped) description;
// steps are derived from the description. Test Case IDs continue after
// `startTestCaseId`; the source row id is `temp-dokimion-<row>`.
function buildYouTrackOnlyRecords(startTestCaseId) {
  if (!fs.existsSync(tempDokimionPath)) {
    return [];
  }
  const rows = parseCsv(fs.readFileSync(tempDokimionPath, 'utf8'));
  const records = [];
  let seq = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    if (rowNumber < 609) {
      continue;
    }
    const row = rows[index];
    const dokNumber = clean(row[0]);
    const descriptionText = clean(row[15]) || clean(row[1]);
    if (!dokNumber && !descriptionText) {
      continue;
    }
    seq += 1;
    const dokimionId = dokNumber ? `TC${dokNumber}` : '';
    const issueId = extractIssueIds(row[2]).split('\n')[0] || '';
    const cleanTitle = stripTitlePrefixes(descriptionText);
    const title = (issueId ? `${issueId} - ${cleanTitle}` : cleanTitle).slice(0, 200);
    // No steps for issue-only rows; the body just points at the issue. The
    // BL id becomes a link when rendered (issueRichText on bodyChecklistItems).
    const stepLine = issueId ? `see ${issueId}` : cleanTitle;
    const caseImportId = `youtrack-${dokNumber || `r${rowNumber}`}`;
    records.push({
      testCaseId: startTestCaseId + seq,
      importRunId: caseImportId,
      caseImportId,
      suiteRunKey: '',
      sourceRowNumber: `temp-dokimion-${rowNumber}`,
      title,
      suiteRunTag: '',
      caseSummary: title,
      legacyNumber: '',
      dokimionId,
      priority: '',
      pastIssues: extractIssueIds(row[2]),
      estTimeMin: null,
      areas: [],
      originalDescription: descriptionText,
      description: descriptionText,
      caseSnapshot: descriptionText,
      stepDescription: stepLine,
      checklistSteps: [stepLine],
      stepNotes: [],
      bodyChecklistItems: [stepLine],
      skipped: false,
      assignee: '',
      testedOn: '',
      buildTested: '',
      issueLinks: '',
      ok: '',
      importNotes: '',
    });
  }
  return records;
}

// The temp-Dokimion source's two run columns (same quintet layout as the main
// sheet): 6.4 then 6.3. Both are >= 5.5 and reuse the main suite-run keys, so
// these runs merge into the existing 6.3 / 6.4 tags.
const TEMP_DOKIMION_SLOTS = [
  { suiteRunName: '6.4', suiteRunKey: '6-4', personColumn: 5, dateColumn: 6, buildColumn: 7, issueColumn: 8, okColumn: 9 },
  { suiteRunName: '6.3', suiteRunKey: '6-3', personColumn: 10, dateColumn: 11, buildColumn: 12, issueColumn: 13, okColumn: 14 },
];

// Only these 1-based row ranges of the temp-Dokimion sheet are imported.
function isKeptTempDokimionRow(rowNumber) {
  return (rowNumber >= 507 && rowNumber <= 567) || (rowNumber >= 592 && rowNumber <= 608);
}

// Build run cards from the temp-Dokimion source. Unlike the YouTrack source,
// these have run data: one card per (case, suite-run-with-data). Columns:
// 0 id, 1 description, 2 issues, 3 priority, 4 steps (ignored), 5-9 the 6.4
// quintet, 10-14 the 6.3 quintet, 15 new description (overrides 1). The card
// name is the normal derivation of the description with bracketed prefixes
// dropped; the notes column (16) is rendered at the bottom of the page body.
function buildTempDokimionRecords(baseIndex, startTestCaseId) {
  if (!fs.existsSync(tempDokimionPath)) {
    return [];
  }
  const rows = parseCsv(fs.readFileSync(tempDokimionPath, 'utf8'));
  const records = [];
  let caseSeq = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    if (!isKeptTempDokimionRow(rowNumber)) {
      continue;
    }
    const row = rows[index];
    const dokNumber = clean(row[0]);
    const descriptionText = clean(row[15]) || clean(row[1]);
    if (!dokNumber && !descriptionText) {
      continue;
    }
    caseSeq += 1;
    const testCaseId = startTestCaseId + caseSeq;
    const dokimionId = dokNumber ? `TC${dokNumber}` : '';
    const synthRow = [];
    synthRow[baseIndex.description] = stripBracketPrefixes(descriptionText);
    synthRow[baseIndex.dokimion] = dokimionId;
    const title = buildCaseTitle(synthRow, baseIndex).slice(0, 200);
    const processed = buildProcessedContent(title, descriptionText, {});
    const priority = normalizePriority(row[3]);
    const pastIssues = clean(row[2]);
    // The "Steps are helpful" column (4): ✅ -> helpful, ❌ -> unhelpful.
    // Anything else ("?", empty) adds no verdict line.
    const stepsCell = clean(row[4]);
    const stepsVerdict = stepsCell.includes('✅')
      ? 'Dokimion steps deemed helpful'
      : stepsCell.includes('❌')
        ? 'Dokimion steps deemed unhelpful'
        : '';
    const notes = [stepsVerdict, clean(row[16])].filter(Boolean).join('\n\n');
    const caseImportId = `temp-dok-${dokNumber || `r${rowNumber}`}`;
    for (const slot of TEMP_DOKIMION_SLOTS) {
      const person = clean(row[slot.personColumn]);
      const rawDate = clean(row[slot.dateColumn]);
      const build = clean(row[slot.buildColumn]);
      const issue = clean(row[slot.issueColumn]);
      const ok = normalizeOk(row[slot.okColumn]);
      if (!person && !rawDate && !build && !issue && !ok) {
        continue;
      }
      const testedOn = normalizeDate(rawDate).value;
      const skipped = isSkippedAssignee(person);
      const assignee = skipped ? '' : normalizeAssignee(person);
      const primary = { person, rawDate, testedOn, platform: '' };
      records.push({
        testCaseId,
        importRunId: `${caseImportId}::${slot.suiteRunKey}`,
        caseImportId,
        suiteRunKey: slot.suiteRunKey,
        sourceRowNumber: `temp-dokimion-${rowNumber}`,
        title,
        suiteRunTag: slot.suiteRunName,
        caseSummary: title,
        legacyNumber: '',
        dokimionId,
        priority,
        pastIssues,
        estTimeMin: null,
        areas: [],
        originalDescription: descriptionText,
        description: descriptionText,
        caseSnapshot: descriptionText,
        stepDescription: processed.stepDescription,
        checklistSteps: [...processed.checklistSteps],
        stepNotes: [...processed.stepNotes],
        bodyChecklistItems: [...processed.bodyChecklistItems],
        notes,
        skipped,
        assignee,
        testedOn,
        buildTested: build,
        issueLinks: issue,
        ok,
        importNotes: buildImportNotes(primary, assignee),
      });
    }
  }
  return records;
}

function main() {
  const text = fs.readFileSync(csvPath, 'utf8');
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
  const detectedSlots = detectSlots(rows[0], rows[1], runStart);
  // Normalize suite-run names (drop "BetaInternal") and keep only slots at or
  // after the minimum supported version. Dropped slots are never read, so no
  // run cards are produced for suite runs prior to the cutoff.
  for (const slot of detectedSlots) {
    slot.suiteRunName = cleanSuiteRunName(slot.suiteRunName);
    slot.suiteRunKey = slugify(slot.suiteRunName) || slot.suiteRunKey;
  }
  const slots = detectedSlots.filter((slot) => suiteRunInRange(slot.suiteRunName));
  const slotColumns = collectSlotColumns(slots);

  const testCases = [];
  const suiteRunMap = new Map();
  const testCaseRuns = [];
  const dateWarnings = [];
  let activeAreaContext = { areas: [], instructions: [] };
  let importableCaseCount = 0;

  for (let rowIndex = 5; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    while (row.length < width) {
      row.push('');
    }
    // Explicit per-row curation, looked up by normalized description. Handled
    // ahead of the heuristic checks because these rows carry a Dokimion id that
    // would otherwise make them look like ordinary cases.
    const curated = curationRows[normalizeDescription(row[baseIndex.description])] || null;
    // Curated instruction rows are not test cases: prepend their text to the
    // following tests (until the next area) and skip importing them.
    if (curated?.kind === 'instruction') {
      activeAreaContext = {
        ...activeAreaContext,
        instructions: appendUniqueInstruction(
          activeAreaContext.instructions || [],
          normalizeDescription(row[baseIndex.description]),
        ),
      };
      continue;
    }

    const descriptionCell = row[baseIndex.description];
    const mappedRow = getMappedRow(descriptionCell);

    if (mappedRow?.kind === 'ignore' && isContextOnlyRow(row, baseIndex)) {
      continue;
    }

    if (mappedRow?.kind === 'instruction' && isContextOnlyRow(row, baseIndex)) {
      activeAreaContext = resolveInstructionRow(activeAreaContext, descriptionCell);
      continue;
    }

    if ((mappedRow?.kind === 'area' && isContextOnlyRow(row, baseIndex)) || isAreaRow(row, baseIndex, slots)) {
      activeAreaContext = resolveAreaHeading(activeAreaContext, row[baseIndex.description]);
      continue;
    }

    if (!looksImportableRow(row, baseIndex, slotColumns)) {
      continue;
    }

    if (importableCaseCount < caseOffset) {
      importableCaseCount += 1;
      continue;
    }

    importableCaseCount += 1;

    if (!clean(row[baseIndex.importId])) {
      row[baseIndex.importId] = buildImportId(row, rowIndex + 1, baseIndex);
    }

    const originalDescription = clean(row[baseIndex.description]);
    const description = prependInstruction(
      row[baseIndex.description],
      activeAreaContext.instructions,
    );
    row.sourceRowNumber = rowIndex + 1;

    const importId = clean(row[baseIndex.importId]);
    const title = buildCaseTitle(row, baseIndex);
    const stepOverride = stepOverrides[importId] || {};
    const processedContent = buildProcessedContent(title, description, stepOverride);
    const testCase = {
      importId,
      sourceRowNumber: rowIndex + 1,
      legacyNumber: clean(row[baseIndex.legacyNumber]),
      title,
      originalDescription,
      description,
      stepDescription: processedContent.stepDescription,
      checklistSteps: [...processedContent.checklistSteps],
      stepNotes: [...processedContent.stepNotes],
      bodyChecklistItems: [...processedContent.bodyChecklistItems],
      dokimionId: clean(row[baseIndex.dokimion]),
      priority: curated?.priority || normalizePriority(row[baseIndex.priority]),
      pastIssues: clean(row[baseIndex.pastIssues]),
      estTimeMin: parseNumber(row[baseIndex.timeToTest]),
      areas: [...activeAreaContext.areas],
    };
    testCases.push(testCase);

    const groupedEntries = new Map();
    for (const slot of slots) {
      const person = slot.personColumn == null ? '' : clean(row[slot.personColumn]);
      const rawDate = slot.dateColumn == null ? '' : clean(row[slot.dateColumn]);
      const build = slot.buildColumn == null ? '' : clean(row[slot.buildColumn]);
      const issue = slot.issueColumn == null ? '' : clean(row[slot.issueColumn]);
      const ok = slot.okColumn == null ? '' : normalizeOk(row[slot.okColumn]);
      const hasData = Boolean(person || rawDate || build || issue || ok);

      if (!hasData) {
        continue;
      }

      const normalizedDate = normalizeDate(rawDate);
      if (rawDate && normalizedDate.status !== 'ok') {
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
        platform: slot.platformHint || '',
        person,
        rawDate,
        testedOn: normalizedDate.value,
        build,
        issue,
        ok,
      });

      const existingSuiteRun = suiteRunMap.get(slot.suiteRunKey);
      const runOrder = slot.startColumn - runStart + 1;
      if (!existingSuiteRun) {
        suiteRunMap.set(slot.suiteRunKey, {
          importRunKey: slot.suiteRunKey,
          name: slot.suiteRunName,
          runOrder,
        });
      } else if (runOrder < existingSuiteRun.runOrder) {
        existingSuiteRun.runOrder = runOrder;
      }
    }

    for (const [suiteRunKey, executionEntries] of groupedEntries.entries()) {
      const suiteRun = suiteRunMap.get(suiteRunKey);
      const suiteRunName = suiteRun?.name || suiteRunKey;
      const primary = choosePrimaryExecution(executionEntries);
      // A "skip" assignee marks a deliberately-skipped run, not a tester, so it
      // is flagged separately and kept out of the assignee field.
      const skipped = isSkippedAssignee(primary?.person);
      const assignee = skipped ? '' : normalizeAssignee(primary?.person);
      // Single-database model: each run card is the merge of the durable test
      // case *definition* (folded metadata + steps/notes/areas) and the
      // specifics of this one run (assignee, date, build, issues, OK).
      testCaseRuns.push({
        // --- identity ---
        testCaseId: testCase.sourceRowNumber,
        importRunId: `${testCase.importId}::${suiteRunKey}`,
        caseImportId: testCase.importId,
        suiteRunKey,
        sourceRowNumber: testCase.sourceRowNumber,
        title: buildRunCardTitle(testCase),

        // --- suite-run membership (closed select tag, not a relation) ---
        suiteRunTag: suiteRunName,

        // --- folded test case definition ---
        caseSummary: testCase.title,
        legacyNumber: testCase.legacyNumber,
        dokimionId: testCase.dokimionId,
        priority: testCase.priority,
        pastIssues: testCase.pastIssues,
        estTimeMin: testCase.estTimeMin,
        areas: [...testCase.areas],
        originalDescription: testCase.originalDescription,
        description: testCase.description,
        caseSnapshot: testCase.description,
        stepDescription: testCase.stepDescription,
        checklistSteps: [...testCase.checklistSteps],
        stepNotes: [...testCase.stepNotes],
        bodyChecklistItems: [...testCase.bodyChecklistItems],

        // --- this run's specifics ---
        skipped,
        assignee,
        testedOn: primary?.testedOn || '',
        buildTested: primary?.build || '',
        issueLinks: uniqueJoined(executionEntries.map((entry) => entry.issue)),
        ok: primary?.ok || '',
        // Raw execution details that did not survive normalization into the
        // clean properties (e.g. a skip reason, an unknown/"Future" tester, an
        // unparsable date). Kept so nothing from the source is silently lost.
        importNotes: buildImportNotes(primary, assignee),
      });
    }

    if (caseLimit > 0 && testCases.length >= caseLimit) {
      break;
    }
  }

  // Append the YouTrack-only source (a second, three-column file with no run
  // data). Its Test Case IDs continue after the main set's highest id.
  const maxTestCaseId = testCaseRuns.reduce(
    (max, record) => Math.max(max, record.testCaseId || 0),
    0,
  );
  const youtrackOnlyRecords = buildYouTrackOnlyRecords(maxTestCaseId);
  for (const record of youtrackOnlyRecords) {
    testCaseRuns.push(record);
  }

  // Then the temp-Dokimion source (which has run data), continuing the Test
  // Case ID sequence after everything appended so far.
  const maxTestCaseIdAfterYouTrack = testCaseRuns.reduce(
    (max, record) => Math.max(max, record.testCaseId || 0),
    0,
  );
  const tempDokimionRecords = buildTempDokimionRecords(baseIndex, maxTestCaseIdAfterYouTrack);
  for (const record of tempDokimionRecords) {
    testCaseRuns.push(record);
  }

  // Suite runs are no longer a database. Emit the distinct suite-run names as
  // the closed `Test Suite Run` select-tag list for reference.
  const suiteRunTags = Array.from(suiteRunMap.values())
    .sort((left, right) => left.runOrder - right.runOrder)
    .map((suiteRun) => ({
      tag: suiteRun.name,
      key: suiteRun.importRunKey,
      runOrder: suiteRun.runOrder,
    }));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'test-case-runs.json'), JSON.stringify(testCaseRuns, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'suite-run-tags.json'), JSON.stringify(suiteRunTags, null, 2) + '\n', 'utf8');

  const summary = {
    csvPath,
    outDir,
    caseOffset,
    caseLimit,
    slotCount: slots.length,
    caseCount: testCases.length,
    youtrackOnlyCount: youtrackOnlyRecords.length,
    tempDokimionCount: tempDokimionRecords.length,
    suiteRunTagCount: suiteRunTags.length,
    testCaseRunCount: testCaseRuns.length,
    dateWarningCount: dateWarnings.length,
    areaCount: Array.from(new Set(testCases.flatMap((testCase) => testCase.areas || []))).length,
    areaMappingPath,
  };
  fs.writeFileSync(
    path.join(outDir, 'prepare-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(outDir, 'date-warnings.json'), JSON.stringify(dateWarnings, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify(summary, null, 2));
}

main();
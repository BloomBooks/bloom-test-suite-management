// Clone one suite run's cards into a new suite run in the `Test Case Runs`
// Notion database.
//
// Usage:
//   node clone.mjs "<from-tag>" "<to-tag>" [--apply] [--force]
//
//   <from-tag>  the existing Test Suite Run to copy from (e.g. "6.4")
//   <to-tag>    the new Test Suite Run to create (e.g. "6.5")
//   --apply     actually write to Notion (default is a read-only dry run)
//   --force     proceed even if the target tag already has cards that this
//               tool did not create
//   --limit=N   clone at most N cards (a smoke test; pairs with --apply)
//   --require-areas  only consider cards that have at least one Area (a smoke
//               test aid, so a small --limit batch exercises Areas)
//
// Both tags must be given explicitly; this tool never guesses the source.
//
// Per-property clone policy (see README / import/schema.md for the field set):
//   copy exactly      Test Case Run (title), Test Case ID, Summary,
//                     Original Description, Legacy Number, Dokimion ID,
//                     Import Source Row Number, Priority, Est. Time (min),
//                     Areas, Automation Notes, Original Feature Implementation
//   copy modified     Test Suite Run -> the new tag
//                     Status         -> "Not started"
//                     Prior Issues   -> prior Prior Issues + the prior run's
//                                       Run Issues (BL-#### / URL deduped)
//   start blank       Assignee, Assignee - historical, Tested On,
//                     Build Tested, Run Issues, Run Notes (omitted)
//   page body         copied faithfully, with every to-do checkbox unchecked
//
// A card is not cloned if its Priority is "Obsolete" or "Duplicate", OR if its
// Status is "Retired". Both rules apply independently.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendChildren,
  clean,
  createPage,
  execNotionJson,
  linkifyRichText,
  listDatabasePages,
  loadJson,
  normalizePageId,
  saveJson,
  selectName,
  TITLE_PROPERTY,
} from "../lib/notion.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(scriptDir, "..", "notion-config.json");
const statePath = path.join(scriptDir, "state.json");

const EXCLUDED_PRIORITIES = new Set(["Obsolete", "Duplicate"]);

// A card retired from the suite is not carried forward either. This is a
// separate test from the priority one, deliberately: `Retired` is the status a
// person sets on the board when a card is merged away or dropped, and they may
// not also remember to set `Priority` to `Obsolete`. Honouring the status here
// is what stops a retired card reappearing, live, in the next run.
const EXCLUDED_STATUSES = new Set(["Retired"]);

// Run-specific properties that are intentionally left blank on the new card.
// They are simply omitted from the create payload, so the new page starts with
// them empty.
const DROPPED_PROPERTIES = [
  "Assignee",
  // Per-run, like Assignee: it holds the tester the import mapped for that
  // cycle, and is empty on every card created since. Not carried forward.
  "Assignee - historical",
  "Tested On",
  "Build Tested",
  "Run Issues",
  "Run Notes",
];

// Block types we know how to recreate in the cloned page body.
const SUPPORTED_BLOCK_TYPES = new Set([
  "heading_1",
  "heading_2",
  "heading_3",
  "paragraph",
  "to_do",
  "bulleted_list_item",
  "numbered_list_item",
]);

// Bare URLs and BL-#### issue refs, used when merging Prior Issues / Run Issues.
const TOKEN_PATTERN = /(https?:\/\/[^\s<>]+)|(BL-\d+)/gi;

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

function tagOf(page) {
  return page.properties?.["Test Suite Run"]?.select?.name || "";
}

function priorityOf(page) {
  return page.properties?.["Priority"]?.select?.name || "";
}

function statusOf(page) {
  return page.properties?.["Status"]?.status?.name || "";
}

// A card is carried into the new run unless its priority or its status says
// otherwise. Both rules apply; neither replaces the other.
function isExcluded(page) {
  return (
    EXCLUDED_PRIORITIES.has(priorityOf(page)) ||
    EXCLUDED_STATUSES.has(statusOf(page))
  );
}

function hasAreas(page) {
  return (page.properties?.["Areas"]?.multi_select || []).length > 0;
}

function richTextOf(properties, name) {
  return properties?.[name]?.rich_text || [];
}

function plainText(richTextValue) {
  return (richTextValue || [])
    .map((fragment) => fragment.plain_text ?? fragment.text?.content ?? "")
    .join("");
}

// Reduce a read-back rich_text array to the writeable shape: keep the text
// content, any link, and the annotations; drop read-only fields (plain_text,
// href). This preserves links and formatting exactly when copying a value.
function sanitizeRichText(richTextValue) {
  const out = [];
  for (const fragment of richTextValue || []) {
    if (fragment.type && fragment.type !== "text") {
      // Mentions / equations are not used in this database; skip anything that
      // is not a plain text fragment rather than emit something invalid.
      continue;
    }
    const content = fragment.text?.content ?? fragment.plain_text ?? "";
    const piece = { type: "text", text: { content } };
    if (fragment.text?.link?.url) {
      piece.text.link = { url: fragment.text.link.url };
    }
    if (fragment.annotations) {
      piece.annotations = fragment.annotations;
    }
    out.push(piece);
  }
  return out;
}

function extractTokens(text) {
  return [...String(text || "").matchAll(TOKEN_PATTERN)].map((match) => match[0]);
}

// The new card's Prior Issues = the prior Prior Issues, plus any issue refs
// that the prior run found (its Run Issues) which are not already listed.
// BL-#### refs and URLs are deduped case-insensitively; the prior text is
// preserved verbatim and new refs are appended.
function mergePriorIssues(properties) {
  const past = clean(plainText(richTextOf(properties, "Prior Issues")));
  const links = clean(plainText(richTextOf(properties, "Run Issues")));
  if (!links) {
    return linkifyRichText(past);
  }
  const present = new Set(extractTokens(past).map((token) => token.toLowerCase()));
  const additions = [];
  for (const token of extractTokens(links)) {
    const key = token.toLowerCase();
    if (!present.has(key)) {
      present.add(key);
      additions.push(token);
    }
  }
  if (!additions.length) {
    return linkifyRichText(past);
  }
  const merged = past ? `${past}, ${additions.join(", ")}` : additions.join(", ");
  return linkifyRichText(merged);
}

function buildClonedProperties(properties, toTag) {
  const props = {};

  // Title.
  props[TITLE_PROPERTY] = {
    title: sanitizeRichText(properties?.[TITLE_PROPERTY]?.title || []),
  };

  // Copy-exact rich_text (Dokimion ID keeps its embedded link via passthrough).
  for (const name of [
    "Summary",
    "Original Description",
    "Legacy Number",
    "Dokimion ID",
    "Import Source Row Number",
    // Durable case metadata, not run results, so both carry forward.
    "Automation Notes",
    "Original Feature Implementation",
  ]) {
    props[name] = { rich_text: sanitizeRichText(richTextOf(properties, name)) };
  }

  // Copy-exact numbers.
  for (const name of ["Test Case ID", "Est. Time (min)"]) {
    props[name] = { number: properties?.[name]?.number ?? null };
  }

  // Copy-exact select / multi_select.
  const priority = properties?.["Priority"]?.select?.name;
  props["Priority"] = { select: priority ? { name: priority } : null };
  props["Areas"] = {
    multi_select: (properties?.["Areas"]?.multi_select || []).map((option) => ({
      name: option.name,
    })),
  };

  // Modified.
  props["Test Suite Run"] = { select: { name: selectName(toTag) } };
  props["Status"] = { status: { name: "Not started" } };
  props["Prior Issues"] = { rich_text: mergePriorIssues(properties) };

  // DROPPED_PROPERTIES are intentionally not set (start blank on the new card).
  return props;
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

async function listAllChildren(pageId) {
  const blocks = [];
  let cursor = "";
  while (true) {
    const query = cursor
      ? `?page_size=100&start_cursor=${cursor}`
      : "?page_size=100";
    const response = await execNotionJson(
      "GET",
      `blocks/${normalizePageId(pageId)}/children${query}`,
    );
    blocks.push(...(response.results || []));
    if (!response.has_more || !response.next_cursor) {
      return blocks;
    }
    cursor = response.next_cursor;
  }
}

// Recreate a read-back block as a fresh create payload. to_do checkboxes are
// forced unchecked so the new run starts clean. Unsupported / nested block
// types are skipped (the test-case bodies are flat headings + to-do lists).
function rebuildBlock(block) {
  const type = block.type;
  if (!SUPPORTED_BLOCK_TYPES.has(type)) {
    return null;
  }
  const source = block[type] || {};
  const payload = { rich_text: sanitizeRichText(source.rich_text || []) };
  if (type === "to_do") {
    payload.checked = false;
  }
  return { object: "block", type, [type]: payload };
}

async function writeNewBody(pageId, blocks) {
  for (let index = 0; index < blocks.length; index += 100) {
    await appendChildren(pageId, blocks.slice(index, index + 100));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 0;
  return {
    fromTag: positional[0],
    toTag: positional[1],
    apply: flags.has("--apply"),
    force: flags.has("--force"),
    requireAreas: flags.has("--require-areas"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
  };
}

async function main() {
  const { fromTag, toTag, apply, force, requireAreas, limit } = parseArgs(
    process.argv.slice(2),
  );
  if (!fromTag || !toTag) {
    console.error(
      'Usage: node clone.mjs "<from-tag>" "<to-tag>" [--apply] [--force]',
    );
    process.exit(1);
  }
  if (fromTag === toTag) {
    console.error("from-tag and to-tag must differ.");
    process.exit(1);
  }

  const config = loadJson(configPath, {});
  const databaseId = config.databases?.testCaseRuns;
  if (!databaseId) {
    throw new Error(
      `notion-config.json has no databases.testCaseRuns (looked in ${configPath}).`,
    );
  }

  console.log(`Reading database ${databaseId} ...`);
  const pages = await listDatabasePages(databaseId);

  const fromCards = pages.filter((page) => tagOf(page) === fromTag);
  const ignored = fromCards.filter((page) => isExcluded(page));
  const ignoredByPriority = ignored.filter((page) =>
    EXCLUDED_PRIORITIES.has(priorityOf(page)),
  );
  const ignoredByStatusOnly = ignored.filter(
    (page) => !EXCLUDED_PRIORITIES.has(priorityOf(page)),
  );
  const eligible = fromCards.filter(
    (page) => !isExcluded(page) && (!requireAreas || hasAreas(page)),
  );
  const existingTarget = pages.filter((page) => tagOf(page) === toTag);

  // Resume state, scoped to this from->to pair.
  let state = loadJson(statePath, null);
  if (!state || state.fromTag !== fromTag || state.toTag !== toTag) {
    state = { fromTag, toTag, created: {} };
  }
  const alreadyCreated = new Set(Object.values(state.created));

  // Cards not yet cloned in this from->to pair. --limit counts NEW cards, so an
  // earlier partial/smoke run does not eat into this run's batch.
  const pending = eligible.filter((page) => !state.created[page.id]);
  const source = limit ? pending.slice(0, limit) : pending;

  console.log(`Suite run "${fromTag}": ${fromCards.length} cards.`);
  console.log(
    `  eligible to clone: ${eligible.length}` +
      (requireAreas ? " (--require-areas)" : ""),
  );
  console.log(`  already cloned:    ${eligible.length - pending.length}`);
  if (limit) {
    console.log(`  this run (limit):  ${source.length} (--limit=${limit})`);
  }
  console.log(
    `  not carried forward: ${ignored.length}` +
      ` (Obsolete/Duplicate: ${ignoredByPriority.length},` +
      ` Retired only: ${ignoredByStatusOnly.length})`,
  );
  if (ignoredByStatusOnly.length) {
    console.log(
      `    retired without an Obsolete/Duplicate priority: ` +
        ignoredByStatusOnly
          .map((page) => `#${page.properties?.["Test Case ID"]?.number}`)
          .join(", "),
    );
  }
  console.log(`Suite run "${toTag}": ${existingTarget.length} existing cards.`);

  if (!source.length) {
    console.log(`Nothing left to clone for "${fromTag}" -> "${toTag}".`);
    return;
  }

  if (!apply) {
    console.log("\n-- DRY RUN (no Notion writes). Pass --apply to clone. --");
    const preview = source.slice(0, 10);
    for (const page of preview) {
      const title = plainText(page.properties?.[TITLE_PROPERTY]?.title || []);
      console.log(`  would clone: ${title}`);
    }
    if (source.length > preview.length) {
      console.log(`  ... and ${source.length - preview.length} more`);
    }
    return;
  }

  // Guard against duplicating into a tag that already holds cards we did not
  // create in a prior partial run.
  const foreignTargets = existingTarget.filter(
    (page) => !alreadyCreated.has(page.id),
  );
  if (foreignTargets.length && !force) {
    console.error(
      `\nRefusing to apply: "${toTag}" already has ${foreignTargets.length} card(s) ` +
        `not created by this tool. Re-run with --force to clone anyway.`,
    );
    process.exit(1);
  }

  let created = 0;
  for (const page of source) {
    const title = plainText(page.properties?.[TITLE_PROPERTY]?.title || []);
    const properties = buildClonedProperties(page.properties, toTag);
    const newPage = await createPage(databaseId, properties);
    const body = (await listAllChildren(page.id))
      .map(rebuildBlock)
      .filter(Boolean);
    await writeNewBody(newPage.id, body);
    state.created[page.id] = newPage.id;
    saveJson(statePath, state);
    created += 1;
    console.log(`  [${created}/${source.length}] cloned: ${title}`);
  }

  console.log(`\nDone. Created ${created} card(s) under "${toTag}".`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

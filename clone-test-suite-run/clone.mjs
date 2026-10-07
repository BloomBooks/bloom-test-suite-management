// Clone one suite run's cards into a new suite run in the `Test Case Runs`
// Notion database.
//
// Usage:
//   node clone.mjs "<from-tag>" "<to-tag>" [--apply] [--force]
//
//   <from-tag>  the existing Test Suite Run to copy from (e.g. "6.4")
//   <to-tag>    the new Test Suite Run to create (e.g. "6.5")
//   --apply     actually write to Notion (default is a read-only dry run)
//   --force     proceed even if a card already in the target tag (one this
//               tool did not create) has the Test Case ID of a card about to
//               be cloned
//   --limit=N   clone at most N cards (a smoke test; pairs with --apply)
//   --require-areas  only consider cards that have at least one Area (a smoke
//               test aid, so a small --limit batch exercises Areas)
//   --only=N,M  clone only the cards with these Test Case IDs (a smoke test
//               aimed at particular cards)
//   --concurrency=N  copy N cards at once (default 4)
//
// Both tags must be given explicitly; this tool never guesses the source.
//
// Per-property clone policy (see README / import/schema.md for the field set):
//   copy exactly      Test Case Run (title), Test Case ID, Summary,
//                     Original Description, Legacy Number, Dokimion ID,
//                     Import Source Row Number, Priority, Est. Time (min),
//                     Areas, Automation, Automation Notes,
//                     Original Feature Implementation
//   copy modified     Test Suite Run -> the new tag
//                     Status         -> "Not started"
//                     Prior Issues   -> prior Prior Issues + the prior run's
//                                       Run Issues (BL-#### / URL deduped)
//                     Related Cases  -> re-pointed at the new-run counterparts
//   start blank       Assignee, Assignee - historical, Tested On,
//                     Build Tested, Run Issues, Run Notes (omitted)
//   page body         copied whole by Notion (the new card is created with the
//                     old one as its template), then every to-do checkbox is
//                     unchecked at every depth and links to other cards are
//                     re-pointed at the new-run counterparts
//
// A card is not cloned if its Priority is "Obsolete" or "Duplicate", OR if its
// Status is "Retired". Both rules apply independently.
//
// Links between cards (the `Related Cases` relation, and page links / page
// mentions in the body) are re-pointed in a second pass, once every card has
// been created, so a link can reach a card cloned later in the same run. The
// pass also covers cards already in <to-tag> that this tool did not create
// (cards written directly into the new run), since they can link back to the
// previous run too. A link whose target is not carried forward is left
// pointing at the old card and reported.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clean,
  execNotionJson,
  linkifyRichText,
  listDatabasePages,
  loadJson,
  normalizePageId,
  saveJson,
  selectName,
  sleep,
  TITLE_PROPERTY,
  updatePage,
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

const RELATED_CASES = "Related Cases";

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

// Creating a page from a template needs this API version or later.
const TEMPLATE_API_VERSION = "2025-09-03";

// How long to wait for Notion to finish copying a card in the background.
const TEMPLATE_TIMEOUT_MS = 600000;
const TEMPLATE_POLL_MS = 2000;

// How far apart the reads are that confirm a clone's properties have settled.
const PROPERTY_SETTLE_MS = 10000;

// How many cards to copy at once. Each copy spends most of its time waiting on
// Notion, so a few in parallel cut the run time without pushing the API's rate
// limit (the client retries on 429).
const DEFAULT_CONCURRENCY = 4;

// Bare URLs and BL-#### issue refs, used when merging Prior Issues / Run Issues.
const TOKEN_PATTERN = /(https?:\/\/[^\s<>]+)|(BL-\d+)/gi;

// A Notion page id inside a link URL, dashed or not.
const PAGE_ID_IN_URL =
  /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

function tagOf(page) {
  return page?.properties?.["Test Suite Run"]?.select?.name || "";
}

function priorityOf(page) {
  return page.properties?.["Priority"]?.select?.name || "";
}

function statusOf(page) {
  return page.properties?.["Status"]?.status?.name || "";
}

function caseIdOf(page) {
  return page?.properties?.["Test Case ID"]?.number ?? null;
}

function titleOf(page) {
  return plainText(page?.properties?.[TITLE_PROPERTY]?.title || []);
}

// "#123 (6.5)", or the title when a card has no Test Case ID.
function labelOf(page) {
  const id = caseIdOf(page);
  const name = id == null ? `"${titleOf(page)}"` : `#${id}`;
  return `${name} (${tagOf(page) || "no tag"})`;
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

function hasAutomation(page) {
  return Boolean(
    page.properties?.["Automation"]?.select?.name ||
      plainText(richTextOf(page.properties, "Automation Notes")),
  );
}

function relatedIdsOf(page) {
  return (page.properties?.[RELATED_CASES]?.relation || []).map((r) => r.id);
}

function richTextOf(properties, name) {
  return properties?.[name]?.rich_text || [];
}

function plainText(richTextValue) {
  return (richTextValue || [])
    .map((fragment) => fragment.plain_text ?? fragment.text?.content ?? "")
    .join("");
}

function compactId(id) {
  return normalizePageId(id).toLowerCase();
}

// Reduce a read-back rich_text array to the writeable shape: keep the text
// content, any link, and the annotations; drop read-only fields (plain_text,
// href). This preserves links and formatting exactly when copying a value.
// Page, user and date mentions and equations are kept too (card bodies use
// page mentions for cross-card references); anything else is skipped rather
// than emit something invalid.
function sanitizeRichText(richTextValue) {
  const out = [];
  for (const fragment of richTextValue || []) {
    let piece = null;
    if (!fragment.type || fragment.type === "text") {
      const content = fragment.text?.content ?? fragment.plain_text ?? "";
      piece = { type: "text", text: { content } };
      if (fragment.text?.link?.url) {
        piece.text.link = { url: fragment.text.link.url };
      }
    } else if (fragment.type === "mention") {
      const mention = fragment.mention || {};
      if (mention.type === "page") {
        piece = { type: "mention", mention: { page: { id: mention.page.id } } };
      } else if (mention.type === "user") {
        piece = { type: "mention", mention: { user: { id: mention.user.id } } };
      } else if (mention.type === "date") {
        piece = { type: "mention", mention: { date: mention.date } };
      }
    } else if (fragment.type === "equation") {
      piece = {
        type: "equation",
        equation: { expression: fragment.equation.expression },
      };
    }
    if (!piece) {
      continue;
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

  // Copy-exact select / multi_select. `Automation` is the state of the case's
  // automated test, not a run result, so it carries forward like Priority.
  for (const name of ["Priority", "Automation"]) {
    const value = properties?.[name]?.select?.name;
    props[name] = { select: value ? { name: value } : null };
  }
  props["Areas"] = {
    multi_select: (properties?.["Areas"]?.multi_select || []).map((option) => ({
      name: option.name,
    })),
  };

  // Copied as-is here, still pointing at the old run; the relink pass
  // re-points it once every card exists.
  props[RELATED_CASES] = {
    relation: (properties?.[RELATED_CASES]?.relation || []).map((r) => ({
      id: r.id,
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

// Every block of a page body, depth first, including nested children.
async function listAllBlocksDeep(pageId) {
  const out = [];
  for (const block of await listAllChildren(pageId)) {
    out.push(block);
    if (
      block.has_children &&
      block.type !== "child_page" &&
      block.type !== "child_database"
    ) {
      out.push(...(await listAllBlocksDeep(block.id)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copying a card
// ---------------------------------------------------------------------------
//
// The API has no "duplicate page" call, but any page can be applied to another
// as a template, which copies its properties and whole body (images, callouts,
// nested blocks, files) the way the web UI's Duplicate does. The copy happens
// in the background after the call returns, and there is no job status to ask
// about, so we poll until the body is there. Page comments are not copied,
// which is what we want: they belong to the run they were made in.

async function getDataSourceId(databaseId) {
  const database = await execNotionJson(
    "GET",
    `databases/${normalizePageId(databaseId)}`,
    undefined,
    { notionVersion: TEMPLATE_API_VERSION },
  );
  const id = database.data_sources?.[0]?.id;
  if (!id) {
    throw new Error(`Database ${databaseId} reports no data source.`);
  }
  return id;
}

// Create the new card, without a body yet. Title and Test Case ID are set up
// front so the card is never briefly blank: the val.town webhook assigns an ID
// to any new card whose Test Case ID is empty.
async function createCard(dataSourceId, sourcePage, toTag) {
  return execNotionJson(
    "POST",
    "pages",
    {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: {
        [TITLE_PROPERTY]: {
          title: sanitizeRichText(sourcePage.properties?.[TITLE_PROPERTY]?.title || []),
        },
        "Test Case ID": { number: caseIdOf(sourcePage) },
        "Test Suite Run": { select: { name: selectName(toTag) } },
      },
    },
    { notionVersion: TEMPLATE_API_VERSION },
  );
}

// Copy the source card into the new one, as a separate update after the
// create. How long Notion takes to apply a template varies a lot: in October
// 2026 one applied through an update arrived in about 40 seconds, while one
// passed with the create took about five minutes. A template must never be
// applied twice to the same page (a late first copy then lands as a second
// body), so the wait for it is generous. The template also copies the
// source's properties (Status, Tested On, ...); finishCopy overwrites them.
async function applyTemplate(newPageId, sourcePage) {
  await execNotionJson(
    "PATCH",
    `pages/${normalizePageId(newPageId)}`,
    { template: { type: "template_id", template_id: sourcePage.id } },
    { notionVersion: TEMPLATE_API_VERSION },
  );
}

// Wait until the new page's top-level body has as many blocks as the source's.
async function waitForTemplate(newPageId, sourceBlockCount) {
  const started = Date.now();
  while (true) {
    const count = (await listAllChildren(newPageId)).length;
    if (count >= sourceBlockCount) {
      return;
    }
    if (Date.now() - started > TEMPLATE_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for Notion to copy the body into ${newPageId} ` +
          `(${count} of ${sourceBlockCount} top-level blocks).`,
      );
    }
    await sleep(TEMPLATE_POLL_MS);
  }
}

// After the copy: overwrite every property with the clone policy (the template
// copied the old run's values), then untick every checkbox at every depth.
// Returns whether the body links to other cards, for the relink pass.
async function finishCopy(newPageId, sourcePage, toTag, isCard) {
  const properties = {
    ...buildClonedProperties(sourcePage.properties, toTag),
    // The template copied these; the new run starts with them blank.
    "Assignee": { people: [] },
    "Assignee - historical": { select: null },
    "Tested On": { date: null },
    "Build Tested": { rich_text: [] },
    "Run Issues": { rich_text: [] },
    "Run Notes": { rich_text: [] },
  };
  await updatePage(newPageId, properties);
  let hasCardLinks = false;
  for (const block of await listAllBlocksDeep(newPageId)) {
    if (block.type === "to_do" && block.to_do.checked) {
      await execNotionJson("PATCH", `blocks/${normalizePageId(block.id)}`, {
        to_do: { checked: false },
      });
    }
    if (cardLinksInBlock(block, isCard).length) {
      hasCardLinks = true;
    }
  }
  await settleProperties(newPageId, sourcePage, toTag, properties);
  return hasCardLinks;
}

// What is wrong with a clone's run properties, if anything.
function propertyProblems(page, sourcePage, toTag) {
  const p = page.properties || {};
  const problems = [];
  if (p["Test Case ID"]?.number !== caseIdOf(sourcePage)) {
    problems.push(`Test Case ID #${p["Test Case ID"]?.number}`);
  }
  if (p["Test Suite Run"]?.select?.name !== selectName(toTag)) {
    problems.push(`Test Suite Run ${p["Test Suite Run"]?.select?.name}`);
  }
  if (p["Status"]?.status?.name !== "Not started") {
    problems.push(`Status ${p["Status"]?.status?.name}`);
  }
  if (p["Tested On"]?.date) {
    problems.push(`Tested On ${p["Tested On"].date.start}`);
  }
  if ((p["Assignee"]?.people || []).length) {
    problems.push("Assignee set");
  }
  if (p["Assignee - historical"]?.select) {
    problems.push("Assignee - historical set");
  }
  for (const name of ["Build Tested", "Run Issues", "Run Notes"]) {
    if ((p[name]?.rich_text || []).length) {
      problems.push(`${name} set`);
    }
  }
  return problems;
}

// The template's copy of the source's properties, and whatever it sets off on
// the board (in testing, Tested On came back as the current date, probably from
// an automation on the template's Status of Done), land asynchronously and can
// overwrite the reset after it has been written. So
// re-read until the reset has held on two reads PROPERTY_SETTLE_MS apart,
// re-applying it whenever it has been overwritten.
async function settleProperties(newPageId, sourcePage, toTag, properties) {
  let held = 0;
  let problems = [];
  for (let attempt = 0; attempt < 15 && held < 2; attempt += 1) {
    await sleep(PROPERTY_SETTLE_MS);
    const page = await execNotionJson("GET", `pages/${normalizePageId(newPageId)}`);
    problems = propertyProblems(page, sourcePage, toTag);
    if (problems.length) {
      held = 0;
      await updatePage(newPageId, properties);
    } else {
      held += 1;
    }
  }
  if (held < 2) {
    throw new Error(
      `Clone ${newPageId} of ${labelOf(sourcePage)} keeps coming back with ` +
        `${problems.join(", ") || "changed properties"}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Links between cards
// ---------------------------------------------------------------------------

// The ids of database cards a block links to: page mentions and page-link URLs
// in its text, and link_to_page blocks. `isCard` limits it to cards in this
// database (a link to some other Notion page is left alone).
function cardLinksInBlock(block, isCard) {
  const ids = [];
  for (const fragment of block[block.type]?.rich_text || []) {
    if (fragment.type === "mention" && fragment.mention?.type === "page") {
      ids.push(compactId(fragment.mention.page.id));
    }
    const url = fragment.text?.link?.url || "";
    for (const match of url.matchAll(PAGE_ID_IN_URL)) {
      ids.push(compactId(match[0]));
    }
  }
  if (block.type === "link_to_page" && block.link_to_page?.page_id) {
    ids.push(compactId(block.link_to_page.page_id));
  }
  return ids.filter(isCard);
}

// Decides where a link to `targetId` should point in the new run.
//   { kind: "same" }                 already in the new run; leave it
//   { kind: "mapped", newId }        re-point it at newId
//   { kind: "pending" }              will be cloned, but not yet (--limit run)
//   { kind: "not-carried", reason }  the target is not coming forward; flag it
//   { kind: "ambiguous", reason }    several new-run cards share its Test Case ID
function makeResolver({ pagesById, toTag, fromTag, created, dryRun, eligibleIds }) {
  const newIds = new Set(Object.values(created).map(compactId));
  // Test Case ID -> new-run cards: those already tagged toTag, plus clones made
  // during this run (not in the page list read at the start).
  const byCaseId = new Map();
  const addCase = (caseId, id) => {
    if (caseId == null) {
      return;
    }
    const list = byCaseId.get(caseId) || [];
    if (!list.includes(id)) {
      list.push(id);
    }
    byCaseId.set(caseId, list);
  };
  for (const page of pagesById.values()) {
    if (tagOf(page) === toTag) {
      addCase(caseIdOf(page), compactId(page.id));
    }
  }
  for (const [sourceId, newId] of Object.entries(created)) {
    addCase(caseIdOf(pagesById.get(compactId(sourceId))), compactId(newId));
  }

  return function resolve(targetId) {
    const id = compactId(targetId);
    const target = pagesById.get(id);
    if (newIds.has(id) || tagOf(target) === toTag) {
      return { kind: "same" };
    }
    const clonedTo = Object.entries(created).find(
      ([sourceId]) => compactId(sourceId) === id,
    );
    if (clonedTo) {
      return { kind: "mapped", newId: compactId(clonedTo[1]) };
    }
    if (tagOf(target) === fromTag && eligibleIds.has(id)) {
      // Cloned later in this run, or (in a dry run) would be.
      return dryRun ? { kind: "mapped", newId: null } : { kind: "pending" };
    }
    const matches = byCaseId.get(caseIdOf(target)) || [];
    if (matches.length === 1) {
      return { kind: "mapped", newId: matches[0] };
    }
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        reason: `${matches.length} cards in "${toTag}" have Test Case ID #${caseIdOf(target)}`,
      };
    }
    let reason = `no card in "${toTag}" has its Test Case ID`;
    if (tagOf(target) === fromTag && isExcluded(target)) {
      reason = `not carried forward (Priority ${priorityOf(target) || "-"}, Status ${statusOf(target) || "-"})`;
    }
    return { kind: "not-carried", reason, targetTag: tagOf(target) };
  };
}

// A link left pointing at a card in another suite run is preceded by this, so a
// reader can tell where following it will take them.
function suiteMarker(tag) {
  return `[${tag} card] `;
}

// Re-point card links in a rich_text array, and mark any link left pointing
// into another suite run with suiteMarker(). Returns the new array, or null if
// nothing changed.
function relinkRichText(richTextValue, resolve, isCard, onUnresolved) {
  let changed = false;
  const out = [];
  // Put the marker before a link that stays in another suite run, unless the
  // text just before it already has it (a re-run, or a person typed it).
  const markIfNeeded = (result) => {
    if (result.kind !== "not-carried" || !result.targetTag) {
      return;
    }
    const marker = suiteMarker(result.targetTag);
    const before = out.map((p) => p.text?.content ?? "").join("");
    if (before.endsWith(marker) || before.endsWith(marker.trim())) {
      return;
    }
    out.push({ type: "text", text: { content: marker } });
    changed = true;
  };

  for (const piece of sanitizeRichText(richTextValue)) {
    if (piece.type === "mention" && piece.mention.page) {
      const oldId = compactId(piece.mention.page.id);
      if (!isCard(oldId)) {
        out.push(piece);
        continue;
      }
      const result = resolve(oldId);
      if (result.kind === "mapped" && result.newId) {
        changed = true;
        out.push({ ...piece, mention: { page: { id: result.newId } } });
        continue;
      }
      if (result.kind !== "mapped") {
        onUnresolved(oldId, result);
        markIfNeeded(result);
      }
      out.push(piece);
      continue;
    }
    const url = piece.text?.link?.url;
    if (!url) {
      out.push(piece);
      continue;
    }
    let unresolved = null;
    const newUrl = url.replace(PAGE_ID_IN_URL, (match) => {
      const oldId = compactId(match);
      if (!isCard(oldId)) {
        return match;
      }
      const result = resolve(oldId);
      if (result.kind === "mapped" && result.newId) {
        return result.newId;
      }
      if (result.kind !== "mapped") {
        onUnresolved(oldId, result);
        unresolved = result;
      }
      return match;
    });
    if (unresolved) {
      markIfNeeded(unresolved);
    }
    if (newUrl === url) {
      out.push(piece);
      continue;
    }
    changed = true;
    out.push({ ...piece, text: { ...piece.text, link: { url: newUrl } } });
  }
  return changed ? out : null;
}

// The relink pass for one new-run card: its Related Cases relation and the
// card links in its body. With apply=false it only reports.
async function relinkCard({ pageId, label, relatedIds, scanBody, resolve, isCard, pagesById, apply, flags }) {
  const flag = (via, targetId, result) => {
    if (result.kind === "pending" || result.kind === "same") {
      return;
    }
    const target = pagesById.get(compactId(targetId));
    flags.push({ from: label, via, to: target ? labelOf(target) : targetId, reason: result.reason });
  };
  let writes = 0;

  // Related Cases.
  const newRelated = [];
  let relationChanged = false;
  for (const id of relatedIds) {
    const result = resolve(id);
    if (result.kind === "mapped") {
      relationChanged = true;
      if (result.newId) {
        newRelated.push(result.newId);
      }
    } else {
      flag(RELATED_CASES, id, result);
      newRelated.push(compactId(id));
    }
  }
  if (apply && relationChanged) {
    const unique = [...new Set(newRelated)];
    await updatePage(pageId, { [RELATED_CASES]: { relation: unique.map((id) => ({ id })) } });
    writes += 1;
  }

  if (!scanBody) {
    return writes;
  }
  for (const block of await listAllBlocksDeep(pageId)) {
    const links = cardLinksInBlock(block, isCard);
    if (!links.length) {
      continue;
    }
    if (block.type === "link_to_page") {
      const result = resolve(links[0]);
      if (result.kind === "mapped" && result.newId && apply) {
        try {
          await execNotionJson("PATCH", `blocks/${normalizePageId(block.id)}`, {
            link_to_page: { type: "page_id", page_id: result.newId },
          });
          writes += 1;
        } catch (error) {
          flags.push({ from: label, via: "body link_to_page", to: links[0], reason: `could not re-point (${error.message}); fix by hand` });
        }
      } else if (result.kind !== "mapped") {
        flag("body", links[0], result);
      }
      continue;
    }
    const newRichText = relinkRichText(
      block[block.type].rich_text,
      resolve,
      isCard,
      (id, result) => flag("body", id, result),
    );
    if (newRichText && apply) {
      await execNotionJson("PATCH", `blocks/${normalizePageId(block.id)}`, {
        [block.type]: { rich_text: newRichText },
      });
      writes += 1;
    }
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 0;
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg
    ? new Set(onlyArg.slice("--only=".length).split(",").map((id) => Number(id.replace("#", ""))))
    : null;
  const concurrencyArg = argv.find((arg) => arg.startsWith("--concurrency="));
  const concurrency = concurrencyArg
    ? Number(concurrencyArg.slice("--concurrency=".length))
    : DEFAULT_CONCURRENCY;
  return {
    only,
    concurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY,
    fromTag: positional[0],
    toTag: positional[1],
    apply: flags.has("--apply"),
    force: flags.has("--force"),
    requireAreas: flags.has("--require-areas"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
  };
}

async function main() {
  const { fromTag, toTag, apply, force, requireAreas, limit, only, concurrency } = parseArgs(
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
  const pagesById = new Map(pages.map((page) => [compactId(page.id), page]));
  const isCard = (id) => pagesById.has(id);

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
  const eligibleIds = new Set(eligible.map((page) => compactId(page.id)));
  const existingTarget = pages.filter((page) => tagOf(page) === toTag);

  // Resume state, scoped to this from->to pair.
  let state = loadJson(statePath, null);
  if (!state || state.fromTag !== fromTag || state.toTag !== toTag) {
    state = { fromTag, toTag, created: {} };
  }
  state.bodyHasCardLinks ||= {};
  state.finished ||= {};
  state.templateApplied ||= {};
  const alreadyCreated = new Set(Object.values(state.created).map(compactId));

  // Cards not yet cloned in this from->to pair. --limit counts NEW cards, so an
  // earlier partial/smoke run does not eat into this run's batch.
  const pending = eligible.filter(
    (page) => !state.created[page.id] && (!only || only.has(caseIdOf(page))),
  );
  const source = limit ? pending.slice(0, limit) : pending;
  const foreignTargets = existingTarget.filter(
    (page) => !alreadyCreated.has(compactId(page.id)),
  );

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
  console.log(
    `Suite run "${toTag}": ${existingTarget.length} existing cards` +
      ` (${foreignTargets.length} not created by this tool).`,
  );

  // A card with an automated test should never be dropped from the suite by
  // accident; report any that are.
  const droppedAutomation = ignored.filter(hasAutomation);
  if (droppedAutomation.length) {
    console.log(`\nWARNING: cards with automation that will NOT be carried forward:`);
    for (const page of droppedAutomation) {
      console.log(
        `  ${labelOf(page)} Automation=${page.properties?.["Automation"]?.select?.name || "-"}` +
          ` Priority=${priorityOf(page) || "-"} Status=${statusOf(page)} :: ${titleOf(page)}`,
      );
    }
  }

  // Guard against duplicating a case into the new run. Cards already in <to-tag>
  // that this tool did not create are expected (new cases are written straight
  // into the new run), so they only block the run when one shares a Test Case ID
  // with a card about to be cloned: that means the case is already there.
  const sourceCaseIds = new Set(source.map(caseIdOf).filter((id) => id != null));
  const collisions = foreignTargets.filter((page) => sourceCaseIds.has(caseIdOf(page)));
  if (collisions.length) {
    console.log(
      `\n${apply && !force ? "Refusing to apply" : "WARNING"}: these cards in "${toTag}" ` +
        `already have the Test Case ID of a card about to be cloned:`,
    );
    for (const page of collisions) {
      console.log(`  ${labelOf(page)} ${titleOf(page)}`);
    }
    if (apply && !force) {
      console.error(`Re-run with --force to clone them anyway.`);
      process.exit(1);
    }
  }

  if (!apply) {
    console.log("\n-- DRY RUN (no Notion writes). Pass --apply to clone. --");
    const preview = source.slice(0, 10);
    for (const page of preview) {
      console.log(`  would clone: ${titleOf(page)}`);
    }
    if (source.length > preview.length) {
      console.log(`  ... and ${source.length - preview.length} more`);
    }
  }

  // Pass 1: copy the cards. A card is recorded in state as soon as its copy is
  // started, so an interrupted run never starts a second copy of it; a copy
  // that was started but not finished is finished on the next run.
  let created = 0;
  const failures = [];
  if (apply) {
    const dataSourceId = await getDataSourceId(databaseId);
    const unfinished = eligible.filter(
      (page) => state.created[page.id] && !state.finished[state.created[page.id]],
    );
    const work = [...unfinished, ...source];

    const copyOne = async (page) => {
      const sourceBlockCount = (await listAllChildren(page.id)).length;
      let newId = state.created[page.id];
      if (!newId) {
        newId = (await createCard(dataSourceId, page, toTag)).id;
        state.created[page.id] = newId;
        saveJson(statePath, state);
      }
      // The template is applied at most once per page, even across resumed
      // runs: a copy that is merely slow would otherwise land as a second body.
      if (sourceBlockCount && !state.templateApplied[newId]) {
        await applyTemplate(newId, page);
        state.templateApplied[newId] = true;
        saveJson(statePath, state);
      }
      await waitForTemplate(newId, sourceBlockCount);
      const newBlockCount = (await listAllChildren(newId)).length;
      if (newBlockCount !== sourceBlockCount) {
        throw new Error(
          `Clone ${newId} has ${newBlockCount} top-level blocks; ` +
            `the source has ${sourceBlockCount}. Check it for a doubled body.`,
        );
      }
      if (await finishCopy(newId, page, toTag, isCard)) {
        state.bodyHasCardLinks[newId] = true;
      }
      state.finished[newId] = true;
      saveJson(statePath, state);
      created += 1;
      console.log(`  [${created}/${work.length}] cloned: ${labelOf(page)} ${titleOf(page)}`);
    };

    // A few workers share the queue. One card failing is reported and does not
    // stop the others; a re-run picks it up again.
    const queue = [...work];
    const worker = async () => {
      while (queue.length) {
        const page = queue.shift();
        try {
          await copyOne(page);
        } catch (error) {
          failures.push(`${labelOf(page)} ${titleOf(page)}: ${error.message}`);
          console.error(`  FAILED: ${labelOf(page)} ${titleOf(page)}: ${error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  }

  // Pass 2: re-point links between cards at the new-run counterparts. In a dry
  // run this scans the source cards instead, and only reports.
  console.log(apply ? "\nRe-pointing links between cards ..." : "\nChecking links between cards ...");
  const resolve = makeResolver({
    pagesById,
    toTag,
    fromTag,
    created: state.created,
    dryRun: !apply,
    eligibleIds,
  });
  const flags = [];
  let writes = 0;
  const targets = [];
  for (const page of foreignTargets) {
    targets.push({ pageId: page.id, label: labelOf(page), relatedIds: relatedIdsOf(page), scanBody: true });
  }
  if (apply) {
    for (const [sourceId, newId] of Object.entries(state.created)) {
      const sourcePage = pagesById.get(compactId(sourceId));
      targets.push({
        pageId: newId,
        label: `${labelOf(sourcePage).replace(`(${fromTag})`, `(${toTag})`)}`,
        relatedIds: relatedIdsOf(sourcePage),
        scanBody: Boolean(state.bodyHasCardLinks[newId]),
      });
    }
  } else {
    for (const page of eligible) {
      targets.push({ pageId: page.id, label: labelOf(page), relatedIds: relatedIdsOf(page), scanBody: true });
    }
  }
  for (const target of targets) {
    writes += await relinkCard({ ...target, resolve, isCard, pagesById, apply, flags });
  }
  if (apply) {
    console.log(`  ${writes} relation/block update(s).`);
  }

  if (flags.length) {
    console.log(`\nLinks to cards that will not be in "${toTag}" (left pointing at the old card):`);
    for (const f of flags) {
      console.log(`  ${f.from} --${f.via}--> ${f.to}: ${f.reason}`);
    }
  } else {
    console.log(`\nEvery link between cards resolves to a card in "${toTag}".`);
  }

  if (apply) {
    console.log(`\nDone. Copied ${created} card(s) into "${toTag}".`);
    if (failures.length) {
      console.error(`\n${failures.length} card(s) failed; re-run to retry them:`);
      for (const failure of failures) {
        console.error(`  ${failure}`);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

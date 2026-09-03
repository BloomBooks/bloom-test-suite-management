// Pull every card from the live `Test Case Runs` database and write a flat
// snapshot to progress-report/data/cards.json. One network pass; every later
// step (statistics, chart, image) reads the snapshot, not Notion.
//
//   node fetch-data.mjs
//
// Needs the Notion token in BLOOM_TESTCASE_NOTION (or NOTION_TOKEN).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDatabasePages, getDatabase, loadJson, saveJson } from "../lib/notion.mjs";
import { dataDir } from "./options.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadJson(path.join(here, "..", "notion-config.json"), {});
const databaseId = config.databases?.testCaseRuns;
if (!databaseId) throw new Error("notion-config.json has no databases.testCaseRuns");

function plain(prop) {
  if (!prop) return "";
  const parts = prop.rich_text || prop.title || [];
  return parts.map((p) => p.plain_text).join("");
}

function value(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plain(prop);
    case "number":
      return prop.number;
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "multi_select":
      return prop.multi_select.map((o) => o.name);
    case "date":
      return prop.date?.start ?? null;
    case "people":
      return prop.people.map((p) => p.name || p.id);
    case "checkbox":
      return prop.checkbox;
    default:
      return null;
  }
}

const db = await getDatabase(databaseId);
const pages = await listDatabasePages(databaseId);

const cards = pages.map((page) => {
  const out = {
    id: page.id,
    url: page.url,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    archived: page.archived,
  };
  for (const [name, prop] of Object.entries(page.properties)) out[name] = value(prop);
  return out;
});

saveJson(path.join(dataDir, "cards.json"), cards);
saveJson(path.join(dataDir, "schema.json"), {
  fetchedAt: new Date().toISOString(),
  databaseId,
  properties: Object.fromEntries(
    Object.entries(db.properties).map(([name, p]) => [
      name,
      {
        type: p.type,
        options: (p.select?.options || p.status?.options || p.multi_select?.options || []).map(
          (o) => o.name,
        ),
      },
    ]),
  ),
});
console.log(`fetched ${cards.length} cards into data/cards.json`);

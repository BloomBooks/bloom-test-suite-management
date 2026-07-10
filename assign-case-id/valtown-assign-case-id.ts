// Source of record for the val.town HTTP val that assigns the next
// `Test Case ID` to cards created directly in Notion. The running copy is
// deployed on val.town; keep the two in sync when editing. See README.md in
// this folder for the full wiring. Self-contained on purpose — it runs on
// val.town (Deno), so it cannot import lib/notion.mjs.
//
// Env vars (set in val.town settings):
//   NOTION_TOKEN    - same integration token as BLOOM_TESTCASE_NOTION locally
//   TESTCASE_DB_ID  - databases.testCaseRuns from notion-config.json
//   WEBHOOK_SECRET  - random string; Notion's webhook action cannot set auth
//                     headers, so the secret rides in the query string instead

const NOTION = "https://api.notion.com/v1";

async function notion(method: string, path: string, body?: unknown) {
  const res = await fetch(`${NOTION}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get("NOTION_TOKEN")}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function (req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  // Notion's webhook-action payload shape has shifted over time; try the
  // known wrappings and fail loudly rather than guess.
  const payload = await req.json();
  const pageId = payload?.data?.id ?? payload?.entity?.id;
  if (!pageId) return new Response("no page id in payload", { status: 400 });

  // Re-fetch the page: only assign if Test Case ID is still blank.
  // Duplicated cards (new run of an existing case) and importer-created
  // cards already carry an ID and must be left alone.
  const page = await notion("GET", `pages/${pageId}`);
  if (page.properties?.["Test Case ID"]?.number != null) {
    return new Response("already has an id, skipped");
  }

  const result = await notion(
    "POST",
    `databases/${Deno.env.get("TESTCASE_DB_ID")}/query`,
    {
      filter: { property: "Test Case ID", number: { is_not_empty: true } },
      sorts: [{ property: "Test Case ID", direction: "descending" }],
      page_size: 1,
    },
  );
  const max = result.results[0]?.properties?.["Test Case ID"]?.number ?? 0;

  await notion("PATCH", `pages/${pageId}`, {
    properties: { "Test Case ID": { number: max + 1 } },
  });
  return new Response(`assigned ${max + 1}`);
}

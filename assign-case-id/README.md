# Assign Case ID

Gives every card created directly in Notion the next available `Test Case ID`.
`valtown-assign-case-id.ts` is the **source of record** for an HTTP val whose
running copy is deployed on [val.town](https://val.town); keep the deployed val
and this file in sync when editing. It is deliberately self-contained (val.town
runs Deno and cannot import `lib/notion.mjs`).

## How a tester creates a card

The `Test Case Runs` database has a default template that pre-sets
`Test Suite Run` to the current run and `Status` to `Not started`, and leaves
`Test Case ID` **blank**. A blank `Test Case ID` is the signal that a number
needs to be assigned.

To add a new run of an *existing* case, testers instead use Notion's
**Duplicate** and change the `Test Suite Run` tag — the duplicated card keeps
its `Test Case ID`, and the val leaves it alone (it only ever fills blanks).

## Wiring

1. Create an HTTP val on val.town from `valtown-assign-case-id.ts` and set its
   env vars:
   - `NOTION_TOKEN` — the same integration token as `BLOOM_TESTCASE_NOTION`
     locally
   - `TESTCASE_DB_ID` — `databases.testCaseRuns` from `notion-config.json`
   - `WEBHOOK_SECRET` — any random string
2. On the `Test Case Runs` database, add a database automation:
   trigger **Page added** → action **Send webhook** → the val's URL with
   `?secret=<WEBHOOK_SECRET>` appended. (Notion's webhook action cannot set
   auth headers, so the secret rides in the query string. Database automations
   require a paid Notion plan.)

## What the val does

1. Rejects requests whose `secret` query param doesn't match.
2. Re-fetches the page and exits unless `Test Case ID` is blank — duplicated
   cards and importer-created cards are never renumbered. This also makes
   webhook re-fires harmless.
3. Queries the database for the current max `Test Case ID` and assigns
   max + 1.

## Caveats

- **Concurrency:** val executions can overlap, so two cards created in the
  same instant could in theory read the same max and get the same ID. At human
  card-creation pace this is vanishingly unlikely; if it ever matters, val.town
  sqlite can serialize the counter.
- **Payload shape:** Notion's webhook-action payload wrapping has shifted over
  time; the val tries `data.id` and `entity.id` and returns 400 rather than
  guess. If a new card doesn't get an ID, check the val's logs first.
- **Import interaction:** cards created in Notion claim IDs above the
  spreadsheet-derived max, so any future import must start its `testCaseId`
  sequence above the *live Notion* max (see the note in `import/schema.md`).

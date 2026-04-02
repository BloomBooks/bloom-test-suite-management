The Test cases database is at https://www.notion.so/hattonjohn/3304bb19df1280528bb1c14eb9148029?v=3304bb19df1280139ed8000c2120ff04&source=copy_link

The test runs database is at https://www.notion.so/hattonjohn/3304bb19df1280eab05bd2e727e4454d?v=3304bb19df1280e69ec1000cbee2a1fc&source=copy_link

"Bloom Test Plan.csv" As a single row for each test case and then a set of columns for each test run.

Our goal is to populate the two Notion databases from this CSV. It requires the key be put in NOTION_TOKEN environment variable. the actual value is in my BLOOM_TESTCASE_NOTION environment variable.

We tried the "notion" cli from https://github.com/Balneario-de-Cofrentes/notion-cli-agent, but the reliable bulk-import path turned out to be direct HTTPS calls to the Notion API from `scripts/import-to-notion.mjs`.

Current importer artifacts:

- The preparer script is at `scripts/prepare-bloom-import.mjs`.
- The batch builder is at `scripts/build-notion-batches.mjs`.
- Because the source CSV was locked by the editor, the prepared CSV with `Import ID` values was written to `build/Bloom Test Plan.with-import-id.csv`.
- Normalized data is in `build/bloom-cases.json` and `build/bloom-runs.json`.
- Sanity output is in `build/bloom-sanity.json` and `build/bloom-headers.json`.
- Notion batch payloads are in `build/notion-case-batches/` and `build/notion-run-batches/`.
- Seeded Notion IDs are in `build/notion-state.json`.

Session handoff: what worked for Notion

1. Use stable importer keys, not titles
   Cases upsert by `Import ID`.
   Runs upsert by `Import Run ID`.
   Runs also carry `Case Import ID` as a plain text join key.
   Do not try to dedupe by title or by the visible relation text.
2. Use the current improved schema
   Test cases database fields that matter are: `Test Case` (title), `Case Code`, `Steps`, `Priority`, `Past Issues`, `Import ID`.
   Test runs database fields that matter are: `Run` (title), `Case` (relation), `Case Import ID`, `Import Run ID`, `Person`, `Date`, `Build`, `Issue(s)`, `OK`, `Test Run Label`, `Platform`.
3. Direct API calls were more reliable than the CLI wrapper
   `scripts/import-to-notion.mjs` talks directly to `https://api.notion.com/v1/...` using `fetch`.
   This avoided shell quoting and payload corruption issues that showed up with the CLI wrapper on Windows.
4. Use local state for reruns
   `build/notion-state.json` is the local source of truth for already-created Notion page IDs.
   The importer updates this file after each successful create.
   Reruns are safe because existing IDs are updated instead of recreated.
5. Keep lookup disabled unless necessary
   The importer supports live lookup by `Import ID` and `Import Run ID`, but that increases API traffic.
   The normal fast path is to trust `build/notion-state.json` and leave `IMPORT_ALLOW_LOOKUP` unset.
6. Use conservative retry settings
   Effective settings were low concurrency plus retries/backoff, especially for runs.
   Useful environment variables are:
   `IMPORT_CONCURRENCY`
   `IMPORT_RETRY_COUNT`
   `IMPORT_RETRY_DELAY_MS`
   `IMPORT_REQUEST_TIMEOUT_MS`
   `IMPORT_SKIP_CASES`
   `IMPORT_SKIP_RUNS`
   `IMPORT_ONLY_CASE_IDS`
   `IMPORT_ONLY_RUN_IDS`
7. The CSV must be normalized before import
   Run `scripts/prepare-bloom-import.mjs` first.
   This inserts or preserves `Import ID`, normalizes dates, derives run labels/platforms, and writes `build/bloom-cases.json`, `build/bloom-runs.json`, and `build/bloom-sanity.json`.
   If the main CSV is locked, the script writes `build/Bloom Test Plan.with-import-id.csv` instead.
8. Not every CSV row becomes a run
   The importer intentionally ignores placeholder columns that only have default `FALSE` values and no real person/date/build/issue data.
   That reduced inflated run counts significantly.
9. Continuation rows need deterministic IDs
   Some CSV rows have no source reference in the first column.
   Those get generated IDs like `src-r12` or `src-tc8-r33`.
   These should be treated as stable importer IDs unless the source sheet is manually restructured.
10. Sanity check after import is mandatory
   `scripts/import-to-notion.mjs` ends with a read-only sanity sample and writes `build/notion-post-import-sanity.json`.
   Also review `build/notion-import-failures.json`, `build/notion-state.json`, and `build/bloom-sanity.json`.
11. If starting a new session, inspect these first
   `scripts/import-to-notion.mjs`
   `scripts/prepare-bloom-import.mjs`
   `build/notion-state.json`
   `build/notion-import-failures.json`
   `build/notion-post-import-sanity.json`
   `build/bloom-sanity.json`

Sanity check plan after import:

1. Count comparison
   Compare case count and run count from `build/notion-batch-summary.json` against the counts visible in Notion after import.
2. Date warning review
   Review `build/bloom-sanity.json` for `dateWarnings`; these are ambiguous or unparsed source dates that may need manual cleanup.
3. Version/platform spot checks
   Check at least one imported run for each of these slot families: `6.3`, `6.0`, `5.6`, `5.5`, `5.4 BetaInternal`, `4.9 Spot Testing`, `4.6 Windows`, `4.6 Wasta`, `3.7 Linux`.
4. Existing experiment reconciliation
   Confirm the manually created experiment rows now carry `Import ID` or `Import Run ID` values and were not duplicated by the bulk import.
5. Random row audit
   Pick 20 CSV rows across the file and verify: case name, priority, past issues, run count, people, dates, builds, issues, `OK`, and `Test Run Label`.
6. Continuation-row audit
   Specifically inspect rows whose source reference was blank and now use generated IDs like `src-r12` or `src-tc8-r33` to ensure the derived case identity is acceptable.

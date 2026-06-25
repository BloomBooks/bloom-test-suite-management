# Workspace Notes

## Windows Shell Use

- Use PowerShell as the default command orchestrator in this workspace because the terminal tool is a persistent Windows PowerShell session.
- Do not use `node -e` for nontrivial inspection or transformation commands on Windows.
- Treat inline eval as unsafe when the command contains nested quotes, JSON literals, regexes, template strings, backslashes, or embedded file paths.
- For nontrivial ad hoc logic, prefer one of these instead:
  - a small `.mjs` file in the workspace
  - a small `.ps1` file in the workspace
  - an existing checked-in script
- Prefer the lowest-parser-count option. Avoid stacking JSON string parsing, PowerShell parsing, and JavaScript eval in one command.

## Notion Import

- The model is a **single Notion database: `Test Case Runs`.** There is no separate `Test Cases` or `Test Suite Runs` database.
- Suite-run membership is a closed `Test Suite Run` **select tag** on each run card, not a relation.
- Each run card is the merge of the full test case definition and one run. Durable case metadata (case summary, legacy number, dokimion id, priority, past issues, est. time, areas, step description, original description) is folded onto each run card as its own properties; the parsed checklist steps/notes go in the page body as a to-do list. Each run card corresponds to exactly one execution, so there is no execution-entry list; any raw cell that didn't normalize cleanly (skip reason, unknown/`Future` tester, unparsable date) is kept in the `Import Notes` property.
- Suite-run names drop the `BetaInternal` qualifier, and only suite runs at or after version 5.5 are imported (`MIN_SUITE_RUN` in prepare-import.mjs).
- `Assignee` is a closed select mapped to a fixed name set (Andrew, Bharani, Hatton, Jeffrey, JohnT, Steve, Noel, Heather, Colin, Gordon; SteveMc -> Steve). Cells that don't match — skipped runs, `Future`, review comments, unknown names — leave it blank (raw value stays in the body).
- A run whose assignee starts with `skip` is flagged via the `Skipped` checkbox, and a skipped run is never marked `OK` even if the source said yes.
- `prepare-import.mjs` reads `area-mapping.json`, `title-mapping.json`, and `step-overrides.json` to derive areas, clean titles, and checklist steps/notes from the spreadsheet.
- Besides the main `Bloom Test Plan.csv`, two optional sources are appended (if present), with Test Case IDs continuing past the main set: `Bloom Test Plan - YouTrack Only.csv` (no run data; one card each) and `Bloom Test Plan - temp Dokimion cases.csv` (has 6.3/6.4 run data merged into those tags; only specific row ranges imported; its `notes` column renders under a `Notes` heading at the bottom of the page body).
- `prepare-import.mjs` produces `test-case-runs.json` (the only Notion-bound file) plus `suite-run-tags.json`, and `import-to-notion.mjs` should mainly transport those prepared values to Notion.
- When updating existing run card bodies, use `IMPORT_REPLACE_BODY=1` so old body content is replaced instead of preserved.

## Live Notion Schema

- Clean slate: the new root page is `Bloom-Tests` (`37d4bb19df128097a7f9f7f0ab9f1a2f`). `import-to-notion.mjs` creates a fresh `Test Case Runs` database under `parentPageId` when `databases.testCaseRuns` is empty, and records the created id in `notion-state.json` as `databaseId`.
- Only the `Test Case Runs` database is written. The old `Test Cases` and `Test Suite Runs` databases are left untouched and are no longer in `notion-config.json`.
- In the `Test Case Runs` database:
  - `Test Suite Run` is a `select` (the closed suite-run tag list); option names cannot contain commas.
  - `OK` is a `checkbox` derived from the spreadsheet `OK?` column.
  - `Build Tested`, `Issue Links`, `Past Issues`, `Case Summary`, `Legacy Number`, `Dokimion ID`, `Step Description`, `Original Description`, `Import Notes`, `Import Source Row Number` are `rich_text` (`Dokimion ID` links to its bloom-test-cases file; `Import Source Row Number` is text because the YouTrack-only source uses `youtrack-only-<n>` ids).
  - `Assignee` is a `select` with a fixed option set.
  - `Areas` is a `multi_select`.
  - `Priority` is a `select`; `OK`/`Skipped` are `checkbox`; `Test Case ID`/`Est. Time (min)` are `number`; `Tested On` is `date`.
- `import-to-notion.mjs` reconciles the live `Test Case Runs` schema by default: it drops obsolete properties (`Test Case` relation, `Active`, and the `Import ID` / `Import Run ID` upsert keys), converts any leftover `Test Suite Run` relation into a `select`, and adds any missing required properties.
- This is a one-and-done import (fresh DB, no upsert): there is no live lookup by a Notion property. `notion-state.json` (keyed by `importRunId`) only exists so an interrupted run can resume.

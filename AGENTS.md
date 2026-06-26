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
- Each run card is the merge of the full test case definition and one run. The case summary is the card title; the rest of the durable case metadata (legacy number, dokimion id, priority, past issues, est. time, areas, summary, original description) is folded onto each run card as its own properties; the parsed checklist steps/notes go in the page body as a to-do list. Each run card corresponds to exactly one execution, so there is no execution-entry list; any raw cell that didn't normalize cleanly (skip reason, unknown/`Future` tester, unparsable date) is kept in the `Import Notes` property.
- Suite-run names drop the `BetaInternal` qualifier, and only suite runs at or after version 5.5 are imported (`MIN_SUITE_RUN` in prepare-import.mjs).
- `Assignee` is a closed select mapped to a fixed name set (Andrew, Bharani, Hatton, Jeffrey, JohnT, Steve, Noel, Heather, Colin, Gordon; SteveMc -> Steve). Cells that don't match — skipped runs, `Future`, review comments, unknown names — leave it blank (raw value stays in the body).
- The run outcome is a single native `Status` property (`Not started` / `In Progress` / `Problems` / `Skipped` / `Done`), derived from skipped/ok/assignee/issueLinks in `deriveStatus()`. It replaces the old `OK` and `Skipped` checkboxes and is meant to drive a Kanban board view. A skip assignee yields `Skipped`.
- `prepare-import.mjs` reads `area-mapping.json`, `title-mapping.json`, `step-overrides.json`, and `summaries.json` to derive areas, clean titles, checklist steps/notes, and the one-line `Summary` from the spreadsheet. `summaries.json` is keyed by `Import ID` and supplies hand-authored summaries that override the heuristic; `Ignore` cases get a blank summary.
- Besides the main `Bloom Test Plan.csv`, the optional `Bloom Test Plan - temp Dokimion cases.csv` is appended (Test Case IDs continue past the main set; `Import Source Row Number` is `temp-dokimion-<row>`). Rows 507-567 and 592-608 have 6.3/6.4 run data that merges into those tags (its `notes` column renders under a `Notes` heading at the bottom of the page body); rows 609+ are YouTrack-only issues with no run data (one card each, named `<BL-id> - <description>`).
- `prepare-import.mjs` produces `test-case-runs.json` (the only Notion-bound file) plus `suite-run-tags.json`, and `import-to-notion.mjs` should mainly transport those prepared values to Notion.
- When updating existing run card bodies, use `IMPORT_REPLACE_BODY=1` so old body content is replaced instead of preserved.

## Live Notion Schema

- Clean slate: the new root page is `Bloom-Tests` (`37d4bb19df128097a7f9f7f0ab9f1a2f`). `import-to-notion.mjs` creates a fresh `Test Case Runs` database under `parentPageId` when `databases.testCaseRuns` is empty, and records the created id in `notion-state.json` as `databaseId`.
- Only the `Test Case Runs` database is written. The old `Test Cases` and `Test Suite Runs` databases are left untouched and are no longer in `notion-config.json`.
- In the `Test Case Runs` database:
  - `Test Suite Run` is a `select` (the closed suite-run tag list); option names cannot contain commas.
  - `Status` is a native `status` property (the single run outcome; replaces the old `OK`/`Skipped` checkboxes; drives the Kanban board).
  - `Build Tested`, `Issue Links`, `Past Issues`, `Legacy Number`, `Dokimion ID`, `Summary`, `Original Description`, `Import Notes`, `Import Source Row Number` are `rich_text` (`Dokimion ID` links to its bloom-test-cases file; `Import Source Row Number` is text because the temp-Dokimion source uses `temp-dokimion-<n>` ids). The case summary is the title, not a separate property.
  - The Notion API does not auto-linkify plain text, so `import-to-notion.mjs` runs readable content through `linkifyRichText()`, which makes bare `http(s)://` URLs and `BL-####` issue refs clickable. It is applied to the page-body Test Steps / Notes and the `Summary`, `Original Description`, `Past Issues`, `Issue Links`, and `Import Notes` properties.
  - `Assignee` is a `select` with a fixed option set.
  - `Areas` is a `multi_select`.
  - `Priority` is a `select`, `Status` is a `status`; `Test Case ID`/`Est. Time (min)` are `number`; `Tested On` is `date`.
- `import-to-notion.mjs` reconciles the live `Test Case Runs` schema by default: it drops obsolete properties (`Test Case` relation, `Active`, and the `Import ID` / `Import Run ID` upsert keys), converts any leftover `Test Suite Run` relation into a `select`, and adds any missing required properties.
- This is a one-and-done import (fresh DB, no upsert): there is no live lookup by a Notion property. `notion-state.json` (keyed by `importRunId`) only exists so an interrupted run can resume.

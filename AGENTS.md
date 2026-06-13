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

## Round2 Notion Import

- The model is a **single Notion database: `Test Case Runs`.** There is no separate `Test Cases` or `Test Suite Runs` database.
- Suite-run membership is a closed `Test Suite Run` **select tag** on each run card, not a relation.
- Durable case metadata (case summary, legacy number, dokimion id, priority, past issues, est. time) is folded onto each run card as its own properties; the description/steps go in the page body.
- `round2/prepare-import.mjs` produces `test-case-runs.json` (the only Notion-bound file) plus `suite-run-tags.json`, and `round2/import-to-notion.mjs` should mainly transport those prepared values to Notion.
- When updating existing run card bodies, use `ROUND2_REPLACE_BODY=1` so old body content is replaced instead of preserved.
- Date cells that don't parse: a bare `ok` is dropped; any other leftover text goes into the card `notes` (multiple notes joined with `; `) and is mirrored in `date-warnings.json`.
- After (re)creating the database, some setup can't be scripted (hiding properties on the opened-card view) — see `manual-steps-after-notion-import.md`.

## Live Notion Schema

- Clean slate: the new root page is `Bloom-Tests` (`37d4bb19df128097a7f9f7f0ab9f1a2f`). `import-to-notion.mjs` creates a fresh `Test Case Runs` database under `parentPageId` when `databases.testCaseRuns` is empty, and records the created id in `notion-state.json` as `databaseId`.
- Only suite runs `6.4` down to `4.8` are imported; `detectSlots()` stops at the `4.7 FX` header, excluding it and the older platform-split `Person testing` columns. Every run card therefore has exactly one execution.
- On database creation only: `Priority`/`Status` options are seeded with colors, and the default view hides the plumbing properties (`Import Run ID`, `Source Row Number`, `Test Case ID`, `Legacy Number`, `Dokimion ID`) via the Views API (`Notion-Version: 2025-09-03`, best-effort). To re-apply, delete and recreate the database.
- Only the `Test Case Runs` database is written. The old `Test Cases` and `Test Suite Runs` databases are left untouched and are no longer in `round2/notion-config.json`.
- In the `Test Case Runs` database:
  - `Test Suite Run` is a `select` (the closed suite-run tag list); option names cannot contain commas.
  - `Area` is a `select`, carried forward from section-header rows via `round2/area-mapping.json` (keys matched on the description column; `instruction`/`ignore` kinds are not yet acted on).
  - `Status` is a `select`: `Skipped` (Person matches `/skip/i`) or `Done` (the `OK?` column was TRUE), Skipped winning. There is no OK checkbox; `OK?` is folded into `Status`.
  - `Build Tested`, `Issue Links`, `Past Issues`, `Legacy Number`, `Dokimion ID`, `Notes` are `rich_text`. The card title (`Test Case Run`) is a short hand-written summary from `round2/case-summaries.json` (keyed by snapshot; blank until authored); there is no separate Case Summary property. The card body is `caseSnapshot` (cleaned description, line breaks kept).
  - `Assignee` is a `multi_select` of canonical tester names (normalized from the Person column; `SteveMc`->`Steve`; cleared on Skipped runs).
  - `Priority` is a `select`; `Test Case ID`/`Est. Time (min)`/`Source Row Number` are `number`; `Tested On` is `date`. `Test Case ID` (the case grouping key) currently equals `Source Row Number`. There is no `Import ID` property; `importRunId` is built from an internal case slug.
- `import-to-notion.mjs` reconciles the live `Test Case Runs` schema by default: it drops the obsolete `Test Case` relation, converts any leftover `Test Suite Run` relation into a `select`, and adds any missing required properties.

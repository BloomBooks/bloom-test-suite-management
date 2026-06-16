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
- Each run card is the merge of the full test case definition and one run. Durable case metadata (case summary, legacy number, dokimion id, priority, past issues, est. time, active, areas, step description, original description) is folded onto each run card as its own properties; the parsed checklist steps/notes go in the page body as a to-do list, followed by the imported execution details.
- `prepare-import.mjs` reads `area-mapping.json`, `title-mapping.json`, and `step-overrides.json` to derive areas, clean titles, and checklist steps/notes from the spreadsheet.
- `round2/prepare-import.mjs` produces `test-case-runs.json` (the only Notion-bound file) plus `suite-run-tags.json`, and `round2/import-to-notion.mjs` should mainly transport those prepared values to Notion.
- When updating existing run card bodies, use `ROUND2_REPLACE_BODY=1` so old body content is replaced instead of preserved.

## Live Notion Schema

- Clean slate: the new root page is `Bloom-Tests` (`37d4bb19df128097a7f9f7f0ab9f1a2f`). `import-to-notion.mjs` creates a fresh `Test Case Runs` database under `parentPageId` when `databases.testCaseRuns` is empty, and records the created id in `notion-state.json` as `databaseId`.
- Only the `Test Case Runs` database is written. The old `Test Cases` and `Test Suite Runs` databases are left untouched and are no longer in `round2/notion-config.json`.
- In the `Test Case Runs` database:
  - `Test Suite Run` is a `select` (the closed suite-run tag list); option names cannot contain commas.
  - `OK` is a `checkbox` derived from the spreadsheet `OK?` column.
  - `Assignee`, `Build Tested`, `Issue Links`, `Past Issues`, `Case Summary`, `Legacy Number`, `Dokimion ID`, `Step Description`, `Original Description` are `rich_text`.
  - `Areas` is a `multi_select`.
  - `Priority` is a `select`; `Active`/`Historical Import` are `checkbox`; `Est. Time (min)`/`Source Row Number` are `number`; `Tested On` is `date`.
- `import-to-notion.mjs` reconciles the live `Test Case Runs` schema by default: it drops the obsolete `Test Case` relation, converts any leftover `Test Suite Run` relation into a `select`, and adds any missing required properties.

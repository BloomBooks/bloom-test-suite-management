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

- The AI-curated step overlay lives in `round2/step-overrides.json`.
- `round2/prepare-import.mjs` produces normalized JSON, and `round2/import-to-notion.mjs` should mainly transport those prepared values to Notion.
- Keep `Step Description` as the short Kanban preview field.
- Render both action steps and verification lines as unchecked Notion `to_do` blocks in the page body.
- When updating existing run card bodies, use `ROUND2_REPLACE_BODY=1` so old body content is replaced instead of preserved.

## Live Notion Schema

- In the `Test Case Runs` database, these live property types matter:
  - `Assignee` is `select`
  - `Status` is `status`
  - `Step Description` is `rich_text`
- In the `Test Suite Runs` database, do not send `Run Order`; that property does not exist live.
- For the current round2 workflow, imported run outcomes map to `Status` values `Done`, `In Progress`, and `Problems`.

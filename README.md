# Bloom Test Suite Management

Tooling around the single **`Test Case Runs`** Notion database that drives the
Bloom test board (grouped by Status, sub-grouped by Area, filtered to the
current suite run).

## Layout

- **`clone-test-suite-run/`** — the ongoing maintenance tool. After a suite run
  finishes, clones the latest run's cards into a new suite run (resetting
  status, clearing run-specific fields, unchecking the body checklist). This is
  the day-to-day entry point. _(Scaffolding; see its README.)_
- **`lib/notion.mjs`** — shared Notion plumbing: HTTP client (auth + retry),
  generic page/database operations, and the rich-text / block helpers. Both the
  clone tool and the import build on it.
- **`import/`** — the **one-and-done historical import** that populated the
  database from the Bloom test-plan spreadsheets. Frozen; kept for reference and
  in case a re-import is ever needed. See `import/schema.md` for the data model.
- **`notion-config.json`** — shared config: the parent page and the live
  database id.

## Notion access

Both tools read the integration token from the `BLOOM_TESTCASE_NOTION` (or
`NOTION_TOKEN`) environment variable.

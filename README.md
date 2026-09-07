# Bloom Test Suite Management

Tooling around the single **`Test Case Runs`** Notion database that drives the
Bloom test board (grouped by Status, sub-grouped by Area, filtered to the
current suite run).

## Run a report

The daily progress report needs the Notion token and a Chrome or Edge browser.

```sh
export BLOOM_TESTCASE_NOTION=<the integration token>

# at the end of the workday (the usual case)
node progress-report/run.mjs

# earlier in the day, before the team has tested much
node progress-report/run.mjs --ignore-today
```

The command writes `progress-report/out/progress.png`, which is the image to
upload to the Notion page. It also writes a dated copy beside it, and it opens
the image in the browser.

Add `--run <tag>` to report on a suite run that is not the newest one. For the
other options, and for what the image holds, see `progress-report/README.md`.

## Layout

- **`clone-test-suite-run/`** — the ongoing maintenance tool. After a suite run
  finishes, clones the latest run's cards into a new suite run (resetting
  status, clearing run-specific fields, unchecking the body checklist). This is
  the day-to-day entry point. _(Scaffolding; see its README.)_
- **`assign-case-id/`** — source of record for the val.town webhook val that
  assigns the next `Test Case ID` to cards created directly in Notion (a Notion
  "Page added" automation posts each new card to it; it fills blank IDs with
  live-max + 1). See its README for the wiring.
- **`progress-report/`** — the daily progress image for the current suite run:
  cards cleared, cards left, the rate the team clears them at, and the date the
  run finishes at that rate. `node progress-report/run.mjs` writes
  `out/progress.png` for the Notion page. See its README.
- **`lib/notion.mjs`** — shared Notion plumbing: HTTP client (auth + retry),
  generic page/database operations, and the rich-text / block helpers. Both the
  clone tool and the import build on it.
- **`import/`** — the **one-and-done historical import** that populated the
  database from the Bloom test-plan spreadsheets. Frozen; kept for reference and
  in case a re-import is ever needed. See `import/schema.md` for the data model.
  - **`import/one-off/`** — after-the-fact repair passes. Currently:
    `restore-column-b-links/` (July 2026), which restored the spreadsheet
    hyperlinks that the CSV export had dropped into `test-case-runs.json` and
    the live 6.4 / 6.5 cards. See its README.
- **`notion-config.json`** — shared config: the parent page and the live
  database id.

## Notion access

Both tools read the integration token from the `BLOOM_TESTCASE_NOTION` (or
`NOTION_TOKEN`) environment variable.

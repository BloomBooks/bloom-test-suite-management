# clone-test-suite-run

The ongoing maintenance tool. After a suite run is complete, this clones one
suite run's cards in the `Test Case Runs` Notion database into a **new** suite
run, so testers start the next cycle from a clean board.

## Usage

```sh
# from this folder, with the Notion token in the environment
node clone.mjs "<from-tag>" "<to-tag>" [--apply] [--force]
```

- `<from-tag>` — the existing `Test Suite Run` to copy from (e.g. `6.4`)
- `<to-tag>` — the new `Test Suite Run` to create (e.g. `6.5`)
- `--apply` — actually write to Notion. **Without it the run is a read-only dry
  run** that just reports what it would clone.
- `--force` — proceed even if `<to-tag>` already holds cards this tool did not
  create (the default refuses, to avoid duplicating an existing run).

Both tags must be given explicitly; the tool never guesses the source run. The
target database id is read from `../notion-config.json`
(`databases.testCaseRuns`), and the Notion token from `BLOOM_TESTCASE_NOTION`
(or `NOTION_TOKEN`).

Cards whose `Priority` is `Ignore` or `Duplicate` are not cloned.

## What carries over

Each property is handled in one of three ways:

| Handling | Properties |
|---|---|
| **Copy exactly** | `Test Case Run` (title), `Test Case ID`, `Summary`, `Original Description`, `Legacy Number`, `Dokimion ID`, `Import Source Row Number`, `Import Notes`, `Priority`, `Est. Time (min)`, `Areas` |
| **Copy modified** | `Test Suite Run` → the new tag · `Status` → `Not started` · `Past Issues` → prior `Past Issues` plus the prior run's `Issue Links` (BL-#### / URL refs deduped) |
| **Start blank** | `Assignee`, `Tested On`, `Build Tested`, `Issue Links` |

The page body (Test Steps / Notes) is copied faithfully, with every to-do
checkbox **unchecked** so the new run starts fresh.

## Resume / state

Each created card is recorded in `state.json` (gitignored), keyed by the source
page id and scoped to the `from`→`to` pair. Re-running with the same tags skips
cards already cloned, so an interrupted run can resume safely.

It builds on the shared Notion client in `../lib/notion.mjs` (HTTP client,
page/database operations, rich-text/block helpers).

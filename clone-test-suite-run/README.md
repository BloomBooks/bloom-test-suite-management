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
- `--limit=N` — clone at most `N` **new** cards this run (cards already cloned
  in this `from`→`to` pair don't count against it). Handy with `--apply` for a
  small smoke test before running the full suite.
- `--require-areas` — only consider cards that have at least one `Area`. A smoke
  test aid so a small `--limit` batch exercises the `Areas` copy (the source
  order leads with area-less temp-Dokimion cards).

Both tags must be given explicitly; the tool never guesses the source run. The
target database id is read from `../notion-config.json`
(`databases.testCaseRuns`), and the Notion token from `BLOOM_TESTCASE_NOTION`
(or `NOTION_TOKEN`).

Cards whose `Priority` is `Obsolete` or `Duplicate` are not cloned.

## What carries over

Each property is handled in one of three ways:

| Handling | Properties |
|---|---|
| **Copy exactly** | `Test Case Run` (title), `Test Case ID`, `Summary`, `Original Description`, `Legacy Number`, `Dokimion ID`, `Import Source Row Number`, `Priority`, `Est. Time (min)`, `Areas` |
| **Copy modified** | `Test Suite Run` → the new tag · `Status` → `Not started` · `Prior Issues` → prior `Prior Issues` plus the prior run's `Run Issues` (BL-#### / URL refs deduped) |
| **Start blank** | `Assignee`, `Tested On`, `Build Tested`, `Run Issues`, `Run Notes` |

The page body (Test Steps / Notes) is copied faithfully, with every to-do
checkbox **unchecked** so the new run starts fresh.

### `Status` writes move `Assignee` behind your back

A Notion automation on the database sets `Assignee` whenever `Status` moves: to
the person making the change for `In Progress` and `Skipped`, and to blank for
`Not started`. Over the API that "person" is the **integration**, so a script
that writes `Status` hands the card to the integration account.

For this tool the automation is harmless — it sets `Status` → `Not started` and
wants `Assignee` blank anyway, which is what the automation does. But any other
script here that moves a card to `In Progress` or `Skipped` must set `Assignee`
afterwards if the card should keep a human owner.

The automation is **asynchronous**, so one restore and one read-back is not
enough: it can fire after your restore and overwrite it, and the confirming read
you do immediately afterwards will still look correct. Re-read after a beat and
re-apply until it sticks.

## Resume / state

Each created card is recorded in `state.json` (gitignored), keyed by the source
page id and scoped to the `from`→`to` pair. Re-running with the same tags skips
cards already cloned, so an interrupted run can resume safely.

It builds on the shared Notion client in `../lib/notion.mjs` (HTTP client,
page/database operations, rich-text/block helpers).

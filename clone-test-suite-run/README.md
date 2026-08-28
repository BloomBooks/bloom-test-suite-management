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

A card is **not** cloned if either is true:

- its `Priority` is `Obsolete` or `Duplicate`, or
- its `Status` is `Retired`.

The two rules are independent and both apply. `Retired` is the status a person
sets on the board when a card is merged away or dropped, and they may not also
remember to set the priority — honouring the status is what stops a retired card
reappearing, live, in the next run. (The clone resets `Status` to `Not started`,
so a retired card that slipped through would look completely active.) Setting
both markers is still the convention.

The dry-run summary reports the split, and names any card excluded by status
alone, so a missing `Obsolete` priority is easy to spot:

```
  not carried forward: 28 (Obsolete/Duplicate: 25, Retired only: 3)
    retired without an Obsolete/Duplicate priority: #118, #121, #126
```

## What carries over

Each property is handled in one of three ways:

| Handling | Properties |
|---|---|
| **Copy exactly** | `Test Case Run` (title), `Test Case ID`, `Summary`, `Original Description`, `Legacy Number`, `Dokimion ID`, `Import Source Row Number`, `Priority`, `Est. Time (min)`, `Areas`, `Automation Notes`, `Original Feature Implementation` |
| **Copy modified** | `Test Suite Run` → the new tag · `Status` → `Not started` · `Prior Issues` → prior `Prior Issues` plus the prior run's `Run Issues` (BL-#### / URL refs deduped) |
| **Start blank** | `Assignee`, `Assignee - historical`, `Tested On`, `Build Tested`, `Run Issues`, `Run Notes` |

`Automation Notes` and `Original Feature Implementation` are judgements about
the test case itself, not results of one run, so they carry forward like
`Summary`. `Assignee - historical` is per-run — it holds the tester the import
mapped for that cycle and is empty on every card created since — so it starts
blank alongside `Assignee`.

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

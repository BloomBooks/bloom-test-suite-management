# clone-test-suite-run

The ongoing maintenance tool. After a suite run is complete, this clones one
suite run's cards in the `Test Case Runs` Notion database into a **new** suite
run, so testers start the next cycle from a clean board.

## Usage

```sh
# from this folder, with the Notion token in the environment
node clone.mjs "<from-tag>" "<to-tag>" [--apply] [--force]
```

- `<from-tag>` — the existing `Test Suite Run` to copy from (e.g. `6.5`)
- `<to-tag>` — the new `Test Suite Run` to create (e.g. `6.6`)
- `--apply` — actually write to Notion. **Without it the run is a read-only dry
  run** that reports what it would clone and checks the links between cards.
- `--force` — proceed even if a card already in `<to-tag>` (one this tool did
  not create) has the `Test Case ID` of a card about to be cloned. Without it
  the tool lists those collisions and refuses. Other cards already in
  `<to-tag>` — new cases written straight into the new run — don't block it.
- `--limit=N` — clone at most `N` **new** cards this run (cards already cloned
  in this `from`→`to` pair don't count against it). Handy with `--apply` for a
  small smoke test before running the full suite.
- `--only=N,M` — clone only the cards with these `Test Case ID`s. A smoke test
  aimed at particular cards (e.g. ones with images, nested steps, links).
- `--concurrency=N` — copy `N` cards at once (default 4). Each copy spends most
  of its time waiting for Notion, so this is what keeps a full run to a
  reasonable length.
- `--require-areas` — only consider cards that have at least one `Area`. A smoke
  test aid so a small `--limit` batch exercises the `Areas` copy.

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

It also warns about any card with automation (a non-blank `Automation` or any
`Automation Notes`) that won't be carried forward, since dropping one usually
means its automated test is no longer recorded anywhere.

## How a card is copied

The API has no "duplicate page" call, but an existing page can have any other
page applied to it as a template, which copies that page's properties and whole
body — images, files, callouts, columns, nested steps — the way the web UI's
Duplicate does. So for each card the tool:

1. creates the new card with just its title, `Test Case ID` and new tag (the ID
   is set up front so the val.town webhook, which numbers any card created with
   a blank ID, never sees it blank);
2. applies the source card to it as a template, and waits until the body is
   there;
3. overwrites every property with the policy below, since the template copied
   the old run's values;
4. unticks every to-do checkbox, at every depth;
5. re-reads the properties until the reset has held twice, 10 seconds apart.

The template is applied in the background, and its timing varies a lot: about
40 seconds in one test, about five minutes in another. It is **never applied
twice** to one page — a slow first copy would then land as a second body — so
the wait for it is long (10 minutes), and `state.json` records which pages have
had it applied. Step 5 exists because the template's copy of the properties,
and automations it sets off, can land after the reset: in testing the template
brought back the old `Tested On` / `Build Tested`, and on other cards `Tested On`
came back as the current date (probably an automation reacting to the
template's momentary `Status` of `Done`; not confirmed).

**Page comments are not copied**, by the template or by the tool. They are
treated as belonging to the run they were made in. Anything in a comment that
describes the test case itself should be moved into the card body's Notes
before cloning, or it stays behind in the old run.

## What carries over

| Handling | Properties |
|---|---|
| **Copy exactly** | `Test Case Run` (title), `Test Case ID`, `Summary`, `Original Description`, `Legacy Number`, `Dokimion ID`, `Import Source Row Number`, `Priority`, `Est. Time (min)`, `Areas`, `Automation`, `Automation Notes`, `Original Feature Implementation` |
| **Copy modified** | `Test Suite Run` → the new tag · `Status` → `Not started` · `Prior Issues` → prior `Prior Issues` plus the prior run's `Run Issues` (BL-#### / URL refs deduped) · `Related Cases` → re-pointed at the new run's cards |
| **Start blank** | `Assignee`, `Assignee - historical`, `Tested On`, `Build Tested`, `Run Issues`, `Run Notes` |

`Automation`, `Automation Notes` and `Original Feature Implementation` are
judgements about the test case itself, not results of one run, so they carry
forward like `Summary`. Cards with automation start the new run as
`Not started` like every other card. `Assignee - historical` is per-run — it
holds the tester the import mapped for that cycle and is empty on every card
created since — so it starts blank alongside `Assignee`.

The page body is copied whole, with every to-do checkbox **unchecked** so the
new run starts fresh.

## Links between cards

Cards link to each other through the `Related Cases` relation and through links
in the body (text links and page mentions, e.g. "covered by
Talking Book Basics (#813)"). Copied as-is these would still point at the old
run, so after all the cards are copied a second pass re-points every such link
at the new run's card with the same `Test Case ID`. It covers cards already in
`<to-tag>` that the tool did not create too, since new cases written straight
into the new run often link back to the old one.

A `Related Cases` link shows on both cards, so re-pointing it on a new-run card
also removes it from the old card at the other end. In the 6.5 → 6.6 run that
removed the 6.5 #441's link to the 6.6 #829 (a cross-run link, now between
6.6 #441 and 6.6 #829); links within the old run are untouched.

A link whose target is not carried forward (Retired, Obsolete or Duplicate) is
left pointing at the old card and listed in the output, dry run included, and
on the new card the text `[6.5 card] ` (the target's suite run) is put in front
of it, so a reader knows following it leaves the current run. That is right for
history links ("Merged in September 2026 from …"). Any other such link should be
fixed in the old run before cloning: point it at the card that absorbed the
retired one, or remove it.

## `Status` writes move `Assignee` behind your back

A Notion automation on the database sets `Assignee` whenever `Status` moves: to
the person making the change for `In Progress` and `Skipped`, and to blank for
`Not started`. Over the API that "person" is the **integration**, so a script
that writes `Status` hands the card to the integration account. A move to
`Retired` over the API does **not** change `Assignee` (checked on nine cards in
October 2026).

For this tool the automation is harmless — it sets `Status` → `Not started` and
wants `Assignee` blank anyway, which is what the automation does. But any other
script here that moves a card to `In Progress` or `Skipped` must set `Assignee`
afterwards if the card should keep a human owner.

The automation is **asynchronous**, so one restore and one read-back is not
enough: it can fire after your restore and overwrite it, and the confirming read
you do immediately afterwards will still look correct. Re-read after a beat and
re-apply until it sticks.

## Resume / state

Each card is recorded in `state.json` (gitignored), keyed by the source page id
and scoped to the `from`→`to` pair, as soon as its copy is created — before the
template is applied. The file also records which copies have had the template
applied and which are finished. Re-running with the same tags finishes any
copy left half-done, skips finished ones, and never applies a template twice,
so an interrupted run can resume safely. A card that fails is listed at the end
(the others carry on) and is retried on the next run.

It builds on the shared Notion client in `../lib/notion.mjs` (HTTP client,
page/database operations, rich-text/block helpers).

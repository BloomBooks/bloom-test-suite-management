# progress-report

Makes a one-page PNG that shows how a test suite run is going: how many cards
are cleared, how many are left, how fast the team clears them, and the date the
run finishes at that pace. Made to be run once a day and dropped onto the
`Bloom-Tests` Notion page.

## Usage

```sh
# at the end of the workday (the usual case)
node progress-report/run.mjs --eod

# at the start of the workday, before anyone has tested
node progress-report/run.mjs
```

The image lands in two places:

- `out/progress.png` — always the newest. This is the one to upload.
- `out/progress-<run>-<date>.png` — a dated copy, so the history is kept.

### Options

- `--eod` — count today in the rate. Use this at the end of the workday, when
  today is complete. Without it, today is left out, because a part day at full
  weight drags the rate down.
- `--as-of YYYY-MM-DD` — build the report as it stood at the end of that day:
  cards cleared after it count as still open, and the day itself counts in the
  rate (as `--eod` does). For a day that was missed. The dated PNG takes that
  date. Uses today's data, so a card cleared since is placed on the day it
  actually cleared, not hidden.
- `--run <tag>` — report on a named suite run. The default is the newest one in
  the database.
- `--half-life <n>` — how fast old days lose weight. The default is 2 working
  days. Use 1 to follow the last two days almost alone; use 3 to smooth more.
- `--no-fetch` — skip the Notion call and reuse `data/cards.json`. Use this
  while you change the layout.
- `--open` — open the PNG when it is written.

`BLOOM_TESTCASE_NOTION` (or `NOTION_TOKEN`) must hold the Notion integration
token. Chrome or Edge draws the page; set `CHROME` if neither is in the usual
place.

## What the image holds

1. Five numbers: cards in the run, cards cleared, cards left, the rate, and the
   finish date.
2. A burn-down line, one point per working day, with a dashed projection to zero.
3. A stacked bar per working day: Done, Skipped and Retired. Each bar is faded
   in proportion to its weight in the rate, and the weight is printed below it.
4. The remaining cards, split by priority.

Weekends are excluded everywhere, in the history and in the projection.

## How the rate is worked out

The rate is an exponentially weighted mean of the cards cleared each working
day. A day of age `a` working days gets a weight of `0.5 ^ (a / half-life)`, so
each day counts half as much as the day two working days after it. A pass starts
with two or three testers and reaches full strength days later, so a plain
average predicts a finish that is too far out. Nothing in the calculation is a
fixed date, so the same command stays correct on every later day and on the next
suite run.

The start of the pass is found from the data, not set by hand: the tool walks
back from the newest cleared card and stops at a stretch of five working days
with nothing cleared, which is where the previous pass ended.

## What counts as cleared

A card is cleared when it reaches `Done`, `Skipped` or `Retired`.

- `Done` carries a real date in the `Tested On` property.
- `Skipped` and `Retired` have no date property, so the last edit to the card
  stands in for it. A later edit to such a card moves it to a different day.

`Retired` counts as progress, in its own colour. A retired card leaves the
suite, so it is real work removed. Watch the colour: a day that is mostly green
is cleanup, not testing.

## The steps

`run.mjs` calls these in order. Run one on its own to work on it alone.

1. `fetch-data.mjs` — one pass over the Notion database, into `data/cards.json`.
2. `build-report.mjs` — the statistics, into `data/model.json`.
3. `render.mjs` — the page, into `report.html`.
4. Chrome, headless, writes the PNG.

`data/`, `out/` and `report.html` are generated, and git ignores them.

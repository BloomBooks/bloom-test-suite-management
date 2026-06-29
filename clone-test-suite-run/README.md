# clone-test-suite-run

The ongoing maintenance tool. After a suite run is complete, this clones the
most recent run's cards in the `Test Case Runs` Notion database into a new
suite run, so testers start the next cycle from a clean board.

**Not yet implemented** — this folder is the planned home for the tool. Intended
behavior (per the agreed workflow):

1. Read the target database id from `../notion-config.json`
   (`databases.testCaseRuns`).
2. Find the **most recent** `Test Suite Run` tag (newest version) and enumerate
   its cards.
3. For each card, create a copy under a **new** `Test Suite Run` tag, carrying
   over the durable test-case definition (title/Summary, Areas, Dokimion ID,
   Priority, Est. Time, Original Description, and the page-body Test Steps),
   **but**:
   - `Status` reset to `Not started`,
   - run-specific fields cleared: `Assignee`, `Tested On`, `Build Tested`,
     `Issue Links`,
   - page-body to-do checkboxes unchecked.

It builds on the shared Notion client in `../lib/notion.mjs` (HTTP client,
page/database operations, rich-text/block helpers). Runtime state, if any, is
written to `state.json` here (gitignored).

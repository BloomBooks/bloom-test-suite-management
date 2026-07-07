# One-off: restore column-B hyperlinks (July 2026)

The "Pre-beta tests" sheet of the Bloom Test Plan spreadsheet
(`1rNi4ZktTWGcbTm3g3iD-07Z_BoEp2r3jooQ9D5VYGlo`) carried hyperlinks on text
runs in column B (the test description). The CSV export the import was built
from kept only the display text, so those URLs never made it into
`test-case-runs.json` or the Notion cards. This one-off put them back.

## What was done

1. The sheet was exported as HTML (File > Download > Web Page), which preserves
   every anchor. `extract-links.mjs` parsed it into `colB-links.json`: 70 rows
   had links in column B.
2. `restore-links.mjs` processed them:
   - **Skipped as already covered (35 rows):** links whose URL is recoverable
     from the visible text — a `BL-####` anchor pointing at that issue's
     standard YouTrack URL, or an anchor that is the bare URL itself. The
     importer's `linkifyRichText()` already renders those clickable.
   - **Restored (28 rows, 36 links incl. the pilot):**
     - `import/output/test-case-runs.json` — every run record of the case got
       the URL in parens after the anchor text (`VM notes (https://...)`) in
       `originalDescription` / `description` / `caseSnapshot`, and in the
       checklist item corresponding to the linked occurrence. Where no item
       mentioned the anchor, a `See <anchor> (<url>).` note was appended to
       `stepNotes` / `bodyChecklistItems`.
     - **Notion, 6.4 and 6.5 cards only** — the `Original Description`
       property was rewritten with the anchor text as a real link, and the
       matching body to-do was re-rendered with the anchor linked (checked
       state untouched). Older suite-run cards (6.3 and back) were left alone.
   - **Flagged, not changed:** ambiguities recorded in `report.json`
     (`flagged`) for manual evaluation — rows that were never imported as test
     cases (sheet header/context rows), and anchors that could not be
     unambiguously matched to a checklist item.
3. The pilot case was legacy 2005 ("Install with Feedback Off"), done by hand
   first; `restore-links.mjs` skips row 8 for that reason.

## Files

- `extract-links.mjs` — HTML-export parser (needs the export file as argument;
  the export itself is not kept in the repo).
- `colB-links.json` — every column-B link: row number, cell text, anchor
  text/href/offsets.
- `restore-links.mjs` — the restore pass described above. `--dry-run`
  previews. Re-running is safe: already-restored rows are detected and
  skipped/flagged.
- `report.json` — what the last run changed, skipped as covered, and flagged.

This was a one-time repair; the import pipeline itself was intentionally not
changed. If the import is ever re-run from a fresh CSV, the links will be lost
again unless this pass (or an HTML-aware import) is repeated.

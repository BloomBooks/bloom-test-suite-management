# Manual Steps After a Notion Import

Most of the database setup is applied automatically by `round2/import-to-notion.mjs`
when the `Test Case Runs` database is created (property schema, `Priority`/`Status`
option colors, and hiding the plumbing columns on the default **table view**).

A few things the Notion API does **not** expose, so they must be done by hand in
the Notion UI after creating (or recreating) the database.

## 1. Hide plumbing properties on the opened-card view

The importer hides these on the table view, but the Notion API has no control over
which properties show when you **open a card** as a page. Hide them manually:

- `Import Run ID`
- `Source Row Number`
- `Test Case ID`
- `Legacy Number`
- `Dokimion ID`

**How:** open any card in the database, hover the properties area, and use Notion's
property-visibility control to hide each of the above. They collapse under a single
"N hidden properties" toggle. The setting applies to **all** cards in the database.

> This must be redone whenever the database is deleted and recreated — it is a
> UI-only setting and cannot be scripted.

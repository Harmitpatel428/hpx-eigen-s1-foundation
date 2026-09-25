# API Changelog

## 2026-09-25

### Leads — notes moved off the lead payload
- **`PATCH`/`PUT /api/v1/leads/:id` no longer accepts `notes`.** The field was silently ignored after
  the notes single-source-of-truth change; it is now removed from the update contract
  (`UpdateLeadInput` + route body type). Note writes go to the notes endpoints
  (`/api/v1/leads/:id/notes`). The legacy `Lead.notes` column is no longer written by lead updates.
- **`POST /api/v1/leads`** still accepts `notes` — an initial "first note" that is created as a real
  `leadNote` row atomically with the lead (not written to `Lead.notes`).
- **`POST /api/v1/leads/import`**: notes ≤500 chars become `leadNote` rows; oversize (>500) notes are
  preserved verbatim in the legacy `Lead.notes` column for manual review; re-import no longer
  overwrites notes.

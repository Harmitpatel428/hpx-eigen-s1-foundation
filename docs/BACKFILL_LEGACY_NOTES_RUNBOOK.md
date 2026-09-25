# Runbook — Legacy `Lead.notes` → `leadNote` backfill

**Status: PREPARED, NOT RUN in prod.** `--apply` is off by default. A production run happens only
after a replica dry-run whose numbers are reviewed and **approved in writing** by the owner.

Script: `scripts/backfill-legacy-notes.ts` · Migrations: `20260924000000_add_leadnote_source`,
`20260925000000_leadnote_legacy_backfill_unique` · Tag: `source='legacy_backfill'`.

## What it does
For each lead with non-empty `Lead.notes` and **no live** `leadNote` rows, inserts ONE `leadNote`
(content = legacy text, `source='legacy_backfill'`, `authorId=NIL_UUID` → renders "Migrated",
`createdAt = lead.updatedAt`). Skips and lists for manual review: legacy+live-rows, oversize (>500,
never truncated). `Lead.notes` is **not** nulled or dropped. Idempotent by procedural check **and**
a partial unique index — a second/concurrent insert fails with P2002.

> Deviation from §5 "≈500 leads/txn": the script uses **one transaction per lead** (small locks,
> resumable, each insert independently idempotent). At the observed data scale (dev: 11) this is
> safer than large batches; revisit only if a replica dry-run shows tens of thousands of legacy-only
> leads.

## Step 1 — DDL (both environments, via CI)
Apply migrations with the migration role (DDL), never ad hoc:
```bash
npx prisma migrate deploy
```
Adds `LeadNote.source` and the partial unique index. Non-destructive (guarded by
`scripts/check-destructive-migrations.cjs`).

## Step 2 — Replica dry-run
Restore latest prod backup to a replica, point `DATABASE_URL` at it, then:
```bash
npx tsx scripts/backfill-legacy-notes.ts            # dry-run, no writes
# optional phased scope: --tenant <tenantId>
```
Expected shape (example — dev numbers 2026-09-25):
```
Buckets:
  legacy-only (WILL migrate)        : 11
  legacy-only >500 chars (SKIP)     : 0
  legacy + live rows (SKIP, review) : 1
  already-backfilled (SKIP)         : 0
  whitespace-only legacy (SKIP)     : 0
  rows-only, no legacy (info)       : 3
  legacy leads updated in last 90d   : 12  (estimate — updatedAt proxy, not note-specific)

── MANUAL REVIEW (skipped, not migrated) ──
  legacy + live rows (1): <leadId…>
  oversize >500 chars (N): <leadId…>
```
Save the full output. The manual-review lists (legacy+live, oversize) are the leads a human must
reconcile by hand — they are never auto-migrated.

## Step 3 — APPROVAL CHECKPOINT (blocking)
Send the replica dry-run output to the owner. **Do not proceed without written approval of the
numbers.** If the legacy-only bucket is negligible and the owner confirms, drop the backfill and
keep only the write-path unification (already shipped); record that decision here.

## Step 4 — Replica rollback drill (prove reversibility before prod)
On the replica, with approval to test:
```bash
npx tsx scripts/backfill-legacy-notes.ts --apply     # migrates legacy-only
npx tsx scripts/backfill-legacy-notes.ts             # re-dry-run: legacy-only == 0, already-backfilled == prior legacy-only
psql "$DATABASE_URL" -c "DELETE FROM \"LeadNote\" WHERE source='legacy_backfill';"
npx tsx scripts/backfill-legacy-notes.ts             # legacy-only back to the original count
```
Pass = counts restore exactly and the second `--apply` (if repeated) inserts 0.

## Step 5 — Production run (only after Step 3 approval)
1. Fresh backup (`npm run db:backup`) and confirm it restores.
2. DDL already deployed via CI (Step 1).
3. Run `--apply` under a **least-privilege DML role** — `SELECT` on `Lead`/`LeadNote` and `INSERT`
   on `LeadNote` only; **no** UPDATE/DELETE/DDL. (Rollback DELETE, if ever needed, is a separate
   elevated, logged action.)
   ```bash
   DATABASE_URL=<prod, dml-role> npx tsx scripts/backfill-legacy-notes.ts --apply | tee backfill-$(date +%Y%m%dT%H%M%S).log
   ```
   The script logs the migrated row count and the manual-review IDs; keep the log with the operator
   and timestamp.
4. Post-run verification (expect **0**):
   ```sql
   SELECT count(*) FROM "Lead" l
   WHERE l.notes IS NOT NULL AND btrim(l.notes) <> ''
     AND length(btrim(l.notes)) <= 500
     AND l."deletedAt" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "LeadNote" n WHERE n."leadId" = l.id AND n."deletedAt" IS NULL
     );
   ```
   0 = every legacy-only (≤500) lead now has a live note. Oversize (>500) and legacy+live are
   excluded by design — reconcile them from the manual-review lists.

## Rollback (prod)
```sql
DELETE FROM "LeadNote" WHERE source='legacy_backfill';
```
Removes only backfilled rows; user notes (`source='user'`) and `Lead.notes` are untouched. Re-run
the dry-run afterward to confirm counts return to pre-backfill state.

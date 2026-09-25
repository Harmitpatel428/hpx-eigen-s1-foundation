# Legacy-notes backfill — approval package

Single sign-off doc for the gated production backfill. **PROD `--apply` is forbidden until a written
approval cites this package.** Reviewer approves the *replica* numbers (Section B), not the dev ones.

- Procedure & rollback: [`BACKFILL_LEGACY_NOTES_RUNBOOK.md`](./BACKFILL_LEGACY_NOTES_RUNBOOK.md)
- Script: `scripts/backfill-legacy-notes.ts` (dry-run default; `--apply`; `--tenant`)
- Rollback: `DELETE FROM "LeadNote" WHERE source='legacy_backfill';`

## A. Dev rehearsal (mechanics proof — NOT prod)
> Deviation: no prod-replica access from the working environment. The drill below ran against local dev
> (`hpx_eigen_dev`) to prove the script + rollback mechanics. It is **not** an approval input.

Rollback drill (2026-09-25), full log in the session scratchpad `drill.log`:
```
1. DRY-RUN (pre)          legacy-only=11  already-backfilled=0   (manual-review: 1 legacy+live)
2. APPLY                  Migrated 11
3. DRY-RUN (post-apply)   legacy-only=0   already-backfilled=11
4. ROLLBACK               DELETE WHERE source='legacy_backfill'  → OK
5. DRY-RUN (post-rollback) legacy-only=11  already-backfilled=0   (counts restored exactly)
```
Result: apply → counts move as expected; rollback → counts restore exactly; dev left clean. ✅

## B. Production replica run (operator fills in — REQUIRED for approval)
Restore latest prod backup to a replica, point `DATABASE_URL` at it, then:
```bash
npx prisma migrate deploy                              # DDL: source column + partial unique index
npx tsx scripts/backfill-legacy-notes.ts | tee replica-dryrun.log
```
Paste the replica output here:
```
legacy-only (WILL migrate)        : ___
legacy-only >500 chars (SKIP)     : ___
legacy + live rows (SKIP, review) : ___
already-backfilled (SKIP)         : ___
whitespace-only legacy (SKIP)     : ___
rows-only, no legacy (info)       : ___
legacy leads updated in last 90d  : ___   (estimate — updatedAt proxy)
MANUAL REVIEW lead ids (legacy+live): ___
MANUAL REVIEW lead ids (oversize)   : ___
```
Then run the same 5-step rollback drill (Section A) on the replica and confirm counts restore.

## C. Verification query (run after a real `--apply`; expect 0)
```sql
SELECT count(*) FROM "Lead" l
WHERE l.notes IS NOT NULL AND btrim(l.notes) <> ''
  AND length(btrim(l.notes)) <= 500
  AND l."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "LeadNote" n WHERE n."leadId" = l.id AND n."deletedAt" IS NULL);
```

## D. Approval
- [ ] Replica dry-run numbers reviewed (Section B)
- [ ] Manual-review lists (legacy+live, oversize) triaged
- [ ] Replica rollback drill passed
- [ ] Approver / date: ______________________

Only after all four: run `--apply` in prod under a least-privilege DML role per the runbook.

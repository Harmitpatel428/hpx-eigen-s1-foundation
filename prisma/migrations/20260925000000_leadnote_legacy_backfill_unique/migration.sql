-- F2/P3: structural idempotency guard for the legacy backfill. At most ONE live backfilled note per
-- lead — a partial unique index enforces what the script's procedural live-row check does, so a
-- concurrent/duplicate backfill insert fails with a unique violation instead of double-migrating.
-- Scoped to live rows (deletedAt IS NULL) so a manually-deleted migrated note can be re-backfilled.
-- Non-destructive: adds one index. Partial indexes are not expressible in schema.prisma (Prisma 5),
-- so this lives as a raw migration by design.
CREATE UNIQUE INDEX "LeadNote_leadId_legacy_backfill_live_key"
  ON "LeadNote" ("leadId")
  WHERE "source" = 'legacy_backfill' AND "deletedAt" IS NULL;

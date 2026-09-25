/**
 * Backfill legacy Lead.notes free-text into the leadNote table (F2).
 *
 * Dry-run by default; pass --apply to write. Prod only after a replica dry-run + explicit approval.
 *
 * What it does (only to the "legacy-only" bucket):
 *   for each lead where Lead.notes is non-empty (after trim) AND has NO live leadNote rows,
 *   insert ONE leadNote row: content = legacy text, source = 'legacy_backfill',
 *   authorId = NIL_UUID (system/migrated), createdAt = lead.updatedAt (documented choice:
 *   the legacy note's last-known write time is the closest signal we have to when it was authored).
 *
 * Constraints honoured:
 *   (a) Reports four buckets + a 90-day recent-legacy-write signal. legacy+live leads are SKIPPED
 *       and listed for manual review, never auto-merged.
 *   (b) Backfilled rows are tagged source='legacy_backfill' for a reversible rollback. Lead.notes is
 *       NOT nulled or dropped here.
 *   (c) No silent truncation: leadNote.content is VARCHAR(500). Legacy notes >500 chars are SKIPPED
 *       into their own bucket for manual handling — never truncated.
 *   Idempotent: a re-run finds the backfilled row (now a live row) and re-classifies the lead as
 *       already-backfilled, so it inserts 0. A per-lead transaction re-checks live-row count before
 *       inserting, making it race-safe.
 *
 * Rollback: DELETE FROM "LeadNote" WHERE source = 'legacy_backfill';
 */
import { PrismaClient } from '@prisma/client';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_LEN = 500;

export interface BackfillSummary {
  legacyOnly: number;      // migratable (and migrated when apply=true)
  legacyOnlyOversize: number;
  legacyPlusLive: number;
  alreadyBackfilled: number;
  whitespaceOnly: number;
  rowsOnly: number;
  recentLegacy90d: number;
  migrated: number;        // rows actually inserted (0 unless apply=true)
  manualReviewIds: string[];
  oversizeIds: string[];
}

function nonEmpty(s: string | null | undefined): boolean {
  return !!s && s.trim().length > 0;
}

/** Core backfill logic. Pure of process/CLI concerns so it can be unit-tested against a DB.
 *  `tenantId` optionally scopes the run to one tenant (phased prod rollout + deterministic tests). */
export async function runBackfill(prisma: PrismaClient, opts: { apply: boolean; tenantId?: string }): Promise<BackfillSummary> {
  const APPLY = opts.apply;
  const tenantScope = opts.tenantId ? { tenantId: opts.tenantId } : {};

  // Leads that carry legacy free-text.
  const legacyLeads = await prisma.lead.findMany({
    where: { notes: { not: null }, ...tenantScope },
    select: { id: true, tenantId: true, notes: true, updatedAt: true },
  });

  // Live (non-deleted) note rows grouped by lead, split by provenance.
  const liveNotes = await prisma.leadNote.findMany({
    where: { deletedAt: null, ...tenantScope },
    select: { leadId: true, source: true },
  });
  const live = new Map<string, { total: number; nonBackfill: number }>();
  for (const n of liveNotes) {
    const e = live.get(n.leadId) ?? { total: 0, nonBackfill: 0 };
    e.total += 1;
    if (n.source !== 'legacy_backfill') e.nonBackfill += 1;
    live.set(n.leadId, e);
  }

  const buckets = {
    legacyOnly: [] as typeof legacyLeads,        // migrate
    legacyOnlyOversize: [] as typeof legacyLeads, // skip: >500 chars, manual
    legacyPlusLive: [] as typeof legacyLeads,     // skip: real notes exist, manual review
    alreadyBackfilled: [] as typeof legacyLeads,  // skip: only backfilled rows present (idempotent)
    whitespaceOnly: [] as typeof legacyLeads,     // skip: notes column had only whitespace
  };

  for (const lead of legacyLeads) {
    if (!nonEmpty(lead.notes)) { buckets.whitespaceOnly.push(lead); continue; }
    const l = live.get(lead.id);
    if (!l || l.total === 0) {
      if ((lead.notes as string).trim().length > MAX_LEN) buckets.legacyOnlyOversize.push(lead);
      else buckets.legacyOnly.push(lead);
    } else if (l.nonBackfill > 0) {
      buckets.legacyPlusLive.push(lead);
    } else {
      buckets.alreadyBackfilled.push(lead);
    }
  }

  // rows-only: leads that have live notes but no legacy free-text (informational).
  const legacyIds = new Set(legacyLeads.map((l) => l.id));
  let rowsOnly = 0;
  for (const leadId of live.keys()) if (!legacyIds.has(leadId)) rowsOnly += 1;

  // 90-day recent legacy writes: signal of how actively the legacy field is still used.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentLegacy = legacyLeads.filter((l) => nonEmpty(l.notes) && l.updatedAt >= cutoff);

  let migrated = 0;
  if (APPLY) {
    for (const lead of buckets.legacyOnly) {
      const content = (lead.notes as string).trim();
      await prisma.$transaction(async (tx) => {
        // Race/idempotency guard: only insert if still no live rows for this lead.
        const existing = await tx.leadNote.count({ where: { leadId: lead.id, deletedAt: null } });
        if (existing > 0) return;
        await tx.leadNote.create({
          data: {
            tenantId: lead.tenantId,
            leadId: lead.id,
            authorId: NIL_UUID,
            content,
            source: 'legacy_backfill',
            createdAt: lead.updatedAt,
          },
        });
        migrated += 1;
      });
    }
  }

  return {
    legacyOnly: buckets.legacyOnly.length,
    legacyOnlyOversize: buckets.legacyOnlyOversize.length,
    legacyPlusLive: buckets.legacyPlusLive.length,
    alreadyBackfilled: buckets.alreadyBackfilled.length,
    whitespaceOnly: buckets.whitespaceOnly.length,
    rowsOnly,
    recentLegacy90d: recentLegacy.length,
    migrated,
    manualReviewIds: buckets.legacyPlusLive.map((l) => l.id),
    oversizeIds: buckets.legacyOnlyOversize.map((l) => l.id),
  };
}

/** CLI wrapper: dry-run by default, --apply to write. */
async function main() {
  const apply = process.argv.includes('--apply');
  const tIdx = process.argv.indexOf('--tenant');
  const tenantId = tIdx >= 0 ? process.argv[tIdx + 1] : undefined;
  const prisma = new PrismaClient();
  console.log(`\n=== Legacy notes backfill — ${apply ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}${tenantId ? ` — tenant ${tenantId}` : ''} ===\n`);
  try {
    const s = await runBackfill(prisma, { apply, tenantId });
    console.log('Buckets:');
    console.log(`  legacy-only (${apply ? 'migrated' : 'WILL migrate'})        : ${s.legacyOnly}`);
    console.log(`  legacy-only >500 chars (SKIP)     : ${s.legacyOnlyOversize}`);
    console.log(`  legacy + live rows (SKIP, review) : ${s.legacyPlusLive}`);
    console.log(`  already-backfilled (SKIP)         : ${s.alreadyBackfilled}`);
    console.log(`  whitespace-only legacy (SKIP)     : ${s.whitespaceOnly}`);
    console.log(`  rows-only, no legacy (info)       : ${s.rowsOnly}`);
    // P7: this is an ESTIMATE. Lead.updatedAt changes on ANY lead edit, not just notes, so it
    // over-counts. It is a rough signal of how actively the legacy field is still touched, nothing more.
    console.log(`  legacy leads updated in last 90d   : ${s.recentLegacy90d}  (estimate — updatedAt proxy, not note-specific)`);

    // P4: one MANUAL REVIEW section listing lead IDs for BOTH skipped-with-data buckets.
    const fmt = (ids: string[]) => ids.slice(0, 50).join(', ') + (ids.length > 50 ? ` … (+${ids.length - 50})` : '');
    if (s.manualReviewIds.length || s.oversizeIds.length) {
      console.log('\n── MANUAL REVIEW (skipped, not migrated) ──');
      if (s.manualReviewIds.length) console.log(`  legacy + live rows (${s.manualReviewIds.length}): ${fmt(s.manualReviewIds)}`);
      if (s.oversizeIds.length) console.log(`  oversize >500 chars (${s.oversizeIds.length}): ${fmt(s.oversizeIds)}`);
    }
    if (apply) console.log(`\nApplied. Migrated ${s.migrated} lead(s). Rollback: DELETE FROM "LeadNote" WHERE source='legacy_backfill';\n`);
    else console.log(`\nDry-run only. Re-run with --apply to migrate the ${s.legacyOnly} legacy-only lead(s).\n`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Run as CLI only when invoked directly (not when imported by tests).
if (require.main === module) main();

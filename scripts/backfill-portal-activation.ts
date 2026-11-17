/**
 * Backfill client-portal activation for cases handed off BEFORE handoff-time activation existed.
 *
 * Those cases have a phone snapshot but portalEnabledAt = null (it used to be set only by the first
 * client-visible publish), so the client's verify is rejected with internalReason=portal_not_accessible.
 *
 * Activates a case only when ALL hold — the same invariants as PortalService.enablePortalInTx:
 *   not soft-deleted · portalEnabledAt IS NULL · portalPhoneLast4 present · status not CLOSED/CANCELLED
 *
 * Never touched (reported for ops instead):
 *   - handed-off open cases with NO phone snapshot → re-run handoff / approve a contact change
 *   - closed / cancelled cases → rejection is correct
 *
 * Dry-run by default. Writing needs BOTH --apply AND NODE_ENV=production.
 * Idempotent: each row is activated in its own transaction that re-checks every invariant, so a
 * re-run (or a row that closed / was activated since the scan) writes nothing.
 * Each activation appends a PORTAL_AUTO_ACTIVATED audit row with payload.activationType = "BACKFILL".
 *
 * Dry-run: npx tsx scripts/backfill-portal-activation.ts [--tenant <tenantId>]
 * Apply:   NODE_ENV=production npx tsx scripts/backfill-portal-activation.ts --apply [--tenant <tenantId>]
 *
 * Rollback: the audit rows with activationType "BACKFILL" name exactly the cases this script activated.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PORTAL_CLOSED_STATUSES } from '../src/domain/portal';
import { AuditService } from '../src/services/audit.service';

export interface PortalBackfillSummary {
  eligible: number;        // open + phone snapshot + not yet enabled (activated when apply=true)
  activated: number;       // rows actually written (0 unless apply=true)
  skippedNoPhone: number;  // handed-off, open, not enabled, NO phone snapshot — needs ops
  skippedClosed: number;   // closed/cancelled, not enabled — correct as-is
  caseNumbers: string[];   // the eligible cases, for the operator's review
}

/** Core logic, free of CLI/env concerns so it can be tested against a DB. `tenantId` scopes a phased run. */
export async function runBackfill(
  prisma: PrismaClient,
  opts: { apply: boolean; tenantId?: string },
): Promise<PortalBackfillSummary> {
  const notEnabled = { deletedAt: null, portalEnabledAt: null, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) };
  const eligibleWhere = {
    ...notEnabled,
    portalPhoneLast4: { not: null },
    status: { notIn: PORTAL_CLOSED_STATUSES },
  };

  const [rows, skippedNoPhone, skippedClosed] = await Promise.all([
    prisma.docCase.findMany({ where: eligibleWhere, select: { id: true, tenantId: true, caseNumber: true } }),
    prisma.docCase.count({
      where: { ...notEnabled, caseNumber: { not: null }, portalPhoneLast4: null, status: { notIn: PORTAL_CLOSED_STATUSES } },
    }),
    prisma.docCase.count({ where: { ...notEnabled, status: { in: PORTAL_CLOSED_STATUSES } } }),
  ]);

  let activated = 0;
  if (opts.apply) {
    const audit = new AuditService(prisma);
    const now = new Date();
    for (const row of rows) {
      await prisma.$transaction(async tx => {
        // Re-check every invariant atomically: a row closed or activated since the scan is skipped.
        const { count } = await tx.docCase.updateMany({
          where: { ...eligibleWhere, id: row.id },
          data: { portalEnabledAt: now },
        });
        if (count !== 1) return;
        await audit.appendInTx(tx, {
          tenantId: row.tenantId,
          eventType: 'PORTAL_AUTO_ACTIVATED',
          entityType: 'DocCase',
          entityId: row.id,
          operation: 'UPDATE',
          payload: { caseId: row.id, activationType: 'BACKFILL' },
        });
        activated += 1;
      }, { maxWait: 5000, timeout: 15000 });
    }
  }

  return {
    eligible: rows.length,
    activated,
    skippedNoPhone,
    skippedClosed,
    caseNumbers: rows.map(r => r.caseNumber ?? `(no case number: ${r.id})`),
  };
}

/** CLI wrapper: dry-run by default; --apply additionally requires NODE_ENV=production. */
async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.NODE_ENV !== 'production')
    throw new Error('Refusing --apply: NODE_ENV must be "production". Omit --apply for a dry-run.');
  const tIdx = process.argv.indexOf('--tenant');
  const tenantId = tIdx >= 0 ? process.argv[tIdx + 1] : undefined;

  // Show WHICH database this is about to read/write (host + db name only, never credentials).
  const db = new URL(process.env.DATABASE_URL ?? '');
  console.log(`\n=== Portal activation backfill — ${apply ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} ===`);
  console.log(`Target: ${db.hostname}${db.pathname}${tenantId ? ` — tenant ${tenantId}` : ' — all tenants'}\n`);

  const prisma = new PrismaClient();
  try {
    const s = await runBackfill(prisma, { apply, tenantId });
    console.log(`  eligible (${apply ? 'activated' : 'WILL activate'})              : ${apply ? s.activated : s.eligible}`);
    console.log(`  handed-off, open, NO phone (SKIP, ops) : ${s.skippedNoPhone}`);
    console.log(`  closed / cancelled (SKIP, correct)     : ${s.skippedClosed}`);
    if (s.caseNumbers.length) console.log(`\n  cases: ${s.caseNumbers.join(', ')}`);
    console.log(apply
      ? `\nApplied. Activated ${s.activated} of ${s.eligible} eligible case(s).\n`
      : `\nDry-run only. To write: NODE_ENV=production npx tsx scripts/backfill-portal-activation.ts --apply\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// Run as CLI only when invoked directly (not when imported by tests).
if (require.main === module) main().catch(e => { console.error('ERR:', e.message); process.exit(1); });

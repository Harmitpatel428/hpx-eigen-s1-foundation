/**
 * One-time / manual reconcile of configured component documents into existing
 * cases. The materialization fix (un-gated Phase B + propagation) is
 * event-driven — it fires on an assignPolicies save or a component-document
 * POST/reactivate. A case that selected a component and had presets configured
 * BEFORE those events, and was never since re-saved, keeps its pre-fix state
 * (presets configured, no DocCaseDocument rows). This script sweeps every such
 * case once.
 *
 * Run manually (NOT wired to boot, NOT a migration, NOT a route):
 *   npx ts-node scripts/reconcile-component-documents.ts            # all cases
 *   npx ts-node scripts/reconcile-component-documents.ts HPX-AAAA-BBBB ...   # specific case numbers
 *
 * Idempotent: re-running creates nothing new (mergeKey dedupe + source-triple
 * upsert inside the shared materializer). Terminal / transferred cases are
 * skipped. Legacy component-generated docs are left untouched.
 */
import { PrismaClient } from '@prisma/client';
import { DocumentationService } from '../src/services/documentation.service';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const svc = new DocumentationService(prisma);
  const only = process.argv.slice(2);
  try {
    const sels = await prisma.docCasePolicyComponent.findMany({ where: { deletedAt: null }, select: { caseId: true } });
    const caseIds = [...new Set(sels.map((s) => s.caseId))];
    const cases = await prisma.docCase.findMany({
      where:  { id: { in: caseIds }, deletedAt: null },
      select: { id: true, caseNumber: true, tenantId: true, createdBy: true, status: true },
    });
    const targets = only.length ? cases.filter((c) => c.caseNumber && only.includes(c.caseNumber)) : cases;

    console.log(`reconciling ${targets.length} case(s) with active selections${only.length ? ` (filtered to ${only.join(', ')})` : ''}`);
    let net = 0;
    for (const c of targets) {
      const label = c.caseNumber ?? c.id.slice(0, 8);
      try {
        const r = await svc.reconcileCaseComponentDocuments({ tenantId: c.tenantId, userId: c.createdBy }, c.id);
        if (r.skipped) { console.log(`  ${label} [${r.status}] SKIPPED (terminal/transferred)`); continue; }
        const delta = r.after - r.before;
        net += Math.max(0, delta);
        console.log(`  ${label} [${r.status}] before=${r.before} after=${r.after} (${delta >= 0 ? '+' : ''}${delta})`);
      } catch (e) {
        console.error(`  ${label} ERROR: ${(e as Error).message}`);
      }
    }
    console.log(`done. net documents created/revived: +${net}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

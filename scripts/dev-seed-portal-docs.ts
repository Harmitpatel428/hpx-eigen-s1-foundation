/**
 * DEV-ONLY seed: adds one clientVisible document per DocDocumentStatus value to a portal case so the
 * portal's 3 document categories (+ the dropped NOT_APPLICABLE/WAIVED) all render with real data.
 *
 * Guarded: refuses to run unless NODE_ENV=development AND DATABASE_URL points at localhost.
 * Idempotent: every row is tagged "[TEST-SEED]" and re-seeding deletes prior [TEST-SEED] rows first.
 *
 * Run:     NODE_ENV=development npx tsx scripts/dev-seed-portal-docs.ts HPX-LF5Q-FPWG
 * Cleanup: NODE_ENV=development npx tsx scripts/dev-seed-portal-docs.ts HPX-LF5Q-FPWG --clean
 */
import 'dotenv/config';
import { PrismaClient, DocDocumentStatus } from '@prisma/client';

const TAG = '[TEST-SEED]';

function assertDevLocalhost() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Refusing: NODE_ENV must be "development".');
  const host = new URL(process.env.DATABASE_URL ?? '').hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`Refusing: DATABASE_URL host "${host}" is not localhost.`);
}

async function main() {
  assertDevLocalhost();
  const caseNumber = process.argv[2];
  const clean = process.argv.includes('--clean');
  if (!caseNumber) throw new Error('Usage: dev-seed-portal-docs.ts <CASE_NUMBER> [--clean]');

  const p = new PrismaClient();
  try {
    const c = await p.docCase.findFirst({ where: { caseNumber }, select: { id: true, tenantId: true } });
    if (!c) throw new Error(`No DocCase ${caseNumber}`);

    // Idempotent: always remove prior seed rows first.
    const del = await p.docCaseDocument.deleteMany({ where: { caseId: c.id, name: { startsWith: TAG } } });
    if (clean) { console.log(`cleaned ${del.count} ${TAG} rows`); return; }

    const statuses = Object.values(DocDocumentStatus);
    let created = 0;
    for (const status of statuses) {
      await p.docCaseDocument.create({
        data: {
          tenantId: c.tenantId, caseId: c.id,
          name: `${TAG} ${status}`,
          status,
          clientVisible: true,
          receivedAt: ['RECEIVED', 'UNDER_VERIFICATION', 'APPROVED', 'MANAGER_APPROVED'].includes(status) ? new Date() : null,
        },
      });
      created++;
    }
    console.log(`seeded ${created} ${TAG} docs on ${caseNumber} (one per status). Cleanup: add --clean.`);
  } finally {
    await p.$disconnect();
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });

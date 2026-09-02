/**
 * Repair script: soft-delete duplicate contacts created by the backfill
 * batch at 2026-09-02T16:35:54.432Z, and fix isMain orphans.
 *
 * Usage:
 *   node scripts/repair-backfill-duplicates.js          # dry-run (default)
 *   node scripts/repair-backfill-duplicates.js --apply   # apply changes
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BATCH_TS = new Date('2026-09-02T16:35:54.432Z');
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING ===');
  const log = [];

  const batchContacts = await prisma.contact.findMany({
    where: { createdAt: BATCH_TS, deletedAt: null },
    orderBy: { leadId: 'asc' },
  });
  console.log('Batch contacts found:', batchContacts.length);

  for (const bc of batchContacts) {
    const olderContacts = await prisma.contact.findMany({
      where: { leadId: bc.leadId, deletedAt: null, createdAt: { lt: BATCH_TS } },
      orderBy: { createdAt: 'asc' },
    });

    if (olderContacts.length === 0) {
      // R4: single-backfill-contact lead — keep, ensure isMain=true
      const entry = { leadId: bc.leadId, contactId: bc.id, action: 'KEEP_SOLE', before: { isMain: bc.isMain }, after: { isMain: true } };
      log.push(entry);
      console.log('KEEP_SOLE:', bc.firstName, bc.lastName, '(lead', bc.leadId.slice(0, 8) + ')');
      if (!bc.isMain) {
        if (!DRY_RUN) {
          await prisma.contact.update({ where: { id: bc.id }, data: { isMain: true } });
        }
        console.log('  -> set isMain=true');
      }
      continue;
    }

    // R2: older contacts exist — soft-delete the batch duplicate
    const entry = {
      leadId: bc.leadId,
      contactId: bc.id,
      action: 'SOFT_DELETE_DUPLICATE',
      before: { firstName: bc.firstName, lastName: bc.lastName, isMain: bc.isMain },
      after: { deletedAt: 'now' },
      keptContact: olderContacts[0].id,
    };
    log.push(entry);
    console.log('SOFT_DELETE:', bc.firstName, bc.lastName, '(lead', bc.leadId.slice(0, 8) + ', kept:', olderContacts[0].firstName, olderContacts[0].lastName + ')');

    if (!DRY_RUN) {
      await prisma.contact.update({ where: { id: bc.id }, data: { deletedAt: new Date() } });
    }
  }

  // R3: Fix isMain orphans — leads with zero isMain contacts after cleanup
  const deletedIds = new Set(log.filter(e => e.action === 'SOFT_DELETE_DUPLICATE').map(e => e.contactId));
  const allLeads = await prisma.lead.findMany({
    where: { deletedAt: null },
    include: { contacts: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
  });

  for (const lead of allLeads) {
    const remaining = lead.contacts.filter(c => !deletedIds.has(c.id));
    if (remaining.length === 0) continue;
    const hasMain = remaining.some(c => c.isMain);
    if (hasMain) continue;

    const oldest = remaining[0];
    const entry = {
      leadId: lead.id,
      contactId: oldest.id,
      action: 'PROMOTE_MAIN',
      before: { isMain: false },
      after: { isMain: true },
    };
    log.push(entry);
    console.log('PROMOTE_MAIN:', oldest.firstName, oldest.lastName, '(lead', lead.id.slice(0, 8) + ')');

    if (!DRY_RUN) {
      await prisma.contact.update({ where: { id: oldest.id }, data: { isMain: true } });
      // Sync lead person fields from promoted contact (B4 pattern)
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          firstName: oldest.firstName,
          lastName: oldest.lastName,
          email: oldest.email,
          company: oldest.company,
        },
      });
      console.log('  -> lead fields synced to', oldest.firstName, oldest.lastName);
    }
  }

  console.log('\n=== Summary ===');
  console.log('Total actions:', log.length);
  console.log('  SOFT_DELETE_DUPLICATE:', log.filter(e => e.action === 'SOFT_DELETE_DUPLICATE').length);
  console.log('  PROMOTE_MAIN:', log.filter(e => e.action === 'PROMOTE_MAIN').length);
  console.log('  KEEP_SOLE:', log.filter(e => e.action === 'KEEP_SOLE').length);
  console.log('\nFull log:');
  console.log(JSON.stringify(log, null, 2));

  if (DRY_RUN) {
    console.log('\n*** DRY RUN — no changes made. Run with --apply to execute. ***');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

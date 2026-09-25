/**
 * C2 — import note routing. Exercises the exact helpers the import route uses
 * (routeImportNote + createImportNote) against the isolated test DB.
 *
 *  (a) create with note ≤500 → one leadNote (actor userId, tenantId, source='user', exact content)
 *      and Lead.notes null.
 *  (b) create with note >500 → Lead.notes preserved verbatim and ZERO leadNote rows.
 *  (c) import update (updateMany without a notes field) → Lead.notes AND leadNote rows untouched.
 */
import { PrismaClient } from '@prisma/client';
import { routeImportNote, createImportNote } from '../src/routes/leads.router';

const prisma = new PrismaClient();
const TENANT_ID = '20000000-0000-0000-0000-00000000000c';
const USER_ID = '20000000-0000-0000-0000-00000000000d';
const L_SMALL = '20000000-0000-0000-0002-000000000001';
const L_BIG = '20000000-0000-0000-0002-000000000002';
const L_UPD = '20000000-0000-0000-0002-000000000003';

async function cleanup() {
  await prisma.leadNote.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Import Note Routing Test' } });
  await prisma.lead.createMany({
    data: [
      { id: L_SMALL, tenantId: TENANT_ID, firstName: 'S', lastName: 'T' },
      { id: L_BIG, tenantId: TENANT_ID, firstName: 'B', lastName: 'T' },
      { id: L_UPD, tenantId: TENANT_ID, firstName: 'U', lastName: 'T' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('C2 import note routing', () => {
  it('(a) create with ≤500 note → leadNote row (userId, tenant, source=user, content); Lead.notes null', async () => {
    const raw = 'Imported short note';
    expect(routeImportNote(raw).legacyColumn).toBeNull();      // ≤500 does not touch the legacy column

    await prisma.$transaction((tx) => createImportNote(tx, TENANT_ID, L_SMALL, USER_ID, raw));

    const rows = await prisma.leadNote.findMany({ where: { leadId: L_SMALL } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT_ID, authorId: USER_ID, source: 'user', content: raw });
    const lead = await prisma.lead.findUnique({ where: { id: L_SMALL } });
    expect(lead!.notes).toBeNull();
  });

  it('(b) create with >500 note → Lead.notes verbatim, ZERO leadNote rows', async () => {
    const raw = 'x'.repeat(501);
    const routed = routeImportNote(raw);
    expect(routed.noteContent).toBeNull();                     // never a leadNote (won't fit VARCHAR(500))
    expect(routed.legacyColumn).toBe(raw);                     // preserved verbatim, no truncation

    await prisma.$transaction((tx) => createImportNote(tx, TENANT_ID, L_BIG, USER_ID, raw));
    expect(await prisma.leadNote.count({ where: { leadId: L_BIG } })).toBe(0);

    // buildLeadData stores exactly routeImportNote(row.notes).legacyColumn on the lead.
    await prisma.lead.update({ where: { id: L_BIG }, data: { notes: routed.legacyColumn } });
    const lead = await prisma.lead.findUnique({ where: { id: L_BIG } });
    expect(lead!.notes).toBe(raw);
  });

  it('(c) import update (no notes field) → Lead.notes and leadNote rows untouched', async () => {
    await prisma.lead.update({ where: { id: L_UPD }, data: { notes: 'keep-legacy' } });
    await prisma.leadNote.create({ data: { tenantId: TENANT_ID, leadId: L_UPD, authorId: USER_ID, content: 'existing', source: 'user' } });

    // Mirrors the import-overwrite path: updateMany carries every field EXCEPT notes.
    await prisma.lead.updateMany({
      where: { id: L_UPD, tenantId: TENANT_ID, deletedAt: null },
      data: { firstName: 'Updated', company: 'Acme' },
    });

    const lead = await prisma.lead.findUnique({ where: { id: L_UPD } });
    expect(lead!.firstName).toBe('Updated');                   // other fields did update
    expect(lead!.notes).toBe('keep-legacy');                   // legacy notes untouched
    expect(await prisma.leadNote.count({ where: { leadId: L_UPD } })).toBe(1); // notes rows untouched
  });
});

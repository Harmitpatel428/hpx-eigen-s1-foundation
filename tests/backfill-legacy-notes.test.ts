/**
 * F2 — legacy-notes backfill + create-flow unification.
 *
 * Covers: bucket classification, idempotency (2nd apply inserts 0), null/whitespace + oversize
 * handling (no silent truncation), and the atomic create-flow that routes an initial note into the
 * leadNote table instead of the legacy Lead.notes column.
 *
 * Runs against the dev/test DB (same pattern as lead-notes.test.ts); scoped to a dedicated tenant.
 */
import { PrismaClient } from '@prisma/client';
import { runBackfill, NIL_UUID } from '../scripts/backfill-legacy-notes';
import { LeadService } from '../src/services/lead.service';
import { ValidationError } from '../src/types/exceptions';

const prisma = new PrismaClient();
const TENANT_ID = '20000000-0000-0000-0000-000000000001';
const USER_ID = '20000000-0000-0000-0000-000000000002';
const ctx = { tenantId: TENANT_ID, userId: USER_ID };

const L = {
  legacyOnly: '20000000-0000-0000-0001-000000000001',
  whitespace: '20000000-0000-0000-0001-000000000002',
  oversize: '20000000-0000-0000-0001-000000000003',
  legacyPlusLive: '20000000-0000-0000-0001-000000000004',
};

const LEGACY_UPDATED_AT = new Date('2025-01-15T10:00:00.000Z');

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.leadNote.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.leadActivity.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.contact.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Backfill Test Tenant' } });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('F2 backfill — classification, idempotency, overflow', () => {
  beforeAll(async () => {
    await prisma.lead.createMany({
      data: [
        { id: L.legacyOnly, tenantId: TENANT_ID, firstName: 'A', lastName: 'T', notes: 'Legacy note', updatedAt: LEGACY_UPDATED_AT },
        { id: L.whitespace, tenantId: TENANT_ID, firstName: 'B', lastName: 'T', notes: '   ' },
        { id: L.oversize, tenantId: TENANT_ID, firstName: 'C', lastName: 'T', notes: 'x'.repeat(501) },
        { id: L.legacyPlusLive, tenantId: TENANT_ID, firstName: 'D', lastName: 'T', notes: 'Legacy + real' },
      ],
    });
    // D already has a real (user) note → must be skipped for manual review, never auto-merged.
    await prisma.leadNote.create({
      data: { tenantId: TENANT_ID, leadId: L.legacyPlusLive, authorId: USER_ID, content: 'A real note', source: 'user' },
    });
  });

  it('dry-run classifies buckets without writing', async () => {
    const before = await prisma.leadNote.count({ where: { tenantId: TENANT_ID } });
    const s = await runBackfill(prisma, { apply: false, tenantId: TENANT_ID });

    expect(s.legacyOnly).toBe(1);
    expect(s.legacyOnlyOversize).toBe(1);
    expect(s.legacyPlusLive).toBe(1);
    expect(s.whitespaceOnly).toBe(1);
    expect(s.migrated).toBe(0);
    expect(s.manualReviewIds).toContain(L.legacyPlusLive);
    expect(s.oversizeIds).toContain(L.oversize);
    // Nothing written in dry-run.
    expect(await prisma.leadNote.count({ where: { tenantId: TENANT_ID } })).toBe(before);
  });

  it('apply migrates only the legacy-only lead, tagged and dated from lead.updatedAt', async () => {
    const s = await runBackfill(prisma, { apply: true, tenantId: TENANT_ID });
    expect(s.migrated).toBe(1);

    const row = await prisma.leadNote.findFirst({ where: { leadId: L.legacyOnly } });
    expect(row).not.toBeNull();
    expect(row!.content).toBe('Legacy note');
    expect(row!.source).toBe('legacy_backfill');
    expect(row!.authorId).toBe(NIL_UUID);
    expect(row!.createdAt.getTime()).toBe(LEGACY_UPDATED_AT.getTime());

    // Skipped buckets got no rows.
    expect(await prisma.leadNote.count({ where: { leadId: L.whitespace } })).toBe(0);
    expect(await prisma.leadNote.count({ where: { leadId: L.oversize } })).toBe(0);
    // legacy+live still has exactly its original one row (not merged).
    expect(await prisma.leadNote.count({ where: { leadId: L.legacyPlusLive } })).toBe(1);
  });

  it('is idempotent: a second apply inserts 0 and leaves one row', async () => {
    const s = await runBackfill(prisma, { apply: true, tenantId: TENANT_ID });
    expect(s.migrated).toBe(0);
    expect(s.legacyOnly).toBe(0);          // now reclassified as already-backfilled
    expect(s.alreadyBackfilled).toBe(1);
    expect(await prisma.leadNote.count({ where: { leadId: L.legacyOnly } })).toBe(1);
  });
});

describe('F2/P3 structural idempotency — partial unique index on live backfill rows', () => {
  const LEAD = '20000000-0000-0000-0001-00000000000a';

  beforeAll(async () => {
    await prisma.lead.create({ data: { id: LEAD, tenantId: TENANT_ID, firstName: 'P3', lastName: 'T' } });
  });

  it('blocks a second live legacy_backfill row for the same lead (unique violation)', async () => {
    await prisma.leadNote.create({
      data: { tenantId: TENANT_ID, leadId: LEAD, authorId: NIL_UUID, content: 'backfilled', source: 'legacy_backfill' },
    });
    await expect(
      prisma.leadNote.create({
        data: { tenantId: TENANT_ID, leadId: LEAD, authorId: NIL_UUID, content: 'dup', source: 'legacy_backfill' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('still allows normal user notes alongside a backfilled row', async () => {
    await expect(
      prisma.leadNote.create({
        data: { tenantId: TENANT_ID, leadId: LEAD, authorId: USER_ID, content: 'a user note', source: 'user' },
      }),
    ).resolves.toBeDefined();
  });
});

describe('F2 create-flow — initial note routed to the notes table, not Lead.notes', () => {
  const svc = new LeadService(prisma);

  it('creates a real leadNote row and leaves Lead.notes null', async () => {
    const lead = await svc.createLead(ctx, { firstName: 'New', lastName: 'Lead', notes: 'First note' } as any);
    expect(lead.notes).toBeNull();
    const rows = await prisma.leadNote.findMany({ where: { leadId: lead.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('First note');
    expect(rows[0].source).toBe('user');
  });

  it('rejects an initial note over 500 chars (no truncation)', async () => {
    await expect(
      svc.createLead(ctx, { firstName: 'Big', lastName: 'Note', notes: 'x'.repeat(501) } as any),
    ).rejects.toThrow(ValidationError);
  });

  it('creates no note for a whitespace-only initial note', async () => {
    const lead = await svc.createLead(ctx, { firstName: 'Blank', lastName: 'Note', notes: '   ' } as any);
    expect(lead.notes).toBeNull();
    expect(await prisma.leadNote.count({ where: { leadId: lead.id } })).toBe(0);
  });
});

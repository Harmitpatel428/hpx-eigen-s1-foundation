/**
 * Lead Import Concurrency — DB-level uniqueness enforcement
 *
 * Proves the partial unique indexes introduced in migration
 * 20260817050000_add_lead_email_phone_unique_indexes prevent duplicate leads
 * even when two concurrent imports race past the application-level duplicate check.
 *
 * The TOCTOU race is simulated by bypassing the app-level check and issuing
 * two concurrent createMany calls directly against the real DB.
 */

import 'dotenv/config';
import { PrismaClient, LeadStatus, LeadSource, OrganizationStatus } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

function uid() { return crypto.randomUUID(); }

async function makeTenant(name: string) {
  return (prisma as any).tenant.create({ data: { name, status: OrganizationStatus.ACTIVE } });
}

async function cleanup(tenantId: string | undefined) {
  if (!tenantId) return;
  await (prisma as any).lead.deleteMany({ where: { tenantId } });
  await (prisma as any).user.deleteMany({ where: { tenantId } });
  await (prisma as any).tenant.delete({ where: { id: tenantId } });
}

describe('Lead import — concurrent unique-email race', () => {
  let tenantId: string | undefined;

  beforeAll(async () => {
    const t = await makeTenant('ConcurrentImportOrg');
    tenantId = t.id;
  }, 10000);

  afterAll(async () => { await cleanup(tenantId); }, 10000);

  it('concurrent createMany with same email: exactly one lead created', async () => {
    const email = `race-${uid().slice(0, 8)}@test.invalid`;
    const makePayload = () => ({
      tenantId: tenantId!,
      firstName: 'Race',
      lastName: 'Test',
      email,
      status: LeadStatus.NEW,
      source: LeadSource.OTHER,
    });

    // Fire two concurrent createMany calls with the same email.
    // One will win the DB unique constraint; the other's row is silently skipped
    // by skipDuplicates: true (which compiles to ON CONFLICT DO NOTHING).
    const [r1, r2] = await Promise.all([
      (prisma as any).lead.createMany({ data: [makePayload()], skipDuplicates: true }),
      (prisma as any).lead.createMany({ data: [makePayload()], skipDuplicates: true }),
    ]);

    // Together they insert exactly 1 row
    expect(r1.count + r2.count).toBe(1);

    // DB confirms exactly 1 lead with this email in this tenant
    const leads = await (prisma as any).lead.findMany({
      where: { tenantId, email, deletedAt: null },
    });
    expect(leads).toHaveLength(1);
  });

  it('concurrent createMany with same phone: exactly one lead created', async () => {
    const phone = `+91${Math.floor(Math.random() * 9000000000) + 1000000000}`;
    const makePayload = () => ({
      tenantId: tenantId!,
      firstName: 'RacePhone',
      lastName: 'Test',
      phone,
      status: LeadStatus.NEW,
      source: LeadSource.OTHER,
    });

    const [r1, r2] = await Promise.all([
      (prisma as any).lead.createMany({ data: [makePayload()], skipDuplicates: true }),
      (prisma as any).lead.createMany({ data: [makePayload()], skipDuplicates: true }),
    ]);

    expect(r1.count + r2.count).toBe(1);

    const leads = await (prisma as any).lead.findMany({
      where: { tenantId, phone, deletedAt: null },
    });
    expect(leads).toHaveLength(1);
  });

  it('cross-tenant same email: both inserts succeed (no cross-tenant constraint)', async () => {
    const email = `cross-${uid().slice(0, 8)}@test.invalid`;
    const t2 = await makeTenant('ConcurrentImportOrg2');

    try {
      const [r1, r2] = await Promise.all([
        (prisma as any).lead.createMany({
          data: [{ tenantId: tenantId!, firstName: 'T1', lastName: 'L', email, status: LeadStatus.NEW, source: LeadSource.OTHER }],
          skipDuplicates: true,
        }),
        (prisma as any).lead.createMany({
          data: [{ tenantId: t2.id, firstName: 'T2', lastName: 'L', email, status: LeadStatus.NEW, source: LeadSource.OTHER }],
          skipDuplicates: true,
        }),
      ]);

      // Both succeed — unique index is (tenantId, email), not just email
      expect(r1.count).toBe(1);
      expect(r2.count).toBe(1);
    } finally {
      await (prisma as any).lead.deleteMany({ where: { tenantId: { in: [tenantId!, t2.id] }, email } });
      await (prisma as any).tenant.delete({ where: { id: t2.id } });
    }
  });

  it('soft-deleted email can be reused by a new lead', async () => {
    const email = `reuse-${uid().slice(0, 8)}@test.invalid`;

    // Create + soft-delete a lead
    const first = await (prisma as any).lead.create({
      data: { tenantId: tenantId!, firstName: 'First', lastName: 'L', email, status: LeadStatus.NEW, source: LeadSource.OTHER },
    });
    await (prisma as any).lead.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });

    // Now create a new lead with the same email — should succeed because the
    // unique index is partial (WHERE deletedAt IS NULL)
    const result = await (prisma as any).lead.createMany({
      data: [{ tenantId: tenantId!, firstName: 'Second', lastName: 'L', email, status: LeadStatus.NEW, source: LeadSource.OTHER }],
      skipDuplicates: true,
    });
    expect(result.count).toBe(1);

    // Active leads: exactly 1 (the new one)
    const active = await (prisma as any).lead.findMany({ where: { tenantId, email, deletedAt: null } });
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(first.id);
  });
});

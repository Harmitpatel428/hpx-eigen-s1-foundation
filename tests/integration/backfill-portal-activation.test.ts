/**
 * scripts/backfill-portal-activation.ts — activates the portal on cases handed off before
 * handoff-time activation existed (phone snapshot present, open status, portalEnabledAt null).
 *
 * Covers: eligibility (closed / no-phone / already-enabled / soft-deleted / other-tenant rows are
 * never touched), dry-run writes nothing, apply activates + audits, and a second apply is a no-op.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { runBackfill } from '../../scripts/backfill-portal-activation';

const prisma = new PrismaClient();
const TENANT_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const TENANTS = [TENANT_ID, OTHER_TENANT_ID];
const ALREADY_ENABLED_AT = new Date('2026-10-01T00:00:00.000Z');

type Overrides = Partial<{
  status: DocCaseStatus; portalPhoneLast4: string | null; portalEnabledAt: Date | null;
  deletedAt: Date | null; tenantId: string;
}>;

async function createCase(o: Overrides = {}) {
  const tenantId = o.tenantId ?? TENANT_ID;
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'Backfill', lastName: 'Case', email: `bf-${crypto.randomUUID()}@example.com` },
  });
  return prisma.docCase.create({
    data: {
      tenantId, leadId: lead.id, createdBy: USER_ID,
      caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      status: o.status ?? DocCaseStatus.ACTIVE,
      portalPhoneLast4: o.portalPhoneLast4 === undefined ? '1234' : o.portalPhoneLast4,
      portalEnabledAt: o.portalEnabledAt ?? null,
      deletedAt: o.deletedAt ?? null,
    },
  });
}

async function cleanup() {
  const cases = await prisma.docCase.findMany({ where: { tenantId: { in: TENANTS } }, select: { leadId: true } });
  await prisma.docCase.deleteMany({ where: { tenantId: { in: TENANTS } } });
  await prisma.lead.deleteMany({ where: { id: { in: cases.map(c => c.leadId) } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: TENANTS } } });
  await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

const enabledAt = async (id: string) =>
  (await prisma.docCase.findUniqueOrThrow({ where: { id }, select: { portalEnabledAt: true } })).portalEnabledAt;

describe('backfill-portal-activation', () => {
  let eligible: { id: string }, closed: { id: string }, cancelled: { id: string }, closedNoDocs: { id: string }, noPhone: { id: string },
    already: { id: string }, deleted: { id: string }, otherTenant: { id: string };

  beforeAll(async () => {
    await prisma.tenant.createMany({
      data: [{ id: TENANT_ID, name: 'Portal Backfill Tenant' }, { id: OTHER_TENANT_ID, name: 'Portal Backfill Other' }],
    });
    eligible = await createCase({ status: DocCaseStatus.DOCUMENTATION_READY });
    closed = await createCase({ status: DocCaseStatus.CLOSED });
    cancelled = await createCase({ status: DocCaseStatus.CANCELLED });
    // Closing without docs deliberately deactivates the portal — the backfill must not resurrect it.
    closedNoDocs = await createCase({ status: DocCaseStatus.CLOSED_NO_DOCS });
    noPhone = await createCase({ portalPhoneLast4: null });
    already = await createCase({ portalEnabledAt: ALREADY_ENABLED_AT });
    deleted = await createCase({ deletedAt: new Date() });
    otherTenant = await createCase({ tenantId: OTHER_TENANT_ID });
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('dry-run reports the eligible rows and writes nothing', async () => {
    const s = await runBackfill(prisma, { apply: false, tenantId: TENANT_ID });

    expect(s.eligible).toBe(1);
    expect(s.activated).toBe(0);
    expect(s.skippedNoPhone).toBe(1);
    expect(s.skippedClosed).toBe(3);
    expect(await enabledAt(eligible.id)).toBeNull();
    expect(await prisma.auditLog.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('apply activates only open cases with a phone snapshot, and audits each activation', async () => {
    const s = await runBackfill(prisma, { apply: true, tenantId: TENANT_ID });

    expect(s.eligible).toBe(1);
    expect(s.activated).toBe(1);
    expect(await enabledAt(eligible.id)).toBeTruthy();

    // Never touched: closed, cancelled, closed-no-docs, no phone, soft-deleted, and another tenant's row.
    for (const c of [closed, cancelled, closedNoDocs, noPhone, deleted, otherTenant]) expect(await enabledAt(c.id)).toBeNull();
    // An existing activation timestamp is preserved, not overwritten.
    expect(await enabledAt(already.id)).toEqual(ALREADY_ENABLED_AT);

    const audits = await prisma.auditLog.findMany({ where: { tenantId: TENANT_ID, eventType: 'PORTAL_AUTO_ACTIVATED' } });
    expect(audits.map(a => a.entityId)).toEqual([eligible.id]);
  });

  it('second apply is a no-op (idempotent)', async () => {
    const before = await enabledAt(eligible.id);

    const s = await runBackfill(prisma, { apply: true, tenantId: TENANT_ID });

    expect(s.eligible).toBe(0);
    expect(s.activated).toBe(0);
    expect(await enabledAt(eligible.id)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { tenantId: TENANT_ID, eventType: 'PORTAL_AUTO_ACTIVATED' } })).toBe(1);
  });
});

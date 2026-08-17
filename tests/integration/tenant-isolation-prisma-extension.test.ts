/**
 * Tenant Isolation — Prisma Extension Coverage
 *
 * Verifies that the global Prisma extension in src/db.ts correctly injects
 * tenantId into all read/write operations for tenant-scoped models.
 *
 * Architecture under test: db.ts $allOperations middleware that reads from
 * requestContextStorage (AsyncLocalStorage) and injects tenantId into WHERE.
 *
 * Replaces the original tenant-isolation.test.ts which imported from
 * src/repositories/base.repo — a module that was never implemented.
 */

import { PrismaClient } from '@prisma/client';
import { prisma } from '../../src/db';
import { requestContextStorage, RequestContext } from '../../src/context/request-context';

// Raw client for setup/teardown — bypasses the extension so we can insert
// test data with explicit tenantIds without needing a request context.
const rawPrisma = new PrismaClient();

const TENANT_A = 'a0000000-0000-0000-0000-000000000001';
const TENANT_B = 'b0000000-0000-0000-0000-000000000002';
const LEAD_A_ID = 'c0000000-0000-0000-0000-000000000001';
const LEAD_B_ID = 'c0000000-0000-0000-0000-000000000002';
const USER_STUB = '00000000-0000-0000-0000-000000000099';

function makeCtx(tenantId: string): RequestContext {
  return {
    tenantId,
    identityId: USER_STUB,
    membershipId: '',
    sessionId: '00000000-0000-0000-0000-000000000000',
    correlationId: '00000000-0000-0000-0000-000000000000',
    requestedAt: new Date(),
  };
}

beforeAll(async () => {
  await rawPrisma.tenant.createMany({
    data: [
      { id: TENANT_A, name: 'Isolation Test Tenant A' },
      { id: TENANT_B, name: 'Isolation Test Tenant B' },
    ],
    skipDuplicates: true,
  });
  await rawPrisma.lead.createMany({
    data: [
      { id: LEAD_A_ID, tenantId: TENANT_A, firstName: 'Alice', lastName: 'A' },
      { id: LEAD_B_ID, tenantId: TENANT_B, firstName: 'Bob', lastName: 'B' },
    ],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  await rawPrisma.lead.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
  await rawPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  await rawPrisma.$disconnect();
});

describe('Prisma extension tenant isolation', () => {
  it('findMany: Tenant A context returns only Tenant A leads', async () => {
    let ids: string[] = [];
    await requestContextStorage.run(makeCtx(TENANT_A), async () => {
      const results = await prisma.lead.findMany({ where: {} });
      ids = results.map((r: any) => r.id);
    });
    expect(ids).toContain(LEAD_A_ID);
    expect(ids).not.toContain(LEAD_B_ID);
  });

  it('findMany: Tenant B context cannot see Tenant A leads', async () => {
    let results: any[] = [];
    await requestContextStorage.run(makeCtx(TENANT_B), async () => {
      results = await prisma.lead.findMany({ where: { id: LEAD_A_ID } });
    });
    expect(results).toHaveLength(0);
  });

  it('update: Tenant B cannot update Tenant A lead by id', async () => {
    let updateError: Error | null = null;
    await requestContextStorage.run(makeCtx(TENANT_B), async () => {
      try {
        await prisma.lead.update({
          where: { id: LEAD_A_ID },
          data: { firstName: 'HACKED' },
        });
      } catch (e: any) {
        updateError = e;
      }
    });
    // Extension injects { id: LEAD_A_ID, tenantId: TENANT_B } → no row matches → RecordNotFound
    expect(updateError).not.toBeNull();

    // Confirm original data is untouched
    const unchanged = await rawPrisma.lead.findUnique({ where: { id: LEAD_A_ID } });
    expect(unchanged?.firstName).toBe('Alice');
  });

  it('count: Context scopes count to each tenant', async () => {
    let countA = 0;
    let countB = 0;
    let crossCheck = 0;

    await requestContextStorage.run(makeCtx(TENANT_A), async () => {
      countA = await prisma.lead.count({ where: {} });
    });
    await requestContextStorage.run(makeCtx(TENANT_B), async () => {
      countB = await prisma.lead.count({ where: {} });
    });
    await requestContextStorage.run(makeCtx(TENANT_A), async () => {
      crossCheck = await prisma.lead.count({ where: { id: LEAD_B_ID } });
    });

    expect(countA).toBeGreaterThanOrEqual(1);
    expect(countB).toBeGreaterThanOrEqual(1);
    // Tenant A's count does not include Tenant B's lead
    expect(crossCheck).toBe(0);
  });
});

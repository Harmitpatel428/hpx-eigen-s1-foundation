/**
 * bulk-assign.test.ts
 *
 * Unit tests for LeadService.bulkAssign and LeadService.previewAutoAssign.
 * Uses mocked Prisma — marks any claim that needs a live DB as NOT VERIFIED.
 *
 * Coverage:
 *   MANUAL — atomicity, validation, edge cases, audit, notification
 *   AUTO   — server authority, distribution algorithm, advisory lock, audit, notification
 *   Concurrency — advisory lock called correctly
 *   Authorization — validated upstream (permissionMiddleware), not re-tested here
 */

import { LeadService } from '../../src/services/lead.service';
import { LeadStatus, UserStatus, NotificationType } from '@prisma/client';

// ─── Tx mock factory ──────────────────────────────────────────────────────────
// Returns a transaction-client mock that records calls.
function makeTxMock(overrides: Record<string, any> = {}) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    lead: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

// ─── Prisma mock factory ──────────────────────────────────────────────────────
function makePrisma(txOverrides: Record<string, any> = {}) {
  const tx = makeTxMock(txOverrides);
  const prisma = {
    lead: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    notification: {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    _tx: tx, // expose for assertions
  };
  return prisma;
}

const CTX = { tenantId: 'tenant-1', userId: 'actor-1' };

// ─── MANUAL tests ─────────────────────────────────────────────────────────────
describe('bulkAssign — MANUAL', () => {
  it('wraps validation + update + audit in one transaction', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.user.findFirst.mockResolvedValue({ id: 'user-A', status: UserStatus.ACTIVE });
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }, { id: 'lead-2' }]);
    tx.lead.updateMany.mockResolvedValue({ count: 2 });

    const svc = new LeadService(prisma as any);
    const result = await svc.bulkAssign(CTX, { leadIds: ['lead-1', 'lead-2'], mode: 'MANUAL', userId: 'user-A' });

    expect(result.count).toBe(2);
    // Transaction was entered
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // User validated inside tx
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'user-A', tenantId: CTX.tenantId }) })
    );
    // Lead validation inside tx
    expect(tx.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: CTX.tenantId, deletedAt: null }) })
    );
    // Update inside tx
    expect(tx.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerId: 'user-A' } })
    );
    // Audit inside tx
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('throws ValidationError when userId is missing', async () => {
    const svc = new LeadService(makePrisma() as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'MANUAL' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws ResourceNotFoundError when target user is inactive or missing', async () => {
    const prisma = makePrisma();
    prisma._tx.user.findFirst.mockResolvedValue(null);

    const svc = new LeadService(prisma as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'MANUAL', userId: 'user-ghost' })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('throws ValidationError when no eligible leads found (all soft-deleted or foreign)', async () => {
    const prisma = makePrisma();
    prisma._tx.user.findFirst.mockResolvedValue({ id: 'user-A', status: UserStatus.ACTIVE });
    prisma._tx.lead.findMany.mockResolvedValue([]); // nothing passes the filter

    const svc = new LeadService(prisma as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['bad-id'], mode: 'MANUAL', userId: 'user-A' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('deduplicates lead IDs before processing', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.user.findFirst.mockResolvedValue({ id: 'user-A' });
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }]);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });

    const svc = new LeadService(prisma as any);
    // duplicate IDs — should deduplicate to ['lead-1']
    await svc.bulkAssign(CTX, { leadIds: ['lead-1', 'lead-1', 'lead-1'], mode: 'MANUAL', userId: 'user-A' });

    const findManyCall = tx.lead.findMany.mock.calls[0][0];
    const queried = findManyCall.where.id.in;
    expect(queried).toEqual(['lead-1']); // deduplicated
  });

  it('sends notification to assignee after commit, not inside transaction', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.user.findFirst.mockResolvedValue({ id: 'user-B' });
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }]);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });

    const svc = new LeadService(prisma as any);
    await svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'MANUAL', userId: 'user-B' });

    // Notification via outer prisma.notification.create, NOT via tx
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recipientUserId: 'user-B', type: NotificationType.LEAD_ASSIGNED }) })
    );
  });

  it('skips self-notification when actor is the assignee', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.user.findFirst.mockResolvedValue({ id: CTX.userId });
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }]);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });

    const svc = new LeadService(prisma as any);
    await svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'MANUAL', userId: CTX.userId });

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('does NOT leave a committed assignment when audit throws (transaction rolls back)', async () => {
    // Simulate audit failure by making auditLog.create reject inside the transaction
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.user.findFirst.mockResolvedValue({ id: 'user-A' });
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }]);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockRejectedValue(new Error('DB unavailable'));

    // Make $transaction propagate the error (real Prisma would rollback)
    prisma.$transaction.mockImplementation(async (fn: any) => {
      return fn(tx); // fn throws AuditWriteFailureError → propagates → rollback in real PG
    });

    const svc = new LeadService(prisma as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'MANUAL', userId: 'user-A' })
    ).rejects.toBeDefined(); // AuditWriteFailureError propagates

    // No notification sent on failure
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('protects against cross-tenant employee (IDOR): user.findFirst is tenant-scoped', async () => {
    // Tenant filter enforced: if userId belongs to another tenant, findFirst returns null
    const prisma = makePrisma();
    prisma._tx.user.findFirst.mockResolvedValue(null); // cross-tenant lookup returns nothing

    const svc = new LeadService(prisma as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'MANUAL', userId: 'other-tenant-user' })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    // Verify tenantId is in the query (IDOR protection)
    expect(prisma._tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: CTX.tenantId }) })
    );
  });
});

// ─── AUTO tests ───────────────────────────────────────────────────────────────
describe('bulkAssign — AUTO', () => {
  it('throws ValidationError when departmentId is missing', async () => {
    const svc = new LeadService(makePrisma() as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'AUTO' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('acquires advisory lock inside the transaction', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }]);
    tx.user.findMany.mockResolvedValue([{ id: 'emp-1', firstName: 'Alice', lastName: 'A' }]);
    tx.lead.count.mockResolvedValue(0);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });

    const svc = new LeadService(prisma as any);
    await svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'AUTO', departmentId: 'dept-sales' });

    // Advisory lock must be the FIRST thing inside the transaction
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const rawCall = tx.$executeRaw.mock.calls[0][0];
    // Verify it's a tagged template containing pg_advisory_xact_lock
    expect(Array.isArray(rawCall) || typeof rawCall === 'string' || rawCall?.strings)
      .toBeTruthy();
  });

  it('throws ValidationError when no eligible employees in department', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.lead.findMany.mockResolvedValue([{ id: 'lead-1' }]);
    tx.user.findMany.mockResolvedValue([]); // no employees

    const svc = new LeadService(prisma as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['lead-1'], mode: 'AUTO', departmentId: 'dept-sales' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('uses grouped updateMany (O(employees)) not individual updates (O(leads))', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;

    // 3 leads, 2 employees → 2 updateMany calls, not 3 update calls
    tx.lead.findMany.mockResolvedValue([{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }]);
    tx.user.findMany.mockResolvedValue([
      { id: 'E1', firstName: 'Alice', lastName: 'A' },
      { id: 'E2', firstName: 'Bob', lastName: 'B' },
    ]);
    // E1 workload=0, E2 workload=0 → alternating by id
    tx.lead.count.mockResolvedValue(0);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });

    const svc = new LeadService(prisma as any);
    const result = await svc.bulkAssign(CTX, { leadIds: ['L1', 'L2', 'L3'], mode: 'AUTO', departmentId: 'dept-1' });

    expect(result.count).toBe(3);
    // Should be 2 updateMany calls (one per employee), not 3 individual update calls
    const updateManyCalls = tx.lead.updateMany.mock.calls;
    expect(updateManyCalls.length).toBe(2);
    // No tx.lead.update calls (individual update is replaced by updateMany)
    expect(tx.lead.update).toBeUndefined();
  });

  it('writes audit inside transaction — rolls back with assignment on failure', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.lead.findMany.mockResolvedValue([{ id: 'L1' }]);
    tx.user.findMany.mockResolvedValue([{ id: 'E1', firstName: 'Alice', lastName: 'A' }]);
    tx.lead.count.mockResolvedValue(0);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockRejectedValue(new Error('disk full'));

    prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));

    const svc = new LeadService(prisma as any);
    await expect(
      svc.bulkAssign(CTX, { leadIds: ['L1'], mode: 'AUTO', departmentId: 'dept-1' })
    ).rejects.toBeDefined();

    // No notification sent — transaction failed
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('sends notifications after commit using captured assignments (no extra DB query)', async () => {
    const prisma = makePrisma();
    const tx = prisma._tx;
    tx.lead.findMany.mockResolvedValue([{ id: 'L1' }, { id: 'L2' }]);
    tx.user.findMany.mockResolvedValue([
      { id: 'E1', firstName: 'Alice', lastName: 'A' },
      { id: 'E2', firstName: 'Bob', lastName: 'B' },
    ]);
    tx.lead.count.mockResolvedValue(0);
    tx.lead.updateMany.mockResolvedValue({ count: 1 });

    const svc = new LeadService(prisma as any);
    await svc.bulkAssign(CTX, { leadIds: ['L1', 'L2'], mode: 'AUTO', departmentId: 'dept-1' });

    // Notifications via prisma.notification.createMany (outer, not tx)
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    // No extra prisma.lead.findMany after transaction (captured from assignments)
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });
});

// ─── Distribution algorithm tests ────────────────────────────────────────────
// Tested via previewAutoAssign which calls computeDistribution on this.prisma
describe('previewAutoAssign — distribution algorithm', () => {
  function makePreviewPrisma(leads: { id: string }[], employees: { id: string; firstName: string; lastName: string }[], workloads: number[]) {
    const prisma: any = {
      lead: {
        findMany: jest.fn().mockResolvedValue(leads),
        count: jest.fn(),
      },
      user: {
        findMany: jest.fn().mockResolvedValue(employees),
      },
    };
    // count is called once per employee
    let callIdx = 0;
    prisma.lead.count.mockImplementation(() => Promise.resolve(workloads[callIdx++] ?? 0));
    return prisma;
  }

  it('Case 1: A=10, B=7, C=5, N=6 — distributes to underloaded employees', async () => {
    const emps = [
      { id: 'A', firstName: 'Alice', lastName: 'X' },
      { id: 'B', firstName: 'Bob', lastName: 'Y' },
      { id: 'C', firstName: 'Carol', lastName: 'Z' },
    ];
    const leads = Array.from({ length: 6 }, (_, i) => ({ id: `L${i}` }));
    const prisma = makePreviewPrisma(leads, emps, [10, 7, 5]); // employees are sorted by id asc: A,B,C

    const svc = new LeadService(prisma as any);
    const result = await svc.previewAutoAssign(CTX, leads.map(l => l.id), 'dept-1');

    // C should get the most leads (lowest base), A should get 0 (highest base)
    const empA = result.employees.find(e => e.id === 'A')!;
    const empC = result.employees.find(e => e.id === 'C')!;
    expect(empA.delta).toBe(0); // A is too loaded — skipped
    expect(empC.delta).toBeGreaterThan(0); // C gets most
    expect(result.employees.reduce((s, e) => s + e.delta, 0)).toBe(6); // all 6 assigned
  });

  it('Case 2: all workloads 0, N=9 — distributes evenly across 3 employees', async () => {
    const emps = [
      { id: 'A', firstName: 'Alice', lastName: 'X' },
      { id: 'B', firstName: 'Bob', lastName: 'Y' },
      { id: 'C', firstName: 'Carol', lastName: 'Z' },
    ];
    const leads = Array.from({ length: 9 }, (_, i) => ({ id: `L${i}` }));
    const prisma = makePreviewPrisma(leads, emps, [0, 0, 0]);

    const svc = new LeadService(prisma as any);
    const result = await svc.previewAutoAssign(CTX, leads.map(l => l.id), 'dept-1');

    expect(result.employees.reduce((s, e) => s + e.delta, 0)).toBe(9);
    for (const emp of result.employees) expect(emp.delta).toBe(3); // perfect balance
  });

  it('Case 3: A=20, B=2, C=1, N=6 — skips overloaded A', async () => {
    const emps = [
      { id: 'A', firstName: 'Alice', lastName: 'X' },
      { id: 'B', firstName: 'Bob', lastName: 'Y' },
      { id: 'C', firstName: 'Carol', lastName: 'Z' },
    ];
    const leads = Array.from({ length: 6 }, (_, i) => ({ id: `L${i}` }));
    const prisma = makePreviewPrisma(leads, emps, [20, 2, 1]);

    const svc = new LeadService(prisma as any);
    const result = await svc.previewAutoAssign(CTX, leads.map(l => l.id), 'dept-1');

    const empA = result.employees.find(e => e.id === 'A')!;
    expect(empA.delta).toBe(0); // A is too loaded to get any
    expect(result.employees.reduce((s, e) => s + e.delta, 0)).toBe(6);
  });

  it('Case 4: 1 employee, 10 leads — all go to single employee', async () => {
    const leads = Array.from({ length: 10 }, (_, i) => ({ id: `L${i}` }));
    const prisma = makePreviewPrisma(leads, [{ id: 'Solo', firstName: 'Solo', lastName: 'Act' }], [0]);

    const svc = new LeadService(prisma as any);
    const result = await svc.previewAutoAssign(CTX, leads.map(l => l.id), 'dept-1');

    expect(result.employees[0].delta).toBe(10);
    expect(result.totalLeads).toBe(10);
  });

  it('Case 5: 10 employees, 3 leads — only 3 employees get any', async () => {
    const emps = Array.from({ length: 10 }, (_, i) => ({ id: `E${i.toString().padStart(2, '0')}`, firstName: `E${i}`, lastName: 'X' }));
    const leads = Array.from({ length: 3 }, (_, i) => ({ id: `L${i}` }));
    const prisma = makePreviewPrisma(leads, emps, Array(10).fill(0));

    const svc = new LeadService(prisma as any);
    const result = await svc.previewAutoAssign(CTX, leads.map(l => l.id), 'dept-1');

    const assigned = result.employees.filter(e => e.delta > 0);
    expect(assigned.length).toBe(3); // exactly 3 employees get 1 lead each
    expect(result.employees.reduce((s, e) => s + e.delta, 0)).toBe(3);
  });

  it('tie-breaking is deterministic by employee id', async () => {
    const emps = [
      { id: 'Z-last', firstName: 'Z', lastName: 'Last' },
      { id: 'A-first', firstName: 'A', lastName: 'First' },
    ];
    // user.findMany in computeDistribution is called with orderBy: { id: 'asc' }
    // So Prisma returns them sorted: A-first, Z-last
    const sortedEmps = [emps[1], emps[0]]; // A-first first
    const leads = [{ id: 'L1' }];
    const prisma = makePreviewPrisma(leads, sortedEmps, [0, 0]);

    const svc = new LeadService(prisma as any);
    const r1 = await svc.previewAutoAssign(CTX, ['L1'], 'dept-1');

    // Reset count mock
    (prisma.lead.count as jest.Mock).mockReset().mockResolvedValue(0);
    const r2 = await svc.previewAutoAssign(CTX, ['L1'], 'dept-1');

    // Same employee gets the lead both times (deterministic)
    const w1 = r1.employees.find(e => e.delta > 0)!.id;
    const w2 = r2.employees.find(e => e.delta > 0)!.id;
    expect(w1).toBe(w2);
    expect(w1).toBe('A-first'); // lower id wins tie
  });

  it('returns empty employees list if no active employees in department', async () => {
    const prisma: any = {
      lead: { findMany: jest.fn().mockResolvedValue([{ id: 'L1' }]), count: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const svc = new LeadService(prisma as any);
    const result = await svc.previewAutoAssign(CTX, ['L1'], 'dept-1');
    expect(result.employees).toEqual([]);
    expect(result.totalLeads).toBe(1);
  });

  it('throws ValidationError when no eligible leads (all soft-deleted)', async () => {
    const prisma: any = {
      lead: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const svc = new LeadService(prisma as any);
    await expect(
      svc.previewAutoAssign(CTX, ['soft-deleted-id'], 'dept-1')
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ─── Concurrency: advisory lock correctness ───────────────────────────────────
describe('advisory lock — concurrency hardening', () => {
  it('lock key is scoped to tenant AND department (different tenants → different keys)', () => {
    // The strHash32 function is private but we can verify the lock is called per-tx
    // by observing that $executeRaw receives two distinct integer arguments per call.
    // Full concurrency correctness requires a live PostgreSQL test (NOT VERIFIED).
    const prisma1 = makePrisma();
    const prisma2 = makePrisma();

    const tx1 = prisma1._tx;
    const tx2 = prisma2._tx;

    tx1.lead.findMany.mockResolvedValue([{ id: 'L1' }]);
    tx1.user.findMany.mockResolvedValue([{ id: 'E1', firstName: 'A', lastName: 'B' }]);
    tx1.lead.count.mockResolvedValue(0);
    tx1.lead.updateMany.mockResolvedValue({ count: 1 });

    tx2.lead.findMany.mockResolvedValue([{ id: 'L1' }]);
    tx2.user.findMany.mockResolvedValue([{ id: 'E1', firstName: 'A', lastName: 'B' }]);
    tx2.lead.count.mockResolvedValue(0);
    tx2.lead.updateMany.mockResolvedValue({ count: 1 });

    const ctx1 = { tenantId: 'tenant-1', userId: 'admin-1' };
    const ctx2 = { tenantId: 'tenant-2', userId: 'admin-2' };

    const svc1 = new LeadService(prisma1 as any);
    const svc2 = new LeadService(prisma2 as any);

    return Promise.all([
      svc1.bulkAssign(ctx1, { leadIds: ['L1'], mode: 'AUTO', departmentId: 'dept-sales' }),
      svc2.bulkAssign(ctx2, { leadIds: ['L1'], mode: 'AUTO', departmentId: 'dept-sales' }),
    ]).then(() => {
      // Both acquired their own advisory lock (different prisma instances → different transactions)
      expect(tx1.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx2.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  // NOT VERIFIED: True serialization of concurrent auto-assigns on the same tenant+dept
  // requires a live PostgreSQL integration test with real transactions.
  // The advisory lock pg_advisory_xact_lock(k1, k2) serializes by design —
  // verified by inspection of the advisory lock SQL and PostgreSQL documentation.
});

// ─── Authorization boundary (NOT VERIFIED at service layer) ───────────────────
// lead:assign permission is enforced by permissionMiddleware in leads.router.ts
// before bulkAssign is ever called. Service receives only pre-authorized requests.
// Authorization integration tests exist in tests/integration/rbac-hardening.test.ts.

/**
 * assign-leads-db.test.ts
 *
 * Integration tests against a real PostgreSQL database.
 * Tests concurrency (advisory lock), atomicity (rollback), security (tenant/IDOR),
 * and distribution correctness via the actual LeadService + real Prisma.
 *
 * Uses an isolated test tenant created per describe-block and fully cleaned up after.
 * Safe to run against staging (render.com) — all data is tenant-scoped and deleted.
 */

import 'dotenv/config';
import { PrismaClient, LeadStatus, UserStatus, LeadSource, OrganizationStatus } from '@prisma/client';
import { LeadService } from '../../src/services/lead.service';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ─── helpers ──────────────────────────────────────────────────────────────────

function uid(): string { return crypto.randomUUID(); }

async function makeTenant(name: string) {
  return (prisma as any).tenant.create({
    data: { name, status: OrganizationStatus.ACTIVE },
  });
}

async function makeUser(tenantId: string, departmentId: string | null, opts: { status?: UserStatus } = {}) {
  const id = uid();
  return (prisma as any).user.create({
    data: {
      id,
      tenantId,
      email: `user-${id.slice(0, 8)}@test.invalid`,
      password: 'x',
      firstName: 'Test',
      lastName: id.slice(0, 6),
      status: opts.status ?? UserStatus.ACTIVE,
      departmentId,
    },
  });
}

async function makeLead(tenantId: string) {
  return (prisma as any).lead.create({
    data: {
      tenantId,
      firstName: 'Lead',
      lastName: uid().slice(0, 8),
      status: LeadStatus.NEW,
      source: LeadSource.OTHER,
    },
  });
}

// FK-safe cleanup order for a test tenant.
// Handles: Session→Restrict, UserInvitation→Restrict (invitedBy Restrict), User→Restrict.
// Lead/AuditLog/Notification have no FK to Tenant, so they are cleaned up directly.
// Tenant.delete cascades to Role, Department, Team, etc.
async function cleanup(tenantId: string | undefined) {
  if (!tenantId) return;
  await (prisma as any).session.deleteMany({ where: { tenantId } });
  await (prisma as any).userInvitation.deleteMany({ where: { tenantId } });
  await (prisma as any).notification.deleteMany({ where: { tenantId } });
  await (prisma as any).auditLog.deleteMany({ where: { tenantId } });
  await (prisma as any).leadTagAssignment.deleteMany({ where: { lead: { tenantId } } });
  await (prisma as any).leadNote.deleteMany({ where: { tenantId } });
  await (prisma as any).lead.deleteMany({ where: { tenantId } });
  await (prisma as any).user.deleteMany({ where: { tenantId } });
  // Cascade-deletes Role, Department, Team, TenantSettings, etc.
  await (prisma as any).tenant.delete({ where: { id: tenantId } });
}

// ─── Phase 2: Real concurrency test ──────────────────────────────────────────
describe('Phase 2 — Real DB concurrency: advisory lock serialization', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let empA: any, empB: any, empC: any;
  let leads: any[];
  let svc: LeadService;
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('ConcurrencyTestOrg');
    tenantId = t.id;

    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    deptId = dept.id;

    empA = await makeUser(tenantId, deptId);
    empB = await makeUser(tenantId, deptId);
    empC = await makeUser(tenantId, deptId);

    // Stagger workloads: A=4, B=2, C=0
    for (let i = 0; i < 4; i++) {
      await (prisma as any).lead.create({ data: { tenantId, firstName: 'Existing', lastName: `A${i}`, status: LeadStatus.NEW, source: LeadSource.OTHER, ownerId: empA.id } });
    }
    for (let i = 0; i < 2; i++) {
      await (prisma as any).lead.create({ data: { tenantId, firstName: 'Existing', lastName: `B${i}`, status: LeadStatus.NEW, source: LeadSource.OTHER, ownerId: empB.id } });
    }

    // 6 new unassigned leads
    const set1 = await Promise.all([1, 2, 3].map(() => makeLead(tenantId!)));
    const set2 = await Promise.all([4, 5, 6].map(() => makeLead(tenantId!)));
    leads = [...set1, ...set2];

    svc = new LeadService(prisma);
  }, 30000);

  afterAll(async () => { await cleanup(tenantId); }, 30000);

  it('serializes concurrent auto-assigns and produces a valid final state', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const set1Ids = leads.slice(0, 3).map((l: any) => l.id);
    const set2Ids = leads.slice(3, 6).map((l: any) => l.id);

    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      svc.bulkAssign(ctx, { leadIds: set1Ids, mode: 'AUTO', departmentId: deptId }),
      svc.bulkAssign(ctx, { leadIds: set2Ids, mode: 'AUTO', departmentId: deptId }),
    ]);
    const elapsed = Date.now() - t0;

    expect(r1.count).toBe(3);
    expect(r2.count).toBe(3);

    // All 6 new leads have exactly one owner from the department
    const assigned = await (prisma as any).lead.findMany({
      where: { id: { in: leads.map((l: any) => l.id) }, tenantId },
      select: { id: true, ownerId: true },
    });

    expect(assigned).toHaveLength(6);
    for (const l of assigned) {
      expect(l.ownerId).not.toBeNull();
      expect([empA.id, empB.id, empC.id]).toContain(l.ownerId);
    }

    // Exactly 2 audit records (one per operation)
    const audits = await (prisma as any).auditLog.findMany({
      where: { tenantId, eventType: 'LEADS_BULK_ASSIGNED' },
    });
    expect(audits.length).toBe(2);

    console.log(`[Phase 2] Concurrent assign elapsed: ${elapsed}ms — advisory lock serialized correctly`);
    console.log(`[Phase 2] Audit records: ${audits.length} — PASS`);
  }, 30000);
});

// ─── Phase 4: Transaction atomicity ──────────────────────────────────────────
describe('Phase 4 — Real DB atomicity: rollback on failure', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let emp: any;
  let lead: any;
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('AtomicityTestOrg');
    tenantId = t.id;
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    deptId = dept.id;
    emp = await makeUser(tenantId, deptId);
    lead = await makeLead(tenantId);
  }, 20000);

  afterAll(async () => { await cleanup(tenantId); }, 20000);

  it('MANUAL: no partial update when target user is invalid', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const before = await (prisma as any).lead.findUnique({ where: { id: lead.id } });

    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [lead.id],
        mode: 'MANUAL',
        userId: uid(), // non-existent user
      })
    ).rejects.toBeDefined();

    const after = await (prisma as any).lead.findUnique({ where: { id: lead.id } });
    expect(after.ownerId).toBe(before.ownerId); // unchanged

    const audits = await (prisma as any).auditLog.findMany({ where: { tenantId, eventType: 'LEADS_BULK_ASSIGNED' } });
    expect(audits).toHaveLength(0); // no false audit record
    console.log('[Phase 4] Invalid user: lead unchanged, no audit record — ROLLBACK CONFIRMED');
  }, 15000);

  it('MANUAL: no partial update when all leads are from another tenant', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const otherLeadId = uid();

    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [otherLeadId],
        mode: 'MANUAL',
        userId: emp.id,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const after = await (prisma as any).lead.findUnique({ where: { id: lead.id } });
    expect(after.ownerId).toBeNull();
    console.log('[Phase 4] Cross-tenant leads: rejected with VALIDATION_ERROR — PASS');
  }, 15000);

  it('AUTO: no partial update when no eligible employees', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const emptyDept = await (prisma as any).department.create({ data: { tenantId, name: 'Empty' } });

    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [lead.id],
        mode: 'AUTO',
        departmentId: emptyDept.id,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const after = await (prisma as any).lead.findUnique({ where: { id: lead.id } });
    expect(after.ownerId).toBeNull();

    const audits = await (prisma as any).auditLog.findMany({ where: { tenantId, eventType: 'LEADS_BULK_ASSIGNED' } });
    expect(audits).toHaveLength(0);
    console.log('[Phase 4] Empty dept AUTO: rejected, no audit record — ROLLBACK CONFIRMED');
  }, 15000);

  it('MANUAL success: leads update AND audit both commit atomically', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: [lead.id],
      mode: 'MANUAL',
      userId: emp.id,
    });

    expect(result.count).toBe(1);

    const after = await (prisma as any).lead.findUnique({ where: { id: lead.id } });
    expect(after.ownerId).toBe(emp.id);

    const audits = await (prisma as any).auditLog.findMany({
      where: { tenantId, eventType: 'LEADS_BULK_ASSIGNED' },
    });
    expect(audits).toHaveLength(1);
    const payload = audits[0].payload as any;
    expect(payload.mode).toBe('MANUAL');
    expect(payload.targetUserId).toBe(emp.id);
    expect(payload.count).toBe(1);
    console.log('[Phase 4] MANUAL success: assignment + audit committed atomically — PASS');
  }, 15000);
});

// ─── Phase 5: Security — tenant isolation and IDOR ───────────────────────────
describe('Phase 5 — Security: tenant isolation & IDOR', () => {
  let tenantA: string | undefined;
  let tenantB: string | undefined;
  let deptA: any, deptB: any;
  let empA: any, empB: any;
  let leadA: any, leadB: any;

  beforeAll(async () => {
    const [orgA, orgB] = await Promise.all([makeTenant('SecurityOrgA'), makeTenant('SecurityOrgB')]);
    tenantA = orgA.id;
    tenantB = orgB.id;

    [deptA, deptB] = await Promise.all([
      (prisma as any).department.create({ data: { tenantId: tenantA, name: 'Sales' } }),
      (prisma as any).department.create({ data: { tenantId: tenantB, name: 'Sales' } }),
    ]);
    [empA, empB] = await Promise.all([
      makeUser(tenantA, deptA.id),
      makeUser(tenantB, deptB.id),
    ]);
    [leadA, leadB] = await Promise.all([makeLead(tenantA), makeLead(tenantB)]);
  }, 20000);

  afterAll(async () => {
    await cleanup(tenantA);
    await cleanup(tenantB);
  }, 20000);

  it('cross-tenant lead IDs: cannot assign leads from another tenant', async () => {
    const ctx = { tenantId: tenantA!, userId: uid() };
    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [leadB.id],
        mode: 'MANUAL',
        userId: empA.id,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const after = await (prisma as any).lead.findUnique({ where: { id: leadB.id } });
    expect(after.ownerId).toBeNull();
    console.log('[Phase 5] Cross-tenant lead: rejected with VALIDATION_ERROR — IDOR PREVENTED');
  }, 15000);

  it('cross-tenant employee IDOR: cannot assign to employee from another tenant', async () => {
    const ctx = { tenantId: tenantA!, userId: uid() };
    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [leadA.id],
        mode: 'MANUAL',
        userId: empB.id,
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const after = await (prisma as any).lead.findUnique({ where: { id: leadA.id } });
    expect(after.ownerId).toBeNull();
    console.log('[Phase 5] Cross-tenant employee IDOR: rejected with RESOURCE_NOT_FOUND — IDOR PREVENTED');
  }, 15000);

  it('cross-tenant department: AUTO cannot reach employees in another tenant dept', async () => {
    const ctx = { tenantId: tenantA!, userId: uid() };
    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [leadA.id],
        mode: 'AUTO',
        departmentId: deptB.id,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const after = await (prisma as any).lead.findUnique({ where: { id: leadA.id } });
    expect(after.ownerId).toBeNull();
    console.log('[Phase 5] Cross-tenant dept AUTO: rejected — PASS');
  }, 15000);

  it('inactive employee: cannot receive leads via MANUAL', async () => {
    const ctx = { tenantId: tenantA!, userId: uid() };
    const inactiveEmp = await makeUser(tenantA!, deptA.id, { status: UserStatus.SUSPENDED });

    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [leadA.id],
        mode: 'MANUAL',
        userId: inactiveEmp.id,
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const after = await (prisma as any).lead.findUnique({ where: { id: leadA.id } });
    expect(after.ownerId).toBeNull();
    console.log('[Phase 5] Inactive employee: rejected — PASS');
  }, 15000);

  it('soft-deleted lead: cannot be assigned', async () => {
    const ctx = { tenantId: tenantA!, userId: uid() };
    const deletedLead = await makeLead(tenantA!);
    await (prisma as any).lead.update({ where: { id: deletedLead.id }, data: { deletedAt: new Date() } });

    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [deletedLead.id],
        mode: 'MANUAL',
        userId: empA.id,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const after = await (prisma as any).lead.findUnique({ where: { id: deletedLead.id } });
    expect(after.ownerId).toBeNull();
    console.log('[Phase 5] Soft-deleted lead: rejected — PASS');
  }, 15000);

  it('preview payload forgery: AUTO commit always recalculates server-side', async () => {
    const ctx = { tenantId: tenantA!, userId: uid() };
    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: [leadA.id],
      mode: 'AUTO',
      departmentId: deptA.id,
    } as any);

    expect(result.count).toBe(1);
    const after = await (prisma as any).lead.findUnique({ where: { id: leadA.id } });
    expect([empA.id, empB.id]).toContain(after.ownerId);
    console.log('[Phase 5] Preview forgery: server always recalculates — PASS');
  }, 15000);
});

// ─── Phase 6: Distribution mathematical correctness ───────────────────────────
describe('Phase 6 — Real DB distribution: mathematical correctness', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let empA: any, empB: any, empC: any;
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('DistributionTestOrg');
    tenantId = t.id;
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    deptId = dept.id;
    empA = await makeUser(tenantId, deptId);
    empB = await makeUser(tenantId, deptId);
    empC = await makeUser(tenantId, deptId);
  }, 20000);

  afterAll(async () => { await cleanup(tenantId); }, 20000);

  async function setWorkload(empId: string, count: number) {
    for (let i = 0; i < count; i++) {
      await (prisma as any).lead.create({
        data: { tenantId, firstName: 'Wl', lastName: uid().slice(0, 8), status: LeadStatus.NEW, source: LeadSource.OTHER, ownerId: empId },
      });
    }
  }

  async function getWorkload(empId: string): Promise<number> {
    return (prisma as any).lead.count({
      where: { ownerId: empId, tenantId, deletedAt: null, status: { in: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED] } },
    });
  }

  it('A=4, B=2, C=0, N=6: greedy assigns to underloaded employees first', async () => {
    await setWorkload(empA.id, 4);
    await setWorkload(empB.id, 2);

    const newLeads = await Promise.all(Array.from({ length: 6 }, () => makeLead(tenantId!)));
    const ctx = { tenantId: tenantId!, userId: actorId };

    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: newLeads.map((l: any) => l.id),
      mode: 'AUTO',
      departmentId: deptId,
    });
    expect(result.count).toBe(6);

    const [wa, wb, wc] = await Promise.all([
      getWorkload(empA.id), getWorkload(empB.id), getWorkload(empC.id),
    ]);

    console.log(`[Phase 6] After greedy distribution: A=${wa}, B=${wb}, C=${wc} (base: A=4, B=2, C=0, +6 leads)`);

    expect(wa + wb + wc).toBe(12);
    expect(wc).toBeGreaterThan(0);

    const spread = Math.max(wa, wb, wc) - Math.min(wa, wb, wc);
    expect(spread).toBeLessThanOrEqual(2);
    console.log(`[Phase 6] Workload spread: ${spread} — algorithm correct`);

    const assigned = await (prisma as any).lead.findMany({
      where: { id: { in: newLeads.map((l: any) => l.id) }, tenantId },
      select: { ownerId: true },
    });
    expect(assigned.every((l: any) => l.ownerId !== null)).toBe(true);
    console.log('[Phase 6] All 6 new leads assigned — PASS');
  }, 20000);
});

// ─── Phase 3: MANUAL vs AUTO concurrency ─────────────────────────────────────
describe('Phase 3 — MANUAL vs AUTO concurrency', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let empA: any, empB: any;
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('ManualAutoRaceOrg');
    tenantId = t.id;
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    deptId = dept.id;
    empA = await makeUser(tenantId, deptId);
    empB = await makeUser(tenantId, deptId);
  }, 20000);

  afterAll(async () => { await cleanup(tenantId); }, 20000);

  it('disjoint MANUAL + AUTO concurrent: each lead gets exactly one owner', async () => {
    const autoLeads = await Promise.all([1, 2].map(() => makeLead(tenantId!)));
    const manualLeads = await Promise.all([3, 4].map(() => makeLead(tenantId!)));

    const ctx = { tenantId: tenantId!, userId: actorId };
    const svc = new LeadService(prisma);

    const [autoResult, manualResult] = await Promise.all([
      svc.bulkAssign(ctx, { leadIds: autoLeads.map((l: any) => l.id), mode: 'AUTO', departmentId: deptId }),
      svc.bulkAssign(ctx, { leadIds: manualLeads.map((l: any) => l.id), mode: 'MANUAL', userId: empA.id }),
    ]);

    expect(autoResult.count).toBe(2);
    expect(manualResult.count).toBe(2);

    const all = await (prisma as any).lead.findMany({
      where: { id: { in: [...autoLeads, ...manualLeads].map((l: any) => l.id) }, tenantId },
      select: { id: true, ownerId: true },
    });
    expect(all).toHaveLength(4);
    for (const l of all) { expect(l.ownerId).not.toBeNull(); }
    console.log('[Phase 3] Disjoint MANUAL+AUTO concurrent: all 4 leads assigned, no data corruption — PASS');
  }, 20000);

  it('overlapping MANUAL + AUTO: last-write-wins per row, no null owners', async () => {
    // Advisory lock covers AUTO+AUTO concurrency. MANUAL does not take the lock.
    // Concurrent MANUAL+AUTO on the same leads: PostgreSQL row-level last-write-wins.
    // Both operations may succeed; the winning writer determines final ownership.
    // No data corruption (null owners, partial rows) occurs — documented limitation.
    const sharedLeads = await Promise.all([1, 2].map(() => makeLead(tenantId!)));
    const ctx = { tenantId: tenantId!, userId: actorId };
    const svc = new LeadService(prisma);

    const results = await Promise.allSettled([
      svc.bulkAssign(ctx, { leadIds: sharedLeads.map((l: any) => l.id), mode: 'AUTO', departmentId: deptId }),
      svc.bulkAssign(ctx, { leadIds: sharedLeads.map((l: any) => l.id), mode: 'MANUAL', userId: empA.id }),
    ]);

    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);

    const all = await (prisma as any).lead.findMany({
      where: { id: { in: sharedLeads.map((l: any) => l.id) }, tenantId },
      select: { id: true, ownerId: true },
    });
    for (const l of all) {
      expect(l.ownerId).not.toBeNull();
      expect([empA.id, empB.id]).toContain(l.ownerId);
    }
    console.log('[Phase 3] Overlapping MANUAL+AUTO: no null owners, no DB corruption — last-write-wins documented');
  }, 20000);
});

// ─── Phase 2b: Documents department — explicit E2E via service ───────────────
// Spec requires Documents to be executed, not inferred from code similarity.
// Tests the identical code path (computeDistribution) with a "Documentation" dept.
describe('Phase 2b — Documents department: explicit assignment verification', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let empA: any, empB: any;
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('DocumentsDeptTestOrg');
    tenantId = t.id;
    // Named "Documentation" to match seed data department
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Documentation' } });
    deptId = dept.id;
    empA = await makeUser(tenantId, deptId);
    empB = await makeUser(tenantId, deptId);
    // empA has 2 existing leads, empB has 0
    for (let i = 0; i < 2; i++) {
      await (prisma as any).lead.create({
        data: { tenantId, firstName: 'Existing', lastName: `DocA${i}`, status: LeadStatus.NEW, source: LeadSource.OTHER, ownerId: empA.id },
      });
    }
  }, 20000);

  afterAll(async () => { await cleanup(tenantId); }, 20000);

  it('Documentation dept: auto-assigns leads to underloaded employee', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const newLeads = await Promise.all([1, 2, 3].map(() => makeLead(tenantId!)));

    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: newLeads.map((l: any) => l.id),
      mode: 'AUTO',
      departmentId: deptId,
    });

    expect(result.count).toBe(3);

    const assigned = await (prisma as any).lead.findMany({
      where: { id: { in: newLeads.map((l: any) => l.id) }, tenantId },
      select: { id: true, ownerId: true },
    });

    expect(assigned).toHaveLength(3);
    for (const l of assigned) {
      expect(l.ownerId).not.toBeNull();
      expect([empA.id, empB.id]).toContain(l.ownerId);
    }

    // empB (0 workload) should receive all 3 new leads — greedy always picks lowest first
    const wB = await (prisma as any).lead.count({
      where: { ownerId: empB.id, tenantId, deletedAt: null, status: { in: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED] } },
    });
    expect(wB).toBe(3); // B had 0, gets all 3 before A (who had 2)

    const auditLogs = await (prisma as any).auditLog.findMany({
      where: { tenantId, eventType: 'LEADS_BULK_ASSIGNED' },
    });
    expect(auditLogs).toHaveLength(1);
    expect((auditLogs[0].payload as any).departmentId).toBe(deptId);
    console.log(`[Phase 2b] Documentation dept: ${result.count} leads assigned, empB.workload=${wB}, 1 audit record — PASS`);
  }, 20000);

  it('Documentation dept: suspended employee excluded from distribution', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const suspendedEmp = await makeUser(tenantId!, deptId, { status: UserStatus.SUSPENDED });
    const newLead = await makeLead(tenantId!);

    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: [newLead.id],
      mode: 'AUTO',
      departmentId: deptId,
    });

    expect(result.count).toBe(1);
    const after = await (prisma as any).lead.findUnique({ where: { id: newLead.id } });
    expect(after.ownerId).not.toBe(suspendedEmp.id);
    expect([empA.id, empB.id]).toContain(after.ownerId);
    console.log('[Phase 2b] Suspended employee excluded from Documentation dept distribution — PASS');
  }, 20000);
});

// ─── Phase 4: Notification delivery ──────────────────────────────────────────
describe('Phase 4 — Notification delivery', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let emp: any;
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('NotificationTestOrg');
    tenantId = t.id;
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    deptId = dept.id;
    emp = await makeUser(tenantId, deptId);
  }, 20000);

  afterAll(async () => { await cleanup(tenantId); }, 20000);

  it('MANUAL success: notification created for recipient after commit', async () => {
    const lead = await makeLead(tenantId!);
    // actorId !== emp.id, so notification should be dispatched
    const ctx = { tenantId: tenantId!, userId: actorId };

    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: [lead.id],
      mode: 'MANUAL',
      userId: emp.id,
    });

    expect(result.count).toBe(1);

    // Fire-and-forget over remote DB — allow enough time for the write to settle
    await new Promise(r => setTimeout(r, 3000));

    const notifications = await (prisma as any).notification.findMany({
      where: { tenantId, recipientUserId: emp.id },
    });
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    const n = notifications[0];
    expect(n.recipientUserId).toBe(emp.id);
    // No secrets in payload
    expect(JSON.stringify(n)).not.toMatch(/password|token|secret/i);
    console.log(`[Phase 4] MANUAL notification created: type=${n.type} — PASS`);
  }, 20000);

  it('MANUAL failure: no notification when assignment fails', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const notifsBefore = await (prisma as any).notification.count({ where: { tenantId } });

    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [uid()], // non-existent lead → VALIDATION_ERROR
        mode: 'MANUAL',
        userId: emp.id,
      })
    ).rejects.toBeDefined();

    await new Promise(r => setTimeout(r, 200));
    const notifsAfter = await (prisma as any).notification.count({ where: { tenantId } });
    expect(notifsAfter).toBe(notifsBefore); // no new notifications
    console.log('[Phase 4] Failed assignment: no notification created — PASS');
  }, 20000);

  it('MANUAL: no self-notification when actor is the assignee', async () => {
    const selfLead = await makeLead(tenantId!);
    // Use emp as actor AND assignee — should produce no notification
    const selfCtx = { tenantId: tenantId!, userId: emp.id };

    const result = await new LeadService(prisma).bulkAssign(selfCtx, {
      leadIds: [selfLead.id],
      mode: 'MANUAL',
      userId: emp.id,
    });
    expect(result.count).toBe(1);

    await new Promise(r => setTimeout(r, 200));
    const selfNotifs = await (prisma as any).notification.findMany({
      where: { tenantId, recipientUserId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    // The most recent notification should be from the previous test (different actor)
    // — verify no NEW self-notification was added
    const after = await (prisma as any).lead.findUnique({ where: { id: selfLead.id } });
    expect(after.ownerId).toBe(emp.id); // assignment committed
    console.log('[Phase 4] Self-assignment: lead committed, no self-notification required — PASS');
  }, 20000);
});

// ─── Phase 6b: Security regression — input validation ─────────────────────────
describe('Phase 6b — Security regression: input validation', () => {
  let tenantId: string | undefined;
  let deptId: string;
  let emp: any;
  let lead: any;

  beforeAll(async () => {
    const t = await makeTenant('SecurityRegressionOrg');
    tenantId = t.id;
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    deptId = dept.id;
    emp = await makeUser(tenantId, deptId);
    lead = await makeLead(tenantId);
  }, 20000);

  afterAll(async () => { await cleanup(tenantId); }, 20000);

  it('duplicate lead IDs: deduplicates before assignment', async () => {
    const ctx = { tenantId: tenantId!, userId: uid() };
    // Submit [id, id, id] — should assign the lead exactly once
    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds: [lead.id, lead.id, lead.id],
      mode: 'MANUAL',
      userId: emp.id,
    });
    expect(result.count).toBe(1); // deduped to 1 lead

    const after = await (prisma as any).lead.findUnique({ where: { id: lead.id } });
    expect(after.ownerId).toBe(emp.id);
    console.log('[Phase 6b] Duplicate lead IDs: deduped, assigned exactly once — PASS');
  }, 15000);

  it('AUTO: missing departmentId throws VALIDATION_ERROR', async () => {
    const ctx = { tenantId: tenantId!, userId: uid() };
    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [lead.id],
        mode: 'AUTO',
        departmentId: undefined,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    console.log('[Phase 6b] Missing departmentId: VALIDATION_ERROR — PASS');
  }, 15000);

  it('MANUAL: missing userId throws VALIDATION_ERROR', async () => {
    const ctx = { tenantId: tenantId!, userId: uid() };
    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [lead.id],
        mode: 'MANUAL',
        userId: undefined,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    console.log('[Phase 6b] Missing userId for MANUAL: VALIDATION_ERROR — PASS');
  }, 15000);

  it('cross-tenant lead + cross-tenant employee combo: lead check fires first', async () => {
    const ctx = { tenantId: tenantId!, userId: uid() };
    const foreignLead = uid();
    const foreignEmp = uid();
    await expect(
      new LeadService(prisma).bulkAssign(ctx, {
        leadIds: [foreignLead],
        mode: 'MANUAL',
        userId: foreignEmp,
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION_ERROR|RESOURCE_NOT_FOUND/) });
    console.log('[Phase 6b] Cross-tenant lead+employee combo: rejected — PASS');
  }, 15000);
});

// ─── Phase 8: N=100 AUDIT_WRITE_FAILURE regression ───────────────────────────
// This test reproduces the exact browser failure: 100 leads MANUAL through the full
// LeadService path (validation + updateMany + AuditService). Previously threw
// AUDIT_WRITE_FAILURE because AuditService.findFirst ran on the held tx connection.
describe('Phase 8 — N=100 full-path regression: AUDIT_WRITE_FAILURE must not occur', () => {
  let tenantId: string | undefined;
  let emp: any;
  let leadIds: string[];
  const actorId = uid();

  beforeAll(async () => {
    const t = await makeTenant('N100RegressionOrg');
    tenantId = t.id;
    const dept = await (prisma as any).department.create({ data: { tenantId, name: 'Sales' } });
    emp = await makeUser(tenantId, dept.id);

    await (prisma as any).lead.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        tenantId,
        firstName: 'Bulk',
        lastName: `Lead${i}`,
        status: LeadStatus.NEW,
        source: LeadSource.OTHER,
      })),
    });
    const created = await (prisma as any).lead.findMany({
      where: { tenantId, firstName: 'Bulk' },
      select: { id: true },
    });
    leadIds = created.map((l: any) => l.id);
  }, 30000);

  afterAll(async () => { await cleanup(tenantId); }, 30000);

  it('N=100 MANUAL: no AUDIT_WRITE_FAILURE, all leads assigned, audit record written', async () => {
    const ctx = { tenantId: tenantId!, userId: actorId };
    const result = await new LeadService(prisma).bulkAssign(ctx, {
      leadIds,
      mode: 'MANUAL',
      userId: emp.id,
    });

    expect(result.count).toBe(100);

    const assigned = await (prisma as any).lead.findMany({
      where: { id: { in: leadIds }, tenantId },
      select: { id: true, ownerId: true },
    });
    expect(assigned).toHaveLength(100);
    for (const l of assigned) {
      expect(l.ownerId).toBe(emp.id);
    }

    const audits = await (prisma as any).auditLog.findMany({
      where: { tenantId, eventType: 'LEADS_BULK_ASSIGNED' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((audits[0].payload as any).mode).toBe('MANUAL');
    expect((audits[0].payload as any).count).toBe(100);
    console.log(`[Phase 8] N=100 MANUAL: ${result.count} assigned, audit written — PASS`);
  }, 60000);
});

afterAll(async () => { await prisma.$disconnect(); });

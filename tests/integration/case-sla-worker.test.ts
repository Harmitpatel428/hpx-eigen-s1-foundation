/**
 * Phase 9 Task 4 — periodic SLA worker (runSlaSweep). Real Postgres, fixed injected `now`,
 * fabricated stages built directly via prisma. Covers classification per boundary,
 * hard-block transition + audit, unlock/exception non-block, edge-triggered notifications
 * + idempotency + retry-on-failure, recipient dedupe, isRunning guard, tenant grouping.
 */
import 'dotenv/config';
import { describe, it, beforeEach, afterEach, afterAll, expect, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as bcryptjs from 'bcryptjs';
import { PrismaClient, UserStatus, CaseTypeStatus, CaseStageStatus, CaseStageSlaState } from '@prisma/client';

import { runSlaSweep } from '../../src/workers/sla.worker';
import { NotificationService } from '../../src/services/notification.service';
import { AuditService } from '../../src/services/audit.service';

const prisma = new PrismaClient();
const uid = () => crypto.randomUUID();

// Fixed clock for every scenario.
const NOW = new Date('2026-06-15T12:00:00.000Z');
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
// Date windows relative to NOW (2026-06-15).
const ON_TRACK = { plannedStart: d('2026-06-15'), plannedFinish: d('2026-07-15') };
const AT_RISK = { plannedStart: d('2026-06-01'), plannedFinish: d('2026-06-17') }; // 87.5% elapsed
const OVERDUE = { plannedStart: d('2026-06-01'), plannedFinish: d('2026-06-10') }; // past finish

const tenants: string[] = [];

async function mkTenant() {
  const tenantId = uid();
  tenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: 'T' } });
  const userId = uid();
  await prisma.user.create({ data: { id: userId, tenantId, email: `sw-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE } });
  return { tenantId, userId };
}

async function mkUser(tenantId: string) {
  const id = uid();
  await prisma.user.create({ data: { id, tenantId, email: `sw-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE } });
  return id;
}

interface StageOpts {
  status?: CaseStageStatus;
  plannedStart?: Date | null;
  plannedFinish?: Date | null;
  hardBlock?: boolean;
  hardBlockUnlockedAt?: Date | null;
  exceptionApproved?: boolean;
  slaState?: CaseStageSlaState | null;
  slaNotifiedForState?: CaseStageSlaState | null;
  assignedTo?: string | null;
  createdBy?: string;
}

async function mkStage(tenantId: string, defaultUser: string, opts: StageOpts = {}) {
  const type = await prisma.caseType.create({ data: { tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } });
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  const kase = await prisma.docCase.create({ data: { tenantId, leadId: lead.id, caseTypeId: type.id, createdBy: opts.createdBy ?? defaultUser, assignedTo: opts.assignedTo ?? null }, select: { id: true, updatedAt: true } });
  const tl = await prisma.caseTimeline.create({ data: { tenantId, caseId: kase.id, caseTypeId: type.id, status: 'ACTIVE', exceptionApproved: opts.exceptionApproved ?? false }, select: { id: true } });
  const stage = await prisma.caseStage.create({
    data: {
      tenantId, timelineId: tl.id, key: `s_${uid().slice(0, 8)}`, label: 'S',
      status: opts.status ?? CaseStageStatus.IN_PROGRESS,
      plannedStart: opts.plannedStart ?? null,
      plannedFinish: opts.plannedFinish ?? null,
      hardBlock: opts.hardBlock ?? false,
      hardBlockUnlockedAt: opts.hardBlockUnlockedAt ?? null,
      slaState: opts.slaState ?? null,
      slaNotifiedForState: opts.slaNotifiedForState ?? null,
    },
    select: { id: true },
  });
  return { caseId: kase.id, stageId: stage.id, caseUpdatedAt: kase.updatedAt };
}

const readStage = (id: string) => prisma.caseStage.findUniqueOrThrow({ where: { id } });
const notifCount = (tenantId: string, recipientUserId: string) => prisma.notification.count({ where: { tenantId, recipientUserId } });
const blockedAudit = (tenantId: string, stageId: string) => prisma.auditLog.count({ where: { tenantId, entityId: stageId, eventType: 'CASE_STAGE_BLOCKED' } });

beforeEach(() => { tenants.length = 0; });

afterEach(async () => {
  for (const t of tenants) {
    await prisma.notification.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStageEvent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStage.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTimeline.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.updateMany({ where: { tenantId: t }, data: { caseTypeId: null } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
});

afterAll(async () => { await prisma.$disconnect(); });

describe('classification per boundary', () => {
  it('ON_TRACK / AT_RISK / OVERDUE', async () => {
    const { tenantId, userId } = await mkTenant();
    const on = await mkStage(tenantId, userId, { ...ON_TRACK });
    const at = await mkStage(tenantId, userId, { ...AT_RISK });
    const ov = await mkStage(tenantId, userId, { ...OVERDUE });
    await runSlaSweep(prisma, NOW);
    expect((await readStage(on.stageId)).slaState).toBe('ON_TRACK');
    expect((await readStage(at.stageId)).slaState).toBe('AT_RISK');
    expect((await readStage(ov.stageId)).slaState).toBe('OVERDUE');
  });

  it('WAITING_EXTERNAL stays WAITING_EXTERNAL (status unchanged)', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { status: CaseStageStatus.WAITING_EXTERNAL, ...OVERDUE });
    await runSlaSweep(prisma, NOW);
    const row = await readStage(s.stageId);
    expect(row.slaState).toBe('WAITING_EXTERNAL');
    expect(row.status).toBe('WAITING_EXTERNAL');
  });

  it('exceptionApproved → EXCEPTION_APPROVED, not OVERDUE, and NOT blocked', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...OVERDUE, hardBlock: true, exceptionApproved: true });
    await runSlaSweep(prisma, NOW);
    const row = await readStage(s.stageId);
    expect(row.slaState).toBe('EXCEPTION_APPROVED');
    expect(row.status).not.toBe('BLOCKED');
    expect(await blockedAudit(tenantId, s.stageId)).toBe(0);
  });
});

describe('hard block transition', () => {
  it('hardBlock + OVERDUE → status BLOCKED + CASE_STAGE_BLOCKED audit + event, no DocCase write', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...OVERDUE, status: CaseStageStatus.IN_PROGRESS, hardBlock: true });
    const changed = await runSlaSweep(prisma, NOW);
    expect(changed).toBe(1);
    const row = await readStage(s.stageId);
    expect(row.status).toBe('BLOCKED');
    expect(row.slaState).toBe('OVERDUE');
    expect(await blockedAudit(tenantId, s.stageId)).toBe(1);
    const ev = await prisma.caseStageEvent.findFirst({ where: { tenantId, stageId: s.stageId, eventType: 'BLOCKED' } });
    expect(ev).toMatchObject({ fromStatus: 'IN_PROGRESS', toStatus: 'BLOCKED', actorUserId: null });
    // No DocCase write.
    const kase = await prisma.docCase.findUniqueOrThrow({ where: { id: s.caseId }, select: { updatedAt: true } });
    expect(kase.updatedAt.getTime()).toBe(s.caseUpdatedAt.getTime());
  });

  it('never re-blocks after unlock (hardBlockUnlockedAt set → stays out of BLOCKED though OVERDUE)', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...OVERDUE, status: CaseStageStatus.READY, hardBlock: true, hardBlockUnlockedAt: new Date('2026-06-14T00:00:00.000Z') });
    await runSlaSweep(prisma, NOW);
    const row = await readStage(s.stageId);
    expect(row.status).toBe('READY');
    expect(row.slaState).toBe('OVERDUE');
    expect(await blockedAudit(tenantId, s.stageId)).toBe(0);
  });

  it('exception approval after block does NOT auto-unblock (pre-BLOCKED stays BLOCKED)', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...OVERDUE, status: CaseStageStatus.BLOCKED, hardBlock: true, exceptionApproved: true });
    await runSlaSweep(prisma, NOW);
    const row = await readStage(s.stageId);
    expect(row.status).toBe('BLOCKED');
    expect(row.slaState).toBe('EXCEPTION_APPROVED');
  });
});

describe('edge-triggered notifications', () => {
  it('first tick into AT_RISK → ONE notification + slaNotifiedForState set', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...AT_RISK, assignedTo: null, createdBy: userId });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(1);
    const n = await prisma.notification.findFirstOrThrow({ where: { tenantId, recipientUserId: userId } });
    expect(n.type).toBe('CASE_STAGE_AT_RISK');
    expect(n.message).toContain('Stage "S" on case ');
    expect(n.message).toContain('at risk');
    expect(n.actionUrl).toBe(`/documentation/cases/${s.caseId}`);
    const row = await readStage(s.stageId);
    expect(row.slaState).toBe('AT_RISK');
    expect(row.slaNotifiedForState).toBe('AT_RISK');
  });

  it('second tick same clock → idempotent: 0 new notifications, 0 slaState changes', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...AT_RISK });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(1);
    const changed = await runSlaSweep(prisma, NOW); // only this tenant's fixtures exist
    expect(changed).toBe(0);
    expect(await notifCount(tenantId, userId)).toBe(1);
    expect((await readStage(s.stageId)).slaState).toBe('AT_RISK');
  });

  it('AT_RISK → OVERDUE transition emits a new notification', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...AT_RISK });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(1);
    // Push the stage overdue and sweep again at the same clock.
    await prisma.caseStage.update({ where: { id: s.stageId }, data: { plannedFinish: OVERDUE.plannedFinish } });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(2);
    const row = await readStage(s.stageId);
    expect(row.slaState).toBe('OVERDUE');
    expect(row.slaNotifiedForState).toBe('OVERDUE');
    const overdueNotifs = await prisma.notification.count({ where: { tenantId, recipientUserId: userId, type: 'CASE_STAGE_OVERDUE' } });
    expect(overdueNotifs).toBe(1);
  });

  it('recovers to ON_TRACK → slaNotifiedForState cleared, no notify; re-entering AT_RISK notifies AGAIN', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...AT_RISK });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(1);
    await prisma.caseStage.update({ where: { id: s.stageId }, data: { plannedFinish: ON_TRACK.plannedFinish, plannedStart: ON_TRACK.plannedStart } });
    await runSlaSweep(prisma, NOW);
    const rec = await readStage(s.stageId);
    expect(rec.slaState).toBe('ON_TRACK');
    expect(rec.slaNotifiedForState).toBeNull();
    expect(await notifCount(tenantId, userId)).toBe(1);
    await prisma.caseStage.update({ where: { id: s.stageId }, data: { plannedFinish: AT_RISK.plannedFinish, plannedStart: AT_RISK.plannedStart } });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(2);
    expect((await readStage(s.stageId)).slaNotifiedForState).toBe('AT_RISK');
  });

  it('notification failure → slaState still written, sweep continues, slaNotifiedForState NOT advanced', async () => {
    const { tenantId, userId } = await mkTenant();
    const s = await mkStage(tenantId, userId, { ...AT_RISK });
    const spy = jest.spyOn(NotificationService.prototype, 'createMany').mockRejectedValue(new Error('boom'));
    try {
      const changed = await runSlaSweep(prisma, NOW);
      expect(changed).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const row = await readStage(s.stageId);
    expect(row.slaState).toBe('AT_RISK');            // state committed
    expect(row.slaNotifiedForState).toBeNull();      // not advanced → retries
    expect(await notifCount(tenantId, userId)).toBe(0);
  });

  it('recipient dedupe: assignedTo === createdBy → one notification', async () => {
    const { tenantId, userId } = await mkTenant();
    await mkStage(tenantId, userId, { ...AT_RISK, assignedTo: userId, createdBy: userId });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(1);
  });

  it('distinct assignedTo + createdBy → both notified', async () => {
    const { tenantId, userId } = await mkTenant();
    const other = await mkUser(tenantId);
    await mkStage(tenantId, userId, { ...AT_RISK, assignedTo: other, createdBy: userId });
    await runSlaSweep(prisma, NOW);
    expect(await notifCount(tenantId, userId)).toBe(1);
    expect(await notifCount(tenantId, other)).toBe(1);
  });
});

describe('isRunning guard', () => {
  it('re-entrant call returns 0 while a sweep is in flight', async () => {
    const { tenantId, userId } = await mkTenant();
    await mkStage(tenantId, userId, { ...AT_RISK });
    const [a, b] = await Promise.all([runSlaSweep(prisma, NOW), runSlaSweep(prisma, NOW)]);
    expect([a, b].sort((x, y) => x - y)).toEqual([0, 1]);
  });
});

describe('tenant grouping / scoping', () => {
  it('each tenant swept in its own group; notifications scoped to the right tenant', async () => {
    const A = await mkTenant();
    const B = await mkTenant();
    const a = await mkStage(A.tenantId, A.userId, { ...AT_RISK });
    const b = await mkStage(B.tenantId, B.userId, { ...OVERDUE });
    await runSlaSweep(prisma, NOW);
    expect((await readStage(a.stageId)).slaState).toBe('AT_RISK');
    expect((await readStage(b.stageId)).slaState).toBe('OVERDUE');
    // A's user only has A-tenant notifications; none leak across tenants.
    expect(await notifCount(A.tenantId, A.userId)).toBe(1);
    expect(await notifCount(B.tenantId, A.userId)).toBe(0);
    expect(await notifCount(B.tenantId, B.userId)).toBe(1);
  });
});

describe('per-tenant error isolation', () => {
  // Injection point: spy AuditService.prototype.appendInTx (a prototype method, which SWC keeps
  // spyable — unlike a module's named function export) so it throws whenever the worker writes a
  // CASE_STAGE_BLOCKED audit. Among this test's tenants that write happens ONLY for tenant A, the
  // only one with a hardBlock + OVERDUE stage: A's per-tenant $transaction therefore rolls back.
  // Tenant B has a plain OVERDUE stage (hardBlock:false) → no appendInTx → its tx commits.
  // The other ~59 tenants in the shared .env.test DB never enter this block, so assertions are
  // strictly tenant-scoped (only A's and B's stages) — no global `changed` or spy-count checks.
  it('a failing tenant does not abort other tenants (tenant-scoped assertions only)', async () => {
    const A = await mkTenant();
    const B = await mkTenant();
    const a = await mkStage(A.tenantId, A.userId, { ...OVERDUE, hardBlock: true });
    const b = await mkStage(B.tenantId, B.userId, { ...OVERDUE, hardBlock: false });
    const spy = jest.spyOn(AuditService.prototype, 'appendInTx').mockImplementation(() => {
      throw new Error('tenant A audit boom');
    });
    try {
      await runSlaSweep(prisma, NOW); // must not throw
    } finally {
      spy.mockRestore();
    }
    const rowA = await readStage(a.stageId);
    expect(rowA.slaState).toBeNull();                    // A's tx rolled back → slaState untouched
    expect(rowA.status).not.toBe('BLOCKED');             // block rolled back too
    expect((await readStage(b.stageId)).slaState).toBe('OVERDUE'); // B committed despite A failing
  });
});

/**
 * Phase 7 — planning engine over the real timeline endpoints. Real Postgres.
 * Covers: target set/change/clear + audit; recalc endpoint + response shape; baseline set once
 * and preserved across target changes and repeated recalc; recalc fires on every Phase 6 transition
 * (start/complete/skip/reopen) inside the same tx; duration override recompute + CaseStageEvent +
 * audit; exception approval perm (403) + reason (422); calendar edit does not change persisted dates
 * until next recalc; tenant isolation; flag-disabled gate.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseTypeStatus, CaseStageDurationType } from '@prisma/client';

import { createCaseTimelineRouter, createCaseStageActionsRouter } from '../../src/routes/case-timeline.router';
import { PermissionService } from '../../src/services/permission.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const uid = () => crypto.randomUUID();

let server: http.Server; let baseUrl: string;
const tracked: string[] = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cases/:caseId/timeline', createCaseTimelineRouter(prisma));
  app.use('/api/v1/cases/:caseId/stages', createCaseStageActionsRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: String(err) });
  });
  return app;
}
async function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
async function makeUser(tenantId: string) {
  return prisma.user.create({ data: { id: uid(), tenantId, email: `pl-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
}
async function makeSession(userId: string, tenantId: string) {
  const sid = uid();
  await prisma.session.create({ data: { id: sid, userId, tenantId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  return jwt.sign({ sessionId: sid, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}
async function permId(slug: string) { const p = await prisma.permission.findFirst({ where: { slug } }); if (!p) throw new Error(`${slug} not seeded`); return p.id; }
async function grant(tenantId: string, slugs: string[]) {
  const user = await makeUser(tenantId);
  const role = await prisma.role.create({ data: { tenantId, name: `R-${uid().slice(0, 8)}` } });
  for (const s of slugs) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(s) } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { id: user.id, token: await makeSession(user.id, tenantId) };
}
async function makeType(tenantId: string) {
  return prisma.caseType.create({ data: { tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } });
}
async function makeCase(tenantId: string, createdBy: string, caseTypeId: string) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy, caseTypeId }, select: { id: true } });
}

const ALL = ['case-timeline:view', 'case-timeline:manage', 'case-stage:start', 'case-stage:complete', 'case-stage:skip', 'case-stage:reopen', 'case-stage:pause', 'case-stage:resume', 'case-stage:override', 'case-exception:approve'];

let tenantId: string, otherTenantId: string, disabledTenantId: string;
let admin: { id: string; token: string }, noException: { token: string }, otherAdmin: { token: string }, disabledAdmin: { token: string };

const TL = (caseId: string) => `/api/v1/cases/${caseId}/timeline`;
const SG = (caseId: string) => `/api/v1/cases/${caseId}/stages`;

// Create an ACTIVE type with n dependent DAYS stages (durationValue 3) + a case with a timeline.
async function withTimeline(over: any[] = []) {
  const type = await makeType(tenantId);
  const n = Math.max(over.length, 1);
  for (let i = 0; i < n; i++) {
    await prisma.caseStageTemplate.create({ data: { tenantId, caseTypeId: type.id, key: `s_${uid().slice(0, 8)}`, label: `S${i}`, sequence: i, durationValue: 3, durationType: CaseStageDurationType.DAYS, ...(over[i] ?? {}) } });
  }
  const c = await makeCase(tenantId, admin.id, type.id);
  const created = await req('POST', TL(c.id), { token: admin.token });
  expect(created.status).toBe(201);
  return { caseId: c.id, stages: created.body.data.stages as any[] };
}

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  admin = await grant(tenantId, ALL);
  noException = await grant(tenantId, ALL.filter((s) => s !== 'case-exception:approve'));
  otherAdmin = await grant(otherTenantId, ALL);
  disabledAdmin = await grant(disabledTenantId, ALL);

  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.calendarHoliday.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.workingCalendar.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStageEvent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStage.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTimeline.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStageTemplate.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.updateMany({ where: { tenantId: t }, data: { caseTypeId: null } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId: t } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId: t } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenantSettings.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

describe('recalc endpoint + response shape', () => {
  it('recalc returns feasible/deficit/target/stages and populates planned dates + audit', async () => {
    const { caseId, stages } = await withTimeline([{}, {}]);
    const r = await req('POST', `${TL(caseId)}/recalc`, { token: admin.token });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty('feasible');
    expect(r.body.data).toHaveProperty('deficitDays');
    expect(r.body.data).toHaveProperty('targetDate', null);
    expect(r.body.data.feasible).toBeNull(); // no target set
    const s0 = r.body.data.stages.find((s: any) => s.stageId === stages[0].id);
    expect(s0).toMatchObject({ key: expect.any(String) });
    expect(s0.plannedStart).not.toBeNull();
    expect(s0.plannedFinish).not.toBeNull();
    expect(s0.latestStart).toBeNull(); // no target → no reverse
    expect(s0.slackDays).toBeNull();
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TIMELINE_RECALCULATED' } })).toBeGreaterThanOrEqual(1);
    // persisted on the row
    const persisted = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { plannedStart: true } });
    expect(persisted?.plannedStart).not.toBeNull();
  });
});

describe('target set / change / clear', () => {
  it('set → feasible computed + audit SET; clear → dates null + audit CLEARED', async () => {
    const { caseId } = await withTimeline([{}, {}]);
    const set = await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2027-01-15' } });
    expect(set.status).toBe(200);
    expect(set.body.data.targetDate).toContain('2027-01-15');
    expect(typeof set.body.data.feasible).toBe('boolean');
    expect(set.body.data.stages[0].latestStart).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TIMELINE_TARGET_SET' } })).toBeGreaterThanOrEqual(1);

    // change target
    const change = await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2027-02-01' } });
    expect(change.body.data.targetDate).toContain('2027-02-01');

    // missing key → 400, target UNCHANGED (still the last set value)
    const missing = await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('VALIDATION_ERROR');
    const unchanged = await prisma.caseTimeline.findFirst({ where: { caseId }, select: { targetDate: true } });
    expect(unchanged?.targetDate).not.toBeNull();
    expect(unchanged?.targetDate?.toISOString()).toContain('2027-02-01');

    // clear (explicit null still reaches the service)
    const clr = await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: null } });
    expect(clr.status).toBe(200);
    expect(clr.body.data.targetDate).toBeNull();
    expect(clr.body.data.feasible).toBeNull();
    expect(clr.body.data.stages[0].latestStart).toBeNull();
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TIMELINE_TARGET_CLEARED' } })).toBeGreaterThanOrEqual(1);
    const tl = await prisma.caseTimeline.findFirst({ where: { caseId }, select: { targetDate: true } });
    expect(tl?.targetDate).toBeNull();
  });
});

describe('baseline set once and preserved', () => {
  it('baseline == first planned finish; unchanged after override + target change', async () => {
    const { caseId, stages } = await withTimeline([{}]);
    await req('POST', `${TL(caseId)}/recalc`, { token: admin.token });
    const first = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { baselineStart: true, baselineFinish: true, plannedFinish: true } });
    expect(first?.baselineFinish).toEqual(first?.plannedFinish);
    expect(first?.baselineStart).not.toBeNull();

    // override to a much longer duration → plannedFinish moves, baseline must not.
    const ov = await req('POST', `${SG(caseId)}/${stages[0].id}/override-duration`, { token: admin.token, body: { remainingDuration: 20, reason: 'delay' } });
    expect(ov.status).toBe(200);
    const after = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { baselineStart: true, baselineFinish: true, plannedFinish: true } });
    expect(after?.baselineStart).toEqual(first?.baselineStart);
    expect(after?.baselineFinish).toEqual(first?.baselineFinish);
    expect(after?.plannedFinish?.getTime()).toBeGreaterThan(first!.plannedFinish!.getTime());

    // set + clear target, recalc again: baseline still frozen.
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2027-06-01' } });
    await req('POST', `${TL(caseId)}/recalc`, { token: admin.token });
    const last = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { baselineStart: true, baselineFinish: true } });
    expect(last?.baselineStart).toEqual(first?.baselineStart);
    expect(last?.baselineFinish).toEqual(first?.baselineFinish);
  });
});

describe('recalc fires on every Phase 6 transition', () => {
  async function clearPlanned(caseId: string) {
    await prisma.caseTimeline.updateMany({ where: { caseId }, data: { lastPlannedAt: null } });
  }
  async function lastPlanned(caseId: string) {
    const tl = await prisma.caseTimeline.findFirst({ where: { caseId }, select: { lastPlannedAt: true } });
    return tl?.lastPlannedAt ?? null;
  }
  it('start / complete / skip / reopen each recalc inside the same tx', async () => {
    const { caseId, stages } = await withTimeline([{}, {}]);
    // start
    await clearPlanned(caseId);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/start`, { token: admin.token })).status).toBe(200);
    expect(await lastPlanned(caseId)).not.toBeNull();
    const started = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { plannedStart: true } });
    expect(started?.plannedStart).not.toBeNull();
    // complete
    await clearPlanned(caseId);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/complete`, { token: admin.token })).status).toBe(200);
    expect(await lastPlanned(caseId)).not.toBeNull();
    // skip second stage
    await clearPlanned(caseId);
    expect((await req('POST', `${SG(caseId)}/${stages[1].id}/skip`, { token: admin.token, body: { reason: 'n/a' } })).status).toBe(200);
    expect(await lastPlanned(caseId)).not.toBeNull();
    // reopen first
    await clearPlanned(caseId);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/reopen`, { token: admin.token })).status).toBe(200);
    expect(await lastPlanned(caseId)).not.toBeNull();
    // no extra audit row from the recalc hook: only the per-transition rows exist
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TIMELINE_RECALCULATED', entityId: (await prisma.caseTimeline.findFirst({ where: { caseId }, select: { id: true } }))!.id } })).toBe(0);
  });
});

describe('duration override', () => {
  it('writes a CaseStageEvent + audit + recomputes, requires reason', async () => {
    const { caseId, stages } = await withTimeline([{}]);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/override-duration`, { token: admin.token, body: { remainingDuration: 5 } })).status).toBe(422); // no reason
    const ok = await req('POST', `${SG(caseId)}/${stages[0].id}/override-duration`, { token: admin.token, body: { remainingDuration: 5, reason: 'scope grew' } });
    expect(ok.status).toBe(200);
    const st = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { remainingDurationOverride: true } });
    expect(st?.remainingDurationOverride).toBe(5);
    const ev = await prisma.caseStageEvent.findFirst({ where: { tenantId, stageId: stages[0].id, eventType: 'DURATION_OVERRIDDEN' } });
    expect(ev?.note).toContain('scope grew');
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_STAGE_DURATION_OVERRIDDEN', entityId: stages[0].id } })).toBe(1);
  });
});

describe('exception approval', () => {
  it('wrong perm → 403; missing reason → 422; approve sets fields + audit', async () => {
    const { caseId } = await withTimeline([{}]);
    // Infeasible plan (target in the past) is the precondition for an exception.
    const inf = await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2020-01-06' } });
    expect(inf.body.data.feasible).toBe(false);
    expect((await req('POST', `${TL(caseId)}/approve-exception`, { token: noException.token, body: { reason: 'x' } })).status).toBe(403);
    expect((await req('POST', `${TL(caseId)}/approve-exception`, { token: admin.token, body: {} })).status).toBe(422);
    const ok = await req('POST', `${TL(caseId)}/approve-exception`, { token: admin.token, body: { reason: 'client accepted delay' } });
    expect(ok.status).toBe(200);
    const tl = await prisma.caseTimeline.findFirst({ where: { caseId }, select: { exceptionApproved: true, exceptionReason: true, exceptionApprovedBy: true, exceptionApprovedAt: true } });
    expect(tl?.exceptionApproved).toBe(true);
    expect(tl?.exceptionReason).toBe('client accepted delay');
    expect(tl?.exceptionApprovedBy).toBe(admin.id);
    expect(tl?.exceptionApprovedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TIMELINE_EXCEPTION_APPROVED' } })).toBeGreaterThanOrEqual(1);
  });
});

describe('exception lifecycle', () => {
  const excRow = (caseId: string) => prisma.caseTimeline.findFirstOrThrow({ where: { caseId }, select: { exceptionApproved: true, exceptionReason: true, exceptionApprovedBy: true, exceptionApprovedAt: true } });

  it('approve on a feasible / no-target timeline → 422', async () => {
    const { caseId } = await withTimeline([{}]);
    expect((await req('POST', `${TL(caseId)}/approve-exception`, { token: admin.token, body: { reason: 'x' } })).status).toBe(422); // feasible null
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2030-01-15' } });
    const r = await req('POST', `${TL(caseId)}/approve-exception`, { token: admin.token, body: { reason: 'x' } });
    expect(r.status).toBe(422);
    expect(r.body.message).toContain('No exception needed');
    expect((await excRow(caseId)).exceptionApproved).toBe(false);
  });

  it('retarget after approval clears the exception; same target does not', async () => {
    const { caseId } = await withTimeline([{}]);
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2020-01-06' } });
    expect((await req('POST', `${TL(caseId)}/approve-exception`, { token: admin.token, body: { reason: 'ok' } })).status).toBe(200);
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2020-01-06' } }); // unchanged
    expect((await excRow(caseId)).exceptionApproved).toBe(true);
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2030-01-15' } }); // changed
    expect(await excRow(caseId)).toEqual({ exceptionApproved: false, exceptionReason: null, exceptionApprovedBy: null, exceptionApprovedAt: null });
  });
});

describe('calendar edit does not change persisted dates until next recalc', () => {
  it('adding a holiday shifts latestStart only after an explicit recalc', async () => {
    const { caseId, stages } = await withTimeline([{}]); // 1 stage, DAYS internal dur 3
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2027-01-15' } }); // Fri
    const before = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { latestStart: true } });
    expect(before?.latestStart).not.toBeNull();

    // Edit the tenant calendar directly: a holiday inside the reverse span.
    const cal = await prisma.workingCalendar.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
    await prisma.calendarHoliday.create({ data: { tenantId, calendarId: cal.id, date: new Date('2027-01-14T00:00:00.000Z'), label: 'H' } });

    // No recalc yet → persisted date unchanged.
    const stillSame = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { latestStart: true } });
    expect(stillSame?.latestStart?.getTime()).toBe(before?.latestStart?.getTime());

    // Recalc → latestStart moves one working day earlier.
    await req('POST', `${TL(caseId)}/recalc`, { token: admin.token });
    const shifted = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { latestStart: true } });
    expect(shifted?.latestStart?.getTime()).toBeLessThan(before!.latestStart!.getTime());

    // cleanup so other tests' recalcs use the default calendar
    await prisma.calendarHoliday.deleteMany({ where: { tenantId } });
    await prisma.workingCalendar.deleteMany({ where: { tenantId } });
  });
});

describe('tenant isolation + flag gate', () => {
  it('other tenant → 404 on target / recalc / override / exception', async () => {
    const { caseId, stages } = await withTimeline([{}]);
    expect((await req('PUT', `${TL(caseId)}/target`, { token: otherAdmin.token, body: { targetDate: '2027-01-15' } })).status).toBe(404);
    expect((await req('POST', `${TL(caseId)}/recalc`, { token: otherAdmin.token })).status).toBe(404);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/override-duration`, { token: otherAdmin.token, body: { remainingDuration: 2, reason: 'x' } })).status).toBe(404);
    expect((await req('POST', `${TL(caseId)}/approve-exception`, { token: otherAdmin.token, body: { reason: 'x' } })).status).toBe(404);
  });
  it('flag disabled → 403 before handler', async () => {
    const r = await req('POST', `${TL(uid())}/recalc`, { token: disabledAdmin.token });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
});

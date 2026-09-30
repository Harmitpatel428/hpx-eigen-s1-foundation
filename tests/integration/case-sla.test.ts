/**
 * Phase 9 Task 3 — template SLA thresholds, stage snapshot, completeStage SLA state, unlock endpoint.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseTypeStatus, CaseStageDurationType } from '@prisma/client';

import { createCaseStageTemplatesRouter, createCaseTimelineRouter, createCaseStageActionsRouter } from '../../src/routes/case-timeline.router';
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
  app.use('/api/v1/case-types/:caseTypeId/stages', createCaseStageTemplatesRouter(prisma));
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

const ALL = ['case-timeline:view', 'case-timeline:manage', 'case-stage:start', 'case-stage:complete', 'case-stage:skip', 'case-stage:reopen', 'case-stage:pause', 'case-stage:resume', 'case-stage:override', 'case-exception:approve', 'sla:unlock'];

let tenantId: string, otherTenantId: string, disabledTenantId: string;
let admin: { id: string; token: string }, noUnlock: { token: string }, otherAdmin: { token: string }, disabledAdmin: { token: string };

const TL = (caseId: string) => `/api/v1/cases/${caseId}/timeline`;
const TP = (typeId: string) => `/api/v1/case-types/${typeId}/stages`;
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
  noUnlock = await grant(tenantId, ALL.filter((s) => s !== 'sla:unlock'));
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


const unlock = (caseId: string, stageId: string, token: string, body: any = { reason: 'ok' }) => req('POST', `${SG(caseId)}/${stageId}/unlock`, { token, body });
const auditCount = (entityId: string, eventType?: string) => prisma.auditLog.count({ where: { tenantId, entityId, ...(eventType ? { eventType } : {}) } });

describe('template SLA thresholds', () => {
  it('create/update persist the 3 fields; explicit-undefined does not clear', async () => {
    const type = await makeType(tenantId);
    const c = await req('POST', TP(type.id), { token: admin.token, body: { key: 'a', label: 'A', atRiskPercent: 80, warnDaysRemaining: 2, hardBlock: true } });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ atRiskPercent: 80, warnDaysRemaining: 2, hardBlock: true });
    const u = await req('PATCH', `${TP(type.id)}/${c.body.data.id}`, { token: admin.token, body: { label: 'A2' } });
    expect(u.body.data).toMatchObject({ atRiskPercent: 80, warnDaysRemaining: 2, hardBlock: true });
    const u2 = await req('PATCH', `${TP(type.id)}/${c.body.data.id}`, { token: admin.token, body: { atRiskPercent: null, hardBlock: false } });
    expect(u2.body.data).toMatchObject({ atRiskPercent: null, warnDaysRemaining: 2, hardBlock: false });
  });
  it('range validation -> 400', async () => {
    const type = await makeType(tenantId);
    expect((await req('POST', TP(type.id), { token: admin.token, body: { key: 'b', label: 'B', atRiskPercent: 101 } })).status).toBe(400);
    expect((await req('POST', TP(type.id), { token: admin.token, body: { key: 'b', label: 'B', warnDaysRemaining: -1 } })).status).toBe(400);
    const c = await req('POST', TP(type.id), { token: admin.token, body: { key: 'c', label: 'C' } });
    expect((await req('PATCH', `${TP(type.id)}/${c.body.data.id}`, { token: admin.token, body: { atRiskPercent: -1 } })).status).toBe(400);
    expect((await req('PATCH', `${TP(type.id)}/${c.body.data.id}`, { token: admin.token, body: { warnDaysRemaining: -1 } })).status).toBe(400);
  });
  it('snapshot copies the 3 fields into stages at timeline creation', async () => {
    const { stages } = await withTimeline([{ atRiskPercent: 70, warnDaysRemaining: 3, hardBlock: true }]);
    expect(stages[0]).toMatchObject({ atRiskPercent: 70, warnDaysRemaining: 3, hardBlock: true });
  });
});

describe('completeStage SLA state', () => {
  async function run(plannedFinish: Date) {
    const { caseId, stages } = await withTimeline([{}]);
    const id = stages[0].id;
    await req('POST', `${SG(caseId)}/${id}/start`, { token: admin.token });
    await prisma.caseStage.update({ where: { id }, data: { plannedFinish } });
    const before = await auditCount(id);
    const r = await req('POST', `${SG(caseId)}/${id}/complete`, { token: admin.token, body: {} });
    expect(r.status).toBe(200);
    expect(await auditCount(id)).toBe(before + 1);
    expect(await auditCount(id, 'CASE_STAGE_COMPLETED')).toBe(1);
    return (await prisma.caseStage.findUniqueOrThrow({ where: { id } })).slaState;
  }
  it('on/before plannedFinish -> COMPLETED_ON_TIME', async () => {
    expect(await run(new Date(Date.now() + 5 * 864e5))).toBe('COMPLETED_ON_TIME');
  });
  it('after plannedFinish -> COMPLETED_LATE', async () => {
    expect(await run(new Date(Date.now() - 5 * 864e5))).toBe('COMPLETED_LATE');
  });
});

describe('unlock', () => {
  async function blocked(startedAt: Date | null = null) {
    const { caseId, stages } = await withTimeline([{}]);
    await prisma.caseStage.update({ where: { id: stages[0].id }, data: { status: 'BLOCKED', startedAt } });
    return { caseId, id: stages[0].id as string };
  }
  it('wrong perm -> 403', async () => {
    const { caseId, id } = await blocked();
    expect((await unlock(caseId, id, noUnlock.token)).status).toBe(403);
  });
  it('missing/blank reason -> 422', async () => {
    const { caseId, id } = await blocked();
    expect((await unlock(caseId, id, admin.token, {})).status).toBe(422);
    expect((await unlock(caseId, id, admin.token, { reason: '   ' })).status).toBe(422);
  });
  it('non-BLOCKED -> 422', async () => {
    const { caseId, stages } = await withTimeline([{}]);
    expect((await unlock(caseId, stages[0].id, admin.token)).status).toBe(422);
  });
  it('BLOCKED (never started) -> READY with unlock fields, event, audit', async () => {
    const { caseId, id } = await blocked();
    const r = await unlock(caseId, id, admin.token, { reason: '  approved  ' });
    expect(r.status).toBe(200);
    const s = await prisma.caseStage.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe('READY');
    expect(s.hardBlockUnlockedBy).toBe(admin.id);
    expect(s.hardBlockUnlockedReason).toBe('approved');
    expect(s.hardBlockUnlockedAt).not.toBeNull();
    const ev = await prisma.caseStageEvent.findFirst({ where: { stageId: id, eventType: 'UNBLOCKED' } });
    expect(ev).toMatchObject({ fromStatus: 'BLOCKED', toStatus: 'READY', note: 'approved' });
    expect(await auditCount(id, 'CASE_STAGE_UNBLOCKED')).toBe(1);
  });
  it('BLOCKED (started) -> IN_PROGRESS', async () => {
    const { caseId, id } = await blocked(new Date());
    expect((await unlock(caseId, id, admin.token)).status).toBe(200);
    expect((await prisma.caseStage.findUniqueOrThrow({ where: { id } })).status).toBe('IN_PROGRESS');
    const ev = await prisma.caseStageEvent.findFirst({ where: { stageId: id, eventType: 'UNBLOCKED' } });
    expect(ev).toMatchObject({ fromStatus: 'BLOCKED', toStatus: 'IN_PROGRESS' });
  });
  it('BLOCKED (never started) with non-terminal predecessor -> PENDING; event toStatus matches persisted', async () => {
    const { caseId, stages } = await withTimeline([{}, {}]);
    const id = stages[1].id as string; // stage 0 stays READY (non-terminal)
    await prisma.caseStage.update({ where: { id }, data: { status: 'BLOCKED', startedAt: null } });
    const r = await unlock(caseId, id, admin.token);
    expect(r.status).toBe(200);
    const s = await prisma.caseStage.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe('PENDING');
    const ev = await prisma.caseStageEvent.findFirst({ where: { stageId: id, eventType: 'UNBLOCKED' }, orderBy: { createdAt: 'desc' } });
    expect(ev).toMatchObject({ eventType: 'UNBLOCKED', fromStatus: 'BLOCKED', toStatus: 'PENDING' });
  });
  it('tenant isolation -> 404', async () => {
    const { caseId, id } = await blocked();
    expect((await unlock(caseId, id, otherAdmin.token)).status).toBe(404);
  });
  it('flag disabled -> 403', async () => {
    const { caseId, id } = await blocked();
    expect((await unlock(caseId, id, disabledAdmin.token)).status).toBe(403);
  });
});

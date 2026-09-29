/**
 * Phase 6 — case timeline templates, instances, stage state machine, events.
 * Real Postgres. Covers template CRUD/reorder/isolation, timeline creation rules,
 * snapshot independence, the full state machine + illegal transitions, readiness
 * recompute, reopen demotion, timeline completion, required-field enforcement +
 * override, pause/resume perms, append-only events, coarse audit, flag gate,
 * and DocCase-row safety.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseFieldStatus, CaseFieldType, CaseTypeStatus } from '@prisma/client';

import { createCaseStageTemplatesRouter, createCaseTimelineRouter, createCaseStageActionsRouter } from '../../src/routes/case-timeline.router';
import { createCaseFieldValuesRouter } from '../../src/routes/case-field-values.router';
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
  app.use('/api/v1/cases/:caseId/field-values', createCaseFieldValuesRouter(prisma));
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `tl-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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
async function makeType(tenantId: string, status: CaseTypeStatus = CaseTypeStatus.ACTIVE) {
  return prisma.caseType.create({ data: { tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status }, select: { id: true } });
}
async function makeTemplate(tenantId: string, caseTypeId: string, sequence: number, over: any = {}) {
  return prisma.caseStageTemplate.create({ data: { tenantId, caseTypeId, key: `s_${uid().slice(0, 8)}`, label: `S${sequence}`, sequence, ...over }, select: { id: true, key: true } });
}
async function makeCase(tenantId: string, createdBy: string, caseTypeId?: string) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy, caseTypeId: caseTypeId ?? null }, select: { id: true, status: true, completionPercent: true, isReady: true } });
}

const ALL_STAGE_PERMS = ['case-timeline:view', 'case-timeline:manage', 'case-stage:start', 'case-stage:complete', 'case-stage:skip', 'case-stage:reopen', 'case-stage:pause', 'case-stage:resume', 'case-stage:override', 'doc:view', 'doc:edit'];

let tenantId: string, otherTenantId: string, disabledTenantId: string;
let admin: { id: string; token: string }, viewer: { token: string }, limited: { token: string }, otherAdmin: { token: string }, disabledAdmin: { token: string };

const ST = (typeId: string) => `/api/v1/case-types/${typeId}/stages`;
const TL = (caseId: string) => `/api/v1/cases/${caseId}/timeline`;
const SG = (caseId: string) => `/api/v1/cases/${caseId}/stages`;

// Create an ACTIVE type with n dependent stage templates (seq 0..n-1) + a case with a timeline.
async function typedCaseWithTimeline(n: number, templateOver: any[] = []) {
  const type = await makeType(tenantId);
  for (let i = 0; i < n; i++) await makeTemplate(tenantId, type.id, i, templateOver[i] ?? {});
  const c = await makeCase(tenantId, admin.id, type.id);
  const created = await req('POST', TL(c.id), { token: admin.token });
  expect(created.status).toBe(201);
  return { type, caseId: c.id, stages: created.body.data.stages as any[] };
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
  admin = await grant(tenantId, ALL_STAGE_PERMS);
  viewer = await grant(tenantId, ['case-timeline:view']);
  limited = await grant(tenantId, ['case-timeline:view', 'case-timeline:manage', 'case-stage:start', 'case-stage:complete']); // no pause/resume/override
  otherAdmin = await grant(otherTenantId, ALL_STAGE_PERMS);
  disabledAdmin = await grant(disabledTenantId, ALL_STAGE_PERMS);

  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.caseStageEvent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStage.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTimeline.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStageTemplate.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValueOption.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValueHistory.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValue.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.updateMany({ where: { tenantId: t }, data: { caseTypeId: null } }).catch(() => {});
    await prisma.caseTypeFieldPlacement.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldRule.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldOption.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldDefinition.deleteMany({ where: { tenantId: t } }).catch(() => {});
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

describe('Templates: flag / permission / CRUD / isolation', () => {
  it('flag disabled → 403', async () => {
    const type = await makeType(disabledTenantId);
    const { status, body } = await req('GET', ST(type.id), { token: disabledAdmin.token });
    expect(status).toBe(403); expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
  it('viewer lists, cannot create; manage creates', async () => {
    const type = await makeType(tenantId);
    expect((await req('GET', ST(type.id), { token: viewer.token })).status).toBe(200);
    expect((await req('POST', ST(type.id), { token: viewer.token, body: { key: 'a', label: 'A' } })).status).toBe(403);
    expect((await req('POST', ST(type.id), { token: admin.token, body: { key: 'a', label: 'A' } })).status).toBe(201);
  });
  it("other tenant's type → 404", async () => {
    const type = await makeType(tenantId);
    expect((await req('GET', ST(type.id), { token: otherAdmin.token })).status).toBe(404);
  });
  it('reorder sets sequence', async () => {
    const type = await makeType(tenantId);
    const a = await makeTemplate(tenantId, type.id, 0); const b = await makeTemplate(tenantId, type.id, 1);
    const r = await req('PUT', `${ST(type.id)}/reorder`, { token: admin.token, body: { orderedIds: [b.id, a.id] } });
    expect(r.status).toBe(200);
    expect(r.body.data.map((t: any) => t.id)).toEqual([b.id, a.id]);
  });
});

describe('Timeline creation rules', () => {
  it('typed + ACTIVE + templates → 201; duplicate → 409', async () => {
    const { caseId } = await typedCaseWithTimeline(2);
    expect((await req('POST', TL(caseId), { token: admin.token })).status).toBe(409);
  });
  it('untyped case → 422', async () => {
    const c = await makeCase(tenantId, admin.id);
    expect((await req('POST', TL(c.id), { token: admin.token })).status).toBe(422);
  });
  it('type without templates → 422', async () => {
    const type = await makeType(tenantId);
    const c = await makeCase(tenantId, admin.id, type.id);
    expect((await req('POST', TL(c.id), { token: admin.token })).status).toBe(422);
  });
});

describe('Snapshot independence', () => {
  it('editing a template after creation does not change live stages', async () => {
    const type = await makeType(tenantId);
    const tpl = await makeTemplate(tenantId, type.id, 0, { label: 'Original' });
    const c = await makeCase(tenantId, admin.id, type.id);
    await req('POST', TL(c.id), { token: admin.token });
    await req('PATCH', `${ST(type.id)}/${tpl.id}`, { token: admin.token, body: { label: 'Renamed' } });
    const get = await req('GET', TL(c.id), { token: admin.token });
    expect(get.body.data.stages[0].label).toBe('Original');
  });
});

describe('State machine + readiness', () => {
  it('first stage READY, second PENDING; legal path start→complete cascades readiness', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(2);
    expect(stages[0].status).toBe('READY');
    expect(stages[1].status).toBe('PENDING');
    // illegal: start the PENDING second stage
    expect((await req('POST', `${SG(caseId)}/${stages[1].id}/start`, { token: admin.token })).status).toBe(422);
    // start + complete first
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/start`, { token: admin.token })).status).toBe(200);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/complete`, { token: admin.token })).status).toBe(200);
    const tl = await req('GET', TL(caseId), { token: admin.token });
    const byId = Object.fromEntries(tl.body.data.stages.map((s: any) => [s.id, s.status]));
    expect(byId[stages[0].id]).toBe('COMPLETED');
    expect(byId[stages[1].id]).toBe('READY'); // recompute promoted it
  });
  it('illegal transitions return 422', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(1);
    const s = stages[0].id;
    expect((await req('POST', `${SG(caseId)}/${s}/complete`, { token: admin.token })).status).toBe(422); // READY -> complete illegal
    expect((await req('POST', `${SG(caseId)}/${s}/pause`, { token: admin.token })).status).toBe(422); // READY -> pause illegal
    expect((await req('POST', `${SG(caseId)}/${s}/resume`, { token: admin.token })).status).toBe(422); // not waiting
    expect((await req('POST', `${SG(caseId)}/${s}/reopen`, { token: admin.token })).status).toBe(422); // not terminal
  });
  it('skip requires a reason; pause/resume cycle', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(1);
    const s = stages[0].id;
    expect((await req('POST', `${SG(caseId)}/${s}/skip`, { token: admin.token, body: {} })).status).toBe(400);
    await req('POST', `${SG(caseId)}/${s}/start`, { token: admin.token });
    expect((await req('POST', `${SG(caseId)}/${s}/pause`, { token: admin.token })).status).toBe(200);
    expect((await req('POST', `${SG(caseId)}/${s}/resume`, { token: admin.token })).status).toBe(200);
  });
  it('reopen demotes READY successors to PENDING; timeline status flips', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(2);
    await req('POST', `${SG(caseId)}/${stages[0].id}/start`, { token: admin.token });
    await req('POST', `${SG(caseId)}/${stages[0].id}/complete`, { token: admin.token }); // stage2 -> READY
    // reopen stage1 → stage2 demoted to PENDING
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/reopen`, { token: admin.token })).status).toBe(200);
    const tl = await req('GET', TL(caseId), { token: admin.token });
    const byId = Object.fromEntries(tl.body.data.stages.map((s: any) => [s.id, s.status]));
    expect(byId[stages[0].id]).toBe('IN_PROGRESS');
    expect(byId[stages[1].id]).toBe('PENDING');
    expect(tl.body.data.timeline.status).toBe('ACTIVE');
  });
  it('timeline COMPLETED when all stages terminal (complete + skip)', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(2);
    await req('POST', `${SG(caseId)}/${stages[0].id}/start`, { token: admin.token });
    await req('POST', `${SG(caseId)}/${stages[0].id}/complete`, { token: admin.token });
    await req('POST', `${SG(caseId)}/${stages[1].id}/skip`, { token: admin.token, body: { reason: 'n/a' } });
    const tl = await req('GET', TL(caseId), { token: admin.token });
    expect(tl.body.data.timeline.status).toBe('COMPLETED');
  });
});

describe('pause/resume permission (new slugs)', () => {
  it('user without case-stage:pause → 403', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(1);
    await req('POST', `${SG(caseId)}/${stages[0].id}/start`, { token: admin.token });
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/pause`, { token: limited.token })).status).toBe(403);
  });
});

describe('Required-field enforcement on complete', () => {
  async function typedCaseEnforcing(enforce: boolean, opts: { fireRule: boolean }) {
    const type = await makeType(tenantId);
    await makeTemplate(tenantId, type.id, 0, { enforceRequiredOnComplete: enforce });
    const dept = await prisma.department.create({ data: { tenantId, name: 'D' }, select: { id: true } });
    const cond = await prisma.caseFieldDefinition.create({ data: { tenantId, key: `c_${uid().slice(0, 8)}`, name: 'C', type: CaseFieldType.TEXT, status: CaseFieldStatus.ACTIVE, owningDepartmentId: dept.id }, select: { id: true } });
    const target = await prisma.caseFieldDefinition.create({ data: { tenantId, key: `g_${uid().slice(0, 8)}`, name: 'G', type: CaseFieldType.TEXT, status: CaseFieldStatus.ACTIVE, owningDepartmentId: dept.id }, select: { id: true } });
    await prisma.caseTypeFieldPlacement.createMany({ data: [{ tenantId, caseTypeId: type.id, fieldId: cond.id }, { tenantId, caseTypeId: type.id, fieldId: target.id }] });
    await prisma.caseFieldRule.create({ data: { tenantId, name: 'req', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id } });
    const c = await makeCase(tenantId, admin.id, type.id);
    const created = await req('POST', TL(c.id), { token: admin.token });
    const stageId = created.body.data.stages[0].id;
    if (opts.fireRule) await req('PATCH', `/api/v1/cases/${c.id}/field-values`, { token: admin.token, body: { values: [{ fieldId: cond.id, value: 'go' }] } });
    await req('POST', `${SG(c.id)}/${stageId}/start`, { token: admin.token });
    return { caseId: c.id, stageId };
  }

  it('enforce=true + unmet required → 422; override+reason → 200 with recorded reason', async () => {
    const { caseId, stageId } = await typedCaseEnforcing(true, { fireRule: true });
    expect((await req('POST', `${SG(caseId)}/${stageId}/complete`, { token: admin.token })).status).toBe(422);
    const ov = await req('POST', `${SG(caseId)}/${stageId}/complete`, { token: admin.token, body: { override: true, reason: 'client waived' } });
    expect(ov.status).toBe(200);
    const ev = await prisma.caseStageEvent.findFirst({ where: { tenantId, stageId, eventType: 'COMPLETED' } });
    expect(ev?.note).toContain('client waived');
  });
  it('enforce=false ignores required fields', async () => {
    const { caseId, stageId } = await typedCaseEnforcing(false, { fireRule: true });
    expect((await req('POST', `${SG(caseId)}/${stageId}/complete`, { token: admin.token })).status).toBe(200);
  });
  it('override without case-stage:override permission → 403', async () => {
    const { caseId, stageId } = await typedCaseEnforcing(true, { fireRule: true });
    expect((await req('POST', `${SG(caseId)}/${stageId}/complete`, { token: limited.token, body: { override: true, reason: 'x' } })).status).toBe(403);
  });
});

describe('Events, audit, DocCase safety', () => {
  it('events append-only with from/to; one coarse audit row per action', async () => {
    const { caseId, stages } = await typedCaseWithTimeline(1);
    const s = stages[0].id;
    await req('POST', `${SG(caseId)}/${s}/start`, { token: admin.token });
    const events = await req('GET', `${SG(caseId)}/${s}/events`, { token: admin.token });
    expect(events.body.data[0].eventType).toBe('STARTED');
    expect(events.body.data[0].fromStatus).toBe('READY');
    expect(events.body.data[0].toStatus).toBe('IN_PROGRESS');
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_STAGE_STARTED', entityId: s } })).toBe(1);
  });
  it('stage actions never mutate DocCase status/completionPercent/isReady', async () => {
    const type = await makeType(tenantId);
    await makeTemplate(tenantId, type.id, 0);
    const c = await makeCase(tenantId, admin.id, type.id);
    const before = { status: c.status, completionPercent: c.completionPercent, isReady: c.isReady };
    const created = await req('POST', TL(c.id), { token: admin.token });
    await req('POST', `${SG(c.id)}/${created.body.data.stages[0].id}/start`, { token: admin.token });
    const after = await prisma.docCase.findUnique({ where: { id: c.id }, select: { status: true, completionPercent: true, isReady: true } });
    expect(after).toEqual(before);
  });
});

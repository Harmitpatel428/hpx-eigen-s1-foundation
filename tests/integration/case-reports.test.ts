/**
 * Operational reports + dashboard stage metrics (Phase 12 Task 2). Real Postgres.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import { Router } from 'express';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, ScopeType, UserStatus, CaseFieldType, CaseFieldStatus, CaseTypeStatus, CaseStageSlaState } from '@prisma/client';
import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { createDashboardRouter } from '../../src/routes/dashboard.router';
import { authMiddleware } from '../../src/middleware/auth.middleware';
import { PermissionService } from '../../src/services/permission.service';
import { makeApp, startServer, makeReq, provisionTenant, cleanupTenants, ProvisionedTenant, uid } from './_shared/case-field-harness';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const R = '/api/v1/documentation/reports';

let server: http.Server;
let baseUrl: string;
let req: ReturnType<typeof makeReq>;
let t: ProvisionedTenant;
let other: ProvisionedTenant;
let disabledTok: string;
let full: string;   // doc:view + case-timeline:view
let docOnly: string; // doc:view only
const tracked: string[] = [];
let selF: string, textF: string, optA: string, optB: string;

async function actor(tenantId: string, slugs: string[]): Promise<string> {
  const user = await prisma.user.create({ data: { id: uid(), tenantId, email: `rp-${uid()}@test.invalid`, password: 'x', status: UserStatus.ACTIVE }, select: { id: true } });
  const role = await prisma.role.create({ data: { tenantId, name: `RP-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    const p = await prisma.permission.findFirst({ where: { slug } });
    if (!p) throw new Error(`permission ${slug} not seeded`);
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
  }
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const sid = uid();
  await prisma.session.create({ data: { id: sid, userId: user.id, tenantId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  return jwt.sign({ sessionId: sid, userId: user.id, tenantId }, process.env.JWT_SECRET ?? 'test-jwt-secret', { expiresIn: '1h' });
}

/** DocCase + timeline + one stage per given (key, slaState). */
async function mkCase(tenantId: string, stages: Array<[string, CaseStageSlaState]>, deleted = false): Promise<string> {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'L', lastName: 'C' }, select: { id: true } });
  const c = await prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy: uid(), ...(deleted ? { deletedAt: new Date() } : {}) }, select: { id: true } });
  const type = await prisma.caseType.create({ data: { tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } });
  const tl = await prisma.caseTimeline.create({ data: { tenantId, caseId: c.id, caseTypeId: type.id }, select: { id: true } });
  let seq = 0;
  for (const [key, slaState] of stages) {
    await prisma.caseStage.create({ data: { tenantId, timelineId: tl.id, key, label: key, sequence: seq++, slaState } });
  }
  return c.id;
}
const mkField = async (tenantId: string, deptId: string, type: CaseFieldType, reportable: boolean) =>
  (await prisma.caseFieldDefinition.create({
    data: { tenantId, key: `f_${uid().slice(0, 8)}`, name: 'F', type, status: CaseFieldStatus.ACTIVE, owningDepartmentId: deptId, reportable },
    select: { id: true },
  })).id;

beforeAll(async () => {
  t = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  other = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  tracked.push(t.tenantId, other.tenantId);
  full = await actor(t.tenantId, ['doc:view', 'case-timeline:view']);
  docOnly = await actor(t.tenantId, ['doc:view']);
  const off = await provisionTenant(prisma, permissionService, { engineEnabled: false });
  tracked.push(off.tenantId);
  disabledTok = await actor(off.tenantId, ['doc:view', 'case-timeline:view']);
  await permissionService.invalidatePermissionCache(t.tenantId);
  await permissionService.invalidatePermissionCache(off.tenantId);

  // Tenant stages: intake OVERDUE x2, AT_RISK x1; review OVERDUE x1; 3 on time, 1 late; deleted case's OVERDUE excluded.
  const c1 = await mkCase(t.tenantId, [['intake', 'OVERDUE'], ['review', 'COMPLETED_ON_TIME']]);
  const c2 = await mkCase(t.tenantId, [['intake', 'OVERDUE'], ['review', 'OVERDUE'], ['file', 'COMPLETED_ON_TIME']]);
  const c3 = await mkCase(t.tenantId, [['intake', 'AT_RISK'], ['review', 'COMPLETED_ON_TIME'], ['file', 'COMPLETED_LATE']]);
  await mkCase(t.tenantId, [['intake', 'OVERDUE']], true);
  // Other tenant noise
  await mkCase(other.tenantId, [['intake', 'OVERDUE'], ['x', 'AT_RISK'], ['y', 'COMPLETED_LATE']]);

  selF = await mkField(t.tenantId, t.deptId, CaseFieldType.SELECT, true);
  textF = await mkField(t.tenantId, t.deptId, CaseFieldType.TEXT, true);
  const nonReportSel = await mkField(t.tenantId, t.deptId, CaseFieldType.SELECT, false);
  const otherSel = await mkField(other.tenantId, other.deptId, CaseFieldType.SELECT, true);
  optA = (await prisma.caseFieldOption.create({ data: { tenantId: t.tenantId, fieldId: selF, key: 'a', label: 'Alpha' }, select: { id: true } })).id;
  optB = (await prisma.caseFieldOption.create({ data: { tenantId: t.tenantId, fieldId: selF, key: 'b', label: 'Beta' }, select: { id: true } })).id;
  const val = (tenantId: string, caseId: string, fieldId: string, optionId: string, extra = {}) =>
    prisma.caseFieldValue.create({ data: { tenantId, caseId, fieldId, optionId, ...extra } });
  await val(t.tenantId, c1, selF, optA);
  await val(t.tenantId, c2, selF, optA);
  await val(t.tenantId, c3, selF, optB);
  await val(t.tenantId, c3, nonReportSel, optB);
  const delCase = await mkCase(t.tenantId, [], true);
  await val(t.tenantId, delCase, selF, optA);
  const oc = await mkCase(other.tenantId, []);
  const otherOpt = (await prisma.caseFieldOption.create({ data: { tenantId: other.tenantId, fieldId: otherSel, key: 'z', label: 'Z' }, select: { id: true } })).id;
  await val(other.tenantId, oc, otherSel, otherOpt);
  (globalThis as any).__nonReportSel = nonReportSel;
  (globalThis as any).__otherSel = otherSel;

  // dashboard behind the same auth the real mount applies
  const dash = Router();
  dash.use(authMiddleware, createDashboardRouter(prisma));
  const app = makeApp([
    ['/api/v1/documentation', createDocumentationRouter(prisma)],
    ['/api/v1/dashboard', dash],
  ]);
  const started = await startServer(app);
  server = started.server;
  baseUrl = started.baseUrl;
  req = makeReq(baseUrl);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const tenantId of tracked) {
    await prisma.caseFieldValue.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.caseStage.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.caseTimeline.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId } }).catch(() => {});
  }
  await cleanupTenants(prisma, tracked);
  await prisma.$disconnect();
}, 30_000);

describe('overdue-by-stage', () => {
  it('aggregates per stage key, excluding deleted cases and other tenants', async () => {
    const { status, body } = await req('GET', `${R}/overdue-by-stage`, { token: full });
    expect(status).toBe(200);
    const m = Object.fromEntries(body.data.map((r: any) => [r.stageKey, r]));
    expect(m.intake).toEqual({ stageKey: 'intake', overdue: 2, atRisk: 1 });
    expect(m.review).toEqual({ stageKey: 'review', overdue: 1, atRisk: 0 });
    expect(Object.keys(m).sort()).toEqual(['intake', 'review']);
  });
  it('requires case-timeline:view', async () => {
    expect((await req('GET', `${R}/overdue-by-stage`, { token: docOnly })).status).toBe(403);
  });
});

describe('on-time-vs-late', () => {
  it('counts completed stages', async () => {
    const { status, body } = await req('GET', `${R}/on-time-vs-late`, { token: full });
    expect(status).toBe(200);
    expect(body.data).toEqual({ onTime: 3, late: 1 });
  });
  it('requires case-timeline:view', async () => {
    expect((await req('GET', `${R}/on-time-vs-late`, { token: docOnly })).status).toBe(403);
  });
});

describe('engine gate', () => {
  it('engine-disabled tenant -> 403', async () => {
    const { status, body } = await req('GET', `${R}/overdue-by-stage`, { token: disabledTok });
    expect(status).toBe(403);
    expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
});

describe('cases-by-option', () => {
  it('groups by option with labels', async () => {
    const { status, body } = await req('GET', `${R}/cases-by-option?fieldId=${selF}`, { token: docOnly });
    expect(status).toBe(200);
    const m = Object.fromEntries(body.data.map((r: any) => [r.optionId, r]));
    expect(m[optA]).toEqual({ optionId: optA, label: 'Alpha', count: 2 });
    expect(m[optB]).toEqual({ optionId: optB, label: 'Beta', count: 1 });
    expect(body.data).toHaveLength(2);
  });
  it('non-SELECT field -> 400', async () => {
    expect((await req('GET', `${R}/cases-by-option?fieldId=${textF}`, { token: docOnly })).status).toBe(400);
  });
  it('non-reportable SELECT field -> 400', async () => {
    expect((await req('GET', `${R}/cases-by-option?fieldId=${(globalThis as any).__nonReportSel}`, { token: docOnly })).status).toBe(400);
  });
  it('other tenant field -> 404', async () => {
    expect((await req('GET', `${R}/cases-by-option?fieldId=${(globalThis as any).__otherSel}`, { token: docOnly })).status).toBe(404);
  });
  it('missing / bad fieldId -> 400', async () => {
    expect((await req('GET', `${R}/cases-by-option`, { token: docOnly })).status).toBe(400);
    expect((await req('GET', `${R}/cases-by-option?fieldId=nope`, { token: docOnly })).status).toBe(400);
  });
});

describe('dashboard metrics', () => {
  it('overdueStages / atRiskStages match fixture (tenant-scoped)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/dashboard/metrics`, { headers: { Authorization: `Bearer ${full}`, 'X-Department-Id': t.deptId } });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.overdueStages).toBe(3);
    expect(body.data.atRiskStages).toBe(1);
    expect(body.data.activeDrafts).toBe(0);
  });
});

/**
 * Case Field VALUES — integration tests (Phase 3). Real Postgres.
 * Covers flag gate, RBAC (doc:view/doc:edit), tenant isolation, batch PATCH,
 * per-type validation, REQUIRE_FIELD validate, archived field/option, optimistic
 * lock, coarse audit (one row/batch), history rows, and DocCase-row safety.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseFieldStatus, CaseFieldType } from '@prisma/client';

import { createCaseFieldValuesRouter } from '../../src/routes/case-field-values.router';
import { PermissionService } from '../../src/services/permission.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const uid = () => crypto.randomUUID();

let server: http.Server;
let baseUrl: string;
const tracked: string[] = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cases/:caseId/field-values', createCaseFieldValuesRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: String(err) });
  });
  return app;
}
async function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
async function makeUser(tenantId: string) {
  return prisma.user.create({ data: { id: uid(), tenantId, email: `v-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
}
async function makeSession(userId: string, tenantId: string) {
  const sessionId = uid();
  await prisma.session.create({ data: { id: sessionId, userId, tenantId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  return jwt.sign({ sessionId, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}
async function permId(slug: string) {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded.`);
  return p.id;
}
async function grant(tenantId: string, slugs: string[]) {
  const user = await makeUser(tenantId);
  const role = await prisma.role.create({ data: { tenantId, name: `R-${uid().slice(0, 8)}` } });
  for (const s of slugs) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(s) } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { id: user.id, token: await makeSession(user.id, tenantId) };
}
async function makeCase(tenantId: string, createdBy: string) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy }, select: { id: true, status: true, completionPercent: true, isReady: true } });
}
async function makeField(tenantId: string, deptId: string, type: CaseFieldType, over: any = {}) {
  return prisma.caseFieldDefinition.create({
    data: { tenantId, key: `k_${uid().slice(0, 8)}`, name: 'F', type, status: CaseFieldStatus.ACTIVE, owningDepartmentId: deptId, ...over },
    select: { id: true, type: true },
  });
}
async function makeOption(tenantId: string, fieldId: string, over: any = {}) {
  return prisma.caseFieldOption.create({ data: { tenantId, fieldId, key: `o_${uid().slice(0, 8)}`, label: 'O', ...over }, select: { id: true } });
}

// Fixtures
let tenantId: string, otherTenantId: string, disabledTenantId: string, deptId: string;
let editor: { id: string; token: string }, viewer: { id: string; token: string };
let disabledEditor: { token: string }, otherEditor: { token: string };
let caseId: string, otherCaseId: string, disabledCaseId: string;
let textField: any, numField: any, selField: any, selOptA: any, selOptB: any, multiField: any, multiOptA: any, multiOptB: any;
let archivedField: any, fieldWithArchivedOption: any, archivedOption: any;
let condField: any, targetField: any;

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'V' }, { id: otherTenantId, name: 'O' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  const dept = await prisma.department.create({ data: { tenantId, name: 'Docs' }, select: { id: true } });
  deptId = dept.id;

  editor = await grant(tenantId, ['doc:view', 'doc:edit']);
  viewer = await grant(tenantId, ['doc:view']);
  disabledEditor = await grant(disabledTenantId, ['doc:view', 'doc:edit']);
  otherEditor = await grant(otherTenantId, ['doc:view', 'doc:edit']);

  const c = await makeCase(tenantId, editor.id); caseId = c.id;
  otherCaseId = (await makeCase(otherTenantId, otherEditor ? (await makeUser(otherTenantId)).id : editor.id)).id;
  disabledCaseId = (await makeCase(disabledTenantId, (await makeUser(disabledTenantId)).id)).id;

  textField = await makeField(tenantId, deptId, CaseFieldType.TEXT);
  numField = await makeField(tenantId, deptId, CaseFieldType.NUMBER);
  selField = await makeField(tenantId, deptId, CaseFieldType.SELECT);
  selOptA = await makeOption(tenantId, selField.id); selOptB = await makeOption(tenantId, selField.id);
  multiField = await makeField(tenantId, deptId, CaseFieldType.MULTI_SELECT);
  multiOptA = await makeOption(tenantId, multiField.id); multiOptB = await makeOption(tenantId, multiField.id);
  archivedField = await makeField(tenantId, deptId, CaseFieldType.TEXT, { status: CaseFieldStatus.ARCHIVED, deletedAt: new Date() });
  fieldWithArchivedOption = await makeField(tenantId, deptId, CaseFieldType.SELECT);
  archivedOption = await makeOption(tenantId, fieldWithArchivedOption.id, { isActive: false, deletedAt: new Date() });
  condField = await makeField(tenantId, deptId, CaseFieldType.TEXT);
  targetField = await makeField(tenantId, deptId, CaseFieldType.TEXT);
  await prisma.caseFieldRule.create({ data: {
    tenantId, name: 'require target when cond set',
    conditionFieldId: condField.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: targetField.id,
  }});

  await Promise.all([tenantId, otherTenantId, disabledTenantId].map((t) => permissionService.invalidatePermissionCache(t)));
  const started = makeApp();
  server = http.createServer(started);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.caseFieldValueOption.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValueHistory.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValue.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldRule.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldOption.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldDefinition.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.department.deleteMany({ where: { tenantId: t } }).catch(() => {});
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

const P = (id: string) => `/api/v1/cases/${id}/field-values`;

describe('Auth / flag / permission', () => {
  it('no token → 401', async () => { expect((await req('GET', P(caseId))).status).toBe(401); });
  it('flag disabled → 403 CASE_OPERATIONS_ENGINE_DISABLED', async () => {
    const { status, body } = await req('GET', P(disabledCaseId), { token: disabledEditor.token });
    expect(status).toBe(403); expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
  it('viewer can GET, cannot PATCH', async () => {
    expect((await req('GET', P(caseId), { token: viewer.token })).status).toBe(200);
    expect((await req('PATCH', P(caseId), { token: viewer.token, body: { values: [{ fieldId: textField.id, value: 'x' }] } })).status).toBe(403);
  });
});

describe('Tenant isolation', () => {
  it("other tenant's case → 404", async () => {
    expect((await req('GET', P(otherCaseId), { token: editor.token })).status).toBe(404);
  });
});

describe('Batch PATCH + validation', () => {
  it('batch success across types', async () => {
    const { status, body } = await req('PATCH', P(caseId), { token: editor.token, body: { values: [
      { fieldId: textField.id, value: 'hello' },
      { fieldId: numField.id, value: 42 },
      { fieldId: selField.id, optionId: selOptA.id },
      { fieldId: multiField.id, optionIds: [multiOptA.id, multiOptB.id] },
    ]}});
    expect(status).toBe(200);
    expect(body.data.values.length).toBe(4);
  });
  it('TEXT given a number → 400', async () => {
    expect((await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: textField.id, value: 5 }] } })).status).toBe(400);
  });
  it('NUMBER given a string → 400', async () => {
    expect((await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: numField.id, value: 'x' }] } })).status).toBe(400);
  });
});

describe('Archived field / option', () => {
  it('archived field rejects new value → 422', async () => {
    expect((await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: archivedField.id, value: 'x' }] } })).status).toBe(422);
  });
  it('archived option rejected on selection → 422', async () => {
    expect((await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: fieldWithArchivedOption.id, optionId: archivedOption.id }] } })).status).toBe(422);
  });
  it('existing value referencing a later-archived option stays readable', async () => {
    const live = await makeField(tenantId, deptId, CaseFieldType.SELECT);
    const opt = await makeOption(tenantId, live.id);
    expect((await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: live.id, optionId: opt.id }] } })).status).toBe(200);
    await prisma.caseFieldOption.update({ where: { id: opt.id }, data: { isActive: false, deletedAt: new Date() } });
    const get = await req('GET', P(caseId), { token: editor.token });
    const row = get.body.data.values.find((v: any) => v.fieldId === live.id);
    expect(row.optionId).toBe(opt.id);
  });
});

describe('Optimistic lock', () => {
  it('stale version → 409', async () => {
    const f = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    expect((await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: f.id, value: 'a' }] } })).status).toBe(200);
    const stale = await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: f.id, value: 'b', version: 99 }] } });
    expect(stale.status).toBe(409);
    const ok = await req('PATCH', P(caseId), { token: editor.token, body: { values: [{ fieldId: f.id, value: 'b', version: 1 }] } });
    expect(ok.status).toBe(200);
  });
});

describe('REQUIRE_FIELD validate', () => {
  it('not applicable when condition empty → valid', async () => {
    const fresh = await makeCase(tenantId, editor.id);
    const { body } = await req('POST', `${P(fresh.id)}/validate`, { token: editor.token });
    expect(body.data.valid).toBe(true);
  });
  it('applicable + target missing → invalid; then target set → valid', async () => {
    const fresh = await makeCase(tenantId, editor.id);
    await req('PATCH', P(fresh.id), { token: editor.token, body: { values: [{ fieldId: condField.id, value: 'trigger' }] } });
    const fail = await req('POST', `${P(fresh.id)}/validate`, { token: editor.token });
    expect(fail.body.data.valid).toBe(false);
    expect(fail.body.data.missing.some((m: any) => m.targetFieldId === targetField.id)).toBe(true);
    await req('PATCH', P(fresh.id), { token: editor.token, body: { values: [{ fieldId: targetField.id, value: 'done' }] } });
    const pass = await req('POST', `${P(fresh.id)}/validate`, { token: editor.token });
    expect(pass.body.data.valid).toBe(true);
  });
});

describe('Audit, history, DocCase safety', () => {
  it('one coarse audit row per PATCH batch', async () => {
    const fresh = await makeCase(tenantId, editor.id);
    const before = await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_FIELD_VALUES_UPDATED', entityId: fresh.id } });
    await req('PATCH', P(fresh.id), { token: editor.token, body: { values: [
      { fieldId: textField.id, value: 'a' }, { fieldId: numField.id, value: 1 },
    ]}});
    const after = await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_FIELD_VALUES_UPDATED', entityId: fresh.id } });
    expect(after - before).toBe(1);
  });
  it('history rows created for changed values', async () => {
    const fresh = await makeCase(tenantId, editor.id);
    await req('PATCH', P(fresh.id), { token: editor.token, body: { values: [{ fieldId: textField.id, value: 'h' }] } });
    const hist = await req('GET', `${P(fresh.id)}/history`, { token: editor.token });
    expect(hist.body.data.length).toBeGreaterThanOrEqual(1);
    expect(hist.body.data[0].fieldId).toBe(textField.id);
  });
  it('value write does NOT mutate DocCase status/completionPercent/isReady', async () => {
    const fresh = await makeCase(tenantId, editor.id);
    const before = await prisma.docCase.findUnique({ where: { id: fresh.id }, select: { status: true, completionPercent: true, isReady: true, updatedAt: true } });
    await req('PATCH', P(fresh.id), { token: editor.token, body: { values: [{ fieldId: textField.id, value: 'x' }] } });
    const after = await prisma.docCase.findUnique({ where: { id: fresh.id }, select: { status: true, completionPercent: true, isReady: true, updatedAt: true } });
    expect(after).toEqual(before); // untouched, including updatedAt
  });
});

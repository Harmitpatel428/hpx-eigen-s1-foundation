/**
 * Phase 5 — advanced rule effects runtime & dependency validation. Real Postgres.
 * Covers HIDE_FIELD/SET_DEFAULT runtime in getValues, hidden precedence + advisory
 * writes, validate suppression, default option selectability, invalid default payload,
 * rule cycle detection (create/update), self-reference, deterministic default ordering,
 * type-aware restriction, flag/permission, and DocCase-row safety.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseFieldStatus, CaseFieldType, CaseTypeStatus } from '@prisma/client';

import { createCaseFieldRulesRouter } from '../../src/routes/case-field-rules.router';
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
  app.use('/api/v1/case-field-rules', createCaseFieldRulesRouter(prisma));
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `re-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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
async function makeCase(tenantId: string, createdBy: string) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy }, select: { id: true } });
}
async function makeField(tenantId: string, deptId: string, type: CaseFieldType, over: any = {}) {
  return prisma.caseFieldDefinition.create({ data: { tenantId, key: `k_${uid().slice(0, 8)}`, name: 'F', type, status: CaseFieldStatus.ACTIVE, owningDepartmentId: deptId, ...over }, select: { id: true } });
}
async function makeOption(tenantId: string, fieldId: string, over: any = {}) {
  return prisma.caseFieldOption.create({ data: { tenantId, fieldId, key: `o_${uid().slice(0, 8)}`, label: 'O', ...over }, select: { id: true } });
}
async function createRule(token: string, body: any) { return req('POST', '/api/v1/case-field-rules', { token, body }); }

let tenantId: string, disabledTenantId: string, deptId: string;
let admin: { id: string; token: string }, viewer: { token: string }, disabledAdmin: { token: string };
const P = (id: string) => `/api/v1/cases/${id}/field-values`;
const fieldOf = (getBody: any, fid: string) => getBody.data.fields.find((f: any) => f.id === fid);

beforeAll(async () => {
  tenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  deptId = (await prisma.department.create({ data: { tenantId, name: 'Docs' }, select: { id: true } })).id;
  admin = await grant(tenantId, ['case-field:view', 'case-field:manage', 'doc:view', 'doc:edit']);
  viewer = await grant(tenantId, ['doc:view']);
  disabledAdmin = await grant(disabledTenantId, ['case-field:view', 'case-field:manage', 'doc:view', 'doc:edit']);

  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.caseFieldValueOption.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValueHistory.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseFieldValue.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.updateMany({ where: { tenantId: t }, data: { caseTypeId: null } }).catch(() => {});
    await prisma.caseTypeFieldPlacement.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId: t } }).catch(() => {});
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

describe('Flag / permission', () => {
  it('flag disabled → 403', async () => {
    const c = await makeCase(disabledTenantId, disabledAdmin ? (await makeUser(disabledTenantId)).id : '');
    const { status, body } = await req('GET', P(c.id), { token: disabledAdmin.token });
    expect(status).toBe(403); expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
  it('viewer GET ok, PATCH forbidden', async () => {
    const c = await makeCase(tenantId, admin.id);
    expect((await req('GET', P(c.id), { token: viewer.token })).status).toBe(200);
    const f = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    expect((await req('PATCH', P(c.id), { token: viewer.token, body: { values: [{ fieldId: f.id, value: 'x' }] } })).status).toBe(403);
  });
});

describe('HIDE_FIELD runtime', () => {
  it('hides target; keeps stored value; remains writable; suppresses REQUIRE in validate', async () => {
    const cond = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const target = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    await createRule(admin.token, { name: 'hide', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id, effectType: 'HIDE_FIELD' });
    await createRule(admin.token, { name: 'req', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id, effectType: 'REQUIRE_FIELD' });
    const c = await makeCase(tenantId, admin.id);

    // store a value on target, then trigger the hide
    await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: target.id, value: 'stored' }, { fieldId: cond.id, value: 'go' }] } });
    const get = await req('GET', P(c.id), { token: admin.token });
    const tf = fieldOf(get.body, target.id);
    expect(tf.isHidden).toBe(true);
    expect(tf.isApplicable).toBe(false);
    // stored value still returned
    expect(get.body.data.values.find((v: any) => v.fieldId === target.id).valueText).toBe('stored');
    // hidden field still writable (advisory)
    expect((await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: target.id, value: 'again', version: 1 }] } })).status).toBe(200);
    // REQUIRE suppressed by hide → validate valid even though a require rule targets it
    expect((await req('POST', `${P(c.id)}/validate`, { token: admin.token })).body.data.valid).toBe(true);
  });
});

describe('SET_DEFAULT runtime', () => {
  it('advisory default appears only when no stored value; primitive value', async () => {
    const cond = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const target = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    await createRule(admin.token, { name: 'def', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id, effectType: 'SET_DEFAULT', defaultPayload: { value: 'hello' } });
    const c = await makeCase(tenantId, admin.id);
    await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: cond.id, value: 'go' }] } });
    expect(fieldOf((await req('GET', P(c.id), { token: admin.token })).body, target.id).defaultValue).toEqual({ value: 'hello' });
    // once a value exists, no default
    await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: target.id, value: 'real' }] } });
    expect(fieldOf((await req('GET', P(c.id), { token: admin.token })).body, target.id).defaultValue).toBeNull();
  });

  it('default omitted when its option is archived/inactive', async () => {
    const cond = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const sel = await makeField(tenantId, deptId, CaseFieldType.SELECT);
    const opt = await makeOption(tenantId, sel.id);
    await createRule(admin.token, { name: 'seldef', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: sel.id, effectType: 'SET_DEFAULT', defaultPayload: { optionId: opt.id } });
    const c = await makeCase(tenantId, admin.id);
    await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: cond.id, value: 'go' }] } });
    expect(fieldOf((await req('GET', P(c.id), { token: admin.token })).body, sel.id).defaultValue).toEqual({ optionId: opt.id });
    // archive the option → default omitted
    await prisma.caseFieldOption.update({ where: { id: opt.id }, data: { isActive: false, deletedAt: new Date() } });
    expect(fieldOf((await req('GET', P(c.id), { token: admin.token })).body, sel.id).defaultValue).toBeNull();
  });

  it('deterministic ordering: higher priority default wins', async () => {
    const cond = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const target = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    await createRule(admin.token, { name: 'low', priority: 1, conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id, effectType: 'SET_DEFAULT', defaultPayload: { value: 'low' } });
    await createRule(admin.token, { name: 'high', priority: 5, conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id, effectType: 'SET_DEFAULT', defaultPayload: { value: 'high' } });
    const c = await makeCase(tenantId, admin.id);
    await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: cond.id, value: 'go' }] } });
    expect(fieldOf((await req('GET', P(c.id), { token: admin.token })).body, target.id).defaultValue).toEqual({ value: 'high' });
  });
});

describe('Rule config-time validation', () => {
  it('invalid default payload rejected at create and update', async () => {
    const cond = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const numT = await makeField(tenantId, deptId, CaseFieldType.NUMBER);
    // string value for a NUMBER target
    const bad = await createRule(admin.token, { name: 'bad', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: numT.id, effectType: 'SET_DEFAULT', defaultPayload: { value: 'x' } });
    expect(bad.status).toBe(400);
    const ok = await createRule(admin.token, { name: 'ok', conditionFieldId: cond.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: numT.id, effectType: 'SET_DEFAULT', defaultPayload: { value: 3 } });
    expect(ok.status).toBe(201);
    const upd = await req('PATCH', `/api/v1/case-field-rules/${ok.body.data.id}`, { token: admin.token, body: { defaultPayload: { value: 'nope' } } });
    expect(upd.status).toBe(400);
  });

  it('self-reference rejected', async () => {
    const f = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    expect((await createRule(admin.token, { name: 'self', conditionFieldId: f.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: f.id, effectType: 'REQUIRE_FIELD' })).status).toBe(422);
  });

  it('rule cycle rejected on create', async () => {
    const a = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const b = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    expect((await createRule(admin.token, { name: 'ab', conditionFieldId: a.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: b.id, effectType: 'REQUIRE_FIELD' })).status).toBe(201);
    expect((await createRule(admin.token, { name: 'ba', conditionFieldId: b.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: a.id, effectType: 'REQUIRE_FIELD' })).status).toBe(422);
  });

  it('rule cycle rejected on update', async () => {
    const a = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const b = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const m = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const n = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    await createRule(admin.token, { name: 'ab', conditionFieldId: a.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: b.id, effectType: 'REQUIRE_FIELD' });
    const mn = await createRule(admin.token, { name: 'mn', conditionFieldId: m.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: n.id, effectType: 'REQUIRE_FIELD' });
    // repoint mn to b->a, closing a cycle with a->b
    const upd = await req('PATCH', `/api/v1/case-field-rules/${mn.body.data.id}`, { token: admin.token, body: { conditionFieldId: b.id, targetFieldId: a.id } });
    expect(upd.status).toBe(422);
  });
});

describe('Type-aware restriction still holds under Phase 5', () => {
  it('typed case returns only placed fields (with runtime flags)', async () => {
    const placed = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const unplaced = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    const type = await prisma.caseType.create({ data: { tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } });
    await prisma.caseTypeFieldPlacement.create({ data: { tenantId, caseTypeId: type.id, fieldId: placed.id } });
    const c = await makeCase(tenantId, admin.id);
    await prisma.docCase.update({ where: { id: c.id }, data: { caseTypeId: type.id } });
    const get = await req('GET', P(c.id), { token: admin.token });
    const ids = get.body.data.fields.map((f: any) => f.id);
    expect(ids).toContain(placed.id);
    expect(ids).not.toContain(unplaced.id);
  });
});

describe('DocCase-row safety', () => {
  it('value write does not mutate DocCase status/completionPercent/isReady', async () => {
    const c = await prisma.docCase.create({ data: { tenantId, leadId: (await prisma.lead.create({ data: { tenantId, firstName: 'A', lastName: 'B' }, select: { id: true } })).id, createdBy: admin.id }, select: { id: true, status: true, completionPercent: true, isReady: true } });
    const f = await makeField(tenantId, deptId, CaseFieldType.TEXT);
    await req('PATCH', P(c.id), { token: admin.token, body: { values: [{ fieldId: f.id, value: 'x' }] } });
    const after = await prisma.docCase.findUnique({ where: { id: c.id }, select: { status: true, completionPercent: true, isReady: true } });
    expect(after).toEqual({ status: c.status, completionPercent: c.completionPercent, isReady: c.isReady });
  });
});

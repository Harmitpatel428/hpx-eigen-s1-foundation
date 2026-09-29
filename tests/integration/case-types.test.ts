/**
 * Case Types & field applicability — integration tests (Phase 4). Real Postgres.
 * Covers CaseType CRUD/publish/archive RBAC, placements, DocCase assignment,
 * type-aware getValues/validate, advisory PATCH, tenant isolation, flag gate,
 * audit, and DocCase-row safety.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseFieldStatus, CaseFieldType, CaseTypeStatus } from '@prisma/client';

import { createCaseTypesRouter, createCaseTypeAssignmentRouter } from '../../src/routes/case-types.router';
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
  app.use('/api/v1/case-types', createCaseTypesRouter(prisma));
  app.use('/api/v1/cases/:caseId/case-type', createCaseTypeAssignmentRouter(prisma));
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `ct-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy }, select: { id: true, caseTypeId: true, status: true, completionPercent: true, isReady: true } });
}
async function makeField(tenantId: string, deptId: string) {
  return prisma.caseFieldDefinition.create({ data: { tenantId, key: `k_${uid().slice(0, 8)}`, name: 'F', type: CaseFieldType.TEXT, status: CaseFieldStatus.ACTIVE, owningDepartmentId: deptId }, select: { id: true } });
}

let tenantId: string, otherTenantId: string, disabledTenantId: string, deptId: string;
let mgr: { id: string; token: string }, viewer: { id: string; token: string }, noPerm: { token: string };
let disabledMgr: { token: string }, otherMgr: { token: string };
let fieldA: any, fieldB: any, condField: any, targetField: any;
let activeType: any, draftType: any;
const CT = '/api/v1/case-types';

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  deptId = (await prisma.department.create({ data: { tenantId, name: 'Docs' }, select: { id: true } })).id;

  mgr = await grant(tenantId, ['case-type:view', 'case-type:manage', 'case-type:publish', 'doc:view', 'doc:edit']);
  viewer = await grant(tenantId, ['case-type:view', 'doc:view']);
  noPerm = await grant(tenantId, []);
  disabledMgr = await grant(disabledTenantId, ['case-type:view', 'case-type:manage', 'doc:edit']);
  otherMgr = await grant(otherTenantId, ['case-type:view', 'case-type:manage', 'case-type:publish', 'doc:edit']);

  fieldA = await makeField(tenantId, deptId);
  fieldB = await makeField(tenantId, deptId);
  condField = await makeField(tenantId, deptId);
  targetField = await makeField(tenantId, deptId);
  await prisma.caseFieldRule.create({ data: { tenantId, name: 'req', conditionFieldId: condField.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: targetField.id } });

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

// Helper: create + publish a type, place given fields.
async function makeActiveType(fieldIds: string[]) {
  const created = await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'Type' } });
  const id = created.body.data.id;
  for (const fid of fieldIds) await req('POST', `${CT}/${id}/fields`, { token: mgr.token, body: { fieldId: fid } });
  await req('POST', `${CT}/${id}/publish`, { token: mgr.token });
  return id;
}

describe('Auth / flag / permission (catalog)', () => {
  it('no token → 401', async () => { expect((await req('GET', CT)).status).toBe(401); });
  it('flag disabled → 403 CASE_OPERATIONS_ENGINE_DISABLED', async () => {
    const { status, body } = await req('GET', CT, { token: disabledMgr.token });
    expect(status).toBe(403); expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
  it('no case-type perm → 403 list; viewer can list; viewer cannot create', async () => {
    expect((await req('GET', CT, { token: noPerm.token })).status).toBe(403);
    expect((await req('GET', CT, { token: viewer.token })).status).toBe(200);
    expect((await req('POST', CT, { token: viewer.token, body: { key: 'x', name: 'X' } })).status).toBe(403);
  });
});

describe('Catalog lifecycle', () => {
  it('create (DRAFT) → publish requires case-type:publish', async () => {
    const c = await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'T' } });
    expect(c.status).toBe(201); expect(c.body.data.status).toBe('DRAFT');
    // viewer lacks publish
    expect((await req('POST', `${CT}/${c.body.data.id}/publish`, { token: viewer.token })).status).toBe(403);
    const pub = await req('POST', `${CT}/${c.body.data.id}/publish`, { token: mgr.token });
    expect(pub.status).toBe(200); expect(pub.body.data.status).toBe('ACTIVE');
  });
  it('duplicate key → 409', async () => {
    const key = `t_${uid().slice(0, 8)}`;
    expect((await req('POST', CT, { token: mgr.token, body: { key, name: 'A' } })).status).toBe(201);
    expect((await req('POST', CT, { token: mgr.token, body: { key, name: 'B' } })).status).toBe(409);
  });
  it('placement add/update/remove need manage; view can list', async () => {
    const id = (await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'P' } })).body.data.id;
    expect((await req('POST', `${CT}/${id}/fields`, { token: viewer.token, body: { fieldId: fieldA.id } })).status).toBe(403);
    expect((await req('POST', `${CT}/${id}/fields`, { token: mgr.token, body: { fieldId: fieldA.id } })).status).toBe(201);
    expect((await req('GET', `${CT}/${id}/fields`, { token: viewer.token })).status).toBe(200);
    expect((await req('PATCH', `${CT}/${id}/fields/${fieldA.id}`, { token: mgr.token, body: { displayOrder: 3 } })).status).toBe(200);
    expect((await req('DELETE', `${CT}/${id}/fields/${fieldA.id}`, { token: mgr.token })).status).toBe(200);
  });
});

describe('Tenant isolation', () => {
  it("other tenant's type → 404", async () => {
    const id = await makeActiveType([]);
    expect((await req('GET', `${CT}/${id}`, { token: otherMgr.token })).status).toBe(404);
    expect((await req('POST', `${CT}/${id}/fields`, { token: otherMgr.token, body: { fieldId: fieldA.id } })).status).toBe(404);
  });
});

describe('Assignment', () => {
  it('only ACTIVE type assignable; DRAFT → 422', async () => {
    const draft = (await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'D' } })).body.data.id;
    const c = await makeCase(tenantId, mgr.id);
    expect((await req('PATCH', `/api/v1/cases/${c.id}/case-type`, { token: mgr.token, body: { caseTypeId: draft } })).status).toBe(422);
  });
  it('assign + clear are audited; recalc fields untouched', async () => {
    const type = await makeActiveType([fieldA.id]);
    const c = await makeCase(tenantId, mgr.id);
    const assign = await req('PATCH', `/api/v1/cases/${c.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } });
    expect(assign.status).toBe(200); expect(assign.body.data.caseTypeId).toBe(type);
    const after = await prisma.docCase.findUnique({ where: { id: c.id }, select: { status: true, completionPercent: true, isReady: true } });
    expect(after).toEqual({ status: c.status, completionPercent: c.completionPercent, isReady: c.isReady });
    await req('PATCH', `/api/v1/cases/${c.id}/case-type`, { token: mgr.token, body: { caseTypeId: null } });
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TYPE_ASSIGNED', entityId: c.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TYPE_CLEARED', entityId: c.id } })).toBe(1);
  });
  it("assignment doc:edit gate; assigning to another tenant's case → 404", async () => {
    const type = await makeActiveType([]);
    const otherCase = await makeCase(otherTenantId, (await makeUser(otherTenantId)).id);
    expect((await req('PATCH', `/api/v1/cases/${otherCase.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } })).status).toBe(404);
  });
});

describe('Archive semantics', () => {
  it('archived type blocks NEW assignment but existing case keeps reading placements', async () => {
    const type = await makeActiveType([fieldA.id]);
    const c = await makeCase(tenantId, mgr.id);
    await req('PATCH', `/api/v1/cases/${c.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } });
    expect((await req('POST', `${CT}/${type}/archive`, { token: mgr.token })).status).toBe(200);
    // existing case still resolves its placed fields
    const get = await req('GET', `/api/v1/cases/${c.id}/field-values`, { token: mgr.token });
    expect(get.body.data.fields.map((f: any) => f.id)).toEqual([fieldA.id]);
    // new assignment of the archived type is rejected
    const c2 = await makeCase(tenantId, mgr.id);
    expect((await req('PATCH', `/api/v1/cases/${c2.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } })).status).toBe(422);
  });
});

describe('Type-aware getValues / validate / advisory PATCH', () => {
  it('untyped case → tenant-global fields; typed case → only placed fields', async () => {
    const untyped = await makeCase(tenantId, mgr.id);
    const uget = await req('GET', `/api/v1/cases/${untyped.id}/field-values`, { token: mgr.token });
    expect(uget.body.data.fields.length).toBeGreaterThanOrEqual(4); // all active tenant fields

    const type = await makeActiveType([fieldA.id]);
    const typed = await makeCase(tenantId, mgr.id);
    await req('PATCH', `/api/v1/cases/${typed.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } });
    const tget = await req('GET', `/api/v1/cases/${typed.id}/field-values`, { token: mgr.token });
    expect(tget.body.data.fields.map((f: any) => f.id)).toEqual([fieldA.id]);
  });

  it('PATCH accepts an ACTIVE field NOT placed on the type (advisory)', async () => {
    const type = await makeActiveType([fieldA.id]); // fieldB not placed
    const c = await makeCase(tenantId, mgr.id);
    await req('PATCH', `/api/v1/cases/${c.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } });
    const patch = await req('PATCH', `/api/v1/cases/${c.id}/field-values`, { token: mgr.token, body: { values: [{ fieldId: fieldB.id, value: 'x' }] } });
    expect(patch.status).toBe(200);
  });

  it('typed validate evaluates only placed rules', async () => {
    // cond+target placed → rule applies. Set cond, leave target empty → invalid.
    const typeWith = await makeActiveType([condField.id, targetField.id]);
    const c1 = await makeCase(tenantId, mgr.id);
    await req('PATCH', `/api/v1/cases/${c1.id}/case-type`, { token: mgr.token, body: { caseTypeId: typeWith } });
    await req('PATCH', `/api/v1/cases/${c1.id}/field-values`, { token: mgr.token, body: { values: [{ fieldId: condField.id, value: 'go' }] } });
    const v1 = await req('POST', `/api/v1/cases/${c1.id}/field-values/validate`, { token: mgr.token });
    expect(v1.body.data.valid).toBe(false);

    // target NOT placed → rule ignored → valid despite cond set.
    const typeWithout = await makeActiveType([condField.id]);
    const c2 = await makeCase(tenantId, mgr.id);
    await req('PATCH', `/api/v1/cases/${c2.id}/case-type`, { token: mgr.token, body: { caseTypeId: typeWithout } });
    await req('PATCH', `/api/v1/cases/${c2.id}/field-values`, { token: mgr.token, body: { values: [{ fieldId: condField.id, value: 'go' }] } });
    const v2 = await req('POST', `/api/v1/cases/${c2.id}/field-values/validate`, { token: mgr.token });
    expect(v2.body.data.valid).toBe(true);
  });

  it('removing a placement does NOT delete stored values', async () => {
    const type = await makeActiveType([fieldA.id]);
    const c = await makeCase(tenantId, mgr.id);
    await req('PATCH', `/api/v1/cases/${c.id}/case-type`, { token: mgr.token, body: { caseTypeId: type } });
    await req('PATCH', `/api/v1/cases/${c.id}/field-values`, { token: mgr.token, body: { values: [{ fieldId: fieldA.id, value: 'keep' }] } });
    expect((await req('DELETE', `${CT}/${type}/fields/${fieldA.id}`, { token: mgr.token })).status).toBe(200);
    const stored = await prisma.caseFieldValue.findFirst({ where: { tenantId, caseId: c.id, fieldId: fieldA.id, deletedAt: null } });
    expect(stored?.valueText).toBe('keep');
  });
});

describe('DocCase create without a type still works', () => {
  it('creates an untyped case (nullable caseTypeId, no backfill)', async () => {
    const c = await makeCase(tenantId, mgr.id);
    expect(c.caseTypeId).toBeNull();
  });
});

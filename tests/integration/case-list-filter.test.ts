/**
 * GET /documentation/cases — custom-field filters + sort allowlist (Phase 12 Task 1).
 * Real Postgres; mirrors case-fields.test.ts harness.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, ScopeType, UserStatus, CaseFieldType, CaseFieldStatus, CaseTypeStatus } from '@prisma/client';
import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { PermissionService } from '../../src/services/permission.service';
import { makeApp, startServer, makeReq, provisionTenant, cleanupTenants, ProvisionedTenant, uid } from './_shared/case-field-harness';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const BASE = '/api/v1/documentation/cases';

let server: http.Server;
let req: ReturnType<typeof makeReq>;
let t: ProvisionedTenant;
let other: ProvisionedTenant;
let token: string;
const tracked: string[] = [];

let textF: string, numF: string, selF: string, lockedF: string, otherF: string;
let optA: string, optB: string;
let c1: string, c2: string, c3: string;

async function mkField(tenantId: string, deptId: string, type: CaseFieldType, filterable = true) {
  return (await prisma.caseFieldDefinition.create({
    data: { tenantId, key: `f_${uid().slice(0, 8)}`, name: 'F', type, status: CaseFieldStatus.ACTIVE, owningDepartmentId: deptId, filterable },
    select: { id: true },
  })).id;
}
async function mkCase(createdBy: string, targetDate: string): Promise<string> {
  const lead = await prisma.lead.create({ data: { tenantId: t.tenantId, firstName: 'L', lastName: 'C' }, select: { id: true } });
  const c = await prisma.docCase.create({ data: { tenantId: t.tenantId, leadId: lead.id, createdBy }, select: { id: true } });
  const type = await prisma.caseType.create({ data: { tenantId: t.tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } });
  await prisma.caseTimeline.create({ data: { tenantId: t.tenantId, caseId: c.id, caseTypeId: type.id, targetDate: new Date(targetDate) } });
  return c.id;
}
const val = (caseId: string, fieldId: string, data: Record<string, unknown>) =>
  prisma.caseFieldValue.create({ data: { tenantId: t.tenantId, caseId, fieldId, ...data } as any });

const list = (filters?: unknown, extra = '') => {
  const ff = filters === undefined ? '' : `&fieldFilters=${encodeURIComponent(typeof filters === 'string' ? filters : JSON.stringify(filters))}`;
  return req('GET', `${BASE}?pageSize=100${ff}${extra}`, { token });
};
const ids = (b: any): string[] => b.data.map((r: any) => r.id);

beforeAll(async () => {
  t = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  other = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  tracked.push(t.tenantId, other.tenantId);

  const user = await prisma.user.create({ data: { id: uid(), tenantId: t.tenantId, email: `cl-${uid()}@test.invalid`, password: 'x', status: UserStatus.ACTIVE }, select: { id: true } });
  const role = await prisma.role.create({ data: { tenantId: t.tenantId, name: `CL-${uid().slice(0, 8)}` } });
  const perm = await prisma.permission.findFirst({ where: { slug: 'doc:view' } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm!.id } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const sid = uid();
  await prisma.session.create({ data: { id: sid, userId: user.id, tenantId: t.tenantId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  token = jwt.sign({ sessionId: sid, userId: user.id, tenantId: t.tenantId }, process.env.JWT_SECRET ?? 'test-jwt-secret', { expiresIn: '1h' });
  await permissionService.invalidatePermissionCache(t.tenantId);

  textF = await mkField(t.tenantId, t.deptId, CaseFieldType.TEXT);
  numF = await mkField(t.tenantId, t.deptId, CaseFieldType.NUMBER);
  selF = await mkField(t.tenantId, t.deptId, CaseFieldType.SELECT);
  lockedF = await mkField(t.tenantId, t.deptId, CaseFieldType.TEXT, false);
  otherF = await mkField(other.tenantId, other.deptId, CaseFieldType.TEXT);
  optA = (await prisma.caseFieldOption.create({ data: { tenantId: t.tenantId, fieldId: selF, key: 'a', label: 'A' }, select: { id: true } })).id;
  optB = (await prisma.caseFieldOption.create({ data: { tenantId: t.tenantId, fieldId: selF, key: 'b', label: 'B' }, select: { id: true } })).id;

  c1 = await mkCase(user.id, '2030-03-01');
  c2 = await mkCase(user.id, '2030-01-01');
  c3 = await mkCase(user.id, '2030-02-01');
  await val(c1, textF, { valueText: 'alpha' }); await val(c1, numF, { valueNumber: 10 }); await val(c1, selF, { optionId: optA });
  await val(c2, textF, { valueText: 'beta' });  await val(c2, numF, { valueNumber: 50 }); await val(c2, selF, { optionId: optB });
  await val(c3, textF, { valueText: 'alpha' }); await val(c3, numF, { valueNumber: 90 }); await val(c3, selF, { optionId: optA });

  const app = makeApp([['/api/v1/documentation', createDocumentationRouter(prisma)]]);
  const started = await startServer(app);
  server = started.server;
  req = makeReq(started.baseUrl);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const tenantId of tracked) {
    await prisma.caseFieldValue.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId } }).catch(() => {});
  }
  await cleanupTenants(prisma, tracked);
  await prisma.$disconnect();
}, 30_000);

describe('fieldFilters', () => {
  it('text EQUALS narrows', async () => {
    const { status, body } = await list([{ fieldId: textF, operator: 'EQUALS', value: 'beta' }]);
    expect(status).toBe(200);
    expect(ids(body)).toEqual([c2]);
    expect(body.total).toBe(1);
  });
  it('SELECT optionId', async () => {
    const { body } = await list([{ fieldId: selF, operator: 'EQUALS', value: optA }]);
    expect(ids(body).sort()).toEqual([c1, c3].sort());
  });
  it('numeric GREATER_THAN', async () => {
    const { body } = await list([{ fieldId: numF, operator: 'GREATER_THAN', value: 40 }]);
    expect(ids(body).sort()).toEqual([c2, c3].sort());
  });
  it('two filters AND together', async () => {
    const { body } = await list([
      { fieldId: textF, operator: 'EQUALS', value: 'alpha' },
      { fieldId: numF, operator: 'GREATER_THAN', value: 40 },
    ]);
    expect(ids(body)).toEqual([c3]);
  });
  it('IS_EMPTY / IS_NOT_EMPTY', async () => {
    expect((await list([{ fieldId: textF, operator: 'IS_NOT_EMPTY' }])).body.total).toBe(3);
    expect((await list([{ fieldId: textF, operator: 'IS_EMPTY' }])).body.total).toBe(0);
  });
  it('non-filterable field -> 400', async () => {
    expect((await list([{ fieldId: lockedF, operator: 'EQUALS', value: 'x' }])).status).toBe(400);
  });
  it('disallowed operator for type -> 400', async () => {
    expect((await list([{ fieldId: textF, operator: 'GREATER_THAN', value: 'x' }])).status).toBe(400);
  });
  it('wrong-typed value -> 400', async () => {
    expect((await list([{ fieldId: numF, operator: 'EQUALS', value: 'abc' }])).status).toBe(400);
  });
  it('more than 5 filters -> 400', async () => {
    const f = { fieldId: textF, operator: 'EQUALS', value: 'alpha' };
    expect((await list([f, f, f, f, f, f])).status).toBe(400);
  });
  it('malformed JSON -> 400', async () => {
    expect((await list('{not json')).status).toBe(400);
  });
  it('another tenant field id -> 400', async () => {
    expect((await list([{ fieldId: otherF, operator: 'EQUALS', value: 'x' }])).status).toBe(400);
  });
  it('shape-valid but invalid date value -> 400', async () => {
    const dateF = await mkField(t.tenantId, t.deptId, CaseFieldType.DATE);
    expect((await list([{ fieldId: dateF, operator: 'EQUALS', value: '2030-13-45' }])).status).toBe(400);
  });
  it('non-UUID SELECT option id -> 400', async () => {
    expect((await list([{ fieldId: selF, operator: 'EQUALS', value: 'not-a-uuid' }])).status).toBe(400);
  });
  it('non-UUID MULTI_SELECT option id -> 400', async () => {
    const multiF = await mkField(t.tenantId, t.deptId, CaseFieldType.MULTI_SELECT);
    expect((await list([{ fieldId: multiF, operator: 'IN', value: ['not-a-uuid'] }])).status).toBe(400);
  });
});

describe('sort', () => {
  it('disallowed sortBy -> 400', async () => {
    expect((await list(undefined, '&sortBy=tenantId')).status).toBe(400);
  });
  it('bad sortDir -> 400', async () => {
    expect((await list(undefined, '&sortBy=createdAt&sortDir=up')).status).toBe(400);
  });
  it('sortBy=targetDate asc orders by timeline', async () => {
    const { status, body } = await list(undefined, '&sortBy=targetDate&sortDir=asc');
    expect(status).toBe(200);
    expect(ids(body)).toEqual([c2, c3, c1]);
  });
  it('sortBy=targetDate desc', async () => {
    expect(ids((await list(undefined, '&sortBy=targetDate')).body)).toEqual([c1, c3, c2]);
  });
});

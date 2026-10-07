/**
 * CaseTypeComponentDocument CRUD — integration tests. Real Postgres.
 * Covers create/list/includeInactive/update/archive/reactivate, dedupeKey
 * normalization + immutability, duplicate-active-key (409), archived case
 * type/component rejection (422), validation (400), tenant isolation (404),
 * permission (403) and the engine gate (403).
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus } from '@prisma/client';

import { createCaseTypesRouter } from '../../src/routes/case-types.router';
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `ctcd-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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

const CT = '/api/v1/case-types';
let tenantId: string, otherTenantId: string, disabledTenantId: string;
let mgr: { token: string }, viewer: { token: string }, otherMgr: { token: string }, disabledMgr: { token: string };

async function makeType(): Promise<string> {
  return (await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'T' } })).body.data.id;
}
async function makeComp(typeId: string, name = 'Comp'): Promise<string> {
  const r = await req('POST', `${CT}/${typeId}/components`, { token: mgr.token, body: { name: `${name}-${uid().slice(0, 6)}` } });
  if (r.status !== 201) throw new Error(`makeComp ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}
const docsUrl = (t: string, c: string) => `${CT}/${t}/components/${c}/documents`;

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  mgr = await grant(tenantId, ['case-type:view', 'case-type:manage', 'case-type:publish']);
  viewer = await grant(tenantId, ['case-type:view']);
  otherMgr = await grant(otherTenantId, ['case-type:view', 'case-type:manage']);
  disabledMgr = await grant(disabledTenantId, ['case-type:view', 'case-type:manage']);
  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.docCaseDocumentComponentSource.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTypeComponentDocument.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTypeComponent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId: t } }).catch(() => {});
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

describe('Component document CRUD', () => {
  it('create → list → update → archive → includeInactive → reactivate', async () => {
    const type = await makeType(); const comp = await makeComp(type);

    const created = await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: '  PAN  Card ', description: 'ID proof', isMandatory: true, displayOrder: 2 } });
    expect(created.status).toBe(201);
    // dedupeKey is the normalized name: trimmed, lowercased, whitespace collapsed.
    expect(created.body.data).toMatchObject({ name: 'PAN  Card', dedupeKey: 'pan card', isMandatory: true, displayOrder: 2, isActive: true });
    const id = created.body.data.id;

    const list = await req('GET', docsUrl(type, comp), { token: viewer.token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((d: any) => d.id)).toEqual([id]);

    const patched = await req('PATCH', `${docsUrl(type, comp)}/${id}`, { token: mgr.token, body: { description: 'Updated', isMandatory: false, displayOrder: 5 } });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ description: 'Updated', isMandatory: false, displayOrder: 5 });

    expect((await req('PATCH', `${docsUrl(type, comp)}/${id}`, { token: mgr.token, body: { isActive: false } })).status).toBe(200);
    expect((await req('GET', docsUrl(type, comp), { token: mgr.token })).body.data).toHaveLength(0);
    expect((await req('GET', `${docsUrl(type, comp)}?includeInactive=true`, { token: mgr.token })).body.data.map((d: any) => d.id)).toEqual([id]);

    expect((await req('PATCH', `${docsUrl(type, comp)}/${id}`, { token: mgr.token, body: { isActive: true } })).status).toBe(200);
    expect((await req('GET', docsUrl(type, comp), { token: mgr.token })).body.data).toHaveLength(1);
  });

  it('duplicate active dedupeKey → 409; allowed once the first is archived; reactivation then collides', async () => {
    const type = await makeType(); const comp = await makeComp(type);
    const first = (await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'PAN' } })).body.data;
    // " pan " normalizes to the same key as "PAN".
    expect((await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: ' pan ' } })).status).toBe(409);

    await req('PATCH', `${docsUrl(type, comp)}/${first.id}`, { token: mgr.token, body: { isActive: false } });
    const second = await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'PAN' } });
    expect(second.status).toBe(201);
    expect((await req('PATCH', `${docsUrl(type, comp)}/${first.id}`, { token: mgr.token, body: { isActive: true } })).status).toBe(409);
  });

  it('the same dedupeKey is allowed under a different component (that is what merges)', async () => {
    const type = await makeType();
    const a = await makeComp(type, 'A'); const b = await makeComp(type, 'B');
    expect((await req('POST', docsUrl(type, a), { token: mgr.token, body: { name: 'PAN' } })).status).toBe(201);
    expect((await req('POST', docsUrl(type, b), { token: mgr.token, body: { name: 'PAN' } })).status).toBe(201);
  });

  it('dedupeKey is immutable: PATCH with dedupeKey → 400; renaming never changes it', async () => {
    const type = await makeType(); const comp = await makeComp(type);
    const doc = (await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'PAN' } })).body.data;
    expect(doc.dedupeKey).toBe('pan');

    const rejected = await req('PATCH', `${docsUrl(type, comp)}/${doc.id}`, { token: mgr.token, body: { dedupeKey: 'something-else' } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toBe('dedupeKey is immutable.');

    const renamed = await req('PATCH', `${docsUrl(type, comp)}/${doc.id}`, { token: mgr.token, body: { name: 'Permanent Account Number' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Permanent Account Number');
    expect(renamed.body.data.dedupeKey).toBe('pan');
  });

  it('validation: blank name → 400, name too long → 400, negative displayOrder → 400', async () => {
    const type = await makeType(); const comp = await makeComp(type);
    const blank = await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: '   ' } });
    expect(blank.status).toBe(400);
    expect((await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'x'.repeat(201) } })).status).toBe(400);
    expect((await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'ok', displayOrder: -1 } })).status).toBe(400);
  });

  it('writes rejected (422) for an archived case type, and for an archived component; reads still work', async () => {
    const type = await makeType(); const comp = await makeComp(type);
    const doc = (await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'GST' } })).body.data;

    // archived component, live case type
    await req('PATCH', `${CT}/${type}/components/${comp}`, { token: mgr.token, body: { isActive: false } });
    expect((await req('POST', docsUrl(type, comp), { token: mgr.token, body: { name: 'New' } })).status).toBe(422);
    expect((await req('PATCH', `${docsUrl(type, comp)}/${doc.id}`, { token: mgr.token, body: { name: 'X' } })).status).toBe(422);
    expect((await req('GET', `${docsUrl(type, comp)}?includeInactive=true`, { token: mgr.token })).status).toBe(200);

    // archived case type
    const type2 = await makeType(); const comp2 = await makeComp(type2);
    const doc2 = (await req('POST', docsUrl(type2, comp2), { token: mgr.token, body: { name: 'GST' } })).body.data;
    await req('POST', `${CT}/${type2}/publish`, { token: mgr.token });
    await req('POST', `${CT}/${type2}/archive`, { token: mgr.token });
    expect((await req('POST', docsUrl(type2, comp2), { token: mgr.token, body: { name: 'New' } })).status).toBe(422);
    expect((await req('PATCH', `${docsUrl(type2, comp2)}/${doc2.id}`, { token: mgr.token, body: { name: 'X' } })).status).toBe(422);
    expect((await req('GET', docsUrl(type2, comp2), { token: mgr.token })).status).toBe(200);
  });

  it('gates: viewer cannot manage (403), other tenant → 404, engine disabled → 403', async () => {
    const type = await makeType(); const comp = await makeComp(type);
    expect((await req('POST', docsUrl(type, comp), { token: viewer.token, body: { name: 'Z' } })).status).toBe(403);
    expect((await req('GET', docsUrl(type, comp), { token: otherMgr.token })).status).toBe(404);
    expect((await req('POST', docsUrl(type, comp), { token: otherMgr.token, body: { name: 'Z' } })).status).toBe(404);
    const disabled = await req('GET', docsUrl(type, comp), { token: disabledMgr.token });
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });

  it('a component from another case type is not addressable through this case type (404)', async () => {
    const typeA = await makeType(); const typeB = await makeType();
    const compB = await makeComp(typeB);
    expect((await req('GET', docsUrl(typeA, compB), { token: mgr.token })).status).toBe(404);
    expect((await req('POST', docsUrl(typeA, compB), { token: mgr.token, body: { name: 'Z' } })).status).toBe(404);
  });
});

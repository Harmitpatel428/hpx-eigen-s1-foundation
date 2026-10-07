/**
 * CaseTypeComponent CRUD — integration tests. Real Postgres.
 * Covers component create/update/archive/reactivate, duplicate-active-name (409),
 * includeInactive listing, archived-case-type rejection (422), tenant isolation (404),
 * and permission gating (403).
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `ctc-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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
let tenantId: string, otherTenantId: string;
let mgr: { id: string; token: string }, viewer: { id: string; token: string }, otherMgr: { token: string };

async function makeType(): Promise<string> {
  const c = await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'T' } });
  return c.body.data.id;
}

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid();
  tracked.push(tenantId, otherTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
  ]});
  mgr = await grant(tenantId, ['case-type:view', 'case-type:manage', 'case-type:publish']);
  viewer = await grant(tenantId, ['case-type:view']);
  otherMgr = await grant(otherTenantId, ['case-type:view', 'case-type:manage']);
  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    // componentDocument rows hold a Cascade FK to the component, but source rows
    // hold Restrict FKs to both — clear the dependants first.
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

describe('CaseTypeComponent CRUD', () => {
  it('create/list/update/archive/reactivate lifecycle', async () => {
    const type = await makeType();
    const created = await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'Aadhaar', description: 'ID', isMandatory: true, displayOrder: 2 } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Aadhaar', isMandatory: true, displayOrder: 2, isActive: true });
    const compId = created.body.data.id;

    const list = await req('GET', `${CT}/${type}/components`, { token: viewer.token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: any) => c.id)).toContain(compId);

    const patched = await req('PATCH', `${CT}/${type}/components/${compId}`, { token: mgr.token, body: { name: 'Aadhaar Card', isMandatory: false } });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ name: 'Aadhaar Card', isMandatory: false });

    // archive → disappears from default list, visible with includeInactive
    expect((await req('PATCH', `${CT}/${type}/components/${compId}`, { token: mgr.token, body: { isActive: false } })).status).toBe(200);
    expect((await req('GET', `${CT}/${type}/components`, { token: mgr.token })).body.data.map((c: any) => c.id)).not.toContain(compId);
    expect((await req('GET', `${CT}/${type}/components?includeInactive=true`, { token: mgr.token })).body.data.map((c: any) => c.id)).toContain(compId);

    // reactivate
    expect((await req('PATCH', `${CT}/${type}/components/${compId}`, { token: mgr.token, body: { isActive: true } })).status).toBe(200);
    expect((await req('GET', `${CT}/${type}/components`, { token: mgr.token })).body.data.map((c: any) => c.id)).toContain(compId);
  });

  it('duplicate active name → 409; allowed when existing is inactive', async () => {
    const type = await makeType();
    expect((await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'PAN' } })).status).toBe(201);
    expect((await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'PAN' } })).status).toBe(409);

    // archive the first, then same name is allowed again
    const first = (await req('GET', `${CT}/${type}/components`, { token: mgr.token })).body.data.find((c: any) => c.name === 'PAN');
    await req('PATCH', `${CT}/${type}/components/${first.id}`, { token: mgr.token, body: { isActive: false } });
    const second = await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'PAN' } });
    expect(second.status).toBe(201);

    // reactivating the first would now collide with the active second → 409
    expect((await req('PATCH', `${CT}/${type}/components/${first.id}`, { token: mgr.token, body: { isActive: true } })).status).toBe(409);
  });

  it('component config rejected (422) on an archived case type', async () => {
    const type = await makeType();
    await req('POST', `${CT}/${type}/publish`, { token: mgr.token });
    const comp = (await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'GST' } })).body.data;
    await req('POST', `${CT}/${type}/archive`, { token: mgr.token });
    expect((await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'New' } })).status).toBe(422);
    expect((await req('PATCH', `${CT}/${type}/components/${comp.id}`, { token: mgr.token, body: { name: 'X' } })).status).toBe(422);
    // reading still works for archived types (retained-assignment rendering)
    expect((await req('GET', `${CT}/${type}/components?includeInactive=true`, { token: mgr.token })).status).toBe(200);
  });

  it('validation: name required (400), name too long (400), displayOrder < 0 (400)', async () => {
    const type = await makeType();
    expect((await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: '  ' } })).status).toBe(400);
    expect((await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'x'.repeat(201) } })).status).toBe(400);
    expect((await req('POST', `${CT}/${type}/components`, { token: mgr.token, body: { name: 'ok', displayOrder: -1 } })).status).toBe(400);
  });

  it('permission + tenant isolation: viewer cannot manage (403); other tenant → 404', async () => {
    const type = await makeType();
    expect((await req('POST', `${CT}/${type}/components`, { token: viewer.token, body: { name: 'Z' } })).status).toBe(403);
    expect((await req('GET', `${CT}/${type}/components`, { token: otherMgr.token })).status).toBe(404);
    expect((await req('POST', `${CT}/${type}/components`, { token: otherMgr.token, body: { name: 'Z' } })).status).toBe(404);
  });
});

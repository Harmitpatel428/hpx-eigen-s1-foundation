/**
 * GET /api/v1/documentation/cases — assignedUser resolution (HTTP integration, real Postgres).
 * The "Assign" action writes lead.ownerId; assignedUser resolves from it first. For cases created
 * before the Assigned-column release (2026-11-19) it falls back to the legacy DocCase.assignedTo so
 * historical assignments still show; modern assignedTo-only cases stay unassigned. Tenant-scoped.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;
const trackedTenants: string[] = [];

function uid() { return crypto.randomUUID(); }

const ipSeq = { n: crypto.randomBytes(2).readUInt16BE(0) };
function testIp(): string {
  const n = ipSeq.n++ % 65536;
  return `10.${(n >> 8) & 0xff}.${n & 0xff}.1`;
}

async function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/v1/documentation${path}`, {
    headers: { 'X-Forwarded-For': testIp(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function makeSession(userId: string, tenantId: string): Promise<string> {
  const sessionId = uid();
  await prisma.session.create({
    data: {
      id: sessionId, userId, tenantId, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
      ipAddress: '127.0.0.1',
      refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex'),
    },
  });
  return jwt.sign({ sessionId, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

async function permId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded.`);
  return p.id;
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  server = http.createServer(app);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(res => server.close(() => res()));
  for (const tenantId of trackedTenants) {
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.department.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);


const pw = bcryptjs.hashSync('Password1!', 4);

async function mkUser(tenantId: string, slugs: string[]) {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { user, token: await makeSession(user.id, tenantId) };
}

async function mkCase(tenantId: string, createdBy: string, o: { ownerId?: string; assignedTo?: string; processAssignedTo?: string; createdAt?: Date } = {}) {
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'L', lastName: uid().slice(0, 6), ownerId: o.ownerId ?? null },
  });
  const c = await prisma.docCase.create({
    data: { tenantId, leadId: lead.id, createdBy, assignedTo: o.assignedTo ?? null, processAssignedTo: o.processAssignedTo ?? null, ...(o.createdAt ? { createdAt: o.createdAt } : {}) },
    select: { id: true },
  });
  return c.id;
}


describe('GET /documentation/cases — assignedUser (owner, with legacy assignedTo fallback)', () => {
  it('resolves owner; legacy assignedTo fallback shows; modern assignedTo-only stays unassigned', async () => {
    const tenantId = uid();
    trackedTenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `docassign-${tenantId.slice(0, 8)}` } });
    const otherTenant = uid();
    trackedTenants.push(otherTenant);
    await prisma.tenant.create({ data: { id: otherTenant, name: `docassign-${otherTenant.slice(0, 8)}` } });

    const viewer = await mkUser(tenantId, ['doc:view', 'doc:case:view-all']);
    const active = await mkUser(tenantId, ['doc:view']);
    const suspended = await mkUser(tenantId, ['doc:view']);
    const foreign = await mkUser(otherTenant, ['doc:view']);
    const other = await mkUser(tenantId, ['doc:view']);
    await prisma.user.update({ where: { id: active.user.id }, data: { firstName: 'Ada', lastName: 'Active' } });
    await prisma.user.update({ where: { id: suspended.user.id }, data: { firstName: 'Sam', lastName: 'Suspended', status: UserStatus.SUSPENDED } });
    await prisma.user.update({ where: { id: other.user.id }, data: { firstName: 'Otto', lastName: 'Other' } });

    // assigned: the lead is owned by the active user (this is what the Documentation Assign action writes).
    const cAssigned = await mkCase(tenantId, viewer.user.id, { ownerId: active.user.id });
    // unassigned: no owner.
    const cNone = await mkCase(tenantId, viewer.user.id);
    // owner is in another tenant → cannot resolve → null (missing-user state).
    const cForeign = await mkCase(tenantId, viewer.user.id, { ownerId: foreign.user.id });
    // suspended/restricted owner still resolves by name (Sales parity).
    const cSuspended = await mkCase(tenantId, viewer.user.id, { ownerId: suspended.user.id });
    // Precedence: the owner (Otto) always wins over DocCase.assignedTo (Ada), never shadowed.
    const cOwnerNotAssignedTo = await mkCase(tenantId, viewer.user.id, { ownerId: other.user.id, assignedTo: active.user.id });
    // MODERN case (created after the Assigned-column release): assignedTo-only is a transient
    // handoff, not an assignment — must stay unassigned (preserves the 8dab098 invariant).
    const cModernAssignedTo = await mkCase(tenantId, viewer.user.id, { assignedTo: active.user.id, createdAt: new Date('2099-01-01T00:00:00Z') });
    // LEGACY case (created before the release): assignedTo IS the historical assignee → show it.
    const cLegacyAssignedTo = await mkCase(tenantId, viewer.user.id, { assignedTo: active.user.id, createdAt: new Date('2000-01-01T00:00:00Z') });

    const res = await get('/cases', viewer.token);
    expect(res.status).toBe(200);
    const row = (id: string) => res.body.data.find((c: any) => c.id === id);
    expect(row(cAssigned).assignedUser).toEqual({ id: active.user.id, firstName: 'Ada', lastName: 'Active' });
    expect(row(cNone).assignedUser).toBeNull();
    expect(row(cForeign).assignedUser).toBeNull();
    expect(row(cSuspended).assignedUser).toEqual({ id: suspended.user.id, firstName: 'Sam', lastName: 'Suspended' });
    expect(row(cOwnerNotAssignedTo).assignedUser).toEqual({ id: other.user.id, firstName: 'Otto', lastName: 'Other' });
    expect(row(cModernAssignedTo).assignedUser).toBeNull();
    expect(row(cLegacyAssignedTo).assignedUser).toEqual({ id: active.user.id, firstName: 'Ada', lastName: 'Active' });
  });
});

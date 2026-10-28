/**
 * GET /api/v1/leads/bulk-assign/documentation-assignees — HTTP integration tests
 * Real Express router + auth/permission middleware + PostgreSQL, no mocks.
 * Pool = active tenant users who HOLD the `lead:receive:documentation` marker via a
 * NON-system role, regardless of department. Organization Admin (the only isSystem role,
 * which holds every permission) and plain lead:view holders (e.g. Sales Executives) are
 * excluded. Response still carries the resolved Documentation departmentId for AUTO.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createLeadsRouter } from '../../src/routes/leads.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const PATH = '/api/v1/leads/bulk-assign/documentation-assignees';

let server: http.Server;
let baseUrl: string;
const trackedTenants: string[] = [];

function uid() { return crypto.randomUUID(); }

const ipSeq = { n: crypto.randomBytes(2).readUInt16BE(0) };
function testIp(): string {
  const n = ipSeq.n++ % 65536;
  return `10.${(n >> 8) & 0xff}.${n & 0xff}.1`;
}

async function get(token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${PATH}`, {
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
  app.use('/api/v1/leads', createLeadsRouter(prisma));
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
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.department.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

async function makeTenant(callerSlugs: string[]) {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `docassign-${tenantId.slice(0, 8)}` } });
  const pw = await bcryptjs.hash('Password1!', 10);

  const callerRole = await prisma.role.create({ data: { tenantId, name: `Caller-${uid().slice(0, 6)}` } });
  for (const slug of callerSlugs) {
    await prisma.rolePermission.create({ data: { roleId: callerRole.id, permissionId: await permId(slug) } });
  }
  const caller = await prisma.user.create({
    data: { id: uid(), tenantId, email: `caller-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: caller.id, roleId: callerRole.id, scopeType: ScopeType.ORGANIZATION } });

  // An arbitrary non-caller role, to prove the pool has NO role filter.
  const someRole = await prisma.role.create({ data: { tenantId, name: `Random-${uid().slice(0, 6)}` } });
  const token = await makeSession(caller.id, tenantId);

  const mkUser = async (
    first: string,
    o: { dept?: string | null; role?: string | null; status?: UserStatus; deleted?: boolean },
  ) => {
    const u = await prisma.user.create({
      data: {
        id: uid(), tenantId, email: `${first.toLowerCase()}-${uid()}@test.invalid`, password: pw,
        firstName: first, lastName: 'Test', status: o.status ?? UserStatus.ACTIVE,
        departmentId: o.dept ?? null, deletedAt: o.deleted ? new Date() : null,
      },
    });
    if (o.role) await prisma.userRole.create({ data: { userId: u.id, roleId: o.role, scopeType: ScopeType.ORGANIZATION } });
    return u;
  };
  return { tenantId, token, someRole, mkUser };
}

// Helper: a role carrying exactly the given permission slugs, in the given tenant.
async function roleWith(tenantId: string, slugs: string[], isSystem = false): Promise<string> {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}`, isSystem } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  return role.id;
}

const MARKER = 'lead:receive:documentation';

describe('GET /bulk-assign/documentation-assignees (marker: lead:receive:documentation via non-system role)', () => {
  it('C1 — 403 without lead:assign', async () => {
    const t = await makeTenant(['lead:view']);
    const res = await get(t.token);
    expect(res.status).toBe(403);
  });

  it('C2 — returns active marker holders (non-system role); excludes system-role, lead:view-only, inactive, deleted', async () => {
    const t = await makeTenant(['lead:view', 'lead:assign']);
    const markerRole = await roleWith(t.tenantId, ['lead:view', MARKER]);
    const adminRole = await roleWith(t.tenantId, [MARKER], true);
    const leadViewOnly = await roleWith(t.tenantId, ['lead:view']);

    const included = await t.mkUser('Inc', { role: markerRole });
    const adminLike = await t.mkUser('Adm', { role: adminRole });
    const salesLike = await t.mkUser('Sal', { role: leadViewOnly });
    const noRole = await t.mkUser('NoRole', {});
    const inactive = await t.mkUser('Inactive', { role: markerRole, status: UserStatus.SUSPENDED });
    const deleted = await t.mkUser('Deleted', { role: markerRole, deleted: true });

    const res = await get(t.token);
    expect(res.status).toBe(200);
    const ids = res.body.users.map((u: any) => u.id);
    expect(ids).toContain(included.id);
    expect(ids).not.toContain(adminLike.id);
    expect(ids).not.toContain(salesLike.id);
    expect(ids).not.toContain(noRole.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(deleted.id);
    expect(Object.keys(res.body.users[0]).sort()).toEqual(['email', 'firstName', 'id', 'lastName']);
  });

  it('C3 — tenant isolation: another tenant\'s marker holders never returned', async () => {
    const a = await makeTenant(['lead:view', 'lead:assign']);
    const b = await makeTenant(['lead:view', 'lead:assign']);
    const mine = await a.mkUser('Mine', { role: await roleWith(a.tenantId, [MARKER]) });
    const theirs = await b.mkUser('Theirs', { role: await roleWith(b.tenantId, [MARKER]) });

    const res = await get(a.token);
    const ids = res.body.users.map((u: any) => u.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('C4 — departmentId still resolves the Documentation dept for AUTO (single → id; none/ambiguous → null)', async () => {
    const single = await makeTenant(['lead:view', 'lead:assign']);
    const d = await prisma.department.create({ data: { tenantId: single.tenantId, name: 'Documentation' } });
    expect((await get(single.token)).body.departmentId).toBe(d.id);

    const none = await makeTenant(['lead:view', 'lead:assign']);
    expect((await get(none.token)).body.departmentId).toBeNull();

    const ambiguous = await makeTenant(['lead:view', 'lead:assign']);
    await prisma.department.create({ data: { tenantId: ambiguous.tenantId, name: 'Documentation' } });
    await prisma.department.create({ data: { tenantId: ambiguous.tenantId, name: 'Doc Control' } });
    expect((await get(ambiguous.token)).body.departmentId).toBeNull();
  });

  it('C5 — pool is dept-independent: a marker holder is returned even with NO Documentation department', async () => {
    const t = await makeTenant(['lead:view', 'lead:assign']);
    const holder = await t.mkUser('Holder', { role: await roleWith(t.tenantId, [MARKER]) }); // no dept
    const res = await get(t.token);
    expect(res.status).toBe(200);
    expect(res.body.departmentId).toBeNull();
    expect(res.body.users.map((u: any) => u.id)).toContain(holder.id);
  });
});

/**
 * GET /api/v1/leads/bulk-assign/documentation-assignees — HTTP integration tests
 * Real Express router + auth/permission middleware + PostgreSQL, no mocks.
 * Pool = ALL active users in the Documentation department (NO role filter);
 * response also carries the resolved Documentation departmentId for AUTO.
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

describe('GET /bulk-assign/documentation-assignees', () => {
  it('D1 — 403 without lead:assign', async () => {
    const t = await makeTenant(['lead:view']);
    const res = await get(t.token);
    expect(res.status).toBe(403);
  });

  it('D2 — returns ALL active Documentation-dept users (no role filter), excluding inactive/deleted/wrong-dept', async () => {
    const t = await makeTenant(['lead:view', 'lead:assign']);
    const docs = await prisma.department.create({ data: { tenantId: t.tenantId, name: 'Documentation' } });
    const sales = await prisma.department.create({ data: { tenantId: t.tenantId, name: 'Sales' } });

    // All three below are in Documentation and must ALL be returned regardless of role.
    const amy = await t.mkUser('Amy', { dept: docs.id });                    // no role
    const bob = await t.mkUser('Bob', { dept: docs.id, role: t.someRole.id }); // arbitrary role
    const zed = await t.mkUser('Zed', { dept: docs.id });                    // no role
    // Excluded:
    await t.mkUser('WrongDept', { dept: sales.id });
    await t.mkUser('NoDept', {});
    await t.mkUser('Suspended', { dept: docs.id, status: UserStatus.SUSPENDED });
    await t.mkUser('Deleted', { dept: docs.id, deleted: true });

    const res = await get(t.token);
    expect(res.status).toBe(200);
    expect(res.body.departmentId).toBe(docs.id);
    expect(res.body.users.map((u: any) => u.id)).toEqual([amy.id, bob.id, zed.id]); // firstName asc
    expect(Object.keys(res.body.users[0]).sort()).toEqual(['email', 'firstName', 'id', 'lastName']);
  });

  it('D3 — tenant isolation: another tenant\'s Documentation users never returned', async () => {
    const a = await makeTenant(['lead:view', 'lead:assign']);
    const b = await makeTenant(['lead:view', 'lead:assign']);
    const docsA = await prisma.department.create({ data: { tenantId: a.tenantId, name: 'Documentation' } });
    const docsB = await prisma.department.create({ data: { tenantId: b.tenantId, name: 'Documentation' } });
    const mine = await a.mkUser('Mine', { dept: docsA.id });
    const theirs = await b.mkUser('Theirs', { dept: docsB.id });

    const res = await get(a.token);
    const ids = res.body.users.map((u: any) => u.id);
    expect(ids).toEqual([mine.id]);
    expect(ids).not.toContain(theirs.id);
  });

  it('D4 — no Documentation dept -> 200 {departmentId:null,users:[]}; dept but no users -> 200 {departmentId,users:[]}', async () => {
    const noDept = await makeTenant(['lead:view', 'lead:assign']);
    const sales = await prisma.department.create({ data: { tenantId: noDept.tenantId, name: 'Sales' } });
    await noDept.mkUser('SalesGuy', { dept: sales.id });
    const r1 = await get(noDept.token);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ departmentId: null, users: [] });

    const noUsers = await makeTenant(['lead:view', 'lead:assign']);
    const docs = await prisma.department.create({ data: { tenantId: noUsers.tenantId, name: 'Documentation' } });
    const r2 = await get(noUsers.token);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ departmentId: docs.id, users: [] });
  });

  it('D5 — multiple Documentation depts -> departmentId null (ambiguous), users span all', async () => {
    const t = await makeTenant(['lead:view', 'lead:assign']);
    const d1 = await prisma.department.create({ data: { tenantId: t.tenantId, name: 'Documentation' } });
    const d2 = await prisma.department.create({ data: { tenantId: t.tenantId, name: 'Doc Control' } });
    const u1 = await t.mkUser('Ann', { dept: d1.id });
    const u2 = await t.mkUser('Cyd', { dept: d2.id });

    const res = await get(t.token);
    expect(res.status).toBe(200);
    expect(res.body.departmentId).toBeNull();
    expect(res.body.users.map((u: any) => u.id).sort()).toEqual([u1.id, u2.id].sort());
  });
});

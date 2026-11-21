/**
 * RED TEAM — PUT /api/v1/users/:id/password (admin member password reset).
 * Adversarial suite: target manipulation, cross-tenant, concurrency, atomicity,
 * revoked/expired sessions, password boundaries. Local test DB only.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType, SessionStatus } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createUsersRouter } from '../../src/routes/users.router';
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

async function put(path: string, token: string | undefined, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/v1/users${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': testIp(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: any;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

async function makeSession(
  userId: string, tenantId: string,
  opts: { status?: SessionStatus; expiresAt?: Date } = {},
): Promise<{ token: string; sessionId: string }> {
  const sessionId = uid();
  await prisma.session.create({
    data: {
      id: sessionId, userId, tenantId,
      status: opts.status ?? SessionStatus.ACTIVE,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 3_600_000),
      ipAddress: '127.0.0.1',
      refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex'),
    },
  });
  return { token: jwt.sign({ sessionId, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' }), sessionId };
}

async function permId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded.`);
  return p.id;
}

async function mkUser(tenantId: string, slugs: string[], password = 'Initial9#Secure!') {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: bcryptjs.hashSync(password, 4), status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const session = await makeSession(user.id, tenantId);
  return { user, ...session };
}

const hashOf = async (id: string) =>
  (await prisma.user.findUnique({ where: { id }, select: { password: true } }))!.password!;

async function mkTenant(label: string) {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `${label}-${tenantId.slice(0, 8)}` } });
  return tenantId;
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/users', createUsersRouter(prisma));
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
    await prisma.notification.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

describe('RED TEAM — admin password reset', () => {
  it('body cannot override the route target (mass assignment)', async () => {
    const t = await mkTenant('rt-massassign');
    const admin = await mkUser(t, ['user:password:reset']);
    const a = await mkUser(t, ['lead:view']);
    const b = await mkUser(t, ['lead:view']);
    const adminBefore = await hashOf(admin.user.id);
    const bBefore = await hashOf(b.user.id);

    // Attacker stuffs other identifiers into the body; the ROUTE param must win.
    const res = await put(`/${a.user.id}/password`, admin.token, {
      newPassword: 'Zq7#Strongpass!',
      id: b.user.id, userId: b.user.id, targetUserId: b.user.id,
      tenantId: uid(), password: 'ignored', role: 'Organization Admin',
    });

    expect(res.status).toBe(200);
    expect(await bcryptjs.compare('Zq7#Strongpass!', await hashOf(a.user.id))).toBe(true); // A changed
    expect(await hashOf(b.user.id)).toBe(bBefore);        // B untouched by body injection
    expect(await hashOf(admin.user.id)).toBe(adminBefore); // admin untouched
  }, 30_000);

  it('concurrent resets for different targets do not cross-contaminate', async () => {
    const t = await mkTenant('rt-concurrent');
    const admin = await mkUser(t, ['user:password:reset']);
    const a = await mkUser(t, ['lead:view']);
    const b = await mkUser(t, ['lead:view']);
    const adminBefore = await hashOf(admin.user.id);
    const PW_A = 'Alpha5#Concurr!';
    const PW_B = 'Bravo6#Concurr!';

    const [ra, rb] = await Promise.all([
      put(`/${a.user.id}/password`, admin.token, { newPassword: PW_A }),
      put(`/${b.user.id}/password`, admin.token, { newPassword: PW_B }),
    ]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(await bcryptjs.compare(PW_A, await hashOf(a.user.id))).toBe(true);
    expect(await bcryptjs.compare(PW_B, await hashOf(b.user.id))).toBe(true);
    expect(await hashOf(admin.user.id)).toBe(adminBefore);
  }, 30_000);

  it('duplicate rapid submissions for the same target leave consistent state', async () => {
    const t = await mkTenant('rt-dupe');
    const admin = await mkUser(t, ['user:password:reset']);
    const a = await mkUser(t, ['lead:view']);
    const PW = 'Delta8#Repeat!!';

    const results = await Promise.all([
      put(`/${a.user.id}/password`, admin.token, { newPassword: PW }),
      put(`/${a.user.id}/password`, admin.token, { newPassword: PW }),
      put(`/${a.user.id}/password`, admin.token, { newPassword: PW }),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    // Whichever write landed last, the stored hash must verify the password exactly once-consistent.
    expect(await bcryptjs.compare(PW, await hashOf(a.user.id))).toBe(true);
    // All of the target's sessions are revoked, none left ACTIVE/CREATED.
    const live = await prisma.session.count({
      where: { userId: a.user.id, status: { in: [SessionStatus.ACTIVE, SessionStatus.CREATED] } },
    });
    expect(live).toBe(0);
  }, 30_000);

  it('a rejected request writes nothing (no partial state)', async () => {
    const t = await mkTenant('rt-atomic');
    const admin = await mkUser(t, ['user:password:reset']);
    const a = await mkUser(t, ['lead:view']);
    const before = await hashOf(a.user.id);
    const liveBefore = await prisma.session.count({
      where: { userId: a.user.id, status: { in: [SessionStatus.ACTIVE, SessionStatus.CREATED] } },
    });
    expect(liveBefore).toBeGreaterThan(0);

    const weak = await put(`/${a.user.id}/password`, admin.token, { newPassword: 'short' });
    expect(weak.status).toBe(400);

    expect(await hashOf(a.user.id)).toBe(before);           // hash untouched
    const liveAfter = await prisma.session.count({
      where: { userId: a.user.id, status: { in: [SessionStatus.ACTIVE, SessionStatus.CREATED] } },
    });
    expect(liveAfter).toBe(liveBefore);                      // sessions NOT revoked on failure
  }, 30_000);

  it('password boundaries are enforced at the API edge', async () => {
    const t = await mkTenant('rt-bounds');
    const admin = await mkUser(t, ['user:password:reset']);
    const a = await mkUser(t, ['lead:view']);
    const before = await hashOf(a.user.id);

    const reject = async (pw: unknown) => (await put(`/${a.user.id}/password`, admin.token, { newPassword: pw })).status;

    expect(await reject('')).toBe(400);                       // empty
    expect(await reject('Aa1!bcdefgh')).toBe(400);            // 11 chars — one under min
    expect(await reject('Aa1!' + 'x'.repeat(69))).toBe(400);  // 73 chars — one over bcrypt cap
    expect(await reject('alllowercase1!')).toBe(400);         // no uppercase
    expect(await reject(12345678901234)).toBe(400);           // non-string
    expect(await reject(null)).toBe(400);                     // null
    expect(await reject({ a: 1 })).toBe(400);                 // object
    expect(await hashOf(a.user.id)).toBe(before);             // nothing written by any rejection

    // Accepted boundaries.
    expect((await put(`/${a.user.id}/password`, admin.token, { newPassword: 'Aa1!bcdefghi' })).status).toBe(200); // 12
    expect((await put(`/${a.user.id}/password`, admin.token, { newPassword: 'Aa1!' + 'x'.repeat(68) })).status).toBe(200); // 72
  }, 30_000);

  it('revoked and expired sessions are rejected', async () => {
    const t = await mkTenant('rt-session');
    const admin = await mkUser(t, ['user:password:reset']);
    const a = await mkUser(t, ['lead:view']);
    const before = await hashOf(a.user.id);

    // Admin holds the permission but the session is revoked.
    const revoked = await makeSession(admin.user.id, t, { status: SessionStatus.REVOKED });
    const r1 = await put(`/${a.user.id}/password`, revoked.token, { newPassword: 'Echo9#Revoked!!' });
    expect([401, 403]).toContain(r1.status);

    // Expired session.
    const expired = await makeSession(admin.user.id, t, { expiresAt: new Date(Date.now() - 60_000) });
    const r2 = await put(`/${a.user.id}/password`, expired.token, { newPassword: 'Echo9#Expired!!' });
    expect([401, 403]).toContain(r2.status);

    // Garbage / unsigned token.
    const r3 = await put(`/${a.user.id}/password`, 'not-a-jwt', { newPassword: 'Echo9#Garbage!!' });
    expect([401, 403]).toContain(r3.status);

    expect(await hashOf(a.user.id)).toBe(before); // nothing written by any rejected auth
  }, 30_000);

  it('cross-tenant target is 404 and writes nothing, even for a real admin', async () => {
    const tA = await mkTenant('rt-xt-a');
    const tB = await mkTenant('rt-xt-b');
    const admin = await mkUser(tA, ['user:password:reset']);
    const victim = await mkUser(tB, ['lead:view']);
    const before = await hashOf(victim.user.id);

    const res = await put(`/${victim.user.id}/password`, admin.token, { newPassword: 'Foxtrot7#Cross!' });
    expect(res.status).toBe(404);
    expect(await hashOf(victim.user.id)).toBe(before);
  }, 30_000);

  it('delegated manager (user:manage, no reset marker) is 403 and writes nothing', async () => {
    const t = await mkTenant('rt-deleg');
    const mgr = await mkUser(t, ['user:manage', 'user:view']);
    const a = await mkUser(t, ['lead:view']);
    const before = await hashOf(a.user.id);

    const res = await put(`/${a.user.id}/password`, mgr.token, { newPassword: 'Golf4#Delegated!' });
    expect(res.status).toBe(403);
    expect(await hashOf(a.user.id)).toBe(before);
  }, 30_000);
});

/**
 * PUT /api/v1/users/:id/password — admin-only member password reset (Issue 3).
 * HTTP integration against real Postgres. Covers the positive path (hash changed +
 * sessions revoked) and the security negatives: non-admin 403, cross-tenant 404,
 * self 4xx, weak password 400.
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

async function makeSession(userId: string, tenantId: string): Promise<{ token: string; sessionId: string }> {
  const sessionId = uid();
  await prisma.session.create({
    data: {
      id: sessionId, userId, tenantId, status: SessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 3_600_000),
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

async function mkUser(tenantId: string, slugs: string[], password = 'OldPassw0rd!') {
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

describe('PUT /users/:id/password — admin member password reset', () => {
  it('enforces the full security contract', async () => {
    const tenantId = uid();
    trackedTenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `pwreset-${tenantId.slice(0, 8)}` } });
    const otherTenant = uid();
    trackedTenants.push(otherTenant);
    await prisma.tenant.create({ data: { id: otherTenant, name: `pwreset-${otherTenant.slice(0, 8)}` } });

    const admin = await mkUser(tenantId, ['user:password:reset', 'user:view']);
    const target = await mkUser(tenantId, ['lead:view']);
    const plain = await mkUser(tenantId, ['lead:view']); // no admin perms at all
    // Delegated manager: holds user:manage (invite/suspend/terminate) but NOT the strictly-admin
    // reset marker. Must be rejected — this is the privilege-escalation guard.
    const delegatedMgr = await mkUser(tenantId, ['user:manage', 'user:view']);
    const foreign = await mkUser(otherTenant, ['lead:view']);

    const NEW = 'N3w!StrongPass';

    // 1. Happy path: admin resets target → 200, password hash changes, target session revoked.
    const ok = await put(`/${target.user.id}/password`, admin.token, { newPassword: NEW });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    const after = await prisma.user.findUnique({ where: { id: target.user.id }, select: { password: true } });
    expect(await bcryptjs.compare(NEW, after!.password!)).toBe(true);
    expect(await bcryptjs.compare('OldPassw0rd!', after!.password!)).toBe(false);

    const targetSession = await prisma.session.findUnique({ where: { id: target.sessionId }, select: { status: true } });
    expect(targetSession!.status).toBe(SessionStatus.REVOKED);

    // 2. Non-admin caller → 403 (server-enforced, not just UI).
    const forbidden = await put(`/${target.user.id}/password`, plain.token, { newPassword: NEW });
    expect(forbidden.status).toBe(403);

    // 2b. Delegated manager WITH user:manage but WITHOUT user:password:reset → 403.
    //     Proves the gate no longer rides on user:manage (privilege-escalation fix).
    const delegated = await put(`/${target.user.id}/password`, delegatedMgr.token, { newPassword: NEW });
    expect(delegated.status).toBe(403);

    // 3. Cross-tenant target → 404 (no existence leak).
    const crossTenant = await put(`/${foreign.user.id}/password`, admin.token, { newPassword: NEW });
    expect(crossTenant.status).toBe(404);

    // 4. Self → blocked (self uses /auth/change-password; avoids self-lockout).
    const self = await put(`/${admin.user.id}/password`, admin.token, { newPassword: NEW });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect(self.status).toBeLessThan(500);

    // 5. Weak password → 400, and the target's current (new) password is unchanged.
    const weak = await put(`/${target.user.id}/password`, admin.token, { newPassword: 'weak' });
    expect(weak.status).toBe(400);
    const stillNew = await prisma.user.findUnique({ where: { id: target.user.id }, select: { password: true } });
    expect(await bcryptjs.compare(NEW, stillNew!.password!)).toBe(true);

    // 6. Missing body field → 400.
    const missing = await put(`/${target.user.id}/password`, admin.token, {});
    expect(missing.status).toBe(400);

    // 7. Unauthenticated → 401.
    const anon = await put(`/${target.user.id}/password`, undefined, { newPassword: NEW });
    expect(anon.status).toBe(401);
  }, 30_000);

  it('changes ONLY the targeted member — other members and the acting admin are untouched', async () => {
    const tenantId = uid();
    trackedTenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `pwiso-${tenantId.slice(0, 8)}` } });

    const admin = await mkUser(tenantId, ['user:password:reset', 'user:view']);
    const memberA = await mkUser(tenantId, ['lead:view']);
    const memberB = await mkUser(tenantId, ['lead:view']);

    const hashOf = async (id: string) =>
      (await prisma.user.findUnique({ where: { id }, select: { password: true } }))!.password!;

    const adminBefore = await hashOf(admin.user.id);
    const bBefore = await hashOf(memberB.user.id);

    const NEW_A = 'Alpha9#Rotate!x';
    const NEW_B = 'Bravo7#Rotate!x';

    // Reset A → ONLY A's hash changes.
    expect((await put(`/${memberA.user.id}/password`, admin.token, { newPassword: NEW_A })).status).toBe(200);
    expect(await bcryptjs.compare(NEW_A, await hashOf(memberA.user.id))).toBe(true);
    expect(await hashOf(memberB.user.id)).toBe(bBefore);   // B untouched
    expect(await hashOf(admin.user.id)).toBe(adminBefore); // acting admin untouched

    // Reset B → ONLY B's hash changes; A keeps the hash it just got.
    const aAfterFirstReset = await hashOf(memberA.user.id);
    expect((await put(`/${memberB.user.id}/password`, admin.token, { newPassword: NEW_B })).status).toBe(200);
    expect(await bcryptjs.compare(NEW_B, await hashOf(memberB.user.id))).toBe(true);
    expect(await hashOf(memberA.user.id)).toBe(aAfterFirstReset); // A untouched by B's reset
    expect(await hashOf(admin.user.id)).toBe(adminBefore);        // admin STILL untouched

    // The admin's own session survived both resets (only the target's are revoked) —
    // proven by admin.token still authorizing the second call above.

    // Malformed target id must fail safely (4xx), never a 500.
    const malformed = await put('/not-a-uuid/password', admin.token, { newPassword: NEW_A });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
  }, 30_000);
});

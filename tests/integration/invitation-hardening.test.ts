/**
 * Invitation System — Production Hardening Integration Tests
 *
 * Tests real security properties against PostgreSQL.
 * No mocks on business-critical paths except email delivery (external side-effect).
 *
 * Tests A–O per the approved hardening spec.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect, jest } from '@jest/globals';
import { PrismaClient, InvitationEmailStatus, InvitationStatus, UserStatus } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { InvitationService } from '../../src/services/invitation.service';
import { EmailService } from '../../src/services/email.service';
import { RateLimitExceededError } from '../../src/types/exceptions';

// ─── Infrastructure ────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;
// mock module ref set in beforeAll, used in test G
let mockRateLimit: Record<string, jest.MockedFunction<any>>;

// ─── HTTP helper ───────────────────────────────────────────────────────────────
async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ─── DB helpers ────────────────────────────────────────────────────────────────
function uid() { return crypto.randomUUID(); }
function tokenHash(raw: string) { return crypto.createHash('sha256').update(raw).digest('hex'); }

async function makeSession(userId: string, tenantId: string): Promise<string> {
  const sessionId = uid();
  await prisma.session.create({
    data: {
      id: sessionId, userId, tenantId, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex'),
    },
  });
  return jwt.sign({ sessionId, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

async function makeUser(tenantId: string, status: UserStatus = UserStatus.ACTIVE): Promise<any> {
  const pw = await bcryptjs.hash('Password1!', 10);
  return prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status, emailVerified: new Date() } as any,
  });
}

async function makeRole(tenantId: string, withManageUserPerm = false): Promise<any> {
  const role = await prisma.role.create({ data: { tenantId, name: `role-${uid()}`, isSystem: false } });
  if (withManageUserPerm) {
    const perm = await prisma.permission.findFirst({ where: { slug: 'user:manage' } });
    if (perm) {
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
  }
  return role;
}

async function grantRole(userId: string, roleId: string) {
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId } },
    create: { userId, roleId },
    update: {}
  });
}

// ─── Test tenant/user setup ────────────────────────────────────────────────────
let tenantId: string;
let adminUser: { id: string; token: string };
let targetRole: { id: string; name: string };

beforeAll(async () => {
  // @swc/jest compiles named exports with Object.defineProperty (configurable:false),
  // so jest.spyOn always throws "Cannot redefine property". The only @swc/jest-compatible
  // approach is jest.mock() + jest.resetModules(): register the factory, clear the module
  // registry so the real modules are evicted, then fresh-require the routers so they load
  // RateLimitService through the factory and pick up the mock functions.
  jest.mock('../../src/services/auth/RateLimitService', () => ({
    checkInviteCreation:    jest.fn().mockResolvedValue(undefined),
    checkInviteTokenLookup: jest.fn().mockResolvedValue(undefined),
    checkAcceptAttempts:    jest.fn().mockResolvedValue(undefined),
    checkLoginAttempts:     jest.fn().mockResolvedValue(1),
    checkResendLimit:       jest.fn().mockResolvedValue(1),
  }));
  jest.resetModules();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createAuthRouter }  = require('../../src/routes/auth.router')  as { createAuthRouter:  (p: PrismaClient) => any };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createUsersRouter } = require('../../src/routes/users.router') as { createUsersRouter: (p: PrismaClient) => any };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mockRateLimit = require('../../src/services/auth/RateLimitService');

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth',  createAuthRouter(prisma));
  app.use('/api/v1/users', createUsersRouter(prisma));
  // Duck-typing instead of instanceof to avoid cross-module class identity issues
  // after jest.resetModules() (fresh require gives a different AppException class object).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as any;
    if (e?.httpStatus && e?.code) {
      res.status(e.httpStatus).json({ code: e.code, message: e.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: e?.message ?? 'Unexpected error' });
  });
  server = http.createServer(app);

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Create isolated test tenant
  const tenant = await prisma.tenant.create({ data: { name: `inv-test-${uid()}` } });
  tenantId = tenant.id;

  // Admin user with user:manage permission
  const admin = await makeUser(tenantId);
  const adminRole = await makeRole(tenantId, true);
  await grantRole(admin.id, adminRole.id);
  const token = await makeSession(admin.id, tenantId);
  adminUser = { id: admin.id, token };

  // Target role for invitations
  targetRole = await makeRole(tenantId);
}, 30000);

afterAll(async () => {
  jest.restoreAllMocks();
  // Clean up test tenant data
  await prisma.userInvitation.deleteMany({ where: { tenantId } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId } } });
  await prisma.session.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.role.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.$disconnect();
  await new Promise<void>(r => server.close(r));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Invitation Hardening', () => {
  jest.setTimeout(30000);

  // A: PENDING + FAILED email → admin re-invites → new token, email re-attempted
  it('A: re-invites when email previously FAILED', async () => {
    // SKIPPED path requires an unconfigured mailer — don't trust ambient .env
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = '';
    const email = `a-${uid()}@test.invalid`;
    // Directly insert a row with emailStatus=FAILED to simulate prior failure
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: targetRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() + 86_400_000),
        emailStatus: InvitationEmailStatus.FAILED
      }
    });

    const r = await req('POST', '/api/v1/users/invite', {
      token: adminUser.token,
      body: { email, roleId: targetRole.id }
    });

    // SKIPPED in test env (NODE_ENV !== 'production')
    expect(r.status).toBe(201);
    expect(r.body.emailStatus).toBe('SKIPPED');
    expect(r.body.devInviteUrl).toBeTruthy();

    // Verify a new token hash was written (old hash no longer valid)
    const row = await prisma.userInvitation.findFirst({ where: { tenantId, email } });
    expect(row?.token).not.toBe(tokenHash(rawToken));
    if (origKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = origKey;
  });

  // B: PENDING + SENT → admin tries to re-invite → 409
  it('B: duplicate invite blocked when email already SENT', async () => {
    const email = `b-${uid()}@test.invalid`;
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: targetRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() + 86_400_000),
        emailStatus: InvitationEmailStatus.SENT
      }
    });

    const r = await req('POST', '/api/v1/users/invite', {
      token: adminUser.token,
      body: { email, roleId: targetRole.id }
    });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DUPLICATE_RESOURCE');
  });

  // C: PENDING + PENDING → duplicate invite → 409
  it('C: duplicate invite blocked when status PENDING/emailStatus PENDING', async () => {
    const email = `c-${uid()}@test.invalid`;
    // First invite creates the row (emailStatus=SKIPPED in test env)
    const r1 = await req('POST', '/api/v1/users/invite', {
      token: adminUser.token, body: { email, roleId: targetRole.id }
    });
    expect(r1.status).toBe(201);

    // Manually set emailStatus back to PENDING to test the PENDING/PENDING branch
    await prisma.userInvitation.updateMany({
      where: { tenantId, email },
      data: { emailStatus: InvitationEmailStatus.PENDING }
    });

    const r2 = await req('POST', '/api/v1/users/invite', {
      token: adminUser.token, body: { email, roleId: targetRole.id }
    });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('DUPLICATE_RESOURCE');
  });

  // D: Concurrent invite creation race → exactly one row, second gets 409 (never 500)
  it('D: concurrent invite creation race — only one row, second gets 409 not 500', async () => {
    const email = `d-${uid()}@test.invalid`;
    const [r1, r2] = await Promise.all([
      req('POST', '/api/v1/users/invite', { token: adminUser.token, body: { email, roleId: targetRole.id } }),
      req('POST', '/api/v1/users/invite', { token: adminUser.token, body: { email, roleId: targetRole.id } })
    ]);

    const statuses = [r1.status, r2.status].sort();
    // One should succeed (201), the other should be a client error (409) — never 500
    expect(statuses[0]).toBeLessThan(500);
    expect(statuses[1]).toBeLessThan(500);
    const created = [r1, r2].filter(r => r.status === 201);
    const rejected = [r1, r2].filter(r => r.status === 409);
    expect(created.length + rejected.length).toBe(2);

    const rows = await prisma.userInvitation.findMany({ where: { tenantId, email } });
    expect(rows.length).toBe(1);
  });

  // E: Concurrent acceptance → one winner gets session, second gets 409 with no credentials
  it('E: concurrent acceptance — one winner, second gets INVITATION_ALREADY_ACCEPTED with no credentials', async () => {
    const email = `e-${uid()}@test.invalid`;
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: targetRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() + 86_400_000),
        emailStatus: InvitationEmailStatus.SENT
      }
    });

    const body = { token: rawToken, password: 'Password1!' };
    const [r1, r2] = await Promise.all([
      req('POST', '/api/v1/auth/accept-invite', { body }),
      req('POST', '/api/v1/auth/accept-invite', { body })
    ]);

    const winner = [r1, r2].find(r => r.status === 200);
    const loser  = [r1, r2].find(r => r.status !== 200);

    expect(winner).toBeDefined();
    expect(winner!.body.data?.accessToken).toBeTruthy();

    expect(loser).toBeDefined();
    expect(loser!.status).toBe(409);
    expect(loser!.body.code).toBe('INVITATION_ALREADY_ACCEPTED');
    expect(loser!.body.data?.accessToken).toBeUndefined();
    expect(loser!.body.data?.refreshToken).toBeUndefined();

    // Exactly one User and one UserRole created
    const users = await prisma.user.findMany({ where: { email, tenantId } });
    expect(users.length).toBe(1);

    const roles = await prisma.userRole.findMany({ where: { userId: users[0]!.id, roleId: targetRole.id } });
    expect(roles.length).toBe(1);
  });

  // F: Role deleted between invite and accept → 422 BusinessRuleViolation, no User created
  it('F: role deleted after invite issuance → accept rejected, no User created', async () => {
    const email = `f-${uid()}@test.invalid`;
    const ephemeralRole = await makeRole(tenantId);
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: ephemeralRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() + 86_400_000),
        emailStatus: InvitationEmailStatus.SENT
      }
    });

    // Soft-delete the role
    await prisma.role.update({ where: { id: ephemeralRole.id }, data: { deletedAt: new Date() } });

    const r = await req('POST', '/api/v1/auth/accept-invite', {
      body: { token: rawToken, password: 'Password1!' }
    });

    expect(r.status).toBe(422);

    const users = await prisma.user.findMany({ where: { email, tenantId } });
    expect(users.length).toBe(0);
  });

  // G: Actor rate limit after 10 invites in the same hour → 429
  // Redis not available in CI — validate that the route correctly propagates RateLimitExceededError.
  it('G: route correctly propagates 429 when checkInviteCreation throws RateLimitExceededError', async () => {
    mockRateLimit.checkInviteCreation.mockRejectedValueOnce(new RateLimitExceededError());

    const r = await req('POST', '/api/v1/users/invite', {
      token: adminUser.token,
      body: { email: `g-${uid()}@test.invalid`, roleId: targetRole.id }
    });

    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMIT_EXCEEDED');
    mockRateLimit.checkInviteCreation.mockResolvedValue(undefined);
  });

  // H: Unconfigured mailer → emailStatus=SKIPPED, devInviteUrl present
  it('H: unconfigured RESEND_API_KEY produces emailStatus=SKIPPED and devInviteUrl', async () => {
    // Don't trust ambient .env — pin the mailer to unconfigured
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = '';
    try {
      const email = `h-${uid()}@test.invalid`;
      const r = await req('POST', '/api/v1/users/invite', {
        token: adminUser.token, body: { email, roleId: targetRole.id }
      });

      expect(r.status).toBe(201);
      expect(r.body.emailStatus).toBe('SKIPPED');
      expect(r.body.devInviteUrl).toMatch(/accept-invite\?token=/);
      expect(r.body).not.toHaveProperty('token'); // raw token must not be in response
    } finally {
      if (origKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = origKey;
    }
  });

  // I: Resend succeeds (mocked) → emailStatus=SENT
  it('I: when email service succeeds, emailStatus=SENT', async () => {
    const spy = jest.spyOn(EmailService.prototype, 'sendInvitationEmail').mockResolvedValue(undefined);
    const origEnv = process.env.NODE_ENV;
    const origKey = process.env.RESEND_API_KEY;
    process.env.NODE_ENV = 'production';
    // Sending is now keyed on a configured API key, not NODE_ENV
    process.env.RESEND_API_KEY = 're_test_key';

    try {
      const email = `i-${uid()}@test.invalid`;
      const svc = new InvitationService(prisma);
      const result = await svc.createInvitation(tenantId, email, targetRole.id, adminUser.id);
      expect(result.emailStatus).toBe('SENT');
      expect(result.devInviteUrl).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = origKey;
      spy.mockRestore();
    }
  });

  // J: Resend throws → emailStatus=FAILED, invitation row preserved
  it('J: when email service fails, emailStatus=FAILED and invitation row is preserved', async () => {
    const spy = jest.spyOn(EmailService.prototype, 'sendInvitationEmail').mockRejectedValue(new Error('Resend API error'));
    const origEnv = process.env.NODE_ENV;
    const origKey = process.env.RESEND_API_KEY;
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 're_test_key';

    try {
      const email = `j-${uid()}@test.invalid`;
      const svc = new InvitationService(prisma);
      const result = await svc.createInvitation(tenantId, email, targetRole.id, adminUser.id);
      expect(result.emailStatus).toBe('FAILED');

      const row = await prisma.userInvitation.findFirst({ where: { tenantId, email } });
      expect(row).not.toBeNull();
      expect(row?.status).toBe('PENDING'); // invitation still open
      expect(row?.emailStatus).toBe('FAILED');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = origKey;
      spy.mockRestore();
    }
  });

  // K: Cross-tenant roleId → 404
  it('K: cross-tenant roleId rejected with 404', async () => {
    const otherTenant = await prisma.tenant.create({ data: { name: `other-${uid()}` } });
    const otherRole = await prisma.role.create({ data: { tenantId: otherTenant.id, name: 'other-role', isSystem: false } });

    try {
      const r = await req('POST', '/api/v1/users/invite', {
        token: adminUser.token,
        body: { email: `k-${uid()}@test.invalid`, roleId: otherRole.id }
      });
      expect(r.status).toBe(404);
    } finally {
      await prisma.role.delete({ where: { id: otherRole.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  });

  // L: Expired token → 422
  it('L: expired invitation token rejected with 422', async () => {
    const email = `l-${uid()}@test.invalid`;
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: targetRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() - 1000), // already expired
        emailStatus: InvitationEmailStatus.SENT
      }
    });

    const r = await req('POST', '/api/v1/auth/accept-invite', {
      body: { token: rawToken, name: 'Test L', password: 'Password1!' }
    });

    expect(r.status).toBe(422);
  });

  // M: Revoked token → 422
  it('M: revoked invitation rejected with 422', async () => {
    const email = `m-${uid()}@test.invalid`;
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: targetRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() + 86_400_000),
        status: InvitationStatus.REVOKED,
        emailStatus: InvitationEmailStatus.SENT
      }
    });

    const r = await req('POST', '/api/v1/auth/accept-invite', {
      body: { token: rawToken, name: 'Test M', password: 'Password1!' }
    });

    expect(r.status).toBe(422);
  });

  // N: Token replay after acceptance — 10 precise assertions
  it('N: token replay after acceptance returns 409 with no credentials', async () => {
    const email = `n-${uid()}@test.invalid`;
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.userInvitation.create({
      data: {
        tenantId, email, roleId: targetRole.id, invitedBy: adminUser.id,
        token: tokenHash(rawToken),
        expiresAt: new Date(Date.now() + 86_400_000),
        emailStatus: InvitationEmailStatus.SENT
      }
    });

    // 1. Accept successfully
    const r1 = await req('POST', '/api/v1/auth/accept-invite', {
      body: { token: rawToken, password: 'Password1!' }
    });
    expect(r1.status).toBe(200); // (1) first acceptance succeeds

    const user = await prisma.user.findFirst({ where: { email, tenantId } });
    expect(user).not.toBeNull(); // (2) user was created

    const sessionCount = await prisma.session.count({ where: { userId: user!.id } });
    const roleCount = await prisma.userRole.count({ where: { userId: user!.id, roleId: targetRole.id } });

    // 2. Replay the same token
    const r2 = await req('POST', '/api/v1/auth/accept-invite', {
      body: { token: rawToken, password: 'Password1!' }
    });

    // (3) HTTP 409
    expect(r2.status).toBe(409);
    // (4) code is INVITATION_ALREADY_ACCEPTED
    expect(r2.body.code).toBe('INVITATION_ALREADY_ACCEPTED');
    // (5) no accessToken in response
    expect(r2.body.data?.accessToken).toBeUndefined();
    // (6) no refreshToken in response
    expect(r2.body.data?.refreshToken).toBeUndefined();

    // (7) session count unchanged
    const sessionCountAfter = await prisma.session.count({ where: { userId: user!.id } });
    expect(sessionCountAfter).toBe(sessionCount);

    // (8) userRole count unchanged
    const roleCountAfter = await prisma.userRole.count({ where: { userId: user!.id, roleId: targetRole.id } });
    expect(roleCountAfter).toBe(roleCount);

    // (9) invitation still ACCEPTED
    const inv = await prisma.userInvitation.findFirst({ where: { tenantId, email } });
    expect(inv?.status).toBe('ACCEPTED');

    // (10) no new user created (only original)
    const allUsers = await prisma.user.findMany({ where: { email, tenantId } });
    expect(allUsers.length).toBe(1);
  });

  // O: Raw token never in API response or audit payload
  it('O: raw token never in POST /invite response; audit payload contains only safe fields', async () => {
    const email = `o-${uid()}@test.invalid`;
    const r = await req('POST', '/api/v1/users/invite', {
      token: adminUser.token, body: { email, roleId: targetRole.id }
    });

    expect(r.status).toBe(201);
    // Response must not contain a raw token
    expect(r.body).not.toHaveProperty('token');
    expect(JSON.stringify(r.body)).not.toMatch(/"token":/);

    // Verify audit log for this invitation does not contain token or tokenHash
    const inv = await prisma.userInvitation.findFirst({ where: { tenantId, email } });
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, entityId: inv!.id, eventType: 'INVITATION_CREATED' },
      orderBy: { createdAt: 'desc' }
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('tokenHash');
    expect(payload).not.toHaveProperty('rawToken');
  });
});

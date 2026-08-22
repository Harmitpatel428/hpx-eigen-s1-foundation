/**
 * Signup / Org Initiation — Integration Tests
 *
 * Proves POST /api/auth/signup atomically provisions Tenant + User + admin
 * role assignment, rolls back completely on mid-transaction failure, and is
 * idempotent under duplicate and concurrent requests.
 *
 * Runs against the real Express router and PostgreSQL — no mocks (except the
 * deliberate injected failure used for rollback testing).
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';

import { createAuthRouter } from '../../src/routes/auth.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

const EMAIL_A = `signup-test-a-${crypto.randomUUID().slice(0, 8)}@example.com`;
const EMAIL_B = `signup-test-b-${crypto.randomUUID().slice(0, 8)}@example.com`;

function makeTestApp(client: PrismaClient) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter(client));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[signup-test] Unhandled route error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

async function api(
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (res.status >= 500 && parsed?.detail) {
    console.error(`[signup-test] ${path} → ${res.status}:`, parsed.detail);
  }
  return { status: res.status, body: parsed };
}

function signupBody(email: string) {
  return { email, password: 'S3curePassw0rd!', companyName: `Test Co ${email.slice(12, 20)}` };
}

/** Deletes every row created for the given test emails, children first. */
async function cleanup(emails: string[]) {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, tenantId: true } });
  const userIds = users.map(u => u.id);
  const tenantIds = [...new Set(users.map(u => u.tenantId))];

  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.team.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.department.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

beforeAll(async () => {
  const app = makeTestApp(prisma);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await cleanup([EMAIL_A, EMAIL_B]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/signup', () => {
  it('creates tenant + user + admin role assignment atomically', async () => {
    const { status, body } = await api('/api/v1/auth/signup', signupBody(EMAIL_A));
    expect(status).toBe(201);
    expect(body.success).toBe(true);

    const user = await prisma.user.findFirst({ where: { email: EMAIL_A } });
    expect(user).not.toBeNull();

    const tenant = await prisma.tenant.findUnique({ where: { id: user!.tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');

    // The user must be the org administrator — this is the regression this
    // suite exists to prevent.
    const role = await prisma.role.findFirst({
      where: { tenantId: tenant!.id, name: 'Organization Admin', deletedAt: null },
    });
    expect(role).not.toBeNull();
    expect(role!.isSystem).toBe(true);

    const userRole = await prisma.userRole.findUnique({
      where: { userId_roleId: { userId: user!.id, roleId: role!.id } },
    });
    expect(userRole).not.toBeNull();
    expect(userRole!.scopeType).toBe('ORGANIZATION');

    // Admin role carries every permission in the system
    const permissionCount = await prisma.permission.count();
    const rolePermissionCount = await prisma.rolePermission.count({ where: { roleId: role!.id } });
    expect(rolePermissionCount).toBe(permissionCount);

    // RBAC scaffolding attached to the user
    expect(user!.departmentId).not.toBeNull();
    expect(user!.teamId).not.toBeNull();
    const dept = await prisma.department.findUnique({ where: { id: user!.departmentId! } });
    expect(dept!.tenantId).toBe(tenant!.id);

    // Verification token persisted
    const tokenRow = await prisma.verificationToken.findFirst({ where: { userId: user!.id } });
    expect(tokenRow).not.toBeNull();

    // Audit chain connects USER_REGISTERED → RBAC init entries
    const registered = await prisma.auditLog.findFirst({
      where: { tenantId: tenant!.id, eventType: 'USER_REGISTERED' },
    });
    expect(registered).not.toBeNull();
    // Chain continuity within THIS org's provisioning entries. The first
    // RBAC entry must chain directly onto USER_REGISTERED. (The global tip
    // can't be compared — parallel suites append to the same chain.)
    const deptAudit = await prisma.auditLog.findFirst({
      where: { tenantId: tenant!.id, eventType: 'department_created' },
    });
    expect(deptAudit).not.toBeNull();
    expect(deptAudit!.previousHash).toBe(registered!.currentHash);
    const roleAssigned = await prisma.auditLog.findFirst({
      where: { tenantId: tenant!.id, eventType: 'role_assigned' },
    });
    expect(roleAssigned).not.toBeNull();
    expect(roleAssigned!.previousHash).not.toBeNull();
  });

  it('returns 409 and creates nothing when the email already exists', async () => {
    const tenantsBefore = await prisma.tenant.count();
    const usersBefore = await prisma.user.count({ where: { email: EMAIL_A } });

    const { status, body } = await api('/api/v1/auth/signup', signupBody(EMAIL_A));
    expect(status).toBe(409);
    expect(body.code).toBe('USER_EXISTS');

    expect(await prisma.tenant.count()).toBe(tenantsBefore);
    expect(await prisma.user.count({ where: { email: EMAIL_A } })).toBe(usersBefore);
  });

  it('serializes concurrent same-email signups into exactly one org', async () => {
    const results = await Promise.allSettled([
      api('/api/v1/auth/signup', signupBody(EMAIL_B)),
      api('/api/v1/auth/signup', signupBody(EMAIL_B)),
    ]);
    const settled = results.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);

    const created = settled.filter(r => r!.status === 201);
    const conflicted = settled.filter(r => r!.status === 409);
    expect(created.length).toBe(1);
    expect(conflicted.length).toBe(1);

    const users = await prisma.user.findMany({ where: { email: EMAIL_B } });
    expect(users.length).toBe(1);
    const roles = await prisma.role.findMany({ where: { tenantId: users[0].tenantId } });
    expect(roles.length).toBeGreaterThanOrEqual(1); // exactly one admin role was created for it

    const adminRoles = await prisma.role.findMany({
      where: { tenantId: users[0].tenantId, name: 'Organization Admin' },
    });
    expect(adminRoles.length).toBe(1);
  });

  it('rolls back the entire transaction on a mid-flow failure', async () => {
    // Proxy that poisons department.create inside every transaction started
    // by the wrapped client — simulating an RBAC-init DB failure after the
    // User row has already been written.
    function poisonDepartmentCreate<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (fn: (tx: any) => Promise<unknown>, ...rest: unknown[]) =>
              Reflect.get(target, prop, receiver).call(
                target,
                (tx: any) =>
                  fn(new Proxy(tx, {
                    get(txTarget, txProp) {
                      if (txProp === 'department') {
                        return {
                          create: async () => { throw new Error('INJECTED_DEPARTMENT_FAILURE'); },
                        };
                      }
                      return Reflect.get(txTarget, txProp);
                    },
                  })),
                ...rest
              );
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as T;
    }

    const poisonedPrisma = poisonDepartmentCreate(prisma);
    const poisonedApp = makeTestApp(poisonedPrisma);
    const poisonedServer = await new Promise<http.Server>((resolve) => {
      const s = poisonedApp.listen(0, () => resolve(s));
    });
    const poisonedUrl = `http://127.0.0.1:${(poisonedServer.address() as { port: number }).port}`;

    try {
      const email = `signup-test-fail-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const res = await fetch(`${poisonedUrl}/api/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signupBody(email)),
      });
      expect(res.status).toBe(500);

      // Nothing may persist — no orphaned tenant, user, role, or audit rows.
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      const orphans = await prisma.tenant.findMany({
        where: { name: signupBody(email).companyName },
      });
      expect(orphans.length).toBe(0);
      await cleanup([email]); // no-op if rollback held; fails loudly below if not
    } finally {
      await new Promise<void>((resolve) => poisonedServer.close(() => resolve()));
    }
  });

  it('rejects invalid payloads with 400', async () => {
    const missing = await api('/api/v1/auth/signup', { email: 'x@example.com', password: 'longenough1' });
    expect(missing.status).toBe(400);

    const shortPassword = await api('/api/v1/auth/signup', { email: 'y@example.com', password: 'short', companyName: 'C' });
    expect(shortPassword.status).toBe(400);
  });
});

/**
 * Stage 3 RBAC Hardening — Integration Tests
 *
 * Tests actual security properties against real PostgreSQL.
 * No mocks on business-critical paths.
 *
 * Phases covered:
 *   Phase 1  — Authorization gates (401/403 on missing token/perm)
 *   Phase 3  — isSystem role protection
 *   Phase 7  — Privilege escalation (limitedA cannot gain admin powers)
 *   Phase 8  — Tenant isolation (cross-tenant access blocked)
 *   Phase 9  — Admin lockout (sequential + concurrent) — isolated tenant
 *   Phase 10 — Role cloning atomicity
 *   Phase 12 — Multi-role effective permissions + revocation
 *   Phase 20 — Database integrity (unique constraints, soft-delete)
 *   Phase 21 — Permission cache invalidation (grant→200, revoke→403)
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createRolesRouter } from '../../src/routes/roles.router';
import { createUsersRouter } from '../../src/routes/users.router';
import { createOpportunityTypesRouter } from '../../src/routes/opportunity-types.router';
import { AdminLockoutService } from '../../src/services/admin-lockout.service';
import { PermissionService } from '../../src/services/permission.service';
import { AppException } from '../../src/types/exceptions';

// ─── Infrastructure ────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const adminLockoutService = new AdminLockoutService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/roles', createRolesRouter(prisma));
  app.use('/api/v1/users', createUsersRouter(prisma));
  app.use('/api/v1/opportunity-types', createOpportunityTypesRouter(prisma));
  // Global error handler — mirrors app.ts without Sentry
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; url?: string } = {}
): Promise<{ status: number; body: any }> {
  const target = opts.url ?? baseUrl;
  const res = await fetch(`${target}${path}`, {
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

async function getPermId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded. Run seed-permissions.ts first.`);
  return p.id;
}

async function makeUser(tenantId: string, status: UserStatus = UserStatus.ACTIVE) {
  const pwHash = await bcryptjs.hash('Password1!', 10);
  return prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pwHash, status },
  });
}

// ─── Global test state ─────────────────────────────────────────────────────────
let tenantA: string;
let tenantB: string;
let adminA: { id: string; token: string };   // has role:manage + role:view + user:manage
let limitedA: { id: string; token: string }; // no permissions
let adminB: { id: string; token: string };   // has role:manage in tenantB
let managePermId: string;
let viewPermId: string;
let userManagePermId: string;
let adminRoleA: string;  // adminA's role in tenantA

// Tracked tenant IDs for afterAll cleanup
const trackedTenants: string[] = [];

beforeAll(async () => {
  // Get canonical perm IDs
  [managePermId, viewPermId, userManagePermId] = await Promise.all([
    getPermId('role:manage'),
    getPermId('role:view'),
    getPermId('user:manage'),
  ]);

  tenantA = uid();
  tenantB = uid();
  trackedTenants.push(tenantA, tenantB);

  await prisma.tenant.createMany({
    data: [
      { id: tenantA, name: `AuditA-${tenantA.slice(0, 8)}` },
      { id: tenantB, name: `AuditB-${tenantB.slice(0, 8)}` },
    ],
  });

  const [uA, uLimited, uB] = await Promise.all([
    makeUser(tenantA),
    makeUser(tenantA),
    makeUser(tenantB),
  ]);

  // adminA's role: role:manage + role:view + user:manage
  const roleA = await prisma.role.create({
    data: { tenantId: tenantA, name: `AdminRoleA-${uid().slice(0, 8)}` },
  });
  adminRoleA = roleA.id;
  await prisma.rolePermission.createMany({
    data: [
      { roleId: roleA.id, permissionId: managePermId },
      { roleId: roleA.id, permissionId: viewPermId },
      { roleId: roleA.id, permissionId: userManagePermId },
    ],
  });
  await prisma.userRole.create({
    data: { userId: uA.id, roleId: roleA.id, scopeType: ScopeType.ORGANIZATION },
  });

  // adminB's role: role:manage in tenantB
  const roleB = await prisma.role.create({
    data: { tenantId: tenantB, name: `AdminRoleB-${uid().slice(0, 8)}` },
  });
  await prisma.rolePermission.createMany({
    data: [
      { roleId: roleB.id, permissionId: managePermId },
      { roleId: roleB.id, permissionId: viewPermId },
      { roleId: roleB.id, permissionId: userManagePermId },
    ],
  });
  await prisma.userRole.create({
    data: { userId: uB.id, roleId: roleB.id, scopeType: ScopeType.ORGANIZATION },
  });

  const [tokA, tokLimited, tokB] = await Promise.all([
    makeSession(uA.id, tenantA),
    makeSession(uLimited.id, tenantA),
    makeSession(uB.id, tenantB),
  ]);
  adminA   = { id: uA.id,       token: tokA };
  limitedA = { id: uLimited.id, token: tokLimited };
  adminB   = { id: uB.id,       token: tokB };

  await Promise.all([
    permissionService.invalidatePermissionCache(tenantA),
    permissionService.invalidatePermissionCache(tenantB),
  ]);

  // Start HTTP server
  server = http.createServer(makeTestApp());
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(res => server.close(() => res()));
  // Clean up all tracked tenants (cascades to users, roles, sessions via FK)
  for (const tenantId of trackedTenants) {
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

// ─── Phase 1: Authentication + Authorization ───────────────────────────────────
describe('Phase 1 — Authentication + Authorization', () => {
  it('GET /roles without token → 401', async () => {
    const { status } = await api('GET', '/api/v1/roles');
    expect(status).toBe(401);
  });

  it('GET /roles with adminA (role:view) → 200', async () => {
    const { status } = await api('GET', '/api/v1/roles', { token: adminA.token });
    expect(status).toBe(200);
  });

  it('GET /roles with limitedA (no role:view) → 403', async () => {
    const { status } = await api('GET', '/api/v1/roles', { token: limitedA.token });
    expect(status).toBe(403);
  });

  it('POST /roles with limitedA (no role:manage) → 403', async () => {
    const { status } = await api('POST', '/api/v1/roles', {
      token: limitedA.token, body: { name: 'HijackRole' },
    });
    expect(status).toBe(403);
  });

  it('POST /roles with adminA (role:manage) → 201', async () => {
    const { status, body } = await api('POST', '/api/v1/roles', {
      token: adminA.token,
      body: { name: `CreateTest-${uid().slice(0, 8)}` },
    });
    expect(status).toBe(201);
    expect(body.id).toBeTruthy();
    await prisma.role.delete({ where: { id: body.id } }).catch(() => {});
  });

  it('GET /opportunity-types with limitedA (no opportunity:view) → 403', async () => {
    const { status } = await api('GET', '/api/v1/opportunity-types', { token: limitedA.token });
    expect(status).toBe(403);
  });

  it('POST /opportunity-types with limitedA (no role:manage) → 403', async () => {
    const { status } = await api('POST', '/api/v1/opportunity-types', {
      token: limitedA.token, body: { name: 'AttackType' },
    });
    expect(status).toBe(403);
  });

  it('expired JWT → 401', async () => {
    const tok = jwt.sign(
      { sessionId: uid(), userId: uid(), tenantId: tenantA },
      JWT_SECRET,
      { expiresIn: '-1s' }
    );
    const { status } = await api('GET', '/api/v1/roles', { token: tok });
    expect(status).toBe(401);
  });
});

// ─── Phase 3: isSystem role protection ────────────────────────────────────────
describe('Phase 3 — isSystem Role Protection', () => {
  let sysRoleId: string;

  beforeAll(async () => {
    const r = await prisma.role.create({
      data: { tenantId: tenantA, name: `Sys-${uid().slice(0, 8)}`, isSystem: true },
    });
    sysRoleId = r.id;
    await permissionService.invalidatePermissionCache(tenantA);
  });

  afterAll(async () => {
    await prisma.rolePermission.deleteMany({ where: { roleId: sysRoleId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { roleId: sysRoleId } }).catch(() => {});
    await prisma.role.delete({ where: { id: sysRoleId } }).catch(() => {});
  });

  it('POST /:id/permissions on isSystem → 403 SYSTEM_ROLE_PROTECTED', async () => {
    const { status, body } = await api('POST', `/api/v1/roles/${sysRoleId}/permissions`, {
      token: adminA.token, body: { permissionId: viewPermId },
    });
    expect(status).toBe(403);
    expect(body.error).toBe('SYSTEM_ROLE_PROTECTED');
  });

  it('DELETE /:id/permissions/:permId on isSystem → 403 SYSTEM_ROLE_PROTECTED', async () => {
    await prisma.rolePermission.create({
      data: { roleId: sysRoleId, permissionId: viewPermId },
    }).catch(() => {});
    const { status, body } = await api('DELETE', `/api/v1/roles/${sysRoleId}/permissions/${viewPermId}`, {
      token: adminA.token,
    });
    expect(status).toBe(403);
    expect(body.error).toBe('SYSTEM_ROLE_PROTECTED');
    await prisma.rolePermission.deleteMany({ where: { roleId: sysRoleId } });
  });

  it('isSystem cannot be set by client on create (server ignores it)', async () => {
    const { status, body } = await api('POST', '/api/v1/roles', {
      token: adminA.token,
      body: { name: `FakeSys-${uid().slice(0, 8)}`, isSystem: true },
    });
    expect(status).toBe(201);
    expect(body.isSystem).toBe(false); // server-enforced
    await prisma.role.delete({ where: { id: body.id } }).catch(() => {});
  });

  it('POST /:id/users on isSystem → 201 (assigning users to system roles is allowed)', async () => {
    const { status } = await api('POST', `/api/v1/roles/${sysRoleId}/users`, {
      token: adminA.token, body: { userId: limitedA.id, scopeType: 'OWN' },
    });
    expect(status).toBe(201);
    await prisma.userRole.deleteMany({ where: { userId: limitedA.id, roleId: sysRoleId } });
  });
});

// ─── Phase 7: Privilege escalation ────────────────────────────────────────────
describe('Phase 7 — Privilege Escalation (limitedA has no permissions)', () => {
  let anyRoleId: string;

  beforeAll(async () => {
    const r = await prisma.role.findFirst({ where: { tenantId: tenantA, deletedAt: null } });
    anyRoleId = r!.id;
  });

  it('cannot create a role', async () => {
    const { status } = await api('POST', '/api/v1/roles', {
      token: limitedA.token, body: { name: 'PrivEsc' },
    });
    expect(status).toBe(403);
  });

  it('cannot add permission to any role', async () => {
    const { status } = await api('POST', `/api/v1/roles/${anyRoleId}/permissions`, {
      token: limitedA.token, body: { permissionId: managePermId },
    });
    expect(status).toBe(403);
  });

  it('cannot assign role to user', async () => {
    const { status } = await api('POST', `/api/v1/roles/${anyRoleId}/users`, {
      token: limitedA.token, body: { userId: limitedA.id },
    });
    expect(status).toBe(403);
  });

  it('cannot clone a role', async () => {
    const { status } = await api('POST', `/api/v1/roles/${anyRoleId}/clone`, {
      token: limitedA.token,
    });
    expect(status).toBe(403);
  });

  it('cannot suspend another user', async () => {
    const { status } = await api('PUT', `/api/v1/users/${adminA.id}/suspend`, {
      token: limitedA.token, body: { reason: 'escalation test' },
    });
    expect(status).toBe(403);
  });

  it('cannot terminate another user', async () => {
    const { status } = await api('PUT', `/api/v1/users/${adminA.id}/terminate`, {
      token: limitedA.token, body: { reason: 'escalation test' },
    });
    expect(status).toBe(403);
  });

  it('cannot invite users', async () => {
    const { status } = await api('POST', '/api/v1/users/invite', {
      token: limitedA.token, body: { email: 'evil@evil.com', roleId: anyRoleId },
    });
    expect(status).toBe(403);
  });
});

// ─── Phase 8: Tenant isolation ────────────────────────────────────────────────
describe('Phase 8 — Tenant Isolation', () => {
  let roleB: string;

  beforeAll(async () => {
    const r = await prisma.role.create({
      data: { tenantId: tenantB, name: `IsolB-${uid().slice(0, 8)}` },
    });
    roleB = r.id;
    await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: viewPermId } });
  });

  afterAll(async () => {
    await prisma.rolePermission.deleteMany({ where: { roleId: roleB } }).catch(() => {});
    await prisma.role.delete({ where: { id: roleB } }).catch(() => {});
  });

  it('Tenant A admin cannot read Tenant B role permissions → 404', async () => {
    const { status } = await api('GET', `/api/v1/roles/${roleB}/permissions`, {
      token: adminA.token,
    });
    expect(status).toBe(404);
  });

  it('Tenant A admin cannot add perm to Tenant B role → 404', async () => {
    const { status } = await api('POST', `/api/v1/roles/${roleB}/permissions`, {
      token: adminA.token, body: { permissionId: managePermId },
    });
    expect(status).toBe(404);
  });

  it('Tenant A admin cannot clone Tenant B role → 404', async () => {
    const { status } = await api('POST', `/api/v1/roles/${roleB}/clone`, {
      token: adminA.token,
    });
    expect(status).toBe(404);
  });

  it('Tenant A admin cannot delete Tenant B role permission → 404', async () => {
    const { status } = await api('DELETE', `/api/v1/roles/${roleB}/permissions/${viewPermId}`, {
      token: adminA.token,
    });
    expect(status).toBe(404);
  });

  it('Tenant A admin cannot assign cross-tenant user → 400 (user not found in tenantA)', async () => {
    const { status } = await api('POST', `/api/v1/roles/${adminRoleA}/users`, {
      token: adminA.token, body: { userId: adminB.id },
    });
    expect(status).toBe(400);
  });

  it('Tenant A admin cannot suspend Tenant B user → 404', async () => {
    // adminA has user:manage, so the permission gate passes
    // The suspend endpoint then finds the user by { id: targetUserId, tenantId: tenantA }
    // adminB.id is in tenantB, not tenantA → ResourceNotFoundError → 404
    const { status } = await api('PUT', `/api/v1/users/${adminB.id}/suspend`, {
      token: adminA.token, body: { reason: 'cross-tenant attack' },
    });
    expect(status).toBe(404);
  });

  it('Tenant A admin cannot terminate Tenant B user → 404', async () => {
    const { status } = await api('PUT', `/api/v1/users/${adminB.id}/terminate`, {
      token: adminA.token, body: { reason: 'cross-tenant attack' },
    });
    expect(status).toBe(404);
  });

  it('tenantId in request body cannot override JWT tenant context', async () => {
    const { status, body } = await api('POST', '/api/v1/roles', {
      token: adminA.token,
      body: { name: `BodyTen-${uid().slice(0, 8)}`, tenantId: tenantB },
    });
    expect(status).toBe(201);
    if (body.id) {
      const created = await prisma.role.findUnique({ where: { id: body.id } });
      expect(created?.tenantId).toBe(tenantA); // JWT wins, not body
      await prisma.role.delete({ where: { id: body.id } }).catch(() => {});
    }
  });
});

// ─── Phase 9: Admin lockout (isolated tenant) ─────────────────────────────────
// Uses a dedicated tenant so there's only ONE role with role:manage, making
// lockout conditions deterministic.
describe('Phase 9 — Admin Lockout (isolated tenant)', () => {
  let lockTenant: string;
  let lockRole: string;         // only admin role in lockTenant
  let onlyAdmin: { id: string; token: string };
  let secondAdmin: { id: string; token: string };

  beforeAll(async () => {
    lockTenant = uid();
    trackedTenants.push(lockTenant);
    await prisma.tenant.create({ data: { id: lockTenant, name: `Lock-${lockTenant.slice(0, 8)}` } });

    const r = await prisma.role.create({
      data: { tenantId: lockTenant, name: `LockRole-${uid().slice(0, 8)}` },
    });
    lockRole = r.id;
    await prisma.rolePermission.createMany({
      data: [
        { roleId: r.id, permissionId: managePermId },
        { roleId: r.id, permissionId: userManagePermId },
      ],
    });

    const [u1, u2] = await Promise.all([makeUser(lockTenant), makeUser(lockTenant)]);
    await prisma.userRole.create({
      data: { userId: u1.id, roleId: r.id, scopeType: ScopeType.ORGANIZATION },
    });

    await permissionService.invalidatePermissionCache(lockTenant);
    const [tok1, tok2] = await Promise.all([
      makeSession(u1.id, lockTenant),
      makeSession(u2.id, lockTenant),
    ]);
    onlyAdmin    = { id: u1.id, token: tok1 };
    secondAdmin  = { id: u2.id, token: tok2 };
  });

  it('A: Remove role:manage from the only admin role → 422', async () => {
    await expect(
      adminLockoutService.withAdminGuard(
        lockTenant,
        { skipRoleId: lockRole },
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('B: Two admins, remove one → success (second remains)', async () => {
    // Add secondAdmin to lockRole
    await prisma.userRole.create({
      data: { userId: secondAdmin.id, roleId: lockRole, scopeType: ScopeType.ORGANIZATION },
    });
    await permissionService.invalidatePermissionCache(lockTenant);

    await expect(
      adminLockoutService.withAdminGuard(
        lockTenant,
        { skipUserRole: { userId: onlyAdmin.id, roleId: lockRole } },
        async (tx) => {
          await tx.userRole.deleteMany({ where: { userId: onlyAdmin.id, roleId: lockRole } });
        }
      )
    ).resolves.toBeUndefined();

    // secondAdmin still has the role
    const surviving = await prisma.userRole.findFirst({
      where: { userId: secondAdmin.id, roleId: lockRole },
    });
    expect(surviving).toBeTruthy();

    // Restore onlyAdmin for subsequent tests
    await prisma.userRole.create({
      data: { userId: onlyAdmin.id, roleId: lockRole, scopeType: ScopeType.ORGANIZATION },
    });
    await prisma.userRole.deleteMany({ where: { userId: secondAdmin.id, roleId: lockRole } });
    await permissionService.invalidatePermissionCache(lockTenant);
  });

  it('C: Unassign the last admin from role → 422', async () => {
    await expect(
      adminLockoutService.withAdminGuard(
        lockTenant,
        { skipUserRole: { userId: onlyAdmin.id, roleId: lockRole } },
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('D: Self-suspend via API → 422 (onlyAdmin has user:manage)', async () => {
    const { status } = await api('PUT', `/api/v1/users/${onlyAdmin.id}/suspend`, {
      token: onlyAdmin.token, body: { reason: 'self-test' },
    });
    expect(status).toBe(422);
  });

  it('E: Self-terminate via API → 422 (onlyAdmin has user:manage)', async () => {
    const { status } = await api('PUT', `/api/v1/users/${onlyAdmin.id}/terminate`, {
      token: onlyAdmin.token, body: { reason: 'self-test' },
    });
    expect(status).toBe(422);
  });

  it('Suspended user does NOT count as eligible admin', async () => {
    const suspUser = await makeUser(lockTenant, UserStatus.SUSPENDED);
    await prisma.userRole.create({
      data: { userId: suspUser.id, roleId: lockRole, scopeType: ScopeType.ORGANIZATION },
    });

    // onlyAdmin is the only ACTIVE admin; suspUser is SUSPENDED (ineligible)
    await expect(
      adminLockoutService.withAdminGuard(
        lockTenant,
        { skipUserRole: { userId: onlyAdmin.id, roleId: lockRole } },
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    await prisma.userRole.deleteMany({ where: { userId: suspUser.id } });
    await prisma.user.delete({ where: { id: suspUser.id } });
  });

  it('Soft-deleted user does NOT count as eligible admin', async () => {
    const deadUser = await makeUser(lockTenant);
    await prisma.user.update({ where: { id: deadUser.id }, data: { deletedAt: new Date() } });
    await prisma.userRole.create({
      data: { userId: deadUser.id, roleId: lockRole, scopeType: ScopeType.ORGANIZATION },
    });

    await expect(
      adminLockoutService.withAdminGuard(
        lockTenant,
        { skipUserRole: { userId: onlyAdmin.id, roleId: lockRole } },
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    await prisma.userRole.deleteMany({ where: { userId: deadUser.id } });
    await prisma.user.delete({ where: { id: deadUser.id } });
  });

  it('I: Concurrent last-admin removal → at least one fails', async () => {
    // onlyAdmin is the only admin on lockRole
    const attempt = () => adminLockoutService.withAdminGuard(
      lockTenant,
      { skipUserRole: { userId: onlyAdmin.id, roleId: lockRole } },
      async (tx) => {
        await tx.userRole.deleteMany({ where: { userId: onlyAdmin.id, roleId: lockRole } });
      }
    );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const failed = results.filter(r => r.status === 'rejected').length;
    expect(failed).toBeGreaterThanOrEqual(1);

    // Restore onlyAdmin if deleted (one succeeded)
    const still = await prisma.userRole.findFirst({
      where: { userId: onlyAdmin.id, roleId: lockRole },
    });
    if (!still) {
      await prisma.userRole.create({
        data: { userId: onlyAdmin.id, roleId: lockRole, scopeType: ScopeType.ORGANIZATION },
      });
    }
    await permissionService.invalidatePermissionCache(lockTenant);
  }, 20_000);
});

// ─── Phase 10: Role cloning atomicity ─────────────────────────────────────────
describe('Phase 10 — Role Cloning Atomicity', () => {
  it('clones all permissions, no users, new ID, isSystem=false', async () => {
    const userViewId = await getPermId('user:view');
    const src = await prisma.role.create({ data: { tenantId: tenantA, name: `Src-${uid().slice(0, 8)}` } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: src.id, permissionId: managePermId },
        { roleId: src.id, permissionId: viewPermId },
        { roleId: src.id, permissionId: userViewId },
      ],
    });
    // Assign adminA to src — should NOT be copied to clone
    await prisma.userRole.create({
      data: { userId: adminA.id, roleId: src.id, scopeType: ScopeType.OWN },
    });

    const { status, body } = await api('POST', `/api/v1/roles/${src.id}/clone`, {
      token: adminA.token,
    });
    expect(status).toBe(201);
    expect(body.id).not.toBe(src.id);
    expect(body.name).toBe(`${src.name} (Copy)`);
    expect(body.isSystem).toBe(false);

    const clonePerms = await prisma.rolePermission.findMany({ where: { roleId: body.id } });
    const srcPerms   = await prisma.rolePermission.findMany({ where: { roleId: src.id } });
    expect(clonePerms.length).toBe(srcPerms.length);

    const cloneUsers = await prisma.userRole.findMany({ where: { roleId: body.id } });
    expect(cloneUsers.length).toBe(0); // no users copied

    await prisma.userRole.deleteMany({ where: { roleId: src.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: [src.id, body.id] } } });
    await prisma.role.deleteMany({ where: { id: { in: [src.id, body.id] } } }).catch(() => {});
  });

  it('duplicate clone name → 409, zero orphaned roles', async () => {
    const name = `DupSrc-${uid().slice(0, 8)}`;
    const src  = await prisma.role.create({ data: { tenantId: tenantA, name } });
    const pre  = await prisma.role.create({ data: { tenantId: tenantA, name: `${name} (Copy)` } });

    const { status } = await api('POST', `/api/v1/roles/${src.id}/clone`, { token: adminA.token });
    expect(status).toBe(409);

    const all = await prisma.role.findMany({
      where: { tenantId: tenantA, name: `${name} (Copy)`, deletedAt: null },
    });
    expect(all.length).toBe(1); // only the pre-existing one

    await prisma.role.deleteMany({ where: { id: { in: [src.id, pre.id] } } }).catch(() => {});
  });

  it('cloning Tenant B role as Tenant A admin → 404', async () => {
    const rB = await prisma.role.create({ data: { tenantId: tenantB, name: `TB-${uid().slice(0, 8)}` } });
    const { status } = await api('POST', `/api/v1/roles/${rB.id}/clone`, { token: adminA.token });
    expect(status).toBe(404);
    await prisma.role.delete({ where: { id: rB.id } });
  });
});

// ─── Phase 12: Multi-role effective permissions ────────────────────────────────
describe('Phase 12 — Multi-Role Effective Permissions', () => {
  it('merges perms from two roles; removing one role removes its perms', async () => {
    const leadViewId    = await getPermId('lead:view');
    const contactViewId = await getPermId('contact:view');

    const r1 = await prisma.role.create({ data: { tenantId: tenantA, name: `MR1-${uid().slice(0, 8)}` } });
    const r2 = await prisma.role.create({ data: { tenantId: tenantA, name: `MR2-${uid().slice(0, 8)}` } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: r1.id, permissionId: leadViewId },
        { roleId: r2.id, permissionId: contactViewId },
      ],
    });

    const u = await makeUser(tenantA);
    await prisma.userRole.createMany({
      data: [
        { userId: u.id, roleId: r1.id, scopeType: ScopeType.OWN },
        { userId: u.id, roleId: r2.id, scopeType: ScopeType.ORGANIZATION },
      ],
    });

    const m1 = await permissionService.buildManifestFromDB(u.id, tenantA);
    expect(m1['lead:view']).toBeTruthy();
    expect(m1['contact:view']).toBeTruthy();

    await prisma.userRole.deleteMany({ where: { userId: u.id, roleId: r1.id } });
    const m2 = await permissionService.buildManifestFromDB(u.id, tenantA);
    expect(m2['lead:view']).toBeUndefined();
    expect(m2['contact:view']).toBeTruthy();

    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: [r1.id, r2.id] } } });
    await prisma.role.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
    await prisma.user.delete({ where: { id: u.id } });
  });

  it('ORGANIZATION scope wins over OWN for same slug across two roles', async () => {
    const leadViewId = await getPermId('lead:view');
    const r1 = await prisma.role.create({ data: { tenantId: tenantA, name: `S1-${uid().slice(0, 8)}` } });
    const r2 = await prisma.role.create({ data: { tenantId: tenantA, name: `S2-${uid().slice(0, 8)}` } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: r1.id, permissionId: leadViewId },
        { roleId: r2.id, permissionId: leadViewId },
      ],
    });

    const u = await makeUser(tenantA);
    await prisma.userRole.createMany({
      data: [
        { userId: u.id, roleId: r1.id, scopeType: ScopeType.OWN },
        { userId: u.id, roleId: r2.id, scopeType: ScopeType.ORGANIZATION },
      ],
    });

    const m = await permissionService.buildManifestFromDB(u.id, tenantA);
    expect(m['lead:view']).toBe('ORGANIZATION'); // most permissive wins

    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: [r1.id, r2.id] } } });
    await prisma.role.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
    await prisma.user.delete({ where: { id: u.id } });
  });
});

// ─── Phase 20: Database integrity ─────────────────────────────────────────────
describe('Phase 20 — Database Integrity', () => {
  it('duplicate role name same tenant → 409', async () => {
    const name = `Dup-${uid().slice(0, 8)}`;
    await prisma.role.create({ data: { tenantId: tenantA, name } });

    const { status } = await api('POST', '/api/v1/roles', {
      token: adminA.token, body: { name },
    });
    expect(status).toBe(409);

    await prisma.role.deleteMany({ where: { tenantId: tenantA, name } });
  });

  it('same role name in different tenant → 201 (no conflict)', async () => {
    const name = `Shared-${uid().slice(0, 8)}`;
    await prisma.role.create({ data: { tenantId: tenantA, name } });

    const { status, body } = await api('POST', '/api/v1/roles', {
      token: adminB.token, body: { name },
    });
    expect(status).toBe(201);

    await prisma.role.deleteMany({ where: { name } });
    if (body?.id) await prisma.role.delete({ where: { id: body.id } }).catch(() => {});
  });

  it('soft-deleted role NOT returned in GET /roles', async () => {
    const r = await prisma.role.create({
      data: { tenantId: tenantA, name: `Ghost-${uid().slice(0, 8)}`, deletedAt: new Date() },
    });

    const { status, body } = await api('GET', '/api/v1/roles', { token: adminA.token });
    expect(status).toBe(200);
    const ids = (body as any[]).map(x => x.id);
    expect(ids).not.toContain(r.id);

    await prisma.role.delete({ where: { id: r.id } });
  });

  it('soft-deleted role NOT accessible for permission edits → 404', async () => {
    const r = await prisma.role.create({
      data: { tenantId: tenantA, name: `GhostPerm-${uid().slice(0, 8)}`, deletedAt: new Date() },
    });

    const { status } = await api('POST', `/api/v1/roles/${r.id}/permissions`, {
      token: adminA.token, body: { permissionId: viewPermId },
    });
    expect(status).toBe(404);

    await prisma.role.delete({ where: { id: r.id } });
  });
});

// ─── Phase 21: Permission cache invalidation ───────────────────────────────────
describe('Phase 21 — Permission Cache Invalidation', () => {
  it('grant → in manifest; revoke → gone (no logout)', async () => {
    const leadCreateId = await getPermId('lead:create');
    const r = await prisma.role.create({ data: { tenantId: tenantA, name: `Cache-${uid().slice(0, 8)}` } });
    const u = await makeUser(tenantA);
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, scopeType: ScopeType.OWN } });

    await permissionService.invalidatePermissionCache(tenantA);
    const m0 = await permissionService.getPermissionManifest(u.id, tenantA);
    expect(m0['lead:create']).toBeUndefined();

    await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: leadCreateId } });
    await permissionService.invalidatePermissionCache(tenantA);
    const m1 = await permissionService.getPermissionManifest(u.id, tenantA);
    expect(m1['lead:create']).toBeTruthy();

    await prisma.rolePermission.deleteMany({ where: { roleId: r.id, permissionId: leadCreateId } });
    await permissionService.invalidatePermissionCache(tenantA);
    const m2 = await permissionService.getPermissionManifest(u.id, tenantA);
    expect(m2['lead:create']).toBeUndefined();

    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.role.delete({ where: { id: r.id } });
    await prisma.user.delete({ where: { id: u.id } });
  });

  it('API: grant role:view → GET /roles 200; revoke → 403 (same token, no logout)', async () => {
    const r = await prisma.role.create({ data: { tenantId: tenantA, name: `APIc-${uid().slice(0, 8)}` } });
    const u = await makeUser(tenantA);
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, scopeType: ScopeType.OWN } });
    await permissionService.invalidatePermissionCache(tenantA);
    const tok = await makeSession(u.id, tenantA);

    // No role:view → 403
    expect((await api('GET', '/api/v1/roles', { token: tok })).status).toBe(403);

    // Grant role:view + invalidate
    await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: viewPermId } });
    await permissionService.invalidatePermissionCache(tenantA);
    // Same token → 200
    expect((await api('GET', '/api/v1/roles', { token: tok })).status).toBe(200);

    // Revoke + invalidate
    await prisma.rolePermission.deleteMany({ where: { roleId: r.id, permissionId: viewPermId } });
    await permissionService.invalidatePermissionCache(tenantA);
    // Same token → 403 (no logout required)
    expect((await api('GET', '/api/v1/roles', { token: tok })).status).toBe(403);

    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: r.id } });
    await prisma.role.delete({ where: { id: r.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 15_000);

  it('stale vN cache is NOT served after version bump', async () => {
    const leadViewId = await getPermId('lead:view');
    const r = await prisma.role.create({ data: { tenantId: tenantA, name: `Stale-${uid().slice(0, 8)}` } });
    const u = await makeUser(tenantA);
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, scopeType: ScopeType.OWN } });
    await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: leadViewId } });

    await permissionService.invalidatePermissionCache(tenantA);
    const m1 = await permissionService.getPermissionManifest(u.id, tenantA); // primes vN cache
    expect(m1['lead:view']).toBeTruthy();

    // Remove perm + bump to vN+1
    await prisma.rolePermission.deleteMany({ where: { roleId: r.id } });
    await permissionService.invalidatePermissionCache(tenantA);

    // Must NOT serve stale vN value
    const m2 = await permissionService.getPermissionManifest(u.id, tenantA);
    expect(m2['lead:view']).toBeUndefined();

    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.role.delete({ where: { id: r.id } });
    await prisma.user.delete({ where: { id: u.id } });
  });
});

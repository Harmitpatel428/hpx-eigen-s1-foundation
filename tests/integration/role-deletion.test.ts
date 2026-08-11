/**
 * Role Deletion — Integration Tests
 *
 * Security-critical verification of DELETE /api/v1/roles/:id.
 * Runs against real PostgreSQL. No mocks on business paths.
 *
 * Covers:
 *   1.  Empty custom role deletion
 *   2.  Multi-user role deletion — users preserved
 *   3.  Multi-role user — other role untouched
 *   4.  User with only the deleted role — user preserved
 *   5.  System role rejection (409)
 *   6.  Unauthorized (no role:manage) → 403
 *   7.  Cross-tenant role ID → 404 (no data leak)
 *   8.  Nonexistent role → 404
 *   9.  Admin lockout prevention (422)
 *   10. Idempotent second DELETE → 404
 *   11. Audit log created
 *   12. Permission cache invalidation
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
import { PermissionService } from '../../src/services/permission.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/roles', createRolesRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

async function api(
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
  if (!p) throw new Error(`Permission '${slug}' not seeded.`);
  return p.id;
}

async function makeUser(tenantId: string, status: UserStatus = UserStatus.ACTIVE) {
  const pwHash = await bcryptjs.hash('Password1!', 10);
  return prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pwHash, status },
  });
}

// ─── Shared state ─────────────────────────────────────────────────────────────
let managePermId: string;
let viewPermId: string;

// Each test creates its own isolated tenant — pushed here for afterAll cleanup
const trackedTenants: string[] = [];

beforeAll(async () => {
  [managePermId, viewPermId] = await Promise.all([
    getPermId('role:manage'),
    getPermId('role:view'),
  ]);
  server = http.createServer(makeTestApp());
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(res => server.close(() => res()));
  for (const tenantId of trackedTenants) {
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create an isolated tenant with one admin user (role:manage + role:view). */
async function makeIsolatedTenant() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `test-${tenantId.slice(0, 8)}` } });

  const admin = await makeUser(tenantId);
  const adminRole = await prisma.role.create({
    data: { tenantId, name: `Admin-${uid().slice(0, 6)}` },
  });
  await prisma.rolePermission.createMany({
    data: [
      { roleId: adminRole.id, permissionId: managePermId },
      { roleId: adminRole.id, permissionId: viewPermId },
    ],
  });
  await prisma.userRole.create({
    data: { userId: admin.id, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION },
  });
  const token = await makeSession(admin.id, tenantId);
  await permissionService.invalidatePermissionCache(tenantId);
  return { tenantId, adminId: admin.id, adminRoleId: adminRole.id, token };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/roles/:id — Role Deletion', () => {
  jest.setTimeout(30_000);

  it('T1 — empty custom role: deletes cleanly, no orphans', async () => {
    const { tenantId, token } = await makeIsolatedTenant();

    // Create custom role with 2 permissions, 0 users
    const role = await prisma.role.create({ data: { tenantId, name: `Empty-${uid().slice(0,6)}` } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: managePermId },
        { roleId: role.id, permissionId: viewPermId },
      ],
    });

    const r = await api('DELETE', `/api/v1/roles/${role.id}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    // Role gone
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
    // No orphaned RolePermission
    expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
    // No orphaned UserRole
    expect(await prisma.userRole.count({ where: { roleId: role.id } })).toBe(0);
  });

  it('T2 — multi-user role: all users preserved, only role & assignments removed', async () => {
    const { tenantId, token } = await makeIsolatedTenant();

    const role = await prisma.role.create({ data: { tenantId, name: `Sales-${uid().slice(0,6)}` } });

    const users = await Promise.all([makeUser(tenantId), makeUser(tenantId), makeUser(tenantId)]);
    await prisma.userRole.createMany({
      data: users.map(u => ({ userId: u.id, roleId: role.id, scopeType: ScopeType.OWN })),
    });

    const r = await api('DELETE', `/api/v1/roles/${role.id}`, { token });
    expect(r.status).toBe(200);

    // Role gone
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
    // UserRole assignments gone
    expect(await prisma.userRole.count({ where: { roleId: role.id } })).toBe(0);
    // All 3 users still exist
    for (const u of users) {
      expect(await prisma.user.findUnique({ where: { id: u.id } })).not.toBeNull();
    }
  });

  it('T3 — multi-role user: other role preserved after target role deleted', async () => {
    const { tenantId, token } = await makeIsolatedTenant();

    const roleA = await prisma.role.create({ data: { tenantId, name: `RoleA-${uid().slice(0,6)}` } });
    const roleB = await prisma.role.create({ data: { tenantId, name: `RoleB-${uid().slice(0,6)}` } });
    await prisma.rolePermission.create({ data: { roleId: roleB.id, permissionId: viewPermId } });

    const user = await makeUser(tenantId);
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: roleA.id, scopeType: ScopeType.OWN },
        { userId: user.id, roleId: roleB.id, scopeType: ScopeType.OWN },
      ],
    });

    const r = await api('DELETE', `/api/v1/roles/${roleA.id}`, { token });
    expect(r.status).toBe(200);

    // RoleA gone
    expect(await prisma.role.findUnique({ where: { id: roleA.id } })).toBeNull();
    // User's RoleA assignment gone
    expect(await prisma.userRole.findFirst({ where: { userId: user.id, roleId: roleA.id } })).toBeNull();
    // User's RoleB assignment untouched
    expect(await prisma.userRole.findFirst({ where: { userId: user.id, roleId: roleB.id } })).not.toBeNull();
    // RoleB itself untouched
    expect(await prisma.role.findUnique({ where: { id: roleB.id } })).not.toBeNull();
    // RoleB's permissions untouched
    expect(await prisma.rolePermission.count({ where: { roleId: roleB.id } })).toBe(1);
  });

  it('T4 — role-less user after deletion: user still exists', async () => {
    const { tenantId, token } = await makeIsolatedTenant();

    const role = await prisma.role.create({ data: { tenantId, name: `Solo-${uid().slice(0,6)}` } });
    const user = await makeUser(tenantId);
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.OWN } });

    const r = await api('DELETE', `/api/v1/roles/${role.id}`, { token });
    expect(r.status).toBe(200);

    // User still exists and is active
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u).not.toBeNull();
    expect(u!.status).toBe(UserStatus.ACTIVE);
    expect(u!.deletedAt).toBeNull();
  });

  it('T5 — system role rejection: 409 SYSTEM_ROLE_NOT_DELETABLE', async () => {
    const { tenantId, token } = await makeIsolatedTenant();

    const sysRole = await prisma.role.create({
      data: { tenantId, name: `SysRole-${uid().slice(0,6)}`, isSystem: true },
    });

    const r = await api('DELETE', `/api/v1/roles/${sysRole.id}`, { token });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SYSTEM_ROLE_NOT_DELETABLE');

    // Role still exists
    expect(await prisma.role.findUnique({ where: { id: sysRole.id } })).not.toBeNull();
  });

  it('T6 — unauthorized: 403 when caller lacks role:manage', async () => {
    const { tenantId } = await makeIsolatedTenant();

    const limitedUser = await makeUser(tenantId);
    const limitedToken = await makeSession(limitedUser.id, tenantId);
    await permissionService.invalidatePermissionCache(tenantId);

    const role = await prisma.role.create({ data: { tenantId, name: `Target-${uid().slice(0,6)}` } });

    const r = await api('DELETE', `/api/v1/roles/${role.id}`, { token: limitedToken });
    expect(r.status).toBe(403);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
  });

  it('T7 — cross-tenant: 404 when admin uses another tenant\'s role ID', async () => {
    const tenantA = await makeIsolatedTenant();
    const tenantB = await makeIsolatedTenant();

    // Role belongs to tenantB
    const roleBId = tenantB.adminRoleId;

    // tenantA admin tries to delete it
    const r = await api('DELETE', `/api/v1/roles/${roleBId}`, { token: tenantA.token });
    expect(r.status).toBe(404);

    // tenantB's role is unchanged
    expect(await prisma.role.findUnique({ where: { id: roleBId } })).not.toBeNull();
  });

  it('T8 — nonexistent role: 404', async () => {
    const { token } = await makeIsolatedTenant();
    const r = await api('DELETE', `/api/v1/roles/${uid()}`, { token });
    expect(r.status).toBe(404);
  });

  it('T9 — admin lockout prevention: 422 when deletion would remove last role:manage', async () => {
    const { tenantId, token, adminRoleId } = await makeIsolatedTenant();

    // adminRoleId is the ONLY role:manage source in this tenant
    const r = await api('DELETE', `/api/v1/roles/${adminRoleId}`, { token });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('BUSINESS_RULE_VIOLATION');

    // Role, UserRole, RolePermission all untouched
    expect(await prisma.role.findUnique({ where: { id: adminRoleId } })).not.toBeNull();
    expect(await prisma.userRole.count({ where: { roleId: adminRoleId } })).toBe(1);
    expect(await prisma.rolePermission.count({ where: { roleId: adminRoleId } })).toBe(2);

    // Now create a second admin role assigned to the same user — lockout no longer applies
    const admin = await prisma.userRole.findFirst({ where: { roleId: adminRoleId } });
    const secondRole = await prisma.role.create({ data: { tenantId, name: `Admin2-${uid().slice(0,6)}` } });
    await prisma.rolePermission.create({ data: { roleId: secondRole.id, permissionId: managePermId } });
    await prisma.userRole.create({ data: { userId: admin!.userId, roleId: secondRole.id, scopeType: ScopeType.ORGANIZATION } });
    await permissionService.invalidatePermissionCache(tenantId);

    // Now deletion should succeed
    const r2 = await api('DELETE', `/api/v1/roles/${adminRoleId}`, { token });
    expect(r2.status).toBe(200);
    expect(await prisma.role.findUnique({ where: { id: adminRoleId } })).toBeNull();
  });

  it('T10 — idempotent: second DELETE returns 404 cleanly', async () => {
    const { tenantId, token } = await makeIsolatedTenant();
    const role = await prisma.role.create({ data: { tenantId, name: `Idempotent-${uid().slice(0,6)}` } });

    const r1 = await api('DELETE', `/api/v1/roles/${role.id}`, { token });
    expect(r1.status).toBe(200);

    const r2 = await api('DELETE', `/api/v1/roles/${role.id}`, { token });
    expect(r2.status).toBe(404);
    expect(r2.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('T11 — audit log created with correct payload', async () => {
    const { tenantId, token } = await makeIsolatedTenant();

    const role = await prisma.role.create({ data: { tenantId, name: `Audit-${uid().slice(0,6)}` } });
    const users = await Promise.all([makeUser(tenantId), makeUser(tenantId)]);
    await prisma.userRole.createMany({
      data: users.map(u => ({ userId: u.id, roleId: role.id, scopeType: ScopeType.OWN })),
    });

    await api('DELETE', `/api/v1/roles/${role.id}`, { token });

    // Allow audit (best-effort async) a moment to settle
    await new Promise(r => setTimeout(r, 200));

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, eventType: 'RoleDeleted', entityId: role.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.operation).toBe('DELETE');
    expect(audit!.entityType).toBe('Role');
    const payload = audit!.payload as { roleName: string; affectedUserCount: number };
    expect(payload.roleName).toBe(role.name);
    expect(payload.affectedUserCount).toBe(2);
  });

  it('T12 — permission cache invalidated: deleted role\'s permissions no longer effective', async () => {
    const { tenantId } = await makeIsolatedTenant();

    // Create a second user whose ONLY role grants role:view
    const viewer = await makeUser(tenantId);
    const viewerRole = await prisma.role.create({ data: { tenantId, name: `Viewer-${uid().slice(0,6)}` } });
    await prisma.rolePermission.create({ data: { roleId: viewerRole.id, permissionId: viewPermId } });
    await prisma.userRole.create({ data: { userId: viewer.id, roleId: viewerRole.id, scopeType: ScopeType.OWN } });
    const viewerToken = await makeSession(viewer.id, tenantId);
    await permissionService.invalidatePermissionCache(tenantId);

    // Viewer can GET /roles before deletion
    const before = await api('GET', '/api/v1/roles', { token: viewerToken });
    expect(before.status).toBe(200);

    // Admin (from a separate admin context in same tenant) deletes the viewer's role
    const adminUser = await prisma.userRole.findFirst({
      where: { role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    // Find the admin token for this tenant
    const adminSession = await prisma.session.findFirst({ where: { tenantId, status: 'ACTIVE' } });
    const adminToken = jwt.sign(
      { sessionId: adminSession!.id, userId: adminSession!.userId, tenantId },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const deleteR = await api('DELETE', `/api/v1/roles/${viewerRole.id}`, { token: adminToken });
    expect(deleteR.status).toBe(200);

    // Viewer's role is gone — cache should be invalidated — next request should 403
    const after = await api('GET', '/api/v1/roles', { token: viewerToken });
    expect(after.status).toBe(403);
  });

});

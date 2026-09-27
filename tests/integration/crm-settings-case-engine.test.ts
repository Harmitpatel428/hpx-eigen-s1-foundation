/**
 * CRM Settings — Case Operations Engine Toggle — Integration Tests (Phase 1, Task A)
 *
 * Covers authorization (case-engine:manage gate), validation, the tenant
 * create-on-first-toggle path, audit trail, and tenant isolation.
 * Runs against real PostgreSQL — no mocks on business-critical paths.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, ScopeType, UserStatus } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createCrmSettingsRouter } from '../../src/routes/crm-settings.router';
import { PermissionService } from '../../src/services/permission.service';
import { AppException } from '../../src/types/exceptions';
import { CASE_ENGINE_MANAGE_SLUG, ENGINE_PERMISSION_SLUGS } from './_shared/engine-permission-slugs';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/settings/crm', createCrmSettingsRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
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

async function makeUser(tenantId: string) {
  const pwHash = await bcryptjs.hash('Password1!', 10);
  return prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
  });
}

async function getPermId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded. Run seed-permissions.ts first.`);
  return p.id;
}

// ── Test state ──────────────────────────────────────────────────────────────────
let tenantA: string;
let tenantB: string;
let tenantC: string;
let adminA: { id: string; token: string };   // has case-engine:manage in tenantA
let limitedA: { id: string; token: string }; // no permissions in tenantA
let adminB: { id: string; token: string };   // tenantB — never POSTs; used for isolation check
let adminC: { id: string; token: string };   // has case-engine:manage in tenantC — no TenantSettings row
const trackedTenants: string[] = [];

beforeAll(async () => {
  // Sanity: the shared slug list includes the one this test actually exercises
  // (per the reconciliation-file's own rule that both suites import it).
  expect(ENGINE_PERMISSION_SLUGS).toContain(CASE_ENGINE_MANAGE_SLUG);

  const engineManagePermId = await getPermId(CASE_ENGINE_MANAGE_SLUG);

  tenantA = uid();
  tenantB = uid();
  tenantC = uid();
  trackedTenants.push(tenantA, tenantB, tenantC);

  await prisma.tenant.createMany({
    data: [
      { id: tenantA, name: `EngineA-${tenantA.slice(0, 8)}` },
      { id: tenantB, name: `EngineB-${tenantB.slice(0, 8)}` },
      { id: tenantC, name: `EngineC-${tenantC.slice(0, 8)}` },
    ],
  });

  const [uA, uLimited, uB, uC] = await Promise.all([
    makeUser(tenantA), makeUser(tenantA), makeUser(tenantB), makeUser(tenantC),
  ]);

  // adminA: has case-engine:manage in tenantA
  const roleA = await prisma.role.create({ data: { tenantId: tenantA, name: `EngineAdminA-${uid().slice(0, 8)}` } });
  await prisma.rolePermission.create({ data: { roleId: roleA.id, permissionId: engineManagePermId } });
  await prisma.userRole.create({ data: { userId: uA.id, roleId: roleA.id, scopeType: ScopeType.ORGANIZATION } });

  // adminB: tenantB — deliberately NOT granted case-engine:manage; only used to read GET
  const roleB = await prisma.role.create({ data: { tenantId: tenantB, name: `EngineAdminB-${uid().slice(0, 8)}` } });
  await prisma.userRole.create({ data: { userId: uB.id, roleId: roleB.id, scopeType: ScopeType.ORGANIZATION } });

  // adminC: has case-engine:manage in tenantC — used for the no-row toggle test
  const roleC = await prisma.role.create({ data: { tenantId: tenantC, name: `EngineAdminC-${uid().slice(0, 8)}` } });
  await prisma.rolePermission.create({ data: { roleId: roleC.id, permissionId: engineManagePermId } });
  await prisma.userRole.create({ data: { userId: uC.id, roleId: roleC.id, scopeType: ScopeType.ORGANIZATION } });

  await Promise.all([
    permissionService.invalidatePermissionCache(tenantA),
    permissionService.invalidatePermissionCache(tenantB),
    permissionService.invalidatePermissionCache(tenantC),
  ]);

  const [tokA, tokLimited, tokB, tokC] = await Promise.all([
    makeSession(uA.id, tenantA),
    makeSession(uLimited.id, tenantA),
    makeSession(uB.id, tenantB),
    makeSession(uC.id, tenantC),
  ]);
  adminA   = { id: uA.id,       token: tokA };
  limitedA = { id: uLimited.id, token: tokLimited };
  adminB   = { id: uB.id,       token: tokB };
  adminC   = { id: uC.id,       token: tokC };

  server = http.createServer(makeTestApp());
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const tenantId of trackedTenants) {
    await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenantSettings.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

// ── Auth / 401 ─────────────────────────────────────────────────────────────────
describe('Authentication', () => {
  it('GET / without token → 401', async () => {
    const { status } = await req('GET', '/api/v1/settings/crm');
    expect(status).toBe(401);
  });

  it('POST /case-operations-engine without token → 401', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/case-operations-engine', { body: { enabled: true } });
    expect(status).toBe(401);
  });
});

// ── GET data contract ─────────────────────────────────────────────────────────
describe('GET /settings/crm — data contract', () => {
  it('no TenantSettings row exists yet for tenantA → caseOperationsEngineEnabled is false', async () => {
    const { status, body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(status).toBe(200);
    expect(body.caseOperationsEngineEnabled).toBe(false);
  });
});

// ── Authorization + validation + behavior ──────────────────────────────────────
describe('POST /case-operations-engine', () => {
  it('authed WITHOUT case-engine:manage → 403', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/case-operations-engine', {
      token: limitedA.token,
      body: { enabled: true },
    });
    expect(status).toBe(403);
  });

  it('non-boolean enabled → 400', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/case-operations-engine', {
      token: adminA.token,
      body: { enabled: 'yes' },
    });
    expect(status).toBe(400);
  });

  it('missing enabled → 400', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/case-operations-engine', {
      token: adminA.token,
      body: {},
    });
    expect(status).toBe(400);
  });

  it('authed WITH case-engine:manage, {enabled:true} → 200', async () => {
    const { status, body } = await req('POST', '/api/v1/settings/crm/case-operations-engine', {
      token: adminA.token,
      body: { enabled: true },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, caseOperationsEngineEnabled: true });
  });

  it('DB reflects the toggle', async () => {
    const row = await prisma.tenantSettings.findUnique({ where: { tenantId: tenantA } });
    expect(row?.caseOperationsEngineEnabled).toBe(true);
  });

  it('writes an audit log row for the toggle', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: tenantA, eventType: 'TENANT_ENGINE_FLAG_UPDATED' },
    });
    expect(entry).toBeTruthy();
    expect(entry?.entityType).toBe('TenantSettings');
    expect(entry?.entityId).toBe(tenantA);
  });
});

// ── No-row toggle: POST creates the TenantSettings row when none exists ───────
describe('POST /case-operations-engine — no-row toggle', () => {
  it('creates a TenantSettings row with the flag set when none existed', async () => {
    const before = await prisma.tenantSettings.findUnique({ where: { tenantId: tenantC } });
    expect(before).toBeNull();

    const { status, body } = await req('POST', '/api/v1/settings/crm/case-operations-engine', {
      token: adminC.token,
      body: { enabled: true },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, caseOperationsEngineEnabled: true });

    const after = await prisma.tenantSettings.findUnique({ where: { tenantId: tenantC } });
    expect(after).toBeTruthy();
    expect(after?.caseOperationsEngineEnabled).toBe(true);
  });
});

// ── Tenant isolation ────────────────────────────────────────────────────────────
describe('Tenant isolation', () => {
  it('tenantA is true; tenantB is unaffected (false / no row)', async () => {
    const { body: bA } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(bA.caseOperationsEngineEnabled).toBe(true);

    const { body: bB } = await req('GET', '/api/v1/settings/crm', { token: adminB.token });
    expect(bB.caseOperationsEngineEnabled).toBe(false);

    const rowB = await prisma.tenantSettings.findUnique({ where: { tenantId: tenantB } });
    expect(rowB?.caseOperationsEngineEnabled ?? false).toBe(false);
  });
});

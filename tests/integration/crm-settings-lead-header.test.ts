/**
 * CRM Settings — Lead Header Preference Integration Tests
 *
 * Covers authorization, validation, tenant isolation, and data contract.
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

async function makeUser(tenantId: string) {
  const pwHash = await bcryptjs.hash('Password1!', 10);
  return prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
  });
}

// ── Test state ──────────────────────────────────────────────────────────────────
let tenantA: string;
let tenantB: string;
let adminA: { id: string; token: string };
let limitedA: { id: string; token: string };
let adminB: { id: string; token: string };
const trackedTenants: string[] = [];

beforeAll(async () => {
  const managePermId = await prisma.permission
    .findFirst({ where: { slug: 'role:manage' } })
    .then(p => { if (!p) throw new Error("'role:manage' not seeded"); return p.id; });

  tenantA = uid();
  tenantB = uid();
  trackedTenants.push(tenantA, tenantB);

  await prisma.tenant.createMany({
    data: [
      { id: tenantA, name: `CrmTestA-${tenantA.slice(0, 8)}` },
      { id: tenantB, name: `CrmTestB-${tenantB.slice(0, 8)}` },
    ],
  });

  const [uA, uLimited, uB] = await Promise.all([
    makeUser(tenantA), makeUser(tenantA), makeUser(tenantB),
  ]);

  // adminA: has role:manage in tenantA
  const roleA = await prisma.role.create({ data: { tenantId: tenantA, name: `AdminA-${uid().slice(0, 8)}` } });
  await prisma.rolePermission.create({ data: { roleId: roleA.id, permissionId: managePermId } });
  await prisma.userRole.create({ data: { userId: uA.id, roleId: roleA.id, scopeType: ScopeType.ORGANIZATION } });

  // adminB: has role:manage in tenantB
  const roleB = await prisma.role.create({ data: { tenantId: tenantB, name: `AdminB-${uid().slice(0, 8)}` } });
  await prisma.rolePermission.create({ data: { roleId: roleB.id, permissionId: managePermId } });
  await prisma.userRole.create({ data: { userId: uB.id, roleId: roleB.id, scopeType: ScopeType.ORGANIZATION } });

  await Promise.all([
    permissionService.invalidatePermissionCache(tenantA),
    permissionService.invalidatePermissionCache(tenantB),
  ]);

  const [tokA, tokLimited, tokB] = await Promise.all([
    makeSession(uA.id, tenantA),
    makeSession(uLimited.id, tenantA),
    makeSession(uB.id, tenantB),
  ]);
  adminA   = { id: uA.id,       token: tokA };
  limitedA = { id: uLimited.id, token: tokLimited };
  adminB   = { id: uB.id,       token: tokB };

  server = http.createServer(makeTestApp());
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
    await prisma.tenantSettings.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

// ── Auth / 401 ─────────────────────────────────────────────────────────────────
describe('Authentication', () => {
  it('GET without token → 401', async () => {
    const { status } = await req('GET', '/api/v1/settings/crm');
    expect(status).toBe(401);
  });
  it('POST /lead-header without token → 401', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/lead-header', { body: { preference: 'name' } });
    expect(status).toBe(401);
  });
});

// ── GET data contract ─────────────────────────────────────────────────────────
describe('GET /settings/crm — data contract', () => {
  it('returns "name" when no TenantSettings row exists (no null leak)', async () => {
    // tenantA has no TenantSettings row yet at this point
    const { status, body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(status).toBe(200);
    expect(body.leadHeaderPreference).toBe('name');
  });

  it('returns correct value after row is created', async () => {
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'company' } });
    const { body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(body.leadHeaderPreference).toBe('company');
  });

  it('GET includes allowImpersonation', async () => {
    const { body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(typeof body.allowImpersonation).toBe('boolean');
  });
});

// ── Authorization ─────────────────────────────────────────────────────────────
describe('POST /lead-header — authorization', () => {
  it('limitedA (no role:manage) → 403', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/lead-header', {
      token: limitedA.token,
      body: { preference: 'name' },
    });
    expect(status).toBe(403);
  });

  it('adminA (role:manage) can set "name" → 200', async () => {
    const { status, body } = await req('POST', '/api/v1/settings/crm/lead-header', {
      token: adminA.token,
      body: { preference: 'name' },
    });
    expect(status).toBe(200);
    expect(body.leadHeaderPreference).toBe('name');
  });

  it('adminA can set "company" → 200', async () => {
    const { status, body } = await req('POST', '/api/v1/settings/crm/lead-header', {
      token: adminA.token,
      body: { preference: 'company' },
    });
    expect(status).toBe(200);
    expect(body.leadHeaderPreference).toBe('company');
  });

  it('adminA can change repeatedly (name → company → name)', async () => {
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'name' } });
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'company' } });
    const final = await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'name' } });
    expect(final.status).toBe(200);
    expect(final.body.leadHeaderPreference).toBe('name');
    const { body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(body.leadHeaderPreference).toBe('name');
  });
});

// ── Validation / adversarial ──────────────────────────────────────────────────
describe('POST /lead-header — validation (adversarial)', () => {
  const bad = [
    ['phone', { preference: 'phone' }],
    ['PHONE (case)', { preference: 'PHONE' }],
    ['null preference', { preference: null }],
    ['empty string', { preference: '' }],
    ['random string', { preference: 'anything_goes' }],
    ['missing preference key', {}],
    ['number', { preference: 42 }],
  ] as const;

  for (const [name, body] of bad) {
    it(`"${name}" → 400`, async () => {
      const { status } = await req('POST', '/api/v1/settings/crm/lead-header', {
        token: adminA.token,
        body,
      });
      expect(status).toBe(400);
    });
  }
});

// ── Tenant isolation ──────────────────────────────────────────────────────────
//
// Architecture note: there is no client-supplied tenantId field on any endpoint.
// tenantId is derived exclusively from the authenticated JWT (sessionId → tenantId)
// and cross-checked against the session row. A Tenant A principal cannot directly
// address Tenant B — it would require forging a JWT signed with the server secret.
// The tests below cover: (a) GET scoping, (b) write scoping, and (c) the closest
// exploitable attack surface: supplying tenantId in the POST body.
//
describe('Tenant isolation', () => {
  it('GET is scoped to the authenticated tenant — adminA cannot observe tenantB', async () => {
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminB.token, body: { preference: 'company' } });
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'name' } });
    const { body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(body.leadHeaderPreference).toBe('name'); // tenantA's value, not tenantB's 'company'
  });

  it('POST is scoped to the authenticated tenant — adminA mutation does not affect tenantB', async () => {
    // Set known baseline for both tenants
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminB.token, body: { preference: 'company' } });
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'name' } });
    // adminA changes their own setting to 'company'
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'company' } });
    // tenantB was set to 'company' above and must remain 'company' — unaffected by tenantA's mutation
    const { body: bB } = await req('GET', '/api/v1/settings/crm', { token: adminB.token });
    expect(bB.leadHeaderPreference).toBe('company');
    // tenantA must reflect the change adminA just made
    const { body: bA } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(bA.leadHeaderPreference).toBe('company');
  });

  it('server ignores tenantId supplied in POST body — mutation still applies to authenticated tenant only', async () => {
    // Set known baselines
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminB.token, body: { preference: 'name' } });
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'name' } });
    // adminA sends tenantB's id in the body — closest real attack surface since body is the only
    // client-controlled input; the server must ignore it and write to tenantA only.
    const { status } = await req('POST', '/api/v1/settings/crm/lead-header', {
      token: adminA.token,
      body: { preference: 'company', tenantId: tenantB },
    });
    expect(status).toBe(200);
    // tenantA reflected the change
    const { body: bA } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(bA.leadHeaderPreference).toBe('company');
    // tenantB is untouched — still 'name'
    const { body: bB } = await req('GET', '/api/v1/settings/crm', { token: adminB.token });
    expect(bB.leadHeaderPreference).toBe('name');
  });
});

// ── Regression: GET after repeated mutations stays consistent ─────────────────
describe('State consistency', () => {
  it('GET always reflects latest persisted value', async () => {
    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'company' } });
    const { body: b1 } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(b1.leadHeaderPreference).toBe('company');

    await req('POST', '/api/v1/settings/crm/lead-header', { token: adminA.token, body: { preference: 'name' } });
    const { body: b2 } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(b2.leadHeaderPreference).toBe('name');
  });
});

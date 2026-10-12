/**
 * CRM Settings — Pending-Reminder Template Integration Tests
 *
 * Covers the GET data contract, role:manage authorization, template validation
 * (including case-insensitive {{PENDING_DOCUMENTS}}), persistence round-trip, and
 * the DB-level CHECK length constraint. Runs against real PostgreSQL.
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

const VALID_TEMPLATE = 'Please send {{pending_documents}}\n\n*{{organization_name}}*';

let tenantA: string;
let adminA: { id: string; token: string };
let limitedA: { id: string; token: string };
const trackedTenants: string[] = [];

beforeAll(async () => {
  const managePermId = await prisma.permission
    .findFirst({ where: { slug: 'role:manage' } })
    .then(p => { if (!p) throw new Error("'role:manage' not seeded"); return p.id; });

  tenantA = uid();
  trackedTenants.push(tenantA);

  await prisma.tenant.create({ data: { id: tenantA, name: `RemTestA-${tenantA.slice(0, 8)}` } });

  const [uA, uLimited] = await Promise.all([makeUser(tenantA), makeUser(tenantA)]);

  const roleA = await prisma.role.create({ data: { tenantId: tenantA, name: `AdminA-${uid().slice(0, 8)}` } });
  await prisma.rolePermission.create({ data: { roleId: roleA.id, permissionId: managePermId } });
  await prisma.userRole.create({ data: { userId: uA.id, roleId: roleA.id, scopeType: ScopeType.ORGANIZATION } });

  await permissionService.invalidatePermissionCache(tenantA);

  const [tokA, tokLimited] = await Promise.all([
    makeSession(uA.id, tenantA),
    makeSession(uLimited.id, tenantA),
  ]);
  adminA   = { id: uA.id,       token: tokA };
  limitedA = { id: uLimited.id, token: tokLimited };

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

describe('GET /settings/crm — reminder fields', () => {
  it('returns null template + null org name when no row exists', async () => {
    const { status, body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(status).toBe(200);
    expect(body.pendingReminderTemplate).toBeNull();
    expect(body.pendingReminderOrgName).toBeNull();
  });
});

describe('POST /reminder-template — authorization', () => {
  it('limitedA (no role:manage) → 403', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/reminder-template', {
      token: limitedA.token,
      body: { template: VALID_TEMPLATE, organizationName: 'Team HPX Eigen' },
    });
    expect(status).toBe(403);
  });
});

describe('POST /reminder-template — persist + reflect', () => {
  it('adminA saves a valid template and GET reflects it', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/reminder-template', {
      token: adminA.token,
      body: { template: VALID_TEMPLATE, organizationName: 'Acme Advisors' },
    });
    expect(status).toBe(200);
    const { body } = await req('GET', '/api/v1/settings/crm', { token: adminA.token });
    expect(body.pendingReminderTemplate).toBe(VALID_TEMPLATE);
    expect(body.pendingReminderOrgName).toBe('Acme Advisors');
  });

  it('accepts case-insensitive {{PENDING_DOCUMENTS}} → 200', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/reminder-template', {
      token: adminA.token,
      body: { template: 'Docs: {{PENDING_DOCUMENTS}}', organizationName: 'Acme' },
    });
    expect(status).toBe(200);
  });
});

describe('POST /reminder-template — validation', () => {
  it('rejects a template missing {{pending_documents}} → 400', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/reminder-template', {
      token: adminA.token,
      body: { template: 'no variable here', organizationName: 'Acme' },
    });
    expect(status).toBe(400);
  });
  it('rejects empty organizationName → 400', async () => {
    const { status } = await req('POST', '/api/v1/settings/crm/reminder-template', {
      token: adminA.token,
      body: { template: VALID_TEMPLATE, organizationName: '   ' },
    });
    expect(status).toBe(400);
  });
});

describe('DB CHECK constraint', () => {
  it('rejects a direct insert of a 10,001-char template', async () => {
    const oversized = 'x'.repeat(10_001);
    await expect(
      prisma.tenantSettings.upsert({
        where: { tenantId: tenantA },
        create: { tenantId: tenantA, pendingReminderTemplate: oversized },
        update: { pendingReminderTemplate: oversized },
      })
    ).rejects.toThrow();
  });
});

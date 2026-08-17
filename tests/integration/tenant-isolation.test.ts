/**
 * Tenant Isolation — Security Integration Tests
 *
 * Proves that tenant A cannot read, update, delete, or overwrite tenant B's
 * leads through the real Express router, auth middleware, and PostgreSQL.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType, LeadStage } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createLeadsRouter } from '../../src/routes/leads.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;

function uid() { return crypto.randomUUID(); }

function makeTestApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/leads', createLeadsRouter(prisma));
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

const trackedTenants: string[] = [];
let leadPermIds: string[];

beforeAll(async () => {
  const slugs = ['lead:view', 'lead:create', 'lead:edit', 'lead:delete', 'lead:assign'];
  leadPermIds = await Promise.all(slugs.map(getPermId));
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
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

async function makeTenantWithLeadPerms() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `iso-test-${tenantId.slice(0, 8)}` } });

  const pwHash = await bcryptjs.hash('Password1!', 10);
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `iso-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
  });
  const role = await prisma.role.create({ data: { tenantId, name: `IsoRole-${uid().slice(0, 6)}` } });
  await prisma.rolePermission.createMany({
    data: leadPermIds.map(pid => ({ roleId: role.id, permissionId: pid })),
    skipDuplicates: true,
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const token = await makeSession(user.id, tenantId);
  return { tenantId, userId: user.id, token };
}

describe('Tenant Isolation — Lead Operations', () => {

  it('TI01 — tenant A cannot list tenant B leads', async () => {
    const a = await makeTenantWithLeadPerms();
    const b = await makeTenantWithLeadPerms();

    await prisma.lead.create({
      data: { tenantId: b.tenantId, firstName: 'Secret', lastName: 'Lead', email: `secret-${uid().slice(0, 8)}@test.invalid`, status: 'NEW' as any, source: 'OTHER' as any },
    });

    const r = await api('GET', '/api/v1/leads', { token: a.token });
    expect(r.status).toBe(200);
    const leadIds = (r.body.data ?? r.body).map?.((l: any) => l.tenantId) ?? [];
    expect(leadIds).not.toContain(b.tenantId);
  });

  it('TI02 — tenant A cannot read tenant B lead by ID', async () => {
    const a = await makeTenantWithLeadPerms();
    const b = await makeTenantWithLeadPerms();

    const bLead = await prisma.lead.create({
      data: { tenantId: b.tenantId, firstName: 'Hidden', lastName: 'Lead', status: 'NEW' as any, source: 'OTHER' as any },
    });

    const r = await api('GET', `/api/v1/leads/${bLead.id}`, { token: a.token });
    expect([403, 404]).toContain(r.status);
  });

  it('TI03 — tenant A cannot update tenant B lead', async () => {
    const a = await makeTenantWithLeadPerms();
    const b = await makeTenantWithLeadPerms();

    const bLead = await prisma.lead.create({
      data: { tenantId: b.tenantId, firstName: 'Original', lastName: 'Name', status: 'NEW' as any, source: 'OTHER' as any },
    });

    const r = await api('POST', `/api/v1/leads/${bLead.id}`, {
      token: a.token,
      body: { firstName: 'Hacked' },
    });
    expect([403, 404]).toContain(r.status);

    const check = await prisma.lead.findUnique({ where: { id: bLead.id } });
    expect(check?.firstName).toBe('Original');
  });

  it('TI04 — tenant A cannot delete tenant B lead', async () => {
    const a = await makeTenantWithLeadPerms();
    const b = await makeTenantWithLeadPerms();

    const bLead = await prisma.lead.create({
      data: { tenantId: b.tenantId, firstName: 'Protected', lastName: 'Lead', status: 'NEW' as any, source: 'OTHER' as any },
    });

    const r = await api('POST', `/api/v1/leads/bulk-delete`, {
      token: a.token,
      body: { leadIds: [bLead.id] },
    });

    const check = await prisma.lead.findUnique({ where: { id: bLead.id } });
    expect(check?.deletedAt).toBeNull();
  });

  it('TI05 — tenant A import with overwrite cannot modify tenant B lead', async () => {
    const a = await makeTenantWithLeadPerms();
    const b = await makeTenantWithLeadPerms();
    const email = `crossover-${uid().slice(0, 8)}@test.invalid`;

    await prisma.lead.create({
      data: { tenantId: b.tenantId, firstName: 'TenantB', lastName: 'Original', email, status: 'NEW' as any, source: 'OTHER' as any },
    });

    const r = await api('POST', '/api/v1/leads/import', {
      token: a.token,
      body: { rows: [{ firstName: 'TenantA', lastName: 'Overwrite', email }], onDuplicates: 'overwrite' },
    });
    expect(r.status).toBe(200);

    const bCheck = await prisma.lead.findFirst({ where: { tenantId: b.tenantId, email, deletedAt: null } });
    expect(bCheck?.firstName).toBe('TenantB');
  });

  it('TI06 — tenant A bulk assign cannot affect tenant B leads', async () => {
    const a = await makeTenantWithLeadPerms();
    const b = await makeTenantWithLeadPerms();

    const bLead = await prisma.lead.create({
      data: { tenantId: b.tenantId, firstName: 'Unassignable', lastName: 'Lead', status: 'NEW' as any, source: 'OTHER' as any },
    });

    const r = await api('POST', '/api/v1/leads/bulk-assign', {
      token: a.token,
      body: { leadIds: [bLead.id], ownerId: a.userId },
    });

    const check = await prisma.lead.findUnique({ where: { id: bLead.id } });
    expect(check?.ownerId).not.toBe(a.userId);
  });
});

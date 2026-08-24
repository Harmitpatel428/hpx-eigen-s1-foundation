/**
 * Lead Bulk Delete + Interested Import Rules — HTTP Integration Tests
 *
 * Proves through the real Express router, auth middleware, permission
 * middleware, and PostgreSQL — no mocks:
 *   1. POST /api/v1/leads/bulk-delete soft-deletes exactly the given ids,
 *      leaves other tenants' leads untouched.
 *   2. Validation: missing/oversized ids arrays are rejected 400.
 *   3. Import rows with Stage=Interested but no follow-up date are rejected
 *      with a clear row error (never silently mapped to another stage).
 *   4. Import normalizes priority case-insensitively and rejects bad values.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
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

function makeTestApp() {
  const app = express();
  app.set('trust proxy', true); // honor X-Forwarded-For from the api() helper
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

function uid() { return crypto.randomUUID(); }

// Spoofed unique client IP per request. With REDIS_URL set, the Redis-backed
// per-IP rate limiters (import:ip:* — 20/hr) are shared by every suite through
// 127.0.0.1 and persist across runs; trust proxy + X-Forwarded-For gives each
// suite its own buckets so suites don't exhaust each other's quota.
const ipSeq = { n: crypto.randomBytes(2).readUInt16BE(0) };
function testIp(): string {
  const n = ipSeq.n++ % 65536;
  return `10.${(n >> 8) & 0xff}.${n & 0xff}.1`;
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
      'X-Forwarded-For': testIp(),
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

let trackedTenants: string[] = [];

beforeAll(async () => {
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

/** Org-admin tenant with the given permission slugs granted. */
async function makeAdminTenant(slugs: string[]) {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `bd-test-${tenantId.slice(0, 8)}` } });

  const pwHash = await bcryptjs.hash('Password1!', 10);
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `admin-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
  });
  const role = await prisma.role.create({ data: { tenantId, name: `AdminRole-${uid().slice(0, 6)}` } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await getPermId(slug) } });
  }
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const token = await makeSession(user.id, tenantId);
  return { tenantId, userId: user.id, token };
}

describe('POST /api/v1/leads/bulk-delete — HTTP integration', () => {

  it('BD1 — deletes exactly the given ids within the tenant; cross-tenant lead untouched', async () => {
    const a = await makeAdminTenant(['lead:view', 'lead:create', 'lead:delete']);
    const b = await makeAdminTenant(['lead:view', 'lead:create', 'lead:delete']);

    const mk = async (t: typeof a, first: string) => {
      const res = await api('POST', '/api/v1/leads', { token: t.token, body: { firstName: first, lastName: 'Bulk' } });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };

    const ids = [await mk(a, 'Asha'), await mk(a, 'Bharat'), await mk(a, 'Chandra')];
    const survivorA = await mk(a, 'Survivor');
    const foreignId = await mk(b, 'Foreign');

    const del = await api('POST', '/api/v1/leads/bulk-delete', { token: a.token, body: { ids } });
    expect(del.status).toBe(200);
    expect(del.body.data.count).toBe(3);

    // Exactly those three are soft-deleted…
    const deletedRows = await prisma.lead.findMany({
      where: { id: { in: ids }, tenantId: a.tenantId },
      select: { id: true, deletedAt: true },
    });
    expect(deletedRows).toHaveLength(3);
    expect(deletedRows.every((r) => r.deletedAt !== null)).toBe(true);

    // …the sibling lead in the same tenant survives…
    const survivor = await prisma.lead.findUnique({ where: { id: survivorA }, select: { deletedAt: true } });
    expect(survivor?.deletedAt).toBeNull();

    // …and the other tenant's lead is untouched.
    const foreign = await prisma.lead.findUnique({ where: { id: foreignId }, select: { deletedAt: true } });
    expect(foreign?.deletedAt).toBeNull();

    // Live list no longer contains them.
    const list = await api('GET', '/api/v1/leads?page=1&pageSize=50', { token: a.token });
    expect(list.status).toBe(200);
    const listedIds = (list.body.data as any[]).map((l) => l.id);
    for (const id of ids) expect(listedIds).not.toContain(id);
    expect(listedIds).toContain(survivorA);

    // Audit trail: entityId is `bulk:N`, never the joined id list — joining 75+
    // UUIDs exceeded PostgreSQL's 2704-byte btree index row cap (error 54000),
    // which threw AFTER the delete committed and surfaced as a bogus 500.
    const audits = await prisma.auditLog.findMany({
      where: { tenantId: a.tenantId, eventType: 'LEADS_BULK_DELETED' },
      select: { entityId: true },
    });
    expect(audits.map((a2) => a2.entityId)).toContain('bulk:3');

    // Second bulk delete of already-deleted ids reports zero — no double effect.
    const again = await api('POST', '/api/v1/leads/bulk-delete', { token: a.token, body: { ids } });
    expect(again.status).toBe(200);
    expect(again.body.data.count).toBe(0);
  });

  it('BD2 — authorization: without lead:delete → 403', async () => {
    const c = await makeAdminTenant(['lead:view', 'lead:create']); // no delete perm
    const res = await api('POST', '/api/v1/leads', { token: c.token, body: { firstName: 'NoPerm', lastName: 'User' } });
    expect(res.status).toBe(201);
    const del = await api('POST', '/api/v1/leads/bulk-delete', { token: c.token, body: { ids: [res.body.data.id] } });
    expect(del.status).toBe(403);
    const still = await prisma.lead.findUnique({ where: { id: res.body.data.id }, select: { deletedAt: true } });
    expect(still?.deletedAt).toBeNull();
  });

  it('BD3 — validation: empty array → 400; >200 ids → 400', async () => {
    const d = await makeAdminTenant(['lead:view', 'lead:create', 'lead:delete']);
    const empty = await api('POST', '/api/v1/leads/bulk-delete', { token: d.token, body: { ids: [] } });
    expect(empty.status).toBe(400);
    const big = await api('POST', '/api/v1/leads/bulk-delete', {
      token: d.token, body: { ids: Array.from({ length: 201 }, () => uid()) },
    });
    expect(big.status).toBe(400);
  });
});

describe('POST /api/v1/leads/import — Interested stage + priority rules', () => {

  it('IM1 — Interested without follow-up date is rejected per-row with clear error; never remapped', async () => {
    const t = await makeAdminTenant(['lead:view', 'lead:create']);
    const res = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: {
        onDuplicates: 'skip',
        rows: [
          { firstName: 'Interested', lastName: 'NoDate', stage: 'interested' },          // bad: no date
          { firstName: 'Interested', lastName: 'WithDate', stage: 'INTERESTED', followUpDate: '2026-09-01T10:00:00.000Z' }, // ok
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);
    const errs = res.body.data.errors as Array<{ row: number; message: string }>;
    expect(errs).toHaveLength(1);
    expect(errs[0].row).toBe(1);
    expect(errs[0].message).toContain('Follow-up Date is required for Interested leads');

    const saved = await prisma.lead.findFirst({
      where: { tenantId: t.tenantId, lastName: 'WithDate' },
      select: { stage: true, followUpDate: true },
    });
    expect(saved?.stage).toBe('INTERESTED');
    expect(saved?.followUpDate).not.toBeNull();
  });

  it('IM2 — priority normalizes case-insensitively and rejects invalid values', async () => {
    const t = await makeAdminTenant(['lead:view', 'lead:create']);
    const res = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: {
        onDuplicates: 'skip',
        rows: [
          { firstName: 'Pri', lastName: 'Lower', priority: 'critical' },
          { firstName: 'Pri', lastName: 'Bad', priority: 'URGENT' },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);
    const errs = res.body.data.errors as Array<{ row: number; message: string }>;
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('Priority');

    const saved = await prisma.lead.findFirst({
      where: { tenantId: t.tenantId, lastName: 'Lower' },
      select: { priority: true },
    });
    expect(saved?.priority).toBe('CRITICAL');
  });
});

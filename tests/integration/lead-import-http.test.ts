/**
 * Lead Import — HTTP Integration Tests
 *
 * Proves POST /api/v1/leads/import behaves correctly end-to-end through the
 * real Express router, auth middleware, and PostgreSQL — no mocks.
 *
 * Covers audit items 10 (HTTP verification), 8 (authorization), and
 * follow-up date rules, stage validation, duplicate handling, and
 * tenant isolation.
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

let createPermId: string;
const trackedTenants: string[] = [];

beforeAll(async () => {
  createPermId = await getPermId('lead:create');
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

async function makeImporterTenant() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `import-test-${tenantId.slice(0, 8)}` } });

  const pwHash = await bcryptjs.hash('Password1!', 10);
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `importer-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
  });
  const role = await prisma.role.create({ data: { tenantId, name: `ImporterRole-${uid().slice(0, 6)}` } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: createPermId } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const token = await makeSession(user.id, tenantId);
  return { tenantId, userId: user.id, token };
}

describe('POST /api/v1/leads/import — HTTP integration', () => {

  it('I01 — authorization: no lead:create → 403', async () => {
    const tenantId = uid();
    trackedTenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `noauth-${tenantId.slice(0, 8)}` } });
    const pwHash = await bcryptjs.hash('Password1!', 10);
    const user = await prisma.user.create({
      data: { id: uid(), tenantId, email: `noauth-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
    });
    const token = await makeSession(user.id, tenantId);

    const r = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'A', lastName: 'B' }] },
    });
    expect(r.status).toBe(403);
  });

  it('I02 — unauthenticated: no token → 401', async () => {
    const r = await api('POST', '/api/v1/leads/import', {
      body: { rows: [{ firstName: 'A', lastName: 'B' }] },
    });
    expect(r.status).toBe(401);
  });

  it('I03 — all 7 active stages accepted', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const rows = [
      { firstName: 'A', lastName: 'Stage', stage: LeadStage.NEW },
      { firstName: 'B', lastName: 'Stage', stage: LeadStage.QUALIFIED },
      { firstName: 'C', lastName: 'Stage', stage: LeadStage.FOLLOW_UP, followUpDate: TOMORROW },
      { firstName: 'D', lastName: 'Stage', stage: LeadStage.CALL_BACK_REQUESTED, followUpDate: TOMORROW },
      { firstName: 'E', lastName: 'Stage', stage: LeadStage.CALL_NOT_RECEIVED, followUpDate: TOMORROW },
      { firstName: 'F', lastName: 'Stage', stage: LeadStage.OTHER },
      { firstName: 'G', lastName: 'Stage', stage: LeadStage.DISQUALIFIED },
    ];
    const r = await api('POST', '/api/v1/leads/import', { token, body: { rows } });
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(7);
    expect(r.body.data.failed).toBe(0);

    const dbLeads = await prisma.lead.findMany({ where: { tenantId, deletedAt: null }, select: { stage: true } });
    const stages = new Set(dbLeads.map(l => l.stage));
    for (const stage of rows.map(r => r.stage)) {
      expect(stages.has(stage)).toBe(true);
    }
  });

  it('I04 — follow-up stages require followUpDate', async () => {
    const { token } = await makeImporterTenant();
    const FOLLOW_UP_STAGES = [LeadStage.FOLLOW_UP, LeadStage.CALL_BACK_REQUESTED, LeadStage.CALL_NOT_RECEIVED];

    for (const stage of FOLLOW_UP_STAGES) {
      const r = await api('POST', '/api/v1/leads/import', {
        token,
        body: { rows: [{ firstName: 'X', lastName: 'Y', stage }] },
      });
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe('IMPORT_VALIDATION_FAILED');
    }
  });

  it('I05 — QUALIFIED without followUpDate accepted', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const r = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'Q', lastName: 'Lead', stage: LeadStage.QUALIFIED }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(1);
  });

  it('I06 — invalid stage rejected, never silently remapped to NEW', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const r = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'Bad', lastName: 'Stage', stage: 'INVALID_STAGE' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('IMPORT_VALIDATION_FAILED');

    // Confirm nothing was created
    const count = await prisma.lead.count({ where: { tenantId, deletedAt: null } });
    expect(count).toBe(0);
  });

  it('I07 — legacy stages CONTACTED and CONVERTED rejected at import', async () => {
    const { token } = await makeImporterTenant();
    for (const stage of ['CONTACTED', 'CONVERTED']) {
      const r = await api('POST', '/api/v1/leads/import', {
        token,
        body: { rows: [{ firstName: 'Legacy', lastName: 'Lead', stage }] },
      });
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe('IMPORT_VALIDATION_FAILED');
    }
  });

  it('I08 — mixed batch: valid rows imported, invalid rows skipped with errors', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const email = `mixed-${uid().slice(0, 8)}@test.invalid`;

    const rows = [
      { firstName: 'Valid', lastName: 'One', email },
      { firstName: '', lastName: 'NoFirst' }, // missing firstName
      { firstName: 'Bad', lastName: 'Stage', stage: 'INVALID' },
    ];
    const r = await api('POST', '/api/v1/leads/import', { token, body: { rows } });
    // Per-row validation: valid rows imported, invalid rows reported in errors
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(1);
    expect(r.body.data.skipped).toBeGreaterThanOrEqual(2);
    expect(r.body.data.errors.length).toBeGreaterThanOrEqual(2);

    // Verify the valid row was actually created
    const leads = await prisma.lead.findMany({ where: { tenantId, email, deletedAt: null } });
    expect(leads).toHaveLength(1);
    expect(leads[0].firstName).toBe('Valid');
  });

  it('I09 — duplicate skip: second import of same email is skipped', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const email = `dup-skip-${uid().slice(0, 8)}@test.invalid`;

    const r1 = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'First', lastName: 'Import', email }] },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.data.imported).toBe(1);

    const r2 = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'Second', lastName: 'Import', email }], onDuplicates: 'skip' },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.data.imported).toBe(0);
    expect(r2.body.data.skipped).toBeGreaterThanOrEqual(1);

    // Only one lead with this email
    const leads = await prisma.lead.findMany({ where: { tenantId, email, deletedAt: null } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.firstName).toBe('First'); // not overwritten
  });

  it('I10 — duplicate overwrite: second import of same email updates the lead', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const email = `dup-overwrite-${uid().slice(0, 8)}@test.invalid`;

    const r1 = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'Original', lastName: 'Name', email }] },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.data.imported).toBe(1);

    const r2 = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'Updated', lastName: 'Name', email }], onDuplicates: 'overwrite' },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.data.imported).toBe(1); // overwrite counts as imported

    const leads = await prisma.lead.findMany({ where: { tenantId, email, deletedAt: null } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.firstName).toBe('Updated');
  });

  it('I11 — tenant isolation: importer cannot see or affect another tenant\'s leads', async () => {
    const { tenantId: t1, token: tok1 } = await makeImporterTenant();
    const { tenantId: t2 } = await makeImporterTenant();
    const email = `iso-${uid().slice(0, 8)}@test.invalid`;

    // Seed a lead in t2 with this email
    await prisma.lead.create({
      data: { tenantId: t2, firstName: 'T2', lastName: 'Lead', email, status: 'NEW' as any, source: 'OTHER' as any },
    });

    // Import with same email from t1 — should succeed (different tenant, no constraint)
    const r = await api('POST', '/api/v1/leads/import', {
      token: tok1,
      body: { rows: [{ firstName: 'T1', lastName: 'Lead', email }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(1);

    // t2's lead is untouched
    const t2Lead = await prisma.lead.findFirst({ where: { tenantId: t2, email, deletedAt: null } });
    expect(t2Lead?.firstName).toBe('T2');
    // t1 has exactly its own lead
    const t1Lead = await prisma.lead.findFirst({ where: { tenantId: t1, email, deletedAt: null } });
    expect(t1Lead?.firstName).toBe('T1');
  });

  it('I12 — empty rows array rejected', async () => {
    const { token } = await makeImporterTenant();
    const r = await api('POST', '/api/v1/leads/import', { token, body: { rows: [] } });
    expect(r.status).toBe(400);
  });

  it('I13 — import without stage defaults to NEW', async () => {
    const { tenantId, token } = await makeImporterTenant();
    const email = `no-stage-${uid().slice(0, 8)}@test.invalid`;

    const r = await api('POST', '/api/v1/leads/import', {
      token,
      body: { rows: [{ firstName: 'No', lastName: 'Stage', email }] },
    });
    expect(r.status).toBe(200);

    const lead = await prisma.lead.findFirst({ where: { tenantId, email, deletedAt: null } });
    expect(lead?.stage).toBe(LeadStage.NEW);
  });

  it('I14 — empty string email/phone normalized to null (not a unique constraint value)', async () => {
    const { tenantId, token } = await makeImporterTenant();

    // Two rows with empty email — should both be created (email=null, no unique conflict)
    const r = await api('POST', '/api/v1/leads/import', {
      token,
      body: {
        rows: [
          { firstName: 'Empty', lastName: 'Email1', email: '' },
          { firstName: 'Empty', lastName: 'Email2', email: '' },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(2);

    const leads = await prisma.lead.findMany({
      where: { tenantId, email: null, deletedAt: null },
    });
    expect(leads.length).toBeGreaterThanOrEqual(2);
  });

});

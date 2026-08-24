/**
 * Lead Import — Custom Fields, Ownership & Tags — HTTP Integration Tests
 *
 * Regression for the 2026-08-24 export→import incident: the import route
 * hardcoded `customFieldValues: []`, silently dropping every custom field.
 * Proves through the real Express router + PostgreSQL — no mocks:
 *   1. Custom field values round-trip exactly (comma/quote/newline included).
 *   2. Rows referencing unknown or OTHER-TENANT field ids are rejected loudly.
 *   3. Owner ids from another tenant are rejected; own users accepted.
 *   4. Overwrite mode MERGES custom fields per fieldId (imported wins).
 *   5. tagNames are resolved to tenant-scoped tags and assigned.
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

// Spoofed unique client IP per request so Redis-backed per-IP rate limiters
// don't bleed quota between suites sharing 127.0.0.1.
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
    await prisma.leadTagAssignment.deleteMany({ where: { tag: { tenantId } } }).catch(() => {});
    await prisma.leadTag.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadFieldDef.deleteMany({ where: { tenantId } }).catch(() => {});
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
  await prisma.tenant.create({ data: { id: tenantId, name: `cf-test-${tenantId.slice(0, 8)}` } });

  const pwHash = await bcryptjs.hash('Password1!', 10);
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `importer-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
  });
  const role = await prisma.role.create({ data: { tenantId, name: `CfRole-${uid().slice(0, 6)}` } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: createPermId } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const token = await makeSession(user.id, tenantId);
  return { tenantId, userId: user.id, token };
}

async function makeFieldDef(tenantId: string, name: string) {
  const def = await prisma.leadFieldDef.create({
    data: { id: uid(), tenantId, name, key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), type: 'text' },
  });
  return def.id;
}

/** The golden fixture value from the spec — comma, quote AND newline. */
const NASTY = 'Value with comma, quote " and newline\nsecond line';

describe('POST /api/v1/leads/import — custom fields / ownership / tags', () => {

  it('C01 — custom field values round-trip exactly into lead.customFieldValues', async () => {
    const t = await makeImporterTenant();
    const gstId = await makeFieldDef(t.tenantId, 'GST');
    const newCustomId = await makeFieldDef(t.tenantId, 'NewCustom');

    const sent = [
      { fieldId: gstId, value: 'GST' },
      { fieldId: newCustomId, value: NASTY },
    ];
    const r = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: { rows: [{ firstName: 'Harmit', lastName: 'Patel', customFieldValues: sent }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(1);
    expect(r.body.data.failed).toBe(0);

    const lead = await prisma.lead.findFirst({ where: { tenantId: t.tenantId, lastName: 'Patel', deletedAt: null } });
    expect(lead).not.toBeNull();
    // Exact array round trip — order, values, and the nasty cell byte-for-byte.
    expect(lead!.customFieldValues).toEqual(sent);
  });

  it('C02 — row referencing an unknown fieldId is rejected with a precise error', async () => {
    const t = await makeImporterTenant();
    const r = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: {
        rows: [
          { firstName: 'Ghost', lastName: 'Field', customFieldValues: [{ fieldId: uid(), value: 'x' }] },
        ],
      },
    });
    expect(r.status).toBe(400); // every row failed → batch rejected
    expect(r.body.error?.errors?.[0]?.message).toContain('Unknown custom field');
    const count = await prisma.lead.count({ where: { tenantId: t.tenantId } });
    expect(count).toBe(0);
  });

  it('C03 — cross-tenant fieldId is rejected like unknown (no resolving across tenants)', async () => {
    const other = await makeImporterTenant();
    const foreignFieldId = await makeFieldDef(other.tenantId, 'ForeignField');

    const t = await makeImporterTenant();
    const r = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: {
        rows: [
          { firstName: 'Spy', lastName: 'Import', customFieldValues: [{ fieldId: foreignFieldId, value: 'leak' }] },
        ],
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error?.errors?.[0]?.message).toContain('Unknown custom field');
    const count = await prisma.lead.count({ where: { tenantId: t.tenantId } });
    expect(count).toBe(0);
  });

  it('C04 — foreign owner UUID rejected; own active user accepted and persisted', async () => {
    const other = await makeImporterTenant();
    const t = await makeImporterTenant();

    const r1 = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: { rows: [{ firstName: 'Bad', lastName: 'Owner', ownerId: other.userId }] },
    });
    expect(r1.status).toBe(400);
    expect(r1.body.error?.errors?.[0]?.message).toContain('Owner ID does not match');

    const r2 = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: { rows: [{ firstName: 'Good', lastName: 'Owner', ownerId: t.userId }] },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.data.imported).toBe(1);
    const lead = await prisma.lead.findFirst({ where: { tenantId: t.tenantId, lastName: 'Owner', deletedAt: null } });
    expect(lead?.ownerId).toBe(t.userId);
  });

  it('C05 — overwrite mode merges custom fields per fieldId (imported wins)', async () => {
    const t = await makeImporterTenant();
    const gstId = await makeFieldDef(t.tenantId, 'GST');
    const kvaId = await makeFieldDef(t.tenantId, 'KVA');
    const email = `merge-${uid().slice(0, 8)}@test.invalid`;

    const r1 = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: { rows: [{ firstName: 'Merge', lastName: 'Me', email, customFieldValues: [{ fieldId: gstId, value: 'old-gst' }, { fieldId: kvaId, value: 'keep-me' }] }] },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.data.imported).toBe(1);

    const r2 = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: {
        onDuplicates: 'overwrite',
        rows: [{ firstName: 'Merge', lastName: 'Me', email, customFieldValues: [{ fieldId: gstId, value: 'new-gst' }] }],
      },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.data.imported).toBe(1);

    const lead = await prisma.lead.findFirst({ where: { tenantId: t.tenantId, email, deletedAt: null } });
    const cfs = [...((lead!.customFieldValues as any[]) ?? [])].sort((a, b) => a.fieldId.localeCompare(b.fieldId));
    expect(cfs).toEqual([
      { fieldId: gstId, value: 'new-gst' }, // imported wins…
      { fieldId: kvaId, value: 'keep-me' }, // …untouched sibling field survives
    ]);
  });

  it('C06 — tagNames resolve to tenant-scoped tags and are assigned to the lead', async () => {
    const t = await makeImporterTenant();
    const tagName = `vip-${uid().slice(0, 8)}`;

    const r = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: { rows: [{ firstName: 'Tagged', lastName: 'Lead', tagNames: [tagName, tagName] }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toBe(1);

    const tag = await prisma.leadTag.findFirst({ where: { tenantId: t.tenantId, name: tagName } });
    expect(tag).not.toBeNull();

    // Re-import reuses the existing tag via the upsert's update branch.
    const r2 = await api('POST', '/api/v1/leads/import', {
      token: t.token,
      body: { rows: [{ firstName: 'Tagged', lastName: 'Again', tagNames: [tagName] }] },
    });
    expect(r2.status).toBe(200);
    const tagAfter = await prisma.leadTag.findFirst({ where: { tenantId: t.tenantId, name: tagName } });
    expect(tagAfter!.usageCount).toBe(tag!.usageCount + 1);

    const lead = await prisma.lead.findFirst({
      where: { tenantId: t.tenantId, lastName: 'Lead', deletedAt: null },
      include: { tags: true },
    });
    expect(lead!.tags.map((a) => a.tagId)).toEqual([tag!.id]);
  });

});

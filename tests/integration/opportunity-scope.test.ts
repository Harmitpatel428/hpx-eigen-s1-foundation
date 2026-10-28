/**
 * /api/v1/opportunities — tenant-reference validation (F-OPP1) and caller-scope enforcement on /:id (F-OPP2).
 * Real Express router + auth/permission middleware + PostgreSQL, no mocks.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createOpportunitiesRouter } from '../../src/routes/opportunities.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;
const trackedTenants: string[] = [];

function uid() { return crypto.randomUUID(); }

const ipSeq = { n: crypto.randomBytes(2).readUInt16BE(0) };
function testIp(): string {
  const n = ipSeq.n++ % 65536;
  return `10.${(n >> 8) & 0xff}.${n & 0xff}.1`;
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/v1/opportunities${path}`, {
    method,
    headers: {
      'X-Forwarded-For': testIp(),
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
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

async function permId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded.`);
  return p.id;
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/opportunities', createOpportunitiesRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  server = http.createServer(app);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(res => server.close(() => res()));
  for (const tenantId of trackedTenants) {
    await prisma.pipeline.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.opportunity.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

const pw = bcryptjs.hashSync('Password1!', 4);
const SLUGS = ['opportunity:view', 'opportunity:create', 'opportunity:edit', 'opportunity:delete'];

async function mkCaller(tenantId: string, scopeType: ScopeType) {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  for (const slug of SLUGS) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType } });
  return { user, token: await makeSession(user.id, tenantId) };
}

async function seed() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `oppscope-${tenantId.slice(0, 8)}` } });
  const owner = await mkCaller(tenantId, ScopeType.OWN);
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'Own', lastName: 'Ed', ownerId: owner.user.id },
  });
  const opp = await prisma.opportunity.create({
    data: { tenantId, leadId: lead.id, ownerId: owner.user.id, title: 'Deal', value: 100 },
  });
  return { tenantId, owner, lead, opp };
}

describe('F-OPP2 — /opportunities/:id caller scope', () => {
  it('OWN-scope non-owner gets 404 on GET, PUT, stage, close and DELETE', async () => {
    const s = await seed();
    const other = await mkCaller(s.tenantId, ScopeType.OWN);
    const id = s.opp.id;
    expect((await call('GET', `/${id}`, other.token)).status).toBe(404);
    expect((await call('PUT', `/${id}`, other.token, { title: 'pwned' })).status).toBe(404);
    expect((await call('PUT', `/${id}/stage`, other.token, { stage: 'QUALIFICATION' })).status).toBe(404);
    expect((await call('POST', `/${id}/close`, other.token, { outcome: 'WON' })).status).toBe(404);
    expect((await call('DELETE', `/${id}`, other.token)).status).toBe(404);
    const row = await prisma.opportunity.findUnique({ where: { id } });
    expect(row?.title).toBe('Deal');
    expect(row?.deletedAt).toBeNull();
  });

  it('the owner (OWN scope) gets 200 on GET and PUT', async () => {
    const s = await seed();
    expect((await call('GET', `/${s.opp.id}`, s.owner.token)).status).toBe(200);
    expect((await call('PUT', `/${s.opp.id}`, s.owner.token, { title: 'Renamed' })).status).toBe(200);
  });

  it('ORGANIZATION-scope caller can read and delete another user\'s opportunity', async () => {
    const s = await seed();
    const admin = await mkCaller(s.tenantId, ScopeType.ORGANIZATION);
    expect((await call('GET', `/${s.opp.id}`, admin.token)).status).toBe(200);
    expect((await call('DELETE', `/${s.opp.id}`, admin.token)).status).toBe(204);
  });
});

describe('F-OPP1 — cross-tenant leadId/contactId/ownerId', () => {
  it('rejects create with another tenant\'s lead', async () => {
    const a = await seed();
    const b = await seed();
    const r = await call('POST', '', a.owner.token, { leadId: b.lead.id, title: 'x', value: 1 });
    expect(r.status).toBe(400);
    expect(await prisma.opportunity.count({ where: { tenantId: a.tenantId, leadId: b.lead.id } })).toBe(0);
  });

  it('rejects create with another tenant\'s contact or owner', async () => {
    const a = await seed();
    const b = await seed();
    const contact = await prisma.contact.create({ data: { tenantId: b.tenantId, firstName: 'C', lastName: 'X' } });
    expect((await call('POST', '', a.owner.token, { leadId: a.lead.id, contactId: contact.id, title: 'x', value: 1 })).status).toBe(400);
    expect((await call('POST', '', a.owner.token, { leadId: a.lead.id, ownerId: b.owner.user.id, title: 'x', value: 1 })).status).toBe(400);
  });

  it('rejects update with another tenant\'s contact or owner', async () => {
    const a = await seed();
    const b = await seed();
    const contact = await prisma.contact.create({ data: { tenantId: b.tenantId, firstName: 'C', lastName: 'X' } });
    expect((await call('PUT', `/${a.opp.id}`, a.owner.token, { contactId: contact.id })).status).toBe(400);
    expect((await call('PUT', `/${a.opp.id}`, a.owner.token, { ownerId: b.owner.user.id })).status).toBe(400);
    const row = await prisma.opportunity.findUnique({ where: { id: a.opp.id } });
    expect(row?.contactId).toBeNull();
    expect(row?.ownerId).toBe(a.owner.user.id);
  });

  it('still allows create with same-tenant lead and contact', async () => {
    const a = await seed();
    const contact = await prisma.contact.create({
      data: { tenantId: a.tenantId, leadId: a.lead.id, firstName: 'C', lastName: 'Y' },
    });
    const r = await call('POST', '', a.owner.token, { leadId: a.lead.id, contactId: contact.id, title: 'ok', value: 5 });
    expect(r.status).toBe(201);
  });
});

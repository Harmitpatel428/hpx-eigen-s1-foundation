/**
 * GET /api/v1/leads/:leadId/{contacts,notes,notes/summary} — caller-scope enforcement (HTTP integration).
 * Real Express routers + auth/permission middleware + PostgreSQL, no mocks.
 * lead:view alone must not expose a lead's subresources by id: the lead has to be inside the
 * caller's scope (buildOwnerFilter), same as the leads list and lead-activities.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createLeadContactsRouter } from '../../src/routes/lead-contacts.router';
import { createLeadNotesRouter } from '../../src/routes/lead-notes.router';
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

async function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/v1/leads${path}`, {
    headers: { 'X-Forwarded-For': testIp(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

async function permId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded.`);
  return p.id;
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads/:leadId/contacts', createLeadContactsRouter(prisma));
  app.use('/api/v1/leads/:leadId/notes', createLeadNotesRouter(prisma));
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
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadNote.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.department.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

const pw = bcryptjs.hashSync('Password1!', 4);

async function mkCaller(tenantId: string, scopeType: ScopeType) {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId('lead:view') } });
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType } });
  return { user, token: await makeSession(user.id, tenantId) };
}

async function seed() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `subscope-${tenantId.slice(0, 8)}` } });
  const owner = await mkCaller(tenantId, ScopeType.OWN);
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'Own', lastName: 'Ed', ownerId: owner.user.id },
  });
  await prisma.contact.create({
    data: { tenantId, leadId: lead.id, firstName: 'Pat', lastName: 'Contact', isMain: true },
  });
  await prisma.leadNote.create({
    data: { tenantId, leadId: lead.id, authorId: owner.user.id, content: 'secret note' },
  });
  return { tenantId, owner, lead };
}

describe('GET /leads/:leadId/{contacts,notes,notes/summary} — caller scope', () => {
  it('OWN-scope caller who does not own the lead gets 404 on contacts, notes and summary', async () => {
    const s = await seed();
    const other = await mkCaller(s.tenantId, ScopeType.OWN);
    expect((await get(`/${s.lead.id}/contacts`, other.token)).status).toBe(404);
    expect((await get(`/${s.lead.id}/notes`, other.token)).status).toBe(404);
    expect((await get(`/${s.lead.id}/notes/summary`, other.token)).status).toBe(404);
  });

  it('the owner (OWN scope) gets 200 with the data', async () => {
    const s = await seed();
    const c = await get(`/${s.lead.id}/contacts`, s.owner.token);
    expect(c.status).toBe(200);
    expect(c.body.data).toHaveLength(1);
    const n = await get(`/${s.lead.id}/notes`, s.owner.token);
    expect(n.status).toBe(200);
    expect(n.body.data).toHaveLength(1);
    expect((await get(`/${s.lead.id}/notes/summary`, s.owner.token)).status).toBe(200);
  });

  it('ORGANIZATION-scope caller sees subresources of a lead owned by someone else', async () => {
    const s = await seed();
    const admin = await mkCaller(s.tenantId, ScopeType.ORGANIZATION);
    const c = await get(`/${s.lead.id}/contacts`, admin.token);
    expect(c.status).toBe(200);
    expect(c.body.data).toHaveLength(1);
    expect((await get(`/${s.lead.id}/notes`, admin.token)).status).toBe(200);
    expect((await get(`/${s.lead.id}/notes/summary`, admin.token)).status).toBe(200);
  });
});

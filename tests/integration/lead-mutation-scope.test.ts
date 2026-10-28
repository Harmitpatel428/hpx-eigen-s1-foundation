/**
 * lead:edit / lead:delete MUTATIONS — caller-scope enforcement (HTTP integration).
 * Real Express routers + auth/permission middleware + PostgreSQL, no mocks.
 * Holding lead:edit/lead:delete must not let an OWN-scope caller mutate a lead (or its
 * contacts/notes/activities) outside their visible set (same buildOwnerFilter as reads).
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
import { createLeadContactsRouter } from '../../src/routes/lead-contacts.router';
import { createLeadNotesRouter } from '../../src/routes/lead-notes.router';
import { createLeadWaChannelsRouter } from '../../src/routes/lead-wa-channels.router';
import { createGlobalLeadActivitiesRouter } from '../../src/routes/global-lead-activities.router';
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
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'X-Forwarded-For': testIp(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let b: any;
  try { b = await res.json(); } catch { b = null; }
  return { status: res.status, body: b };
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
  app.use('/api/v1/leads', createLeadsRouter(prisma));
  app.use('/api/v1/leads/:leadId/contacts', createLeadContactsRouter(prisma));
  app.use('/api/v1/leads/:leadId/notes', createLeadNotesRouter(prisma));
  app.use('/api/v1/leads/:leadId/wa-channels', createLeadWaChannelsRouter(prisma));
  app.use('/api/v1/lead-activities', createGlobalLeadActivitiesRouter(prisma));
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
    await prisma.leadActivity.deleteMany({ where: { tenantId } }).catch(() => {});
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
  for (const slug of ['lead:view', 'lead:edit', 'lead:delete']) {
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
  await prisma.tenant.create({ data: { id: tenantId, name: `mutscope-${tenantId.slice(0, 8)}` } });
  const owner = await mkCaller(tenantId, ScopeType.OWN);
  const other = await mkCaller(tenantId, ScopeType.OWN);
  const admin = await mkCaller(tenantId, ScopeType.ORGANIZATION);
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'Own', lastName: 'Ed', ownerId: owner.user.id } });
  const contact = await prisma.contact.create({ data: { tenantId, leadId: lead.id, firstName: 'Pat', lastName: 'Contact', isMain: true } });
  const note = await prisma.leadNote.create({ data: { tenantId, leadId: lead.id, authorId: owner.user.id, content: 'secret note' } });
  return { tenantId, owner, other, admin, lead, contact, note };
}

describe('lead:edit / lead:delete mutations - caller scope', () => {
  it('OWN-scope non-owner gets 404 on single-lead mutations and nothing changes', async () => {
    const s = await seed();
    const t = s.other.token;
    expect((await call('PUT', `/leads/${s.lead.id}`, t, { firstName: 'Hacked' })).status).toBe(404);
    expect((await call('POST', `/leads/${s.lead.id}/waiting-higher-authority`, t, { value: true })).status).toBe(404);
    expect((await call('DELETE', `/leads/${s.lead.id}`, t)).status).toBe(404);
    expect((await call('POST', `/leads/${s.lead.id}/contacts`, t, { firstName: 'X', lastName: 'Y' })).status).toBe(404);
    expect((await call('PUT', `/leads/${s.lead.id}/contacts/${s.contact.id}`, t, { firstName: 'Z' })).status).toBe(404);
    expect((await call('DELETE', `/leads/${s.lead.id}/contacts/${s.contact.id}`, t)).status).toBe(404);
    expect((await call('POST', `/leads/${s.lead.id}/notes`, t, { content: 'x' })).status).toBe(404);
    expect((await call('PATCH', `/leads/${s.lead.id}/notes/${s.note.id}`, t, { content: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/leads/${s.lead.id}/notes/${s.note.id}`, t)).status).toBe(404);
    expect((await call('POST', `/leads/${s.lead.id}/wa-channels`, t, { identifier: '+1', displayName: 'wa' })).status).toBe(404);
    expect((await call('POST', `/lead-activities`, t, { leadId: s.lead.id, type: 'NOTE', subject: 'x' })).status).toBe(404);

    const after = await prisma.lead.findUnique({ where: { id: s.lead.id } });
    expect(after?.firstName).toBe('Own');
    expect(after?.deletedAt).toBeNull();
    expect(await prisma.contact.count({ where: { leadId: s.lead.id, deletedAt: null } })).toBe(1);
    expect(await prisma.leadNote.count({ where: { leadId: s.lead.id, deletedAt: null } })).toBe(1);
  });

  it('a note of ANOTHER lead cannot be touched via the callers own leadId in the URL', async () => {
    const s = await seed();
    const mine = await prisma.lead.create({ data: { tenantId: s.tenantId, firstName: 'Mine', lastName: 'L', ownerId: s.other.user.id } });
    expect((await call('PATCH', `/leads/${mine.id}/notes/${s.note.id}`, s.other.token, { content: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/leads/${mine.id}/notes/${s.note.id}`, s.other.token)).status).toBe(404);
    expect(await prisma.leadNote.count({ where: { id: s.note.id, deletedAt: null } })).toBe(1);
  });

  it('SINGLE-DELETED variant: non-owner cannot restore / permanently delete a soft-deleted lead', async () => {
    const s = await seed();
    await prisma.lead.update({ where: { id: s.lead.id, deletedAt: null }, data: { deletedAt: new Date() } });
    expect((await call('POST', `/leads/${s.lead.id}/restore`, s.other.token)).status).toBe(404);
    expect((await call('DELETE', `/leads/${s.lead.id}/permanent`, s.other.token)).status).toBe(404);
    expect(await prisma.lead.count({ where: { id: s.lead.id, deletedAt: { not: null } } })).toBe(1);
    // owner may restore it
    expect((await call('POST', `/leads/${s.lead.id}/restore`, s.owner.token)).status).toBe(200);
  });

  it('BULK variant: non-owner affects 0 rows (restrict, not reject); owner affects own', async () => {
    const s = await seed();
    const del = await call('POST', '/leads/bulk-delete', s.other.token, { ids: [s.lead.id] });
    expect(del.status).toBe(200);
    expect(del.body.data.count).toBe(0);
    expect(await prisma.lead.count({ where: { id: s.lead.id, deletedAt: null } })).toBe(1);

    await prisma.lead.update({ where: { id: s.lead.id, deletedAt: null }, data: { deletedAt: new Date() } });
    const rest = await call('POST', '/leads/bulk-restore', s.other.token, { ids: [s.lead.id] });
    expect(rest.body.data.count).toBe(0);
    const perm = await call('POST', '/leads/bulk-permanent-delete', s.other.token, { ids: [s.lead.id] });
    expect(perm.body.data.count).toBe(0);
    expect(await prisma.lead.count({ where: { id: s.lead.id, deletedAt: { not: null } } })).toBe(1);

    const ownRest = await call('POST', '/leads/bulk-restore', s.owner.token, { ids: [s.lead.id] });
    expect(ownRest.body.data.count).toBe(1);
    const ownDel = await call('POST', '/leads/bulk-delete', s.owner.token, { ids: [s.lead.id] });
    expect(ownDel.body.data.count).toBe(1);
  });

  it('the owner (OWN scope) can still edit and add notes/contacts', async () => {
    const s = await seed();
    expect((await call('PUT', `/leads/${s.lead.id}`, s.owner.token, { firstName: 'Renamed' })).status).toBe(200);
    expect((await call('POST', `/leads/${s.lead.id}/notes`, s.owner.token, { content: 'hello' })).status).toBe(201);
    expect((await call('POST', `/leads/${s.lead.id}/contacts`, s.owner.token, { firstName: 'A', lastName: 'B' })).status).toBe(201);
    expect((await call('PATCH', `/leads/${s.lead.id}/notes/${s.note.id}`, s.owner.token, { content: 'edited' })).status).toBe(200);
  });

  it('ORGANIZATION-scope caller can edit a lead owned by someone else', async () => {
    const s = await seed();
    expect((await call('PUT', `/leads/${s.lead.id}`, s.admin.token, { firstName: 'AdminEdit' })).status).toBe(200);
    expect((await call('POST', `/leads/${s.lead.id}/notes`, s.admin.token, { content: 'adm' })).status).toBe(201);
  });
});

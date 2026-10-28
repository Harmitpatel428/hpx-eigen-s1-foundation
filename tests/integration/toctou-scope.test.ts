/**
 * Phase 3 — TOCTOU closure on single-/:id scope gates (HTTP integration, real Express + PostgreSQL).
 *
 * The scope gate (assertLeadInScope / assertInScope) and the write used to be two statements, so a
 * row reassigned out of the caller's scope between them was still written (check-then-act).
 * The scope filter is now folded into the mutation's own WHERE.
 *
 * Deterministic window: the routers get a prisma Proxy whose lead/opportunity `findFirst` (the gate
 * query) parks AFTER it has read an in-scope row. While N concurrent requests are parked past the
 * gate, the test reassigns the row to someone else, then releases them. Pre-fix every parked write
 * lands (200); post-fix each write's own WHERE no longer matches -> 404 and nothing changes.
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
import { createOpportunitiesRouter } from '../../src/routes/opportunities.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const N = 12; // concurrent requests per case

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

// ── Gate: parks gate queries (lead/opportunity findFirst) after they have read ─────────────────
const gate = { armed: false, arrivals: 0, open: Promise.resolve() as Promise<void>, release: () => {} };
function arm() {
  gate.armed = true;
  gate.arrivals = 0;
  gate.open = new Promise<void>(r => { gate.release = () => r(); });
}
function bindIfFn(t: any, p: string | symbol) { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; }
function gatedModel(delegate: any) {
  return new Proxy(delegate, {
    get(t, p) {
      if (p === 'findFirst') {
        return async (...a: any[]) => {
          const r = await t.findFirst(...a);
          if (gate.armed) { gate.arrivals++; await gate.open; }
          return r;
        };
      }
      return bindIfFn(t, p);
    },
  });
}
const gatedPrisma = new Proxy(prisma, {
  get(t, p) {
    if (p === 'lead' || p === 'opportunity') return gatedModel((t as any)[p]);
    return bindIfFn(t, p);
  },
}) as PrismaClient;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', createLeadsRouter(gatedPrisma));
  app.use('/api/v1/leads/:leadId/contacts', createLeadContactsRouter(gatedPrisma));
  app.use('/api/v1/leads/:leadId/notes', createLeadNotesRouter(gatedPrisma));
  app.use('/api/v1/leads/:leadId/wa-channels', createLeadWaChannelsRouter(gatedPrisma));
  app.use('/api/v1/opportunities', createOpportunitiesRouter(gatedPrisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  server = http.createServer(app);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  gate.armed = false;
  gate.release();
  await new Promise<void>(res => server.close(() => res()));
  for (const tenantId of trackedTenants) {
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.pipeline.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.opportunity.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadNote.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadActivity.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.whatsAppChannel.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

const pw = bcryptjs.hashSync('Password1!', 4);
const SLUGS = ['lead:view', 'lead:edit', 'lead:delete', 'opportunity:view', 'opportunity:edit', 'opportunity:delete'];

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

/** B = OWN-scope caller who owns everything at gate time; U = the user it is reassigned to. */
async function seed(opts: { deleted?: boolean } = {}) {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `toctou-${tenantId.slice(0, 8)}` } });
  const b = await mkCaller(tenantId, ScopeType.OWN);
  const u = await mkCaller(tenantId, ScopeType.OWN);
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'Own', lastName: 'Ed', ownerId: b.user.id, ...(opts.deleted ? { deletedAt: new Date() } : {}) },
  });
  const contact = await prisma.contact.create({ data: { tenantId, leadId: lead.id, firstName: 'Pat', lastName: 'Contact', isMain: false } });
  const note = await prisma.leadNote.create({ data: { tenantId, leadId: lead.id, authorId: b.user.id, content: 'orig note' } });
  const channel = await prisma.whatsAppChannel.create({ data: { tenantId, identifier: '+15550001', displayName: 'orig wa' } });
  await prisma.leadWhatsAppChannel.create({ data: { leadId: lead.id, channelId: channel.id, isPrimary: false } });
  const opp = await prisma.opportunity.create({ data: { tenantId, leadId: lead.id, ownerId: b.user.id, title: 'Deal', value: 100 } });
  return { tenantId, b, u, lead, contact, note, channel, opp };
}
type Seed = Awaited<ReturnType<typeof seed>>;

/** Fire N concurrent requests as B, park them past the gate, reassign away from B, release. */
async function raceReassign(s: Seed, reassign: () => Promise<unknown>, req: () => Promise<{ status: number }>) {
  arm();
  const inflight = Array.from({ length: N }, () => req());
  const deadline = Date.now() + 20_000;
  while (gate.arrivals < N && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  expect(gate.arrivals).toBeGreaterThanOrEqual(N); // every request is past its scope gate
  await reassign();
  gate.armed = false;
  gate.release();
  return Promise.all(inflight);
}

const reassignLead = (s: Seed) => () =>
  prisma.lead.updateMany({ where: { id: s.lead.id }, data: { ownerId: s.u.user.id, managerId: null } });
const reassignOpp = (s: Seed) => () =>
  prisma.opportunity.update({ where: { id: s.opp.id }, data: { ownerId: s.u.user.id } });

interface Case {
  name: string;
  deleted?: boolean;
  reassign: (s: Seed) => () => Promise<unknown>;
  req: (s: Seed) => () => Promise<{ status: number }>;
  unchanged: (s: Seed) => Promise<void>;
}

const cases: Case[] = [
  {
    name: 'PUT /leads/:id', reassign: reassignLead,
    req: s => () => call('PUT', `/leads/${s.lead.id}`, s.b.token, { firstName: 'Hacked' }),
    unchanged: async s => { expect((await prisma.lead.findUnique({ where: { id: s.lead.id } }))?.firstName).toBe('Own'); },
  },
  {
    name: 'POST /leads/:id/convert', reassign: reassignLead,
    req: s => () => call('POST', `/leads/${s.lead.id}/convert`, s.b.token,
      { contact: { firstName: 'C', lastName: 'D' }, opportunity: { title: 'T', value: 1 } }),
    unchanged: async s => {
      expect((await prisma.lead.findUnique({ where: { id: s.lead.id } }))?.status).toBe('NEW');
      expect(await prisma.opportunity.count({ where: { leadId: s.lead.id } })).toBe(1); // only the seeded one
      expect(await prisma.contact.count({ where: { leadId: s.lead.id } })).toBe(1);
    },
  },
  {
    name: 'POST /leads/:id/waiting-higher-authority', reassign: reassignLead,
    req: s => () => call('POST', `/leads/${s.lead.id}/waiting-higher-authority`, s.b.token, { value: true }),
    unchanged: async s => { expect((await prisma.lead.findUnique({ where: { id: s.lead.id } }))?.waitingHigherAuthority).toBe(false); },
  },
  {
    name: 'DELETE /leads/:id', reassign: reassignLead,
    req: s => () => call('DELETE', `/leads/${s.lead.id}`, s.b.token),
    unchanged: async s => { expect((await prisma.lead.findUnique({ where: { id: s.lead.id } }))?.deletedAt).toBeNull(); },
  },
  {
    name: 'POST /leads/:id/restore', deleted: true, reassign: reassignLead,
    req: s => () => call('POST', `/leads/${s.lead.id}/restore`, s.b.token),
    unchanged: async s => { expect((await prisma.lead.findUnique({ where: { id: s.lead.id } }))?.deletedAt).not.toBeNull(); },
  },
  {
    name: 'DELETE /leads/:id/permanent', deleted: true, reassign: reassignLead,
    req: s => () => call('DELETE', `/leads/${s.lead.id}/permanent`, s.b.token),
    unchanged: async s => { expect(await prisma.lead.count({ where: { id: s.lead.id } })).toBe(1); },
  },
  {
    name: 'PUT /opportunities/:id', reassign: reassignOpp,
    req: s => () => call('PUT', `/opportunities/${s.opp.id}`, s.b.token, { title: 'Hacked' }),
    unchanged: async s => { expect((await prisma.opportunity.findUnique({ where: { id: s.opp.id } }))?.title).toBe('Deal'); },
  },
  {
    name: 'PUT /opportunities/:id/stage', reassign: reassignOpp,
    req: s => () => call('PUT', `/opportunities/${s.opp.id}/stage`, s.b.token, { stage: 'QUALIFICATION' }),
    unchanged: async s => { expect((await prisma.opportunity.findUnique({ where: { id: s.opp.id } }))?.stage).toBe('PROSPECTING'); },
  },
  {
    name: 'POST /opportunities/:id/close', reassign: reassignOpp,
    req: s => () => call('POST', `/opportunities/${s.opp.id}/close`, s.b.token, { outcome: 'WON' }),
    unchanged: async s => { expect((await prisma.opportunity.findUnique({ where: { id: s.opp.id } }))?.stage).toBe('PROSPECTING'); },
  },
  {
    name: 'DELETE /opportunities/:id', reassign: reassignOpp,
    req: s => () => call('DELETE', `/opportunities/${s.opp.id}`, s.b.token),
    unchanged: async s => { expect((await prisma.opportunity.findUnique({ where: { id: s.opp.id } }))?.deletedAt).toBeNull(); },
  },
  {
    name: 'PUT /leads/:id/contacts/:contactId', reassign: reassignLead,
    req: s => () => call('PUT', `/leads/${s.lead.id}/contacts/${s.contact.id}`, s.b.token, { firstName: 'Hacked' }),
    unchanged: async s => { expect((await prisma.contact.findUnique({ where: { id: s.contact.id } }))?.firstName).toBe('Pat'); },
  },
  {
    name: 'DELETE /leads/:id/contacts/:contactId', reassign: reassignLead,
    req: s => () => call('DELETE', `/leads/${s.lead.id}/contacts/${s.contact.id}`, s.b.token),
    unchanged: async s => { expect((await prisma.contact.findUnique({ where: { id: s.contact.id } }))?.deletedAt).toBeNull(); },
  },
  {
    name: 'PATCH /leads/:id/notes/:noteId', reassign: reassignLead,
    req: s => () => call('PATCH', `/leads/${s.lead.id}/notes/${s.note.id}`, s.b.token, { content: 'Hacked' }),
    unchanged: async s => { expect((await prisma.leadNote.findUnique({ where: { id: s.note.id } }))?.content).toBe('orig note'); },
  },
  {
    name: 'DELETE /leads/:id/notes/:noteId', reassign: reassignLead,
    req: s => () => call('DELETE', `/leads/${s.lead.id}/notes/${s.note.id}`, s.b.token),
    unchanged: async s => { expect((await prisma.leadNote.findUnique({ where: { id: s.note.id } }))?.deletedAt).toBeNull(); },
  },
  {
    name: 'PATCH /leads/:id/wa-channels/:channelId', reassign: reassignLead,
    req: s => () => call('PATCH', `/leads/${s.lead.id}/wa-channels/${s.channel.id}`, s.b.token, { displayName: 'Hacked', isPrimary: true }),
    unchanged: async s => {
      expect((await prisma.whatsAppChannel.findUnique({ where: { id: s.channel.id } }))?.displayName).toBe('orig wa');
      expect((await prisma.leadWhatsAppChannel.findFirst({ where: { channelId: s.channel.id } }))?.isPrimary).toBe(false);
    },
  },
  {
    name: 'DELETE /leads/:id/wa-channels/:channelId', reassign: reassignLead,
    req: s => () => call('DELETE', `/leads/${s.lead.id}/wa-channels/${s.channel.id}`, s.b.token),
    unchanged: async s => { expect((await prisma.whatsAppChannel.findUnique({ where: { id: s.channel.id } }))?.status).toBe('ACTIVE'); },
  },
  {
    name: 'POST /leads/:id/wa-channels/:channelId/make-primary', reassign: reassignLead,
    req: s => () => call('POST', `/leads/${s.lead.id}/wa-channels/${s.channel.id}/make-primary`, s.b.token),
    unchanged: async s => { expect((await prisma.leadWhatsAppChannel.findFirst({ where: { channelId: s.channel.id } }))?.isPrimary).toBe(false); },
  },
];

describe('Phase 3 — scope gate is atomic with the write (no TOCTOU)', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s: reassigned away mid-flight -> all N concurrent writes 404, row unchanged', async (_name, c) => {
    const s = await seed({ deleted: c.deleted });
    const results = await raceReassign(s, c.reassign(s), c.req(s));
    expect(results.map(r => r.status)).toEqual(Array(N).fill(404));
    await c.unchanged(s);
  }, 60_000);

  it('positive: the owner\'s N concurrent mutations all succeed', async () => {
    const s = await seed();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => call('PUT', `/leads/${s.lead.id}`, s.b.token, { firstName: `Own${i}` })),
    );
    expect(results.map(r => r.status)).toEqual(Array(N).fill(200));
    const after = await prisma.lead.findUnique({ where: { id: s.lead.id } });
    expect(after?.firstName).toMatch(/^Own\d+$/);
  }, 60_000);

  it('positive: owner\'s concurrent opportunity updates all succeed', async () => {
    const s = await seed();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => call('PUT', `/opportunities/${s.opp.id}`, s.b.token, { title: `Deal${i}` })),
    );
    expect(results.map(r => r.status)).toEqual(Array(N).fill(200));
  }, 60_000);
});

/**
 * DocActivity isolation — HTTP integration tests.
 * Real Express routers + auth/permission middleware + PostgreSQL, no mocks.
 *
 * Proves Documentation activities (DocActivity) are physically isolated from Sales:
 *  1. A DocActivity never appears in Sales GET /lead-activities.
 *  2. Documentation endpoints reject callers without Documentation permissions (403).
 *  3. A caller without doc:case:view-all only sees activities on cases they own/are assigned.
 *  4. The Sales LeadActivity write path (shared by Doc auto-drop) creates no DocActivity.
 */

import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createDocumentationRouter } from '../../src/routes/documentation.router';
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

async function call(
  method: string, path: string, token?: string, body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': testIp(),
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

/** A user in `tenantId` holding exactly `slugs`, ORGANIZATION scope; returns {userId, token}. */
async function makeUser(tenantId: string, slugs: string[]) {
  const pw = await bcryptjs.hash('Password1!', 10);
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const token = await makeSession(user.id, tenantId);
  return { userId: user.id, token };
}

async function makeTenant(): Promise<string> {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `docact-${tenantId.slice(0, 8)}` } });
  return tenantId;
}

async function makeLeadCase(tenantId: string, ownerId: string | null, assignedTo: string | null, createdBy: string) {
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'Lead', lastName: uid().slice(0, 6), ownerId: ownerId ?? undefined },
  });
  const docCase = await prisma.docCase.create({
    data: { tenantId, leadId: lead.id, createdBy, assignedTo: assignedTo ?? undefined },
  });
  return { leadId: lead.id, caseId: docCase.id };
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
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
    await prisma.docActivity.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadActivity.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

describe('DocActivity isolation', () => {
  it('T1 — a DocActivity never appears in Sales GET /lead-activities', async () => {
    const tenantId = await makeTenant();
    const doc = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all', 'lead:view']);
    const { leadId, caseId } = await makeLeadCase(tenantId, doc.userId, doc.userId, doc.userId);

    // One Sales LeadActivity on the lead, so the Sales list is non-trivially populated.
    const leadAct = await prisma.leadActivity.create({
      data: { tenantId, leadId, actorUserId: doc.userId, type: 'NOTE_ADDED', subject: 'sales note' },
    });

    const created = await call('POST', `/api/v1/documentation/cases/${caseId}/activities`, doc.token,
      { type: 'FOLLOW_UP', subject: 'chase passport' });
    expect(created.status).toBe(201);
    const docActId = created.body.data.id;

    const list = await call('GET', '/api/v1/lead-activities?filter=ALL', doc.token);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((a: any) => a.id);
    expect(ids).toContain(leadAct.id);
    expect(ids).not.toContain(docActId);
    // Sanity: the DocActivity really was persisted (isolation isn't "nothing was created").
    expect(await prisma.docActivity.count({ where: { tenantId } })).toBe(1);
  });

  it('T2 — doc endpoints reject a caller without doc:view (403)', async () => {
    const tenantId = await makeTenant();
    const sales = await makeUser(tenantId, ['lead:view', 'lead:edit']);
    const res = await call('GET', '/api/v1/documentation/activities', sales.token);
    expect(res.status).toBe(403);
  });

  it('T3 — without doc:case:view-all, caller sees only their own cases\' activities', async () => {
    const tenantId = await makeTenant();
    const me = await makeUser(tenantId, ['doc:view', 'doc:edit']); // NO doc:case:view-all
    const other = await makeUser(tenantId, ['doc:view', 'doc:edit']);

    const mine = await makeLeadCase(tenantId, me.userId, me.userId, me.userId);
    const theirs = await makeLeadCase(tenantId, other.userId, other.userId, other.userId);

    const a1 = await prisma.docActivity.create({ data: { tenantId, caseId: mine.caseId, type: 'NOTE', subject: 'mine' } });
    const a2 = await prisma.docActivity.create({ data: { tenantId, caseId: theirs.caseId, type: 'NOTE', subject: 'theirs' } });

    const res = await call('GET', '/api/v1/documentation/activities?filter=ALL', me.token);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: any) => a.id);
    expect(ids).toContain(a1.id);
    expect(ids).not.toContain(a2.id);

    // IDOR guard: cannot create an activity on a case they cannot see.
    const blocked = await call('POST', `/api/v1/documentation/cases/${theirs.caseId}/activities`, me.token,
      { type: 'NOTE', subject: 'x' });
    expect(blocked.status).toBe(404);
  });

  it('T4 — the Sales LeadActivity write path creates no DocActivity', async () => {
    const tenantId = await makeTenant();
    const sales = await makeUser(tenantId, ['lead:view', 'lead:edit']);
    const lead = await prisma.lead.create({ data: { tenantId, firstName: 'L', lastName: 'X', ownerId: sales.userId } });

    const res = await call('POST', '/api/v1/lead-activities', sales.token,
      { leadId: lead.id, type: 'FOLLOW_UP_SCHEDULED', subject: 'call back', scheduledAt: new Date().toISOString() });
    expect(res.status).toBe(201);

    expect(await prisma.docActivity.count({ where: { tenantId } })).toBe(0);
  });

  it('T5 — doc:case:view-all manager sees activities on cases they do not own', async () => {
    const tenantId = await makeTenant();
    const mgr = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all']);
    const other = await makeUser(tenantId, ['doc:view']);
    const foreign = await makeLeadCase(tenantId, other.userId, other.userId, other.userId);
    const a = await prisma.docActivity.create({ data: { tenantId, caseId: foreign.caseId, type: 'NOTE', subject: 'not mine' } });

    const res = await call('GET', '/api/v1/documentation/activities?filter=ALL', mgr.token);
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: any) => x.id)).toContain(a.id);
  });

  it('T6 — filters ALL/DUE_TODAY/UPCOMING/OVERDUE/MINE incl. UTC day boundary', async () => {
    const tenantId = await makeTenant();
    const mgr = await makeUser(tenantId, ['doc:view', 'doc:case:view-all']);
    const other = await makeUser(tenantId, ['doc:view']);
    const { caseId } = await makeLeadCase(tenantId, mgr.userId, mgr.userId, mgr.userId);

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);       // tomorrow 00:00 UTC (exclusive)
    const yesterday = new Date(todayStart.getTime() - 3_600_000);
    const future = new Date(todayEnd.getTime() + 3_600_000);

    const mk = (scheduledAt: Date | null, state: 'PENDING' | 'COMPLETED', actorUserId: string | null) =>
      prisma.docActivity.create({ data: { tenantId, caseId, type: 'FOLLOW_UP', subject: 's', state, scheduledAt, actorUserId } });

    const aToday   = await mk(todayStart, 'PENDING', mgr.userId);       // exactly UTC midnight → DUE_TODAY (gte inclusive)
    const aEnd     = await mk(todayEnd, 'PENDING', other.userId);       // exactly tomorrow 00:00 → UPCOMING (lt exclusive), NOT DUE_TODAY
    const aFuture  = await mk(future, 'PENDING', other.userId);
    const aOverdue = await mk(yesterday, 'PENDING', other.userId);
    const aDone    = await mk(todayStart, 'COMPLETED', mgr.userId);     // completed → excluded from PENDING filters

    const ids = async (filter: string) =>
      (await call('GET', `/api/v1/documentation/activities?filter=${filter}`, mgr.token)).body.data.map((x: any) => x.id);

    expect(await ids('ALL')).toEqual(expect.arrayContaining([aToday.id, aEnd.id, aFuture.id, aOverdue.id, aDone.id]));

    const due = await ids('DUE_TODAY');
    expect(due).toContain(aToday.id);
    expect(due).not.toContain(aEnd.id);     // UTC boundary: todayEnd is NOT due today
    expect(due).not.toContain(aFuture.id);
    expect(due).not.toContain(aOverdue.id);
    expect(due).not.toContain(aDone.id);    // completed excluded

    const up = await ids('UPCOMING');
    expect(up).toEqual(expect.arrayContaining([aEnd.id, aFuture.id]));
    expect(up).not.toContain(aToday.id);
    expect(up).not.toContain(aOverdue.id);

    const over = await ids('OVERDUE');
    expect(over).toContain(aOverdue.id);
    expect(over).not.toContain(aToday.id);
    expect(over).not.toContain(aFuture.id);

    const mine = await ids('MINE');         // PENDING where actor = caller
    expect(mine).toContain(aToday.id);
    expect(mine).not.toContain(aEnd.id);
    expect(mine).not.toContain(aDone.id);   // completed, even though actor=caller
  });

  it('T7 — create rejects invalid type / empty subject / invalid scheduledAt / cross-tenant case', async () => {
    const tenantId = await makeTenant();
    const doc = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all']);
    const { caseId } = await makeLeadCase(tenantId, doc.userId, doc.userId, doc.userId);

    const foreignTenant = await makeTenant();
    const fu = await makeUser(foreignTenant, ['doc:view']);
    const foreign = await makeLeadCase(foreignTenant, fu.userId, fu.userId, fu.userId);

    const base = `/api/v1/documentation/cases/${caseId}/activities`;
    expect((await call('POST', base, doc.token, { type: 'BOGUS', subject: 'x' })).status).toBe(400);
    expect((await call('POST', base, doc.token, { type: 'NOTE', subject: '   ' })).status).toBe(400);
    expect((await call('POST', base, doc.token, { type: 'NOTE', subject: 'x', scheduledAt: 'not-a-date' })).status).toBe(400);
    // Cross-tenant case id: not visible in this tenant → 404, no data.
    expect((await call('POST', `/api/v1/documentation/cases/${foreign.caseId}/activities`, doc.token, { type: 'NOTE', subject: 'x' })).status).toBe(404);
    expect(await prisma.docActivity.count({ where: { tenantId } })).toBe(0);
  });

  it('T8 — complete works, drops from PENDING filters, and 404s on an invisible activity', async () => {
    const tenantId = await makeTenant();
    const doc = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all']);
    const { caseId } = await makeLeadCase(tenantId, doc.userId, doc.userId, doc.userId);

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const act = await prisma.docActivity.create({ data: { tenantId, caseId, type: 'FOLLOW_UP', subject: 'due', state: 'PENDING', scheduledAt: todayStart, actorUserId: doc.userId } });

    const done = await call('PATCH', `/api/v1/documentation/activities/${act.id}/complete`, doc.token);
    expect(done.status).toBe(200);
    expect(done.body.data.state).toBe('COMPLETED');

    const due = (await call('GET', '/api/v1/documentation/activities?filter=DUE_TODAY', doc.token)).body.data.map((x: any) => x.id);
    expect(due).not.toContain(act.id);

    // Invisible activity: a restricted caller (no view-all) cannot complete another user's case activity.
    const restricted = await makeUser(tenantId, ['doc:view', 'doc:edit']);
    const other = await makeUser(tenantId, ['doc:view']);
    const foreign = await makeLeadCase(tenantId, other.userId, other.userId, other.userId);
    const invisible = await prisma.docActivity.create({ data: { tenantId, caseId: foreign.caseId, type: 'NOTE', subject: 'theirs', state: 'PENDING' } });
    const blocked = await call('PATCH', `/api/v1/documentation/activities/${invisible.id}/complete`, restricted.token);
    expect(blocked.status).toBe(404);
    expect((await prisma.docActivity.findUnique({ where: { id: invisible.id } }))!.state).toBe('PENDING');
  });

  it('T9 — update replaces the date in place (no new row) + persists/clears notes + IDOR 404', async () => {
    const tenantId = await makeTenant();
    const doc = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all']);
    const { caseId } = await makeLeadCase(tenantId, doc.userId, doc.userId, doc.userId);

    // Create one follow-up, then update its date 3× — the old row must be mutated, never duplicated.
    const created = await call('POST', `/api/v1/documentation/cases/${caseId}/activities`, doc.token,
      { type: 'FOLLOW_UP', subject: 'Follow-up', scheduledAt: '2026-12-01T00:00:00.000Z' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    for (const d of ['2026-12-05', '2026-12-10', '2026-12-20']) {
      const upd = await call('PATCH', `/api/v1/documentation/activities/${id}`, doc.token,
        { scheduledAt: `${d}T00:00:00.000Z`, notes: `chase on ${d}` });
      expect(upd.status).toBe(200);
      expect(upd.body.data.scheduledAt).toBe(`${d}T00:00:00.000Z`);
      expect(upd.body.data.metadata.notes).toBe(`chase on ${d}`);
    }
    // Exactly one row for this case — updates did not insert.
    expect(await prisma.docActivity.count({ where: { tenantId, caseId, deletedAt: null } })).toBe(1);
    const row = await prisma.docActivity.findUnique({ where: { id } });
    expect(row!.scheduledAt!.toISOString()).toBe('2026-12-20T00:00:00.000Z'); // latest only

    // Empty notes clears the key (no empty-note artifact).
    const cleared = await call('PATCH', `/api/v1/documentation/activities/${id}`, doc.token, { notes: '   ' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.metadata.notes).toBeUndefined();

    // Invalid date rejected.
    expect((await call('PATCH', `/api/v1/documentation/activities/${id}`, doc.token, { scheduledAt: 'nope' })).status).toBe(400);

    // IDOR: a restricted caller cannot update an activity on a case they cannot see.
    const restricted = await makeUser(tenantId, ['doc:view', 'doc:edit']);
    const other = await makeUser(tenantId, ['doc:view']);
    const foreign = await makeLeadCase(tenantId, other.userId, other.userId, other.userId);
    const invisible = await prisma.docActivity.create({ data: { tenantId, caseId: foreign.caseId, type: 'FOLLOW_UP', subject: 'x', state: 'PENDING', scheduledAt: new Date() } });
    const idor = await call('PATCH', `/api/v1/documentation/activities/${invisible.id}`, restricted.token, { scheduledAt: '2026-12-31T00:00:00.000Z' });
    expect(idor.status).toBe(404);
  });

  it('T10 — global list projects case company + contact for the row display', async () => {
    const tenantId = await makeTenant();
    const doc = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all']);
    const lead = await prisma.lead.create({ data: { tenantId, firstName: 'Asha', lastName: 'Rao', company: 'Globex Ltd', ownerId: doc.userId } });
    const docCase = await prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy: doc.userId, assignedTo: doc.userId } });
    const act = await prisma.docActivity.create({ data: { tenantId, caseId: docCase.id, type: 'FOLLOW_UP', subject: 'Follow-up', state: 'PENDING', scheduledAt: new Date() } });

    const res = await call('GET', '/api/v1/documentation/activities?filter=ALL', doc.token);
    expect(res.status).toBe(200);
    const row = res.body.data.find((x: any) => x.id === act.id);
    expect(row.case.lead.company).toBe('Globex Ltd');
    expect(row.case.lead.firstName).toBe('Asha');
  });

  it('T11 — bulk-complete completes visible PENDING, skips invisible, returns real count', async () => {
    const tenantId = await makeTenant();
    const me = await makeUser(tenantId, ['doc:view', 'doc:edit']); // no view-all
    const other = await makeUser(tenantId, ['doc:view']);
    const mine = await makeLeadCase(tenantId, me.userId, me.userId, me.userId);
    const theirs = await makeLeadCase(tenantId, other.userId, other.userId, other.userId);

    const a1 = await prisma.docActivity.create({ data: { tenantId, caseId: mine.caseId, type: 'FOLLOW_UP', subject: 's', state: 'PENDING', scheduledAt: new Date() } });
    const a2 = await prisma.docActivity.create({ data: { tenantId, caseId: mine.caseId, type: 'FOLLOW_UP', subject: 's', state: 'PENDING', scheduledAt: new Date() } });
    const invisible = await prisma.docActivity.create({ data: { tenantId, caseId: theirs.caseId, type: 'FOLLOW_UP', subject: 's', state: 'PENDING', scheduledAt: new Date() } });

    const res = await call('POST', '/api/v1/documentation/activities/bulk-complete', me.token, { ids: [a1.id, a2.id, invisible.id] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2); // invisible skipped, not counted
    expect((await prisma.docActivity.findUnique({ where: { id: a1.id } }))!.state).toBe('COMPLETED');
    expect((await prisma.docActivity.findUnique({ where: { id: a2.id } }))!.state).toBe('COMPLETED');
    expect((await prisma.docActivity.findUnique({ where: { id: invisible.id } }))!.state).toBe('PENDING'); // invisible untouched

    // Empty ids → 400.
    expect((await call('POST', '/api/v1/documentation/activities/bulk-complete', me.token, { ids: [] })).status).toBe(400);
  });

  it('T12 — complete with note writes a case note, chains next follow-up, and projects actor', async () => {
    const tenantId = await makeTenant();
    const doc = await makeUser(tenantId, ['doc:view', 'doc:edit', 'doc:case:view-all']);
    const { caseId } = await makeLeadCase(tenantId, doc.userId, doc.userId, doc.userId);
    const act = await prisma.docActivity.create({ data: { tenantId, caseId, type: 'FOLLOW_UP', subject: 'chase', state: 'PENDING', scheduledAt: new Date(), actorUserId: doc.userId } });

    const next = '2026-12-31T00:00:00.000Z';
    const done = await call('PATCH', `/api/v1/documentation/activities/${act.id}/complete`, doc.token, { note: 'client called back', nextFollowUp: next });
    expect(done.status).toBe(200);
    expect(done.body.data.state).toBe('COMPLETED');

    // Completion note surfaced as a case note (INTERNAL).
    const notes = await prisma.docCaseNote.findMany({ where: { tenantId, caseId } });
    expect(notes.map(n => n.content)).toContain('client called back');
    // Next follow-up chained as a new PENDING follow-up.
    const pend = await prisma.docActivity.findMany({ where: { tenantId, caseId, state: 'PENDING', deletedAt: null } });
    expect(pend.some(p => p.scheduledAt?.toISOString() === next)).toBe(true);

    // Actor projected on the global list for the "by {actor}" row meta.
    const list = await call('GET', '/api/v1/documentation/activities?filter=ALL', doc.token);
    const row = list.body.data.find((x: any) => x.id === act.id);
    expect(row.actor.id).toBe(doc.userId);
  });
});

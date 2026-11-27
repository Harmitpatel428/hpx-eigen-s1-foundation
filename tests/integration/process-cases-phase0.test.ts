/**
 * Process department Phase 0 — queue/detail/assign scoping (HTTP integration).
 * Real Express router + auth/permission middleware + PostgreSQL, no mocks.
 *
 * Covers:
 *   - Executive (no process:case:view-all) sees only processAssignedTo = self
 *   - Manager (process:case:view-all) sees the full tenant Process queue
 *   - Cross-tenant isolation (another tenant's cases never returned)
 *   - POST /cases/:id/assign writes ONLY processAssignedTo (status/handoff untouched)
 *   - permission denial returns 403
 *   - an out-of-scope / other-tenant / unknown id on detail returns 404
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, ProcessHandoffState, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createProcessRouter } from '../../src/routes/process.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;
const trackedTenants: string[] = [];

function uid() { return crypto.randomUUID(); }

async function req(method: 'GET' | 'POST', path: string, token?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api/v1/process${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  let json: any;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
const get = (p: string, t?: string) => req('GET', p, t);
const post = (p: string, t?: string, b?: unknown) => req('POST', p, t, b);

async function makeSession(userId: string, tenantId: string): Promise<string> {
  const sessionId = uid();
  await prisma.session.create({
    data: {
      id: sessionId, userId, tenantId, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex'),
    },
  });
  return jwt.sign({ sessionId, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

async function permId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded — run prisma migrate deploy.`);
  return p.id;
}

const pw = bcryptjs.hashSync('Password1!', 4);

async function mkUser(tenantId: string, slugs: string[]) {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { user, token: await makeSession(user.id, tenantId) };
}

async function mkCase(
  tenantId: string, createdBy: string,
  o: { status?: DocCaseStatus; processAssignedTo?: string; handoffState?: ProcessHandoffState } = {},
) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'L', lastName: uid().slice(0, 6) } });
  const c = await prisma.docCase.create({
    data: {
      tenantId, leadId: lead.id, createdBy,
      status: o.status ?? DocCaseStatus.PENDING_PROCESS_REVIEW,
      processHandoffState: o.handoffState ?? ProcessHandoffState.PENDING_REVIEW,
      processAssignedTo: o.processAssignedTo ?? null,
    },
    select: { id: true },
  });
  return c.id;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/process', createProcessRouter(prisma));
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
    await prisma.docCaseEvent.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

const idsOf = (r: { body: any }): string[] => r.body.data.cases.map((c: any) => c.id);

async function seed() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `proc-${tenantId.slice(0, 8)}` } });

  const manager = await mkUser(tenantId, ['process:view', 'process:case:view-all', 'process:assign']);
  const exec = await mkUser(tenantId, ['process:view', 'process:accept', 'process:return']);
  const exec2 = await mkUser(tenantId, ['process:view']);

  const mine = await mkCase(tenantId, manager.user.id, { processAssignedTo: exec.user.id });
  const otherAssigned = await mkCase(tenantId, manager.user.id, {
    status: DocCaseStatus.TRANSFERRED_TO_PROCESS, handoffState: ProcessHandoffState.ACCEPTED, processAssignedTo: exec2.user.id,
  });
  const unassigned = await mkCase(tenantId, manager.user.id); // PENDING, processAssignedTo = null

  // A second tenant whose cases must never leak into tenantId's queue.
  const otherTenantId = uid();
  trackedTenants.push(otherTenantId);
  await prisma.tenant.create({ data: { id: otherTenantId, name: `proc-${otherTenantId.slice(0, 8)}` } });
  const foreignAdmin = await mkUser(otherTenantId, ['process:view']);
  const foreignCase = await mkCase(otherTenantId, foreignAdmin.user.id, { processAssignedTo: foreignAdmin.user.id });

  return { tenantId, manager, exec, exec2, mine, otherAssigned, unassigned, foreignCase };
}

describe('Process Phase 0 — queue / detail / assign', () => {
  it('Executive (no view-all) sees only processAssignedTo = self', async () => {
    const s = await seed();
    const res = await get('/cases', s.exec.token);
    expect(res.status).toBe(200);
    expect(idsOf(res).sort()).toEqual([s.mine].sort());
    expect(idsOf(res)).not.toContain(s.otherAssigned);
    expect(idsOf(res)).not.toContain(s.unassigned);
  });

  it('Manager (view-all) sees the full tenant Process queue, never another tenant', async () => {
    const s = await seed();
    const res = await get('/cases', s.manager.token);
    expect(res.status).toBe(200);
    expect(idsOf(res).sort()).toEqual([s.mine, s.otherAssigned, s.unassigned].sort());
    expect(idsOf(res)).not.toContain(s.foreignCase);
  });

  it('detail: in-scope 200, out-of-scope / unknown / other-tenant → 404', async () => {
    const s = await seed();
    expect((await get(`/cases/${s.mine}`, s.exec.token)).status).toBe(200);
    // exec is not assigned otherAssigned → out of scope → 404 (not 403)
    expect((await get(`/cases/${s.otherAssigned}`, s.exec.token)).status).toBe(404);
    expect((await get(`/cases/${uid()}`, s.exec.token)).status).toBe(404);
    // foreign-tenant case id is invisible to this tenant's manager → 404
    expect((await get(`/cases/${s.foreignCase}`, s.manager.token)).status).toBe(404);
    // manager can see all three
    expect((await get(`/cases/${s.unassigned}`, s.manager.token)).status).toBe(200);
  });

  it('assign writes ONLY processAssignedTo (status + handoff state untouched), then exec sees it', async () => {
    const s = await seed();
    const before = await prisma.docCase.findUnique({ where: { id: s.unassigned } });
    const r = await post(`/cases/${s.unassigned}/assign`, s.manager.token, { assigneeUserId: s.exec.user.id });
    expect(r.status).toBe(200);

    const after = await prisma.docCase.findUnique({ where: { id: s.unassigned } });
    expect(after?.processAssignedTo).toBe(s.exec.user.id);
    expect(after?.status).toBe(before?.status);                         // unchanged
    expect(after?.processHandoffState).toBe(before?.processHandoffState); // unchanged
    expect(after?.processAcceptedAt).toBe(before?.processAcceptedAt ?? null);

    // Exec now sees the freshly-assigned case in their self-scoped queue.
    expect(idsOf(await get('/cases', s.exec.token))).toContain(s.unassigned);
  });

  it('assign rejects a non-tenant assignee (400) and a bad uuid (400)', async () => {
    const s = await seed();
    expect((await post(`/cases/${s.unassigned}/assign`, s.manager.token, { assigneeUserId: uid() })).status).toBe(400);
    expect((await post(`/cases/${s.unassigned}/assign`, s.manager.token, { assigneeUserId: 'not-a-uuid' })).status).toBe(400);
  });

  it('permission denial: no process:view → 403 on queue; no process:assign → 403 on assign', async () => {
    const s = await seed();
    const noPerms = await mkUser(s.tenantId, []);
    expect((await get('/cases', noPerms.token)).status).toBe(403);
    expect((await get('/dashboard', noPerms.token)).status).toBe(403);
    // exec has process:view but not process:assign
    expect((await post(`/cases/${s.unassigned}/assign`, s.exec.token, { assigneeUserId: s.exec.user.id })).status).toBe(403);
  });

  it('dashboard counts are view-all/self scoped', async () => {
    const s = await seed();
    const mgr = (await get('/dashboard', s.manager.token)).body.data;
    expect(mgr.incoming).toBeGreaterThanOrEqual(2);   // mine + unassigned are PENDING
    expect(mgr.processing).toBeGreaterThanOrEqual(1);  // otherAssigned is TRANSFERRED
    const ex = (await get('/dashboard', s.exec.token)).body.data;
    expect(ex.incoming).toBe(1);   // only `mine` (PENDING, assigned to exec)
    expect(ex.processing).toBe(0); // exec is assigned no TRANSFERRED case
  });
});

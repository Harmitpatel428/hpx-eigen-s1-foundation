/**
 * Acceptance test: getDashboardKPIs scoping (d5430ca).
 * Verifies that doc:case:view-all holders see the full tenant count and
 * non-holders see only the union-scope (assignedTo | processAssignedTo | lead.ownerId).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, ScopeType, UserStatus } from '@prisma/client';
import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { authMiddleware } from '../../src/middleware/auth.middleware';
import { PermissionService } from '../../src/services/permission.service';
import { makeApp, startServer, makeReq, uid } from './_shared/case-field-harness';

const prisma = new PrismaClient();
const permSvc = new PermissionService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

let server: http.Server;
let baseUrl: string;
let req: ReturnType<typeof makeReq>;

const tenantIds: string[] = [];

async function mkActor(tenantId: string, slugs: string[]): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `ds-${uid()}@test.invalid`, password: 'x', status: UserStatus.ACTIVE },
    select: { id: true },
  });
  const role = await prisma.role.create({ data: { tenantId, name: `DS-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    const p = await prisma.permission.findFirst({ where: { slug } });
    if (!p) throw new Error(`Permission '${slug}' not seeded`);
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
  }
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  const sid = uid();
  await prisma.session.create({
    data: {
      id: sid, userId: user.id, tenantId, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
      ipAddress: '127.0.0.1',
      refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex'),
    },
  });
  return { id: user.id, token: jwt.sign({ sessionId: sid, userId: user.id, tenantId }, JWT_SECRET, { expiresIn: '1h' }) };
}

async function mkCase(tenantId: string, opts: { assignedTo?: string; processAssignedTo?: string; ownerId?: string } = {}): Promise<string> {
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'T', lastName: 'L', ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) },
    select: { id: true },
  });
  const c = await prisma.docCase.create({
    data: { tenantId, leadId: lead.id, createdBy: uid(), ...(opts.assignedTo ? { assignedTo: opts.assignedTo } : {}), ...(opts.processAssignedTo ? { processAssignedTo: opts.processAssignedTo } : {}) },
    select: { id: true },
  });
  return c.id;
}

beforeAll(async () => {
  const app = makeApp([['/api/v1/documentation', createDocumentationRouter(prisma, permSvc)]]);
  ({ server, baseUrl } = await startServer(app));
  req = makeReq(baseUrl);
});

afterAll(async () => {
  server.close();
  // FK-safe cleanup in reverse dependency order
  for (const tid of tenantIds) {
    await prisma.docCase.deleteMany({ where: { tenantId: tid } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId: tid } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId: tid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId: tid } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId: tid } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId: tid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId: tid } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tid } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe('GET /documentation/dashboard — scoping', () => {
  it('admin (doc:case:view-all) sees all cases; exec sees only own-scope; foreign tenant is blocked', async () => {
    // ── Provision tenant ──────────────────────────────────────────────
    const tenantId = uid();
    tenantIds.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `DST-${tenantId.slice(0, 8)}` } });

    const admin = await mkActor(tenantId, ['doc:view', 'doc:case:view-all']);
    const exec  = await mkActor(tenantId, ['doc:view']);
    const other = await mkActor(tenantId, ['doc:view']);
    await permSvc.invalidatePermissionCache(tenantId);

    // 2 cases owned by exec (assignedTo), 1 by processAssignedTo, 1 by lead.ownerId, 3 outside exec scope
    await mkCase(tenantId, { assignedTo: exec.id });
    await mkCase(tenantId, { assignedTo: exec.id });
    await mkCase(tenantId, { processAssignedTo: exec.id });
    await mkCase(tenantId, { ownerId: exec.id });
    await mkCase(tenantId, { assignedTo: other.id });
    await mkCase(tenantId, { assignedTo: other.id });
    await mkCase(tenantId, { assignedTo: other.id });

    // ── Admin sees all 7 ─────────────────────────────────────────────
    const adminR = await req('GET', '/api/v1/documentation/dashboard', { token: admin.token });
    expect(adminR.status).toBe(200);
    const adminTotal: number = adminR.body.data.totalCases;
    expect(adminTotal).toBeGreaterThanOrEqual(7); // ≥7: other tenant data may exist in dev DB

    // ── Exec sees only union-scope 4 ─────────────────────────────────
    const execR = await req('GET', '/api/v1/documentation/dashboard', { token: exec.token });
    expect(execR.status).toBe(200);
    const execTotal: number = execR.body.data.totalCases;
    expect(execTotal).toBe(4); // exactly 4: assignedTo×2 + processAssignedTo×1 + ownerId×1

    // Admin total > exec total (not equal)
    expect(adminTotal).toBeGreaterThan(execTotal);

    // ── Foreign tenant: fresh tenant, token for tenantId2 used against tenantId ─
    const tid2 = uid();
    tenantIds.push(tid2);
    await prisma.tenant.create({ data: { id: tid2, name: `DST2-${tid2.slice(0, 8)}` } });
    const foreignActor = await mkActor(tid2, ['doc:view', 'doc:case:view-all']);
    await permSvc.invalidatePermissionCache(tid2);

    // tenantId check is embedded in the JWT — foreign token hits backend scoped to tid2
    // The dashboard returns their own tenant's data (0 cases), not tenantId's
    const foreignR = await req('GET', '/api/v1/documentation/dashboard', { token: foreignActor.token });
    expect(foreignR.status).toBe(200);
    // Foreign tenant has 0 cases — no bleed from tenantId
    expect(foreignR.body.data.totalCases).toBe(0);
  });

  it('counts update immediately after reassignment (row 3)', async () => {
    const tenantId = uid();
    tenantIds.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `DST-R3-${tenantId.slice(0, 8)}` } });

    const admin = await mkActor(tenantId, ['doc:view', 'doc:case:view-all']);
    const exec  = await mkActor(tenantId, ['doc:view']);
    const peer  = await mkActor(tenantId, ['doc:view']);
    await permSvc.invalidatePermissionCache(tenantId);

    const caseId = await mkCase(tenantId, { assignedTo: exec.id });

    // Before reassignment: exec sees 1, peer sees 0
    const before = await req('GET', '/api/v1/documentation/dashboard', { token: exec.token });
    expect(before.body.data.totalCases).toBe(1);
    const peerBefore = await req('GET', '/api/v1/documentation/dashboard', { token: peer.token });
    expect(peerBefore.body.data.totalCases).toBe(0);

    // Reassign to peer (no PATCH endpoint — service reassigns via DB; test drives DB directly)
    await prisma.docCase.update({ where: { id: caseId }, data: { assignedTo: peer.id } });

    // After reassignment: exec sees 0, peer sees 1 (immediate, no cache)
    const after = await req('GET', '/api/v1/documentation/dashboard', { token: exec.token });
    expect(after.body.data.totalCases).toBe(0);
    const peerAfter = await req('GET', '/api/v1/documentation/dashboard', { token: peer.token });
    expect(peerAfter.body.data.totalCases).toBe(1);

    // Admin still sees 1 (unchanged total)
    const adminR = await req('GET', '/api/v1/documentation/dashboard', { token: admin.token });
    expect(adminR.body.data.totalCases).toBe(1);
  });

  it('doc:case:view-all holder (manager path) gets full count', async () => {
    const tenantId = uid();
    tenantIds.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `DST3-${tenantId.slice(0, 8)}` } });

    const mgr  = await mkActor(tenantId, ['doc:view', 'doc:case:view-all']);
    const exec = await mkActor(tenantId, ['doc:view']);
    await permSvc.invalidatePermissionCache(tenantId);

    await mkCase(tenantId, { assignedTo: exec.id });
    await mkCase(tenantId, { assignedTo: exec.id });
    await mkCase(tenantId); // unassigned

    const mgrR = await req('GET', '/api/v1/documentation/dashboard', { token: mgr.token });
    expect(mgrR.status).toBe(200);
    expect(mgrR.body.data.totalCases).toBe(3);

    const execR = await req('GET', '/api/v1/documentation/dashboard', { token: exec.token });
    expect(execR.status).toBe(200);
    expect(execR.body.data.totalCases).toBe(2); // only the 2 assigned to exec
  });
});

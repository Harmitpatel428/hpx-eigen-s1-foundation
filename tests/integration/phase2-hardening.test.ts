/**
 * Phase 2 security hardening — one regression per finding.
 * Real Express routers + auth/permission middleware + PostgreSQL, no mocks
 * (except a throwing Prisma proxy to force an unexpected 500 for the err.message leak check).
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, UserStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';

import { createOpportunityTypesRouter } from '../../src/routes/opportunity-types.router';
import { createPipelineRouter } from '../../src/routes/pipeline.router';
import { createLeadTagsRouter } from '../../src/routes/lead-tags.router';
import { createLeadFieldsRouter } from '../../src/routes/lead-fields.router';
import { createDashboardRouter } from '../../src/routes/dashboard.router';
import { createInvoicesRouter } from '../../src/routes/invoices.router';
import { createPaymentsRouter } from '../../src/routes/payments.router';
import { createPortalRouter } from '../../src/routes/portal.router';
import { authMiddleware } from '../../src/middleware/auth.middleware';
import { InvitationService } from '../../src/services/invitation.service';
import { AppException, AuthorizationError } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const SECRET_DETAIL = 'pg-internal-secret-detail-xyz';

let server: http.Server;
let baseUrl: string;
const trackedTenants: string[] = [];

function uid() { return crypto.randomUUID(); }
const ipSeq = { n: crypto.randomBytes(2).readUInt16BE(0) };
function testIp(): string {
  const n = ipSeq.n++ % 65536;
  return `10.${(n >> 8) & 0xff}.${n & 0xff}.1`;
}

async function call(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': testIp(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
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

const pw = bcryptjs.hashSync('Password1!', 4);

async function mkRole(tenantId: string, slugs: string[]) {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uid().slice(0, 8)}` } });
  for (const slug of slugs) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(slug) } });
  }
  return role;
}

async function mkCaller(tenantId: string, slugs: string[], departmentId: string | null = null) {
  const role = await mkRole(tenantId, slugs);
  const user = await prisma.user.create({
    data: { id: uid(), tenantId, email: `u-${uid()}@test.invalid`, password: pw, status: UserStatus.ACTIVE, departmentId },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { user, token: await makeSession(user.id, tenantId) };
}

async function mkTenant() {
  const tenantId = uid();
  trackedTenants.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: `p2-${tenantId.slice(0, 8)}` } });
  return tenantId;
}

beforeAll(async () => {
  // Prisma proxy whose invoice/payment delegates throw an error carrying an internal detail.
  const throwingPrisma = new Proxy(prisma, {
    get(target, prop, recv) {
      if (prop === 'invoice' || prop === 'payment') throw new Error(SECRET_DETAIL);
      return Reflect.get(target, prop, recv);
    },
  }) as PrismaClient;

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/opportunity-types', createOpportunityTypesRouter(prisma));
  app.use('/api/v1/analytics/pipeline', createPipelineRouter(prisma));
  app.use('/api/v1/lead-tags', createLeadTagsRouter(prisma));
  app.use('/api/v1/lead-fields', createLeadFieldsRouter(prisma));
  app.use('/api/v1/dashboard', authMiddleware, createDashboardRouter(prisma));
  // Same router, but the caller is flagged super-admin after auth (no '*'/'admin:all' permission is seeded).
  app.use('/api/v1/dashboard-sa', authMiddleware, (req: Request, _res: Response, next: NextFunction) => {
    ((req as any).user.permissions ??= {})['*'] = { allowed: true };
    next();
  }, createDashboardRouter(prisma));
  app.use('/api/v1/invoices', createInvoicesRouter(throwingPrisma));
  app.use('/api/v1/payments', createPaymentsRouter(throwingPrisma));
  app.use('/api/v1/portal', createPortalRouter(prisma));
  // Mirrors the global handler in src/app.ts
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  });
  server = http.createServer(app);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(res => server.close(() => res()));
  for (const tenantId of trackedTenants) {
    await prisma.userInvitation.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadTag.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.leadFieldDef.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.opportunityType.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.department.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

// ─── 1. F-OPPTYPE ────────────────────────────────────────────────────────────
describe('F-OPPTYPE — reorder is tenant-scoped', () => {
  it('a reorder referencing another tenant\'s type id does not modify it', async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const caller = await mkCaller(a, ['role:manage']);
    const foreign = await prisma.opportunityType.create({ data: { tenantId: b, name: 'Foreign', displayOrder: 7 } });
    const own = await prisma.opportunityType.create({ data: { tenantId: a, name: 'Own', displayOrder: 9 } });

    const r = await call('PUT', '/api/v1/opportunity-types/reorder', caller.token, { typeIds: [foreign.id, own.id] });
    expect(r.status).toBeLessThan(500);

    expect((await prisma.opportunityType.findUnique({ where: { id: foreign.id } }))?.displayOrder).toBe(7);
    // own-tenant row is still reordered (index 1 after the skipped foreign id)
    expect((await prisma.opportunityType.findUnique({ where: { id: own.id } }))?.displayOrder).toBeLessThan(9);
  });
});

// ─── 2. Finance err.message leak ─────────────────────────────────────────────
describe('Finance routes do not leak err.message', () => {
  it('GET /invoices unexpected error -> generic body, no error field', async () => {
    const t = await mkTenant();
    const c = await mkCaller(t, ['invoice:view']);
    const r = await call('GET', '/api/v1/invoices', c.token);
    expect(r.status).toBe(500);
    expect(r.body.error).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(SECRET_DETAIL);
    expect(r.body.code).toBe('INTERNAL_ERROR');
  });

  it('POST /invoices unexpected error -> generic body, no error field', async () => {
    const t = await mkTenant();
    const c = await mkCaller(t, ['invoice:create']);
    const r = await call('POST', '/api/v1/invoices', c.token, { opportunityId: uid(), amount: 10 });
    expect(r.status).toBe(404); // AppException keeps its own status via next(err)
    expect(r.body.error).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(SECRET_DETAIL);
  });

  it('GET /payments unexpected error -> generic body, no error field', async () => {
    const t = await mkTenant();
    const c = await mkCaller(t, ['payment:view']);
    const r = await call('GET', '/api/v1/payments', c.token);
    expect(r.status).toBe(500);
    expect(r.body.error).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(SECRET_DETAIL);
  });

  it('POST /payments unexpected error -> generic body, no error field', async () => {
    const t = await mkTenant();
    const c = await mkCaller(t, ['payment:create']);
    const r = await call('POST', '/api/v1/payments', c.token, { invoiceId: uid(), amount: 10, method: 'CASH' });
    expect(r.status).toBe(500);
    expect(r.body.error).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(SECRET_DETAIL);
  });
});

// ─── 3. Pipeline guard ───────────────────────────────────────────────────────
describe('Pipeline routes require opportunity:view', () => {
  const paths = [
    '/analytics', '/stage/QUALIFICATION', '/velocity',
    `/opportunities/${uid()}/history`, `/opportunities/${uid()}/current-stage`, `/opportunities/${uid()}/predict-close`,
  ];

  it('403 without opportunity:view on every route', async () => {
    const t = await mkTenant();
    const c = await mkCaller(t, ['lead:view']);
    for (const p of paths) {
      expect((await call('GET', `/api/v1/analytics/pipeline${p}`, c.token)).status).toBe(403);
    }
  });

  it('200 with opportunity:view on /analytics, /velocity and /stage', async () => {
    const t = await mkTenant();
    const c = await mkCaller(t, ['opportunity:view']);
    for (const p of ['/analytics', '/velocity', '/stage/QUALIFICATION']) {
      expect((await call('GET', `/api/v1/analytics/pipeline${p}`, c.token)).status).toBe(200);
    }
  });
});

// ─── 4. lead-tags / lead-fields mutations ────────────────────────────────────
describe('lead-tags / lead-fields mutations require lead:edit', () => {
  it('lead-tags: 403 without lead:edit on POST and DELETE; allowed with it', async () => {
    const t = await mkTenant();
    const noEdit = await mkCaller(t, ['lead:view']);
    const editor = await mkCaller(t, ['lead:view', 'lead:edit']);
    expect((await call('POST', '/api/v1/lead-tags', noEdit.token, { name: 'hot' })).status).toBe(403);
    const created = await call('POST', '/api/v1/lead-tags', editor.token, { name: 'hot' });
    expect(created.status).toBe(201);
    expect((await call('DELETE', `/api/v1/lead-tags/${created.body.data.id}`, noEdit.token)).status).toBe(403);
    expect((await call('DELETE', `/api/v1/lead-tags/${created.body.data.id}`, editor.token)).status).toBe(204);
  });

  it('lead-fields: 403 without lead:edit on POST, PATCH and DELETE; allowed with it', async () => {
    const t = await mkTenant();
    const noEdit = await mkCaller(t, ['lead:view']);
    const editor = await mkCaller(t, ['lead:view', 'lead:edit']);
    expect((await call('POST', '/api/v1/lead-fields', noEdit.token, { name: 'Budget', type: 'number' })).status).toBe(403);
    const created = await call('POST', '/api/v1/lead-fields', editor.token, { name: 'Budget', type: 'number' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await call('PATCH', `/api/v1/lead-fields/${id}`, noEdit.token, { required: true })).status).toBe(403);
    expect((await call('DELETE', `/api/v1/lead-fields/${id}`, noEdit.token)).status).toBe(403);
    expect((await call('DELETE', `/api/v1/lead-fields/${id}`, editor.token)).status).toBe(200);
  });
});

// ─── 5. dashboard /metrics ───────────────────────────────────────────────────
describe('dashboard /metrics requires the department-appropriate view permission', () => {
  it('Sales dashboard: 403 without opportunity:view, 200 with it', async () => {
    const t = await mkTenant();
    const dept = await prisma.department.create({ data: { tenantId: t, name: 'Sales' } });
    const noView = await mkCaller(t, ['lead:view'], dept.id);
    const withView = await mkCaller(t, ['opportunity:view'], dept.id);
    const h = { 'x-department-id': dept.id };
    expect((await call('GET', '/api/v1/dashboard/metrics', noView.token, undefined, h)).status).toBe(403);
    expect((await call('GET', '/api/v1/dashboard/metrics', withView.token, undefined, h)).status).toBe(200);
  });

  it('cross-department gate: null-department non-admin is 403 (never skips the check); own dept 200; super-admin any dept 200', async () => {
    const t = await mkTenant();
    const deptA = await prisma.department.create({ data: { tenantId: t, name: 'Sales' } });
    const deptB = await prisma.department.create({ data: { tenantId: t, name: 'Sales East' } });
    const noDept = await mkCaller(t, ['opportunity:view'], null);
    const inA = await mkCaller(t, ['opportunity:view'], deptA.id);
    const hA = { 'x-department-id': deptA.id };
    const hB = { 'x-department-id': deptB.id };
    expect((await call('GET', '/api/v1/dashboard/metrics', noDept.token, undefined, hA)).status).toBe(403);
    expect((await call('GET', '/api/v1/dashboard/metrics', inA.token, undefined, hA)).status).toBe(200);
    expect((await call('GET', '/api/v1/dashboard/metrics', inA.token, undefined, hB)).status).toBe(403);
    expect((await call('GET', '/api/v1/dashboard-sa/metrics', noDept.token, undefined, hB)).status).toBe(200);
  });

  it('Process dashboard needs process:view; Documentation dashboard needs doc:view', async () => {
    const t = await mkTenant();
    const proc = await prisma.department.create({ data: { tenantId: t, name: 'Process' } });
    const doc = await prisma.department.create({ data: { tenantId: t, name: 'Documentation' } });
    // Each caller sits in the department they request, so the 403s below are the permission gate, not the dept gate.
    const salesOnlyProc = await mkCaller(t, ['opportunity:view'], proc.id);
    const salesOnlyDoc = await mkCaller(t, ['opportunity:view'], doc.id);
    const procUser = await mkCaller(t, ['process:view'], proc.id);
    const docUser = await mkCaller(t, ['doc:view'], doc.id);
    expect((await call('GET', '/api/v1/dashboard/metrics', salesOnlyProc.token, undefined, { 'x-department-id': proc.id })).status).toBe(403);
    expect((await call('GET', '/api/v1/dashboard/metrics', procUser.token, undefined, { 'x-department-id': proc.id })).status).toBe(200);
    expect((await call('GET', '/api/v1/dashboard/metrics', salesOnlyDoc.token, undefined, { 'x-department-id': doc.id })).status).toBe(403);
    expect((await call('GET', '/api/v1/dashboard/metrics', docUser.token, undefined, { 'x-department-id': doc.id })).status).toBe(200);
  });
});

// ─── 6. F-PORTAL ─────────────────────────────────────────────────────────────
describe('F-PORTAL — /verify input validation', () => {
  it('no body -> 400, not 500', async () => {
    const r = await call('POST', '/api/v1/portal/verify');
    expect(r.status).toBe(400);
  });

  it('empty caseNumber -> 400', async () => {
    expect((await call('POST', '/api/v1/portal/verify', undefined, { caseNumber: '', phoneLast4: '1234' })).status).toBe(400);
  });

  it('non-4-digit phoneLast4 -> 400', async () => {
    for (const phoneLast4 of ['12', '12345', 'abcd', 1234, null]) {
      expect((await call('POST', '/api/v1/portal/verify', undefined, { caseNumber: 'CASE-1', phoneLast4 })).status).toBe(400);
    }
  });

  it('well-formed but unknown case still returns the uniform failure (not 400/500)', async () => {
    const r = await call('POST', '/api/v1/portal/verify', undefined, { caseNumber: 'HPX-2026-000001', phoneLast4: '1234' });
    expect([401, 404, 429]).toContain(r.status);
  });
});

// ─── 7. Invite privilege escalation ──────────────────────────────────────────
describe('Invite cannot grant a role broader than the inviter\'s own permissions', () => {
  const svc = new InvitationService(prisma);

  it('inviter with user:manage+user:view cannot invite into a role holding role:manage', async () => {
    const t = await mkTenant();
    const inviter = await mkCaller(t, ['user:manage', 'user:view']);
    const superior = await mkRole(t, ['user:manage', 'role:manage']);
    await expect(svc.createInvitation(t, `x-${uid()}@test.invalid`, superior.id, inviter.user.id))
      .rejects.toBeInstanceOf(AuthorizationError);
    expect(await prisma.userInvitation.count({ where: { tenantId: t } })).toBe(0);
  });

  it('inviter can invite into an equal or narrower role', async () => {
    const t = await mkTenant();
    const inviter = await mkCaller(t, ['user:manage', 'user:view']);
    const narrower = await mkRole(t, ['user:view']);
    const equal = await mkRole(t, ['user:manage', 'user:view']);
    const r1 = await svc.createInvitation(t, `x-${uid()}@test.invalid`, narrower.id, inviter.user.id);
    const r2 = await svc.createInvitation(t, `x-${uid()}@test.invalid`, equal.id, inviter.user.id);
    expect(r1.invitationId).toBeTruthy();
    expect(r2.invitationId).toBeTruthy();
  });
});

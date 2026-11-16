/**
 * GET /api/v1/portal/preview/:caseNumber — staff client-portal preview.
 * Real Postgres + the real portal router. Pins: resolution BY CASE NUMBER (not UUID), the authz matrix, and
 * that a not-yet-activated case still renders content (portalActive:false) instead of erroring. The client
 * last-4 flow (/portal/verify + /portal/case) stays session-gated and is covered by portal-verify.test.ts.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, DocCaseStatus, DocDocumentStatus } from '@prisma/client';

import { createPortalRouter } from '../../src/routes/portal.router';
import { generateCaseNumber } from '../../src/domain/caseNumber';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const uid = () => crypto.randomUUID();
const BASE = '/api/v1/portal';

let server: http.Server; let baseUrl: string;
let tenantId: string; let otherTenantId: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, createPortalRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: String(err) });
  });
  return app;
}
async function makeUser(tId: string) {
  return prisma.user.create({ data: { id: uid(), tenantId: tId, email: `pp-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
}
async function makeSession(userId: string, tId: string) {
  const sid = uid();
  await prisma.session.create({ data: { id: sid, userId, tenantId: tId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  return jwt.sign({ sessionId: sid, userId, tenantId: tId }, JWT_SECRET, { expiresIn: '1h' });
}
async function permId(slug: string) { const p = await prisma.permission.findFirst({ where: { slug } }); if (!p) throw new Error(`${slug} not seeded`); return p.id; }
async function grant(tId: string, slugs: string[]) {
  const user = await makeUser(tId);
  const role = await prisma.role.create({ data: { tenantId: tId, name: `R-${uid().slice(0, 8)}` } });
  for (const s of slugs) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(s) } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { id: user.id, token: await makeSession(user.id, tId) };
}
async function makeCase(tId: string, opts: { active: boolean; company?: string } = { active: true }) {
  const lead = await prisma.lead.create({ data: { tenantId: tId, firstName: 'Prev', lastName: 'Client', company: opts.company ?? 'Preview Co', email: `pp-${uid()}@test.invalid` } });
  const caseNumber = generateCaseNumber();
  const c = await prisma.docCase.create({ data: {
    tenantId: tId, leadId: lead.id, caseNumber, status: DocCaseStatus.DOCUMENTATION_READY, createdBy: uid(),
    portalEnabledAt: opts.active ? new Date() : null,
    portalPhoneLast4: opts.active ? '1234' : null,
  }, select: { id: true, caseNumber: true } });
  return c;
}
async function get(caseNumber: string, token?: string) {
  const res = await fetch(`${baseUrl}${BASE}/preview/${encodeURIComponent(caseNumber)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid();
  await prisma.tenant.create({ data: { id: tenantId, name: 'PP Tenant' } });
  await prisma.tenant.create({ data: { id: otherTenantId, name: 'PP Other Tenant' } });
  const app = makeApp();
  await new Promise<void>(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r(); }); });
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  for (const t of [tenantId, otherTenantId]) {
    const users = await prisma.user.findMany({ where: { tenantId: t }, select: { id: true } });
    const roles = await prisma.role.findMany({ where: { tenantId: t }, select: { id: true } });
    await prisma.docCaseDocument.deleteMany({ where: { tenantId: t } });
    await prisma.docCaseNote.deleteMany({ where: { tenantId: t } });
    await prisma.docCase.deleteMany({ where: { tenantId: t } });
    await prisma.lead.deleteMany({ where: { tenantId: t } });
    await prisma.auditLog.deleteMany({ where: { tenantId: t } });
    await prisma.userRole.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map(r => r.id) } } });
    await prisma.session.deleteMany({ where: { tenantId: t } });
    await prisma.role.deleteMany({ where: { tenantId: t } });
    await prisma.user.deleteMany({ where: { tenantId: t } });
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

describe('portal preview authz', () => {
  it('401 without a token', async () => {
    const c = await makeCase(tenantId, { active: true });
    expect((await get(c.caseNumber!)).status).toBe(401);
  });
  it('401 for a non-staff (client/opaque) token', async () => {
    const c = await makeCase(tenantId, { active: true });
    expect((await get(c.caseNumber!, 'not-a-staff-jwt.opaque.portal.token')).status).toBe(401);
  });
  it('403 for a staff token lacking portal:preview', async () => {
    const u = await grant(tenantId, ['portal:view']);
    const c = await makeCase(tenantId, { active: true });
    expect((await get(c.caseNumber!, u.token)).status).toBe(403);
  });
  it('404 for an unknown case number', async () => {
    const u = await grant(tenantId, ['portal:preview']);
    expect((await get('HPX-ZZZZ-ZZZZ', u.token)).status).toBe(404);
  });
  it('404 for another tenant\'s case (cross-tenant isolation)', async () => {
    const u = await grant(tenantId, ['portal:preview']);
    const c = await makeCase(otherTenantId, { active: true });
    expect((await get(c.caseNumber!, u.token)).status).toBe(404);
  });
});

describe('portal preview rendering', () => {
  it('ROOT CAUSE: resolves by CASE NUMBER and returns the case data (was 500 on UUID parse)', async () => {
    const u = await grant(tenantId, ['portal:preview']);
    const c = await makeCase(tenantId, { active: true, company: 'Resolve By Number Ltd' });
    const r = await get(c.caseNumber!, u.token);
    expect(r.status).toBe(200);
    expect(r.body.data.caseNumber).toBe(c.caseNumber);
    expect(r.body.data.company).toBe('Resolve By Number Ltd');
    expect(r.body.data.isPreview).toBe(true);
    expect(r.body.data.portalActive).toBe(true);
  });

  it('renders content for a NOT-yet-activated case with portalActive:false (no activation gate in preview)', async () => {
    const u = await grant(tenantId, ['portal:preview']);
    const c = await makeCase(tenantId, { active: false });
    await prisma.docCaseDocument.create({ data: { tenantId, caseId: c.id, name: 'KYC', status: DocDocumentStatus.RECEIVED, clientVisible: true, receivedAt: new Date() } });
    await prisma.docCaseNote.create({ data: { tenantId, caseId: c.id, content: 'Visible update', clientVisible: true, createdBy: uid() } });

    const r = await get(c.caseNumber!, u.token);
    expect(r.status).toBe(200);
    expect(r.body.data.portalActive).toBe(false);          // staff sees the "not yet activated" signal
    expect(r.body.data.caseNumber).toBe(c.caseNumber);
    expect(r.body.data.documents).toHaveLength(1);          // content still renders
    expect(r.body.data.notes).toHaveLength(1);
  });
});

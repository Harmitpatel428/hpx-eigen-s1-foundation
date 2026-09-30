/**
 * Race-safe case recalculation guard (Phase 1, Task B) — integration tests.
 *
 * Covers DocumentationService#_recalcAndUpdateCase, exercised indirectly through
 * PATCH /api/v1/documentation/documents/:id/status, for all 8 DocCaseStatus values:
 *  - ACTIVE / DOCUMENTATION_READY (RECALC_MUTABLE)      → status + progress recomputed
 *  - INCOMING / RETURNED / TRANSFERRED_TO_PROCESS       → progress-only, status frozen
 *  - CLOSED / CANCELLED / CLOSED_NO_DOCS (TERMINAL)      → no writes at all
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, DocDocumentStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();
const USER_ID   = crypto.randomUUID();
let editToken: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[documentation-recalc-guard-test] Unhandled error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

async function makeSession(userId: string, tenantId: string): Promise<string> {
  const session = await prisma.session.create({
    data: {
      tenantId, userId, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return jwt.sign({ userId, tenantId, sessionId: session.id }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function createCase(tenantId = TENANT_ID, status: DocCaseStatus = DocCaseStatus.ACTIVE) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'Recalc', lastName: 'Guard', email: `rg-${crypto.randomUUID()}@example.com` } });
  return prisma.docCase.create({
    data: { tenantId, leadId: lead.id, caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, status, createdBy: USER_ID },
  });
}

async function createRequirement(caseId: string, tenantId = TENANT_ID, status: DocDocumentStatus = DocDocumentStatus.PENDING_COLLECTION, isMandatory = true) {
  return prisma.docCaseDocument.create({ data: { tenantId, caseId, name: 'PAN Card', status, isMandatory } });
}

const authHeaders = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const patchStatus = (documentId: string, token: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}/api/v1/documentation/documents/${documentId}/status`, { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function grant(roleId: string, slug: string) {
  const perm = await prisma.permission.findFirst({ where: { slug } });
  if (!perm) throw new Error(`permission ${slug} not seeded — run prisma migrate deploy`);
  await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
}

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Recalc Guard Tenant' } });
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.create({ data: { id: USER_ID, email: `rg-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID } });

  const editRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'RG Editor', isSystem: true } });
  await grant(editRole.id, 'doc:edit');
  await prisma.userRole.create({ data: { userId: USER_ID, roleId: editRole.id, scopeType: ScopeType.ORGANIZATION } });
  editToken = await makeSession(USER_ID, TENANT_ID);

  server = makeTestApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: TENANT_ID } } });
  await prisma.docCase.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: TENANT_ID } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: TENANT_ID } } });
  await prisma.role.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.session.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
}, 30_000);

describe('POST /documentation/cases (tx visibility regression)', () => {
  it('creates a case and returns it (no 404 rollback)', async () => {
    const lead = await prisma.lead.create({ data: { tenantId: TENANT_ID, firstName: 'Cr', lastName: 'Ok', email: `cr-${crypto.randomUUID()}@example.com` } });
    const createToken = await (async () => {
      const role = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'RG Creator' } });
      await grant(role.id, 'doc:create');
      await prisma.userRole.create({ data: { userId: USER_ID, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
      return makeSession(USER_ID, TENANT_ID);
    })();
    const res = await fetch(`${baseUrl}/api/v1/documentation/cases`, { method: 'POST', headers: authHeaders(createToken), body: JSON.stringify({ leadId: lead.id }) });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.data.leadId).toBe(lead.id);
    expect(await prisma.docCase.count({ where: { tenantId: TENANT_ID, leadId: lead.id } })).toBe(1);
  });
});

describe('Case recalc guard — RECALC_MUTABLE statuses', () => {
  it('1a. ACTIVE stays ACTIVE when not yet ready, progress updated', async () => {
    const c = await createCase(TENANT_ID, 'ACTIVE');
    const req = await createRequirement(c.id, TENANT_ID, 'PENDING_COLLECTION', true);

    const res = await patchStatus(req.id, editToken, { status: 'RECEIVED' });
    expect(res.status).toBe(200);

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.receivedDocs).toBe(1);
    expect(updated.mandatoryApproved).toBe(0);
    expect(updated.isReady).toBe(false);
  });

  it('1b. ACTIVE moves to DOCUMENTATION_READY once all mandatory requirements are ready', async () => {
    const c = await createCase(TENANT_ID, 'ACTIVE');
    const req = await createRequirement(c.id, TENANT_ID, 'PENDING_COLLECTION', true);

    const res = await patchStatus(req.id, editToken, { status: 'WAIVED', waivedReason: 'not needed' });
    expect(res.status).toBe(200);

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.status).toBe('DOCUMENTATION_READY');
    expect(updated.isReady).toBe(true);
    expect(updated.mandatoryApproved).toBe(1);
  });

  it('2. DOCUMENTATION_READY regresses to ACTIVE when a requirement is no longer ready', async () => {
    const c = await createCase(TENANT_ID, 'DOCUMENTATION_READY');
    await createRequirement(c.id, TENANT_ID, 'APPROVED', true);
    const req2 = await createRequirement(c.id, TENANT_ID, 'UNDER_VERIFICATION', true);

    const res = await patchStatus(req2.id, editToken, { status: 'REJECTED', rejectionReason: 'incomplete' });
    expect(res.status).toBe(200);

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.isReady).toBe(false);
    expect(updated.mandatoryDocs).toBe(2);
    expect(updated.mandatoryApproved).toBe(1);
  });
});

describe('Case recalc guard — PROTECTED_NON_TERMINAL statuses (progress-only)', () => {
  it.each<[string, DocCaseStatus]>([
    ['INCOMING', 'INCOMING'],
    ['RETURNED', 'RETURNED'],
    ['TRANSFERRED_TO_PROCESS', 'TRANSFERRED_TO_PROCESS'],
  ])('3-5. %s → status unchanged, progress counters refreshed', async (_label, status) => {
    const c = await createCase(TENANT_ID, status);
    const req = await createRequirement(c.id, TENANT_ID, 'PENDING_COLLECTION', true);

    const res = await patchStatus(req.id, editToken, { status: 'RECEIVED' });
    expect(res.status).toBe(200);

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.status).toBe(status);
    expect(updated.receivedDocs).toBe(1);
    expect(updated.totalDocs).toBe(1);
  });
});

describe('Case recalc guard — TERMINAL statuses (no writes at all)', () => {
  it.each<[string, DocCaseStatus]>([
    ['CLOSED', 'CLOSED'],
    ['CANCELLED', 'CANCELLED'],
    ['CLOSED_NO_DOCS', 'CLOSED_NO_DOCS'],
  ])('6-8. %s → status AND progress left untouched', async (_label, status) => {
    const c = await createCase(TENANT_ID, status);
    const req = await createRequirement(c.id, TENANT_ID, 'PENDING_COLLECTION', true);
    const before = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });

    const res = await patchStatus(req.id, editToken, { status: 'RECEIVED' });
    expect(res.status).toBe(200);

    const after = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe(status);
    expect(after.totalDocs).toBe(before.totalDocs);
    expect(after.receivedDocs).toBe(before.receivedDocs);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

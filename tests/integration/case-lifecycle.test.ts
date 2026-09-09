/**
 * Case lifecycle (close/reopen) — integration tests.
 *
 * Tests POST /cases/:caseId/close-no-docs and POST /cases/:caseId/reopen
 * against real PostgreSQL. Each test creates its own Lead + DocCase because
 * DocCase has @@unique([tenantId, leadId]).
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createCasesRouter } from '../../src/routes/handoff.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

const TENANT_ID       = crypto.randomUUID();
const USER_ID         = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const OTHER_USER_ID   = crypto.randomUUID();

let jwtToken: string;
let noCloseToken: string;   // has cases:reopen but NOT cases:close
let noReopenToken: string;  // has cases:close but NOT cases:reopen
let noPermsToken: string;   // no lifecycle permissions at all

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cases', createCasesRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[case-lifecycle-test] Unhandled error:', detail);
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

async function seedTestData() {
  await prisma.tenant.createMany({
    data: [
      { id: TENANT_ID, name: 'Lifecycle Test Tenant' },
      { id: OTHER_TENANT_ID, name: 'Other Lifecycle Tenant' },
    ],
  });

  const pw = await bcrypt.hash('TestPass123!', 12);
  const extraIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await prisma.user.createMany({
    data: [
      { id: USER_ID, email: `lifecycle-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: OTHER_USER_ID, email: `other-lc-${OTHER_TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: OTHER_TENANT_ID },
      { id: extraIds[0], email: `noc-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: extraIds[1], email: `nor-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: extraIds[2], email: `nop-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
    ],
  });

  const [closePerm, reopenPerm] = await Promise.all([
    prisma.permission.findFirst({ where: { slug: 'cases:close' } }),
    prisma.permission.findFirst({ where: { slug: 'cases:reopen' } }),
  ]);
  if (!closePerm) throw new Error('cases:close permission not seeded — run prisma migrate deploy');
  if (!reopenPerm) throw new Error('cases:reopen permission not seeded — run prisma migrate deploy');

  // Full admin role (both close + reopen)
  const adminRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'LC Admin', isSystem: true } });
  await prisma.rolePermission.createMany({
    data: [
      { roleId: adminRole.id, permissionId: closePerm.id },
      { roleId: adminRole.id, permissionId: reopenPerm.id },
    ],
  });
  await prisma.userRole.create({ data: { userId: USER_ID, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION } });
  jwtToken = await makeSession(USER_ID, TENANT_ID);

  // noClose role: reopen only
  const noCloseRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'LC NoClose', isSystem: false } });
  await prisma.rolePermission.create({ data: { roleId: noCloseRole.id, permissionId: reopenPerm.id } });
  await prisma.userRole.create({ data: { userId: extraIds[0], roleId: noCloseRole.id, scopeType: ScopeType.ORGANIZATION } });
  noCloseToken = await makeSession(extraIds[0], TENANT_ID);

  // noReopen role: close only
  const noReopenRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'LC NoReopen', isSystem: false } });
  await prisma.rolePermission.create({ data: { roleId: noReopenRole.id, permissionId: closePerm.id } });
  await prisma.userRole.create({ data: { userId: extraIds[1], roleId: noReopenRole.id, scopeType: ScopeType.ORGANIZATION } });
  noReopenToken = await makeSession(extraIds[1], TENANT_ID);

  // noPerms role: no permissions
  const noPermsRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'LC NoPerms', isSystem: false } });
  await prisma.userRole.create({ data: { userId: extraIds[2], roleId: noPermsRole.id, scopeType: ScopeType.ORGANIZATION } });
  noPermsToken = await makeSession(extraIds[2], TENANT_ID);
}

type CaseOpts = { status?: DocCaseStatus; caseNumber?: string | null; portalEnabledAt?: Date | null; tenantId?: string };

async function createCase(opts: CaseOpts = {}) {
  const tenantId = opts.tenantId ?? TENANT_ID;
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'LC', lastName: 'Test', email: `lc-${crypto.randomUUID()}@example.com` },
  });
  const cn = opts.caseNumber !== undefined
    ? opts.caseNumber
    : `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  return prisma.docCase.create({
    data: {
      tenantId,
      leadId: lead.id,
      caseNumber: cn,
      status: opts.status ?? DocCaseStatus.ACTIVE,
      portalEnabledAt: opts.portalEnabledAt ?? null,
      createdBy: USER_ID,
    },
  });
}

async function postClose(caseId: string, reason: string, token?: string) {
  const res = await fetch(`${baseUrl}/api/v1/cases/${caseId}/close-no-docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ reason }),
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function postReopen(caseId: string, token?: string) {
  const res = await fetch(`${baseUrl}/api/v1/cases/${caseId}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function cleanupTestData() {
  await prisma.portalSession.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.docCaseNote.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  const cases = await prisma.docCase.findMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } }, select: { leadId: true } });
  await prisma.docCase.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.lead.deleteMany({ where: { id: { in: cases.map(c => c.leadId) } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.session.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
}

beforeAll(async () => {
  await seedTestData();
  const app = makeTestApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTestData();
  await prisma.$disconnect();
});

describe('POST /cases/:caseId/close-no-docs', () => {
  it('6. INCOMING → CLOSED_NO_DOCS, fields set, audit event written', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    const r = await postClose(c.id, 'CLIENT_UNRESPONSIVE', jwtToken);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('CLOSED_NO_DOCS');
    expect(r.body.data.closedReason).toBe('CLIENT_UNRESPONSIVE');
    expect(r.body.data.closedAt).toBeTruthy();

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.status).toBe('CLOSED_NO_DOCS');
    expect(updated.closedReason).toBe('CLIENT_UNRESPONSIVE');
    expect(updated.closedByUserId).toBe(USER_ID);
    expect(updated.closedAt).toBeTruthy();

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'CASE_CLOSED_NO_DOCS' },
    });
    expect(audits).toHaveLength(1);
  });

  it('7. ACTIVE → CLOSED_NO_DOCS', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const r = await postClose(c.id, 'CLIENT_FAILED_DOCS', jwtToken);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('CLOSED_NO_DOCS');
  });

  it('8. DOCUMENTATION_READY → 422', async () => {
    const c = await createCase({ status: DocCaseStatus.DOCUMENTATION_READY });
    const r = await postClose(c.id, 'FIRM_DECISION', jwtToken);
    expect(r.status).toBe(422);
  });

  it('9. idempotent — second close returns current state, no duplicate audit', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    const r1 = await postClose(c.id, 'DUPLICATE_CASE', jwtToken);
    expect(r1.status).toBe(200);
    const r2 = await postClose(c.id, 'CLIENT_FAILED_DOCS', jwtToken);
    expect(r2.status).toBe(200);
    // closedReason preserved from first close, not overwritten
    expect(r2.body.data.closedReason).toBe('DUPLICATE_CASE');

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'CASE_CLOSED_NO_DOCS' },
    });
    expect(audits).toHaveLength(1);
  });

  it('10. portal active → deactivated on close, sessions revoked', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE, portalEnabledAt: new Date() });
    // Create a live portal session
    await prisma.portalSession.create({
      data: {
        tenantId: TENANT_ID, caseId: c.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const r = await postClose(c.id, 'FIRM_DECISION', jwtToken);
    expect(r.status).toBe(200);

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.portalEnabledAt).toBeNull();

    const sessions = await prisma.portalSession.findMany({
      where: { caseId: c.id, revokedAt: null },
    });
    expect(sessions).toHaveLength(0);
  });

  it('11. missing cases:close permission → 403', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const r = await postClose(c.id, 'CLIENT_FAILED_DOCS', noCloseToken);
    expect(r.status).toBe(403);
  });
});

describe('POST /cases/:caseId/reopen', () => {
  it('12. CLOSED_NO_DOCS → INCOMING, caseNumber preserved, audit written', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    await postClose(c.id, 'CLIENT_UNRESPONSIVE', jwtToken);

    const r = await postReopen(c.id, jwtToken);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('INCOMING');
    expect(r.body.data.caseNumber).toBe(c.caseNumber);
    expect(r.body.data.reopenedAt).toBeTruthy();

    const updated = await prisma.docCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(updated.status).toBe('INCOMING');
    expect(updated.caseNumber).toBe(c.caseNumber);
    expect(updated.closedAt).toBeNull();
    expect(updated.closedReason).toBeNull();
    expect(updated.reopenedByUserId).toBe(USER_ID);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'CASE_REOPENED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('13. ACTIVE (non-closed) → 422', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const r = await postReopen(c.id, jwtToken);
    expect(r.status).toBe(422);
  });

  it('14. missing cases:reopen permission → 403', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    await postClose(c.id, 'CLIENT_FAILED_DOCS', jwtToken);
    const r = await postReopen(c.id, noReopenToken);
    expect(r.status).toBe(403);
  });

  it('15. close+reopen cycle: caseNumber identical before and after', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const originalCaseNumber = c.caseNumber;
    await postClose(c.id, 'DUPLICATE_CASE', jwtToken);
    const r = await postReopen(c.id, jwtToken);
    expect(r.status).toBe(200);
    expect(r.body.data.caseNumber).toBe(originalCaseNumber);
  });

  it('16. concurrent close: one closes, one idempotent, exactly one audit event', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const results = await Promise.all([
      postClose(c.id, 'CLIENT_FAILED_DOCS', jwtToken),
      postClose(c.id, 'CLIENT_FAILED_DOCS', jwtToken),
    ]);
    for (const r of results) expect(r.status).toBe(200);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'CASE_CLOSED_NO_DOCS' },
    });
    expect(audits).toHaveLength(1);
  });
});

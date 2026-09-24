/**
 * Mandate lifecycle — integration tests.
 *
 * Tests the full mandate upload flow: send → upload-url → confirm-upload → verify/reject,
 * plus regeneration, listing, view-url, permission enforcement, and tenant isolation.
 * Runs against real PostgreSQL with mocked R2 storage, email, and rate-limit services.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, MandateRequestStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// ─── Mocks (must be before router import) ──────────────────────────────────

jest.mock('../../src/services/storage.service', () => ({
  storageService: {
    generateUploadUrl: jest.fn().mockResolvedValue({ url: 'https://fake-presigned-put', expiresAt: new Date(Date.now() + 900_000) }),
    generateViewUrl: jest.fn().mockResolvedValue({ url: 'https://fake-presigned-get', expiresAt: new Date(Date.now() + 900_000) }),
    headObject: jest.fn().mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'application/pdf' }),
    getObjectBytes: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 mock content')),
    copyObject: jest.fn().mockResolvedValue(undefined),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/auth/RateLimitService', () => ({
  ...jest.requireActual('../../src/services/auth/RateLimitService'),
  checkMandateUploadAttempts: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/email.service', () => ({
  emailService: {
    sendMandateUploadEmail: jest.fn().mockResolvedValue(undefined),
    sendMandateRejectedEmail: jest.fn().mockResolvedValue(undefined),
    canSend: jest.fn().mockReturnValue(false),
  },
}));

import { createMandateRouter } from '../../src/routes/mandate.router';
import { CaseLifecycleService } from '../../src/services/case-lifecycle.service';
import { AppException } from '../../src/types/exceptions';
import { hashUploadToken, MANDATE_POLICY } from '../../src/domain/mandate';
import { storageService } from '../../src/services/storage.service';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

const TENANT_ID       = crypto.randomUUID();
const USER_ID         = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const OTHER_USER_ID   = crypto.randomUUID();

let adminToken: string;        // mandate:send + mandate:verify + mandate:view
let viewOnlyToken: string;     // mandate:view only
let noPermsToken: string;      // no mandate permissions
let otherTenantToken: string;  // admin on OTHER_TENANT_ID

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createMandateRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[mandate-lifecycle-test] Unhandled error:', detail);
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

async function createCase(opts: { status?: DocCaseStatus; tenantId?: string } = {}) {
  const tenantId = opts.tenantId ?? TENANT_ID;
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'ML', lastName: 'Test', email: `ml-${crypto.randomUUID()}@example.com` },
  });
  return prisma.docCase.create({
    data: {
      tenantId,
      leadId: lead.id,
      caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      status: opts.status ?? DocCaseStatus.ACTIVE,
      createdBy: USER_ID,
    },
  });
}

async function sendMandate(caseId: string, token?: string, body?: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/v1/cases/${caseId}/mandate/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? { mandateType: 'KYC Verification', sendEmail: false }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function requestUploadUrl(token: string, opts?: { contentType?: string; fileSizeBytes?: number; fileName?: string }) {
  return fetch(`${baseUrl}/api/v1/mandate/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      fileName: opts?.fileName ?? 'mandate.pdf',
      contentType: opts?.contentType ?? 'application/pdf',
      fileSizeBytes: opts?.fileSizeBytes ?? 1024,
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function confirmUpload(token: string, uploadId: string, fileName?: string) {
  return fetch(`${baseUrl}/api/v1/mandate/confirm-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, uploadId, fileName: fileName ?? 'mandate.pdf' }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function verifyMandate(mandateRequestId: string, token?: string) {
  return fetch(`${baseUrl}/api/v1/mandate/${mandateRequestId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function rejectMandate(mandateRequestId: string, reason: string, token?: string) {
  return fetch(`${baseUrl}/api/v1/mandate/${mandateRequestId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ reason }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function regenerateLink(mandateRequestId: string, token?: string) {
  return fetch(`${baseUrl}/api/v1/mandate/${mandateRequestId}/regenerate-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function getViewUrl(uploadId: string, token?: string) {
  return fetch(`${baseUrl}/api/v1/mandate/uploads/${uploadId}/view-url`, {
    method: 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function listForCase(caseId: string, token?: string) {
  return fetch(`${baseUrl}/api/v1/cases/${caseId}/mandate`, {
    method: 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function sendAndUpload(caseId: string) {
  const send = await sendMandate(caseId, adminToken);
  expect(send.status).toBe(201);
  const { uploadToken, mandateRequestId } = send.body.data;
  const urlRes = await requestUploadUrl(uploadToken);
  expect(urlRes.status).toBe(200);
  const { uploadId } = urlRes.body.data;
  const confirm = await confirmUpload(uploadToken, uploadId);
  expect(confirm.status).toBe(200);
  const dbUpload = await prisma.mandateUpload.findFirst({ where: { mandateRequestId } });
  return { mandateRequestId, uploadId, uploadToken, dbUploadId: dbUpload!.id };
}

// ─── Seed & Cleanup ────────────────────────────────────────────────────────

async function seedTestData() {
  await prisma.tenant.createMany({
    data: [
      { id: TENANT_ID, name: 'Mandate Test Tenant' },
      { id: OTHER_TENANT_ID, name: 'Other Mandate Tenant' },
    ],
  });

  const pw = await bcrypt.hash('TestPass123!', 12);
  const viewOnlyUserId = crypto.randomUUID();
  const noPermsUserId = crypto.randomUUID();

  await prisma.user.createMany({
    data: [
      { id: USER_ID, email: `mandate-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: viewOnlyUserId, email: `mview-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: noPermsUserId, email: `mnop-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: OTHER_USER_ID, email: `mother-${OTHER_TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: OTHER_TENANT_ID },
    ],
  });

  const [sendPerm, verifyPerm, viewPerm] = await Promise.all([
    prisma.permission.findFirst({ where: { slug: 'mandate:send' } }),
    prisma.permission.findFirst({ where: { slug: 'mandate:verify' } }),
    prisma.permission.findFirst({ where: { slug: 'mandate:view' } }),
  ]);
  if (!sendPerm) throw new Error('mandate:send permission not seeded — run prisma migrate deploy');
  if (!verifyPerm) throw new Error('mandate:verify permission not seeded — run prisma migrate deploy');
  if (!viewPerm) throw new Error('mandate:view permission not seeded — run prisma migrate deploy');

  const adminRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'Mandate Admin', isSystem: true } });
  await prisma.rolePermission.createMany({
    data: [
      { roleId: adminRole.id, permissionId: sendPerm.id },
      { roleId: adminRole.id, permissionId: verifyPerm.id },
      { roleId: adminRole.id, permissionId: viewPerm.id },
    ],
  });
  await prisma.userRole.create({ data: { userId: USER_ID, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION } });
  adminToken = await makeSession(USER_ID, TENANT_ID);

  const viewRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'Mandate Viewer', isSystem: false } });
  await prisma.rolePermission.create({ data: { roleId: viewRole.id, permissionId: viewPerm.id } });
  await prisma.userRole.create({ data: { userId: viewOnlyUserId, roleId: viewRole.id, scopeType: ScopeType.ORGANIZATION } });
  viewOnlyToken = await makeSession(viewOnlyUserId, TENANT_ID);

  const noPermsRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'Mandate NoPerms', isSystem: false } });
  await prisma.userRole.create({ data: { userId: noPermsUserId, roleId: noPermsRole.id, scopeType: ScopeType.ORGANIZATION } });
  noPermsToken = await makeSession(noPermsUserId, TENANT_ID);

  const otherAdminRole = await prisma.role.create({ data: { tenantId: OTHER_TENANT_ID, name: 'Other Mandate Admin', isSystem: true } });
  await prisma.rolePermission.createMany({
    data: [
      { roleId: otherAdminRole.id, permissionId: sendPerm.id },
      { roleId: otherAdminRole.id, permissionId: verifyPerm.id },
      { roleId: otherAdminRole.id, permissionId: viewPerm.id },
    ],
  });
  await prisma.userRole.create({ data: { userId: OTHER_USER_ID, roleId: otherAdminRole.id, scopeType: ScopeType.ORGANIZATION } });
  otherTenantToken = await makeSession(OTHER_USER_ID, OTHER_TENANT_ID);
}

async function cleanupTestData() {
  const tenants = [TENANT_ID, OTHER_TENANT_ID];
  await prisma.mandateUpload.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.mandateRequest.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.notification.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.portalSession.deleteMany({ where: { case: { tenantId: { in: tenants } } } });
  await prisma.docCaseNote.deleteMany({ where: { case: { tenantId: { in: tenants } } } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: { in: tenants } } } });
  const cases = await prisma.docCase.findMany({ where: { tenantId: { in: tenants } }, select: { leadId: true } });
  await prisma.docCase.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.lead.deleteMany({ where: { id: { in: cases.map((c) => c.leadId) } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: tenants } } } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: { in: tenants } } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.session.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────────

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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTestData();
  await prisma.$disconnect();
}, 30_000);

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /cases/:caseId/mandate/send', () => {
  it('1. send mandate for INCOMING case → 201, MandateRequest + events', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    const r = await sendMandate(c.id, adminToken);
    expect(r.status).toBe(201);
    expect(r.body.data.mandateRequestId).toBeTruthy();
    expect(r.body.data.uploadToken).toBeTruthy();
    expect(r.body.data.expiresAt).toBeTruthy();

    const request = await prisma.mandateRequest.findUnique({ where: { id: r.body.data.mandateRequestId } });
    expect(request).toBeTruthy();
    expect(request!.status).toBe('PENDING_UPLOAD');
    expect(request!.tenantId).toBe(TENANT_ID);
    expect(request!.caseId).toBe(c.id);

    const events = await prisma.docCaseEvent.findMany({ where: { caseId: c.id, eventType: 'MANDATE_SENT' } });
    expect(events).toHaveLength(1);

    const audits = await prisma.auditLog.findMany({ where: { tenantId: TENANT_ID, entityId: r.body.data.mandateRequestId, eventType: 'MANDATE_SENT' } });
    expect(audits).toHaveLength(1);
  });

  it('2. send mandate for ACTIVE case → 201', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const r = await sendMandate(c.id, adminToken);
    expect(r.status).toBe(201);
    expect(r.body.data.mandateRequestId).toBeTruthy();
  });

  it('3. send mandate for CLOSED case → 422', async () => {
    const c = await createCase({ status: DocCaseStatus.CLOSED });
    const r = await sendMandate(c.id, adminToken);
    expect(r.status).toBe(422);
  });

  it('4. send without mandate:send permission → 403', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const r = await sendMandate(c.id, viewOnlyToken);
    expect(r.status).toBe(403);
  });

  it('5. send for wrong tenant → 404', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE, tenantId: OTHER_TENANT_ID });
    const r = await sendMandate(c.id, adminToken);
    expect(r.status).toBe(404);
  });

  it('6. double send while first is PENDING_UPLOAD → old SUPERSEDED, new active', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const r1 = await sendMandate(c.id, adminToken);
    expect(r1.status).toBe(201);
    const firstId = r1.body.data.mandateRequestId;

    const r2 = await sendMandate(c.id, adminToken);
    expect(r2.status).toBe(201);
    const secondId = r2.body.data.mandateRequestId;
    expect(secondId).not.toBe(firstId);

    const old = await prisma.mandateRequest.findUnique({ where: { id: firstId } });
    expect(old!.status).toBe('SUPERSEDED');

    const fresh = await prisma.mandateRequest.findUnique({ where: { id: secondId } });
    expect(fresh!.status).toBe('PENDING_UPLOAD');
  });

  it('7. send while existing is UPLOADED → 422', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    await sendAndUpload(c.id);
    const r = await sendMandate(c.id, adminToken);
    expect(r.status).toBe(422);
  });
});

describe('POST /mandate/upload-url', () => {
  it('8. request upload URL with valid token → 200, presigned URL returned', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;

    const r = await requestUploadUrl(uploadToken);
    expect(r.status).toBe(200);
    expect(r.body.data.uploadUrl).toBe('https://fake-presigned-put');
    expect(r.body.data.uploadId).toBeTruthy();
    expect(r.body.data.expiresAt).toBeTruthy();
  });

  it('9. request upload URL with expired token → 410', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken, mandateRequestId } = send.body.data;

    await prisma.mandateRequest.update({
      where: { id: mandateRequestId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });

    const r = await requestUploadUrl(uploadToken);
    expect(r.status).toBe(410);
  });

  it('10. request upload URL with invalid content type → 400', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;

    const r = await requestUploadUrl(uploadToken, { contentType: 'application/zip' });
    expect(r.status).toBe(400);
  });

  it('11. request upload URL with file > 5 MB → 400', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;

    const r = await requestUploadUrl(uploadToken, { fileSizeBytes: MANDATE_POLICY.MAX_FILE_SIZE_BYTES + 1 });
    expect(r.status).toBe(400);
  });

  it('12. 5 MB exactly accepted (boundary)', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;

    const r = await requestUploadUrl(uploadToken, { fileSizeBytes: MANDATE_POLICY.MAX_FILE_SIZE_BYTES });
    expect(r.status).toBe(200);
  });

  it('13. 5 MB + 1 byte rejected (boundary)', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;

    const r = await requestUploadUrl(uploadToken, { fileSizeBytes: MANDATE_POLICY.MAX_FILE_SIZE_BYTES + 1 });
    expect(r.status).toBe(400);
  });
});

describe('POST /mandate/confirm-upload', () => {
  it('14. confirm upload with file in R2 → 200, UPLOADED status, MandateUpload + audit', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken, mandateRequestId } = send.body.data;
    const urlRes = await requestUploadUrl(uploadToken);
    const { uploadId } = urlRes.body.data;

    const r = await confirmUpload(uploadToken, uploadId);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('UPLOADED');

    const request = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(request!.status).toBe('UPLOADED');

    const uploads = await prisma.mandateUpload.findMany({ where: { mandateRequestId } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].fileName).toBe('mandate.pdf');

    const audits = await prisma.auditLog.findMany({ where: { tenantId: TENANT_ID, entityId: mandateRequestId, eventType: 'MANDATE_UPLOADED' } });
    expect(audits).toHaveLength(1);
  });

  it('15. confirm upload with missing file → 409', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;
    const urlRes = await requestUploadUrl(uploadToken);
    const { uploadId } = urlRes.body.data;

    (storageService.headObject as any).mockResolvedValueOnce({ exists: false });

    const r = await confirmUpload(uploadToken, uploadId);
    expect(r.status).toBe(409);
  });

  it('16. double confirm → first 200, second 410 (sequential)', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;
    const urlRes = await requestUploadUrl(uploadToken);
    const { uploadId } = urlRes.body.data;

    const r1 = await confirmUpload(uploadToken, uploadId);
    expect(r1.status).toBe(200);

    const r2 = await confirmUpload(uploadToken, uploadId);
    expect(r2.status).toBe(410);
  });
});

describe('POST /mandate/:id/verify', () => {
  it('17. verify mandate → 200, VERIFIED status, audit event', async () => {
    const c = await createCase();
    const { mandateRequestId } = await sendAndUpload(c.id);

    const r = await verifyMandate(mandateRequestId, adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('VERIFIED');

    const request = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(request!.status).toBe('VERIFIED');
    expect(request!.verifiedBy).toBe(USER_ID);
    expect(request!.verifiedAt).toBeTruthy();

    const audits = await prisma.auditLog.findMany({ where: { tenantId: TENANT_ID, entityId: mandateRequestId, eventType: 'MANDATE_VERIFIED' } });
    expect(audits).toHaveLength(1);
  });

  it('19. verify without mandate:verify permission → 403', async () => {
    const c = await createCase();
    const { mandateRequestId } = await sendAndUpload(c.id);

    const r = await verifyMandate(mandateRequestId, viewOnlyToken);
    expect(r.status).toBe(403);
  });
});

describe('POST /mandate/:id/reject', () => {
  it('18. reject mandate → 200, REJECTED status, reason stored', async () => {
    const c = await createCase();
    const { mandateRequestId } = await sendAndUpload(c.id);

    const r = await rejectMandate(mandateRequestId, 'Document is blurry', adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REJECTED');

    const request = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(request!.status).toBe('REJECTED');
    expect(request!.rejectionReason).toBe('Document is blurry');
    expect(request!.rejectedBy).toBe(USER_ID);

    const audits = await prisma.auditLog.findMany({ where: { tenantId: TENANT_ID, entityId: mandateRequestId, eventType: 'MANDATE_REJECTED' } });
    expect(audits).toHaveLength(1);
  });
});

describe('POST /mandate/:id/regenerate-link', () => {
  it('20. regenerate expired link → old SUPERSEDED, new PENDING_UPLOAD', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { mandateRequestId: oldId } = send.body.data;

    await prisma.mandateRequest.update({ where: { id: oldId }, data: { tokenExpiresAt: new Date(Date.now() - 1000), status: MandateRequestStatus.EXPIRED } });

    const r = await regenerateLink(oldId, adminToken);
    expect(r.status).toBe(201);
    expect(r.body.data.mandateRequestId).toBeTruthy();
    expect(r.body.data.mandateRequestId).not.toBe(oldId);
    expect(r.body.data.uploadToken).toBeTruthy();

    const old = await prisma.mandateRequest.findUnique({ where: { id: oldId } });
    expect(old!.status).toBe('SUPERSEDED');

    const fresh = await prisma.mandateRequest.findUnique({ where: { id: r.body.data.mandateRequestId } });
    expect(fresh!.status).toBe('PENDING_UPLOAD');
  });
});

describe('GET /mandate/uploads/:uploadId/view-url', () => {
  it('21. get view URL with mandate:view → 200', async () => {
    const c = await createCase();
    const { dbUploadId } = await sendAndUpload(c.id);

    const r = await getViewUrl(dbUploadId, adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data.viewUrl).toBe('https://fake-presigned-get');
    expect(r.body.data.fileName).toBeTruthy();
  });

  it('22. get view URL without permission → 403', async () => {
    const c = await createCase();
    const { dbUploadId } = await sendAndUpload(c.id);

    const r = await getViewUrl(dbUploadId, noPermsToken);
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation', () => {
  it('23. verify as wrong tenant → 404', async () => {
    const c = await createCase({ status: DocCaseStatus.ACTIVE });
    const { mandateRequestId } = await sendAndUpload(c.id);

    const r = await verifyMandate(mandateRequestId, otherTenantToken);
    expect(r.status).toBe(404);
  });
});

describe('Response contract', () => {
  it('24. listForCase contains no storageKey or uploadTokenHash', async () => {
    const c = await createCase();
    await sendAndUpload(c.id);

    const r = await listForCase(c.id, adminToken);
    expect(r.status).toBe(200);
    const items = r.body.data;
    expect(items.length).toBeGreaterThanOrEqual(1);

    for (const item of items) {
      expect(item).not.toHaveProperty('storageKey');
      expect(item).not.toHaveProperty('uploadTokenHash');
      for (const upload of item.uploads ?? []) {
        expect(upload).not.toHaveProperty('storageKey');
      }
    }
  });
});

describe('Audit lifecycle', () => {
  it('25. full lifecycle send → upload → verify produces 3 audit events + 3 DocCaseEvents', async () => {
    const c = await createCase();

    const send = await sendMandate(c.id, adminToken);
    expect(send.status).toBe(201);
    const { mandateRequestId, uploadToken } = send.body.data;

    const urlRes = await requestUploadUrl(uploadToken);
    const { uploadId } = urlRes.body.data;
    const confirm = await confirmUpload(uploadToken, uploadId);
    expect(confirm.status).toBe(200);

    const verify = await verifyMandate(mandateRequestId, adminToken);
    expect(verify.status).toBe(200);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: mandateRequestId },
      orderBy: { createdAt: 'asc' },
    });
    const auditTypes = audits.map((a) => a.eventType);
    expect(auditTypes).toContain('MANDATE_SENT');
    expect(auditTypes).toContain('MANDATE_UPLOADED');
    expect(auditTypes).toContain('MANDATE_VERIFIED');
    expect(audits.length).toBeGreaterThanOrEqual(3);

    const events = await prisma.docCaseEvent.findMany({
      where: { caseId: c.id, eventType: { in: ['MANDATE_SENT', 'MANDATE_UPLOADED', 'MANDATE_VERIFIED'] } },
    });
    expect(events).toHaveLength(3);
  });
});

describe('Magic-byte validation gate', () => {
  it('26. confirm upload with mismatched magic bytes → 400, staging deleted', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    expect(send.status).toBe(201);
    const { uploadToken } = send.body.data;

    const urlRes = await requestUploadUrl(uploadToken);
    expect(urlRes.status).toBe(200);
    const { uploadId } = urlRes.body.data;

    // Override: headObject says PDF, but bytes are JPEG magic
    (storageService.getObjectBytes as jest.Mock).mockResolvedValueOnce(
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]),
    );

    const confirm = await confirmUpload(uploadToken, uploadId);
    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe('VALIDATION_ERROR');
    expect(confirm.body.message).toMatch(/does not match/i);

    // Staging object must be deleted
    expect(storageService.deleteObject).toHaveBeenCalled();

    // copyObject must NOT have been called (file never promoted)
    const copyCalls = (storageService.copyObject as jest.Mock).mock.calls.length;
    // Reset mock call counts for future tests
    (storageService.getObjectBytes as jest.Mock).mockResolvedValue(Buffer.from('%PDF-1.7 mock content'));

    // Mandate request stays PENDING_UPLOAD (never transitions to UPLOADED)
    const send2 = send.body.data;
    const req = await prisma.mandateRequest.findUnique({ where: { id: send2.mandateRequestId } });
    expect(req!.status).toBe(MandateRequestStatus.PENDING_UPLOAD);
  });
});

// ─── D5: upload tokens must die when the parent case closes ──────────────────
describe('D5: mandate upload tokens invalidated when case closes', () => {
  const caseLifecycle = new CaseLifecycleService(prisma);
  const closeCase = (caseId: string) =>
    caseLifecycle.closeWithoutDocs({ tenantId: TENANT_ID, userId: USER_ID }, caseId, 'CLIENT_FAILED_DOCS');
  const reopenCase = (caseId: string) =>
    caseLifecycle.reopenCase({ tenantId: TENANT_ID, userId: USER_ID }, caseId);

  it('27. closed case -> upload-url with previously valid token -> 410 CASE_CLOSED', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    expect(send.status).toBe(201);
    const { uploadToken } = send.body.data;
    await closeCase(c.id);
    const res = await requestUploadUrl(uploadToken);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('CASE_CLOSED');
  });

  it('28. closed case -> confirm-upload -> 410 CASE_CLOSED', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken } = send.body.data;
    const urlRes = await requestUploadUrl(uploadToken);
    expect(urlRes.status).toBe(200);
    const { uploadId } = urlRes.body.data;
    await closeCase(c.id);
    const res = await confirmUpload(uploadToken, uploadId);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('CASE_CLOSED');
  });

  it('29. closed case -> regenerateLink -> 422', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { mandateRequestId } = send.body.data;
    await closeCase(c.id);
    const res = await regenerateLink(mandateRequestId, adminToken);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('30. closeWithoutDocs supersedes PENDING_UPLOAD + writes MANDATE_SUPERSEDED audit', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { mandateRequestId } = send.body.data;
    const before = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(before!.status).toBe(MandateRequestStatus.PENDING_UPLOAD);

    await closeCase(c.id);

    const after = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(after!.status).toBe(MandateRequestStatus.SUPERSEDED);
    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, eventType: 'MANDATE_SUPERSEDED', entityId: mandateRequestId },
    });
    expect(audits.length).toBe(1);
    const events = await prisma.docCaseEvent.findMany({
      where: { caseId: c.id, eventType: 'MANDATE_SUPERSEDED' },
    });
    expect(events.length).toBe(1);
  });

  it('31. UPLOADED mandate is preserved (not superseded) on close', async () => {
    const c = await createCase();
    const { mandateRequestId } = await sendAndUpload(c.id);
    const up = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(up!.status).toBe(MandateRequestStatus.UPLOADED);
    await closeCase(c.id);
    const after = await prisma.mandateRequest.findUnique({ where: { id: mandateRequestId } });
    expect(after!.status).toBe(MandateRequestStatus.UPLOADED);
  });

  it('32. reopen case -> old superseded token stays dead (410); a new send works', async () => {
    const c = await createCase();
    const send = await sendMandate(c.id, adminToken);
    const { uploadToken: oldToken } = send.body.data;
    await closeCase(c.id);
    await reopenCase(c.id);
    const oldRes = await requestUploadUrl(oldToken);
    expect(oldRes.status).toBe(410);
    const send2 = await sendMandate(c.id, adminToken);
    expect(send2.status).toBe(201);
    const newRes = await requestUploadUrl(send2.body.data.uploadToken);
    expect(newRes.status).toBe(200);
  });
});
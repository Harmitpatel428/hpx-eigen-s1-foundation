/**
 * G2: staging disposition symmetry on the DOCUMENT confirm endpoint — integration tests.
 *
 * Storage is MOCKED, so "the staged object was removed" is verified by asserting
 * storageService.deleteObject was called with the staging key, not by checking a real
 * headObject 404. Covers:
 *  - T4(a): verify:true without doc:verify → 403 AND staging deleted (the gap this task closes).
 *  - T4(b): duplicate active requirement → 409 AND staging deleted (pre-existing behavior,
 *    asserted here as a regression guard).
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, DocDocumentStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

jest.mock('../../src/services/storage.service', () => ({
  storageService: {
    generateUploadUrl: jest.fn().mockResolvedValue({ url: 'https://fake-presigned-put', expiresAt: new Date(Date.now() + 900_000) }),
    generateViewUrl: jest.fn().mockResolvedValue({ url: 'https://fake-presigned-get', expiresAt: new Date(Date.now() + 900_000) }),
    headObject: jest.fn().mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'application/pdf' }),
    getObjectBytes: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 mock content')),
    copyObject: jest.fn().mockResolvedValue(undefined),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    listObjects: jest.fn().mockResolvedValue({ objects: [], nextToken: undefined }),
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

import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { AppException } from '../../src/types/exceptions';
import { storageService } from '../../src/services/storage.service';

const prisma = new PrismaClient();
let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();
const UPLOADER_ID = crypto.randomUUID(); // doc:upload + doc:view (NO doc:verify)

let adminToken: string;
let uploaderToken: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[document-staging-disposition-test] Unhandled error:', detail);
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
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'Staging', lastName: 'Disposition', email: `sd-${crypto.randomUUID()}@example.com` } });
  return prisma.docCase.create({
    data: { tenantId, leadId: lead.id, caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, status, createdBy: ADMIN_ID },
  });
}

async function createRequirement(caseId: string, tenantId = TENANT_ID, status: DocDocumentStatus = DocDocumentStatus.PENDING_COLLECTION) {
  return prisma.docCaseDocument.create({ data: { tenantId, caseId, name: 'PAN Card', status, isMandatory: true } });
}

const authHeaders = (token?: string) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const post = (path: string, token?: string, body?: unknown) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function docUploadUrl(caseId: string, token: string) {
  return post(`/api/v1/documentation/cases/${caseId}/files/upload-url`, token, { fileName: 'd.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
}

async function grant(roleId: string, slug: string) {
  const perm = await prisma.permission.findFirst({ where: { slug } });
  if (!perm) throw new Error(`permission ${slug} not seeded — run prisma migrate deploy`);
  await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
}

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Staging Disposition Tenant' } });
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.createMany({ data: [
    { id: ADMIN_ID, email: `sd-admin-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID },
    { id: UPLOADER_ID, email: `sd-upl-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID },
  ] });

  const adminRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'SD Admin', isSystem: true } });
  for (const s of ['doc:view', 'doc:upload', 'doc:verify', 'doc:file:manage', 'doc:edit']) await grant(adminRole.id, s);
  await prisma.userRole.create({ data: { userId: ADMIN_ID, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION } });
  adminToken = await makeSession(ADMIN_ID, TENANT_ID);

  const uploaderRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'SD Uploader', isSystem: false } });
  for (const s of ['doc:view', 'doc:upload']) await grant(uploaderRole.id, s);
  await prisma.userRole.create({ data: { userId: UPLOADER_ID, roleId: uploaderRole.id, scopeType: ScopeType.ORGANIZATION } });
  uploaderToken = await makeSession(UPLOADER_ID, TENANT_ID);

  server = makeTestApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  const tenants = [TENANT_ID];
  await prisma.document.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.notification.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: { in: tenants } } } });
  await prisma.docCase.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.lead.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.session.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: { in: tenants } } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: tenants } } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(() => {
  jest.clearAllMocks();
  (storageService.headObject as jest.Mock).mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'application/pdf' });
  (storageService.getObjectBytes as jest.Mock).mockResolvedValue(Buffer.from('%PDF-1.7 mock content'));
  (storageService.generateUploadUrl as jest.Mock).mockResolvedValue({ url: 'https://fake', expiresAt: new Date(Date.now() + 900_000) });
  (storageService.copyObject as jest.Mock).mockResolvedValue(undefined);
  (storageService.deleteObject as jest.Mock).mockResolvedValue(undefined);
});

describe('Document confirmUpload — staging disposition (G2)', () => {
  it('T4(a): verify:true without doc:verify → 403 AND staging deleted', async () => {
    const c = await createCase();
    const url = await docUploadUrl(c.id, uploaderToken);
    expect(url.status).toBe(200);
    const uploadId = url.body.data.uploadId;

    const confirm = await post(`/api/v1/documentation/cases/${c.id}/files/confirm-upload`, uploaderToken, {
      uploadId, fileName: 'd.pdf', category: 'GENERAL', name: 'X', sourceChannel: 'EMAIL', verify: true,
    });
    expect(confirm.status).toBe(403);

    expect(storageService.deleteObject).toHaveBeenCalledWith(expect.stringContaining(uploadId));
    const calls = (storageService.deleteObject as jest.Mock).mock.calls as unknown[][];
    expect(calls.some((args) => typeof args[0] === 'string' && args[0].includes('doc-staging/'))).toBe(true);

    // No document row was created for the rejected confirm.
    expect(await prisma.document.count({ where: { uploadId } })).toBe(0);
  });

  it('T4(b): duplicate active requirement → 409 AND staging deleted', async () => {
    const c = await createCase();
    const req = await createRequirement(c.id);

    const firstUrl = await docUploadUrl(c.id, adminToken);
    expect(firstUrl.status).toBe(200);
    const firstConfirm = await post(`/api/v1/documentation/cases/${c.id}/files/confirm-upload`, adminToken, {
      uploadId: firstUrl.body.data.uploadId, fileName: 'd.pdf', category: 'REQUIREMENT', requirementId: req.id, sourceChannel: 'EMAIL',
    });
    expect(firstConfirm.status).toBe(200);

    const secondUrl = await docUploadUrl(c.id, adminToken);
    expect(secondUrl.status).toBe(200);
    const secondUploadId = secondUrl.body.data.uploadId;

    jest.clearAllMocks();
    (storageService.headObject as jest.Mock).mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'application/pdf' });
    (storageService.getObjectBytes as jest.Mock).mockResolvedValue(Buffer.from('%PDF-1.7 mock content'));
    (storageService.copyObject as jest.Mock).mockResolvedValue(undefined);
    (storageService.deleteObject as jest.Mock).mockResolvedValue(undefined);

    const secondConfirm = await post(`/api/v1/documentation/cases/${c.id}/files/confirm-upload`, adminToken, {
      uploadId: secondUploadId, fileName: 'd.pdf', category: 'REQUIREMENT', requirementId: req.id, sourceChannel: 'EMAIL',
    });
    expect(secondConfirm.status).toBe(409);

    expect(storageService.deleteObject).toHaveBeenCalledWith(expect.stringContaining(secondUploadId));
  });
});

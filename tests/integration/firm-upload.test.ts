/**
 * Firm direct upload (Phase 1) — integration tests.
 *
 * Covers the staff firm-upload endpoints for mandate + unified Document files:
 * happy paths, the verify-permission gate, permission 403s, idempotent replay,
 * requirement transitions, status machine, and tenant isolation. Runs against
 * real PostgreSQL with mocked R2 storage + rate-limit + virus scan.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, MandateRequestStatus, DocumentStatus, DocDocumentStatus, ScopeType } from '@prisma/client';
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

import { createMandateRouter } from '../../src/routes/mandate.router';
import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();       // all firm-upload perms + verify
const UPLOADER_ID = crypto.randomUUID();     // mandate:upload + doc:upload + doc:view (NO verify/file:manage)
const NOPERMS_ID = crypto.randomUUID();      // no perms
const OTHER_ADMIN_ID = crypto.randomUUID();

let adminToken: string;
let uploaderToken: string;
let noPermsToken: string;
let otherToken: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use('/api/v1', createMandateRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[firm-upload-test] Unhandled error:', detail);
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
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'Firm', lastName: 'Upload', email: `fu-${crypto.randomUUID()}@example.com` } });
  return prisma.docCase.create({
    data: { tenantId, leadId: lead.id, caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, status, createdBy: ADMIN_ID },
  });
}

async function createRequirement(caseId: string, tenantId = TENANT_ID, status: DocDocumentStatus = DocDocumentStatus.PENDING_COLLECTION) {
  return prisma.docCaseDocument.create({ data: { tenantId, caseId, name: 'PAN Card', status, isMandatory: true } });
}

const authHeaders = (token?: string) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const post = (path: string, token?: string, body?: unknown) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const patch = (path: string, token?: string, body?: unknown) => fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function firmMandate(caseId: string, token: string, extra: Record<string, unknown> = {}) {
  const url = await post(`/api/v1/cases/${caseId}/mandate/firm-upload-url`, token, { fileName: 'mandate.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
  if (url.status !== 200) return { urlStatus: url.status, url };
  const confirm = await post(`/api/v1/cases/${caseId}/mandate/firm-confirm-upload`, token, { uploadId: url.body.data.uploadId, fileName: 'mandate.pdf', sourceChannel: 'WHATSAPP', ...extra });
  return { urlStatus: url.status, uploadId: url.body.data.uploadId, confirm };
}

async function firmDoc(caseId: string, token: string, body: Record<string, unknown>) {
  const url = await post(`/api/v1/documentation/cases/${caseId}/files/upload-url`, token, { fileName: 'doc.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
  if (url.status !== 200) return { urlStatus: url.status, url };
  const confirm = await post(`/api/v1/documentation/cases/${caseId}/files/confirm-upload`, token, { uploadId: url.body.data.uploadId, fileName: 'doc.pdf', sourceChannel: 'EMAIL', ...body });
  return { urlStatus: url.status, uploadId: url.body.data.uploadId, confirm };
}

async function grant(roleId: string, slug: string) {
  const perm = await prisma.permission.findFirst({ where: { slug } });
  if (!perm) throw new Error(`permission ${slug} not seeded — run prisma migrate deploy`);
  await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
}

beforeAll(async () => {
  await prisma.tenant.createMany({ data: [{ id: TENANT_ID, name: 'Firm Upload Tenant' }, { id: OTHER_TENANT_ID, name: 'Other FU Tenant' }] });
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.createMany({ data: [
    { id: ADMIN_ID, email: `fu-admin-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID },
    { id: UPLOADER_ID, email: `fu-upl-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID },
    { id: NOPERMS_ID, email: `fu-nop-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID },
    { id: OTHER_ADMIN_ID, email: `fu-oth-${OTHER_TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: OTHER_TENANT_ID },
  ] });

  const adminRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'FU Admin', isSystem: true } });
  for (const s of ['mandate:upload', 'mandate:verify', 'mandate:view', 'doc:view', 'doc:upload', 'doc:verify', 'doc:file:manage', 'doc:edit']) await grant(adminRole.id, s);
  await prisma.userRole.create({ data: { userId: ADMIN_ID, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION } });
  adminToken = await makeSession(ADMIN_ID, TENANT_ID);

  const uploaderRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'FU Uploader', isSystem: false } });
  for (const s of ['mandate:upload', 'mandate:view', 'doc:view', 'doc:upload']) await grant(uploaderRole.id, s);
  await prisma.userRole.create({ data: { userId: UPLOADER_ID, roleId: uploaderRole.id, scopeType: ScopeType.ORGANIZATION } });
  uploaderToken = await makeSession(UPLOADER_ID, TENANT_ID);

  const noRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'FU NoPerms', isSystem: false } });
  await prisma.userRole.create({ data: { userId: NOPERMS_ID, roleId: noRole.id, scopeType: ScopeType.ORGANIZATION } });
  noPermsToken = await makeSession(NOPERMS_ID, TENANT_ID);

  const otherRole = await prisma.role.create({ data: { tenantId: OTHER_TENANT_ID, name: 'FU Other Admin', isSystem: true } });
  for (const s of ['mandate:upload', 'mandate:verify', 'mandate:view', 'doc:view', 'doc:upload', 'doc:verify', 'doc:file:manage']) await grant(otherRole.id, s);
  await prisma.userRole.create({ data: { userId: OTHER_ADMIN_ID, roleId: otherRole.id, scopeType: ScopeType.ORGANIZATION } });
  otherToken = await makeSession(OTHER_ADMIN_ID, OTHER_TENANT_ID);

  server = makeTestApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  const tenants = [TENANT_ID, OTHER_TENANT_ID];
  await prisma.document.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.mandateUpload.deleteMany({ where: { tenantId: { in: tenants } } });
  await prisma.mandateRequest.deleteMany({ where: { tenantId: { in: tenants } } });
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

describe('Firm mandate upload', () => {
  it('uploads a mandate directly (status UPLOADED, party FIRM)', async () => {
    const c = await createCase();
    const { confirm } = await firmMandate(c.id, adminToken);
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.data.status).toBe('UPLOADED');
    const upload = await prisma.mandateUpload.findFirst({ where: { mandateRequestId: confirm!.body.data.mandateRequestId } });
    expect(upload?.uploadedByParty).toBe('FIRM');
    expect(upload?.sourceChannel).toBe('WHATSAPP');
    const req = await prisma.mandateRequest.findUnique({ where: { id: confirm!.body.data.mandateRequestId } });
    expect(req?.status).toBe(MandateRequestStatus.UPLOADED);
  });

  it('verifies on upload when the caller has mandate:verify', async () => {
    const c = await createCase();
    const { confirm } = await firmMandate(c.id, adminToken, { verify: true });
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.data.status).toBe('VERIFIED');
  });

  it('rejects verify=true when the caller lacks mandate:verify (403)', async () => {
    const c = await createCase();
    const { confirm } = await firmMandate(c.id, uploaderToken, { verify: true });
    expect(confirm!.status).toBe(403);
    // no request/upload created
    expect(await prisma.mandateRequest.count({ where: { caseId: c.id } })).toBe(0);
  });

  it('rejects firm upload without mandate:upload (403)', async () => {
    const c = await createCase();
    const url = await post(`/api/v1/cases/${c.id}/mandate/firm-upload-url`, noPermsToken, { fileName: 'm.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(url.status).toBe(403);
  });

  it('is idempotent on replay (same uploadId → one upload row, first-wins)', async () => {
    const c = await createCase();
    const url = await post(`/api/v1/cases/${c.id}/mandate/firm-upload-url`, adminToken, { fileName: 'm.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    const uploadId = url.body.data.uploadId;
    const first = await post(`/api/v1/cases/${c.id}/mandate/firm-confirm-upload`, adminToken, { uploadId, fileName: 'm.pdf', sourceChannel: 'WHATSAPP' });
    const second = await post(`/api/v1/cases/${c.id}/mandate/firm-confirm-upload`, adminToken, { uploadId, fileName: 'm.pdf', sourceChannel: 'WHATSAPP', verify: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.mandateRequestId).toBe(first.body.data.mandateRequestId); // first-wins ignores the verify diff
    expect(await prisma.mandateUpload.count({ where: { uploadId } })).toBe(1);
  });

  it('rejects an invalid content type (400)', async () => {
    const c = await createCase();
    const url = await post(`/api/v1/cases/${c.id}/mandate/firm-upload-url`, adminToken, { fileName: 'm.exe', contentType: 'application/x-msdownload', fileSizeBytes: 1024 });
    expect(url.status).toBe(400);
  });

  it('isolates tenants (other tenant case → 404)', async () => {
    const c = await createCase();
    const url = await post(`/api/v1/cases/${c.id}/mandate/firm-upload-url`, otherToken, { fileName: 'm.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(url.status).toBe(404);
  });
});

describe('Firm document upload (unified Document)', () => {
  it('uploads a requirement document and moves the requirement to RECEIVED', async () => {
    const c = await createCase();
    const req = await createRequirement(c.id);
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'REQUIREMENT', requirementId: req.id });
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.data.status).toBe('RECEIVED');
    const doc = await prisma.document.findUnique({ where: { id: confirm!.body.data.documentId } });
    expect(doc?.uploadedByParty).toBe('FIRM');
    expect(doc?.requirementId).toBe(req.id);
    const reqRow = await prisma.docCaseDocument.findUnique({ where: { id: req.id } });
    expect(reqRow?.status).toBe(DocDocumentStatus.RECEIVED);
  });

  it('uploads a general document (name required)', async () => {
    const c = await createCase();
    const missingName = await post(`/api/v1/documentation/cases/${c.id}/files/upload-url`, adminToken, { fileName: 'g.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 })
      .then((u) => post(`/api/v1/documentation/cases/${c.id}/files/confirm-upload`, adminToken, { uploadId: u.body.data.uploadId, fileName: 'g.pdf', category: 'GENERAL', sourceChannel: 'EMAIL' }));
    expect(missingName.status).toBe(400); // name required for GENERAL
    const ok = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'Bank statement' });
    expect(ok.confirm!.status).toBe(200);
    const doc = await prisma.document.findUnique({ where: { id: ok.confirm!.body.data.documentId } });
    expect(doc?.category).toBe('GENERAL');
    expect(doc?.name).toBe('Bank statement');
  });

  it('rejects firm document upload without doc:upload (403)', async () => {
    const c = await createCase();
    const url = await post(`/api/v1/documentation/cases/${c.id}/files/upload-url`, noPermsToken, { fileName: 'g.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(url.status).toBe(403);
  });

  it('rejects verify=true + requirementStatus (400 mutual exclusion)', async () => {
    const c = await createCase();
    const req = await createRequirement(c.id);
    const url = await post(`/api/v1/documentation/cases/${c.id}/files/upload-url`, adminToken, { fileName: 'd.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    const confirm = await post(`/api/v1/documentation/cases/${c.id}/files/confirm-upload`, adminToken, { uploadId: url.body.data.uploadId, fileName: 'd.pdf', category: 'REQUIREMENT', requirementId: req.id, sourceChannel: 'EMAIL', verify: true, requirementStatus: 'RECEIVED' });
    expect(confirm.status).toBe(400);
  });

  it('409 on a second active document for the same requirement', async () => {
    const c = await createCase();
    const req = await createRequirement(c.id);
    const first = await firmDoc(c.id, adminToken, { category: 'REQUIREMENT', requirementId: req.id });
    expect(first.confirm!.status).toBe(200);
    const second = await firmDoc(c.id, adminToken, { category: 'REQUIREMENT', requirementId: req.id });
    expect(second.confirm!.status).toBe(409);
  });

  it('enforces the Document status machine (verify needs doc:verify; invalid → 422)', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'X' });
    const id = confirm!.body.data.documentId;
    // uploader lacks doc:file:manage → 403
    const noManage = await patch(`/api/v1/documentation/files/${id}/status`, uploaderToken, { status: 'UNDER_REVIEW' });
    expect(noManage.status).toBe(403);
    // invalid transition RECEIVED → SCANNING → 422
    const invalid = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'SCANNING' });
    expect(invalid.status).toBe(422);
    // valid RECEIVED → UNDER_REVIEW
    const ok = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'UNDER_REVIEW' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('UNDER_REVIEW');
    // REJECTED requires a reason
    const noReason = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'REJECTED' });
    expect(noReason.status).toBe(400);
  });

  it('soft-deletes a document', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'ToDelete' });
    const id = confirm!.body.data.documentId;
    const del = await fetch(`${baseUrl}/api/v1/documentation/files/${id}`, { method: 'DELETE', headers: authHeaders(adminToken) });
    expect(del.status).toBe(204);
    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.deletedAt).not.toBeNull();
  });
});

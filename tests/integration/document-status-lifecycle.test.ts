/**
 * Document status lifecycle (Phase 1) — integration tests.
 *
 * Covers G1 (status PATCH concurrency + inactive-row guards, soft-delete) and
 * E3 (verify/reject lifecycle timestamps) for the unified Document model.
 * Runs against real PostgreSQL with mocked R2 storage + rate-limit + email.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, MandateRequestStatus, DocumentStatus, DocDocumentStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
    console.error('[document-status-lifecycle-test] Unhandled error:', detail);
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

// ─── helpers specific to this suite ────────────────────────────────────────

/** Replaces an active document (deactivates the original, creates a new active row). */
async function replaceDoc(caseId: string, documentId: string, token: string) {
  const url = await post(`/api/v1/documentation/cases/${caseId}/files/upload-url`, token, { fileName: 'r.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
  return post(`/api/v1/documentation/files/${documentId}/replace`, token, { uploadId: url.body.data.uploadId, fileName: 'r.pdf', sourceChannel: 'EMAIL' });
}

describe('Document status/delete lifecycle (G1)', () => {
  it('T1 — concurrent conflicting PATCH (VERIFIED vs REJECTED) resolves deterministically', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T1 doc' });
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.data.status).toBe('RECEIVED');
    const id = confirm!.body.data.documentId;

    const [a, b] = await Promise.all([
      patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'VERIFIED' }),
      patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'REJECTED', rejectionReason: 'dup' }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 422]);

    const winner = a.status === 200 ? a : b;
    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.status).toBe(winner.body.data.status);

    const auditCount = await prisma.auditLog.count({ where: { entityId: id, eventType: 'DOCUMENT_STATUS_CHANGED' } });
    expect(auditCount).toBe(1);
  });

  it('T2 — PATCH on a replaced (inactive) row → 409', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T2 doc' });
    const id = confirm!.body.data.documentId;
    const rep = await replaceDoc(c.id, id, adminToken);
    expect(rep.status).toBe(200);

    const res = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'UNDER_REVIEW' });
    expect(res.status).toBe(409);
  });

  it('T3 — DELETE on an inactive/replaced row → 204 + soft-delete + DOCUMENT_REMOVED audit', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T3 doc' });
    const id = confirm!.body.data.documentId;
    const rep = await replaceDoc(c.id, id, adminToken);
    expect(rep.status).toBe(200);

    const del = await fetch(`${baseUrl}/api/v1/documentation/files/${id}`, { method: 'DELETE', headers: authHeaders(adminToken) });
    expect(del.status).toBe(204);

    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.deletedAt).not.toBeNull();

    const auditCount = await prisma.auditLog.count({ where: { entityId: id, eventType: 'DOCUMENT_REMOVED' } });
    expect(auditCount).toBe(1);
  });
});

describe('Document verify/reject lifecycle timestamps (E3)', () => {
  it('T6(a) — confirm-verify sets verifiedAt/verifiedByUserId', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T6a doc', verify: true });
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.data.status).toBe('VERIFIED');
    const id = confirm!.body.data.documentId;

    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.verifiedByUserId).toBe(ADMIN_ID);
  });

  it('T6(b1) — VERIFIED→EXPIRED nulls verifiedAt + verifiedByUserId', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T6b1 doc', verify: true });
    const id = confirm!.body.data.documentId;

    const res = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'EXPIRED' });
    expect(res.status).toBe(200);

    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.verifiedAt).toBeNull();
    expect(row?.verifiedByUserId).toBeNull();
  });

  it('T6(b2) — RECEIVED→REJECTED sets rejectedAt/rejectedByUserId/rejectionReason', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T6b2 doc' });
    expect(confirm!.body.data.status).toBe('RECEIVED');
    const id = confirm!.body.data.documentId;

    const res = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'REJECTED', rejectionReason: 'blurry' });
    expect(res.status).toBe(200);

    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.rejectedAt).not.toBeNull();
    expect(row?.rejectedByUserId).toBe(ADMIN_ID);
    expect(row?.rejectionReason).toBe('blurry');
  });

  it('T6(c) — VERIFIED→ARCHIVED preserves verifiedAt/verifiedByUserId', async () => {
    const c = await createCase();
    const { confirm } = await firmDoc(c.id, adminToken, { category: 'GENERAL', name: 'T6c doc', verify: true });
    const id = confirm!.body.data.documentId;
    const before = await prisma.document.findUnique({ where: { id } });
    expect(before?.verifiedAt).not.toBeNull();

    const res = await patch(`/api/v1/documentation/files/${id}/status`, adminToken, { status: 'ARCHIVED' });
    expect(res.status).toBe(200);

    const after = await prisma.document.findUnique({ where: { id } });
    expect(after?.verifiedAt?.getTime()).toBe(before?.verifiedAt?.getTime());
    expect(after?.verifiedByUserId).toBe(ADMIN_ID);
  });
});

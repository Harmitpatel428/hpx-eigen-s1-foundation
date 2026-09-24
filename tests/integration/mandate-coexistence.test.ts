/**
 * F6 coexistence — integration tests.
 *
 * When a firm confirms a new mandate upload while a prior VERIFIED mandate exists,
 * the prior VERIFIED request is RETAINED as history (VERIFIED→SUPERSEDED is forbidden),
 * and the timeline emits a dedicated MANDATE_VERIFIED_RETAINED DocCaseEvent plus a
 * matching audit row. No prior VERIFIED → neither is emitted. Runs against real
 * PostgreSQL with mocked R2 storage + rate-limit + virus scan.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, MandateRequestStatus, ScopeType } from '@prisma/client';
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
const ADMIN_ID = crypto.randomUUID();       // mandate:verify + mandate:upload

let adminToken: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use('/api/v1', createMandateRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[mandate-coexistence-test] Unhandled error:', detail);
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
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'Firm', lastName: 'Upload', email: `cx-${crypto.randomUUID()}@example.com` } });
  return prisma.docCase.create({
    data: { tenantId, leadId: lead.id, caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, status, createdBy: ADMIN_ID },
  });
}

const authHeaders = (token?: string) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const post = (path: string, token?: string, body?: unknown) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function firmMandate(caseId: string, token: string, extra: Record<string, unknown> = {}) {
  const url = await post(`/api/v1/cases/${caseId}/mandate/firm-upload-url`, token, { fileName: 'mandate.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
  if (url.status !== 200) return { urlStatus: url.status, url };
  const confirm = await post(`/api/v1/cases/${caseId}/mandate/firm-confirm-upload`, token, { uploadId: url.body.data.uploadId, fileName: 'mandate.pdf', sourceChannel: 'WHATSAPP', ...extra });
  return { urlStatus: url.status, uploadId: url.body.data.uploadId, confirm };
}

async function grant(roleId: string, slug: string) {
  const perm = await prisma.permission.findFirst({ where: { slug } });
  if (!perm) throw new Error(`permission ${slug} not seeded — run prisma migrate deploy`);
  await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
}

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Coexistence Tenant' } });
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.create({ data: { id: ADMIN_ID, email: `cx-admin-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID } });

  const adminRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'CX Admin', isSystem: true } });
  for (const s of ['mandate:upload', 'mandate:verify', 'mandate:view', 'doc:view']) await grant(adminRole.id, s);
  await prisma.userRole.create({ data: { userId: ADMIN_ID, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION } });
  adminToken = await makeSession(ADMIN_ID, TENANT_ID);

  server = makeTestApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await prisma.mandateUpload.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.mandateRequest.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.notification.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: TENANT_ID } } });
  await prisma.docCase.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.session.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: TENANT_ID } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: TENANT_ID } } });
  await prisma.role.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
}, 30_000);

describe('F6 mandate coexistence — MANDATE_VERIFIED_RETAINED', () => {
  it('T5(a) firm confirm over a prior VERIFIED emits exactly one event + audit', async () => {
    const c = await createCase();

    const first = await firmMandate(c.id, adminToken, { verify: true });
    expect(first.confirm!.status).toBe(200);
    const request1Id = first.confirm!.body.data.mandateRequestId;
    const req1 = await prisma.mandateRequest.findUnique({ where: { id: request1Id } });
    expect(req1?.status).toBe(MandateRequestStatus.VERIFIED);

    const second = await firmMandate(c.id, adminToken);
    expect(second.confirm!.status).toBe(200);
    const request2Id = second.confirm!.body.data.mandateRequestId;

    const eventCount = await prisma.docCaseEvent.count({ where: { caseId: c.id, eventType: 'MANDATE_VERIFIED_RETAINED' } });
    expect(eventCount).toBe(1);

    const event = await prisma.docCaseEvent.findFirst({ where: { caseId: c.id, eventType: 'MANDATE_VERIFIED_RETAINED' } });
    const payload = event!.payload as { caseId: string; newRequestId: string; retainedRequestIds: string[] };
    expect(payload.caseId).toBe(c.id);
    expect(payload.newRequestId).toBe(request2Id);
    expect(payload.retainedRequestIds).toContain(request1Id);

    const auditCount = await prisma.auditLog.count({ where: { tenantId: TENANT_ID, eventType: 'MANDATE_VERIFIED_RETAINED' } });
    expect(auditCount).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: TENANT_ID, eventType: 'MANDATE_VERIFIED_RETAINED' } });
    const meta = audit!.payload as { caseId: string; newRequestId: string; retainedRequestIds: string[] };
    expect(meta.caseId).toBe(c.id);
    expect(meta.newRequestId).toBe(request2Id);
    expect(meta.retainedRequestIds).toContain(request1Id);
  });

  it('T5(b) firm confirm with NO prior VERIFIED emits neither', async () => {
    const c = await createCase();

    const only = await firmMandate(c.id, adminToken);
    expect(only.confirm!.status).toBe(200);

    const eventCount = await prisma.docCaseEvent.count({ where: { caseId: c.id, eventType: 'MANDATE_VERIFIED_RETAINED' } });
    expect(eventCount).toBe(0);

    const auditCount = await prisma.auditLog.count({ where: { tenantId: TENANT_ID, eventType: 'MANDATE_VERIFIED_RETAINED', entityId: { in: (await prisma.mandateRequest.findMany({ where: { caseId: c.id }, select: { id: true } })).map((r) => r.id) } } });
    expect(auditCount).toBe(0);
  });
});

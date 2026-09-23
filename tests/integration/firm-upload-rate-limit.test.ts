/**
 * M3 firm-upload-url rate limit — wiring + 429-mapping integration test.
 *
 * The test env forces REDIS_URL='' (tests/setup-env.js) so the real
 * checkFirmUploadUrlAttempts always fails OPEN — a naive N+1 HTTP loop can
 * never observe a 429 here. Instead this mocks checkFirmUploadUrlAttempts
 * directly to prove both firm presign endpoints (a) call it with the
 * authenticated (userId, tenantId) before presigning, and (b) map a thrown
 * RateLimitExceededError to HTTP 429. The cap arithmetic itself (throws
 * after cap / fails open on null) is covered by
 * tests/unit/firm-upload-rate-limit.test.ts.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

jest.mock('../../src/services/storage.service', () => ({
  storageService: {
    generateUploadUrl: jest.fn().mockResolvedValue({ url: 'https://fake-presigned-put', expiresAt: new Date(Date.now() + 900_000) }),
  },
}));

const checkFirmUploadUrlAttempts = jest.fn();

jest.mock('../../src/services/auth/RateLimitService', () => ({
  ...jest.requireActual('../../src/services/auth/RateLimitService'),
  checkMandateUploadAttempts: jest.fn().mockResolvedValue(undefined),
  checkFirmUploadUrlAttempts: (...args: unknown[]) => checkFirmUploadUrlAttempts(...args),
}));

import { createMandateRouter } from '../../src/routes/mandate.router';
import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { AppException, RateLimitExceededError } from '../../src/types/exceptions';

const prisma = new PrismaClient();
let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();

let adminToken: string;
let caseId: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use('/api/v1', createMandateRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[firm-upload-rate-limit-test] Unhandled error:', detail);
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

async function grant(roleId: string, slug: string) {
  const perm = await prisma.permission.findFirst({ where: { slug } });
  if (!perm) throw new Error(`permission ${slug} not seeded — run prisma migrate deploy`);
  await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
}

const authHeaders = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const post = (path: string, token: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'FU Rate Limit Tenant' } });
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.create({ data: { id: ADMIN_ID, email: `fu-rl-admin-${TENANT_ID.slice(0, 8)}@x.com`, password: pw, tenantId: TENANT_ID } });

  const role = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'FU RL Admin', isSystem: true } });
  for (const s of ['mandate:upload', 'doc:upload']) await grant(role.id, s);
  await prisma.userRole.create({ data: { userId: ADMIN_ID, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  adminToken = await makeSession(ADMIN_ID, TENANT_ID);

  const lead = await prisma.lead.create({ data: { tenantId: TENANT_ID, firstName: 'RL', lastName: 'Case', email: `fu-rl-${crypto.randomUUID()}@example.com` } });
  const docCase = await prisma.docCase.create({
    data: { tenantId: TENANT_ID, leadId: lead.id, caseNumber: `HPX-RL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, status: DocCaseStatus.ACTIVE, createdBy: ADMIN_ID },
  });
  caseId = docCase.id;

  server = makeTestApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await prisma.docCase.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.session.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: TENANT_ID } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: TENANT_ID } } });
  await prisma.role.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(() => {
  checkFirmUploadUrlAttempts.mockReset();
});

describe('firm-upload-url rate limit wiring', () => {
  it('under cap: mandate firm-upload-url calls checkFirmUploadUrlAttempts(userId, tenantId) and returns 200', async () => {
    checkFirmUploadUrlAttempts.mockResolvedValue(undefined);
    const res = await post(`/api/v1/cases/${caseId}/mandate/firm-upload-url`, adminToken, { fileName: 'm.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(res.status).toBe(200);
    expect(checkFirmUploadUrlAttempts).toHaveBeenCalledWith(ADMIN_ID, TENANT_ID);
  });

  it('under cap: documentation files/upload-url calls checkFirmUploadUrlAttempts(userId, tenantId) and returns 200', async () => {
    checkFirmUploadUrlAttempts.mockResolvedValue(undefined);
    const res = await post(`/api/v1/documentation/cases/${caseId}/files/upload-url`, adminToken, { fileName: 'd.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(res.status).toBe(200);
    expect(checkFirmUploadUrlAttempts).toHaveBeenCalledWith(ADMIN_ID, TENANT_ID);
  });

  it('over cap: mandate firm-upload-url returns 429 when checkFirmUploadUrlAttempts throws', async () => {
    checkFirmUploadUrlAttempts.mockRejectedValue(new RateLimitExceededError());
    const res = await post(`/api/v1/cases/${caseId}/mandate/firm-upload-url`, adminToken, { fileName: 'm.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(res.status).toBe(429);
  });

  it('over cap: documentation files/upload-url returns 429 when checkFirmUploadUrlAttempts throws', async () => {
    checkFirmUploadUrlAttempts.mockRejectedValue(new RateLimitExceededError());
    const res = await post(`/api/v1/documentation/cases/${caseId}/files/upload-url`, adminToken, { fileName: 'd.pdf', contentType: 'application/pdf', fileSizeBytes: 1024 });
    expect(res.status).toBe(429);
  });
});

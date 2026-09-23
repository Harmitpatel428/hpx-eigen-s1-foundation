/**
 * Mandate virus-scan gate — integration tests.
 *
 * Exercises the clamd scan gate inside confirmUpload with a mocked scanner and mocked
 * R2 storage against real PostgreSQL. Covers: clean promotion, infected rejection,
 * scanner-unavailable/timeout fail-closed, and the disabled-scanner bypass.
 *
 * IMPORTANT: `virusScanService` is the REAL implementation here (not jest.mock'd). Only
 * the scanner-client boundary (`scan`) is spied on, and `process.env.VIRUS_SCAN_ENABLED`
 * is driven per test, so the actual `scanOrBypass` enabled/disabled decision runs for real.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, afterEach, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, MandateRequestStatus } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';

// ─── Mocks (before router import) ──────────────────────────────────────────

jest.mock('../../src/services/storage.service', () => ({
  storageService: {
    generateUploadUrl: jest.fn().mockResolvedValue({ url: 'https://fake-put', expiresAt: new Date(Date.now() + 900_000) }),
    generateViewUrl: jest.fn().mockResolvedValue({ url: 'https://fake-get', expiresAt: new Date(Date.now() + 900_000) }),
    headObject: jest.fn().mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'application/pdf' }),
    getObjectBytes: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
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

// NOTE: virus-scan.service is intentionally NOT jest.mock'd. We use the real
// `virusScanService` (real scanOrBypass + real isEnabled) and only spy on the
// scanner-client method (`scan`) below, so the enabled/disabled/fail-closed
// decision logic actually executes during these tests.

import { createMandateRouter } from '../../src/routes/mandate.router';
import { AppException, ScannerUnavailableError } from '../../src/types/exceptions';
import { hashUploadToken } from '../../src/domain/mandate';
import { storageService } from '../../src/services/storage.service';
import { virusScanService } from '../../src/services/virus-scan.service';
import { logger } from '../../src/utils/logger';

const prisma = new PrismaClient();
const deleteObjectMock = storageService.deleteObject as jest.Mock;
const copyObjectMock = storageService.copyObject as jest.Mock;

// Spy on the scanner-client boundary only. The real scanOrBypass (isEnabled + bypass
// warn log + fail-closed error propagation) is untouched and runs for real.
const scanSpy = jest.spyOn(virusScanService, 'scan');

const ORIGINAL_VIRUS_SCAN_ENABLED = process.env.VIRUS_SCAN_ENABLED;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const TENANT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();

let server: http.Server;
let baseUrl: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createMandateRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

async function createPendingMandate(): Promise<{ token: string; requestId: string; caseId: string }> {
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, firstName: 'VS', lastName: 'Test', email: `vs-${crypto.randomUUID()}@example.com` },
  });
  const docCase = await prisma.docCase.create({
    data: {
      tenantId: TENANT_ID, leadId: lead.id,
      caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      status: DocCaseStatus.ACTIVE, createdBy: USER_ID,
    },
  });
  const token = crypto.randomUUID();
  const req = await prisma.mandateRequest.create({
    data: {
      tenantId: TENANT_ID, caseId: docCase.id, mandateType: 'KYC',
      uploadTokenHash: hashUploadToken(token),
      tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      sentByUserId: USER_ID,
    },
  });
  return { token, requestId: req.id, caseId: docCase.id };
}

function confirmUpload(token: string) {
  return fetch(`${baseUrl}/api/v1/mandate/confirm-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, uploadId: crypto.randomUUID(), fileName: 'mandate.pdf' }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: `vs-${TENANT_ID.slice(0, 8)}` } });
  await prisma.user.create({
    data: { id: USER_ID, tenantId: TENANT_ID, email: `vs-admin-${crypto.randomUUID()}@test.invalid`, password: 'x', status: 'ACTIVE' },
  });
  server = http.createServer(makeTestApp());
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterEach(() => {
  // Restore env + spies so no test's config leaks into the next.
  if (ORIGINAL_VIRUS_SCAN_ENABLED === undefined) delete process.env.VIRUS_SCAN_ENABLED;
  else process.env.VIRUS_SCAN_ENABLED = ORIGINAL_VIRUS_SCAN_ENABLED;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  scanSpy.mockReset();
  deleteObjectMock.mockClear();
  copyObjectMock.mockClear();
});

afterAll(async () => {
  scanSpy.mockRestore();
  await new Promise<void>((res) => server.close(() => res()));
  const cases = await prisma.docCase.findMany({ where: { tenantId: TENANT_ID }, select: { id: true, leadId: true } });
  await prisma.mandateUpload.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.mandateRequest.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCase.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { id: { in: cases.map((c) => c.leadId) } } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  await prisma.$disconnect();
}, 30_000);

describe('confirmUpload — virus scan gate', () => {
  it('1. clean file → 200 UPLOADED, promoted, MandateUpload created', async () => {
    process.env.VIRUS_SCAN_ENABLED = 'true';
    scanSpy.mockResolvedValue({ clean: true });
    const { token, requestId } = await createPendingMandate();

    const res = await confirmUpload(token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('UPLOADED');
    expect(copyObjectMock).toHaveBeenCalled();
    const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
    expect(req?.status).toBe(MandateRequestStatus.UPLOADED);
    const uploads = await prisma.mandateUpload.count({ where: { mandateRequestId: requestId } });
    expect(uploads).toBe(1);
  });

  it('2. infected file → 422 FILE_REJECTED, staging deleted, request REJECTED, no MandateUpload', async () => {
    process.env.VIRUS_SCAN_ENABLED = 'true';
    scanSpy.mockResolvedValue({ clean: false, signature: 'Eicar-Test-Signature' });
    const { token, requestId } = await createPendingMandate();

    const res = await confirmUpload(token);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_REJECTED');
    expect(res.body.message).not.toContain('Eicar'); // signature never leaked to client
    expect(deleteObjectMock).toHaveBeenCalled();      // staging deleted
    expect(copyObjectMock).not.toHaveBeenCalled();    // never promoted
    const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
    expect(req?.status).toBe(MandateRequestStatus.REJECTED);
    const uploads = await prisma.mandateUpload.count({ where: { mandateRequestId: requestId } });
    expect(uploads).toBe(0);
  });

  it('3. infected rejection writes an audit event (no signature in payload)', async () => {
    process.env.VIRUS_SCAN_ENABLED = 'true';
    scanSpy.mockResolvedValue({ clean: false, signature: 'Win.Test.EICAR' });
    const { token, requestId } = await createPendingMandate();

    await confirmUpload(token);
    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, eventType: 'MANDATE_UPLOAD_REJECTED_INFECTED', entityId: requestId },
    });
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0].payload)).not.toContain('EICAR'); // sanitized
  });

  it('4. scanner unavailable → 503 SCANNER_UNAVAILABLE, request stays PENDING_UPLOAD, not promoted, staging kept', async () => {
    process.env.VIRUS_SCAN_ENABLED = 'true';
    scanSpy.mockRejectedValue(new ScannerUnavailableError());
    const { token, requestId } = await createPendingMandate();

    const res = await confirmUpload(token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCANNER_UNAVAILABLE');
    expect(copyObjectMock).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled(); // staging preserved for retry
    const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
    expect(req?.status).toBe(MandateRequestStatus.PENDING_UPLOAD);
  });

  it('5. scanner timeout → 503 SCANNER_UNAVAILABLE, request safe', async () => {
    process.env.VIRUS_SCAN_ENABLED = 'true';
    // A timeout surfaces as ScannerUnavailableError from the service.
    scanSpy.mockRejectedValue(new ScannerUnavailableError());
    const { token, requestId } = await createPendingMandate();

    const res = await confirmUpload(token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCANNER_UNAVAILABLE');
    const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
    expect(req?.status).toBe(MandateRequestStatus.PENDING_UPLOAD);
  });

  it('6. scanning disabled → bypass, scanner client not invoked', async () => {
    delete process.env.VIRUS_SCAN_ENABLED; // unset = disabled (isEnabled() requires === 'true')
    const { token, requestId } = await createPendingMandate();

    const res = await confirmUpload(token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('UPLOADED');
    // Real scanOrBypass short-circuits before calling this.scan() when disabled.
    expect(scanSpy).not.toHaveBeenCalled();
    expect(copyObjectMock).toHaveBeenCalled(); // unscanned file still promoted (accepted-risk bypass)
    const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
    expect(req?.status).toBe(MandateRequestStatus.UPLOADED);
    const uploads = await prisma.mandateUpload.count({ where: { mandateRequestId: requestId } });
    expect(uploads).toBe(1);
  });

  it('7. scanning disabled -> bypass -> 200 with warn log (all envs)', async () => {
    delete process.env.VIRUS_SCAN_ENABLED;
    // Demonstrate the bypass is NOT gated by environment: even with NODE_ENV=production,
    // the real scanOrBypass fails OPEN (200) when VIRUS_SCAN_ENABLED isn't 'true'.
    process.env.NODE_ENV = 'production';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const { token, requestId } = await createPendingMandate();

      const res = await confirmUpload(token);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('UPLOADED');
      expect(scanSpy).not.toHaveBeenCalled();
      const warnedBypass = warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('bypassing scan'))
      );
      expect(warnedBypass).toBe(true);
      const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
      expect(req?.status).toBe(MandateRequestStatus.UPLOADED);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('8. infected + staging delete fails → still 422 REJECTED, audit flags stagingDeleteFailed, no signature', async () => {
    process.env.VIRUS_SCAN_ENABLED = 'true';
    scanSpy.mockResolvedValue({ clean: false, signature: 'Win.Test.EICAR' });
    deleteObjectMock.mockRejectedValueOnce(new Error('R2 delete failed'));
    const { token, requestId } = await createPendingMandate();

    const res = await confirmUpload(token);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_REJECTED');
    expect(res.body.message).not.toContain('EICAR'); // signature never leaked

    const req = await prisma.mandateRequest.findUnique({ where: { id: requestId } });
    expect(req?.status).toBe(MandateRequestStatus.REJECTED);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, eventType: 'MANDATE_UPLOAD_REJECTED_INFECTED', entityId: requestId },
    });
    expect(audits.length).toBe(1);
    const payload = audits[0].payload as { stagingDeleteFailed?: boolean };
    expect(payload.stagingDeleteFailed).toBe(true);
    expect(JSON.stringify(audits[0].payload)).not.toContain('EICAR'); // still sanitized
  });
});

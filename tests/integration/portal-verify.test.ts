/**
 * POST /api/v1/portal/verify + GET /api/v1/portal/case — integration tests.
 *
 * Validates the PUBLIC client-portal flow against real PostgreSQL through the
 * real Express router: verify success, uniform-401 failure, per-(caseNumber,ip)
 * lockout, portal-not-active rejection, session scoping, and expired/revoked
 * session rejection. The backend security model is immutable — these tests
 * pin its current behaviour.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, DocDocumentStatus, DocNoteType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';

import { createPortalRouter } from '../../src/routes/portal.router';
import { AppException } from '../../src/types/exceptions';
import { hashSessionToken } from '../../src/domain/portal';
import { generateCaseNumber } from '../../src/domain/caseNumber';
import { DocumentationService } from '../../src/services/documentation.service';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/portal', createPortalRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[portal-verify-test] Unhandled route error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

/** Fresh lead + case per test so the per-(caseNumber,ip) lockout never bleeds across tests. */
async function createCase(overrides: Partial<{
  status: DocCaseStatus;
  portalPhoneLast4: string | null;
  portalEnabledAt: Date | null;
}> = {}): Promise<{ id: string; caseNumber: string }> {
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, firstName: 'Test', lastName: 'Client', company: 'Acme Industries Pvt Ltd', email: `lead-${crypto.randomUUID()}@example.com` },
  });
  // Use the production generator: the case-number alphabet omits 0/1/I/O, so a
  // hex slice of a UUID would often be rejected by isValidCaseNumber.
  const caseNumber = generateCaseNumber();
  const c = await prisma.docCase.create({
    data: {
      tenantId: TENANT_ID,
      leadId: lead.id,
      caseNumber,
      status: overrides.status ?? DocCaseStatus.ACTIVE,
      portalPhoneLast4: overrides.portalPhoneLast4 === undefined ? '1234' : overrides.portalPhoneLast4,
      portalEnabledAt: overrides.portalEnabledAt === undefined ? new Date() : overrides.portalEnabledAt,
      createdBy: crypto.randomUUID(),
    },
    select: { id: true, caseNumber: true },
  });
  return { id: c.id, caseNumber: c.caseNumber! };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed: any; try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  let parsed: any; try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Portal Verify Test Tenant' } });
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
  await prisma.portalSession.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.portalAuthAttempt.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCaseDocument.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.docCaseNote.deleteMany({ where: { tenantId: TENANT_ID } });
  const cases = await prisma.docCase.findMany({ where: { tenantId: TENANT_ID }, select: { leadId: true } });
  await prisma.docCase.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { id: { in: cases.map(c => c.leadId) } } });
  await prisma.tenant.delete({ where: { id: TENANT_ID } }).catch(() => {});
  await prisma.$disconnect();
}, 30_000);

describe('POST /portal/verify', () => {
  it('correct caseNumber + last-4 digits → 200 with a session token', async () => {
    const c = await createCase();
    const r = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '1234' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(typeof r.body.data.sessionToken).toBe('string');
    expect(r.body.data.sessionToken.length).toBeGreaterThan(0);
  });

  it('wrong digits → uniform 401, no field-level leak', async () => {
    const c = await createCase();
    const r = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '9999' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('VERIFICATION_FAILED');
    expect(r.body).not.toHaveProperty('remainingAttempts');
  });

  it('missing phoneLast4 → 400 validation error', async () => {
    const c = await createCase();
    const r = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber });
    expect(r.status).toBe(400);
  });

  it('empty body → 400 (caseNumber required)', async () => {
    const r = await post('/api/v1/portal/verify', {});
    expect(r.status).toBe(400);
  });

  it('case with portal not activated → 401 (indistinguishable from wrong case)', async () => {
    const c = await createCase({ portalEnabledAt: null });
    const r = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '1234' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('VERIFICATION_FAILED');
  });

  it('after 5 well-formed failures, the CORRECT last-4 returns a DISTINCT 429 (lockout not masked as generic failure)', async () => {
    const c = await createCase();
    for (let i = 0; i < 5; i++) {
      const bad = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '0000' });
      expect(bad.status).toBe(401);
    }
    // The correct last-4, while locked, must be clearly a rate-limit — not the
    // generic "couldn't verify" that a user reads as "wrong digits".
    const locked = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '1234' });
    expect(locked.status).toBe(429);
    expect(JSON.stringify(locked.body)).not.toContain("couldn't verify");
  });

  it('malformed body (missing phoneLast4) → 400 and records NO attempt', async () => {
    const c = await createCase();
    const before = await prisma.portalAuthAttempt.count({ where: { caseNumber: c.caseNumber } });
    const r = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber });
    expect(r.status).toBe(400);
    const after = await prisma.portalAuthAttempt.count({ where: { caseNumber: c.caseNumber } });
    expect(after).toBe(before); // malformed requests must not count toward lockout
  });

  it('non-existent / foreign case number → generic 401, NOT a 429 oracle', async () => {
    const r = await post('/api/v1/portal/verify', { caseNumber: generateCaseNumber(), phoneLast4: '1234' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('VERIFICATION_FAILED');
  });

  it('a successful verification clears prior failed attempts for (caseNumber, ip)', async () => {
    const c = await createCase();
    for (let i = 0; i < 4; i++) {
      await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '0000' });
    }
    const ok = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '1234' });
    expect(ok.status).toBe(200);
    const remainingFailures = await prisma.portalAuthAttempt.count({ where: { caseNumber: c.caseNumber, succeeded: false } });
    expect(remainingFailures).toBe(0); // a success resets the lockout counter
  });

  it('retrying while locked does NOT record a new attempt (lockout must not self-extend)', async () => {
    const c = await createCase();
    for (let i = 0; i < 5; i++) {
      await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '0000' });
    }
    const before = await prisma.portalAuthAttempt.count({ where: { caseNumber: c.caseNumber } });
    const locked = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '1234' });
    expect(locked.status).toBe(429);
    const after = await prisma.portalAuthAttempt.count({ where: { caseNumber: c.caseNumber } });
    expect(after).toBe(before); // a locked retry must not extend the window
  });

  it('lockout expires once failures age out of the 30-minute window → correct last-4 succeeds', async () => {
    const c = await createCase();
    for (let i = 0; i < 5; i++) {
      await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '0000' });
    }
    // Age the recorded failures out of the sliding window.
    await prisma.portalAuthAttempt.updateMany({
      where: { caseNumber: c.caseNumber, succeeded: false },
      data: { attemptedAt: new Date(Date.now() - 31 * 60_000) },
    });
    const ok = await post('/api/v1/portal/verify', { caseNumber: c.caseNumber, phoneLast4: '1234' });
    expect(ok.status).toBe(200);
  });
});

describe('GET /portal/case', () => {
  async function verifiedToken(caseNumber: string): Promise<string> {
    const r = await post('/api/v1/portal/verify', { caseNumber, phoneLast4: '1234' });
    expect(r.status).toBe(200);
    return r.body.data.sessionToken as string;
  }

  it('returns only client-visible notes/documents and no internal fields', async () => {
    const c = await createCase();
    await prisma.docCaseNote.create({ data: { tenantId: TENANT_ID, caseId: c.id, content: 'Client-visible update', createdBy: crypto.randomUUID(), clientVisible: true } });
    await prisma.docCaseNote.create({ data: { tenantId: TENANT_ID, caseId: c.id, content: 'INTERNAL ONLY', createdBy: crypto.randomUUID(), clientVisible: false } });
    await prisma.docCaseDocument.create({ data: { tenantId: TENANT_ID, caseId: c.id, name: 'KYC Form', status: DocDocumentStatus.RECEIVED, clientVisible: true, receivedAt: new Date() } });
    await prisma.docCaseDocument.create({ data: { tenantId: TENANT_ID, caseId: c.id, name: 'Internal Check', status: DocDocumentStatus.RECEIVED, clientVisible: false } });

    const token = await verifiedToken(c.caseNumber);
    const r = await get('/api/v1/portal/case', { Authorization: `Bearer ${token}` });

    expect(r.status).toBe(200);
    const view = r.body.data;
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0].content).toBe('Client-visible update');
    expect(view.documents).toHaveLength(1);
    expect(view.documents[0].name).toBe('KYC Form');
    // No internal leakage in the client projection.
    expect(view).not.toHaveProperty('ownerId');
    expect(view).not.toHaveProperty('portalPhoneLast4');
    expect(JSON.stringify(view)).not.toContain('INTERNAL ONLY');
    expect(JSON.stringify(view)).not.toContain('Internal Check');
  });

  it('ROOT CAUSE: addNote(CUSTOMER) publishes to the portal; addNote(INTERNAL) stays staff-only', async () => {
    const c = await createCase();
    const svc = new DocumentationService(prisma);
    const ctx = { tenantId: TENANT_ID, userId: crypto.randomUUID() };

    const customer = await svc.addNote(ctx, c.id, { noteType: DocNoteType.CUSTOMER, content: 'Published client note' });
    const internal = await svc.addNote(ctx, c.id, { noteType: DocNoteType.INTERNAL, content: 'STAFF ONLY note' });

    // The fix: a CUSTOMER note is client-visible the moment it is created; INTERNAL is not. Single source of truth.
    expect(customer.clientVisible).toBe(true);
    expect(customer.clientVisibleAt).not.toBeNull();
    expect(internal.clientVisible).toBe(false);
    expect(internal.clientVisibleAt).toBeNull();

    // End-to-end: the portal returns the published note and never the internal one.
    const token = await verifiedToken(c.caseNumber);
    const r = await get('/api/v1/portal/case', { Authorization: `Bearer ${token}` });
    expect(r.status).toBe(200);
    const contents = (r.body.data.notes as Array<{ content: string }>).map(n => n.content);
    expect(contents).toContain('Published client note');
    expect(contents).not.toContain('STAFF ONLY note');
    expect(JSON.stringify(r.body.data)).not.toContain('STAFF ONLY note');
  });

  it('mandate status: PENDING with no request or no upload; UPLOADED once a mandate is uploaded', async () => {
    const mkReq = (caseId: string, status: 'PENDING_UPLOAD' | 'UPLOADED') =>
      prisma.mandateRequest.create({ data: {
        tenantId: TENANT_ID, caseId, mandateType: 'ECS', status,
        uploadTokenHash: crypto.randomBytes(32).toString('hex'),
        tokenExpiresAt: new Date(Date.now() + 864e5), sentByUserId: crypto.randomUUID(),
      } });
    const mandate = async (caseNumber: string) => {
      const r = await get('/api/v1/portal/case', { Authorization: `Bearer ${await verifiedToken(caseNumber)}` });
      expect(r.status).toBe(200);
      return r.body.data.mandateStatus as string;
    };

    // (a) no mandate request → PENDING
    const a = await createCase();
    expect(await mandate(a.caseNumber)).toBe('PENDING');

    // (b) request without an upload → PENDING
    const b = await createCase();
    await mkReq(b.id, 'PENDING_UPLOAD');
    expect(await mandate(b.caseNumber)).toBe('PENDING');

    // (c) uploaded (status UPLOADED + an upload row) → UPLOADED
    const c = await createCase();
    const req = await mkReq(c.id, 'UPLOADED');
    await prisma.mandateUpload.create({ data: {
      tenantId: TENANT_ID, mandateRequestId: req.id, storageKey: 'k',
      fileName: 'm.pdf', contentType: 'application/pdf', fileSizeBytes: 100,
    } });
    expect(await mandate(c.caseNumber)).toBe('UPLOADED');
  });

  it('document contract: 3-category status vocabulary, NOT_APPLICABLE/WAIVED dropped, no reasons/refs', async () => {
    const c = await createCase();
    const mk = (name: string, status: DocDocumentStatus) =>
      prisma.docCaseDocument.create({ data: { tenantId: TENANT_ID, caseId: c.id, name, status, clientVisible: true, receivedAt: new Date() } });
    await mk('Pending Doc', DocDocumentStatus.PENDING_COLLECTION);  // → ACTION_REQUIRED
    await mk('Rejected Doc', DocDocumentStatus.REJECTED);            // → ACTION_REQUIRED (no reason leaked)
    await mk('Submitted Doc', DocDocumentStatus.UNDER_VERIFICATION); // → AWAITING_REVIEW
    await mk('Approved Doc', DocDocumentStatus.APPROVED);            // → APPROVED
    await mk('N/A Doc', DocDocumentStatus.NOT_APPLICABLE);           // → dropped
    await mk('Waived Doc', DocDocumentStatus.WAIVED);               // → dropped

    const token = await verifiedToken(c.caseNumber);
    const r = await get('/api/v1/portal/case', { Authorization: `Bearer ${token}` });
    expect(r.status).toBe(200);
    const docs = r.body.data.documents as Array<{ id: string; name: string; status: string; receivedAt: string | null }>;

    expect(r.body.data.company).toBe('Acme Industries Pvt Ltd'); // company name surfaced to the client
    expect(r.body.data.clientName).toBe('Test Client');
    expect(docs).toHaveLength(4); // N/A + Waived dropped
    for (const d of docs) {
      expect(['ACTION_REQUIRED', 'AWAITING_REVIEW', 'APPROVED']).toContain(d.status);
      expect(Object.keys(d).sort()).toEqual(['id', 'name', 'receivedAt', 'status']);
    }
    const blob = JSON.stringify(docs);
    expect(blob).not.toMatch(/RECEIVED|PENDING\b/); // old vocabulary gone
    expect(blob).not.toContain('N/A Doc');
    expect(blob).not.toContain('Waived Doc');
    expect(blob).not.toMatch(/reason|rejection|storage|verification|remarks/i);
  });

  it('missing / malformed token → 401', async () => {
    const r = await get('/api/v1/portal/case', { Authorization: 'Bearer not-a-real-token' });
    expect(r.status).toBe(401);
  });

  it('revoked session → 401', async () => {
    const c = await createCase();
    const token = await verifiedToken(c.caseNumber);
    await prisma.portalSession.updateMany({ where: { caseId: c.id }, data: { revokedAt: new Date() } });
    const r = await get('/api/v1/portal/case', { Authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
  });

  it('expired session → 401', async () => {
    const c = await createCase();
    const rawToken = crypto.randomBytes(32).toString('base64url');
    await prisma.portalSession.create({
      data: {
        tenantId: TENANT_ID, caseId: c.id,
        tokenHash: hashSessionToken(rawToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const r = await get('/api/v1/portal/case', { Authorization: `Bearer ${rawToken}` });
    expect(r.status).toBe(401);
  });
});

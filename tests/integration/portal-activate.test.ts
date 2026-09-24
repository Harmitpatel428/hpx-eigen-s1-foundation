/**
 * POST /api/v1/cases/:caseId/portal/activate — integration tests.
 *
 * Exercises the real Express router (auth + RBAC + PortalService) against
 * real PostgreSQL. Each test creates its own Lead + DocCase because DocCase
 * has a @@unique([tenantId, leadId]) constraint — one case per lead.
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
import { PortalService } from '../../src/services/portal.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

// Test fixtures
const TENANT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();

let jwtToken: string;
let unpermittedToken: string;

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
    console.error('[portal-activate-test] Unhandled route error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

async function seedTestData() {
  await prisma.tenant.createMany({
    data: [
      { id: TENANT_ID, name: 'Portal Test Tenant' },
      { id: OTHER_TENANT_ID, name: 'Other Tenant' },
    ],
  });

  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.createMany({
    data: [
      { id: USER_ID, email: `portal-test-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: OTHER_USER_ID, email: `other-${OTHER_TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: OTHER_TENANT_ID },
    ],
  });

  // Role + permissions for portal:activate (and handoff:accept, exercised elsewhere in the router)
  const role = await prisma.role.create({
    data: { tenantId: TENANT_ID, name: 'Test Admin', isSystem: true },
  });
  const perm = await prisma.permission.findFirst({ where: { slug: 'portal:activate' } });
  if (!perm) throw new Error('portal:activate permission not seeded — run prisma migrate deploy');
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  const handoffPerm = await prisma.permission.findFirst({ where: { slug: 'handoff:accept' } });
  if (handoffPerm) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: handoffPerm.id } });
  }
  await prisma.userRole.create({
    data: { userId: USER_ID, roleId: role.id, scopeType: ScopeType.ORGANIZATION },
  });

  const session = await prisma.session.create({
    data: {
      tenantId: TENANT_ID, userId: USER_ID, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  jwtToken = jwt.sign(
    { userId: USER_ID, tenantId: TENANT_ID, sessionId: session.id },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );

  // Unpermitted user: different tenant, no portal:activate permission at all
  const otherSession = await prisma.session.create({
    data: {
      tenantId: OTHER_TENANT_ID, userId: OTHER_USER_ID, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  unpermittedToken = jwt.sign(
    { userId: OTHER_USER_ID, tenantId: OTHER_TENANT_ID, sessionId: otherSession.id },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

/**
 * Creates a fresh Lead + DocCase. DocCase has @@unique([tenantId, leadId]),
 * so every case under test needs its own lead — sharing one lead across
 * cases in the same tenant would violate that constraint.
 */
async function createCase(overrides: Partial<{
  status: DocCaseStatus;
  portalPhoneLast4: string | null;
  portalEnabledAt: Date | null;
  tenantId: string;
}> = {}) {
  const tenantId = overrides.tenantId ?? TENANT_ID;
  const lead = await prisma.lead.create({
    data: {
      tenantId,
      firstName: 'Test',
      lastName: 'Client',
      email: `lead-${crypto.randomUUID()}@example.com`,
    },
  });
  return prisma.docCase.create({
    data: {
      tenantId,
      leadId: lead.id,
      caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      status: overrides.status ?? DocCaseStatus.ACTIVE,
      portalPhoneLast4: overrides.portalPhoneLast4 === undefined ? '1234' : overrides.portalPhoneLast4,
      portalEnabledAt: overrides.portalEnabledAt ?? null,
      createdBy: USER_ID,
    },
  });
}

async function activate(caseId: string, token?: string) {
  const res = await fetch(`${baseUrl}/api/v1/cases/${caseId}/portal/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function cleanupTestData() {
  await prisma.portalSession.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.docCaseNote.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  const cases = await prisma.docCase.findMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } }, select: { id: true, leadId: true } });
  await prisma.docCase.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.lead.deleteMany({ where: { id: { in: cases.map(c => c.leadId) } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: [USER_ID, OTHER_USER_ID] } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.session.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.user.deleteMany({ where: { id: { in: [USER_ID, OTHER_USER_ID] } } });
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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTestData();
  await prisma.$disconnect();
}, 30_000);

describe('POST /cases/:caseId/portal/activate', () => {
  it('1. unauthenticated → 401', async () => {
    const c = await createCase();
    const r = await activate(c.id);
    expect(r.status).toBe(401);
  });

  it('2. wrong tenant, no permission → 403', async () => {
    const c = await createCase();
    const r = await activate(c.id, unpermittedToken);
    // unpermittedToken belongs to OTHER_TENANT_ID which has no portal:activate permission
    expect(r.status).toBe(403);
  });

  it('3. invalid caseId → 400', async () => {
    const r = await activate('not-a-uuid', jwtToken);
    expect(r.status).toBe(400);
  });

  it('4. non-existent case → 404', async () => {
    const r = await activate(crypto.randomUUID(), jwtToken);
    expect(r.status).toBe(404);
  });

  it('5. INCOMING status → 422', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    const r = await activate(c.id, jwtToken);
    expect(r.status).toBe(422);
  });

  it('6. missing portalPhoneLast4 → 400', async () => {
    const c = await createCase({ portalPhoneLast4: null });
    const r = await activate(c.id, jwtToken);
    expect(r.status).toBe(400);
  });

  it('7. valid activation → 200, portalEnabledAt set', async () => {
    const c = await createCase();
    const r = await activate(c.id, jwtToken);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.alreadyEnabled).toBe(false);
    expect(r.body.data.portalEnabledAt).toBeTruthy();

    const updated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(updated!.portalEnabledAt).toBeTruthy();
  });

  it('8. exactly one PORTAL_ACTIVATED audit record', async () => {
    const c = await createCase();
    await activate(c.id, jwtToken);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].hashVersion).toBe(1);
  });

  it('9. repeated activation → 200 idempotent, no duplicate audit', async () => {
    const c = await createCase();
    await activate(c.id, jwtToken);
    const r2 = await activate(c.id, jwtToken);

    expect(r2.status).toBe(200);
    expect(r2.body.data.alreadyEnabled).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('10. concurrent activation → exactly one audit record', async () => {
    const c = await createCase();
    const results = await Promise.all([
      activate(c.id, jwtToken),
      activate(c.id, jwtToken),
      activate(c.id, jwtToken),
    ]);

    const successes = results.filter(r => r.status === 200);
    expect(successes.length).toBe(3); // all succeed (idempotent)

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('11. response excludes portalPhoneSnapshot / portalPhoneLast4', async () => {
    const c = await createCase();
    const r = await activate(c.id, jwtToken);
    expect(r.body.data).not.toHaveProperty('portalPhoneSnapshot');
    expect(r.body.data).not.toHaveProperty('portalPhoneLast4');
  });

  it('12. deactivation revokes sessions', async () => {
    const c = await createCase({ portalEnabledAt: new Date() });

    await prisma.portalSession.create({
      data: {
        tenantId: TENANT_ID,
        caseId: c.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Deactivate + revoke sessions as PortalService.disablePortalInTx would
    await prisma.docCase.update({ where: { id: c.id }, data: { portalEnabledAt: null } });
    await prisma.portalSession.updateMany({
      where: { caseId: c.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const sessions = await prisma.portalSession.findMany({ where: { caseId: c.id } });
    expect(sessions.every(s => s.revokedAt !== null)).toBe(true);
  });

});

describe('portal auto-activation via publish flow (reconcilePortalActivation)', () => {
  const portalService = new PortalService(prisma);
  const ctx = { tenantId: TENANT_ID, userId: USER_ID };

  async function createNote(caseId: string) {
    return prisma.docCaseNote.create({
      data: {
        tenantId: TENANT_ID,
        caseId,
        content: 'Test note for portal activation',
        createdBy: USER_ID,
        clientVisible: false,
      },
    });
  }

  it('13. publish note on ACTIVE case → auto-activates portal + PORTAL_AUTO_ACTIVATED audit', async () => {
    const c = await createCase();
    const note = await createNote(c.id);

    await portalService.setNoteVisibility(ctx, note.id, true);

    const updated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(updated!.portalEnabledAt).toBeTruthy();

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_AUTO_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].hashVersion).toBe(1);
  });

  it('14. publish note on INCOMING case → does NOT auto-activate', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    const note = await createNote(c.id);

    await portalService.setNoteVisibility(ctx, note.id, true);

    const updated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(updated!.portalEnabledAt).toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_AUTO_ACTIVATED' },
    });
    expect(audits).toHaveLength(0);
  });

  it('15. publish note on case with no portalPhoneLast4 → does NOT auto-activate', async () => {
    const c = await createCase({ portalPhoneLast4: null });
    const note = await createNote(c.id);

    await portalService.setNoteVisibility(ctx, note.id, true);

    const updated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(updated!.portalEnabledAt).toBeNull();
  });

  it('16. publish twice on same case → exactly one PORTAL_AUTO_ACTIVATED audit (idempotent)', async () => {
    const c = await createCase();
    const note1 = await createNote(c.id);
    const note2 = await createNote(c.id);

    await portalService.setNoteVisibility(ctx, note1.id, true);
    await portalService.setNoteVisibility(ctx, note2.id, true);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_AUTO_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('17. unpublish all visible content → deactivates portal + revokes sessions + PORTAL_DEACTIVATED audit', async () => {
    const c = await createCase();
    const note = await createNote(c.id);

    // Activate via publish
    await portalService.setNoteVisibility(ctx, note.id, true);
    const activated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(activated!.portalEnabledAt).toBeTruthy();

    // Create a portal session while active
    await prisma.portalSession.create({
      data: {
        tenantId: TENANT_ID,
        caseId: c.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Unpublish → should deactivate + revoke sessions
    await portalService.setNoteVisibility(ctx, note.id, false);

    const deactivated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(deactivated!.portalEnabledAt).toBeNull();

    const sessions = await prisma.portalSession.findMany({ where: { caseId: c.id } });
    expect(sessions.every(s => s.revokedAt !== null)).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_DEACTIVATED' },
    });
    expect(audits).toHaveLength(1);
  });
});

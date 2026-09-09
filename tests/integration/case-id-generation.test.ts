/**
 * Case ID generation — integration tests.
 *
 * Tests the generateCaseNumber domain function (format + uniqueness),
 * the POST /cases/:caseId/generate-case-id endpoint (idempotency, RBAC, tenant
 * isolation), and that confirmHandoff auto-assigns a case number.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { generateCaseNumber } from '../../src/domain/caseNumber';
import { createCasesRouter } from '../../src/routes/handoff.router';
import { HandoffService } from '../../src/services/handoff.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

const TENANT_ID      = crypto.randomUUID();
const USER_ID        = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const OTHER_USER_ID  = crypto.randomUUID();

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
    console.error('[case-id-generation-test] Unhandled error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

async function seedTestData() {
  await prisma.tenant.createMany({
    data: [
      { id: TENANT_ID, name: 'CaseId Test Tenant' },
      { id: OTHER_TENANT_ID, name: 'Other Tenant (CaseId)' },
    ],
  });

  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.createMany({
    data: [
      { id: USER_ID, email: `caseid-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: OTHER_USER_ID, email: `other-${OTHER_TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: OTHER_TENANT_ID },
    ],
  });

  const role = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'CaseId Test Admin', isSystem: true } });

  const perms = await prisma.permission.findMany({
    where: { slug: { in: ['cases:generate-id', 'handoff:submit'] } },
  });
  if (perms.length < 2) throw new Error('cases:generate-id or handoff:submit permission not seeded — run prisma migrate deploy');

  await prisma.rolePermission.createMany({
    data: perms.map(p => ({ roleId: role.id, permissionId: p.id })),
  });
  await prisma.userRole.create({ data: { userId: USER_ID, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });

  const session = await prisma.session.create({
    data: {
      tenantId: TENANT_ID, userId: USER_ID, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  jwtToken = jwt.sign({ userId: USER_ID, tenantId: TENANT_ID, sessionId: session.id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

  // Unpermitted: other tenant, no cases:generate-id
  const otherRole = await prisma.role.create({ data: { tenantId: OTHER_TENANT_ID, name: 'Other Role', isSystem: true } });
  await prisma.userRole.create({ data: { userId: OTHER_USER_ID, roleId: otherRole.id, scopeType: ScopeType.ORGANIZATION } });
  const otherSession = await prisma.session.create({
    data: {
      tenantId: OTHER_TENANT_ID, userId: OTHER_USER_ID, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  unpermittedToken = jwt.sign({ userId: OTHER_USER_ID, tenantId: OTHER_TENANT_ID, sessionId: otherSession.id }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

/** Creates a Lead + DocCase WITHOUT a caseNumber so generation can be tested. */
async function createCaseWithoutNumber(tenantId = TENANT_ID, status: DocCaseStatus = DocCaseStatus.ACTIVE) {
  const lead = await prisma.lead.create({
    data: { tenantId, firstName: 'Gen', lastName: 'Test', email: `gen-${crypto.randomUUID()}@example.com` },
  });
  return prisma.docCase.create({
    data: { tenantId, leadId: lead.id, status, createdBy: USER_ID },
  });
}

async function postGenerateCaseId(caseId: string, token?: string) {
  const res = await fetch(`${baseUrl}/api/v1/cases/${caseId}/generate-case-id`, {
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTestData();
  await prisma.$disconnect();
});

describe('generateCaseNumber — format and uniqueness', () => {
  it('1a. generates 100 unique IDs all matching HPX-XXXX-XXXX format', () => {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const re = new RegExp(`^HPX-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);
    const ids = Array.from({ length: 100 }, () => generateCaseNumber());
    for (const id of ids) expect(id).toMatch(re);
    const unique = new Set(ids);
    expect(unique.size).toBe(100);
  });
});

describe('POST /cases/:caseId/generate-case-id', () => {
  it('2. idempotent — second call returns same ID with alreadyGenerated:true', async () => {
    const c = await createCaseWithoutNumber();
    const r1 = await postGenerateCaseId(c.id, jwtToken);
    expect(r1.status).toBe(200);
    expect(r1.body.data.alreadyGenerated).toBe(false);
    const { caseNumber } = r1.body.data;

    const r2 = await postGenerateCaseId(c.id, jwtToken);
    expect(r2.status).toBe(200);
    expect(r2.body.data.alreadyGenerated).toBe(true);
    expect(r2.body.data.caseNumber).toBe(caseNumber);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'CASE_ID_GENERATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('3. confirmHandoff auto-assigns caseNumber on the returned DocCase', async () => {
    const lead = await prisma.lead.create({
      data: { tenantId: TENANT_ID, firstName: 'Handoff', lastName: 'Test', email: `hoff-${crypto.randomUUID()}@example.com`, stage: 'QUALIFIED' },
    });
    const handoff = new HandoffService(prisma);
    const result = await handoff.confirmHandoff({ tenantId: TENANT_ID, userId: USER_ID }, lead.id);
    expect(result.caseNumber).toBeTruthy();
    expect(result.caseNumber).toMatch(/^HPX-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('4. missing permission → 403', async () => {
    const c = await createCaseWithoutNumber();
    const r = await postGenerateCaseId(c.id, unpermittedToken);
    expect(r.status).toBe(403);
  });

  it('5. wrong tenant caseId → 404', async () => {
    // Create a case under OTHER_TENANT but call with USER's token (TENANT_ID)
    const otherLead = await prisma.lead.create({
      data: { tenantId: OTHER_TENANT_ID, firstName: 'Other', lastName: 'Lead', email: `other-gen-${crypto.randomUUID()}@example.com` },
    });
    const otherCase = await prisma.docCase.create({
      data: { tenantId: OTHER_TENANT_ID, leadId: otherLead.id, status: DocCaseStatus.ACTIVE, createdBy: OTHER_USER_ID },
    });
    const r = await postGenerateCaseId(otherCase.id, jwtToken);
    expect(r.status).toBe(404);
  });
});

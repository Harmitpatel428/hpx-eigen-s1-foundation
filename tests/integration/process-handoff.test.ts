/**
 * Documentation → Process handover (Option B) — integration tests.
 *
 * Exercises the real routes against PostgreSQL:
 *   POST /api/v1/documentation/cases/:id/transfer  (doc:transfer)
 *   GET  /api/v1/process/cases                      (process:view)
 *   POST /api/v1/process/cases/:id/accept           (process:accept)
 *   POST /api/v1/process/cases/:id/return           (process:return)
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, ProcessHandoffState, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { createProcessRouter } from '../../src/routes/process.router';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();   // doc:transfer + process:*
const NOPERMS_ID = crypto.randomUUID(); // nothing

let adminToken: string;
let noPermsToken: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/documentation', createDocumentationRouter(prisma));
  app.use('/api/v1/process', createProcessRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[process-handoff-test] Unhandled error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

async function makeSession(userId: string): Promise<string> {
  const session = await prisma.session.create({
    data: {
      tenantId: TENANT_ID, userId, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return jwt.sign({ userId, tenantId: TENANT_ID, sessionId: session.id }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function seed() {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Process Test Tenant' } });
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.createMany({
    data: [
      { id: ADMIN_ID, email: `ph-admin-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: NOPERMS_ID, email: `ph-nop-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
    ],
  });

  const slugs = ['doc:transfer', 'process:view', 'process:accept', 'process:return'];
  const perms = await prisma.permission.findMany({ where: { slug: { in: slugs } } });
  if (perms.length !== slugs.length) {
    throw new Error(`process/doc permissions not seeded (found ${perms.length}/${slugs.length}) — run prisma migrate deploy`);
  }

  const adminRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'PH Admin', isSystem: true } });
  await prisma.rolePermission.createMany({ data: perms.map(p => ({ roleId: adminRole.id, permissionId: p.id })) });
  await prisma.userRole.create({ data: { userId: ADMIN_ID, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION } });

  const noPermsRole = await prisma.role.create({ data: { tenantId: TENANT_ID, name: 'PH NoPerms' } });
  await prisma.userRole.create({ data: { userId: NOPERMS_ID, roleId: noPermsRole.id, scopeType: ScopeType.ORGANIZATION } });

  adminToken = await makeSession(ADMIN_ID);
  noPermsToken = await makeSession(NOPERMS_ID);
}

async function createCase(status: DocCaseStatus = DocCaseStatus.ACTIVE, isReady = true) {
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, firstName: 'PH', lastName: 'Test', email: `ph-${crypto.randomUUID()}@example.com` },
  });
  return prisma.docCase.create({
    data: {
      tenantId: TENANT_ID, leadId: lead.id,
      caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      status, isReady, createdBy: ADMIN_ID,
    },
  });
}

function post(path: string, token?: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
function get(path: string, token?: string) {
  return fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

const transfer = (id: string, token = adminToken, remarks?: string) =>
  post(`/api/v1/documentation/cases/${id}/transfer`, token, remarks ? { remarks } : {});
const accept = (id: string, token = adminToken) => post(`/api/v1/process/cases/${id}/accept`, token);
const ret = (id: string, reasonCode?: string, note?: string, token = adminToken) =>
  post(`/api/v1/process/cases/${id}/return`, token, { reasonCode, note });

beforeAll(async () => {
  await seed();
  server = makeTestApp().listen(0);
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>(res => server.close(() => res()));
  await prisma.$disconnect();
});

describe('Doc → Process handover', () => {
  it('transfer → appears in queue → accept → leaves queue', async () => {
    const c = await createCase();
    expect((await transfer(c.id)).status).toBe(200);

    const after = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe(DocCaseStatus.PENDING_PROCESS_REVIEW);
    expect(after?.processHandoffState).toBe(ProcessHandoffState.PENDING_REVIEW);

    const queue = await get('/api/v1/process/cases', adminToken);
    expect(queue.status).toBe(200);
    expect(queue.body.data.some((x: any) => x.id === c.id)).toBe(true);

    expect((await accept(c.id)).status).toBe(200);
    const accepted = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(accepted?.status).toBe(DocCaseStatus.TRANSFERRED_TO_PROCESS);
    expect(accepted?.processAssignedTo).toBe(ADMIN_ID);

    const queue2 = await get('/api/v1/process/cases', adminToken);
    expect(queue2.body.data.some((x: any) => x.id === c.id)).toBe(false);
  });

  it('transfer → return (reason) → RETURNED_TO_DOCUMENTATION → re-transfer', async () => {
    const c = await createCase();
    await transfer(c.id);
    const r = await ret(c.id, 'MISSING_DOCUMENT');
    expect(r.status).toBe(200);
    const returned = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(returned?.status).toBe(DocCaseStatus.RETURNED_TO_DOCUMENTATION);
    expect(returned?.processReturnCount).toBe(1);
    expect(returned?.processReturnReasonCode).toBe('MISSING_DOCUMENT');
    // Re-transfer after a return is allowed.
    expect((await transfer(c.id)).status).toBe(200);
  });

  it('rejects return with no reason (400) and OTHER with no note (400)', async () => {
    const c = await createCase();
    await transfer(c.id);
    expect((await ret(c.id, undefined)).status).toBe(400);
    expect((await ret(c.id, 'OTHER', '')).status).toBe(400);
    // OTHER with a note succeeds.
    expect((await ret(c.id, 'OTHER', 'client sent the wrong entity')).status).toBe(200);
  });

  it('rejects accept of a non-pending case (422)', async () => {
    const c = await createCase(); // ACTIVE, never transferred
    expect((await accept(c.id)).status).toBe(422);
  });

  it('enforces permissions (403) for a user with none', async () => {
    const c = await createCase();
    expect((await transfer(c.id, noPermsToken)).status).toBe(403);
    expect((await get('/api/v1/process/cases', noPermsToken)).status).toBe(403);
    await transfer(c.id); // put it in the queue as admin
    expect((await accept(c.id, noPermsToken)).status).toBe(403);
    expect((await ret(c.id, 'MISSING_DOCUMENT', undefined, noPermsToken)).status).toBe(403);
  });

  it('concurrent transfer: exactly one wins, no double-apply', async () => {
    const c = await createCase();
    const [a, b] = await Promise.all([transfer(c.id), transfer(c.id)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter(s => s === 200)).toHaveLength(1);           // exactly one success
    expect(statuses.find(s => s !== 200)).toBeGreaterThanOrEqual(409); // other lost (409 race or 422 stale)
    const events = await prisma.docCaseEvent.count({
      where: { caseId: c.id, eventType: 'PROCESS_REVIEW_REQUESTED' },
    });
    expect(events).toBe(1); // no duplicate state change
  });
});

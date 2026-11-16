/**
 * GET /api/v1/documentation/cases/:caseId/documents/download-all — streaming ZIP.
 * Real Postgres + the real documentation router; S3 is mocked so getObjectStream yields known bytes we can
 * checksum. Proves: ZIP integrity (sha256 per entry incl. binary, unicode names, deduped collisions), the
 * authz matrix (401 / 403 / 404 cross-tenant / 409 empty), ≥32MB streamed integrity, and audit rows written.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import { unzipSync } from 'fflate';
import { PrismaClient, ScopeType, UserStatus, DocCaseStatus } from '@prisma/client';

import { createDocumentationRouter } from '../../src/routes/documentation.router';
import { storageService } from '../../src/services/storage.service';
import { AppException } from '../../src/types/exceptions';

// S3 stand-in: getObjectStream yields the bytes we registered per storageKey (spy on the singleton the
// service actually calls — reliable regardless of jest.mock hoisting).
const mockStore = new Map<string, Buffer>();

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const uid = () => crypto.randomUUID();
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const BASE = '/api/v1/documentation';

let server: http.Server; let baseUrl: string;
let tenantId: string; let otherTenantId: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, createDocumentationRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: String(err) });
  });
  return app;
}

async function makeUser(tId: string) {
  return prisma.user.create({ data: { id: uid(), tenantId: tId, email: `dla-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
}
async function makeSession(userId: string, tId: string) {
  const sid = uid();
  await prisma.session.create({ data: { id: sid, userId, tenantId: tId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  return jwt.sign({ sessionId: sid, userId, tenantId: tId }, JWT_SECRET, { expiresIn: '1h' });
}
async function permId(slug: string) { const p = await prisma.permission.findFirst({ where: { slug } }); if (!p) throw new Error(`${slug} not seeded`); return p.id; }
async function grant(tId: string, slugs: string[]) {
  const user = await makeUser(tId);
  const role = await prisma.role.create({ data: { tenantId: tId, name: `R-${uid().slice(0, 8)}` } });
  for (const s of slugs) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(s) } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { id: user.id, token: await makeSession(user.id, tId) };
}
async function makeCase(tId: string, company: string | null) {
  const lead = await prisma.lead.create({ data: { tenantId: tId, firstName: 'Dl', lastName: 'Client', company, email: `dla-${uid()}@test.invalid` } });
  const c = await prisma.docCase.create({ data: { tenantId: tId, leadId: lead.id, status: DocCaseStatus.ACTIVE, createdBy: uid() }, select: { id: true } });
  return c.id;
}
async function addDoc(tId: string, caseId: string, name: string, bytes: Buffer) {
  const storageKey = `k/${uid()}`;
  mockStore.set(storageKey, bytes);
  await prisma.document.create({ data: {
    tenantId: tId, caseId, category: 'GENERAL', name, originalFilename: name, storageKey,
    mimeType: 'application/octet-stream', sizeBytes: bytes.length, sourceChannel: 'FIRM_UPLOAD', uploadedByParty: 'FIRM',
  } });
}
async function getZip(caseId: string, token?: string) {
  const res = await fetch(`${baseUrl}${BASE}/cases/${caseId}/documents/download-all`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

beforeAll(async () => {
  jest.spyOn(storageService, 'getObjectStream').mockImplementation(async (key: string) => {
    const buf = mockStore.get(key);
    if (!buf) throw new Error(`no object ${key}`);
    return Readable.from(buf);
  });
  tenantId = uid(); otherTenantId = uid();
  await prisma.tenant.create({ data: { id: tenantId, name: 'DLA Tenant' } });
  await prisma.tenant.create({ data: { id: otherTenantId, name: 'DLA Other Tenant' } });
  const app = makeApp();
  await new Promise<void>(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r(); }); });
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  for (const t of [tenantId, otherTenantId]) {
    const users = await prisma.user.findMany({ where: { tenantId: t }, select: { id: true } });
    const roles = await prisma.role.findMany({ where: { tenantId: t }, select: { id: true } });
    await prisma.document.deleteMany({ where: { tenantId: t } });
    await prisma.docCase.deleteMany({ where: { tenantId: t } });
    await prisma.lead.deleteMany({ where: { tenantId: t } });
    await prisma.auditLog.deleteMany({ where: { tenantId: t } });
    await prisma.userRole.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map(r => r.id) } } });
    await prisma.session.deleteMany({ where: { tenantId: t } });
    await prisma.role.deleteMany({ where: { tenantId: t } });
    await prisma.user.deleteMany({ where: { tenantId: t } });
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

describe('download-all authz', () => {
  it('401 without a token', async () => {
    const c = await makeCase(tenantId, 'Acme');
    expect((await getZip(c)).status).toBe(401);
  });
  it('403 for a staff token lacking doc:view', async () => {
    const u = await grant(tenantId, ['doc:preset:view']);
    const c = await makeCase(tenantId, 'Acme');
    expect((await getZip(c, u.token)).status).toBe(403);
  });
  it('404 for another tenant\'s case (cross-tenant isolation)', async () => {
    const u = await grant(tenantId, ['doc:view', 'doc:case:view-all']);
    const c = await makeCase(otherTenantId, 'Other Co');
    await addDoc(otherTenantId, c, 'x.pdf', Buffer.from('x'));
    expect((await getZip(c, u.token)).status).toBe(404);
  });
  it('409 for a case with no documents', async () => {
    const u = await grant(tenantId, ['doc:view', 'doc:case:view-all']);
    const c = await makeCase(tenantId, 'Acme');
    expect((await getZip(c, u.token)).status).toBe(409);
  });
});

describe('download-all ZIP integrity', () => {
  it('streams a company-foldered ZIP: sha256 per entry, binary, unicode names, deduped collisions, audit rows', async () => {
    const u = await grant(tenantId, ['doc:view', 'doc:case:view-all']);
    const c = await makeCase(tenantId, 'Açme/Corp Ltd'); // slash in company must be sanitized, not create a path
    const a = crypto.randomBytes(4096);
    const b = Buffer.from('binary \x00\x01\x02\xff payload', 'binary');
    const uni = Buffer.from('unicode entry content');
    await addDoc(tenantId, c, 'Report.pdf', a);
    await addDoc(tenantId, c, 'Report.pdf', b);     // collision → "Report (2).pdf"
    await addDoc(tenantId, c, '合同_契約.pdf', uni);  // unicode filename preserved

    const r = await getZip(c, u.token);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/zip');
    expect(Number(r.headers.get('x-total-bytes'))).toBe(a.length + b.length + uni.length);

    const files = unzipSync(new Uint8Array(r.buf));
    expect(sha(files['Açme_Corp Ltd/Report.pdf'])).toBe(sha(a));
    expect(sha(files['Açme_Corp Ltd/Report (2).pdf'])).toBe(sha(b));
    expect(sha(files['Açme_Corp Ltd/合同_契約.pdf'])).toBe(sha(uni));

    const events = await prisma.auditLog.findMany({ where: { tenantId, entityId: c } });
    const types = events.map(e => e.eventType);
    expect(types).toContain('DOCUMENTS_DOWNLOAD_ALL_STARTED');
    expect(types).toContain('DOCUMENTS_DOWNLOAD_ALL_COMPLETED');
  });

  it('streams a >=32MB file with byte-intact content (streamed, not truncated)', async () => {
    const u = await grant(tenantId, ['doc:view', 'doc:case:view-all']);
    const c = await makeCase(tenantId, 'Big Co');
    const big = crypto.randomBytes(32 * 1024 * 1024 + 7);
    await addDoc(tenantId, c, 'big.bin', big);

    const r = await getZip(c, u.token);
    expect(r.status).toBe(200);
    const files = unzipSync(new Uint8Array(r.buf));
    expect(sha(files['Big Co/big.bin'])).toBe(sha(big));
  }, 30_000);
});

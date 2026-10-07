/**
 * Component-document materialization + common-document deduplication.
 * Real Postgres. Proves that overlapping components collapse into ONE shared
 * requirement, that provenance is tracked per component, that mandatory-ness is
 * the OR of active sources, and that deselection only retires rows it is safe
 * to retire (manual/adopted rows are never auto-deleted).
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, DocCaseStatus } from '@prisma/client';

import { createCaseTypesRouter, createCaseTypeAssignmentRouter } from '../../src/routes/case-types.router';
import { DocumentationService } from '../../src/services/documentation.service';
import { PermissionService } from '../../src/services/permission.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const docService = new DocumentationService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const uid = () => crypto.randomUUID();

let server: http.Server; let baseUrl: string;
const tracked: string[] = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/case-types', createCaseTypesRouter(prisma));
  app.use('/api/v1/cases/:caseId/case-type', createCaseTypeAssignmentRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) { res.status(err.httpStatus).json({ code: err.code, message: err.message }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: String(err) });
  });
  return app;
}
async function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
async function makeUser(tenantId: string) {
  return prisma.user.create({ data: { id: uid(), tenantId, email: `cdd-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
}
async function makeSession(userId: string, tenantId: string) {
  const sid = uid();
  await prisma.session.create({ data: { id: sid, userId, tenantId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3.6e6), ipAddress: '127.0.0.1', refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex') } });
  return jwt.sign({ sessionId: sid, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}
async function permId(slug: string) { const p = await prisma.permission.findFirst({ where: { slug } }); if (!p) throw new Error(`${slug} not seeded`); return p.id; }
async function grant(tenantId: string, slugs: string[]) {
  const user = await makeUser(tenantId);
  const role = await prisma.role.create({ data: { tenantId, name: `R-${uid().slice(0, 8)}` } });
  for (const s of slugs) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: await permId(s) } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { id: user.id, token: await makeSession(user.id, tenantId) };
}

const CT = '/api/v1/case-types';
let tenantId: string;
let mgr: { id: string; token: string };

async function makeActiveType(): Promise<string> {
  const id = (await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'Type' } })).body.data.id;
  await req('POST', `${CT}/${id}/publish`, { token: mgr.token });
  return id;
}
async function addComp(typeId: string, name: string): Promise<string> {
  const r = await req('POST', `${CT}/${typeId}/components`, { token: mgr.token, body: { name: `${name}-${uid().slice(0, 6)}` } });
  if (r.status !== 201) throw new Error(`addComp ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}
async function addDoc(typeId: string, compId: string, name: string, extra: { isMandatory?: boolean; displayOrder?: number } = {}): Promise<string> {
  const r = await req('POST', `${CT}/${typeId}/components/${compId}/documents`, { token: mgr.token, body: { name, ...extra } });
  if (r.status !== 201) throw new Error(`addDoc ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}
async function makeCase(status: DocCaseStatus = 'ACTIVE') {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy: mgr.id, status }, select: { id: true } });
}
function assign(caseId: string, body: unknown) {
  return req('PATCH', `/api/v1/cases/${caseId}/case-type`, { token: mgr.token, body });
}
const activeDocs = (caseId: string) =>
  prisma.docCaseDocument.findMany({ where: { caseId, deletedAt: null }, orderBy: { displayOrder: 'asc' } });
const activeSources = (documentId: string) =>
  prisma.docCaseDocumentComponentSource.findMany({ where: { tenantId, documentId, deletedAt: null } });
const read = (caseId: string) => docService.getCaseById({ tenantId, userId: mgr.id }, caseId);

/** Minimal active uploaded file against a requirement. */
async function addFile(caseId: string, requirementId: string, over: { isActive?: boolean; deletedAt?: Date } = {}) {
  return prisma.document.create({
    data: {
      tenantId, caseId, requirementId, category: 'REQUIREMENT', name: 'f.pdf', originalFilename: 'f.pdf',
      storageKey: `k/${uid()}`, mimeType: 'application/pdf', sizeBytes: 10,
      sourceChannel: 'FIRM_UPLOAD', uploadedByParty: 'FIRM',
      isActive: over.isActive ?? true, deletedAt: over.deletedAt ?? null,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  tenantId = uid();
  tracked.push(tenantId);
  await prisma.tenant.create({ data: { id: tenantId, name: 'T' } });
  await prisma.tenantSettings.create({ data: { tenantId, caseOperationsEngineEnabled: true } });
  mgr = await grant(tenantId, ['case-type:view', 'case-type:manage', 'case-type:publish', 'doc:view', 'doc:edit']);
  await permissionService.invalidatePermissionCache(tenantId);
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.document.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCaseDocumentComponentSource.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCaseDocument.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCasePolicyComponent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCasePolicyAssignment.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.updateMany({ where: { tenantId: t }, data: { caseTypeId: null } }).catch(() => {});
    await prisma.caseTypeComponentDocument.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTypeComponent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseType.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId: t } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId: t } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenantSettings.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 30_000);

/** A(PAN,GST,Bank) B(PAN,GST,Electricity) C(PAN*,Partnership) — PAN mandatory only under C. */
async function abcFixture() {
  const type = await makeActiveType();
  const A = await addComp(type, 'A'), B = await addComp(type, 'B'), C = await addComp(type, 'C');
  await addDoc(type, A, 'PAN');            await addDoc(type, A, 'GST Certificate'); await addDoc(type, A, 'Bank Statement');
  await addDoc(type, B, 'PAN');            await addDoc(type, B, 'GST Certificate'); await addDoc(type, B, 'Electricity Bill');
  await addDoc(type, C, 'PAN', { isMandatory: true }); await addDoc(type, C, 'Partnership Deed');
  return { type, A, B, C };
}

describe('Deduplication', () => {
  it('A+B+C yield exactly five shared requirements with correct provenance and mandatory-OR', async () => {
    const { type, A, B, C } = await abcFixture();
    const kase = await makeCase();
    expect((await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, B, C] }] })).status).toBe(200);

    const docs = await activeDocs(kase.id);
    expect(docs.map(d => d.name).sort()).toEqual(['Bank Statement', 'Electricity Bill', 'GST Certificate', 'PAN', 'Partnership Deed']);
    expect(docs).toHaveLength(5);
    for (const d of docs) expect(d.isComponentMerged).toBe(true);

    const pan = docs.find(d => d.name === 'PAN')!;
    const gst = docs.find(d => d.name === 'GST Certificate')!;
    const bank = docs.find(d => d.name === 'Bank Statement')!;
    expect(pan.requirementDedupeKey).toBe('compdoc:pan');

    const panComps = (await activeSources(pan.id)).map(s => s.componentId).sort();
    expect(panComps).toEqual([A, B, C].sort());
    const gstComps = (await activeSources(gst.id)).map(s => s.componentId).sort();
    expect(gstComps).toEqual([A, B].sort());
    expect((await activeSources(bank.id)).map(s => s.componentId)).toEqual([A]);

    // PAN is mandatory under C only — the shared row is mandatory (OR).
    expect(pan.isMandatory).toBe(true);
    expect(gst.isMandatory).toBe(false);
  });

  it('read model exposes componentSources with component names for the shared row', async () => {
    const { type, A, B } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, B] }] });
    const r = await read(kase.id);
    const pan = r.documents.find(d => d.name === 'PAN')!;
    expect(pan.isComponentMerged).toBe(true);
    expect(pan.requirementDedupeKey).toBe('compdoc:pan');
    expect(pan.componentSources).toHaveLength(2);
    expect(pan.componentSources.every(s => s.componentName && s.componentDocumentName === 'PAN')).toBe(true);
  });

  it('normalization merges "PAN" with " pan "; different names do not merge', async () => {
    const type = await makeActiveType();
    const A = await addComp(type, 'A'), B = await addComp(type, 'B');
    await addDoc(type, A, 'PAN');
    await addDoc(type, B, ' pan ');
    await addDoc(type, B, 'PAN Card');          // different key -> separate row
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, B] }] });
    const docs = await activeDocs(kase.id);
    expect(docs).toHaveLength(2);
    const merged = docs.find(d => d.requirementDedupeKey === 'compdoc:pan')!;
    expect((await activeSources(merged.id))).toHaveLength(2);
    expect(docs.some(d => d.requirementDedupeKey === 'compdoc:pan card')).toBe(true);
  });

  it('a later component links to the existing shared row instead of duplicating', async () => {
    const { type, A, B } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const panBefore = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;
    expect(await activeSources(panBefore.id)).toHaveLength(1);

    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, B] }] });
    const pans = (await activeDocs(kase.id)).filter(d => d.name === 'PAN');
    expect(pans).toHaveLength(1);
    expect(pans[0].id).toBe(panBefore.id);
    expect(await activeSources(panBefore.id)).toHaveLength(2);
  });

  it('archived presets create no requirement, and archiving one later leaves existing sources alone', async () => {
    const type = await makeActiveType();
    const A = await addComp(type, 'A');
    const live = await addDoc(type, A, 'PAN');
    const dead = await addDoc(type, A, 'Obsolete');
    await req('PATCH', `${CT}/${type}/components/${A}/documents/${dead}`, { token: mgr.token, body: { isActive: false } });

    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    expect((await activeDocs(kase.id)).map(d => d.name)).toEqual(['PAN']);

    // Archiving an already-materialized preset must not retroactively unlink it.
    await req('PATCH', `${CT}/${type}/components/${A}/documents/${live}`, { token: mgr.token, body: { isActive: false } });
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A], proposalDate: '2026-03-01' }] });
    const docs = await activeDocs(kase.id);
    expect(docs.map(d => d.name)).toEqual(['PAN']);
    expect(await activeSources(docs[0].id)).toHaveLength(1);
  });

  it('a preset added after selection materializes on the next assignPolicies save; repeated saves do not duplicate', async () => {
    const { type, A } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    expect(await activeDocs(kase.id)).toHaveLength(3);

    // Add a preset to the already-selected component. The next save — even a
    // date-only edit with an unchanged selection — must surface it.
    await addDoc(type, A, 'Late Addition');
    await assign(kase.id, { policies: [{ caseTypeId: type, proposalDate: '2026-04-01' }] });
    let docs = await activeDocs(kase.id);
    expect(docs.map(d => d.name)).toContain('Late Addition');
    expect(docs).toHaveLength(4);

    // Saving again re-runs materialization but must not duplicate.
    await assign(kase.id, { policies: [{ caseTypeId: type, proposalDate: '2026-05-01' }] });
    docs = await activeDocs(kase.id);
    expect(docs).toHaveLength(4);
    expect(docs.filter(d => d.name === 'Late Addition')).toHaveLength(1);
  });
});

describe('Deselection', () => {
  it('deselecting one component keeps shared rows that still have sources, and soft-deletes only its link', async () => {
    const { type, A, B } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, B] }] });
    const pan = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;
    expect(await activeSources(pan.id)).toHaveLength(2);

    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: pan.id } }))!.deletedAt).toBeNull();
    const left = await activeSources(pan.id);
    expect(left).toHaveLength(1);
    expect(left[0].componentId).toBe(A);
    // B-only requirement is gone, A-only remains
    const names = (await activeDocs(kase.id)).map(d => d.name).sort();
    expect(names).toEqual(['Bank Statement', 'GST Certificate', 'PAN']);
  });

  it('removing the mandatory source recomputes isMandatory from the remaining sources', async () => {
    const { type, A, C } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, C] }] });
    const panId = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!.id;
    expect((await prisma.docCaseDocument.findUnique({ where: { id: panId } }))!.isMandatory).toBe(true);

    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: panId } }))!.isMandatory).toBe(false);
  });

  it('deselecting the last source soft-deletes a safe shared row, and reselecting revives row + link', async () => {
    const { type, A } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const pan = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;

    // swap A out for a component with no overlap
    const B2 = await addComp(type, 'B2'); await addDoc(type, B2, 'Unrelated');
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [B2] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: pan.id } }))!.deletedAt).not.toBeNull();

    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const revived = await prisma.docCaseDocument.findUnique({ where: { id: pan.id } });
    expect(revived!.deletedAt).toBeNull();
    expect(await activeSources(pan.id)).toHaveLength(1);
    // revive, never duplicate
    expect((await prisma.docCaseDocument.findMany({ where: { caseId: kase.id, requirementDedupeKey: 'compdoc:pan' } }))).toHaveLength(1);
  });

  it('a shared row with progress is kept when its last source goes; an active file blocks, a dead file does not', async () => {
    const { type, A } = await abcFixture();
    const other = await addComp(type, 'Other'); await addDoc(type, other, 'Unrelated');

    // (a) progress on the row -> kept
    const k1 = await makeCase();
    await assign(k1.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const pan1 = (await activeDocs(k1.id)).find(d => d.name === 'PAN')!;
    await prisma.docCaseDocument.update({ where: { id: pan1.id }, data: { receivedAt: new Date(), status: 'RECEIVED' } });
    await assign(k1.id, { policies: [{ caseTypeId: type, componentIds: [other] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: pan1.id } }))!.deletedAt).toBeNull();

    // (b) an ACTIVE uploaded file blocks deletion
    const k2 = await makeCase();
    await assign(k2.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const pan2 = (await activeDocs(k2.id)).find(d => d.name === 'PAN')!;
    await addFile(k2.id, pan2.id);
    await assign(k2.id, { policies: [{ caseTypeId: type, componentIds: [other] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: pan2.id } }))!.deletedAt).toBeNull();

    // (c) only inactive / soft-deleted files -> does NOT block
    const k3 = await makeCase();
    await assign(k3.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const pan3 = (await activeDocs(k3.id)).find(d => d.name === 'PAN')!;
    await addFile(k3.id, pan3.id, { isActive: false });
    await addFile(k3.id, pan3.id, { deletedAt: new Date() });
    await assign(k3.id, { policies: [{ caseTypeId: type, componentIds: [other] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: pan3.id } }))!.deletedAt).not.toBeNull();
  });

  it('removing a whole policy assignment soft-deletes its links and reconciles the shared rows', async () => {
    const t1 = await makeActiveType(); const c1 = await addComp(t1, 'One'); await addDoc(t1, c1, 'PAN');
    const t2 = await makeActiveType(); const c2 = await addComp(t2, 'Two'); await addDoc(t2, c2, 'PAN');
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: t1, componentIds: [c1] }, { caseTypeId: t2, componentIds: [c2] }] });
    const pan = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;
    expect(await activeSources(pan.id)).toHaveLength(2);

    // drop the whole t2 assignment
    await assign(kase.id, { policies: [{ caseTypeId: t1, componentIds: [c1] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: pan.id } }))!.deletedAt).toBeNull();
    expect(await activeSources(pan.id)).toHaveLength(1);
  });
});

describe('Manual document adoption', () => {
  it('adopts a matching manual row instead of duplicating, and never auto-deletes it', async () => {
    const { type, A } = await abcFixture();
    const other = await addComp(type, 'Other'); await addDoc(type, other, 'Unrelated');
    const kase = await makeCase();
    const manual = await prisma.docCaseDocument.create({
      data: { tenantId, caseId: kase.id, name: ' PAN ', displayOrder: 99, status: 'REQUESTED', metadataValues: {}, clientVisible: false },
    });

    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const pans = await prisma.docCaseDocument.findMany({ where: { caseId: kase.id, deletedAt: null, requirementDedupeKey: 'compdoc:pan' } });
    expect(pans).toHaveLength(1);
    expect(pans[0].id).toBe(manual.id);              // adopted, not duplicated
    expect(pans[0].name).toBe(' PAN ');              // name untouched
    expect(pans[0].isComponentMerged).toBe(false);   // stays manual-origin -> protected
    expect(await activeSources(manual.id)).toHaveLength(1);

    // losing the last source resets mandatory but must NOT delete a manual row
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [other] }] });
    const after = await prisma.docCaseDocument.findUnique({ where: { id: manual.id } });
    expect(after!.deletedAt).toBeNull();
    expect(after!.isMandatory).toBe(false);
    expect(after!.status).toBe('REQUESTED');
    expect(after!.clientVisible).toBe(false);
  });

  it('never adopts a legacy component row or one that carries a policy pointer', async () => {
    const { type, A } = await abcFixture();
    const kase = await makeCase();
    // looks like a legacy component-generated row: keyed legacy:* with a policy pointer
    const legacyish = await prisma.docCaseDocument.create({
      data: { tenantId, caseId: kase.id, name: 'PAN', displayOrder: 50, status: 'REQUESTED', metadataValues: {}, requirementDedupeKey: `legacy:${uid()}` },
    });
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const shared = await prisma.docCaseDocument.findFirst({ where: { caseId: kase.id, requirementDedupeKey: 'compdoc:pan', deletedAt: null } });
    expect(shared).not.toBeNull();
    expect(shared!.id).not.toBe(legacyish.id);       // a new shared row, legacy left alone
    expect(shared!.isComponentMerged).toBe(true);
    expect((await prisma.docCaseDocument.findUnique({ where: { id: legacyish.id } }))!.requirementDedupeKey).toMatch(/^legacy:/);
  });

  it('picks the deterministic candidate when several manual rows share the normalized name', async () => {
    const { type, A } = await abcFixture();
    const kase = await makeCase();
    const low = await prisma.docCaseDocument.create({ data: { tenantId, caseId: kase.id, name: 'pan', displayOrder: 1, status: 'REQUESTED', metadataValues: {} } });
    const high = await prisma.docCaseDocument.create({ data: { tenantId, caseId: kase.id, name: 'PAN', displayOrder: 7, status: 'REQUESTED', metadataValues: {} } });
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    // lowest displayOrder wins
    expect((await prisma.docCaseDocument.findUnique({ where: { id: low.id } }))!.requirementDedupeKey).toBe('compdoc:pan');
    expect((await prisma.docCaseDocument.findUnique({ where: { id: high.id } }))!.requirementDedupeKey).toBeNull();
  });
});

describe('Legacy rows and upload satisfaction', () => {
  it('a legacy component row stays unmerged yet is still safe-deletable on deselection', async () => {
    const { type, A } = await abcFixture();
    const other = await addComp(type, 'Other'); await addDoc(type, other, 'Unrelated');
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const sel = (await prisma.docCasePolicyComponent.findFirst({ where: { tenantId, caseId: kase.id, componentId: A, deletedAt: null } }))!;

    // emulate a pre-dedupe row: policy pointer + legacy key, no source links
    const legacy = await prisma.docCaseDocument.create({
      data: {
        tenantId, caseId: kase.id, name: 'Legacy Req', displayOrder: 80, status: 'REQUESTED', metadataValues: {},
        policyAssignmentId: sel.policyAssignmentId, policyComponentId: sel.id, requirementDedupeKey: `legacy:${sel.id}`,
      },
    });
    expect(legacy.isComponentMerged).toBe(false);

    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [other] }] });
    // the origin gate allows it (policyComponentId set) and it is untouched
    expect((await prisma.docCaseDocument.findUnique({ where: { id: legacy.id } }))!.deletedAt).not.toBeNull();
  });

  it('one upload against the shared row satisfies every source component', async () => {
    const { type, A, B, C } = await abcFixture();
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A, B, C] }] });
    const pan = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;
    await addFile(kase.id, pan.id);
    await prisma.docCaseDocument.update({ where: { id: pan.id }, data: { status: 'APPROVED', receivedAt: new Date() } });

    const r = await read(kase.id);
    const shared = r.documents.filter(d => d.requirementDedupeKey === 'compdoc:pan');
    expect(shared).toHaveLength(1);                       // one row, not three
    expect(shared[0].status).toBe('APPROVED');
    // all three components observe the same satisfied row
    expect(shared[0].componentSources.map(s => s.componentId).sort()).toEqual([A, B, C].sort());
    expect(new Set(shared[0].componentSources.map(s => s.policyComponentId)).size).toBe(3);
  });

  it('concurrent identical saves do not duplicate shared rows or links', async () => {
    const { type, A, B } = await abcFixture();
    const kase = await makeCase();
    const payload = { policies: [{ caseTypeId: type, componentIds: [A, B] }] };
    const results = await Promise.all([assign(kase.id, payload), assign(kase.id, payload), assign(kase.id, payload)]);
    // the DocCase row lock serializes them; every call must succeed
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);

    const docs = await activeDocs(kase.id);
    expect(docs.filter(d => d.requirementDedupeKey === 'compdoc:pan')).toHaveLength(1);
    expect(docs).toHaveLength(4); // PAN, GST, Bank, Electricity
    const pan = docs.find(d => d.name === 'PAN')!;
    const links = await activeSources(pan.id);
    expect(links).toHaveLength(2);
    expect(new Set(links.map(l => `${l.policyComponentId}:${l.componentDocumentId}`)).size).toBe(2);
  });
});

describe('Propagation of newly-added component documents', () => {
  it('POSTing a preset to an already-selected component materializes it into the case and recalcs totalDocs', async () => {
    const type = await makeActiveType();
    const A = await addComp(type, 'A'); // no presets yet
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    expect(await activeDocs(kase.id)).toHaveLength(0);

    // POST goes through the router, which propagates into live cases.
    const posted = await req('POST', `${CT}/${type}/components/${A}/documents`, { token: mgr.token, body: { name: 'PAN', isMandatory: true } });
    expect(posted.status).toBe(201);

    const docs = await activeDocs(kase.id);
    expect(docs.map(d => d.name)).toEqual(['PAN']);
    const link = await activeSources(docs[0].id);
    expect(link).toHaveLength(1);
    expect(link[0].componentId).toBe(A);
    expect((await prisma.docCase.findUnique({ where: { id: kase.id }, select: { totalDocs: true } }))!.totalDocs).toBe(1);
  });

  it('propagation skips terminal and transferred cases', async () => {
    const type = await makeActiveType();
    const A = await addComp(type, 'A');
    // selections created while the cases are still ACTIVE
    const closed = await makeCase(); const transferred = await makeCase(); const cancelled = await makeCase();
    for (const k of [closed, transferred, cancelled]) await assign(k.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    await prisma.docCase.update({ where: { id: closed.id }, data: { status: 'CLOSED' } });
    await prisma.docCase.update({ where: { id: transferred.id }, data: { status: 'TRANSFERRED_TO_PROCESS' } });
    await prisma.docCase.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });

    expect((await req('POST', `${CT}/${type}/components/${A}/documents`, { token: mgr.token, body: { name: 'PAN' } })).status).toBe(201);

    for (const k of [closed, transferred, cancelled]) {
      expect(await activeDocs(k.id)).toHaveLength(0);
    }
  });

  it('reactivating a preset propagates to selections created while it was archived', async () => {
    const type = await makeActiveType();
    const A = await addComp(type, 'A');
    const presetId = await addDoc(type, A, 'PAN');
    // archive the preset, THEN select the component on a case → nothing materializes
    await req('PATCH', `${CT}/${type}/components/${A}/documents/${presetId}`, { token: mgr.token, body: { isActive: false } });
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    expect(await activeDocs(kase.id)).toHaveLength(0);

    // reactivation propagates into the existing selection
    expect((await req('PATCH', `${CT}/${type}/components/${A}/documents/${presetId}`, { token: mgr.token, body: { isActive: true } })).status).toBe(200);
    expect((await activeDocs(kase.id)).map(d => d.name)).toEqual(['PAN']);
  });

  it('propagation creates no duplicate when the source already exists', async () => {
    const type = await makeActiveType();
    const A = await addComp(type, 'A');
    const presetId = await addDoc(type, A, 'PAN');
    const kase = await makeCase();
    await assign(kase.id, { policies: [{ caseTypeId: type, componentIds: [A] }] });
    const pan = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;
    expect(await activeSources(pan.id)).toHaveLength(1);

    // a redundant isActive:true PATCH re-propagates; the source upsert is idempotent
    expect((await req('PATCH', `${CT}/${type}/components/${A}/documents/${presetId}`, { token: mgr.token, body: { isActive: true } })).status).toBe(200);
    expect(await activeDocs(kase.id)).toHaveLength(1);
    expect(await activeSources(pan.id)).toHaveLength(1);
  });
});

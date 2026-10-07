/**
 * Documentation multi-policy assignment — integration tests. Real Postgres.
 * Covers the new {policies} shape on PATCH /cases/:id/case-type, legacy
 * compatibility, component selection rules, document generation/deselect safety,
 * primary canonicalization, derived legacy read model, and RBAC/tenant/engine gates.
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `dpa-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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
async function makeCase(tenantId: string, createdBy: string, status: DocCaseStatus = 'ACTIVE') {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy, status }, select: { id: true, caseTypeId: true, status: true, completionPercent: true, isReady: true } });
}

const CT = '/api/v1/case-types';
let tenantId: string, otherTenantId: string, disabledTenantId: string;
let mgr: { id: string; token: string }, noEdit: { token: string }, disabledMgr: { token: string }, otherMgr: { id: string; token: string };

async function makeActiveType(): Promise<string> {
  const id = (await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'Type' } })).body.data.id;
  await req('POST', `${CT}/${id}/publish`, { token: mgr.token });
  return id;
}
async function makeDraftType(): Promise<string> {
  return (await req('POST', CT, { token: mgr.token, body: { key: `t_${uid().slice(0, 8)}`, name: 'Draft' } })).body.data.id;
}
async function addComp(typeId: string, name: string, extra: { isMandatory?: boolean; displayOrder?: number } = {}): Promise<string> {
  const r = await req('POST', `${CT}/${typeId}/components`, { token: mgr.token, body: { name, ...extra } });
  if (r.status !== 201) throw new Error(`addComp failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}
/** A component only yields requirements through its document preset lines. */
async function addCompDoc(typeId: string, compId: string, name: string, extra: { isMandatory?: boolean; displayOrder?: number } = {}): Promise<string> {
  const r = await req('POST', `${CT}/${typeId}/components/${compId}/documents`, { token: mgr.token, body: { name, ...extra } });
  if (r.status !== 201) throw new Error(`addCompDoc failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}
/** Component + one preset line of the same name (the old one-doc-per-component shape). */
async function addCompWithDoc(typeId: string, name: string, extra: { isMandatory?: boolean; displayOrder?: number } = {}): Promise<string> {
  const compId = await addComp(typeId, name, extra);
  await addCompDoc(typeId, compId, name, extra);
  return compId;
}
async function activeDocs(caseId: string) {
  return prisma.docCaseDocument.findMany({ where: { caseId, deletedAt: null }, orderBy: { displayOrder: 'asc' } });
}
function assign(caseId: string, body: unknown, token = mgr.token) {
  return req('PATCH', `/api/v1/cases/${caseId}/case-type`, { token, body });
}

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  mgr = await grant(tenantId, ['case-type:view', 'case-type:manage', 'case-type:publish', 'doc:view', 'doc:edit']);
  noEdit = await grant(tenantId, ['case-type:view', 'doc:view']);
  disabledMgr = await grant(disabledTenantId, ['case-type:view', 'case-type:manage', 'doc:edit']);
  otherMgr = await grant(otherTenantId, ['case-type:view', 'case-type:manage', 'case-type:publish', 'doc:edit']);
  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    // Source rows hold Restrict FKs to component/componentDocument — drop them first.
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

describe('Legacy compatibility', () => {
  it('legacy single assignment still works; no policy rows, no docs, recalc untouched; audited', async () => {
    const type = await makeActiveType();
    const c = await makeCase(tenantId, mgr.id);
    const r = await assign(c.id, { caseTypeId: type });
    expect(r.status).toBe(200);
    expect(r.body.data.caseTypeId).toBe(type);
    expect(await prisma.docCasePolicyAssignment.count({ where: { caseId: c.id } })).toBe(0);
    expect((await activeDocs(c.id)).length).toBe(0);
    const after = await prisma.docCase.findUnique({ where: { id: c.id }, select: { status: true, completionPercent: true, isReady: true } });
    expect(after).toEqual({ status: c.status, completionPercent: c.completionPercent, isReady: c.isReady });
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: 'CASE_TYPE_ASSIGNED', entityId: c.id } })).toBe(1);
  });

  it('legacy null clears only caseTypeId; leaves existing policy rows/docs intact', async () => {
    const type = await makeActiveType();
    const comp = await addCompWithDoc(type, 'Aadhaar');
    const c = await makeCase(tenantId, mgr.id);
    await assign(c.id, { policies: [{ caseTypeId: type, componentIds: [comp] }] });
    expect(await prisma.docCasePolicyAssignment.count({ where: { caseId: c.id, deletedAt: null } })).toBe(1);
    const r = await assign(c.id, { caseTypeId: null });
    expect(r.status).toBe(200);
    expect((await prisma.docCase.findUnique({ where: { id: c.id } }))!.caseTypeId).toBeNull();
    // legacy clear does NOT touch assignment rows / generated docs
    expect(await prisma.docCasePolicyAssignment.count({ where: { caseId: c.id, deletedAt: null } })).toBe(1);
    expect((await activeDocs(c.id)).length).toBe(1);
  });

  it('derived legacy assignment appears in read model; new-shape save materializes real rows', async () => {
    const type = await makeActiveType();
    const c = await makeCase(tenantId, mgr.id);
    await assign(c.id, { caseTypeId: type }); // legacy → no rows
    const read1 = await docService.getCaseById({ tenantId, userId: mgr.id }, c.id);
    expect(read1.policyAssignments).toHaveLength(1);
    expect(read1.policyAssignments[0]).toMatchObject({ caseTypeId: type, derived: true, isPrimary: true, id: `legacy:${type}` });

    // new-shape save of the same type → real assignment row, retained (not rejected)
    const r = await assign(c.id, { policies: [{ caseTypeId: type }] });
    expect(r.status).toBe(200);
    const rows = await prisma.docCasePolicyAssignment.findMany({ where: { caseId: c.id, deletedAt: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0].caseTypeId).toBe(type);
    const read2 = await docService.getCaseById({ tenantId, userId: mgr.id }, c.id);
    expect(read2.policyAssignments[0].derived).toBe(false);
  });
});

describe('Validation (400) and structural rules', () => {
  it('neither body → 400; both bodies → 400', async () => {
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, {})).status).toBe(400);
    const type = await makeActiveType();
    expect((await assign(c.id, { caseTypeId: type, policies: [{ caseTypeId: type }] })).status).toBe(400);
  });
  it('empty policies, duplicate caseTypeId, primary-not-in-policies, caps → 400', async () => {
    const c = await makeCase(tenantId, mgr.id);
    const a = await makeActiveType();
    expect((await assign(c.id, { policies: [] })).status).toBe(400);
    expect((await assign(c.id, { policies: [{ caseTypeId: a }, { caseTypeId: a }] })).status).toBe(400);
    expect((await assign(c.id, { policies: [{ caseTypeId: a }], primaryCaseTypeId: uid() })).status).toBe(400);
    const many = Array.from({ length: 26 }, () => ({ caseTypeId: uid() }));
    expect((await assign(c.id, { policies: many })).status).toBe(400);
  });
  it('component not belonging to its policy → 400', async () => {
    const a = await makeActiveType(); const b = await makeActiveType();
    const compB = await addComp(b, 'OnB');
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: a, componentIds: [compB] }] })).status).toBe(400);
  });
  it('invalid date → 400; empty-string date is accepted (cleared)', async () => {
    const a = await makeActiveType();
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: a, proposalDate: '2026/01/01' }] })).status).toBe(400);
    expect((await assign(c.id, { policies: [{ caseTypeId: a, proposalDate: '' }] })).status).toBe(200);
  });
});

describe('Business rules (422)', () => {
  it('newly-added non-ACTIVE (DRAFT) policy → 422', async () => {
    const draft = await makeDraftType();
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: draft }] })).status).toBe(422);
  });
  it('newly-added policy with active components but none selected → 422', async () => {
    const a = await makeActiveType(); await addComp(a, 'Req');
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: a, componentIds: [] }] })).status).toBe(422);
    expect((await assign(c.id, { policies: [{ caseTypeId: a }] })).status).toBe(422); // omitted → empty for new
  });
  it('newly-selected inactive component → 422', async () => {
    const a = await makeActiveType();
    const live = await addComp(a, 'Live');
    const dead = await addComp(a, 'Dead');
    await req('PATCH', `${CT}/${a}/components/${dead}`, { token: mgr.token, body: { isActive: false } });
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: a, componentIds: [live, dead] }] })).status).toBe(422);
  });
  it('terminal and TRANSFERRED_TO_PROCESS statuses → 422', async () => {
    const a = await makeActiveType();
    const closed = await makeCase(tenantId, mgr.id, 'CLOSED');
    const transferred = await makeCase(tenantId, mgr.id, 'TRANSFERRED_TO_PROCESS');
    expect((await assign(closed.id, { policies: [{ caseTypeId: a }] })).status).toBe(422);
    expect((await assign(transferred.id, { policies: [{ caseTypeId: a }] })).status).toBe(422);
  });
});

describe('Primary canonicalization', () => {
  it('primary defaults to first ACTIVE, persisted at displayOrder 0, synced to DocCase.caseTypeId', async () => {
    const a = await makeActiveType(); const b = await makeActiveType();
    const c = await makeCase(tenantId, mgr.id);
    // put b first in request; pass primaryCaseTypeId a → a is primary at order 0
    const r = await assign(c.id, { policies: [{ caseTypeId: b }, { caseTypeId: a }], primaryCaseTypeId: a });
    expect(r.status).toBe(200);
    expect((await prisma.docCase.findUnique({ where: { id: c.id } }))!.caseTypeId).toBe(a);
    const primary = await prisma.docCasePolicyAssignment.findFirst({ where: { caseId: c.id, caseTypeId: a } });
    expect(primary!.displayOrder).toBe(0);
    const read = await docService.getCaseById({ tenantId, userId: mgr.id }, c.id);
    expect(read.policyAssignments[0]).toMatchObject({ caseTypeId: a, isPrimary: true });
    expect(read.policyAssignments.find(p => p.caseTypeId === b)!.isPrimary).toBe(false);
  });
});

describe('Documents generation + deselect safety', () => {
  it('selected components generate docs; re-save does not duplicate', async () => {
    const a = await makeActiveType();
    const c1 = await addCompWithDoc(a, 'Aadhaar', { isMandatory: true, displayOrder: 1 });
    const c2 = await addCompWithDoc(a, 'PAN', { displayOrder: 2 });
    const kase = await makeCase(tenantId, mgr.id);
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [c1, c2] }] });
    let docs = await activeDocs(kase.id);
    expect(docs.map(d => d.name).sort()).toEqual(['Aadhaar', 'PAN']);
    expect(docs.find(d => d.name === 'Aadhaar')!.isMandatory).toBe(true);
    // re-save identical payload → still 2 docs
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [c1, c2] }] });
    docs = await activeDocs(kase.id);
    expect(docs).toHaveLength(2);
  });

  it('a component with no document presets creates no requirement rows', async () => {
    const a = await makeActiveType();
    const bare = await addComp(a, 'Bundle with no presets');
    const kase = await makeCase(tenantId, mgr.id);
    const r = await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [bare] }] });
    expect(r.status).toBe(200);
    expect(await activeDocs(kase.id)).toHaveLength(0);
  });

  it('deselect untouched → soft-delete; deselect with progress/upload/client-visible → kept; reselect revives', async () => {
    const a = await makeActiveType();
    const c1 = await addCompWithDoc(a, 'Aadhaar');
    const c2 = await addCompWithDoc(a, 'PAN');
    const kase = await makeCase(tenantId, mgr.id);
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [c1, c2] }] });
    const panDoc = (await activeDocs(kase.id)).find(d => d.name === 'PAN')!;

    // deselect PAN while untouched → soft-deleted
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [c1] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: panDoc.id } }))!.deletedAt).not.toBeNull();

    // reselect PAN → revives the same doc (no duplicate)
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [c1, c2] }] });
    const revived = await prisma.docCaseDocument.findMany({ where: { caseId: kase.id, name: 'PAN' } });
    expect(revived).toHaveLength(1);
    expect(revived[0].deletedAt).toBeNull();

    // mark Aadhaar as received (touched), then deselect → kept
    const aadhaar = (await activeDocs(kase.id)).find(d => d.name === 'Aadhaar')!;
    await prisma.docCaseDocument.update({ where: { id: aadhaar.id }, data: { receivedAt: new Date(), status: 'RECEIVED' } });
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [c2] }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: aadhaar.id } }))!.deletedAt).toBeNull();
  });

  it('client-visible generated doc is not soft-deleted on deselect; manual docs never touched', async () => {
    const a = await makeActiveType();
    const comp = await addCompWithDoc(a, 'GST');
    const kase = await makeCase(tenantId, mgr.id);
    // manual (non-policy) doc
    const manual = await prisma.docCaseDocument.create({ data: { tenantId, caseId: kase.id, name: 'Manual', displayOrder: 99, status: 'REQUESTED', metadataValues: {} } });
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [comp] }] });
    const gst = (await activeDocs(kase.id)).find(d => d.name === 'GST')!;
    await prisma.docCaseDocument.update({ where: { id: gst.id }, data: { clientVisible: true, clientVisibleAt: new Date() } });
    // remove the whole policy
    await assign(kase.id, { caseTypeId: null }); // legacy clear won't touch; use new empty? must be non-empty. Re-add a different active type instead:
    const b = await makeActiveType();
    await assign(kase.id, { policies: [{ caseTypeId: b }] });
    expect((await prisma.docCaseDocument.findUnique({ where: { id: gst.id } }))!.deletedAt).toBeNull(); // client-visible kept
    expect((await prisma.docCaseDocument.findUnique({ where: { id: manual.id } }))!.deletedAt).toBeNull(); // manual untouched
  });
});

describe('Dates + retained/archived rules', () => {
  it('dates optional and editable after assignment via unchanged-selection edit', async () => {
    const a = await makeActiveType();
    const comp = await addCompWithDoc(a, 'Aadhaar');
    const kase = await makeCase(tenantId, mgr.id);
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [comp] }] });
    // date-only edit: omit componentIds → unchanged selection, not blocked
    const r = await assign(kase.id, { policies: [{ caseTypeId: a, proposalDate: '2026-02-01', actualDate: '2026-03-15' }] });
    expect(r.status).toBe(200);
    const row = await prisma.docCasePolicyAssignment.findFirst({ where: { caseId: kase.id, caseTypeId: a } });
    expect(row!.proposalDate?.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(row!.actualDate?.toISOString().slice(0, 10)).toBe('2026-03-15');
    // generated doc still present (selection unchanged)
    expect((await activeDocs(kase.id)).length).toBe(1);
  });

  it('archived retained policy: date edit OK, component-selection change → 422', async () => {
    const a = await makeActiveType();
    const comp = await addCompWithDoc(a, 'Aadhaar');
    const kase = await makeCase(tenantId, mgr.id);
    await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [comp] }] });
    await req('POST', `${CT}/${a}/archive`, { token: mgr.token });
    // date-only edit (unchanged selection) still allowed
    expect((await assign(kase.id, { policies: [{ caseTypeId: a, proposalDate: '2026-04-01' }] })).status).toBe(200);
    // selection change on the archived retained policy → 422
    expect((await assign(kase.id, { policies: [{ caseTypeId: a, componentIds: [] }] })).status).toBe(422);
  });
});

describe('RBAC / tenant / engine gates', () => {
  it('no doc:edit → 403', async () => {
    const a = await makeActiveType();
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: a }] }, noEdit.token)).status).toBe(403);
  });
  it('engine disabled → 403', async () => {
    const c = await makeCase(disabledTenantId, (await makeUser(disabledTenantId)).id);
    expect((await assign(c.id, { policies: [{ caseTypeId: uid() }] }, disabledMgr.token)).status).toBe(403);
  });
  it("cross-tenant case → 404; cross-tenant caseType → 404", async () => {
    const a = await makeActiveType();
    const otherCase = await makeCase(otherTenantId, otherMgr.id);
    expect((await assign(otherCase.id, { policies: [{ caseTypeId: a }] })).status).toBe(404);
    const c = await makeCase(tenantId, mgr.id);
    expect((await assign(c.id, { policies: [{ caseTypeId: uid() }] })).status).toBe(404);
  });
});

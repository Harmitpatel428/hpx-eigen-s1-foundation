/**
 * Phase 8 Task 3 — performance-summary refresh on the COMPLETED transition. Real Postgres.
 * Covers: refresh on COMPLETE only + audit-silent; not on start/pause/resume/skip/reopen;
 * lazy-create; reopen→recomplete = one sample; SKIPPED excluded; tenant isolation;
 * tenant-wide (null caseTypeId) row created/updated exactly once.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus, CaseTypeStatus, CaseStageDurationType } from '@prisma/client';

import { createCaseTimelineRouter, createCaseStageActionsRouter } from '../../src/routes/case-timeline.router';
import { PermissionService } from '../../src/services/permission.service';
import { loadOrCreateSummary } from '../../src/services/case-performance.service';
import { AppException } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
const uid = () => crypto.randomUUID();

let server: http.Server; let baseUrl: string;
const tracked: string[] = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cases/:caseId/timeline', createCaseTimelineRouter(prisma));
  app.use('/api/v1/cases/:caseId/stages', createCaseStageActionsRouter(prisma));
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `pf-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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

const ALL = ['case-timeline:view', 'case-timeline:manage', 'case-stage:start', 'case-stage:complete', 'case-stage:skip', 'case-stage:reopen', 'case-stage:pause', 'case-stage:resume'];

let tenantId: string, otherTenantId: string;
let admin: { id: string; token: string }, otherAdmin: { id: string; token: string };

const TL = (caseId: string) => `/api/v1/cases/${caseId}/timeline`;
const SG = (caseId: string) => `/api/v1/cases/${caseId}/stages`;
const act = (a: { id: string; token: string }, caseId: string, stageId: string, verb: string, body?: unknown) =>
  req('POST', `${SG(caseId)}/${stageId}/${verb}`, { token: a.token, body });

// One ACTIVE type (given or new) with `keys.length` dependent stages + a case with a timeline.
async function withTimeline(t: string, a: { id: string; token: string }, keys: string[], typeId?: string) {
  let caseTypeId = typeId;
  if (!caseTypeId) {
    caseTypeId = (await prisma.caseType.create({ data: { tenantId: t, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } })).id;
    for (let i = 0; i < keys.length; i++) {
      await prisma.caseStageTemplate.create({ data: { tenantId: t, caseTypeId, key: keys[i], label: `S${i}`, sequence: i, durationValue: 3, durationType: CaseStageDurationType.DAYS } });
    }
  }
  const lead = await prisma.lead.create({ data: { tenantId: t, firstName: 'T', lastName: 'C' }, select: { id: true } });
  const c = await prisma.docCase.create({ data: { tenantId: t, leadId: lead.id, createdBy: a.id, caseTypeId }, select: { id: true } });
  const created = await req('POST', TL(c.id), { token: a.token });
  expect(created.status).toBe(201);
  return { caseId: c.id, caseTypeId, stages: created.body.data.stages as any[] };
}
const key = () => `k_${uid().slice(0, 8)}`;
const rowsFor = (t: string, stageKey: string) => prisma.stagePerformanceSummary.findMany({ where: { tenantId: t, stageKey } });

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid();
  tracked.push(tenantId, otherTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
  ]});
  admin = await grant(tenantId, ALL);
  otherAdmin = await grant(otherTenantId, ALL);
  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.stagePerformanceSummary.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.calendarHoliday.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.workingCalendar.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStageEvent.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStage.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseTimeline.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.caseStageTemplate.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.docCase.updateMany({ where: { tenantId: t }, data: { caseTypeId: null } }).catch(() => {});
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

describe('refresh on COMPLETED', () => {
  it('writes primary + tenant-wide rows, and NO perf audit row (only the one per-transition audit)', async () => {
    const k = key();
    const { caseId, caseTypeId, stages } = await withTimeline(tenantId, admin, [k]);
    expect((await act(admin, caseId, stages[0].id, 'start')).status).toBe(200);
    const before = await prisma.auditLog.count({ where: { tenantId } });
    expect((await act(admin, caseId, stages[0].id, 'complete', {})).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { tenantId } })).toBe(before + 1); // CASE_STAGE_COMPLETED only
    expect(await prisma.auditLog.count({ where: { tenantId, eventType: { contains: 'PERFORMANCE' } } })).toBe(0);

    const rows = await rowsFor(tenantId, k);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.caseTypeId === caseTypeId)?.sampleCount).toBe(1);
    expect(rows.find((r) => r.caseTypeId === null)?.sampleCount).toBe(1);
  });

  it('tenant-wide row is updated in place (exactly one) across completions on different cases/types', async () => {
    const k = key();
    for (let i = 0; i < 2; i++) {
      const { caseId, stages } = await withTimeline(tenantId, admin, [k]); // new type each time, same key
      await act(admin, caseId, stages[0].id, 'start');
      await act(admin, caseId, stages[0].id, 'complete', {});
    }
    const rows = await rowsFor(tenantId, k);
    const wide = rows.filter((r) => r.caseTypeId === null);
    expect(wide).toHaveLength(1);
    expect(wide[0].sampleCount).toBe(2);
    expect(rows.filter((r) => r.caseTypeId !== null)).toHaveLength(2);
  });

  it('concurrent tenant-wide refreshes do not duplicate the null row', async () => {
    const k = key();
    const a = await withTimeline(tenantId, admin, [k]);
    const b = await withTimeline(tenantId, admin, [k]);
    await Promise.all([a, b].map((x) => act(admin, x.caseId, x.stages[0].id, 'start')));
    await Promise.all([a, b].map((x) => act(admin, x.caseId, x.stages[0].id, 'complete', {})));
    expect((await rowsFor(tenantId, k)).filter((r) => r.caseTypeId === null)).toHaveLength(1);
  });
});

describe('refresh does NOT run on other transitions', () => {
  it('start/pause/resume/skip/reopen leave a sentinel summary untouched; recomplete → one sample', async () => {
    const k1 = key(); const k2 = key();
    const { caseId, caseTypeId, stages } = await withTimeline(tenantId, admin, [k1, k2]);
    const [s1, s2] = stages;
    await act(admin, caseId, s1.id, 'start');
    await act(admin, caseId, s1.id, 'pause');
    await act(admin, caseId, s1.id, 'resume');
    expect(await rowsFor(tenantId, k1)).toHaveLength(0); // no refresh yet

    await act(admin, caseId, s1.id, 'complete', {});
    const seed = async () => prisma.stagePerformanceSummary.updateMany({ where: { tenantId, stageKey: k1 }, data: { sampleCount: 99 } });
    await seed();
    // reopen (COMPLETED→IN_PROGRESS) must not refresh
    expect((await act(admin, caseId, s1.id, 'reopen')).status).toBe(200);
    expect((await rowsFor(tenantId, k1)).every((r) => r.sampleCount === 99)).toBe(true);
    // recomplete → refresh; still a single sample for the one stage
    expect((await act(admin, caseId, s1.id, 'complete', {})).status).toBe(200);
    const rows = await rowsFor(tenantId, k1);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sampleCount === 1)).toBe(true);
    expect(rows.find((r) => r.caseTypeId === caseTypeId)).toBeTruthy();

    // skip s2 → no rows for k2 (SKIPPED excluded / no refresh); reopen skipped → none
    expect((await act(admin, caseId, s2.id, 'skip', { reason: 'n/a' })).status).toBe(200);
    expect(await rowsFor(tenantId, k2)).toHaveLength(0);
    expect((await act(admin, caseId, s2.id, 'reopen')).status).toBe(200);
    expect(await rowsFor(tenantId, k2)).toHaveLength(0);
  });

  it('SKIPPED stages are excluded from samples', async () => {
    const k = key();
    const done = await withTimeline(tenantId, admin, [k]);
    await act(admin, done.caseId, done.stages[0].id, 'start');
    await act(admin, done.caseId, done.stages[0].id, 'complete', {});
    const skipped = await withTimeline(tenantId, admin, [k]);
    await act(admin, skipped.caseId, skipped.stages[0].id, 'skip', { reason: 'n/a' });
    const wide = (await rowsFor(tenantId, k)).find((r) => r.caseTypeId === null)!;
    expect(wide.sampleCount).toBe(1);
    // Force a recompute via a third completion: skipped still not counted
    const third = await withTimeline(tenantId, admin, [k]);
    await act(admin, third.caseId, third.stages[0].id, 'start');
    await act(admin, third.caseId, third.stages[0].id, 'complete', {});
    expect((await rowsFor(tenantId, k)).find((r) => r.caseTypeId === null)!.sampleCount).toBe(2);
  });
});

describe('loadOrCreateSummary + tenant isolation', () => {
  it('lazy-creates when no row exists, computed from existing completed stages', async () => {
    const k = key();
    const { caseId, caseTypeId, stages } = await withTimeline(tenantId, admin, [k]);
    await act(admin, caseId, stages[0].id, 'start');
    await act(admin, caseId, stages[0].id, 'complete', {});
    await prisma.stagePerformanceSummary.deleteMany({ where: { tenantId, stageKey: k } });

    const primary = await loadOrCreateSummary(prisma, tenantId, caseTypeId, k);
    expect(primary.sampleCount).toBe(1);
    const wide = await loadOrCreateSummary(prisma, tenantId, null, k);
    expect(wide.caseTypeId).toBeNull();
    expect(wide.sampleCount).toBe(1);
    expect(await rowsFor(tenantId, k)).toHaveLength(2);
    // second call returns the persisted row, no dup
    await loadOrCreateSummary(prisma, tenantId, null, k);
    expect(await rowsFor(tenantId, k)).toHaveLength(2);
  });

  it('lazy-create with no completed stages yields an empty (count 0) row', async () => {
    const s = await loadOrCreateSummary(prisma, tenantId, null, key());
    expect(s.sampleCount).toBe(0);
  });

  it("another tenant's completed stages do not leak", async () => {
    const k = key();
    const mine = await withTimeline(tenantId, admin, [k]);
    await act(admin, mine.caseId, mine.stages[0].id, 'start');
    await act(admin, mine.caseId, mine.stages[0].id, 'complete', {});
    const theirs = await withTimeline(otherTenantId, otherAdmin, [k]);
    await act(otherAdmin, theirs.caseId, theirs.stages[0].id, 'start');
    await act(otherAdmin, theirs.caseId, theirs.stages[0].id, 'complete', {});

    const a = (await rowsFor(tenantId, k)).find((r) => r.caseTypeId === null)!;
    const b = (await rowsFor(otherTenantId, k)).find((r) => r.caseTypeId === null)!;
    expect(a.sampleCount).toBe(1);
    expect(b.sampleCount).toBe(1);
    expect((await rowsFor(tenantId, k)).every((r) => r.tenantId === tenantId)).toBe(true);
  });
});

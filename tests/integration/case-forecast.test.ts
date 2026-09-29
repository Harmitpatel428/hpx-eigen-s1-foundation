/**
 * Phase 8 — per-case completion forecast over the real GET endpoint. Real Postgres.
 * Covers: fallback chain (primary<5 → tenant-wide FALLBACK; both<5 → configured INSUFFICIENT);
 * NORMAL + TREND_SLOWER/FASTER explanations; OVERRIDE_ACTIVE when remainingDurationOverride set;
 * EXTERNAL_WAITING note; forward-chained projectedCompletion with mixed completed/incomplete stages;
 * forecast read leaves planned/baseline/latest byte-identical; lazy-create summary when missing;
 * tenant isolation (other-tenant caseId → 404); flag disabled → 403.
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
import { AppException } from '../../src/types/exceptions';
import { forecastCase } from '../../src/services/case-forecast.service';
import { loadPlanningCalendar } from '../../src/services/case-calendar.service';
import { addWorkingDays, addCalendarDays, toKey } from '../../src/services/case-planning.dates';
import { dateOnly } from '../../src/services/case-planning.service';

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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `fc-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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
async function makeType(tenantId: string) {
  return prisma.caseType.create({ data: { tenantId, key: `t_${uid().slice(0, 8)}`, name: 'T', status: CaseTypeStatus.ACTIVE }, select: { id: true } });
}
async function makeCase(tenantId: string, createdBy: string, caseTypeId: string) {
  const lead = await prisma.lead.create({ data: { tenantId, firstName: 'T', lastName: 'C' }, select: { id: true } });
  return prisma.docCase.create({ data: { tenantId, leadId: lead.id, createdBy, caseTypeId }, select: { id: true } });
}

const ALL = ['case-timeline:view', 'case-timeline:manage', 'case-stage:start', 'case-stage:complete', 'case-stage:skip', 'case-stage:reopen', 'case-stage:pause', 'case-stage:resume', 'case-stage:override', 'case-exception:approve'];

let tenantId: string, otherTenantId: string, disabledTenantId: string;
let admin: { id: string; token: string }, otherAdmin: { token: string }, disabledAdmin: { token: string };

const TL = (caseId: string) => `/api/v1/cases/${caseId}/timeline`;
const SG = (caseId: string) => `/api/v1/cases/${caseId}/stages`;

// Create an ACTIVE type with n dependent DAYS stages (durationValue 3) + a case with a timeline.
async function withTimeline(over: any[] = []) {
  const type = await makeType(tenantId);
  const n = Math.max(over.length, 1);
  for (let i = 0; i < n; i++) {
    await prisma.caseStageTemplate.create({ data: { tenantId, caseTypeId: type.id, key: `s_${uid().slice(0, 8)}`, label: `S${i}`, sequence: i, durationValue: 3, durationType: CaseStageDurationType.DAYS, ...(over[i] ?? {}) } });
  }
  const c = await makeCase(tenantId, admin.id, type.id);
  const created = await req('POST', TL(c.id), { token: admin.token });
  expect(created.status).toBe(201);
  return { caseId: c.id, caseTypeId: type.id, stages: created.body.data.stages as any[] };
}
async function seedSummary(caseTypeId: string | null, stageKey: string, sampleCount: number, medianDays: number, recentMedianDays: number) {
  await prisma.stagePerformanceSummary.create({ data: { tenantId, caseTypeId, stageKey, sampleCount, medianDays, recentMedianDays } });
}
async function snapshotPlanning(caseId: string) {
  return prisma.caseStage.findMany({
    where: { timeline: { caseId } }, orderBy: { sequence: 'asc' },
    select: { id: true, plannedStart: true, plannedFinish: true, baselineStart: true, baselineFinish: true, latestStart: true, latestFinish: true },
  });
}
const getStage = (body: any, key: string) => body.data.stages.find((s: any) => s.stageKey === key);

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  admin = await grant(tenantId, ALL);
  otherAdmin = await grant(otherTenantId, ALL);
  disabledAdmin = await grant(disabledTenantId, ALL);

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

describe('fallback chain', () => {
  it('primary<5 → tenant-wide FALLBACK; both<5 → configured INSUFFICIENT', async () => {
    const { caseId, caseTypeId, stages } = await withTimeline([{}, {}]);
    const [k0, k1] = [stages[0].key, stages[1].key];
    // stage 0: primary insufficient (3), tenant-wide sufficient (6) → FALLBACK, estimate = wide median.
    await seedSummary(caseTypeId, k0, 3, 99, 99);
    await seedSummary(null, k0, 6, 4, 4);
    // stage 1: both insufficient → configured duration (3 DAYS) INSUFFICIENT.
    await seedSummary(caseTypeId, k1, 2, 50, 50);
    await seedSummary(null, k1, 1, 50, 50);

    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200);
    const s0 = getStage(r.body, k0);
    expect(s0.estimateDays).toBe(4);
    expect(s0.confidence).toBe('LOW');
    expect(s0.explanation).toBe('Based on 6 samples across all case types for this stage.');
    const s1 = getStage(r.body, k1);
    expect(s1.estimateDays).toBe(3); // configured durationValue
    expect(s1.confidence).toBe('INSUFFICIENT');
    expect(s1.explanation).toBe('Not enough comparable history (2 samples); using the configured stage duration.');
  });
});

describe('primary summary explanations', () => {
  it('NORMAL, TREND_SLOWER, TREND_FASTER map to exact strings', async () => {
    const { caseId, caseTypeId, stages } = await withTimeline([{}, {}, {}]);
    const [k0, k1, k2] = stages.map((s) => s.key);
    await seedSummary(caseTypeId, k0, 8, 10, 10);  // trend NONE → NORMAL
    await seedSummary(caseTypeId, k1, 8, 10, 13);  // 13 > 12 → SLOWER
    await seedSummary(caseTypeId, k2, 8, 10, 7);   // 7 < 8 → FASTER

    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200);
    const s0 = getStage(r.body, k0);
    expect(s0.estimateDays).toBe(10);
    expect(s0.confidence).toBe('LOW');
    expect(s0.explanation).toBe('Based on 8 comparable samples (median 10 days).');
    expect(getStage(r.body, k1).explanation).toBe('Recent cases are running slower than usual (recent median 13 vs overall 10 days).');
    expect(getStage(r.body, k2).explanation).toBe('Recent cases are completing faster than usual (recent median 7 vs overall 10 days).');
  });
});

describe('override + external-waiting notes', () => {
  it('OVERRIDE_ACTIVE wins over the summary path; EXTERNAL_WAITING appended', async () => {
    const { caseId, caseTypeId, stages } = await withTimeline([{ externalWaiting: true }]);
    const k0 = stages[0].key;
    // Even a strong summary is ignored once an override is set.
    await seedSummary(caseTypeId, k0, 30, 99, 99);
    await prisma.caseStage.update({ where: { id: stages[0].id }, data: { remainingDurationOverride: 2 } });

    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200);
    const s0 = getStage(r.body, k0);
    expect(s0.estimateDays).toBe(2); // 2 DAYS override, scalar-converted
    expect(s0.explanation).toBe(
      'A manual remaining-duration override is set; using the override, not the estimate. External-waiting time is excluded from the active-time estimate.',
    );
  });
});

describe('projectedCompletion forward-chain', () => {
  it('mixed completed/incomplete: completed anchors on completedAt, list is incomplete-only', async () => {
    const { caseId, stages } = await withTimeline([{}, {}, {}]);
    // Complete stage 0 through the real transition flow.
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/start`, { token: admin.token })).status).toBe(200);
    expect((await req('POST', `${SG(caseId)}/${stages[0].id}/complete`, { token: admin.token })).status).toBe(200);
    const completed = await prisma.caseStage.findUnique({ where: { id: stages[0].id }, select: { completedAt: true } });

    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200);
    // Only the 2 remaining stages appear in the per-stage list.
    expect(r.body.data.stages.map((s: any) => s.stageKey).sort()).toEqual([stages[1].key, stages[2].key].sort());
    expect(r.body.data.projectedCompletion).not.toBeNull();
    const projected = new Date(r.body.data.projectedCompletion);
    expect(projected.getTime()).toBeGreaterThanOrEqual(completed!.completedAt!.getTime());
  });
});

describe('forward-chain — non-DAYS estimate flattened to days', () => {
  // Injected `now` + default Mon–Fri/no-holiday calendar → deterministic dates.
  const NOW = new Date('2027-01-04T00:00:00.000Z'); // a Monday

  it('INTERNAL WEEKS stage (configured) chains as CALENDAR days per durationType', async () => {
    // No summaries → INSUFFICIENT → configured branch; WEEKS → calendar even when internal.
    const { caseId } = await withTimeline([{ durationType: CaseStageDurationType.WEEKS, durationValue: 2, externalWaiting: false }]);
    const res = await forecastCase(prisma, tenantId, caseId, NOW);
    expect(res.stages[0].estimateDays).toBe(14);
    expect(res.stages[0].confidence).toBe('INSUFFICIENT');
    const expected = addCalendarDays(dateOnly(NOW), 14 - 1);
    expect(toKey(res.projectedCompletion!)).toBe(toKey(expected));
    expect(toKey(res.projectedCompletion!)).toBe('2027-01-17');
  });

  it('EXTERNAL WEEKS stage chains its flattened estimate as CALENDAR days', async () => {
    const { caseId } = await withTimeline([{ durationType: CaseStageDurationType.WEEKS, durationValue: 2, externalWaiting: true }]);
    const res = await forecastCase(prisma, tenantId, caseId, NOW);
    expect(res.stages[0].estimateDays).toBe(14);
    const expected = addCalendarDays(dateOnly(NOW), 14 - 1);
    expect(toKey(res.projectedCompletion!)).toBe(toKey(expected));
    expect(toKey(res.projectedCompletion!)).toBe('2027-01-17'); // pure calendar span, no working-day skip
  });
});

describe('forward-chain — unit follows estimate source', () => {
  const NOW = new Date('2027-01-04T00:00:00.000Z'); // Monday; 6 days from Mon crosses a weekend

  it('STATISTICAL estimate chains as CALENDAR days (weekend included), + buffer', async () => {
    const { caseId, caseTypeId, stages } = await withTimeline([{ externalWaiting: false, bufferDays: 1 }]);
    await seedSummary(caseTypeId, stages[0].key, 6, 6, 6); // LOW confidence, median 6
    const res = await forecastCase(prisma, tenantId, caseId, NOW);
    expect(res.stages[0].confidence).not.toBe('INSUFFICIENT');
    const expected = addCalendarDays(addCalendarDays(dateOnly(NOW), 6 - 1), 1);
    expect(toKey(res.projectedCompletion!)).toBe(toKey(expected));
    expect(toKey(res.projectedCompletion!)).toBe('2027-01-10'); // Sun 9 + 1 buffer (weekend not skipped)
  });

  it('CONFIGURED internal DAYS fallback chains as WORKING days (skips weekend)', async () => {
    const { caseId } = await withTimeline([{ durationValue: 6, externalWaiting: false }]);
    const cal = await loadPlanningCalendar(prisma, tenantId);
    const res = await forecastCase(prisma, tenantId, caseId, NOW);
    expect(res.stages[0].confidence).toBe('INSUFFICIENT');
    expect(toKey(res.projectedCompletion!)).toBe(toKey(addWorkingDays(dateOnly(NOW), 6 - 1, cal)));
    expect(toKey(res.projectedCompletion!)).toBe('2027-01-11'); // Mon
  });

  it('OVERRIDE on internal DAYS chains as WORKING days', async () => {
    const { caseId, caseTypeId, stages } = await withTimeline([{ externalWaiting: false }]);
    await seedSummary(caseTypeId, stages[0].key, 30, 99, 99); // ignored under override
    await prisma.caseStage.update({ where: { id: stages[0].id }, data: { remainingDurationOverride: 6 } });
    const cal = await loadPlanningCalendar(prisma, tenantId);
    const res = await forecastCase(prisma, tenantId, caseId, NOW);
    expect(toKey(res.projectedCompletion!)).toBe(toKey(addWorkingDays(dateOnly(NOW), 6 - 1, cal)));
    expect(toKey(res.projectedCompletion!)).toBe('2027-01-11');
  });
});

describe('forward-chain — COMPLETED with null completedAt does not crash', () => {
  it('treats a COMPLETED/null-completedAt stage as terminal (no estimate, no time added)', async () => {
    const { caseId, stages } = await withTimeline([{}, {}]);
    // Force the degenerate row directly: COMPLETED but completedAt never set.
    await prisma.caseStage.update({ where: { id: stages[0].id }, data: { status: 'COMPLETED', completedAt: null } });
    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200); // no 500 from a non-null assertion
    // COMPLETED stage is terminal → excluded from the incomplete list.
    expect(r.body.data.stages.map((s: any) => s.stageKey)).toEqual([stages[1].key]);
    expect(r.body.data.projectedCompletion).not.toBeNull();
  });
});

describe('pure read — no planning mutation', () => {
  it('planned/baseline/latest columns are byte-identical before and after the forecast GET', async () => {
    const { caseId } = await withTimeline([{}, {}]);
    // Populate all six planning columns: recalc (planned+baseline) + a target (latest).
    await req('PUT', `${TL(caseId)}/target`, { token: admin.token, body: { targetDate: '2027-06-01' } });
    const before = await snapshotPlanning(caseId);
    expect(before[0].plannedStart).not.toBeNull();
    expect(before[0].latestStart).not.toBeNull();

    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200);
    const after = await snapshotPlanning(caseId);
    expect(after).toEqual(before);
  });
});

describe('lazy-create summary on forecast', () => {
  it('creates the missing StagePerformanceSummary row(s) for a stage key', async () => {
    const { caseId, stages } = await withTimeline([{}]);
    const k0 = stages[0].key;
    expect(await prisma.stagePerformanceSummary.count({ where: { tenantId, stageKey: k0 } })).toBe(0);
    const r = await req('GET', `${TL(caseId)}/forecast`, { token: admin.token });
    expect(r.status).toBe(200);
    // Both dimensions (primary caseTypeId + tenant-wide null) get lazily created.
    expect(await prisma.stagePerformanceSummary.count({ where: { tenantId, stageKey: k0 } })).toBeGreaterThanOrEqual(1);
  });
});

describe('tenant isolation + flag gate', () => {
  it('other-tenant caseId → 404', async () => {
    const { caseId } = await withTimeline([{}]);
    expect((await req('GET', `${TL(caseId)}/forecast`, { token: otherAdmin.token })).status).toBe(404);
  });
  it('flag disabled → 403 CASE_OPERATIONS_ENGINE_DISABLED', async () => {
    const r = await req('GET', `${TL(uid())}/forecast`, { token: disabledAdmin.token });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
});

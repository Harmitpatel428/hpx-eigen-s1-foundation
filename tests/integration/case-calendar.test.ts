/**
 * Phase 7 — firm working calendar + holidays. Real Postgres.
 * Covers flag gate, permissions, default shape (no row created on read), upsert
 * validation, holiday add/duplicate/remove, tenant isolation, audit rows and
 * loadPlanningCalendar (prisma + tx client).
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType, UserStatus } from '@prisma/client';

import { createCaseCalendarRouter } from '../../src/routes/case-calendar.router';
import { loadPlanningCalendar } from '../../src/services/case-calendar.service';
import { PermissionService } from '../../src/services/permission.service';
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
  app.use('/api/v1/case-calendar', createCaseCalendarRouter(prisma));
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
  return prisma.user.create({ data: { id: uid(), tenantId, email: `cal-${uid()}@test.invalid`, password: await bcryptjs.hash('x', 4), status: UserStatus.ACTIVE }, select: { id: true } });
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

const CAL = '/api/v1/case-calendar';
let tenantId: string, otherTenantId: string, freshTenantId: string, disabledTenantId: string;
let admin: { id: string; token: string }, viewer: { token: string }, otherAdmin: { token: string }, freshAdmin: { token: string }, disabledAdmin: { token: string };

beforeAll(async () => {
  tenantId = uid(); otherTenantId = uid(); freshTenantId = uid(); disabledTenantId = uid();
  tracked.push(tenantId, otherTenantId, freshTenantId, disabledTenantId);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: 'T' }, { id: otherTenantId, name: 'O' }, { id: freshTenantId, name: 'F' }, { id: disabledTenantId, name: 'D' }] });
  await prisma.tenantSettings.createMany({ data: [
    { tenantId, caseOperationsEngineEnabled: true },
    { tenantId: otherTenantId, caseOperationsEngineEnabled: true },
    { tenantId: freshTenantId, caseOperationsEngineEnabled: true },
    { tenantId: disabledTenantId, caseOperationsEngineEnabled: false },
  ]});
  const ALL = ['case-timeline:view', 'case-calendar:manage'];
  admin = await grant(tenantId, ALL);
  viewer = await grant(tenantId, ['case-timeline:view']);
  otherAdmin = await grant(otherTenantId, ALL);
  freshAdmin = await grant(freshTenantId, ALL);
  disabledAdmin = await grant(disabledTenantId, ALL);

  await Promise.all(tracked.map((t) => permissionService.invalidatePermissionCache(t)));
  server = http.createServer(makeApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const t of tracked) {
    await prisma.calendarHoliday.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.workingCalendar.deleteMany({ where: { tenantId: t } }).catch(() => {});
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

describe('flag + permissions', () => {
  it('flag disabled → 403 CASE_OPERATIONS_ENGINE_DISABLED', async () => {
    const { status, body } = await req('GET', CAL, { token: disabledAdmin.token });
    expect(status).toBe(403); expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
  it('case-timeline:view allows GET; manage routes 403 without case-calendar:manage', async () => {
    expect((await req('GET', CAL, { token: viewer.token })).status).toBe(200);
    expect((await req('PUT', CAL, { token: viewer.token, body: { workingWeekdays: [1], timezone: 'UTC' } })).status).toBe(403);
    expect((await req('POST', `${CAL}/holidays`, { token: viewer.token, body: { date: '2030-01-01', label: 'x' } })).status).toBe(403);
    expect((await req('DELETE', `${CAL}/holidays/${uid()}`, { token: viewer.token })).status).toBe(403);
  });
});

describe('default shape + upsert', () => {
  it('no calendar row → Mon–Fri default, and GET does not create a row', async () => {
    const r = await req('GET', CAL, { token: freshAdmin.token });
    expect(r.status).toBe(200);
    expect(r.body.data.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(r.body.data.holidays).toEqual([]);
    expect(await prisma.workingCalendar.count({ where: { tenantId: freshTenantId } })).toBe(0);
    const pc = await loadPlanningCalendar(prisma, freshTenantId);
    expect(pc.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(pc.holidays.size).toBe(0);
  });
  it('upsert persists weekdays + timezone and is re-upsertable', async () => {
    const r = await req('PUT', CAL, { token: admin.token, body: { workingWeekdays: [1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' } });
    expect(r.status).toBe(200);
    const get = await req('GET', CAL, { token: admin.token });
    expect(get.body.data.workingWeekdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(get.body.data.timezone).toBe('Asia/Kolkata');
    expect((await req('PUT', CAL, { token: admin.token, body: { workingWeekdays: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' } })).status).toBe(200);
    expect(await prisma.workingCalendar.count({ where: { tenantId } })).toBe(1);
  });
  it('rejects empty / out-of-range / non-integer workingWeekdays → 400', async () => {
    for (const workingWeekdays of [[], [7], [-1], [1.5], 'x', undefined]) {
      expect((await req('PUT', CAL, { token: admin.token, body: { workingWeekdays } })).status).toBe(400);
    }
  });
});

describe('holidays', () => {
  it('add → listed + loadPlanningCalendar (prisma and tx); duplicate → 409; remove → ok; remove again → 404', async () => {
    const add = await req('POST', `${CAL}/holidays`, { token: admin.token, body: { date: '2030-12-25', label: 'Christmas' } });
    expect(add.status).toBe(201);
    const holidayId = add.body.data.id;
    expect(add.body.data.tenantId).toBe(tenantId);

    const get = await req('GET', CAL, { token: admin.token });
    expect(get.body.data.holidays.map((h: any) => h.id)).toContain(holidayId);
    expect((await loadPlanningCalendar(prisma, tenantId)).holidays.has('2030-12-25')).toBe(true);
    const viaTx = await prisma.$transaction((tx) => loadPlanningCalendar(tx, tenantId));
    expect(viaTx.holidays.has('2030-12-25')).toBe(true);

    expect((await req('POST', `${CAL}/holidays`, { token: admin.token, body: { date: '2030-12-25', label: 'dup' } })).status).toBe(409);

    expect((await req('DELETE', `${CAL}/holidays/${holidayId}`, { token: admin.token })).status).toBe(200);
    expect((await req('DELETE', `${CAL}/holidays/${holidayId}`, { token: admin.token })).status).toBe(404);
    expect((await loadPlanningCalendar(prisma, tenantId)).holidays.has('2030-12-25')).toBe(false);
  });
  it('malformed date / missing label → 400', async () => {
    for (const body of [{ date: 'nope', label: 'x' }, { date: '2030-02-30', label: 'x' }, { date: '2030-1-1', label: 'x' }, { label: 'x' }, { date: '2030-01-01' }, { date: '2030-01-01', label: '  ' }]) {
      expect((await req('POST', `${CAL}/holidays`, { token: admin.token, body })).status).toBe(400);
    }
  });
  it('first holiday on a tenant with no calendar creates the row', async () => {
    expect(await prisma.workingCalendar.count({ where: { tenantId: freshTenantId } })).toBe(0);
    expect((await req('POST', `${CAL}/holidays`, { token: freshAdmin.token, body: { date: '2030-01-01', label: 'NY' } })).status).toBe(201);
    expect(await prisma.workingCalendar.count({ where: { tenantId: freshTenantId } })).toBe(1);
  });
});

describe('tenant isolation', () => {
  it("other tenant's holidayId → 404 and row survives; body tenantId is ignored", async () => {
    const add = await req('POST', `${CAL}/holidays`, { token: admin.token, body: { date: '2031-05-01', label: 'Labour', tenantId: otherTenantId, calendarId: uid() } });
    expect(add.status).toBe(201);
    expect(add.body.data.tenantId).toBe(tenantId);
    const row = await prisma.calendarHoliday.findUnique({ where: { id: add.body.data.id }, include: { calendar: true } });
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.calendar.tenantId).toBe(tenantId);

    expect((await req('DELETE', `${CAL}/holidays/${add.body.data.id}`, { token: otherAdmin.token })).status).toBe(404);
    expect(await prisma.calendarHoliday.count({ where: { id: add.body.data.id } })).toBe(1);

    const other = await req('GET', CAL, { token: otherAdmin.token });
    expect(other.body.data.holidays).toEqual([]);
  });
});

describe('audit', () => {
  it('writes rows by eventType', async () => {
    await req('PUT', CAL, { token: admin.token, body: { workingWeekdays: [1, 2, 3], timezone: null } });
    const add = await req('POST', `${CAL}/holidays`, { token: admin.token, body: { date: '2032-07-04', label: 'Audit' } });
    await req('DELETE', `${CAL}/holidays/${add.body.data.id}`, { token: admin.token });
    for (const eventType of ['CASE_CALENDAR_UPDATED', 'CASE_CALENDAR_HOLIDAY_ADDED', 'CASE_CALENDAR_HOLIDAY_REMOVED']) {
      expect(await prisma.auditLog.count({ where: { tenantId, eventType, entityType: 'WorkingCalendar' } })).toBeGreaterThan(0);
    }
  });
});

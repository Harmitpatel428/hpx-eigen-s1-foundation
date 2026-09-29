import { PrismaClient, Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import { PlanningCalendar, toKey } from './case-planning.dates';
import { ValidationError, ResourceNotFoundError, DuplicateResourceError } from '../types/exceptions';

export interface UserContext {
  tenantId: string;
  userId: string;
  actorIp?: string;
  actorUserAgent?: string;
}

const TX_OPTS = { maxWait: 5000, timeout: 15000 };
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Load a tenant's calendar in the pure-module shape; Mon–Fri/no holidays when no row. Works with prisma or a tx. */
export async function loadPlanningCalendar(client: PrismaClient | Prisma.TransactionClient, tenantId: string): Promise<PlanningCalendar> {
  const cal = await client.workingCalendar.findUnique({ where: { tenantId }, include: { holidays: { where: { tenantId } } } });
  if (!cal) return { workingWeekdays: [...DEFAULT_WEEKDAYS], holidays: new Set() };
  return { workingWeekdays: cal.workingWeekdays, holidays: new Set(cal.holidays.map((h) => toKey(h.date))) };
}

/** Parse strict YYYY-MM-DD (or an ISO string starting with it) into a UTC date-only Date. */
export function parseDateOnly(input: unknown): Date {
  const s = typeof input === 'string' ? input.trim().slice(0, 10) : '';
  const d = DATE_RE.test(s) ? new Date(`${s}T00:00:00.000Z`) : null;
  if (!d || isNaN(d.getTime()) || toKey(d) !== s) throw new ValidationError('date must be a valid YYYY-MM-DD date.');
  return d;
}

export class CaseCalendarService {
  private readonly audit: AuditService;
  constructor(private readonly prisma: PrismaClient) { this.audit = new AuditService(prisma); }

  private auditRow(ctx: UserContext, eventType: string, entityId: string, payload: Record<string, unknown>) {
    return {
      tenantId: ctx.tenantId, eventType, entityType: 'WorkingCalendar', entityId,
      actorUserId: ctx.userId, actorIp: ctx.actorIp, actorUserAgent: ctx.actorUserAgent,
      operation: 'UPDATE', payload,
    };
  }

  async getCalendar(ctx: UserContext) {
    const cal = await this.prisma.workingCalendar.findUnique({
      where: { tenantId: ctx.tenantId },
      include: { holidays: { where: { tenantId: ctx.tenantId }, orderBy: { date: 'asc' } } },
    });
    return cal ?? { id: null, tenantId: ctx.tenantId, workingWeekdays: [...DEFAULT_WEEKDAYS], timezone: null, holidays: [] };
  }

  async upsertCalendar(ctx: UserContext, input: { workingWeekdays?: unknown; timezone?: unknown }) {
    const wd = input?.workingWeekdays;
    if (!Array.isArray(wd) || wd.length === 0 || !wd.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
      throw new ValidationError('workingWeekdays must be a non-empty array of integers 0..6.');
    }
    const tz = input.timezone;
    if (tz !== undefined && tz !== null && (typeof tz !== 'string' || tz.length > 64)) throw new ValidationError('timezone must be a string of 64 characters or fewer.');
    const workingWeekdays = [...new Set(wd as number[])].sort((a, b) => a - b);
    const timezone = (tz as string | null | undefined) ?? null;

    return this.prisma.$transaction(async (tx) => {
      const cal = await tx.workingCalendar.upsert({
        where: { tenantId: ctx.tenantId },
        create: { tenantId: ctx.tenantId, workingWeekdays, timezone },
        update: { workingWeekdays, timezone },
        include: { holidays: { where: { tenantId: ctx.tenantId }, orderBy: { date: 'asc' } } },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_CALENDAR_UPDATED', cal.id, { workingWeekdays, timezone }));
      return cal;
    }, TX_OPTS);
  }

  async addHoliday(ctx: UserContext, input: { date?: unknown; label?: unknown }) {
    const date = parseDateOnly(input?.date);
    const label = typeof input?.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 200) throw new ValidationError('label is required and must be 200 characters or fewer.');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cal = await tx.workingCalendar.upsert({
          where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId }, update: {},
        });
        // tenantId comes from the calendar row (ctx), never the request body.
        const h = await tx.calendarHoliday.create({ data: { tenantId: cal.tenantId, calendarId: cal.id, date, label } });
        await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_CALENDAR_HOLIDAY_ADDED', cal.id, { holidayId: h.id, date: toKey(date), label }));
        return h;
      }, TX_OPTS);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new DuplicateResourceError(`A holiday on ${toKey(date)} already exists.`);
      throw err;
    }
  }

  async removeHoliday(ctx: UserContext, holidayId: string) {
    return this.prisma.$transaction(async (tx) => {
      const h = await tx.calendarHoliday.findFirst({ where: { id: holidayId, tenantId: ctx.tenantId } });
      if (!h) throw new ResourceNotFoundError();
      await tx.calendarHoliday.delete({ where: { id: h.id } });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_CALENDAR_HOLIDAY_REMOVED', h.calendarId, { holidayId: h.id, date: toKey(h.date), label: h.label }));
      return { id: h.id };
    }, TX_OPTS);
  }
}

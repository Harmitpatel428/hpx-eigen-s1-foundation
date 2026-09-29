/**
 * Phase 7 — planning engine (forward + reverse) + recalc orchestration.
 *
 * The forward/reverse/feasibility functions are PURE and deterministic: they take an
 * ordered stage array + { now, calendar, targetDate } and return computed dates, no Prisma.
 * `recalcInTx` is the thin orchestration that loads rows, calls the pure functions, and
 * writes back — it takes a tx and emits NO audit (callers own the audit row).
 */
import { Prisma } from '@prisma/client';
import {
  PlanningCalendar, addWorkingDays, subtractWorkingDays, addCalendarDays, addMonths,
  workingDaysBetween, toKey,
} from './case-planning.dates';
import { loadPlanningCalendar } from './case-calendar.service';
import { ResourceNotFoundError } from '../types/exceptions';

export type PlanDurationType = 'DAYS' | 'WEEKS' | 'MONTHS' | null;

/** The subset of a CaseStage the planner reads (ordered by sequence by the caller). */
export interface PlanStageInput {
  durationValue: number | null;
  durationType: PlanDurationType;
  externalWaiting: boolean;
  bufferDays: number | null;
  dependsOnPrevious: boolean;
  remainingDurationOverride: number | null;
  startedAt: Date | null;
}

export interface ForwardResult { plannedStart: Date; plannedFinish: Date; }
export interface ReverseResult { latestStart: Date; latestFinish: Date; }
export interface Feasibility { feasible: boolean | null; deficitDays: number | null; }

/** Truncate any Date to UTC date-only midnight. */
export function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function effectiveDuration(s: PlanStageInput): number | null {
  return s.remainingDurationOverride ?? s.durationValue;
}

/** Last occupied working/calendar day (INCLUSIVE of the start day). Milestone → start. */
function occupiedEnd(start: Date, s: PlanStageInput, cal: PlanningCalendar): Date {
  const v = effectiveDuration(s);
  if (v == null || v === 0) return start;
  switch (s.durationType) {
    case 'DAYS': return s.externalWaiting ? addCalendarDays(start, v - 1) : addWorkingDays(start, v - 1, cal);
    case 'WEEKS': return addCalendarDays(start, v * 7 - 1);
    case 'MONTHS': return addCalendarDays(addMonths(start, v), -1);
    default: return start; // no duration type → milestone
  }
}

/** finish = occupiedEnd + bufferDays (buffer folded INTO finish). */
function finish(start: Date, s: PlanStageInput, cal: PlanningCalendar): Date {
  return addCalendarDays(occupiedEnd(start, s, cal), s.bufferDays ?? 0);
}

/** Inverse of finish(): given a finish date, recover the start date. */
function startFromFinish(fin: Date, s: PlanStageInput, cal: PlanningCalendar): Date {
  const occ = addCalendarDays(fin, -(s.bufferDays ?? 0));
  const v = effectiveDuration(s);
  if (v == null || v === 0) return occ;
  switch (s.durationType) {
    case 'DAYS': return s.externalWaiting ? addCalendarDays(occ, -(v - 1)) : subtractWorkingDays(occ, v - 1, cal);
    case 'WEEKS': return addCalendarDays(occ, -(v * 7 - 1));
    case 'MONTHS': return addCalendarDays(addMonths(occ, -v), 1);
    default: return occ;
  }
}

/** Forward pass in sequence order. */
export function forwardPlan(stages: PlanStageInput[], opts: { now: Date; calendar: PlanningCalendar }): ForwardResult[] {
  const now = dateOnly(opts.now);
  const out: ForwardResult[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    let plannedStart: Date;
    if (s.startedAt) plannedStart = dateOnly(s.startedAt);
    else if (s.dependsOnPrevious && i > 0) plannedStart = addWorkingDays(out[i - 1].plannedFinish, 1, opts.calendar);
    else plannedStart = now;
    out.push({ plannedStart, plannedFinish: finish(plannedStart, s, opts.calendar) });
  }
  return out;
}

/** Reverse pass (only when a target date is set); iterate in REVERSE sequence. */
export function reversePlan(stages: PlanStageInput[], opts: { targetDate: Date; calendar: PlanningCalendar }): ReverseResult[] {
  const target = dateOnly(opts.targetDate);
  const out: ReverseResult[] = new Array(stages.length);
  for (let i = stages.length - 1; i >= 0; i--) {
    const latestFinish = i === stages.length - 1 ? target : subtractWorkingDays(out[i + 1].latestStart, 1, opts.calendar);
    out[i] = { latestFinish, latestStart: startFromFinish(latestFinish, stages[i], opts.calendar) };
  }
  return out;
}

/** Locked decision 6: feasibility is about the final stage's plannedFinish vs the target. */
export function computeFeasibility(finalPlannedFinish: Date | null, targetDate: Date | null, cal: PlanningCalendar): Feasibility {
  if (!targetDate || !finalPlannedFinish) return { feasible: null, deficitDays: null };
  const feasible = finalPlannedFinish.getTime() <= targetDate.getTime();
  return { feasible, deficitDays: feasible ? 0 : workingDaysBetween(targetDate, finalPlannedFinish, cal) };
}

export interface RecalcStage {
  stageId: string; key: string;
  plannedStart: Date; plannedFinish: Date;
  latestStart: Date | null; latestFinish: Date | null;
  slackDays: number | null;
}
export interface RecalcResponse {
  feasible: boolean | null;
  deficitDays: number | null;
  targetDate: Date | null;
  stages: RecalcStage[];
}

interface StageRow extends PlanStageInput {
  id: string; key: string; baselineStart: Date | null; baselineFinish: Date | null;
}

function toPlanInput(s: {
  durationValue: number | null; durationType: unknown; externalWaiting: boolean; bufferDays: number | null;
  dependsOnPrevious: boolean; remainingDurationOverride: number | null; startedAt: Date | null;
}): PlanStageInput {
  return {
    durationValue: s.durationValue, durationType: (s.durationType ?? null) as PlanDurationType,
    externalWaiting: s.externalWaiting, bufferDays: s.bufferDays, dependsOnPrevious: s.dependsOnPrevious,
    remainingDurationOverride: s.remainingDurationOverride, startedAt: s.startedAt,
  };
}

/**
 * Load the timeline + its stages, run the plan, persist planned/latest/baseline + feasibility,
 * and return the recalc response. Runs entirely on the given tx. Emits NO audit row — the caller
 * (setTarget / recalc / overrideDuration / a Phase 6 transition) owns its own audit.
 */
export async function recalcInTx(tx: Prisma.TransactionClient, tenantId: string, caseId: string, now: Date): Promise<RecalcResponse> {
  const timeline = await tx.caseTimeline.findFirst({
    where: { caseId, tenantId }, include: { stages: { orderBy: { sequence: 'asc' } } },
  });
  if (!timeline) throw new ResourceNotFoundError();

  const calendar = await loadPlanningCalendar(tx, tenantId);
  const rows = timeline.stages as unknown as StageRow[];
  const inputs = rows.map(toPlanInput);
  const targetDate = timeline.targetDate ? dateOnly(timeline.targetDate) : null;

  const forward = forwardPlan(inputs, { now, calendar });
  const reverse = targetDate ? reversePlan(inputs, { targetDate, calendar }) : null;
  const finalFinish = forward.length ? forward[forward.length - 1].plannedFinish : null;
  const { feasible, deficitDays } = computeFeasibility(finalFinish, targetDate, calendar);

  const stages: RecalcStage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const f = forward[i];
    const r = reverse ? reverse[i] : null;
    const data: Prisma.CaseStageUpdateInput = {
      plannedStart: f.plannedStart, plannedFinish: f.plannedFinish,
      latestStart: r ? r.latestStart : null, latestFinish: r ? r.latestFinish : null,
    };
    // baseline set ONCE, only where currently null; never auto-reset (locked decision 5).
    if (row.baselineStart === null) data.baselineStart = f.plannedStart;
    if (row.baselineFinish === null) data.baselineFinish = f.plannedFinish;
    await tx.caseStage.update({ where: { id: row.id }, data });
    stages.push({
      stageId: row.id, key: row.key, plannedStart: f.plannedStart, plannedFinish: f.plannedFinish,
      latestStart: r?.latestStart ?? null, latestFinish: r?.latestFinish ?? null,
      slackDays: r ? workingDaysBetween(f.plannedFinish, r.latestFinish, calendar) : null,
    });
  }
  await tx.caseTimeline.update({ where: { id: timeline.id }, data: { feasible, deficitDays, lastPlannedAt: now } });
  return { feasible, deficitDays, targetDate, stages };
}

/** Convenience for audit payloads that want the target as a YYYY-MM-DD string. */
export const targetKey = (d: Date | null): string | null => (d ? toKey(d) : null);

import { describe, it, expect } from '@jest/globals';
import {
  forwardPlan, reversePlan, computeFeasibility, PlanStageInput, PlanDurationType,
} from '../../src/services/case-planning.service';
import { PlanningCalendar, toKey, workingDaysBetween } from '../../src/services/case-planning.dates';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const cal: PlanningCalendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: new Set() };
// 2026-03-02 is a Monday.
const MON = d('2026-03-02');

function stage(over: Partial<PlanStageInput> = {}): PlanStageInput {
  return {
    durationValue: 3, durationType: 'DAYS' as PlanDurationType, externalWaiting: false,
    bufferDays: 0, dependsOnPrevious: true, remainingDurationOverride: null, startedAt: null, ...over,
  };
}
const k = (r: { plannedStart: Date; plannedFinish: Date }) => [toKey(r.plannedStart), toKey(r.plannedFinish)];

describe('forwardPlan', () => {
  it('dependent chain: DAYS internal, buffer 0', () => {
    const f = forwardPlan([stage({ durationValue: 3 }), stage({ durationValue: 3 })], { now: MON, calendar: cal });
    // S0 Mon..Wed (3 working days incl start); S1 starts next working day Thu, Thu..Mon.
    expect(k(f[0])).toEqual(['2026-03-02', '2026-03-04']);
    expect(k(f[1])).toEqual(['2026-03-05', '2026-03-09']);
  });

  it('parallel (dependsOnPrevious=false) both anchor on now', () => {
    const f = forwardPlan([stage({ durationValue: 3 }), stage({ durationValue: 2, dependsOnPrevious: false })], { now: MON, calendar: cal });
    expect(toKey(f[1].plannedStart)).toBe('2026-03-02'); // not chained off S0
    expect(toKey(f[1].plannedFinish)).toBe('2026-03-03'); // Mon..Tue
  });

  it('DAYS internal vs external counting from a Friday', () => {
    const fri = d('2026-03-06');
    const internal = forwardPlan([stage({ durationValue: 3, dependsOnPrevious: false, startedAt: fri })], { now: MON, calendar: cal });
    const external = forwardPlan([stage({ durationValue: 3, externalWaiting: true, dependsOnPrevious: false, startedAt: fri })], { now: MON, calendar: cal });
    expect(toKey(internal[0].plannedFinish)).toBe('2026-03-10'); // Fri->Mon->Tue (working)
    expect(toKey(external[0].plannedFinish)).toBe('2026-03-08'); // Fri + 2 calendar = Sun
  });

  it('WEEKS and MONTHS are calendar spans', () => {
    const w = forwardPlan([stage({ durationValue: 2, durationType: 'WEEKS' })], { now: MON, calendar: cal });
    expect(toKey(w[0].plannedFinish)).toBe('2026-03-15'); // Mon + 13 calendar days
    const m = forwardPlan([stage({ durationValue: 1, durationType: 'MONTHS' })], { now: MON, calendar: cal });
    expect(toKey(m[0].plannedFinish)).toBe('2026-04-01'); // (Mar 02 + 1 month) - 1 calendar day
  });

  it('buffer folds into finish (calendar days)', () => {
    const f = forwardPlan([stage({ durationValue: 3, bufferDays: 2 })], { now: MON, calendar: cal });
    // occupiedEnd Wed 03-04, + 2 calendar days = Fri 03-06.
    expect(toKey(f[0].plannedFinish)).toBe('2026-03-06');
  });

  it('milestone: null duration → finish == start (+buffer)', () => {
    const f = forwardPlan([stage({ durationValue: null, durationType: null })], { now: MON, calendar: cal });
    expect(k(f[0])).toEqual(['2026-03-02', '2026-03-02']);
    const fb = forwardPlan([stage({ durationValue: 0, durationType: 'DAYS', bufferDays: 3 })], { now: MON, calendar: cal });
    expect(toKey(fb[0].plannedFinish)).toBe('2026-03-05'); // start + 3 calendar buffer
  });

  it('remainingDurationOverride replaces durationValue', () => {
    const f = forwardPlan([stage({ durationValue: 3, remainingDurationOverride: 1 })], { now: MON, calendar: cal });
    expect(toKey(f[0].plannedFinish)).toBe('2026-03-02'); // 1 working day incl start
  });
});

describe('reversePlan + slack + feasibility', () => {
  const stages = [stage({ durationValue: 2 }), stage({ durationValue: 2 })];

  it('latest dates walk back from target; slack computed', () => {
    const target = d('2026-03-13'); // Fri
    const f = forwardPlan(stages, { now: MON, calendar: cal });
    const r = reversePlan(stages, { targetDate: target, calendar: cal });
    // S1 last: latestFinish target 03-13, latestStart = target - 1 working day = Thu 03-12.
    expect([toKey(r[1].latestStart), toKey(r[1].latestFinish)]).toEqual(['2026-03-12', '2026-03-13']);
    // S0: latestFinish = S1.latestStart - 1 working day = Wed 03-11; latestStart = 03-10.
    expect([toKey(r[0].latestStart), toKey(r[0].latestFinish)]).toEqual(['2026-03-10', '2026-03-11']);
    // planned finishes: S0 03-03, S1 03-05.
    expect(workingDaysBetween(f[1].plannedFinish, r[1].latestFinish, cal)).toBe(6);
    expect(workingDaysBetween(f[0].plannedFinish, r[0].latestFinish, cal)).toBe(6);
  });

  it('feasible when final plannedFinish <= target; deficit 0', () => {
    const f = forwardPlan(stages, { now: MON, calendar: cal });
    const fe = computeFeasibility(f[1].plannedFinish, d('2026-03-13'), cal);
    expect(fe).toEqual({ feasible: true, deficitDays: 0 });
  });

  it('infeasible → deficitDays = working days from target to final finish', () => {
    const f = forwardPlan(stages, { now: MON, calendar: cal }); // final finish 03-05
    const fe = computeFeasibility(f[1].plannedFinish, d('2026-03-04'), cal);
    expect(fe).toEqual({ feasible: false, deficitDays: 1 });
  });

  it('no target → feasibility null', () => {
    expect(computeFeasibility(d('2026-03-05'), null, cal)).toEqual({ feasible: null, deficitDays: null });
  });
});

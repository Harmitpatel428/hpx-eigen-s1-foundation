import { computeStageSlaState, shouldHardBlock, SlaStageInput } from '../../src/services/case-sla.compute';
import { PlanningCalendar } from '../../src/services/case-planning.dates';

const cal: PlanningCalendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: new Set() };
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// Stage A: Tue 2026-09-01 -> Fri 2026-09-11 (10 calendar days)
const base: SlaStageInput = {
  status: 'IN_PROGRESS', completedAt: null, plannedStart: d('2026-09-01'), plannedFinish: d('2026-09-11'),
  atRiskPercent: null, warnDaysRemaining: null, hardBlock: false, hardBlockUnlockedAt: null, exceptionApproved: false,
};
const st = (o: Partial<SlaStageInput>): SlaStageInput => ({ ...base, ...o });
const run = (o: Partial<SlaStageInput>, now: string) => computeStageSlaState(st(o), new Date(`${now}T15:30:00.000Z`), cal);

describe('computeStageSlaState', () => {
  it('COMPLETED on time / late / no plannedFinish', () => {
    expect(run({ status: 'COMPLETED', completedAt: d('2026-09-11') }, '2026-10-01')).toBe('COMPLETED_ON_TIME');
    expect(run({ status: 'COMPLETED', completedAt: d('2026-09-12') }, '2026-10-01')).toBe('COMPLETED_LATE');
    expect(run({ status: 'COMPLETED', completedAt: d('2026-09-12'), plannedFinish: null }, '2026-10-01')).toBeNull();
  });
  it('SKIPPED -> null', () => expect(run({ status: 'SKIPPED' }, '2026-09-20')).toBeNull());
  it('exceptionApproved wins over overdue and WAITING_EXTERNAL', () => {
    expect(run({ exceptionApproved: true }, '2026-09-20')).toBe('EXCEPTION_APPROVED');
    expect(run({ exceptionApproved: true, status: 'WAITING_EXTERNAL' }, '2026-09-20')).toBe('EXCEPTION_APPROVED');
  });
  it('WAITING_EXTERNAL', () => expect(run({ status: 'WAITING_EXTERNAL' }, '2026-09-20')).toBe('WAITING_EXTERNAL'));
  it('BLOCKED -> OVERDUE', () => expect(run({ status: 'BLOCKED' }, '2026-09-02')).toBe('OVERDUE'));
  it('non-terminal without plannedFinish -> null', () => expect(run({ plannedFinish: null }, '2026-09-05')).toBeNull());
  it('OVERDUE only once date-only now is past plannedFinish', () => {
    expect(run({}, '2026-09-12')).toBe('OVERDUE');
    expect(run({}, '2026-09-11')).toBe('AT_RISK'); // finish day itself is not overdue
  });
  it('AT_RISK by percent boundary (warn disabled)', () => {
    expect(run({ atRiskPercent: 50, warnDaysRemaining: 0 }, '2026-09-06')).toBe('AT_RISK'); // exactly 50%
    expect(run({ atRiskPercent: 50, warnDaysRemaining: 0 }, '2026-09-05')).toBe('ON_TRACK'); // 40%
  });
  it('AT_RISK by warnDaysRemaining boundary (percent disabled)', () => {
    expect(run({ atRiskPercent: 100, warnDaysRemaining: 2 }, '2026-09-09')).toBe('AT_RISK'); // 2 wd left
    expect(run({ atRiskPercent: 100, warnDaysRemaining: 2 }, '2026-09-08')).toBe('ON_TRACK'); // 3 wd left
  });
  it('defaults 80% / 2 days when null', () => {
    const long = { plannedStart: d('2026-09-21'), plannedFinish: d('2026-10-21') }; // 30 days
    expect(run(long, '2026-10-15')).toBe('AT_RISK'); // 80%, 4 wd left
    expect(run(long, '2026-10-14')).toBe('ON_TRACK'); // 76.7%, 5 wd left
    expect(run({ ...long, atRiskPercent: 100 }, '2026-10-19')).toBe('AT_RISK'); // 2 wd left
    expect(run({ ...long, atRiskPercent: 100 }, '2026-10-16')).toBe('ON_TRACK'); // 3 wd left
  });
  it('ON_TRACK otherwise', () => expect(run({}, '2026-09-02')).toBe('ON_TRACK'));
  it('null plannedStart -> elapsed 100% -> AT_RISK', () => expect(run({ plannedStart: null }, '2026-09-02')).toBe('AT_RISK'));
});

describe('shouldHardBlock', () => {
  const hb = { hardBlock: true };
  it('true only for OVERDUE + hardBlock + not unlocked + not BLOCKED', () => {
    expect(shouldHardBlock(st(hb), 'OVERDUE')).toBe(true);
  });
  it('false when unlocked', () => expect(shouldHardBlock(st({ ...hb, hardBlockUnlockedAt: d('2026-09-10') }), 'OVERDUE')).toBe(false));
  it('false when hardBlock false', () => expect(shouldHardBlock(st({ hardBlock: false }), 'OVERDUE')).toBe(false));
  it('false when already BLOCKED', () => expect(shouldHardBlock(st({ ...hb, status: 'BLOCKED' }), 'OVERDUE')).toBe(false));
  it('false when not OVERDUE (incl. exceptionApproved)', () => {
    const s = st({ ...hb, exceptionApproved: true });
    expect(shouldHardBlock(s, computeStageSlaState(s, d('2026-09-20'), cal))).toBe(false);
    expect(shouldHardBlock(st(hb), null)).toBe(false);
  });
});

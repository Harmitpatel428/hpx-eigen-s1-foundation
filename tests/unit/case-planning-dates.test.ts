import {
  PlanningCalendar, toKey, isWorkingDay, addWorkingDays, subtractWorkingDays,
  addCalendarDays, addMonths, workingDaysBetween,
} from '../../src/services/case-planning.dates';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const cal: PlanningCalendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: new Set() };
const withHol = (...h: string[]): PlanningCalendar => ({ ...cal, holidays: new Set(h) });
// 2026-03-02 is a Monday
const MON = '2026-03-02', WED = '2026-03-04', FRI = '2026-03-06', NEXT_MON = '2026-03-09', SAT = '2026-03-07';

describe('case-planning dates', () => {
  it('toKey returns UTC YYYY-MM-DD', () => expect(toKey(d(MON))).toBe(MON));

  it('isWorkingDay: weekday, weekend, holiday', () => {
    expect(isWorkingDay(d(MON), cal)).toBe(true);
    expect(isWorkingDay(d(SAT), cal)).toBe(false);
    expect(isWorkingDay(d(MON), withHol(MON))).toBe(false);
  });

  it('addWorkingDays skips weekend and holiday; n=0 unchanged', () => {
    expect(toKey(addWorkingDays(d(FRI), 1, cal))).toBe(NEXT_MON);
    expect(toKey(addWorkingDays(d(FRI), 1, withHol(NEXT_MON)))).toBe('2026-03-10');
    expect(toKey(addWorkingDays(d(SAT), 0, cal))).toBe(SAT);
  });

  it('throws instead of spinning when workingWeekdays is empty', () => {
    const empty: PlanningCalendar = { workingWeekdays: [], holidays: new Set() };
    expect(() => addWorkingDays(d(MON), 1, empty)).toThrow('workingWeekdays must not be empty');
    expect(() => subtractWorkingDays(d(MON), 1, empty)).toThrow();
  });

  it('subtractWorkingDays is symmetric; n=0 unchanged', () => {
    expect(toKey(subtractWorkingDays(d(NEXT_MON), 1, cal))).toBe(FRI);
    expect(toKey(subtractWorkingDays(d(NEXT_MON), 1, withHol(FRI)))).toBe('2026-03-05');
    expect(toKey(subtractWorkingDays(d(SAT), 0, cal))).toBe(SAT);
  });

  it('addCalendarDays ignores weekends, handles negatives', () => {
    expect(toKey(addCalendarDays(d(FRI), 1))).toBe(SAT);
    expect(toKey(addCalendarDays(d(MON), -1))).toBe('2026-03-01');
  });

  it('addMonths clamps end-of-month', () => {
    expect(toKey(addMonths(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(toKey(addMonths(d('2028-01-31'), 1))).toBe('2028-02-29');
    expect(toKey(addMonths(d('2026-03-15'), 2))).toBe('2026-05-15');
    expect(toKey(addMonths(d('2026-11-30'), 3))).toBe('2027-02-28');
  });

  it('workingDaysBetween sign and magnitude', () => {
    expect(workingDaysBetween(d(MON), d(WED), cal)).toBe(2);
    expect(workingDaysBetween(d(FRI), d(NEXT_MON), cal)).toBe(1);
    expect(workingDaysBetween(d(WED), d(MON), cal)).toBe(-2);
    expect(workingDaysBetween(d(MON), d(MON), cal)).toBe(0);
    expect(workingDaysBetween(d(FRI), d(NEXT_MON), withHol(NEXT_MON))).toBe(0);
  });
});

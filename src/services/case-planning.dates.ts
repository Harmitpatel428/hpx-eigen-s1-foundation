/**
 * Pure date-only business-day math. All Dates are UTC midnight; native Date only.
 */
export interface PlanningCalendar {
  workingWeekdays: number[]; // 0=Sun..6=Sat
  holidays: Set<string>; // YYYY-MM-DD (UTC)
}

const DAY_MS = 86_400_000;

export function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isWorkingDay(date: Date, cal: PlanningCalendar): boolean {
  return cal.workingWeekdays.includes(date.getUTCDay()) && !cal.holidays.has(toKey(date));
}

export function addCalendarDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * DAY_MS);
}

// ponytail: step-by-step walk, O(n); fine for planning horizons.
function walk(date: Date, n: number, dir: 1 | -1, cal: PlanningCalendar): Date {
  if (n > 0 && cal.workingWeekdays.length === 0) throw new Error('workingWeekdays must not be empty');
  let d = date;
  for (let left = n; left > 0; ) {
    d = addCalendarDays(d, dir);
    if (isWorkingDay(d, cal)) left--;
  }
  return d;
}

export function addWorkingDays(date: Date, n: number, cal: PlanningCalendar): Date {
  return walk(date, n, 1, cal);
}

export function subtractWorkingDays(date: Date, n: number, cal: PlanningCalendar): Date {
  return walk(date, n, -1, cal);
}

export function addMonths(date: Date, n: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay)));
}

/** Signed count of working days in (from, to]; negative when `to` is earlier. */
export function workingDaysBetween(from: Date, to: Date, cal: PlanningCalendar): number {
  const a = from.getTime();
  const b = to.getTime();
  if (a === b) return 0;
  const dir = b > a ? 1 : -1;
  let count = 0;
  for (let d = addCalendarDays(from, dir); ; d = addCalendarDays(d, dir)) {
    if (isWorkingDay(d, cal)) count++;
    if (d.getTime() === b) break;
  }
  return dir * count;
}

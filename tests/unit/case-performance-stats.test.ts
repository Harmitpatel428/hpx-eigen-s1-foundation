import {
  activeTimeDays, roundHalfDay, median, confidenceFor, trendFor, summarize, StageEventLite,
} from '../../src/services/case-performance.stats';

const D = (day: number, hour = 0) => new Date(Date.UTC(2026, 0, day, hour));
const ev = (toStatus: string | null, at: Date): StageEventLite => ({ toStatus, createdAt: at });

describe('activeTimeDays', () => {
  it('single IN_PROGRESS -> COMPLETED period', () => {
    expect(activeTimeDays([ev('IN_PROGRESS', D(1)), ev('COMPLETED', D(4))])).toBe(3);
  });
  it('pause/resume sums two periods', () => {
    expect(activeTimeDays([
      ev('IN_PROGRESS', D(1)), ev('PAUSED', D(3)), ev('IN_PROGRESS', D(6)), ev('COMPLETED', D(7)),
    ])).toBe(3);
  });
  it('excludes WAITING_EXTERNAL', () => {
    expect(activeTimeDays([
      ev('IN_PROGRESS', D(1)), ev('WAITING_EXTERNAL', D(2)), ev('IN_PROGRESS', D(10)), ev('COMPLETED', D(11)),
    ])).toBe(2);
  });
  it('DURATION_OVERRIDDEN mid IN_PROGRESS splits but preserves total', () => {
    expect(activeTimeDays([
      ev('IN_PROGRESS', D(1)), ev('IN_PROGRESS', D(3)), ev('COMPLETED', D(5)),
    ])).toBe(4);
  });
  it('trailing unclosed IN_PROGRESS contributes 0', () => {
    expect(activeTimeDays([ev('IN_PROGRESS', D(1)), ev('COMPLETED', D(2)), ev('IN_PROGRESS', D(9))])).toBe(1);
    expect(activeTimeDays([ev('IN_PROGRESS', D(1))])).toBe(0);
    expect(activeTimeDays([])).toBe(0);
  });
  it('supports fractional days', () => {
    expect(activeTimeDays([ev('IN_PROGRESS', D(1)), ev('COMPLETED', D(1, 12))])).toBe(0.5);
  });
});

describe('median', () => {
  it('odd', () => expect(median([5, 1, 3])).toBe(3));
  it('even', () => expect(median([4, 1, 3, 2])).toBe(2.5));
  it('empty', () => expect(median([])).toBe(0));
});

describe('roundHalfDay', () => {
  it.each([[1.2, 1], [1.25, 1.5], [1.74, 1.5], [1.75, 2], [0, 0], [3, 3]])('%p -> %p', (n, e) => {
    expect(roundHalfDay(n)).toBe(e);
  });
});

describe('confidenceFor', () => {
  it.each([[0, 'INSUFFICIENT'], [4, 'INSUFFICIENT'], [5, 'LOW'], [9, 'LOW'], [10, 'MODERATE'], [24, 'MODERATE'], [25, 'HIGH'], [100, 'HIGH']])(
    '%p -> %p', (n, e) => expect(confidenceFor(n as number)).toBe(e));
});

describe('trendFor', () => {
  it('1.20 exactly -> NONE', () => expect(trendFor(10, 12)).toBe('NONE'));
  it('just over 1.20 -> SLOWER', () => expect(trendFor(10, 12.01)).toBe('SLOWER'));
  it('0.80 exactly -> NONE', () => expect(trendFor(10, 8)).toBe('NONE'));
  it('just under 0.80 -> FASTER', () => expect(trendFor(10, 7.99)).toBe('FASTER'));
  it('median 0 -> NONE', () => expect(trendFor(0, 5)).toBe('NONE'));
});

describe('summarize', () => {
  it('recent median uses only last 10 by completedAt desc', () => {
    // 5 old slow samples (100d) + 10 recent (2d); input intentionally unsorted
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => ({ activeDays: 2, completedAt: D(10 + i) })),
      ...Array.from({ length: 5 }, (_, i) => ({ activeDays: 100, completedAt: D(1 + i) })),
    ].reverse();
    const r = summarize(samples);
    expect(r.sampleCount).toBe(15);
    expect(r.recentMedianDays).toBe(2);
    expect(r.medianDays).toBe(2);
  });
  it('rounds to half day and handles empty', () => {
    expect(summarize([{ activeDays: 1.3, completedAt: D(1) }]).medianDays).toBe(1.5);
    expect(summarize([])).toEqual({ sampleCount: 0, medianDays: 0, recentMedianDays: 0 });
  });
});

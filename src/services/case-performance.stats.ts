// Pure stats helpers for case performance/forecast. No I/O.

export interface StageEventLite { toStatus: string | null; createdAt: Date; }
export type Confidence = 'INSUFFICIENT' | 'LOW' | 'MODERATE' | 'HIGH';
export type Trend = 'SLOWER' | 'FASTER' | 'NONE';

const DAY_MS = 86400000;

/** events: ONE stage, ascending. Sums closed IN_PROGRESS intervals in wall-clock days. */
export function activeTimeDays(events: StageEventLite[]): number {
  let ms = 0;
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].toStatus === 'IN_PROGRESS') {
      ms += events[i + 1].createdAt.getTime() - events[i].createdAt.getTime();
    }
  }
  return ms / DAY_MS;
}

export function roundHalfDay(n: number): number {
  return Math.round(n * 2) / 2;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function confidenceFor(sampleCount: number): Confidence {
  if (sampleCount < 5) return 'INSUFFICIENT';
  if (sampleCount < 10) return 'LOW';
  if (sampleCount < 25) return 'MODERATE';
  return 'HIGH';
}

export function trendFor(medianVal: number, recentMedian: number): Trend {
  if (!(medianVal > 0)) return 'NONE';
  if (recentMedian > medianVal * 1.2) return 'SLOWER';
  if (recentMedian < medianVal * 0.8) return 'FASTER';
  return 'NONE';
}

export function summarize(samples: { activeDays: number; completedAt: Date }[]): {
  sampleCount: number;
  medianDays: number;
  recentMedianDays: number;
} {
  const recent = [...samples]
    .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime())
    .slice(0, 10);
  return {
    sampleCount: samples.length,
    medianDays: roundHalfDay(median(samples.map((s) => s.activeDays))),
    recentMedianDays: roundHalfDay(median(recent.map((s) => s.activeDays))),
  };
}

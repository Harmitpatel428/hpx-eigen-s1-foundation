/**
 * Phase 8 — per-case completion forecast. PURE READ.
 *
 * Estimates each incomplete stage's remaining duration via the fallback chain
 * (override → primary summary → tenant-wide summary → configured duration) and
 * forward-chains those estimates into a projected completion date.
 *
 * Reuses Task 2 stats + Task 3 loadOrCreateSummary + Phase 7 date math. The forward
 * chain replicates Phase 7's occupiedEnd/finish arithmetic as PURE helpers here (those
 * helpers are module-private in case-planning.service). This service NEVER calls
 * recalcInTx and NEVER writes planned/baseline/latest columns — the only permitted
 * write is loadOrCreateSummary lazily creating a StagePerformanceSummary row.
 */
import { PrismaClient, Prisma, CaseStageStatus } from '@prisma/client';
import { confidenceFor, trendFor, Confidence } from './case-performance.stats';
import { loadOrCreateSummary } from './case-performance.service';
import { PlanDurationType, dateOnly } from './case-planning.service';
import { addWorkingDays, addCalendarDays } from './case-planning.dates';
import { loadPlanningCalendar } from './case-calendar.service';
import { ResourceNotFoundError } from '../types/exceptions';

type Client = PrismaClient | Prisma.TransactionClient;

export interface ForecastStage {
  stageKey: string;
  estimateDays: number;
  confidence: Confidence;
  explanation: string;
}
export interface ForecastResponse {
  projectedCompletion: Date | null;
  stages: ForecastStage[];
}

const EXTERNAL_WAITING = 'External-waiting time is excluded from the active-time estimate.';

/** Scalar duration→days: DAYS as-is, WEEKS×7, MONTHS×30; null value → 0. */
function toDays(value: number | null, type: PlanDurationType): number {
  if (value == null) return 0;
  switch (type) {
    case 'WEEKS': return value * 7;
    case 'MONTHS': return value * 30;
    case 'DAYS': return value;
    default: return 0; // milestone / no type
  }
}

/**
 * Statistical estimates are wall-clock-measured active time -> chained as calendar days.
 * Configured/override durations are business-day targets -> chained per Phase 7 durationType semantics
 * (internal DAYS = working days; external / WEEKS / MONTHS = calendar days). Each source chains in its own unit.
 * Inclusive of the start day; buffer added as calendar days after.
 */
function chainFinish(
  start: Date, days: number, statistical: boolean, durationType: PlanDurationType,
  externalWaiting: boolean, bufferDays: number | null, cal: Parameters<typeof addWorkingDays>[2],
): Date {
  const working = !statistical && durationType === 'DAYS' && !externalWaiting;
  const occ = days <= 0 ? start : (working ? addWorkingDays(start, days - 1, cal) : addCalendarDays(start, days - 1));
  return addCalendarDays(occ, bufferDays ?? 0);
}

interface StageRow {
  id: string; key: string; sequence: number; status: CaseStageStatus;
  durationValue: number | null; durationType: PlanDurationType;
  externalWaiting: boolean; bufferDays: number | null; dependsOnPrevious: boolean;
  remainingDurationOverride: number | null; completedAt: Date | null;
}

function isIncomplete(status: CaseStageStatus): boolean {
  return status !== CaseStageStatus.COMPLETED && status !== CaseStageStatus.SKIPPED;
}

async function estimateForStage(
  client: Client, tenantId: string, caseTypeId: string | null, s: StageRow,
): Promise<{ estimateDays: number; confidence: Confidence; explanation: string }> {
  // 1. Manual override wins over the summary path.
  if (s.remainingDurationOverride != null) {
    return {
      estimateDays: toDays(s.remainingDurationOverride, s.durationType),
      confidence: 'INSUFFICIENT',
      explanation: 'A manual remaining-duration override is set; using the override, not the estimate.',
    };
  }
  // 2. Primary summary (this case type).
  const primary = await loadOrCreateSummary(client, tenantId, caseTypeId, s.key);
  if (primary.sampleCount >= 5) {
    const trend = trendFor(primary.medianDays, primary.recentMedianDays);
    let explanation: string;
    if (trend === 'SLOWER') explanation = `Recent cases are running slower than usual (recent median ${primary.recentMedianDays} vs overall ${primary.medianDays} days).`;
    else if (trend === 'FASTER') explanation = `Recent cases are completing faster than usual (recent median ${primary.recentMedianDays} vs overall ${primary.medianDays} days).`;
    else explanation = `Based on ${primary.sampleCount} comparable samples (median ${primary.medianDays} days).`;
    return { estimateDays: primary.medianDays, confidence: confidenceFor(primary.sampleCount), explanation };
  }
  // 3. Tenant-wide summary (all case types).
  const wide = await loadOrCreateSummary(client, tenantId, null, s.key);
  if (wide.sampleCount >= 5) {
    return {
      estimateDays: wide.medianDays,
      confidence: confidenceFor(wide.sampleCount),
      explanation: `Based on ${wide.sampleCount} samples across all case types for this stage.`,
    };
  }
  // 4. Configured effective duration (no override here → durationValue).
  return {
    estimateDays: toDays(s.durationValue, s.durationType),
    confidence: 'INSUFFICIENT',
    explanation: `Not enough comparable history (${primary.sampleCount} samples); using the configured stage duration.`,
  };
}

/**
 * Tenant-scoped. Other-tenant / unknown caseId (or a case with no timeline) → ResourceNotFoundError (404).
 * `now` is injectable for deterministic tests.
 */
export async function forecastCase(
  client: Client, tenantId: string, caseId: string, now: Date = new Date(),
): Promise<ForecastResponse> {
  const timeline = await client.caseTimeline.findFirst({
    where: { caseId, tenantId },
    include: { stages: { orderBy: { sequence: 'asc' } } },
  });
  if (!timeline) throw new ResourceNotFoundError();

  const calendar = await loadPlanningCalendar(client, tenantId);
  const caseTypeId = timeline.caseTypeId ?? null;
  const rows = timeline.stages as unknown as StageRow[];

  // Estimate every incomplete stage once (lazy-creates summaries as needed).
  const estimates = new Map<string, { estimateDays: number; confidence: Confidence; explanation: string }>();
  const outStages: ForecastStage[] = [];
  for (const s of rows) {
    if (!isIncomplete(s.status)) continue;
    const est = await estimateForStage(client, tenantId, caseTypeId, s);
    estimates.set(s.id, est);
    outStages.push({
      stageKey: s.key,
      estimateDays: est.estimateDays,
      confidence: est.confidence,
      explanation: s.externalWaiting ? `${est.explanation} ${EXTERNAL_WAITING}` : est.explanation,
    });
  }

  // Forward-chain: completed stages anchor on their real completedAt; incomplete stages chain the
  // (rounded) estimate forward with Phase 7 arithmetic; skipped stages add no time.
  const anchorNow = dateOnly(now);
  let prevFinish: Date | null = null;
  let lastActual: Date | null = null;
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    let thisFinish: Date;
    if (s.status === CaseStageStatus.COMPLETED && s.completedAt) {
      thisFinish = dateOnly(s.completedAt);
      lastActual = thisFinish;
    } else if (!isIncomplete(s.status)) {
      // SKIPPED, or COMPLETED with a null completedAt — terminal, adds no time and has no estimate.
      thisFinish = prevFinish ?? lastActual ?? anchorNow;
    } else {
      const est = estimates.get(s.id)!;
      const days = Math.round(est.estimateDays);
      const start = s.dependsOnPrevious && i > 0 && prevFinish
        ? addWorkingDays(prevFinish, 1, calendar)
        : (lastActual ?? anchorNow);
      thisFinish = chainFinish(start, days, est.confidence !== 'INSUFFICIENT', s.durationType, s.externalWaiting, s.bufferDays, calendar);
    }
    prevFinish = thisFinish;
  }

  return { projectedCompletion: prevFinish, stages: outStages };
}

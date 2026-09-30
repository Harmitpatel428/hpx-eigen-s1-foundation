/**
 * Phase 9 — pure SLA classification. No I/O, native Date, date-only UTC compares.
 */
import type { CaseStageStatus, CaseStageSlaState } from '@prisma/client';
import { PlanningCalendar, workingDaysBetween } from './case-planning.dates';
import { dateOnly } from './case-planning.service';

export const DEFAULT_AT_RISK_PERCENT = 80;
export const DEFAULT_WARN_DAYS_REMAINING = 2;

export interface SlaStageInput {
  status: CaseStageStatus;
  completedAt: Date | null;
  plannedStart: Date | null;
  plannedFinish: Date | null;
  atRiskPercent: number | null;
  warnDaysRemaining: number | null;
  hardBlock: boolean;
  hardBlockUnlockedAt: Date | null;
  exceptionApproved: boolean;
}

export function computeStageSlaState(stage: SlaStageInput, now: Date, cal: PlanningCalendar): CaseStageSlaState | null {
  const { plannedStart, plannedFinish } = stage;
  if (stage.status === 'COMPLETED') {
    if (plannedFinish == null) return null;
    // completedAt should be set when COMPLETED; if not, treat as on time.
    const onTime = stage.completedAt == null || dateOnly(stage.completedAt) <= plannedFinish;
    return onTime ? 'COMPLETED_ON_TIME' : 'COMPLETED_LATE';
  }
  if (stage.status === 'SKIPPED') return null;
  if (stage.exceptionApproved) return 'EXCEPTION_APPROVED';
  if (stage.status === 'WAITING_EXTERNAL') return 'WAITING_EXTERNAL';
  if (stage.status === 'BLOCKED') return 'OVERDUE';
  if (plannedFinish == null) return null;

  const today = dateOnly(now);
  if (today > plannedFinish) return 'OVERDUE';

  const elapsedPercent = plannedStart != null && plannedFinish.getTime() > plannedStart.getTime()
    ? ((today.getTime() - plannedStart.getTime()) / (plannedFinish.getTime() - plannedStart.getTime())) * 100
    : 100;
  if (
    elapsedPercent >= (stage.atRiskPercent ?? DEFAULT_AT_RISK_PERCENT) ||
    workingDaysBetween(today, plannedFinish, cal) <= (stage.warnDaysRemaining ?? DEFAULT_WARN_DAYS_REMAINING)
  ) return 'AT_RISK';
  return 'ON_TRACK';
}

export function shouldHardBlock(stage: SlaStageInput, slaState: CaseStageSlaState | null): boolean {
  return slaState === 'OVERDUE' && stage.hardBlock === true && stage.hardBlockUnlockedAt == null && stage.status !== 'BLOCKED';
}

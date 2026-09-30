import { PrismaClient, CaseStageStatus, CaseStageSlaState } from '@prisma/client';
import { computeStageSlaState, shouldHardBlock, SlaStageInput } from '../services/case-sla.compute';
import { loadPlanningCalendar } from '../services/case-calendar.service';
import { NotificationService } from '../services/notification.service';
import { AuditService } from '../services/audit.service';
import { logger } from '../utils/logger';

let isRunning = false;

const TERMINAL: CaseStageStatus[] = ['COMPLETED', 'SKIPPED'];
const TX_OPTS = { maxWait: 5000, timeout: 15000 };

/**
 * Phase 9 — periodic SLA sweep. Reclassifies non-terminal stages of ACTIVE
 * timelines, applies the hard-block transition, and emits edge-triggered
 * in-app notifications. System actor (actorUserId null). `now` injectable.
 *
 * Notification-vs-tx boundary: per-tenant slaState / block writes + audit run
 * inside ONE interactive tx. Notifications are written through a NotificationService
 * bound to the top-level `prisma` (a SEPARATE connection, not `tx`) and wrapped in
 * try/catch, so a notification failure can neither roll back nor abort the tenant
 * tx — the slaState/block writes still commit. slaNotifiedForState is advanced only
 * after a successful emit, so a failure re-notifies next tick (at-least-once).
 *
 * Returns the number of stages whose slaState changed.
 */
export async function runSlaSweep(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  if (isRunning) return 0;
  isRunning = true;

  const notifier = new NotificationService(prisma); // own connection — decoupled from per-tenant tx
  let changed = 0;

  try {
    const timelines = await prisma.caseTimeline.findMany({
      where: { status: 'ACTIVE', stages: { some: { status: { notIn: TERMINAL } } } },
      select: {
        tenantId: true,
        caseId: true,
        exceptionApproved: true,
        case: { select: { assignedTo: true, createdBy: true, caseNumber: true } },
        stages: {
          where: { status: { notIn: TERMINAL } },
          select: {
            id: true, key: true, label: true, status: true, completedAt: true, plannedStart: true, plannedFinish: true,
            atRiskPercent: true, warnDaysRemaining: true, hardBlock: true, hardBlockUnlockedAt: true,
            slaState: true, slaNotifiedForState: true,
          },
        },
      },
    });

    // Group by tenant so each tenant gets one tx + one calendar load.
    const byTenant = new Map<string, typeof timelines>();
    for (const tl of timelines) {
      const list = byTenant.get(tl.tenantId) ?? [];
      list.push(tl);
      byTenant.set(tl.tenantId, list);
    }

    for (const [tenantId, tls] of byTenant) {
      try {
        const audit = new AuditService(prisma);
        // Notifications to emit AFTER the tenant tx commits (recipients keyed by stageId).
        const notifyQueue: { stageId: string; caseId: string; caseRef: string; stageLabel: string; recipients: string[]; state: CaseStageSlaState }[] = [];

        const tenantChanged = await prisma.$transaction(async (tx) => {
          let txChanged = 0;
          const cal = await loadPlanningCalendar(tx, tenantId);

          for (const tl of tls) {
            const recipients = [...new Set([tl.case.assignedTo, tl.case.createdBy].filter((u): u is string => !!u))];

            for (const stage of tl.stages) {
              const input: SlaStageInput = {
                status: stage.status,
                completedAt: stage.completedAt,
                plannedStart: stage.plannedStart,
                plannedFinish: stage.plannedFinish,
                atRiskPercent: stage.atRiskPercent,
                warnDaysRemaining: stage.warnDaysRemaining,
                hardBlock: stage.hardBlock,
                hardBlockUnlockedAt: stage.hardBlockUnlockedAt,
                exceptionApproved: tl.exceptionApproved,
              };
              const newState = computeStageSlaState(input, now, cal);
              const slaChanged = newState !== stage.slaState;
              const doBlock = shouldHardBlock(input, newState);

              if (doBlock) {
                const priorStatus = stage.status;
                await tx.caseStage.update({ where: { id: stage.id }, data: { status: CaseStageStatus.BLOCKED, slaState: newState } });
                await tx.caseStageEvent.create({
                  data: { tenantId, caseId: tl.caseId, stageId: stage.id, eventType: 'BLOCKED', fromStatus: priorStatus, toStatus: CaseStageStatus.BLOCKED, actorUserId: null },
                });
                await audit.appendInTx(tx, {
                  tenantId, eventType: 'CASE_STAGE_BLOCKED', entityType: 'CaseStage', entityId: stage.id,
                  operation: 'UPDATE', actorUserId: undefined, payload: { caseId: tl.caseId }, beforeState: { status: priorStatus },
                });
              } else if (slaChanged) {
                await tx.caseStage.update({ where: { id: stage.id }, data: { slaState: newState } });
              }

              // Left AT_RISK/OVERDUE → reset the edge so a later re-entry notifies again.
              const alerting = newState === 'AT_RISK' || newState === 'OVERDUE';
              if (!alerting && stage.slaNotifiedForState !== null) {
                await tx.caseStage.update({ where: { id: stage.id }, data: { slaNotifiedForState: null } });
              }

              if (slaChanged) txChanged++;

              // Edge-triggered notify: only on entry into AT_RISK / OVERDUE.
              if (alerting && stage.slaNotifiedForState !== newState) {
                notifyQueue.push({ stageId: stage.id, caseId: tl.caseId, caseRef: tl.case.caseNumber ?? tl.caseId, stageLabel: stage.label || stage.key, recipients, state: newState });
              }
            }
          }
          return txChanged;
        }, TX_OPTS);
        changed += tenantChanged; // committed only: a rolled-back tx throws before this line

        // Emit notifications OUTSIDE the tenant tx. A failure here logs + continues
        // and does NOT advance slaNotifiedForState (retries next tick); the slaState
        // and block writes are already committed.
        for (const n of notifyQueue) {
          if (n.recipients.length === 0) {
            // Nobody to notify — mark done so we don't re-scan it forever.
            await prisma.caseStage.update({ where: { id: n.stageId }, data: { slaNotifiedForState: n.state } }).catch((err) => logger.error({ err }, 'SLA worker: slaNotifiedForState update failed'));
            continue;
          }
          try {
            await notifier.createMany(n.recipients.map((u) => ({
              tenantId,
              recipientUserId: u,
              type: n.state === 'AT_RISK' ? 'CASE_STAGE_AT_RISK' as const : 'CASE_STAGE_OVERDUE' as const,
              title: n.state === 'AT_RISK' ? 'Case stage at risk' : 'Case stage overdue',
              message: `Stage "${n.stageLabel}" on case ${n.caseRef} is ${n.state === 'AT_RISK' ? 'at risk of breaching' : 'past'} its SLA deadline.`,
              actionUrl: `/documentation/cases/${n.caseId}`,
            })));
            await prisma.caseStage.update({ where: { id: n.stageId }, data: { slaNotifiedForState: n.state } });
          } catch (err) {
            logger.error({ err, stageId: n.stageId, state: n.state }, 'SLA worker: notification emit failed — will retry next tick');
          }
        }
      } catch (err) {
        // One tenant's failure must not starve the tenants after it.
        logger.error({ err, tenantId }, 'SLA sweep: tenant failed');
        continue;
      }
    }

    if (changed > 0) logger.info({ changed, runAt: now.toISOString() }, 'SLA worker: reclassified stages');
    return changed;
  } catch (err) {
    logger.error({ err }, 'SLA worker failed');
    return changed;
  } finally {
    isRunning = false;
  }
}

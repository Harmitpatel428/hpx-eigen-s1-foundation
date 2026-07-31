import { PrismaClient, OpportunityStage, Prisma } from '@prisma/client';
import { PipelineRepository } from '../repositories/pipeline.repo';
import { TenantContext } from '../repositories/base.repo';

export interface PipelineAnalytics {
  /** Total number of active (non-closed) opportunities */
  totalActiveOpportunities: number;
  /** Total pipeline value (sum of all active opportunity values) */
  totalPipelineValue: string;
  /** Number of opportunities in each stage */
  byStage: Record<OpportunityStage, number>;
  /** Average days spent in each stage (completed transitions only) */
  stageVelocity: Array<{ stage: OpportunityStage; avgDays: number; count: number }>;
  /** Opportunities won vs lost (closure rate) */
  closureStats: {
    won: number;
    lost: number;
    winRate: number;
  };
}

export class PipelineService {
  constructor(private readonly prisma: PrismaClient) {}

  private makeRepo(tx: PrismaClient, ctx: TenantContext) {
    return new PipelineRepository(ctx, tx);
  }

  /** Get full stage transition history for an opportunity */
  async getOpportunityHistory(tx: PrismaClient, ctx: TenantContext, opportunityId: string) {
    const repo = this.makeRepo(tx, ctx);
    return repo.findByOpportunity(tx, opportunityId);
  }

  /** Get the current active pipeline stage for an opportunity */
  async getCurrentStage(tx: PrismaClient, ctx: TenantContext, opportunityId: string) {
    const repo = this.makeRepo(tx, ctx);
    return repo.findCurrentStage(tx, opportunityId);
  }

  /** Get all opportunities currently in a specific pipeline stage */
  async getOpportunitiesByStage(tx: PrismaClient, ctx: TenantContext, stage: OpportunityStage) {
    const repo = this.makeRepo(tx, ctx);
    return repo.findByStage(tx, stage);
  }

  /** Compute stage velocity metrics — average days per stage */
  async getStageVelocity(tx: PrismaClient, ctx: TenantContext) {
    const repo = this.makeRepo(tx, ctx);
    return repo.stageVelocity(tx);
  }

  /**
   * Compute comprehensive pipeline analytics for the tenant's dashboard.
   * Aggregates opportunity counts, values, closure rates, and velocity.
   */
  async getPipelineAnalytics(tx: PrismaClient, ctx: TenantContext): Promise<PipelineAnalytics> {
    const activeStages: OpportunityStage[] = [
      OpportunityStage.PROSPECTING,
      OpportunityStage.QUALIFICATION,
      OpportunityStage.PROPOSAL,
      OpportunityStage.NEGOTIATION
    ];

    // Fetch all non-deleted opportunities for the tenant
    const opportunities = await tx.opportunity.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null },
      select: { stage: true, value: true }
    });

    // Count by stage
    const byStage = Object.values(OpportunityStage).reduce((acc, stage) => {
      acc[stage] = 0;
      return acc;
    }, {} as Record<OpportunityStage, number>);

    let totalPipelineValueCents = BigInt(0);
    let totalActiveOpportunities = 0;

    for (const opp of opportunities) {
      byStage[opp.stage] = (byStage[opp.stage] ?? 0) + 1;

      if (activeStages.includes(opp.stage)) {
        totalActiveOpportunities++;
        // value is Decimal — convert to string and parse
        totalPipelineValueCents += BigInt(Math.round(Number(opp.value) * 100));
      }
    }

    const totalPipelineValue = (Number(totalPipelineValueCents) / 100).toFixed(2);

    // Closure stats
    const won = byStage[OpportunityStage.CLOSED_WON];
    const lost = byStage[OpportunityStage.CLOSED_LOST];
    const totalClosed = won + lost;
    const winRate = totalClosed > 0 ? Math.round((won / totalClosed) * 100) : 0;

    // Stage velocity
    const repo = this.makeRepo(tx, ctx);
    const stageVelocity = await repo.stageVelocity(tx);

    return {
      totalActiveOpportunities,
      totalPipelineValue,
      byStage,
      stageVelocity,
      closureStats: { won, lost, winRate }
    };
  }

  /**
   * Predict expected closure date for an opportunity based on average
   * stage velocity and current stage entry time.
   */
  async predictClosureDate(tx: PrismaClient, ctx: TenantContext, opportunityId: string): Promise<Date | null> {
    const repo = this.makeRepo(tx, ctx);
    const history = await repo.findByOpportunity(tx, opportunityId);
    const velocity = await repo.stageVelocity(tx);

    if (history.length === 0) return null;

    const currentRecord = history[history.length - 1];
    if (!currentRecord || currentRecord.exitedAt) return null; // already closed

    // Stages remaining after current
    const stageOrder: OpportunityStage[] = [
      OpportunityStage.PROSPECTING,
      OpportunityStage.QUALIFICATION,
      OpportunityStage.PROPOSAL,
      OpportunityStage.NEGOTIATION
    ];

    const currentIdx = stageOrder.indexOf(currentRecord.stage);
    if (currentIdx === -1) return null; // terminal stage

    const remainingStages = stageOrder.slice(currentIdx);
    const velocityMap = new Map(velocity.map(v => [v.stage, v.avgDays]));

    let totalDays = 0;
    for (const stage of remainingStages) {
      totalDays += velocityMap.get(stage) ?? 14; // default 14 days if no history
    }

    const prediction = new Date(currentRecord.enteredAt);
    prediction.setDate(prediction.getDate() + totalDays);
    return prediction;
  }
}

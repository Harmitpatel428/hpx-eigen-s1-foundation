import { PrismaClient, OpportunityStage } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError } from '../types/exceptions';

export class PipelineRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /**
   * Get the full stage history for an opportunity, ordered chronologically.
   * Used to reconstruct deal velocity and stage durations.
   */
  async findByOpportunity(opportunityId: string) {
    return this.prisma.pipeline.findMany({
      where: {
        tenantId: this.ctx.tenantId,
        opportunityId
      },
      orderBy: { enteredAt: 'asc' }
    });
  }

  /**
   * Get the current (open) pipeline stage record for an opportunity.
   * Returns null if the deal is closed (exitedAt is set on all records).
   */
  async findCurrentStage(opportunityId: string) {
    return this.prisma.pipeline.findFirst({
      where: {
        tenantId: this.ctx.tenantId,
        opportunityId,
        exitedAt: null
      }
    });
  }

  /**
   * Get all opportunities currently in a specific stage.
   * Used for pipeline board views.
   */
  async findByStage(stage: OpportunityStage) {
    return this.prisma.pipeline.findMany({
      where: {
        tenantId: this.ctx.tenantId,
        stage,
        exitedAt: null
      },
      include: {
        opportunity: {
          select: {
            id: true,
            title: true,
            value: true,
            currency: true,
            ownerId: true,
            expectedCloseDate: true
          }
        }
      },
      orderBy: { enteredAt: 'asc' }
    });
  }

  /**
   * Record a stage transition — closes the current record and opens the next.
   * Note: OpportunityRepository.advanceStage() calls this within a transaction.
   * This method is also usable standalone for back-fills.
   */
  async recordTransition(opportunityId: string, fromStage: OpportunityStage | null, toStage: OpportunityStage) {
    return this.prisma.$transaction(async (tx) => {
      // Close any open stage record
      if (fromStage !== null) {
        await tx.pipeline.updateMany({
          where: {
            tenantId: this.ctx.tenantId,
            opportunityId,
            stage: fromStage,
            exitedAt: null
          },
          data: { exitedAt: new Date() }
        });
      }

      // Open the new stage record
      return tx.pipeline.create({
        data: {
          tenantId: this.ctx.tenantId,
          opportunityId,
          stage: toStage,
          enteredAt: new Date()
        }
      });
    });
  }

  /**
   * Compute average days spent in each stage across all tenant opportunities.
   * Useful for pipeline velocity analytics.
   */
  async stageVelocity() {
    const records = await this.prisma.pipeline.findMany({
      where: {
        tenantId: this.ctx.tenantId,
        exitedAt: { not: null }
      },
      select: {
        stage: true,
        enteredAt: true,
        exitedAt: true
      }
    });

    // Group by stage and compute averages
    const stageMap = new Map<OpportunityStage, number[]>();

    for (const record of records) {
      if (!record.exitedAt) continue;
      const days = Math.ceil(
        (record.exitedAt.getTime() - record.enteredAt.getTime()) / (1000 * 60 * 60 * 24)
      );
      const existing = stageMap.get(record.stage) ?? [];
      existing.push(days);
      stageMap.set(record.stage, existing);
    }

    return Array.from(stageMap.entries()).map(([stage, days]) => ({
      stage,
      avgDays: days.reduce((a, b) => a + b, 0) / days.length,
      count: days.length
    }));
  }
}

/**
 * Unit tests for PipelineService
 */
import { PipelineService } from '../../../src/services/pipeline.service';
import { OpportunityStage } from '@prisma/client';

function makePrismaMock() {
  return {
    opportunity: {
      findMany: jest.fn()
    },
    pipeline: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn()
    },
    $transaction: jest.fn()
  };
}

const CTX = { tenantId: 'tenant-1', userId: 'user-1' };

describe('PipelineService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: PipelineService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new PipelineService(prisma as any);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getPipelineAnalytics', () => {
    it('aggregates opportunities correctly', async () => {
      prisma.opportunity.findMany.mockResolvedValue([
        { stage: OpportunityStage.PROSPECTING, value: { toString: () => '10000' } },
        { stage: OpportunityStage.QUALIFICATION, value: { toString: () => '5000' } },
        { stage: OpportunityStage.CLOSED_WON, value: { toString: () => '20000' } },
        { stage: OpportunityStage.CLOSED_LOST, value: { toString: () => '3000' } }
      ]);

      // stageVelocity call
      prisma.pipeline.findMany.mockResolvedValue([]);

      const analytics = await service.getPipelineAnalytics(CTX);

      expect(analytics.totalActiveOpportunities).toBe(2);
      expect(parseFloat(analytics.totalPipelineValue)).toBe(15000);
      expect(analytics.byStage[OpportunityStage.CLOSED_WON]).toBe(1);
      expect(analytics.byStage[OpportunityStage.CLOSED_LOST]).toBe(1);
      expect(analytics.closureStats.won).toBe(1);
      expect(analytics.closureStats.lost).toBe(1);
      expect(analytics.closureStats.winRate).toBe(50);
    });

    it('returns 0 winRate when no closed deals', async () => {
      prisma.opportunity.findMany.mockResolvedValue([
        { stage: OpportunityStage.PROSPECTING, value: { toString: () => '5000' } }
      ]);
      prisma.pipeline.findMany.mockResolvedValue([]);

      const analytics = await service.getPipelineAnalytics(CTX);
      expect(analytics.closureStats.winRate).toBe(0);
    });
  });

  describe('getOpportunityHistory', () => {
    it('returns stage history ordered by enteredAt', async () => {
      const history = [
        { id: 'p-1', stage: OpportunityStage.PROSPECTING, enteredAt: new Date('2024-01-01'), exitedAt: new Date('2024-01-10') },
        { id: 'p-2', stage: OpportunityStage.QUALIFICATION, enteredAt: new Date('2024-01-10'), exitedAt: null }
      ];
      prisma.pipeline.findMany.mockResolvedValue(history);

      const result = await service.getOpportunityHistory(CTX, 'opp-1');
      expect(result).toHaveLength(2);
      expect(result[0].stage).toBe(OpportunityStage.PROSPECTING);
    });
  });

  describe('getCurrentStage', () => {
    it('returns the open pipeline record', async () => {
      const current = { id: 'p-2', stage: OpportunityStage.QUALIFICATION, exitedAt: null };
      prisma.pipeline.findFirst.mockResolvedValue(current);

      const result = await service.getCurrentStage(CTX, 'opp-1');
      expect(result?.stage).toBe(OpportunityStage.QUALIFICATION);
    });

    it('returns null for closed deals', async () => {
      prisma.pipeline.findFirst.mockResolvedValue(null);
      const result = await service.getCurrentStage(CTX, 'opp-closed');
      expect(result).toBeNull();
    });
  });

  describe('getStageVelocity', () => {
    it('computes average days per stage', async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);

      prisma.pipeline.findMany.mockResolvedValue([
        { stage: OpportunityStage.PROSPECTING, enteredAt: twentyDaysAgo, exitedAt: tenDaysAgo },
        { stage: OpportunityStage.PROSPECTING, enteredAt: tenDaysAgo, exitedAt: now }
      ]);

      const velocity = await service.getStageVelocity(CTX);
      expect(velocity).toHaveLength(1);
      expect(velocity[0].stage).toBe(OpportunityStage.PROSPECTING);
      expect(velocity[0].avgDays).toBeCloseTo(10, 0);
    });
  });
});

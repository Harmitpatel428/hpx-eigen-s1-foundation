/**
 * Unit tests for OpportunityService
 */
import { OpportunityService } from '../../../src/services/opportunity.service';
import { OpportunityStage, OpportunityCurrency } from '@prisma/client';

function makePrismaMock() {
  return {
    opportunity: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn()
    },
    pipeline: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn()
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({})
    },
    $transaction: jest.fn()
  };
}

const CTX = { tenantId: 'tenant-1', userId: 'user-1' };

const SAMPLE_OPP = {
  id: 'opp-1',
  tenantId: CTX.tenantId,
  leadId: 'lead-1',
  contactId: null,
  ownerId: CTX.userId,
  title: 'Test Deal',
  value: { toString: () => '5000' },
  currency: OpportunityCurrency.INR,
  stage: OpportunityStage.PROSPECTING,
  expectedCloseDate: null,
  closedAt: null,
  lostReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  lead: { id: 'lead-1', firstName: 'John', lastName: 'Doe', company: null },
  contact: null
};

describe('OpportunityService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: OpportunityService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new OpportunityService(prisma as any);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createOpportunity ───────────────────────────────────────────────────────
  describe('createOpportunity', () => {
    it('creates an opportunity with initial pipeline stage', async () => {
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          opportunity: { create: jest.fn().mockResolvedValue(SAMPLE_OPP) },
          pipeline: { create: jest.fn().mockResolvedValue({}) }
        };
        return fn(tx);
      });

      const result = await service.createOpportunity(CTX, {
        leadId: 'lead-1',
        ownerId: CTX.userId,
        title: 'Test Deal',
        value: 5000
      });

      expect(result.id).toBe('opp-1');
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('throws ValidationError if title is missing', async () => {
      await expect(
        service.createOpportunity(CTX, { leadId: 'l-1', ownerId: 'u-1', title: '', value: 100 })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('throws ValidationError if value is negative', async () => {
      await expect(
        service.createOpportunity(CTX, { leadId: 'l-1', ownerId: 'u-1', title: 'Deal', value: -100 })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('throws ValidationError if leadId is missing', async () => {
      await expect(
        service.createOpportunity(CTX, { leadId: '', ownerId: 'u-1', title: 'Deal', value: 100 })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  // ─── getOpportunityById ──────────────────────────────────────────────────────
  describe('getOpportunityById', () => {
    it('returns opportunity with lead and contact summaries', async () => {
      prisma.opportunity.findFirst.mockResolvedValue(SAMPLE_OPP);
      const result = await service.getOpportunityById(CTX, 'opp-1');
      expect(result.lead.firstName).toBe('John');
    });

    it('throws ResourceNotFoundError when not found', async () => {
      prisma.opportunity.findFirst.mockResolvedValue(null);
      await expect(service.getOpportunityById(CTX, 'bad')).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND'
      });
    });
  });

  // ─── listOpportunities ───────────────────────────────────────────────────────
  describe('listOpportunities', () => {
    it('returns all opportunities', async () => {
      prisma.opportunity.findMany.mockResolvedValue([SAMPLE_OPP]);
      const result = await service.listOpportunities(CTX);
      expect(result).toHaveLength(1);
    });

    it('passes stage filter', async () => {
      prisma.opportunity.findMany.mockResolvedValue([]);
      await service.listOpportunities(CTX, { stage: OpportunityStage.PROPOSAL });
      expect(prisma.opportunity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ stage: OpportunityStage.PROPOSAL })
        })
      );
    });
  });

  // ─── advanceStage ────────────────────────────────────────────────────────────
  describe('advanceStage', () => {
    it('advances stage and records pipeline transition', async () => {
      const advanced = { ...SAMPLE_OPP, stage: OpportunityStage.QUALIFICATION };

      // findById returns current stage
      prisma.opportunity.findFirst.mockResolvedValue(SAMPLE_OPP);

      prisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          pipeline: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockResolvedValue({})
          },
          opportunity: { update: jest.fn().mockResolvedValue(advanced) }
        };
        return fn(tx);
      });

      const result = await service.advanceStage(
        CTX,
        'opp-1',
        OpportunityStage.QUALIFICATION
      );

      expect(result.stage).toBe(OpportunityStage.QUALIFICATION);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('throws BusinessRuleViolationError when already CLOSED_WON', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        ...SAMPLE_OPP,
        stage: OpportunityStage.CLOSED_WON
      });

      prisma.$transaction.mockImplementation(async (fn: any) => {
        // The transaction callback will throw
        return fn({});
      });

      await expect(
        service.advanceStage(CTX, 'opp-1', OpportunityStage.PROPOSAL)
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });
  });

  // ─── closeOpportunity ────────────────────────────────────────────────────────
  describe('closeOpportunity', () => {
    it('requires lostReason when closing as LOST', async () => {
      await expect(
        service.closeOpportunity(CTX, 'opp-1', { outcome: 'LOST', lostReason: '' })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('closes as WON without lostReason', async () => {
      prisma.opportunity.findFirst.mockResolvedValue(SAMPLE_OPP);
      prisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          pipeline: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockResolvedValue({})
          },
          opportunity: {
            update: jest.fn().mockResolvedValue({
              ...SAMPLE_OPP,
              stage: OpportunityStage.CLOSED_WON,
              closedAt: new Date()
            })
          }
        });
      });

      const result = await service.closeOpportunity(CTX, 'opp-1', { outcome: 'WON' });
      expect(result.stage).toBe(OpportunityStage.CLOSED_WON);
    });
  });

  // ─── deleteOpportunity ───────────────────────────────────────────────────────
  describe('deleteOpportunity', () => {
    it('soft-deletes and audits', async () => {
      prisma.opportunity.findFirst.mockResolvedValue(SAMPLE_OPP);
      prisma.opportunity.update.mockResolvedValue({ ...SAMPLE_OPP, deletedAt: new Date() });

      await service.deleteOpportunity(CTX, 'opp-1');
      expect(prisma.opportunity.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: expect.any(Date) } })
      );
    });
  });
});

/**
 * Unit tests for LeadService
 * 
 * Strategy: mock PrismaClient, verify business logic in isolation.
 */
import { LeadService } from '../../src/services/lead.service';
import { LeadStatus, LeadSource, OpportunityStage, OpportunityCurrency, LeadStage, LeadPriority } from '@prisma/client';

// ─── Prisma mock factory ───────────────────────────────────────────────────────
function makePrismaMock() {
  const mock: any = {
    lead: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    contact: { create: jest.fn() },
    opportunity: { create: jest.fn() },
    pipeline: { create: jest.fn() },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    notification: {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    leadActivity: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Default $transaction implementation calls the callback with a copy of the mock itself
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((fn: any) => fn(mock));
  return mock;
}

const CTX = { tenantId: 'tenant-1', userId: 'user-1' };

describe('LeadService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: LeadService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new LeadService(prisma as any);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createLead ──────────────────────────────────────────────────────────────
  describe('createLead', () => {
    it('creates a lead and returns it', async () => {
      const lead = {
        id: 'lead-1',
        tenantId: CTX.tenantId,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        status: LeadStatus.NEW,
        source: LeadSource.WEBSITE,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        phone: null,
        company: null,
        notes: null,
        ownerId: null,
        tags: [], // getLeadWithTags adds this
      };
      prisma.lead.create.mockResolvedValue(lead);
      // getLeadWithTags uses findFirst with include — return lead with tags
      prisma.lead.findFirst.mockResolvedValue({ ...lead, tags: [] });

      const result = await service.createLead(CTX, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        source: LeadSource.WEBSITE
      });

      expect(result).toMatchObject({ id: 'lead-1', firstName: 'John', tags: [] });
      expect(prisma.lead.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('throws ValidationError if firstName is missing', async () => {
      await expect(
        service.createLead(CTX, { firstName: '', lastName: 'Doe' })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('throws ValidationError if lastName is missing', async () => {
      await expect(
        service.createLead(CTX, { firstName: 'John', lastName: '' })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  // ─── getLeadById ─────────────────────────────────────────────────────────────
  describe('getLeadById', () => {
    it('returns lead when found', async () => {
      const lead = { id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null };
      prisma.lead.findFirst.mockResolvedValue(lead);

      const result = await service.getLeadById(CTX, 'lead-1');
      expect(result).toEqual(lead);
    });

    it('throws ResourceNotFoundError when not found', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);

      await expect(service.getLeadById(CTX, 'bad-id')).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND'
      });
    });
  });

  // ─── listLeads ───────────────────────────────────────────────────────────────
  // listLeads(ctx, decision, options?) — decision=undefined means no auth check
  describe('listLeads', () => {
    it('returns all leads for tenant', async () => {
      const leads = [
        { id: 'lead-1', status: LeadStatus.NEW },
        { id: 'lead-2', status: LeadStatus.QUALIFIED }
      ];
      prisma.lead.findMany.mockResolvedValue(leads);
      prisma.lead.count.mockResolvedValue(2);

      const result = await service.listLeads(CTX, undefined);
      expect(result.data).toHaveLength(2);
    });

    it('passes status filter to repository', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      prisma.lead.count.mockResolvedValue(0);
      await service.listLeads(CTX, undefined, { status: LeadStatus.QUALIFIED });
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: LeadStatus.QUALIFIED })
        })
      );
    });
  });

  // ─── updateLead ──────────────────────────────────────────────────────────────
  // updateLead(ctx, decision, leadId, input)
  describe('updateLead', () => {
    it('updates lead and returns updated record', async () => {
      const existing = { id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null };
      const updated = { ...existing, firstName: 'Jane', tags: [] };
      prisma.lead.findFirst
        .mockResolvedValueOnce(existing) // getLeadById for beforeLead
        .mockResolvedValueOnce(updated); // getLeadWithTags after update
      prisma.lead.update.mockResolvedValue(updated);

      const result = await service.updateLead(CTX, undefined, 'lead-1', { firstName: 'Jane' });
      expect(result.firstName).toBe('Jane');
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    // Regression: a partial update that touches neither stage nor followUpDate
    // must not be blocked by a pre-existing null followUpDate on a lead already
    // sitting in a follow-up stage. Previously this threw and the UI reverted
    // the change ("priority does not persist").
    //
    // Critically, the input replicates what the ROUTER sends: it destructures
    // every field from the body, so absent fields arrive as `undefined` keys
    // (followUpDate: undefined, expectedCloseDate: undefined, stage: undefined).
    // The earlier `'followUpDate' in input` guard treated those as "provided"
    // and still threw over HTTP — this test would fail against that code.
    it('allows a priority-only update (router-shaped payload) on a follow-up-stage lead with no followUpDate', async () => {
      const existing = {
        id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null,
        stage: LeadStage.FOLLOW_UP, followUpDate: null, expectedCloseDate: null,
        priority: LeadPriority.MEDIUM, ownerId: 'user-1',
      };
      const updated = { ...existing, priority: LeadPriority.HIGH, tags: [] };
      prisma.lead.findFirst
        .mockResolvedValueOnce(existing)  // getLeadById (beforeLead)
        .mockResolvedValueOnce(updated);  // getLeadWithTags (after)
      prisma.lead.update.mockResolvedValue(updated);

      const result = await service.updateLead(CTX, undefined, 'lead-1', {
        priority: LeadPriority.HIGH,
        followUpDate: undefined,
        expectedCloseDate: undefined,
        stage: undefined,
      });
      expect(result.priority).toBe(LeadPriority.HIGH);

      // And it must NOT touch the date fields — a priority-only update must
      // never null out a lead's followUpDate / expectedCloseDate.
      const writeData = prisma.lead.update.mock.calls[0][0].data;
      expect(writeData).not.toHaveProperty('followUpDate');
      expect(writeData).not.toHaveProperty('expectedCloseDate');
      expect(writeData.priority).toBe(LeadPriority.HIGH);
    });

    // Guard the fix from over-reaching: moving INTO a follow-up stage without a
    // followUpDate must still be rejected.
    it('still rejects moving into a follow-up stage without a followUpDate', async () => {
      const existing = {
        id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null,
        stage: LeadStage.NEW, followUpDate: null, priority: LeadPriority.MEDIUM,
      };
      prisma.lead.findFirst.mockResolvedValueOnce(existing);

      await expect(
        service.updateLead(CTX, undefined, 'lead-1', { stage: LeadStage.FOLLOW_UP })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  // ─── follow-up date / stage invariant ─────────────────────────────────────────
  describe('followUpDate stage normalization', () => {
    // B1: PUT stage=DISQUALIFIED + date → stored and returned null
    it('[B1] clears followUpDate when updating to a non-date stage', async () => {
      const existing = {
        id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null,
        stage: LeadStage.FOLLOW_UP, followUpDate: new Date('2026-09-15'),
        priority: LeadPriority.MEDIUM, ownerId: 'user-1',
      };
      const updated = { ...existing, stage: LeadStage.DISQUALIFIED, followUpDate: null, tags: [] };
      prisma.lead.findFirst
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(updated);
      prisma.lead.update.mockResolvedValue(updated);

      const result = await service.updateLead(CTX, undefined, 'lead-1', {
        stage: LeadStage.DISQUALIFIED,
        followUpDate: '2026-09-20',
      });

      const writeData = prisma.lead.update.mock.calls[0][0].data;
      expect(writeData.followUpDate).toBeNull();
      expect(result.followUpDate).toBeNull();
    });

    // B2: PUT stage=FOLLOW_UP + date → kept
    it('[B2] keeps followUpDate when updating to a date stage', async () => {
      const existing = {
        id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null,
        stage: LeadStage.NEW, followUpDate: null,
        priority: LeadPriority.MEDIUM, ownerId: 'user-1',
      };
      const updated = { ...existing, stage: LeadStage.FOLLOW_UP, followUpDate: new Date('2026-09-20'), tags: [] };
      prisma.lead.findFirst
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(updated);
      prisma.lead.update.mockResolvedValue(updated);

      await service.updateLead(CTX, undefined, 'lead-1', {
        stage: LeadStage.FOLLOW_UP,
        followUpDate: '2026-09-20',
      });

      const writeData = prisma.lead.update.mock.calls[0][0].data;
      expect(writeData.followUpDate).toEqual(new Date('2026-09-20'));
    });

    // B3: PUT WITHOUT stage field, lead currently non-date with stale date → cleared
    it('[B3] clears stale followUpDate on partial update when lead is in a non-date stage', async () => {
      const existing = {
        id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null,
        stage: LeadStage.DISQUALIFIED, followUpDate: new Date('2026-09-15'),
        priority: LeadPriority.MEDIUM, ownerId: 'user-1',
      };
      const updated = { ...existing, priority: LeadPriority.HIGH, followUpDate: null, tags: [] };
      prisma.lead.findFirst
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(updated);
      prisma.lead.update.mockResolvedValue(updated);

      await service.updateLead(CTX, undefined, 'lead-1', {
        priority: LeadPriority.HIGH,
        stage: undefined,
        followUpDate: undefined,
      });

      const writeData = prisma.lead.update.mock.calls[0][0].data;
      expect(writeData.followUpDate).toBeNull();
    });

    // B4: create non-date + date → null
    it('[B4] clears followUpDate when creating with a non-date stage', async () => {
      const lead = {
        id: 'lead-new', tenantId: CTX.tenantId, firstName: 'Test', lastName: 'User',
        stage: LeadStage.DISQUALIFIED, followUpDate: null, tags: [],
      };
      prisma.lead.create.mockResolvedValue(lead);
      prisma.lead.findFirst.mockResolvedValue({ ...lead, tags: [] });

      await service.createLead(CTX, {
        firstName: 'Test', lastName: 'User',
        stage: LeadStage.DISQUALIFIED,
        followUpDate: '2026-09-20',
      });

      const createData = prisma.lead.create.mock.calls[0][0].data;
      expect(createData.followUpDate).toBeNull();
    });

    // B5: parity — FOLLOW_UP_REQUIRED_STAGES matches the literal 4-value list
    it('[B5] FOLLOW_UP_REQUIRED_STAGES contains exactly the 4 date stages', () => {
      const { FOLLOW_UP_REQUIRED_STAGES } = require('../../src/services/lead.service');
      const expected = new Set([
        LeadStage.INTERESTED,
        LeadStage.FOLLOW_UP,
        LeadStage.CALL_BACK_REQUESTED,
        LeadStage.CALL_NOT_RECEIVED,
      ]);
      expect(FOLLOW_UP_REQUIRED_STAGES).toEqual(expected);
    });
  });

  // ─── convertLead ─────────────────────────────────────────────────────────────
  describe('convertLead', () => {
    it('throws BusinessRuleViolationError if lead is already converted', async () => {
      const lead = {
        id: 'lead-1',
        tenantId: CTX.tenantId,
        status: LeadStatus.CONVERTED,
        deletedAt: null
      };
      prisma.lead.findFirst.mockResolvedValue(lead);

      await expect(
        service.convertLead(CTX, 'lead-1', {
          contact: { firstName: 'John', lastName: 'Doe' },
          opportunity: { title: 'Deal', value: 5000 }
        })
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('executes transaction and returns contact + opportunity', async () => {
      const lead = {
        id: 'lead-1',
        tenantId: CTX.tenantId,
        status: LeadStatus.NEW,
        company: 'Acme',
        ownerId: 'user-1',
        deletedAt: null
      };
      const contact = { id: 'contact-1' };
      const opportunity = { id: 'opp-1', stage: OpportunityStage.PROSPECTING };

      prisma.lead.findFirst.mockResolvedValue(lead);
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          contact: { create: jest.fn().mockResolvedValue(contact) },
          opportunity: { create: jest.fn().mockResolvedValue(opportunity) },
          pipeline: { create: jest.fn().mockResolvedValue({}) },
          lead: { update: jest.fn().mockResolvedValue({ ...lead, status: LeadStatus.CONVERTED }) }
        };
        return fn(tx);
      });

      const result = await service.convertLead(CTX, 'lead-1', {
        contact: { firstName: 'John', lastName: 'Doe' },
        opportunity: { title: 'New Deal', value: 10000 }
      });

      expect(result.contact.id).toBe('contact-1');
      expect(result.opportunity.id).toBe('opp-1');
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── deleteLead ──────────────────────────────────────────────────────────────
  describe('deleteLead', () => {
    it('soft-deletes a lead', async () => {
      const lead = { id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null };
      prisma.lead.findFirst.mockResolvedValue(lead);
      prisma.lead.update.mockResolvedValue({ ...lead, deletedAt: new Date() });

      await service.deleteLead(CTX, 'lead-1');
      expect(prisma.lead.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: expect.any(Date) } })
      );
    });
  });
});

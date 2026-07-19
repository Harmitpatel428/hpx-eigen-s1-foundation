/**
 * Unit tests for LeadService
 * 
 * Strategy: mock PrismaClient, verify business logic in isolation.
 */
import { LeadService } from '../../../src/services/lead.service';
import { LeadStatus, LeadSource, OpportunityStage, OpportunityCurrency } from '@prisma/client';

// ─── Prisma mock factory ───────────────────────────────────────────────────────
function makePrismaMock() {
  return {
    lead: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn()
    },
    contact: {
      create: jest.fn()
    },
    opportunity: {
      create: jest.fn()
    },
    pipeline: {
      create: jest.fn()
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({})
    },
    $transaction: jest.fn()
  };
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
        ownerId: null
      };
      prisma.lead.create.mockResolvedValue(lead);

      const result = await service.createLead(CTX, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        source: LeadSource.WEBSITE
      });

      expect(result).toEqual(lead);
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
  describe('listLeads', () => {
    it('returns all leads for tenant', async () => {
      const leads = [
        { id: 'lead-1', status: LeadStatus.NEW },
        { id: 'lead-2', status: LeadStatus.QUALIFIED }
      ];
      prisma.lead.findMany.mockResolvedValue(leads);

      const result = await service.listLeads(CTX);
      expect(result).toHaveLength(2);
    });

    it('passes status filter to repository', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await service.listLeads(CTX, { status: LeadStatus.QUALIFIED });
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: LeadStatus.QUALIFIED })
        })
      );
    });
  });

  // ─── updateLead ──────────────────────────────────────────────────────────────
  describe('updateLead', () => {
    it('updates lead and returns updated record', async () => {
      const existing = { id: 'lead-1', tenantId: CTX.tenantId, deletedAt: null };
      const updated = { ...existing, firstName: 'Jane' };
      prisma.lead.findFirst.mockResolvedValue(existing);
      prisma.lead.update.mockResolvedValue(updated);

      const result = await service.updateLead(CTX, 'lead-1', { firstName: 'Jane' });
      expect(result.firstName).toBe('Jane');
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
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

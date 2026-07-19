/**
 * Unit tests for ActivityService
 */
import { ActivityService } from '../../../src/services/activity.service';
import { ActivityType } from '@prisma/client';

function makePrismaMock() {
  return {
    activity: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn()
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({})
    }
  };
}

const CTX = { tenantId: 'tenant-1', userId: 'user-1' };

const SAMPLE_ACTIVITY = {
  id: 'act-1',
  tenantId: CTX.tenantId,
  opportunityId: 'opp-1',
  userId: CTX.userId,
  type: ActivityType.CALL,
  subject: 'Follow up call',
  notes: null,
  scheduledAt: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null
};

describe('ActivityService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: ActivityService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ActivityService(prisma as any);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createActivity', () => {
    it('creates an activity and audits it', async () => {
      prisma.activity.create.mockResolvedValue(SAMPLE_ACTIVITY);

      const result = await service.createActivity(CTX, {
        opportunityId: 'opp-1',
        userId: CTX.userId,
        type: ActivityType.CALL,
        subject: 'Follow up call'
      });

      expect(result.id).toBe('act-1');
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('throws ValidationError if subject is missing', async () => {
      await expect(
        service.createActivity(CTX, {
          opportunityId: 'opp-1',
          userId: CTX.userId,
          type: ActivityType.CALL,
          subject: ''
        })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('throws ValidationError if opportunityId is missing', async () => {
      await expect(
        service.createActivity(CTX, {
          opportunityId: '',
          userId: CTX.userId,
          type: ActivityType.EMAIL,
          subject: 'Test'
        })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('getActivityById', () => {
    it('returns activity when found', async () => {
      prisma.activity.findFirst.mockResolvedValue(SAMPLE_ACTIVITY);
      const result = await service.getActivityById(CTX, 'act-1');
      expect(result.type).toBe(ActivityType.CALL);
    });

    it('throws ResourceNotFoundError when missing', async () => {
      prisma.activity.findFirst.mockResolvedValue(null);
      await expect(service.getActivityById(CTX, 'bad-id')).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND'
      });
    });
  });

  describe('listByOpportunity', () => {
    it('returns activities for the opportunity', async () => {
      prisma.activity.findMany.mockResolvedValue([SAMPLE_ACTIVITY]);
      const result = await service.listByOpportunity(CTX, 'opp-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('markActivityComplete', () => {
    it('sets completedAt to now and audits', async () => {
      const completed = { ...SAMPLE_ACTIVITY, completedAt: new Date() };
      prisma.activity.findFirst.mockResolvedValue(SAMPLE_ACTIVITY);
      prisma.activity.update.mockResolvedValue(completed);

      const result = await service.markActivityComplete(CTX, 'act-1');
      expect(result.completedAt).toBeTruthy();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteActivity', () => {
    it('soft-deletes and audits', async () => {
      prisma.activity.findFirst.mockResolvedValue(SAMPLE_ACTIVITY);
      prisma.activity.update.mockResolvedValue({ ...SAMPLE_ACTIVITY, deletedAt: new Date() });

      await service.deleteActivity(CTX, 'act-1');
      expect(prisma.activity.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: expect.any(Date) } })
      );
    });
  });
});

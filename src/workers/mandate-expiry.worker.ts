import { PrismaClient, MandateRequestStatus, DocEventType } from '@prisma/client';
import { AuditService } from '../services/audit.service';
import { logger } from '../utils/logger';

let isRunning = false;

export async function expirePendingMandates(prisma: PrismaClient): Promise<number> {
  if (isRunning) return 0;
  isRunning = true;

  try {
    const now = new Date();

    const result = await prisma.mandateRequest.updateMany({
      where: {
        status: MandateRequestStatus.PENDING_UPLOAD,
        tokenExpiresAt: { lt: now },
      },
      data: { status: MandateRequestStatus.EXPIRED },
    });

    if (result.count > 0) {
      logger.info({ expiredCount: result.count, runAt: now.toISOString() }, 'Mandate expiry worker: expired pending requests');

      // A8: one audit event for the batch, not per-row
      const audit = new AuditService(prisma);
      await audit.log({
        tenantId: '00000000-0000-0000-0000-000000000000',
        eventType: 'MANDATE_EXPIRED_BATCH',
        entityType: 'MandateRequest',
        entityId: 'batch',
        operation: 'UPDATE',
        payload: { expiredCount: result.count, runAt: now.toISOString() },
      });
    }

    return result.count;
  } catch (err) {
    logger.error({ err }, 'Mandate expiry worker failed');
    return 0;
  } finally {
    isRunning = false;
  }
}
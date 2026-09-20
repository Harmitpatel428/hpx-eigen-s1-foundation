import { PrismaClient, MandateRequestStatus, DocEventType } from '@prisma/client';
import { AuditService } from '../services/audit.service';
import { storageService } from '../services/storage.service';
import { logger } from '../utils/logger';

let isRunning = false;
let sweepRunning = false;

// Backstop cleanup for abandoned staged uploads (inline deletion on reject is primary).
const STAGING_PREFIXES = ['doc-staging/', 'mandate-firm-staging/', 'mandate-staging/'];

/**
 * Delete staged upload objects older than the retention window. Abandoned uploads
 * (presigned but never confirmed, or confirm failed before promotion) linger in
 * staging; a legit upload's staging object is deleted at confirm. Paginated (no
 * unbounded LIST); idempotent deletes make concurrent runs harmless (R11).
 */
export async function sweepStaleStagingObjects(retentionHours = 24): Promise<number> {
  if (sweepRunning) return 0;
  sweepRunning = true;
  const cutoff = Date.now() - retentionHours * 3_600_000;
  let deleted = 0;
  try {
    for (const prefix of STAGING_PREFIXES) {
      let token: string | undefined;
      do {
        const { objects, nextToken } = await storageService.listObjects(prefix, token);
        for (const o of objects) {
          if (o.lastModified && o.lastModified.getTime() < cutoff) {
            try { await storageService.deleteObject(o.key); deleted++; }
            catch (err) { logger.error({ err, key: o.key }, 'Staging sweep: failed to delete object'); }
          }
        }
        token = nextToken;
      } while (token);
    }
    if (deleted > 0) logger.info({ deleted, retentionHours }, 'Staging sweep: removed stale upload objects');
    return deleted;
  } catch (err) {
    // Storage not configured or a transient list error — skip this run, retry next tick.
    logger.warn({ err: (err as Error).message }, 'Staging sweep skipped');
    return deleted;
  } finally {
    sweepRunning = false;
  }
}

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
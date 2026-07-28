import { PrismaClient, DomainEventStatus } from '@prisma/client';
import { PermissionService } from '../services/permission.service';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 5000;

async function processOutbox() {
  try {
    const pendingEvents = await prisma.outboxEvent.findMany({
      where: {
        status: DomainEventStatus.PENDING,
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: BATCH_SIZE,
    });

    for (const event of pendingEvents) {
      try {
        if (event.eventType === 'RoleGranted' || event.eventType === 'PermissionRevoked' || event.eventType === 'PermissionCacheInvalidated') {
          // If the payload contains membershipId or tenantId, invalidate appropriately
          const payload = event.payload as Record<string, any>;
          const userId = payload.userId as string | undefined;
          const tenantId = (payload.tenantId || event.tenantId) as string | undefined;

          if (userId) {
            // Specific user's manifest was invalidated (e.g., UserRole assignment)
            await permissionService.invalidatePermissionCache(userId);
          } else if (tenantId) {
            // Tenant-wide invalidation (e.g., RolePermission change)
            await permissionService.invalidateTenantPermissionCache(tenantId);
          }
        }

        // Mark as published
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: DomainEventStatus.PUBLISHED,
            publishedAt: new Date(),
          },
        });
        
        process.stdout.write(`[OutboxWorker] Published event ${event.id} (${event.eventType})\n`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const attempts = event.attempts + 1;
        const status = attempts >= MAX_ATTEMPTS ? DomainEventStatus.FAILED : DomainEventStatus.PENDING;
        
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts,
            lastAttemptAt: new Date(),
            error: errorMsg,
            status,
            ...(status === DomainEventStatus.FAILED ? { failedAt: new Date() } : {}),
          },
        });
        
        process.stderr.write(`[OutboxWorker] Failed to process event ${event.id}: ${errorMsg}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[OutboxWorker] Fatal error during polling: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function startWorker() {
  process.stdout.write('[OutboxWorker] Starting outbox polling...\n');
  
  // Continuously poll
  while (true) {
    await processOutbox();
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Start worker if run directly
if (require.main === module) {
  startWorker().catch(err => {
    process.stderr.write(`[OutboxWorker] Crash: ${err.message}\n`);
    process.exit(1);
  });
}

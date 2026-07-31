import { PrismaClient, Prisma } from '@prisma/client';


export class OutboxService {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient | PrismaClient | Prisma.TransactionClient) {}

  /**
   * Publishes a domain event to the outbox table.
   * MUST be called within the same database transaction as the state change.
   * Does NOT publish directly to external systems (Redis/Webhooks).
   */
  async publish(tx: PrismaClient, eventType: string, payload: Record<string, unknown>, tenantId?: string): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        eventType,
        payload: payload as Prisma.InputJsonObject,
        tenantId,
        status: 'PENDING',
        attempts: 0
      }
    });
  }
}

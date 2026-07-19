import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { AuditWriteFailureError } from '../types/exceptions';

interface AuditLogInput {
  tenantId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUserId?: string;
  actorIp?: string;
  actorUserAgent?: string;
  operation: string;
  payload: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async log(input: AuditLogInput): Promise<void> {
    try {
      // Fetch the last audit record to chain hashes
      const lastRecord = await this.prisma.auditLog.findFirst({
        where: { tenantId: input.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { currentHash: true }
      });

      const previousHash = lastRecord?.currentHash ?? null;

      // Build the payload string for hashing
      const hashInput = JSON.stringify({
        tenantId: input.tenantId,
        eventType: input.eventType,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId,
        operation: input.operation,
        payload: input.payload,
        previousHash,
        timestamp: new Date().toISOString()
      });

      const currentHash = crypto
        .createHash('sha256')
        .update(hashInput)
        .digest('hex');

      // Append-only: no update, no delete — ever
      await this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId,
          eventType: input.eventType,
          entityType: input.entityType,
          entityId: input.entityId,
          actorUserId: input.actorUserId,
          actorIp: input.actorIp,
          actorUserAgent: input.actorUserAgent,
          operation: input.operation,
          payload: input.payload as Prisma.InputJsonValue,
          previousHash,
          currentHash
        }
      });
    } catch (err) {
      // Audit failure must surface — never silently swallowed
      throw new AuditWriteFailureError();
    }
  }

  /**
   * Verify the hash chain integrity for a tenant's audit log.
   * Returns true if the chain is intact, false if tampered.
   */
  async verifyChain(tenantId: string): Promise<boolean> {
    const records = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' }
    });

    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const curr = records[i];

      if (curr.previousHash !== prev.currentHash) {
        return false; // Chain broken — potential tampering
      }
    }

    return true;
  }
}

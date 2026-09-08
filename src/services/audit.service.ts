import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { AuditWriteFailureError, AuditChainBranchError } from '../types/exceptions';
import { getRequestContext } from '../context/request-context';
import { logger } from '../utils/logger';

export interface AuditAppendInput {
  tenantId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUserId?: string;
  actorIp?: string;
  actorUserAgent?: string;
  operation: string;
  payload: Record<string, unknown>;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}

export class AuditService {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  private async acquireAuditLock(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), 7001)`;
  }

  private async findLeaf(tx: Prisma.TransactionClient, tenantId: string): Promise<string | null> {
    // Check if any rows exist
    const count = await tx.auditLog.count({ where: { tenantId } });
    if (count === 0) return null; // genesis case

    // Find leaf: row where no successor exists
    const leaves: { currentHash: string }[] = await tx.$queryRaw`
      SELECT a."currentHash"
      FROM "AuditLog" a
      WHERE a."tenantId" = ${tenantId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM "AuditLog" s
          WHERE s."tenantId" = ${tenantId}::uuid
            AND s."previousHash" = a."currentHash"
        )
    `;

    if (leaves.length === 1) return leaves[0].currentHash;
    if (leaves.length > 1) throw new AuditChainBranchError();
    // leaves.length === 0 means circular reference — should not happen
    throw new AuditChainBranchError();
  }

  private canonicalJson(obj: unknown): string {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(v => this.canonicalJson(v)).join(',') + ']';
    const sorted = Object.keys(obj as Record<string, unknown>).sort();
    return '{' + sorted.map(k => JSON.stringify(k) + ':' + this.canonicalJson((obj as Record<string, unknown>)[k])).join(',') + '}';
  }

  /**
   * Append one audit record inside an EXISTING interactive transaction.
   * Acquires advisory lock, finds chain leaf, computes hash, creates record.
   * Returns the created record (callers may need currentHash for chaining).
   */
  async appendInTx(tx: Prisma.TransactionClient, input: AuditAppendInput): Promise<{ id: string; currentHash: string }> {
    await this.acquireAuditLock(tx, input.tenantId);
    const previousHash = await this.findLeaf(tx, input.tenantId);

    let correlationId: string | null = null;
    try {
      const ctx = getRequestContext();
      correlationId = ctx.correlationId;
    } catch {
      // Context unbound (e.g., background jobs, signup)
    }

    const timestamp = new Date().toISOString();
    const hashVersion = 1;

    const hashInput = String(hashVersion) +
      (previousHash || '') +
      this.canonicalJson(input.payload) +
      this.canonicalJson(input.beforeState ?? null) +
      this.canonicalJson(input.afterState ?? null) +
      timestamp;

    const currentHash = crypto
      .createHash('sha256')
      .update(hashInput)
      .digest('hex');

    const record = await tx.auditLog.create({
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
        beforeState: (input.beforeState ?? null) as Prisma.InputJsonValue,
        afterState: (input.afterState ?? null) as Prisma.InputJsonValue,
        correlationId,
        previousHash,
        currentHash,
        hashVersion,
      },
      select: { id: true, currentHash: true },
    });

    return record;
  }

  /**
   * Standalone entry point — creates its own transaction, calls appendInTx inside.
   * Use when there is no outer transaction to join.
   */
  async log(input: AuditAppendInput): Promise<void> {
    try {
      const client = this.prisma as PrismaClient;
      await client.$transaction(async (tx) => {
        await this.appendInTx(tx, input);
      }, { maxWait: 5000, timeout: 15000 });
    } catch (err) {
      if (err instanceof AuditChainBranchError) throw err;
      logger.error({ err }, 'AuditService.log underlying error');
      throw new AuditWriteFailureError();
    }
  }

  /**
   * Walk-forward chain verification.
   * Returns { valid: boolean; errors: string[] }
   */
  async verifyChain(tenantId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    const allRecords = await this.prisma.auditLog.findMany({
      where: { tenantId },
      select: {
        id: true,
        previousHash: true,
        currentHash: true,
        hashVersion: true,
        payload: true,
        beforeState: true,
        afterState: true,
        createdAt: true,
      },
    });

    if (allRecords.length === 0) return { valid: true, errors: [] };

    // Find genesis (previousHash IS NULL)
    const genesisRows = allRecords.filter(r => r.previousHash === null);
    if (genesisRows.length === 0) {
      errors.push('No genesis row found (all rows have a previousHash)');
      return { valid: false, errors };
    }
    if (genesisRows.length > 1) {
      errors.push(`Multiple genesis rows found: ${genesisRows.map(r => r.id).join(', ')}`);
      return { valid: false, errors };
    }

    // Build lookup: previousHash → row(s)
    const byPreviousHash = new Map<string, typeof allRecords>();
    for (const r of allRecords) {
      if (r.previousHash !== null) {
        const list = byPreviousHash.get(r.previousHash) || [];
        list.push(r);
        byPreviousHash.set(r.previousHash, list);
      }
    }

    // Walk forward from genesis
    const visited = new Set<string>();
    let current = genesisRows[0];
    visited.add(current.id);

    while (true) {
      // Check for hashVersion=1 content integrity
      if (current.hashVersion === 1) {
        const timestamp = current.createdAt.toISOString();
        const hashInput = '1' +
          (current.previousHash || '') +
          this.canonicalJson(current.payload) +
          this.canonicalJson(current.beforeState ?? null) +
          this.canonicalJson(current.afterState ?? null) +
          timestamp;
        const expected = crypto.createHash('sha256').update(hashInput).digest('hex');
        if (expected !== current.currentHash) {
          errors.push(`Content hash mismatch on row ${current.id}: expected ${expected}, got ${current.currentHash}`);
        }
      }

      // Find successor
      const successors = byPreviousHash.get(current.currentHash) || [];
      if (successors.length === 0) break; // leaf reached
      if (successors.length > 1) {
        errors.push(`Branch detected at row ${current.id}: ${successors.length} successors`);
        break;
      }

      current = successors[0];
      if (visited.has(current.id)) {
        errors.push(`Circular reference detected at row ${current.id}`);
        break;
      }
      visited.add(current.id);
    }

    // Check for disconnected rows
    if (visited.size !== allRecords.length) {
      const disconnected = allRecords.filter(r => !visited.has(r.id));
      errors.push(`${disconnected.length} disconnected row(s) not reachable from genesis: ${disconnected.map(r => r.id).join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
  }
}

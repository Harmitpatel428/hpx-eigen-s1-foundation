import { PrismaClient, SessionStatus, Prisma } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError } from '../types/exceptions';

export class SessionRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /** Find an active, non-expired, non-deleted session */
  async findActive(tx: PrismaClient, sessionId: string) {
    return tx.session.findFirst({
      where: {
        ...this.buildTenantFilter(tx),
        id: sessionId,
        status: SessionStatus.ACTIVE,
        expiresAt: { gt: new Date() }
      }
    });
  }

  /** Find all active sessions for a user */
  async findActiveByUser(tx: PrismaClient, userId: string) {
    return tx.session.findMany({
      where: {
        ...this.buildTenantFilter(tx),
        userId,
        status: SessionStatus.ACTIVE,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Revoke a single session (user logout) */
  async revoke(tx: PrismaClient, sessionId: string) {
    const session = await tx.session.findFirst({
      where: { ...this.buildTenantFilter(tx), id: sessionId }
    });
    if (!session) throw new ResourceNotFoundError();

    return tx.session.update({
      where: { id: sessionId },
      data: { status: SessionStatus.REVOKED, revokedAt: new Date() }
    });
  }

  /** Invalidate all active sessions for a user */
  async invalidateAllForUser(tx: PrismaClient, userId: string) {
    return tx.session.updateMany({
      where: {
        ...this.buildTenantFilter(tx),
        userId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] }
      },
      data: { status: SessionStatus.INVALIDATED, invalidatedAt: new Date() }
    });
  }

  /** Mark expired sessions (run by background job) */
  async expireStale(tx: PrismaClient) {
    return tx.session.updateMany({
      where: {
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        expiresAt: { lte: new Date() },
        deletedAt: null
      },
      data: { status: SessionStatus.EXPIRED, expiredAt: new Date() }
    });
  }
}

import { PrismaClient, SessionStatus } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError } from '../types/exceptions';

export class SessionRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /** Find an active, non-expired, non-deleted session */
  async findActive(sessionId: string) {
    return this.prisma.session.findFirst({
      where: {
        ...this.buildTenantFilter(),
        id: sessionId,
        status: SessionStatus.ACTIVE,
        expiresAt: { gt: new Date() }
      }
    });
  }

  /** Find all active sessions for a user */
  async findActiveByUser(userId: string) {
    return this.prisma.session.findMany({
      where: {
        ...this.buildTenantFilter(),
        userId,
        status: SessionStatus.ACTIVE,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Revoke a single session (user logout) */
  async revoke(sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { ...this.buildTenantFilter(), id: sessionId }
    });
    if (!session) throw new ResourceNotFoundError();

    return this.prisma.session.update({
      where: { id: sessionId },
      data: { status: SessionStatus.REVOKED, revokedAt: new Date() }
    });
  }

  /** Invalidate all active sessions for a user */
  async invalidateAllForUser(userId: string) {
    return this.prisma.session.updateMany({
      where: {
        ...this.buildTenantFilter(),
        userId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] }
      },
      data: { status: SessionStatus.INVALIDATED, invalidatedAt: new Date() }
    });
  }

  /** Mark expired sessions (run by background job) */
  async expireStale() {
    return this.prisma.session.updateMany({
      where: {
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        expiresAt: { lte: new Date() },
        deletedAt: null
      },
      data: { status: SessionStatus.EXPIRED, expiredAt: new Date() }
    });
  }
}

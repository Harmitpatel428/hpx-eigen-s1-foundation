import { PrismaClient, UserStatus, SessionStatus } from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ResourceNotFoundError,
  BusinessRuleViolationError
} from '../types/exceptions';

export class UserService {
  private readonly auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  /**
   * Suspend a user — transitions status to SUSPENDED.
   *
   * Rules (per S1 spec):
   * - Target must be ACTIVE (cannot suspend already-suspended or terminated users)
   * - All CREATED/ACTIVE sessions are invalidated immediately
   * - Audit log written per AUDIT-001
   */
  async suspendUser(
    userId: string,
    tenantId: string,
    reason: string,
    actorUserId: string
  ): Promise<{ success: boolean; sessionsRevoked: number }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null }
    });

    if (!user) throw new ResourceNotFoundError();

    // Only ACTIVE users can be suspended
    const suspendableStates: UserStatus[] = [UserStatus.ACTIVE];
    if (!suspendableStates.includes(user.status)) {
      throw new BusinessRuleViolationError();
    }

    // Invalidate all active sessions
    const sessionResult = await this.prisma.session.updateMany({
      where: {
        userId,
        tenantId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        deletedAt: null
      },
      data: {
        status: SessionStatus.INVALIDATED,
        invalidatedAt: new Date()
      }
    });

    // Update user status
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspensionReason: reason
      }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'USER_SUSPENDED',
      entityType: 'User',
      entityId: userId,
      actorUserId,
      operation: 'UPDATE',
      payload: {
        reason,
        sessionsRevoked: sessionResult.count,
        previousStatus: user.status
      }
    });

    return { success: true, sessionsRevoked: sessionResult.count };
  }

  /**
   * Terminate a user — transitions status to TERMINATED (irreversible).
   *
   * Rules (per S1 spec):
   * - Cannot terminate an already-terminated user
   * - All CREATED/ACTIVE sessions are invalidated immediately
   * - Audit log written per AUDIT-001
   */
  async terminateUser(
    userId: string,
    tenantId: string,
    reason: string,
    actorUserId: string
  ): Promise<{ success: boolean; sessionsRevoked: number }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null }
    });

    if (!user) throw new ResourceNotFoundError();

    // Cannot terminate already-terminated users
    if (user.status === UserStatus.TERMINATED) {
      throw new BusinessRuleViolationError();
    }

    // Invalidate all active sessions
    const sessionResult = await this.prisma.session.updateMany({
      where: {
        userId,
        tenantId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        deletedAt: null
      },
      data: {
        status: SessionStatus.INVALIDATED,
        invalidatedAt: new Date()
      }
    });

    // Update user status
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.TERMINATED,
        terminatedAt: new Date(),
        terminationReason: reason
      }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'USER_TERMINATED',
      entityType: 'User',
      entityId: userId,
      actorUserId,
      operation: 'UPDATE',
      payload: {
        reason,
        sessionsRevoked: sessionResult.count,
        previousStatus: user.status
      }
    });

    return { success: true, sessionsRevoked: sessionResult.count };
  }

  /**
   * Get a single user by ID — tenant-scoped.
   */
  async getUser(userId: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      select: {
        id: true,
        email: true,
        status: true,
        suspendedAt: true,
        suspensionReason: true,
        terminatedAt: true,
        terminationReason: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: { select: { id: true, name: true } }
          }
        }
      }
    });

    if (!user) throw new ResourceNotFoundError();
    return user;
  }

  /**
   * List all non-deleted users in a tenant.
   */
  async listUsers(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId, deletedAt: null },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }
}

import { PrismaClient, Prisma, UserStatus, SessionStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuditService } from './audit.service';
import {
  ResourceNotFoundError,
  BusinessRuleViolationError,
  ValidationError
} from '../types/exceptions';
import { validatePasswordStrength } from '../domain/password-policy';

type DbClient = PrismaClient | Prisma.TransactionClient;

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
    actorUserId: string,
    tx?: Prisma.TransactionClient
  ): Promise<{ success: boolean; sessionsRevoked: number }> {
    const db: DbClient = tx ?? this.prisma;

    const user = await db.user.findFirst({
      where: { id: userId, tenantId, deletedAt: { equals: null } }
    });

    if (!user) throw new ResourceNotFoundError();

    const suspendableStates: UserStatus[] = [UserStatus.ACTIVE];
    if (!suspendableStates.includes(user.status)) {
      throw new BusinessRuleViolationError();
    }

    const sessionResult = await db.session.updateMany({
      where: {
        userId,
        tenantId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        deletedAt: { equals: null }
      },
      data: {
        status: SessionStatus.INVALIDATED,
        invalidatedAt: new Date()
      }
    });

    await db.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspensionReason: reason
      }
    });

    try {
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
    } catch (auditErr) {
      console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'USER_SUSPENDED', entityId: userId, tenantId }, auditErr);
    }

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
    actorUserId: string,
    tx?: Prisma.TransactionClient
  ): Promise<{ success: boolean; sessionsRevoked: number }> {
    const db: DbClient = tx ?? this.prisma;

    const user = await db.user.findFirst({
      where: { id: userId, tenantId, deletedAt: { equals: null } }
    });

    if (!user) throw new ResourceNotFoundError();

    if (user.status === UserStatus.TERMINATED) {
      throw new BusinessRuleViolationError();
    }

    const sessionResult = await db.session.updateMany({
      where: {
        userId,
        tenantId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        deletedAt: { equals: null }
      },
      data: {
        status: SessionStatus.INVALIDATED,
        invalidatedAt: new Date()
      }
    });

    await db.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.TERMINATED,
        terminatedAt: new Date(),
        terminationReason: reason
      }
    });

    try {
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
    } catch (auditErr) {
      console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'USER_TERMINATED', entityId: userId, tenantId }, auditErr);
    }

    return { success: true, sessionsRevoked: sessionResult.count };
  }

  /**
   * Admin sets a member's password (Settings → Members, "Change Password").
   *
   * Security contract:
   * - Caller authorization (holds `user:manage`) is enforced at the route.
   * - Tenant/IDOR guard: the target is looked up WITHIN the caller's tenant, so a
   *   cross-tenant id is indistinguishable from a non-existent one → 404, never a leak.
   * - Strong-password policy (incl. not containing the target's name/email) enforced here.
   * - New password is bcrypt-hashed (cost 12, same as signup/reset); never logged or returned.
   * - All CREATED/ACTIVE sessions of the target are REVOKED, forcing re-authentication.
   * - Audit logged (who/when/for-whom); the password itself is never in the payload.
   */
  async adminResetPassword(
    targetUserId: string,
    tenantId: string,
    actorUserId: string,
    newPassword: string,
  ): Promise<{ sessionsRevoked: number; email: string }> {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, tenantId, deletedAt: { equals: null } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!target) throw new ResourceNotFoundError(); // also the cross-tenant guard (404, no leak)

    const policyError = validatePasswordStrength(newPassword, {
      email: target.email, firstName: target.firstName, lastName: target.lastName,
    });
    if (policyError) throw new ValidationError(policyError);

    const hashed = await bcrypt.hash(newPassword, 12);

    const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetUserId }, data: { password: hashed } });
      const revoked = await tx.session.updateMany({
        where: {
          userId: targetUserId,
          tenantId,
          status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
          deletedAt: { equals: null },
        },
        data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
      });
      return revoked.count;
    });

    try {
      await this.auditService.log({
        tenantId,
        eventType: 'ADMIN_PASSWORD_RESET',
        entityType: 'User',
        entityId: targetUserId,
        actorUserId,
        operation: 'PASSWORD_RESET',
        payload: { sessionsRevoked }, // never the password
      });
    } catch (auditErr) {
      console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'ADMIN_PASSWORD_RESET', entityId: targetUserId, tenantId }, auditErr);
    }

    return { sessionsRevoked, email: target.email };
  }

  /**
   * Get a single user by ID — tenant-scoped.
   */
  async getUser(userId: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: { equals: null } },
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
      where: { tenantId, deletedAt: { equals: null } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        createdAt: true,
        departmentId: true,
        userRoles: {
          select: {
            scopeType: true,
            role: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

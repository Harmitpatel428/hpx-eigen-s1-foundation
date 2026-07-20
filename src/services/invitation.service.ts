import { PrismaClient, InvitationStatus } from '@prisma/client';
import crypto from 'crypto';
import { AuditService } from './audit.service';
import { EmailService } from './email.service';
import {
  ResourceNotFoundError,
  DuplicateResourceError,
  BusinessRuleViolationError
} from '../types/exceptions';

const INVITATION_EXPIRY_DAYS = 7;

export class InvitationService {
  private readonly auditService: AuditService;
  private readonly emailService: EmailService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
    this.emailService = new EmailService();
  }

  /**
   * Create a new invitation — tenant-scoped per TS-001.
   */
  async createInvitation(
    tenantId: string,
    email: string,
    roleId: string,
    invitedBy: string
  ) {
    // Validate role belongs to same tenant
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId, deletedAt: null }
    });
    if (!role) throw new ResourceNotFoundError();

    // Check for existing PENDING invitation for this email in this tenant
    const existing = await this.prisma.userInvitation.findFirst({
      where: { tenantId, email, status: InvitationStatus.PENDING, deletedAt: null }
    });
    if (existing) throw new DuplicateResourceError();

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    const invitation = await this.prisma.userInvitation.create({
      data: { tenantId, email, roleId, invitedBy, token, expiresAt }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'INVITATION_CREATED',
      entityType: 'UserInvitation',
      entityId: invitation.id,
      actorUserId: invitedBy,
      operation: 'CREATE',
      payload: { email, roleId }
    });

    // Send email
    await this.emailService.sendInvitationEmail(email, token);

    return invitation;
  }

  /**
   * Accept an invitation — idempotent per S1.7a spec.
   *
   * Uses SELECT FOR UPDATE to serialize concurrent acceptance attempts.
   * Dual unique constraints on UserRole prevent duplicate role assignments.
   */
  async acceptInvitation(token: string, acceptingUserId: string, tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE — serializes race conditions (Case 1, 2, 3 from spec)
      const rows = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        email: string;
        role_id: string;
        tenant_id: string;
        expires_at: Date;
        invited_by: string;
      }>>`
        SELECT id, status, email, role_id, tenant_id, expires_at, invited_by
        FROM "UserInvitation"
        WHERE token = ${token}
          AND tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `;

      if (!rows.length) throw new ResourceNotFoundError();

      const inv = rows[0]!;

      // Idempotent — already accepted, return success
      if (inv.status === InvitationStatus.ACCEPTED) {
        return { alreadyAccepted: true, invitationId: inv.id };
      }

      // Reject terminal states
      if (inv.status === InvitationStatus.EXPIRED) {
        throw new BusinessRuleViolationError();
      }
      if (inv.status === InvitationStatus.REVOKED) {
        throw new BusinessRuleViolationError();
      }
      if (inv.status === InvitationStatus.FAILED) {
        throw new BusinessRuleViolationError();
      }

      // Check expiry
      if (new Date(inv.expires_at) < new Date()) {
        await tx.userInvitation.update({
          where: { id: inv.id },
          data: { status: InvitationStatus.EXPIRED }
        });
        throw new BusinessRuleViolationError();
      }

      // Create UserRole — idempotent via ON CONFLICT (handled by P2002 catch)
      try {
        await tx.userRole.create({
          data: {
            userId: acceptingUserId,
            roleId: inv.role_id,
            invitationId: inv.id
          }
        });
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err.code === 'P2002') {
          // Duplicate — already exists, treat as success per spec
          const exists = await tx.userRole.findFirst({
            where: { userId: acceptingUserId, roleId: inv.role_id }
          });
          if (!exists) throw e;
        } else {
          throw e;
        }
      }

      // Update invitation to ACCEPTED
      await tx.userInvitation.update({
        where: { id: inv.id },
        data: {
          status: InvitationStatus.ACCEPTED,
          acceptedBy: acceptingUserId,
          acceptedAt: new Date()
        }
      });

      // Audit inside transaction
      await this.auditService.log({
        tenantId,
        eventType: 'INVITATION_ACCEPTED',
        entityType: 'UserInvitation',
        entityId: inv.id,
        actorUserId: acceptingUserId,
        operation: 'UPDATE',
        payload: { token, email: inv.email }
      });

      return { alreadyAccepted: false, invitationId: inv.id };
    });
  }

  /**
   * Revoke a pending invitation — admin action.
   */
  async revokeInvitation(
    invitationId: string,
    tenantId: string,
    actorUserId: string
  ) {
    const invitation = await this.prisma.userInvitation.findFirst({
      where: {
        id: invitationId,
        tenantId,
        status: InvitationStatus.PENDING,
        deletedAt: null
      }
    });

    if (!invitation) throw new ResourceNotFoundError();

    await this.prisma.userInvitation.update({
      where: { id: invitationId },
      data: { status: InvitationStatus.REVOKED }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'INVITATION_REVOKED',
      entityType: 'UserInvitation',
      entityId: invitationId,
      actorUserId,
      operation: 'UPDATE',
      payload: { invitationId }
    });
  }
}

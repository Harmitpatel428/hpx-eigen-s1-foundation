import { PrismaClient, InvitationStatus, InvitationEmailStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuditService } from './audit.service';
import { EmailService } from './email.service';
import { TokenService } from './auth/TokenService';
import {
  ResourceNotFoundError,
  DuplicateResourceError,
  BusinessRuleViolationError,
  InvitationAlreadyAcceptedError
} from '../types/exceptions';

const INVITATION_EXPIRY_DAYS = 7;

export class InvitationService {
  private readonly auditService: AuditService;
  private readonly emailService: EmailService;
  private readonly tokenService: TokenService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
    this.emailService = new EmailService();
    this.tokenService = new TokenService(prisma);
  }

  async createInvitation(
    tenantId: string,
    email: string,
    roleId: string,
    invitedBy: string
  ): Promise<{ invitationId: string; emailStatus: InvitationEmailStatus; devInviteUrl: string | null }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Role must belong to same tenant
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId, deletedAt: { equals: null } }
    });
    if (!role) throw new ResourceNotFoundError();

    // Block if an active user with this email already exists in this tenant
    const existingUser = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, tenantId, deletedAt: { equals: null } }
    });
    if (existingUser) {
      if (existingUser.status === 'ACTIVE') {
        throw new BusinessRuleViolationError('A user with this email already exists in your organization.');
      }
      if (existingUser.status === 'SUSPENDED' || existingUser.status === 'TERMINATED') {
        throw new BusinessRuleViolationError('This email address is not eligible to receive an invitation.');
      }
    }

    // Look up existing invitation row (UserInvitation not in middleware scope — no auto-filter)
    const existing = await this.prisma.userInvitation.findFirst({
      where: { tenantId, email: normalizedEmail }
    });

    if (existing) {
      // Soft-deleted rows → re-issue (raw-token invalidation migration produced these)
      if (!existing.deletedAt && existing.status === InvitationStatus.PENDING) {
        if (existing.emailStatus === InvitationEmailStatus.PENDING) {
          throw new DuplicateResourceError('An invitation is already pending for this email.');
        }
        if (existing.emailStatus === InvitationEmailStatus.SENT) {
          throw new DuplicateResourceError('An invitation has already been sent to this email.');
        }
        // FAILED or SKIPPED → retry with new token
      }
      // EXPIRED, REVOKED, soft-deleted, or FAILED/SKIPPED PENDING → re-issue

      const token = this.tokenService.generateToken();
      const tokenHash = this.tokenService.hashToken(token);
      const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      await this.prisma.userInvitation.update({
        where: { id: existing.id },
        data: {
          token: tokenHash,
          roleId,
          expiresAt,
          status: InvitationStatus.PENDING,
          emailStatus: InvitationEmailStatus.PENDING,
          deletedAt: null,
          invitedBy,
          acceptedBy: null,
          acceptedAt: null
        }
      });

      return this._attemptEmail(existing.id, normalizedEmail, token, role.name, expiresAt, tenantId, invitedBy);
    }

    // No existing row — create fresh
    const token = this.tokenService.generateToken();
    const tokenHash = this.tokenService.hashToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await this.prisma.userInvitation.create({
      data: {
        tenantId,
        email: normalizedEmail,
        roleId,
        invitedBy,
        token: tokenHash,
        expiresAt
      }
    });

    return this._attemptEmail(invitation.id, normalizedEmail, token, role.name, expiresAt, tenantId, invitedBy);
  }

  private async _attemptEmail(
    invitationId: string,
    email: string,
    rawToken: string,
    roleName: string,
    expiresAt: Date,
    tenantId: string,
    invitedBy: string
  ): Promise<{ invitationId: string; emailStatus: InvitationEmailStatus; devInviteUrl: string | null }> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const acceptUrl = `${frontendUrl}/accept-invite?token=${rawToken}`;

    if (process.env.NODE_ENV !== 'production') {
      await this.prisma.userInvitation.update({
        where: { id: invitationId },
        data: { emailStatus: InvitationEmailStatus.SKIPPED }
      });
      await this.auditService.log({
        tenantId, eventType: 'INVITATION_CREATED', entityType: 'UserInvitation',
        entityId: invitationId, actorUserId: invitedBy, operation: 'CREATE',
        payload: { email }
      });
      console.log(`\n[DEV MODE - INVITATION] URL: ${acceptUrl}\n`);
      return { invitationId, emailStatus: InvitationEmailStatus.SKIPPED, devInviteUrl: acceptUrl };
    }

    try {
      await this.emailService.sendInvitationEmail(email, acceptUrl, roleName, expiresAt);
      await this.prisma.userInvitation.update({
        where: { id: invitationId },
        data: { emailStatus: InvitationEmailStatus.SENT }
      });
      await this.auditService.log({
        tenantId, eventType: 'INVITATION_CREATED', entityType: 'UserInvitation',
        entityId: invitationId, actorUserId: invitedBy, operation: 'CREATE',
        payload: { email }
      });
      return { invitationId, emailStatus: InvitationEmailStatus.SENT, devInviteUrl: null };
    } catch {
      await this.prisma.userInvitation.update({
        where: { id: invitationId },
        data: { emailStatus: InvitationEmailStatus.FAILED }
      });
      await this.auditService.log({
        tenantId, eventType: 'INVITATION_CREATED', entityType: 'UserInvitation',
        entityId: invitationId, actorUserId: invitedBy, operation: 'CREATE',
        payload: { email, emailDeliveryFailed: true }
      });
      return { invitationId, emailStatus: InvitationEmailStatus.FAILED, devInviteUrl: null };
    }
  }

  /**
   * Accept an invitation using its token hash.
   * Caller (auth.router) is responsible for session/JWT creation after this returns.
   *
   * SELECT FOR UPDATE provides pessimistic row locking — the first concurrent request
   * locks the row and marks it ACCEPTED; the second reads the updated ACCEPTED status
   * and receives InvitationAlreadyAcceptedError with no credentials issued.
   */
  async acceptInvitation(
    tokenHash: string,
    userData: { password?: string }
  ): Promise<{ userId: string; tenantId: string; roleId: string; invitationId: string }> {
    // Pre-hash password outside the transaction (slow bcrypt should not hold DB lock)
    let passwordHash: string | undefined;
    if (userData.password) {
      passwordHash = await bcrypt.hash(userData.password, 12);
    }

    return this.prisma.$transaction(async (tx) => {
      // Prisma schema uses camelCase field names with no @map, so PostgreSQL columns
      // are quoted camelCase ("roleId", "tenantId", etc.) — must quote them in raw SQL.
      const rows = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        email: string;
        roleId: string;
        tenantId: string;
        expiresAt: Date;
        invitedBy: string;
      }>>`
        SELECT id, status, email, "roleId", "tenantId", "expiresAt", "invitedBy"
        FROM "UserInvitation"
        WHERE token = ${tokenHash}
          AND "deletedAt" IS NULL
        FOR UPDATE
      `;

      if (!rows.length) throw new ResourceNotFoundError();

      const inv = rows[0]!;

      // Idempotency — precise exit points, no credentials ever issued for ACCEPTED
      if (inv.status === InvitationStatus.ACCEPTED) throw new InvitationAlreadyAcceptedError();
      if (inv.status === InvitationStatus.EXPIRED)  throw new BusinessRuleViolationError('This invitation has expired.');
      if (inv.status === InvitationStatus.REVOKED)  throw new BusinessRuleViolationError('This invitation has been revoked.');
      if (inv.status !== InvitationStatus.PENDING)  throw new BusinessRuleViolationError('This invitation is not valid.');

      // Runtime expiry check (PENDING rows can expire without a status update)
      if (new Date(inv.expiresAt) < new Date()) {
        await tx.userInvitation.update({
          where: { id: inv.id },
          data: { status: InvitationStatus.EXPIRED }
        });
        throw new BusinessRuleViolationError('This invitation has expired.');
      }

      // Role must still exist
      const role = await tx.role.findFirst({
        where: { id: inv.roleId, tenantId: inv.tenantId, deletedAt: null }
      });
      if (!role) throw new BusinessRuleViolationError('The role assigned to this invitation no longer exists.');

      // User lookup
      let user = await tx.user.findFirst({
        where: { email: inv.email, tenantId: inv.tenantId, deletedAt: null }
      });

      if (user) {
        if (user.status === 'SUSPENDED' || user.status === 'TERMINATED') {
          throw new BusinessRuleViolationError('Your account is not eligible to accept this invitation.');
        }
        // ACTIVE user — assign role only, no credential change
      } else {
        // New user — password required
        if (!userData.password || userData.password.length < 8) {
          throw new BusinessRuleViolationError('Password must be at least 8 characters.');
        }

        user = await tx.user.create({
          data: {
            email: inv.email,
            tenantId: inv.tenantId,
            password: passwordHash!,
            status: 'ACTIVE',
            emailVerified: new Date() // CRITICAL: prevents login rejection at login
          }
        });
      }

      await tx.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: inv.roleId } },
        create: { userId: user.id, roleId: inv.roleId },
        update: {}
      });

      await tx.userInvitation.update({
        where: { id: inv.id },
        data: { status: InvitationStatus.ACCEPTED, acceptedBy: user.id, acceptedAt: new Date() }
      });

      // Audit: invitationId + userId + roleId only — raw token never in audit payload
      await this.auditService.log({
        tenantId: inv.tenantId,
        eventType: 'INVITATION_ACCEPTED',
        entityType: 'UserInvitation',
        entityId: inv.id,
        actorUserId: user.id,
        operation: 'UPDATE',
        payload: { invitationId: inv.id, userId: user.id, roleId: inv.roleId }
      });

      return { userId: user.id, tenantId: inv.tenantId, roleId: inv.roleId, invitationId: inv.id };
    });
  }

  async revokeInvitation(invitationId: string, tenantId: string, actorUserId: string) {
    const invitation = await this.prisma.userInvitation.findFirst({
      where: { id: invitationId, tenantId, status: InvitationStatus.PENDING, deletedAt: { equals: null } }
    });
    if (!invitation) throw new ResourceNotFoundError();

    await this.prisma.userInvitation.update({
      where: { id: invitationId },
      data: { status: InvitationStatus.REVOKED }
    });

    await this.auditService.log({
      tenantId, eventType: 'INVITATION_REVOKED', entityType: 'UserInvitation',
      entityId: invitationId, actorUserId, operation: 'UPDATE', payload: { invitationId }
    });
  }
}

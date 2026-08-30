import {
  PrismaClient,
  DocCaseStatus,
  DocEventType,
  PortalContactChangeStatus,
  PortalPhoneSource,
  Prisma,
} from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ValidationError,
  ResourceNotFoundError,
  BusinessRuleViolationError,
} from '../types/exceptions';
import { isValidCaseNumber, phoneLast4, normalisePhone } from '../domain/caseNumber';
import {
  PORTAL_AUTH,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  safeCompareDigits,
  isPortalAccessible,
  toClientDocStatus,
  progressStageFor,
  PORTAL_PROGRESS_STAGES,
} from '../domain/portal';
import type { TenantContext } from './documentation.service';

/**
 * Thrown for EVERY portal verification failure. The router maps this to one
 * fixed status and body, so callers cannot distinguish "no such case" from
 * "wrong digits" from "locked out".
 */
export class PortalVerificationFailed extends Error {
  constructor(public readonly internalReason: string) {
    super('VERIFICATION_FAILED');
    this.name = 'PortalVerificationFailed';
  }
}

export interface PortalCaseView {
  caseNumber: string;
  clientName: string;
  status: string;
  portalActivatedAt: string;
  progressStages: Array<{ key: string; label: string; completedAt: string | null; isCurrent: boolean }>;
  documents: Array<{ id: string; name: string; status: 'RECEIVED' | 'PENDING'; receivedAt: string | null }>;
  notes: Array<{ id: string; content: string; createdAt: string }>;
}

export class PortalService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  // ─── Verification ──────────────────────────────────────────────────────────

  /**
   * Case number + last 4 phone digits. No OTP, no SMS, no second channel.
   *
   * Every failure path throws PortalVerificationFailed with an internal reason
   * for the server log only. The reason never reaches the client.
   */
  async verify(caseNumberRaw: string, phoneDigits: string, ip: string, userAgent?: string) {
    const caseNumber = (caseNumberRaw ?? '').toUpperCase().trim();
    const digits = (phoneDigits ?? '').replace(/\D/g, '');

    // Record the attempt regardless of outcome so lockout counts malformed
    // probes too — otherwise an attacker just sends garbage to reset nothing.
    const record = async (succeeded: boolean, caseId: string | null, tenantId: string | null) => {
      await this.prisma.portalAuthAttempt.create({
        data: { caseNumber, ipAddress: ip, succeeded, caseId, tenantId },
      });
    };

    if (!isValidCaseNumber(caseNumber) || digits.length !== 4) {
      await record(false, null, null);
      throw new PortalVerificationFailed('malformed_input');
    }

    if (await this.isLockedOut(caseNumber, ip)) {
      await record(false, null, null);
      throw new PortalVerificationFailed('locked_out');
    }

    const docCase = await this.prisma.docCase.findFirst({
      where: { caseNumber, deletedAt: null },
      include: { lead: { select: { firstName: true, lastName: true } } },
    });

    if (!docCase) {
      await record(false, null, null);
      throw new PortalVerificationFailed('case_not_found');
    }

    if (!isPortalAccessible({
      portalEnabledAt: docCase.portalEnabledAt,
      portalPhoneLast4: docCase.portalPhoneLast4,
      status: docCase.status,
    })) {
      await record(false, docCase.id, docCase.tenantId);
      throw new PortalVerificationFailed('portal_not_accessible');
    }

    if (!safeCompareDigits(docCase.portalPhoneLast4!, digits)) {
      await record(false, docCase.id, docCase.tenantId);
      throw new PortalVerificationFailed('digit_mismatch');
    }

    // Success — issue an opaque session. Only the hash is persisted.
    const token = generateSessionToken();
    await this.prisma.portalSession.create({
      data: {
        tenantId: docCase.tenantId,
        caseId: docCase.id,
        tokenHash: hashSessionToken(token),
        expiresAt: sessionExpiry(),
        ipAddress: ip,
        userAgent: userAgent ?? null,
      },
    });

    await record(true, docCase.id, docCase.tenantId);

    return { sessionToken: token, expiresAt: sessionExpiry().toISOString() };
  }

  /** 5 failed attempts per (caseNumber, ip) inside the lockout window. */
  private async isLockedOut(caseNumber: string, ip: string): Promise<boolean> {
    const since = new Date(Date.now() - PORTAL_AUTH.LOCKOUT_MINUTES * 60_000);
    const failures = await this.prisma.portalAuthAttempt.count({
      where: { caseNumber, ipAddress: ip, succeeded: false, attemptedAt: { gte: since } },
    });
    return failures >= PORTAL_AUTH.MAX_ATTEMPTS;
  }

  /** Resolve a bearer token to a live session, or throw the generic failure. */
  async resolveSession(token: string) {
    if (!token) throw new PortalVerificationFailed('missing_token');

    const session = await this.prisma.portalSession.findUnique({
      where: { tokenHash: hashSessionToken(token) },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date())
      throw new PortalVerificationFailed('session_invalid');

    await this.prisma.portalSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });

    return session;
  }

  async signOut(token: string): Promise<void> {
    const hash = hashSessionToken(token);
    // updateMany, not update: a missing token must not 404 (that would confirm
    // whether a token was ever valid).
    await this.prisma.portalSession.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ─── Client-facing case view ───────────────────────────────────────────────

  /**
   * Everything the client may see, and nothing else.
   *
   * Explicitly excluded: internal notes, owner/assignee identity, completion
   * percentages, storage references, rejection reasons, audit history, return
   * counts, and every handoff field.
   */
  async getCaseView(caseId: string): Promise<PortalCaseView> {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, deletedAt: null },
      include: {
        lead: { select: { firstName: true, lastName: true } },
        documents: {
          where: { clientVisible: true, deletedAt: null },
          select: { id: true, name: true, status: true, receivedAt: true },
          orderBy: { displayOrder: 'asc' },
        },
        caseNotes: {
          where: { clientVisible: true, deletedAt: null },
          select: { id: true, content: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!docCase) throw new PortalVerificationFailed('case_missing_on_view');

    if (!isPortalAccessible({
      portalEnabledAt: docCase.portalEnabledAt,
      portalPhoneLast4: docCase.portalPhoneLast4,
      status: docCase.status,
    })) {
      throw new PortalVerificationFailed('portal_deactivated_mid_session');
    }

    const currentStage = progressStageFor(docCase.status);
    const currentIdx = PORTAL_PROGRESS_STAGES.findIndex(s => s.key === currentStage);

    return {
      caseNumber: docCase.caseNumber!,
      clientName: [docCase.lead.firstName, docCase.lead.lastName].filter(Boolean).join(' '),
      status: docCase.status,
      portalActivatedAt: docCase.portalEnabledAt!.toISOString(),
      progressStages: PORTAL_PROGRESS_STAGES.map((s, i) => ({
        key: s.key,
        label: s.label,
        completedAt: i < currentIdx ? docCase.portalEnabledAt!.toISOString() : null,
        isCurrent: i === currentIdx,
      })),
      documents: docCase.documents.map(d => ({
        id: d.id,
        name: d.name,
        status: toClientDocStatus(d.status),
        receivedAt: d.receivedAt?.toISOString() ?? null,
      })),
      notes: docCase.caseNotes.map(n => ({
        id: n.id,
        content: n.content,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  // ─── Publishing (staff side) ───────────────────────────────────────────────

  /**
   * Publish or unpublish a note. The first publish on a case activates its
   * portal; unpublishing the last one deactivates it again.
   */
  async setNoteVisibility(ctx: TenantContext, noteId: string, clientVisible: boolean) {
    return this.prisma.$transaction(async tx => {
      const note = await tx.docCaseNote.findFirst({
        where: { id: noteId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!note) throw new ResourceNotFoundError();

      await tx.docCaseNote.update({
        where: { id: noteId },
        data: { clientVisible, clientVisibleAt: clientVisible ? new Date() : null },
      });

      return this.reconcilePortalActivation(tx, ctx, note.caseId, clientVisible, 'note', noteId);
    });
  }

  async setDocumentVisibility(ctx: TenantContext, documentId: string, clientVisible: boolean) {
    return this.prisma.$transaction(async tx => {
      const doc = await tx.docCaseDocument.findFirst({
        where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc) throw new ResourceNotFoundError();

      await tx.docCaseDocument.update({
        where: { id: documentId },
        data: { clientVisible, clientVisibleAt: clientVisible ? new Date() : null },
      });

      return this.reconcilePortalActivation(tx, ctx, doc.caseId, clientVisible, 'document', documentId);
    });
  }

  /**
   * Single place that decides whether a portal is on or off, so note and
   * document publishing can never disagree about activation state.
   */
  private async reconcilePortalActivation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    caseId: string,
    published: boolean,
    entity: 'note' | 'document',
    entityId: string,
  ) {
    const docCase = await tx.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId } });
    if (!docCase) throw new ResourceNotFoundError();

    const [visibleNotes, visibleDocs] = await Promise.all([
      tx.docCaseNote.count({ where: { caseId, clientVisible: true, deletedAt: null } }),
      tx.docCaseDocument.count({ where: { caseId, clientVisible: true, deletedAt: null } }),
    ]);
    const visibleCount = visibleNotes + visibleDocs;

    // Activation needs a phone to verify against; without one the portal is unusable.
    const canActivate = visibleCount > 0 && !!docCase.portalPhoneLast4;

    const updated = await tx.docCase.update({
      where: { id: caseId },
      data: {
        portalEnabledAt: canActivate ? (docCase.portalEnabledAt ?? new Date()) : null,
        lastClientVisiblePublishAt: published ? new Date() : docCase.lastClientVisiblePublishAt,
      },
    });

    if (published) {
      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId,
          eventType: DocEventType.CLIENT_VISIBLE_PUBLISHED,
          actorUserId: ctx.userId,
          payload: { entity, entityId, visibleCount },
        },
      });
    }

    // Deactivation revokes live sessions — a client mid-session must not keep
    // reading a case that was just unpublished.
    if (!canActivate && docCase.portalEnabledAt) {
      await tx.portalSession.updateMany({
        where: { caseId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return updated;
  }

  // ─── Portal contact change (manager-gated) ─────────────────────────────────

  async requestContactChange(ctx: TenantContext, caseId: string, newPhone: string, reason: string) {
    if (normalisePhone(newPhone ?? '').length < 10)
      throw new ValidationError('A valid phone number is required.');
    if (!reason?.trim())
      throw new ValidationError('A reason is required.');

    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!docCase) throw new ResourceNotFoundError();

    const pending = await this.prisma.portalContactChangeRequest.findFirst({
      where: { caseId, status: PortalContactChangeStatus.PENDING },
    });
    if (pending)
      throw new BusinessRuleViolationError('A contact change request is already pending for this case.');

    const request = await this.prisma.portalContactChangeRequest.create({
      data: {
        tenantId: ctx.tenantId, caseId, newPhone: newPhone.trim(),
        reason: reason.trim(), requestedBy: ctx.userId,
      },
    });

    await this.audit.log({
      tenantId: ctx.tenantId, eventType: 'PORTAL_CONTACT_CHANGE_REQUESTED',
      entityType: 'PortalContactChangeRequest', entityId: request.id,
      actorUserId: ctx.userId, operation: 'CREATE',
      payload: { caseId, reason: reason.trim() },
    });

    return request;
  }

  /**
   * Approval swaps the portal phone AND revokes every live session for the case.
   * Both happen in one transaction: a changed contact with a surviving session
   * would leave the previous holder authenticated.
   */
  async approveContactChange(ctx: TenantContext, requestId: string) {
    return this.prisma.$transaction(async tx => {
      const request = await tx.portalContactChangeRequest.findFirst({
        where: { id: requestId, tenantId: ctx.tenantId },
      });
      if (!request) throw new ResourceNotFoundError();
      if (request.status !== PortalContactChangeStatus.PENDING)
        throw new BusinessRuleViolationError('This request has already been resolved.');
      if (request.requestedBy === ctx.userId)
        throw new BusinessRuleViolationError('A contact change cannot be approved by its requester.');

      const now = new Date();

      await tx.portalContactChangeRequest.update({
        where: { id: requestId },
        data: { status: PortalContactChangeStatus.APPROVED, approvedBy: ctx.userId, resolvedAt: now },
      });

      await tx.docCase.update({
        where: { id: request.caseId },
        data: {
          portalPhoneSnapshot: request.newPhone,
          portalPhoneLast4: phoneLast4(request.newPhone),
          portalPhoneSource: PortalPhoneSource.NOMINATED_OVERRIDE,
          lastInternalChangeAt: now,
        },
      });

      const revoked = await tx.portalSession.updateMany({
        where: { caseId: request.caseId, revokedAt: null },
        data: { revokedAt: now },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: request.caseId,
          eventType: DocEventType.PORTAL_CONTACT_CHANGE_APPROVED,
          actorUserId: ctx.userId,
          payload: { requestId, sessionsRevoked: revoked.count },
        },
      });

      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'PORTAL_CONTACT_CHANGE_APPROVED',
        entityType: 'PortalContactChangeRequest', entityId: requestId,
        actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { caseId: request.caseId, sessionsRevoked: revoked.count },
      });

      return { requestId, sessionsRevoked: revoked.count };
    });
  }

  async rejectContactChange(ctx: TenantContext, requestId: string) {
    const request = await this.prisma.portalContactChangeRequest.findFirst({
      where: { id: requestId, tenantId: ctx.tenantId },
    });
    if (!request) throw new ResourceNotFoundError();
    if (request.status !== PortalContactChangeStatus.PENDING)
      throw new BusinessRuleViolationError('This request has already been resolved.');

    return this.prisma.portalContactChangeRequest.update({
      where: { id: requestId },
      data: { status: PortalContactChangeStatus.REJECTED, approvedBy: ctx.userId, resolvedAt: new Date() },
    });
  }

  /** Staff-initiated revocation of every live session on a case. */
  async revokeSessions(ctx: TenantContext, caseId: string) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!docCase) throw new ResourceNotFoundError();

    const revoked = await this.prisma.portalSession.updateMany({
      where: { caseId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.log({
      tenantId: ctx.tenantId, eventType: 'PORTAL_SESSION_REVOKED', entityType: 'DocCase',
      entityId: caseId, actorUserId: ctx.userId, operation: 'UPDATE',
      payload: { sessionsRevoked: revoked.count },
    });

    return { sessionsRevoked: revoked.count };
  }

  /** Active session count per case — powers the Client Portal settings panel. */
  async activeSessionStats(ctx: TenantContext) {
    const now = new Date();
    const [activeSessions, failures24h] = await Promise.all([
      this.prisma.portalSession.count({
        where: { tenantId: ctx.tenantId, revokedAt: null, expiresAt: { gt: now } },
      }),
      this.prisma.portalAuthAttempt.count({
        where: {
          tenantId: ctx.tenantId, succeeded: false,
          attemptedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
        },
      }),
    ]);
    return { activeSessions, failures24h };
  }
}

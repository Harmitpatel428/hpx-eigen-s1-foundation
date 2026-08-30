import {
  PrismaClient,
  DocCaseStatus,
  DocEventType,
  HandoffState,
  HandoffReturnReason,
  LeadStage,
  PortalContactChangeStatus,
  Prisma,
} from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ValidationError,
  ResourceNotFoundError,
  BusinessRuleViolationError,
} from '../types/exceptions';
import { generateCaseNumber, isValidCaseNumber, normalisePhone, phoneLast4 } from '../domain/caseNumber';
import {
  canTransition,
  checkResendAllowed,
  computeAutoDropAt,
  requiresManagerReviewAfterReturn,
} from '../domain/handoff';
import type { TenantContext } from './documentation.service';

/** Deny reasons from the domain layer are business-rule violations, not 500s. */
function assertAllowed(check: { allowed: boolean; reason?: string }): void {
  if (!check.allowed) throw new BusinessRuleViolationError(check.reason);
}

export class HandoffService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /**
   * Sales confirms a qualified lead. Creates (or reuses) the DocCase, assigns
   * the public case number, and puts it in the Documentation inbox.
   *
   * Idempotent by construction: DocCase carries @@unique([tenantId, leadId]), so
   * a repeated confirm returns the existing case rather than minting a second
   * case number for the same lead.
   */
  async confirmHandoff(ctx: TenantContext, leadId: string, presetId?: string) {
    return this.prisma.$transaction(async tx => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!lead) throw new ResourceNotFoundError();

      if (lead.stage !== LeadStage.QUALIFIED)
        throw new BusinessRuleViolationError('Only a qualified lead can be handed off.');

      const existing = await tx.docCase.findFirst({
        where: { tenantId: ctx.tenantId, leadId, deletedAt: null },
      });

      // Already handed off — return it unchanged rather than creating a duplicate.
      if (existing?.caseNumber) return existing;

      assertAllowed(
        canTransition('CONFIRM', existing?.status ?? DocCaseStatus.INCOMING,
          existing?.handoffState ?? HandoffState.NONE, false),
      );

      const caseNumber = await this.mintCaseNumber(tx);
      const now = new Date();
      const phone = lead.phone ?? null;

      const data = {
        caseNumber,
        status: DocCaseStatus.INCOMING,
        handoffState: HandoffState.HANDED_OFF,
        handoffAt: now,
        handoffBy: ctx.userId,
        handoffPhoneSnapshot: phone,
        handoffPresetSnapshot: presetId ?? null,
        // Portal phone is snapshotted at handoff but the portal stays dark until
        // the first client-visible publish sets portalEnabledAt.
        portalPhoneSnapshot: phone,
        portalPhoneLast4: phone ? phoneLast4(phone) : null,
        lastInternalChangeAt: now,
      };

      const docCase = existing
        ? await tx.docCase.update({ where: { id: existing.id }, data })
        : await tx.docCase.create({
            data: { ...data, tenantId: ctx.tenantId, leadId, presetId: presetId ?? null, createdBy: ctx.userId },
          });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId,
          caseId: docCase.id,
          eventType: DocEventType.HANDOFF_CREATED,
          actorUserId: ctx.userId,
          payload: { caseNumber, leadId },
        },
      });

      await this.audit.log({
        tenantId: ctx.tenantId,
        eventType: 'HANDOFF_CREATED',
        entityType: 'DocCase',
        entityId: docCase.id,
        actorUserId: ctx.userId,
        operation: 'CREATE',
        payload: { caseNumber, leadId },
      });

      return docCase;
    });
  }

  /** Documentation accepts an incoming handoff and takes ownership. */
  async accept(ctx: TenantContext, caseId: string) {
    return this.prisma.$transaction(async tx => {
      const docCase = await this.loadCase(tx, ctx, caseId);
      assertAllowed(canTransition('ACCEPT', docCase.status, docCase.handoffState, docCase.managerReviewRequired));

      const updated = await tx.docCase.update({
        where: { id: caseId },
        data: {
          status: DocCaseStatus.ACTIVE,
          handoffState: HandoffState.ACCEPTED,
          acceptedAt: new Date(),
          acceptedBy: ctx.userId,
          assignedTo: docCase.assignedTo ?? ctx.userId,
          // Acceptance clears the return clock.
          autoDropAt: null,
          lastInternalChangeAt: new Date(),
        },
      });

      await this.event(tx, ctx, caseId, DocEventType.HANDOFF_ACCEPTED, {});
      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'HANDOFF_ACCEPTED', entityType: 'DocCase',
        entityId: caseId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { caseNumber: docCase.caseNumber },
      });
      return updated;
    });
  }

  /**
   * Reject BEFORE acceptance. The case stays INCOMING for Sales to fix & resend.
   * Distinct from `returnAfterAcceptance` in guard, event type, and SLA effect.
   */
  async reject(ctx: TenantContext, caseId: string, reasonCode: HandoffReturnReason, note: string) {
    if (!note?.trim()) throw new ValidationError('A rejection reason note is required.');

    return this.prisma.$transaction(async tx => {
      const docCase = await this.loadCase(tx, ctx, caseId);
      assertAllowed(canTransition('REJECT', docCase.status, docCase.handoffState, docCase.managerReviewRequired));

      const returnCount = docCase.returnCount + 1;
      const managerReviewRequired = requiresManagerReviewAfterReturn(returnCount, reasonCode);

      const updated = await tx.docCase.update({
        where: { id: caseId },
        data: {
          status: DocCaseStatus.INCOMING,
          handoffState: managerReviewRequired
            ? HandoffState.MANAGER_REVIEW_REQUIRED
            : HandoffState.RETURNED,
          returnCount,
          returnReasonCode: reasonCode,
          returnReasonNote: note.trim(),
          returnedAt: new Date(),
          managerReviewRequired,
          autoDropAt: computeAutoDropAt(new Date()),
          lastInternalChangeAt: new Date(),
        },
      });

      await this.event(tx, ctx, caseId, DocEventType.HANDOFF_REJECTED, {
        reasonCode, note: note.trim(), returnCount, managerReviewRequired,
      });
      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'HANDOFF_REJECTED', entityType: 'DocCase',
        entityId: caseId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { reasonCode, returnCount, managerReviewRequired },
      });
      return updated;
    });
  }

  /**
   * Return AFTER acceptance. Blocked once the case has moved to Process —
   * at that point Process owns it and a CRM-side return would silently diverge
   * from the downstream system.
   */
  async returnAfterAcceptance(
    ctx: TenantContext, caseId: string, reasonCode: HandoffReturnReason, note: string,
  ) {
    if (!note?.trim()) throw new ValidationError('A return reason note is required.');

    return this.prisma.$transaction(async tx => {
      const docCase = await this.loadCase(tx, ctx, caseId);
      assertAllowed(canTransition('RETURN', docCase.status, docCase.handoffState, docCase.managerReviewRequired));

      const returnedAt = new Date();
      const returnCount = docCase.returnCount + 1;
      const managerReviewRequired = requiresManagerReviewAfterReturn(returnCount, reasonCode);

      const updated = await tx.docCase.update({
        where: { id: caseId },
        data: {
          status: DocCaseStatus.RETURNED,
          handoffState: managerReviewRequired
            ? HandoffState.MANAGER_REVIEW_REQUIRED
            : HandoffState.RETURNED,
          returnedAt,
          returnCount,
          returnReasonCode: reasonCode,
          returnReasonNote: note.trim(),
          managerReviewRequired,
          autoDropAt: computeAutoDropAt(returnedAt),
          lastInternalChangeAt: returnedAt,
        },
      });

      await this.event(tx, ctx, caseId, DocEventType.CASE_RETURNED, {
        reasonCode, note: note.trim(), returnCount, managerReviewRequired,
      });
      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'CASE_RETURNED', entityType: 'DocCase',
        entityId: caseId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { reasonCode, returnCount, managerReviewRequired },
      });
      return updated;
    });
  }

  /**
   * Sales fixes the flagged problem and resends. The reason code decides what
   * counts as proof — a note alone is never enough.
   */
  async resend(ctx: TenantContext, caseId: string, resolutionNote: string) {
    return this.prisma.$transaction(async tx => {
      const docCase = await this.loadCase(tx, ctx, caseId);
      assertAllowed(canTransition('RESEND', docCase.status, docCase.handoffState, docCase.managerReviewRequired));

      const lead = await tx.lead.findFirst({
        where: { id: docCase.leadId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!lead) throw new ResourceNotFoundError();

      const approvedOverride = await tx.portalContactChangeRequest.findFirst({
        where: { caseId, status: PortalContactChangeStatus.APPROVED },
      });

      assertAllowed(checkResendAllowed({
        returnReasonCode: docCase.returnReasonCode,
        resolutionNote,
        phoneAtHandoff: docCase.handoffPhoneSnapshot,
        currentPhone: lead.phone,
        hasApprovedContactOverride: !!approvedOverride,
        presetAtHandoff: docCase.handoffPresetSnapshot,
        currentPreset: docCase.presetId,
      }));

      const now = new Date();
      const phone = lead.phone ?? null;

      const updated = await tx.docCase.update({
        where: { id: caseId },
        data: {
          status: DocCaseStatus.INCOMING,
          handoffState: HandoffState.RESENT,
          handoffAt: now,
          handoffBy: ctx.userId,
          // Re-snapshot so the next return compares against what was actually resent.
          handoffPhoneSnapshot: phone,
          handoffPresetSnapshot: docCase.presetId,
          returnReasonCode: null,
          returnReasonNote: null,
          autoDropAt: null,
          lastInternalChangeAt: now,
        },
      });

      await this.event(tx, ctx, caseId, DocEventType.HANDOFF_RESENT, {
        resolutionNote: resolutionNote.trim(),
        previousReason: docCase.returnReasonCode,
      });
      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'HANDOFF_RESENT', entityType: 'DocCase',
        entityId: caseId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { previousReason: docCase.returnReasonCode, returnCount: docCase.returnCount },
      });
      return updated;
    });
  }

  /** A manager clears the review lock so Sales can resend again. */
  async clearManagerReview(ctx: TenantContext, caseId: string, note: string) {
    if (!note?.trim()) throw new ValidationError('A manager review note is required.');

    return this.prisma.$transaction(async tx => {
      const docCase = await this.loadCase(tx, ctx, caseId);
      if (!docCase.managerReviewRequired)
        throw new BusinessRuleViolationError('This case is not awaiting manager review.');

      const updated = await tx.docCase.update({
        where: { id: caseId },
        data: {
          managerReviewRequired: false,
          handoffState: HandoffState.RETURNED,
          lastInternalChangeAt: new Date(),
        },
      });

      await this.event(tx, ctx, caseId, DocEventType.MANAGER_REVIEW_COMPLETED, { note: note.trim() });
      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'MANAGER_REVIEW_COMPLETED', entityType: 'DocCase',
        entityId: caseId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { note: note.trim() },
      });
      return updated;
    });
  }

  /** Lookup by public case number — powers staff Case ID search. */
  async findByCaseNumber(ctx: TenantContext, caseNumber: string) {
    if (!isValidCaseNumber(caseNumber)) throw new ValidationError('Invalid case number format.');
    return this.prisma.docCase.findFirst({
      where: { tenantId: ctx.tenantId, caseNumber: caseNumber.toUpperCase(), deletedAt: null },
      include: { lead: { select: { id: true, firstName: true, lastName: true, company: true, phone: true } } },
    });
  }

  /** Documentation inbox: everything awaiting acceptance, oldest first. */
  async listIncoming(ctx: TenantContext) {
    return this.prisma.docCase.findMany({
      where: { tenantId: ctx.tenantId, status: DocCaseStatus.INCOMING, deletedAt: null },
      include: { lead: { select: { id: true, firstName: true, lastName: true, company: true, phone: true } } },
      orderBy: { handoffAt: 'asc' },
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async loadCase(tx: Prisma.TransactionClient, ctx: TenantContext, caseId: string) {
    const docCase = await tx.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!docCase) throw new ResourceNotFoundError();
    return docCase;
  }

  private async event(
    tx: Prisma.TransactionClient, ctx: TenantContext, caseId: string,
    eventType: DocEventType, payload: Record<string, unknown>,
  ) {
    await tx.docCaseEvent.create({
      data: {
        tenantId: ctx.tenantId, caseId, eventType, actorUserId: ctx.userId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Mint a unique case number. The alphabet gives 32^8 ≈ 1.1e12 possibilities,
   * so a collision is vanishingly unlikely — but the column is UNIQUE and this
   * is an auth factor, so retry rather than trusting the odds.
   */
  private async mintCaseNumber(tx: Prisma.TransactionClient): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = generateCaseNumber();
      const clash = await tx.docCase.findUnique({ where: { caseNumber: candidate } });
      if (!clash) return candidate;
    }
    throw new BusinessRuleViolationError('Could not allocate a case number. Please retry.');
  }
}

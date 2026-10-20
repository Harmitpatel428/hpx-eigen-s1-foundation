import {
  PrismaClient,
  DocCaseStatus,
  DocEventType,
  ProcessHandoffState,
  ProcessReturnReason,
  Prisma,
} from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ValidationError,
  ResourceNotFoundError,
  BusinessRuleViolationError,
  ConflictError,
} from '../types/exceptions';
import { canTransition, checkReturnReason, precondition } from '../domain/process-handoff';
import type { TenantContext } from './documentation.service';

/**
 * Process-side of the Documentation → Process handover (Option B).
 * Mirrors handoff.service.ts (the Sales→Doc inbound side). Pure state rules live
 * in src/domain/process-handoff.ts; this service owns the DB writes, audit and
 * events. Every mutation is a preconditioned updateMany whose WHERE is the
 * domain `precondition(action)` — a 0-row result is a lost race → ConflictError.
 */
export class ProcessHandoffService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Process accepts a pending case → Process-owned (TRANSFERRED_TO_PROCESS). */
  async accept(ctx: TenantContext, caseId: string) {
    return this.prisma.$transaction(async (tx) => {
      const docCase = await this.load(tx, ctx, caseId);

      const check = canTransition('ACCEPT', docCase.status, docCase.processHandoffState);
      if (!check.allowed) throw new BusinessRuleViolationError(check.reason);

      const now = new Date();
      const pre = precondition('ACCEPT');
      const result = await tx.docCase.updateMany({
        where: {
          id: caseId, tenantId: ctx.tenantId, deletedAt: null,
          status: { in: pre.status }, processHandoffState: { in: pre.processHandoffState },
        },
        data: {
          status:              DocCaseStatus.TRANSFERRED_TO_PROCESS,
          processHandoffState: ProcessHandoffState.ACCEPTED,
          processAcceptedAt:   now,
          processAcceptedBy:   ctx.userId,
          processAssignedTo:   docCase.processAssignedTo ?? ctx.userId,
        },
      });
      if (result.count === 0) throw new ConflictError();

      await this.event(tx, ctx, caseId, DocEventType.PROCESS_HANDOFF_ACCEPTED, {});
      // In-transaction audit (design §H): the hash-chain append shares the state-change tx.
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'PROCESS_HANDOFF_ACCEPTED', entityType: 'DocCase', entityId: caseId,
        operation: 'UPDATE', payload: { caseNumber: docCase.caseNumber, processAssignedTo: docCase.processAssignedTo ?? ctx.userId },
      });
      return tx.docCase.findFirst({ where: { id: caseId }, include: { lead: true, preset: true } });
    });
  }

  /**
   * Process returns a pending case to Documentation. Reason is always required;
   * a note is required only when the reason is OTHER (ratified 2026-10-19).
   */
  async returnToDocumentation(
    ctx: TenantContext, caseId: string, reasonCode: ProcessReturnReason, note: string,
  ) {
    const reasonCheck = checkReturnReason(reasonCode, note);
    if (!reasonCheck.allowed) throw new ValidationError(reasonCheck.reason!);

    return this.prisma.$transaction(async (tx) => {
      const docCase = await this.load(tx, ctx, caseId);

      const check = canTransition('RETURN', docCase.status, docCase.processHandoffState);
      if (!check.allowed) throw new BusinessRuleViolationError(check.reason);

      const now = new Date();
      const pre = precondition('RETURN');
      const result = await tx.docCase.updateMany({
        where: {
          id: caseId, tenantId: ctx.tenantId, deletedAt: null,
          status: { in: pre.status }, processHandoffState: { in: pre.processHandoffState },
        },
        data: {
          status:                  DocCaseStatus.RETURNED_TO_DOCUMENTATION,
          processHandoffState:     ProcessHandoffState.RETURNED,
          processReturnedAt:       now,
          processReturnCount:      { increment: 1 },
          processReturnReasonCode: reasonCode,
          processReturnReasonNote: note.trim() || null,
        },
      });
      if (result.count === 0) throw new ConflictError();

      await this.event(tx, ctx, caseId, DocEventType.PROCESS_HANDOFF_RETURNED, {
        reasonCode, hasNote: !!note.trim(),
      });
      // In-transaction audit (design §H): the hash-chain append shares the state-change tx.
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'PROCESS_HANDOFF_RETURNED', entityType: 'DocCase', entityId: caseId,
        operation: 'UPDATE', payload: { caseNumber: docCase.caseNumber, reasonCode, processReturnCount: docCase.processReturnCount + 1 },
      });
      return tx.docCase.findFirst({ where: { id: caseId }, include: { lead: true, preset: true } });
    });
  }

  /** The Process incoming queue: cases awaiting Process acceptance (tenant-scoped). */
  async listPendingForProcess(ctx: TenantContext) {
    const cases = await this.prisma.docCase.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: DocCaseStatus.PENDING_PROCESS_REVIEW,
        deletedAt: null,
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, company: true, phone: true } },
        preset: { select: { id: true, name: true } },
        caseType: { select: { id: true, name: true } },
      },
      orderBy: { processHandoffAt: 'asc' },
    });

    // DocCase has no user relation for processHandoffBy — resolve display names with a
    // manual map (cf. the Lead ownerMap pattern). Falls back to null (FE shows the id).
    const byIds = [...new Set(cases.map((c) => c.processHandoffBy).filter((x): x is string => !!x))];
    const users = byIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: byIds }, tenantId: ctx.tenantId },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [];
    const nameOf = (u: { firstName: string | null; lastName: string | null; email: string }) =>
      [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
    const nameById = new Map(users.map((u) => [u.id, nameOf(u)]));
    const rows = cases.map((c) => ({
      ...c,
      processHandoffByName: c.processHandoffBy ? nameById.get(c.processHandoffBy) ?? null : null,
    }));

    // Header counts carried in THIS (process:view) response so the queue header does not
    // depend on the doc:view-gated dashboard. Same tenant scope, over the full set.
    const grouped = await this.prisma.docCase.groupBy({
      by: ['status'],
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        status: {
          in: [
            DocCaseStatus.PENDING_PROCESS_REVIEW,
            DocCaseStatus.TRANSFERRED_TO_PROCESS,
            DocCaseStatus.RETURNED_TO_DOCUMENTATION,
          ],
        },
      },
      _count: { _all: true },
    });
    const n = (s: DocCaseStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;

    return {
      cases: rows,
      counts: {
        incoming: n(DocCaseStatus.PENDING_PROCESS_REVIEW),
        processing: n(DocCaseStatus.TRANSFERRED_TO_PROCESS),
        returned: n(DocCaseStatus.RETURNED_TO_DOCUMENTATION),
      },
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async load(tx: Prisma.TransactionClient, ctx: TenantContext, caseId: string) {
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
}

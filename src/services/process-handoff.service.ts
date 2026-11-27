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
import { processCaseVisibilityWhere } from '../utils/process-case-visibility.helper';
import type { TenantContext } from './documentation.service';

/** The three Process-relevant case statuses the Process queue surfaces. */
const PROCESS_QUEUE_STATUSES: DocCaseStatus[] = [
  DocCaseStatus.PENDING_PROCESS_REVIEW,
  DocCaseStatus.TRANSFERRED_TO_PROCESS,
  DocCaseStatus.RETURNED_TO_DOCUMENTATION,
];

/** Terminal statuses excluded from the overdue KPI. */
const TERMINAL_STATUSES: DocCaseStatus[] = [
  DocCaseStatus.CLOSED,
  DocCaseStatus.CANCELLED,
  DocCaseStatus.CLOSED_NO_DOCS,
];

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

  /**
   * The Process case queue. Returns the three Process-relevant statuses (or one,
   * when `status` is given), scoped by the view-all/self rule: a caller with
   * `restrictToUserId` set (no process:case:view-all) sees only cases where
   * processAssignedTo = self. Header `counts` are scoped the same way.
   */
  async listCasesForProcess(
    ctx: TenantContext,
    opts: {
      status?: DocCaseStatus;
      search?: string;
      page?: number;
      pageSize?: number;
      restrictToUserId?: string;
    } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, opts.pageSize ?? 50);
    const skip = (page - 1) * pageSize;

    // Tenant + soft-delete + Process status set + view-all/self scope. Search and scope
    // go in an AND array so neither can clobber the other's keys (cf. listCases).
    const conjuncts: Prisma.DocCaseWhereInput[] = [processCaseVisibilityWhere(opts.restrictToUserId)];
    if (opts.search) {
      conjuncts.push({
        OR: [
          { caseNumber: { contains: opts.search, mode: 'insensitive' } },
          { lead: { is: { OR: [
            { firstName: { contains: opts.search, mode: 'insensitive' } },
            { lastName:  { contains: opts.search, mode: 'insensitive' } },
            { company:   { contains: opts.search, mode: 'insensitive' } },
          ] } } },
        ],
      });
    }
    const statusWhere: Prisma.DocCaseWhereInput = opts.status
      ? { status: opts.status }
      : { status: { in: PROCESS_QUEUE_STATUSES } };

    const where: Prisma.DocCaseWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      ...statusWhere,
      AND: conjuncts,
    };
    // Counts use the SAME tenant+scope, but always over the full Process status set
    // (independent of the `status` filter) so the header totals don't collapse to one.
    const countsWhere: Prisma.DocCaseWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      status: { in: PROCESS_QUEUE_STATUSES },
      AND: conjuncts,
    };

    const [cases, grouped] = await Promise.all([
      this.prisma.docCase.findMany({
        where,
        include: {
          lead: { select: { id: true, firstName: true, lastName: true, company: true, phone: true } },
          preset: { select: { id: true, name: true } },
          caseType: { select: { id: true, name: true } },
        },
        orderBy: { processHandoffAt: 'asc' },
        skip,
        take: pageSize,
      }),
      this.prisma.docCase.groupBy({
        by: ['status'],
        where: countsWhere,
        _count: { _all: true },
      }),
    ]);

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
    const n = (s: DocCaseStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;

    return {
      cases: cases.map((c) => ({
        ...c,
        processHandoffByName: c.processHandoffBy ? nameById.get(c.processHandoffBy) ?? null : null,
      })),
      counts: {
        incoming: n(DocCaseStatus.PENDING_PROCESS_REVIEW),
        processing: n(DocCaseStatus.TRANSFERRED_TO_PROCESS),
        returned: n(DocCaseStatus.RETURNED_TO_DOCUMENTATION),
      },
      page,
      pageSize,
    };
  }

  /**
   * Process case detail. Same view-all/self scope as the queue — an out-of-scope
   * or other-tenant id reads as not-found (404), matching getCaseById's convention.
   * Returns the case + events + requirements (DocCaseDocument) + uploaded documents + notes.
   */
  async getCaseForProcess(ctx: TenantContext, caseId: string, opts: { restrictToUserId?: string } = {}) {
    const docCase = await this.prisma.docCase.findFirst({
      where: {
        id: caseId, tenantId: ctx.tenantId, deletedAt: null,
        ...processCaseVisibilityWhere(opts.restrictToUserId),
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true, status: true } },
        preset: { select: { id: true, name: true, category: true, color: true, icon: true } },
        caseType: { select: { id: true, name: true } },
        documents: {
          where: { deletedAt: null },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: { storageRefs: { orderBy: { createdAt: 'desc' } } },
        },
        uploadedDocuments: {
          where: { deletedAt: null, isActive: true },
          orderBy: [{ createdAt: 'desc' }],
          select: {
            id: true, category: true, name: true, originalFilename: true, mimeType: true,
            sizeBytes: true, status: true, sourceChannel: true, uploadedByParty: true,
            clientVisible: true, isActive: true, receivedAt: true, requirementId: true, createdAt: true,
          },
        },
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
        caseNotes: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
        _count: { select: { documents: true } },
      },
    });
    if (!docCase) throw new ResourceNotFoundError();
    return docCase;
  }

  /**
   * Assign a Process case to a Process Executive. Writes ONLY processAssignedTo
   * (updatedAt is bumped by Prisma); status and handoff state are untouched. The
   * assignee must be a user in the same tenant. Emits a DocCaseEvent + hash-chain
   * audit row in the same transaction.
   */
  async assign(ctx: TenantContext, caseId: string, assigneeUserId: string) {
    const assignee = await this.prisma.user.findFirst({
      where: { id: assigneeUserId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!assignee) throw new ValidationError('Assignee is not a user in this tenant.');

    return this.prisma.$transaction(async (tx) => {
      const docCase = await this.load(tx, ctx, caseId);
      const previous = docCase.processAssignedTo;

      await tx.docCase.update({
        where: { id: caseId },
        data: { processAssignedTo: assigneeUserId },
      });

      // ponytail: no PROCESS_CASE_ASSIGNED value in the DocEventType enum and this phase
      // forbids enum changes, so the case-timeline event rides on NOTE_ADDED with a
      // structured payload. The hash-chain audit row below carries the precise free-text
      // eventType. Upgrade: add a PROCESS_CASE_ASSIGNED enum value in a schema-touching phase.
      await this.event(tx, ctx, caseId, DocEventType.NOTE_ADDED, {
        action: 'PROCESS_CASE_ASSIGNED', processAssignedTo: assigneeUserId, previous,
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'PROCESS_CASE_ASSIGNED', entityType: 'DocCase', entityId: caseId,
        operation: 'UPDATE',
        payload: { caseNumber: docCase.caseNumber, processAssignedTo: assigneeUserId, previous },
      });
      return tx.docCase.findFirst({ where: { id: caseId }, include: { lead: true, preset: true } });
    });
  }

  /**
   * Process dashboard KPI counts, scoped by the same view-all/self rule.
   *   incoming   = PENDING_PROCESS_REVIEW
   *   processing = TRANSFERRED_TO_PROCESS
   *   returned   = processHandoffState RETURNED
   *   overdue    = dueDate < now AND status not terminal
   */
  async dashboard(ctx: TenantContext, opts: { restrictToUserId?: string } = {}) {
    const scope = processCaseVisibilityWhere(opts.restrictToUserId);
    const base: Prisma.DocCaseWhereInput = { tenantId: ctx.tenantId, deletedAt: null, ...scope };

    const [incoming, processing, returned, overdue] = await Promise.all([
      this.prisma.docCase.count({ where: { ...base, status: DocCaseStatus.PENDING_PROCESS_REVIEW } }),
      this.prisma.docCase.count({ where: { ...base, status: DocCaseStatus.TRANSFERRED_TO_PROCESS } }),
      this.prisma.docCase.count({ where: { ...base, processHandoffState: ProcessHandoffState.RETURNED } }),
      this.prisma.docCase.count({
        where: { ...base, dueDate: { lt: new Date() }, status: { notIn: TERMINAL_STATUSES } },
      }),
    ]);
    return { incoming, processing, returned, overdue };
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

import { PrismaClient, Prisma, DocCaseStatus, MandateRequestStatus, DocEventType } from '@prisma/client';
import { AuditService } from './audit.service';
import { PortalService } from './portal.service';
import { ResourceNotFoundError, BusinessRuleViolationError } from '../types/exceptions';
import type { TenantContext } from './documentation.service';

export type CaseClosedReason =
  | 'CLIENT_FAILED_DOCS'
  | 'CLIENT_UNRESPONSIVE'
  | 'DUPLICATE_CASE'
  | 'FIRM_DECISION';

export class CaseLifecycleService {
  private readonly audit: AuditService;
  private readonly portal: PortalService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
    this.portal = new PortalService(prisma);
  }

  async closeWithoutDocs(
    ctx: TenantContext,
    caseId: string,
    reason: CaseClosedReason,
  ): Promise<{
    caseId: string;
    caseNumber: string | null;
    status: string;
    closedAt: Date;
    closedReason: string;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const closableStatuses: DocCaseStatus[] = ['INCOMING', 'ACTIVE'];

      const result = await tx.docCase.updateMany({
        where: {
          id: caseId,
          tenantId: ctx.tenantId,
          deletedAt: null,
          status: { in: closableStatuses },
          closedAt: null,
        },
        data: {
          status: 'CLOSED_NO_DOCS',
          closedAt: new Date(),
          closedReason: reason,
          closedByUserId: ctx.userId,
          managerReviewRequired: false,
        },
      });

      if (result.count === 0) {
        const existing = await tx.docCase.findFirst({
          where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (!existing) throw new ResourceNotFoundError();
        if (existing.closedAt) {
          // Idempotent — already closed, return current state.
          return {
            caseId,
            caseNumber: existing.caseNumber ?? null,
            status: existing.status,
            closedAt: existing.closedAt,
            closedReason: existing.closedReason ?? reason,
          };
        }
        throw new BusinessRuleViolationError(
          `Case in status ${existing.status} cannot be closed without documentation`,
        );
      }

      // Deactivate portal and revoke sessions atomically inside this transaction.
      await this.portal.disablePortalInTx(tx, {
        caseId,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
      });

      const updated = await tx.docCase.findUniqueOrThrow({
        where: { id: caseId },
        select: { caseNumber: true, status: true, closedAt: true, closedReason: true },
      });

      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_CLOSED_NO_DOCS',
        entityType: 'DocCase',
        entityId: caseId,
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { reason, caseNumber: updated.caseNumber ?? null },
      });

      // D5: kill any live upload tokens — supersede PENDING_UPLOAD mandate requests
      // on this case so their links stop working immediately. UPLOADED/VERIFIED untouched.
      const pending = await tx.mandateRequest.findMany({
        where: { caseId, tenantId: ctx.tenantId, status: MandateRequestStatus.PENDING_UPLOAD },
        select: { id: true },
      });
      if (pending.length > 0) {
        await tx.mandateRequest.updateMany({
          where: { caseId, tenantId: ctx.tenantId, status: MandateRequestStatus.PENDING_UPLOAD },
          data: { status: MandateRequestStatus.SUPERSEDED },
        });
        for (const p of pending) {
          await tx.docCaseEvent.create({
            data: {
              tenantId: ctx.tenantId, caseId, eventType: DocEventType.MANDATE_SUPERSEDED,
              actorUserId: ctx.userId,
              payload: { supersededRequestId: p.id, reason: 'CASE_CLOSED' } as unknown as Prisma.InputJsonValue,
            },
          });
          await this.audit.appendInTx(tx, {
            tenantId: ctx.tenantId, eventType: 'MANDATE_SUPERSEDED', entityType: 'MandateRequest',
            entityId: p.id, actorUserId: ctx.userId, operation: 'UPDATE',
            payload: { supersededRequestId: p.id, reason: 'CASE_CLOSED' },
          });
        }
      }

      return {
        caseId,
        caseNumber: updated.caseNumber ?? null,
        status: updated.status,
        closedAt: updated.closedAt!,
        closedReason: updated.closedReason ?? reason,
      };
    }, { maxWait: 5000, timeout: 15000 });
  }

  async reopenCase(
    ctx: TenantContext,
    caseId: string,
  ): Promise<{
    caseId: string;
    caseNumber: string | null;
    status: string;
    reopenedAt: Date;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.docCase.updateMany({
        where: {
          id: caseId,
          tenantId: ctx.tenantId,
          deletedAt: null,
          status: 'CLOSED_NO_DOCS',
        },
        data: {
          status: 'INCOMING',
          reopenedAt: new Date(),
          reopenedByUserId: ctx.userId,
          closedAt: null,
          closedReason: null,
          closedByUserId: null,
        },
      });

      if (result.count === 0) {
        const existing = await tx.docCase.findFirst({
          where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (!existing) throw new ResourceNotFoundError();
        throw new BusinessRuleViolationError(
          `Case in status ${existing.status} cannot be reopened — only CLOSED_NO_DOCS cases can be reopened`,
        );
      }

      const updated = await tx.docCase.findUniqueOrThrow({
        where: { id: caseId },
        select: { caseNumber: true, status: true, reopenedAt: true },
      });

      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_REOPENED',
        entityType: 'DocCase',
        entityId: caseId,
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { caseNumber: updated.caseNumber ?? null, reopenedToStatus: 'INCOMING' },
      });

      return {
        caseId,
        caseNumber: updated.caseNumber ?? null,
        status: updated.status,
        reopenedAt: updated.reopenedAt!,
      };
    }, { maxWait: 5000, timeout: 15000 });
  }
}

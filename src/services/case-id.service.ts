import { PrismaClient, Prisma } from '@prisma/client';
import { generateCaseNumber } from '../domain/caseNumber';
import { AuditService } from './audit.service';
import { ResourceNotFoundError, BusinessRuleViolationError } from '../types/exceptions';
import type { TenantContext } from './documentation.service';

const CASE_ID_MAX_RETRIES = 5;

async function mintUniqueCaseNumber(tx: Prisma.TransactionClient): Promise<string> {
  for (let i = 0; i < CASE_ID_MAX_RETRIES; i++) {
    const candidate = generateCaseNumber();
    const exists = await tx.docCase.findUnique({
      where: { caseNumber: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  throw new BusinessRuleViolationError('Could not allocate a case number after maximum retries. Please retry.');
}

export class CaseIdService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /**
   * Idempotent — returns existing caseNumber if already set.
   * Must be called inside an existing interactive transaction.
   */
  async generateCaseIdInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    docCaseId: string,
  ): Promise<{ caseNumber: string; alreadyGenerated: boolean }> {
    const docCase = await tx.docCase.findFirst({
      where: { id: docCaseId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!docCase) throw new ResourceNotFoundError();

    if (docCase.caseNumber) {
      return { caseNumber: docCase.caseNumber, alreadyGenerated: true };
    }

    const caseNumber = await mintUniqueCaseNumber(tx);
    await tx.docCase.update({ where: { id: docCaseId }, data: { caseNumber } });

    await this.audit.appendInTx(tx, {
      tenantId: ctx.tenantId,
      eventType: 'CASE_ID_GENERATED',
      entityType: 'DocCase',
      entityId: docCaseId,
      actorUserId: ctx.userId,
      operation: 'CREATE',
      payload: { caseNumber, docCaseId, leadId: docCase.leadId },
    });

    return { caseNumber, alreadyGenerated: false };
  }

  /** Manual generation — wraps generateCaseIdInTx in its own transaction. */
  async generateCaseIdManual(
    ctx: TenantContext,
    caseId: string,
  ): Promise<{ caseId: string; caseNumber: string; alreadyGenerated: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const result = await this.generateCaseIdInTx(tx, ctx, caseId);
      return { caseId, caseNumber: result.caseNumber, alreadyGenerated: result.alreadyGenerated };
    }, { maxWait: 5000, timeout: 15000 });
  }
}

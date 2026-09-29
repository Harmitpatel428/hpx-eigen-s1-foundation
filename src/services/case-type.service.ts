import {
  PrismaClient,
  Prisma,
  CaseTypeStatus,
  CaseFieldStatus,
  CaseType,
  CaseTypeFieldPlacement,
} from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ValidationError,
  ResourceNotFoundError,
  DuplicateResourceError,
  BusinessRuleViolationError,
} from '../types/exceptions';

export interface UserContext {
  tenantId: string;
  userId: string;
  actorIp?: string;
  actorUserAgent?: string;
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const TX_OPTS = { maxWait: 5000, timeout: 15000 };

function mapP2002(err: unknown, message: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new DuplicateResourceError(message);
  }
  throw err;
}

export class CaseTypeService {
  private readonly audit: AuditService;
  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  private async loadType(
    client: PrismaClient | Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<CaseType> {
    const row = await client.caseType.findFirst({ where: { id, tenantId } });
    if (!row) throw new ResourceNotFoundError();
    return row;
  }

  // ─── Catalog CRUD ─────────────────────────────────────────────
  async listTypes(ctx: UserContext, includeArchived = false): Promise<CaseType[]> {
    return this.prisma.caseType.findMany({
      where: { tenantId: ctx.tenantId, ...(includeArchived ? {} : { deletedAt: null }) },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async getType(ctx: UserContext, id: string): Promise<CaseType> {
    return this.loadType(this.prisma, ctx.tenantId, id);
  }

  async createType(
    ctx: UserContext,
    input: { key?: string; name?: string; description?: string | null; displayOrder?: number },
  ): Promise<CaseType> {
    const key = (input.key ?? '').trim();
    const name = (input.name ?? '').trim();
    if (!KEY_RE.test(key) || key.length > 64) {
      throw new ValidationError('key must be lowercase snake_case (start with a letter), 64 chars max.');
    }
    if (!name || name.length > 200) throw new ValidationError('name is required and must be 200 characters or fewer.');

    const existing = await this.prisma.caseType.findUnique({ where: { tenantId_key: { tenantId: ctx.tenantId, key } } });
    if (existing) throw new DuplicateResourceError(`A case type with key "${key}" already exists.`);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const type = await tx.caseType.create({
          data: { tenantId: ctx.tenantId, key, name, description: input.description ?? null, displayOrder: input.displayOrder ?? 0 },
        });
        await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_CREATED', 'CaseType', type.id, 'CREATE', { key, name }));
        return type;
      }, TX_OPTS);
    } catch (err) {
      mapP2002(err, `A case type with key "${key}" already exists.`);
    }
  }

  async updateType(
    ctx: UserContext,
    id: string,
    input: { key?: string; name?: string; description?: string | null; displayOrder?: number },
  ): Promise<CaseType> {
    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadType(tx, ctx.tenantId, id);
      if (type.status === CaseTypeStatus.ARCHIVED) throw new BusinessRuleViolationError('An archived case type cannot be edited.');
      if (input.key !== undefined && input.key.trim() !== type.key) throw new ValidationError('key is immutable and cannot be changed.');
      if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 200)) {
        throw new ValidationError('name is required and must be 200 characters or fewer.');
      }
      const updated = await tx.caseType.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_UPDATED', 'CaseType', id, 'UPDATE', {}, { name: type.name }));
      return updated;
    }, TX_OPTS);
  }

  /** DRAFT -> ACTIVE (case-type:publish gate applied at the router). */
  async publishType(ctx: UserContext, id: string): Promise<CaseType> {
    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadType(tx, ctx.tenantId, id);
      if (type.status !== CaseTypeStatus.DRAFT) throw new BusinessRuleViolationError('Only a DRAFT case type can be published.');
      const updated = await tx.caseType.update({ where: { id }, data: { status: CaseTypeStatus.ACTIVE } });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_PUBLISHED', 'CaseType', id, 'UPDATE', { status: 'ACTIVE' }, { status: type.status }));
      return updated;
    }, TX_OPTS);
  }

  /** {DRAFT,ACTIVE} -> ARCHIVED (+ deletedAt). Blocks new assignment; existing cases keep reading it. */
  async archiveType(ctx: UserContext, id: string): Promise<CaseType> {
    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadType(tx, ctx.tenantId, id);
      if (type.status === CaseTypeStatus.ARCHIVED) throw new BusinessRuleViolationError('Case type is already archived.');
      const updated = await tx.caseType.update({ where: { id }, data: { status: CaseTypeStatus.ARCHIVED, deletedAt: new Date() } });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_ARCHIVED', 'CaseType', id, 'UPDATE', { status: 'ARCHIVED' }, { status: type.status }));
      return updated;
    }, TX_OPTS);
  }

  // ─── Placements ───────────────────────────────────────────────
  async listPlacements(ctx: UserContext, caseTypeId: string): Promise<CaseTypeFieldPlacement[]> {
    await this.loadType(this.prisma, ctx.tenantId, caseTypeId);
    return this.prisma.caseTypeFieldPlacement.findMany({
      where: { tenantId: ctx.tenantId, caseTypeId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async addPlacement(
    ctx: UserContext,
    caseTypeId: string,
    input: { fieldId?: string; displayOrder?: number },
  ): Promise<CaseTypeFieldPlacement> {
    const fieldId = input.fieldId;
    if (!fieldId) throw new ValidationError('fieldId is required.');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const type = await this.loadType(tx, ctx.tenantId, caseTypeId);
        if (type.status === CaseTypeStatus.ARCHIVED) throw new BusinessRuleViolationError('Cannot edit placements on an archived case type.');
        const field = await tx.caseFieldDefinition.findFirst({ where: { id: fieldId, tenantId: ctx.tenantId } });
        if (!field) throw new ValidationError('fieldId does not reference a field in this organization.');
        if (field.status === CaseFieldStatus.ARCHIVED) throw new BusinessRuleViolationError('An archived field cannot be placed on a case type.');
        const placement = await tx.caseTypeFieldPlacement.create({
          data: { tenantId: ctx.tenantId, caseTypeId, fieldId, displayOrder: input.displayOrder ?? 0 },
        });
        await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_PLACEMENT_ADDED', 'CaseTypeFieldPlacement', placement.id, 'CREATE', { caseTypeId, fieldId }));
        return placement;
      }, TX_OPTS);
    } catch (err) {
      mapP2002(err, 'That field is already placed on this case type.');
    }
  }

  async updatePlacement(
    ctx: UserContext,
    caseTypeId: string,
    fieldId: string,
    input: { displayOrder?: number },
  ): Promise<CaseTypeFieldPlacement> {
    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadType(tx, ctx.tenantId, caseTypeId);
      if (type.status === CaseTypeStatus.ARCHIVED) throw new BusinessRuleViolationError('Cannot edit placements on an archived case type.');
      const placement = await tx.caseTypeFieldPlacement.findFirst({ where: { tenantId: ctx.tenantId, caseTypeId, fieldId } });
      if (!placement) throw new ResourceNotFoundError();
      const updated = await tx.caseTypeFieldPlacement.update({
        where: { id: placement.id },
        data: { ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}) },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_PLACEMENT_UPDATED', 'CaseTypeFieldPlacement', placement.id, 'UPDATE', { caseTypeId, fieldId }));
      return updated;
    }, TX_OPTS);
  }

  /** Removes the placement only — never touches stored CaseFieldValue rows. */
  async removePlacement(ctx: UserContext, caseTypeId: string, fieldId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const type = await this.loadType(tx, ctx.tenantId, caseTypeId);
      if (type.status === CaseTypeStatus.ARCHIVED) throw new BusinessRuleViolationError('Cannot edit placements on an archived case type.');
      const placement = await tx.caseTypeFieldPlacement.findFirst({ where: { tenantId: ctx.tenantId, caseTypeId, fieldId } });
      if (!placement) throw new ResourceNotFoundError();
      await tx.caseTypeFieldPlacement.delete({ where: { id: placement.id } });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_PLACEMENT_REMOVED', 'CaseTypeFieldPlacement', placement.id, 'DELETE', { caseTypeId, fieldId }));
    }, TX_OPTS);
  }

  // ─── DocCase assignment ───────────────────────────────────────
  /** Assign (ACTIVE type only) or clear (null) a case's caseTypeId. Never touches recalc fields. */
  async assignCaseType(ctx: UserContext, caseId: string, caseTypeId: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const docCase = await tx.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true, caseTypeId: true } });
      if (!docCase) throw new ResourceNotFoundError();

      if (caseTypeId) {
        const type = await tx.caseType.findFirst({ where: { id: caseTypeId, tenantId: ctx.tenantId } });
        if (!type) throw new ResourceNotFoundError();
        if (type.status !== CaseTypeStatus.ACTIVE) throw new BusinessRuleViolationError('Only an ACTIVE case type can be assigned to a case.');
      }

      const updated = await tx.docCase.update({ where: { id: caseId }, data: { caseTypeId }, select: { id: true, caseTypeId: true } });
      await this.audit.appendInTx(tx, this.auditRow(
        ctx,
        caseTypeId ? 'CASE_TYPE_ASSIGNED' : 'CASE_TYPE_CLEARED',
        'DocCase', caseId, 'UPDATE',
        { caseTypeId }, { caseTypeId: docCase.caseTypeId },
      ));
      return updated;
    }, TX_OPTS);
  }

  private auditRow(
    ctx: UserContext,
    eventType: string,
    entityType: string,
    entityId: string,
    operation: string,
    payload: Record<string, unknown>,
    beforeState?: Record<string, unknown>,
  ) {
    return {
      tenantId: ctx.tenantId,
      eventType,
      entityType,
      entityId,
      actorUserId: ctx.userId,
      actorIp: ctx.actorIp,
      actorUserAgent: ctx.actorUserAgent,
      operation,
      payload,
      ...(beforeState ? { beforeState } : {}),
    };
  }
}

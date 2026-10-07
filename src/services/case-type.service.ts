import {
  PrismaClient,
  Prisma,
  CaseTypeStatus,
  CaseFieldStatus,
  CaseType,
  CaseTypeFieldPlacement,
  CaseTypeComponent,
  CaseTypeComponentDocument,
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

/**
 * Stable merge key for a component document: trim, lowercase, collapse runs of
 * whitespace. Lines from different components that normalize alike share ONE
 * case requirement. Exported because materialization matches manual document
 * names with exactly this normalization.
 */
export function normalizeDedupeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

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

  // ─── Components (reusable document-requirement templates under a policy) ──────
  async listComponents(ctx: UserContext, caseTypeId: string, includeInactive = false): Promise<CaseTypeComponent[]> {
    // Reading is allowed even for ARCHIVED/soft-deleted types so retained assignments render.
    await this.loadType(this.prisma, ctx.tenantId, caseTypeId);
    return this.prisma.caseTypeComponent.findMany({
      where: {
        tenantId: ctx.tenantId,
        caseTypeId,
        ...(includeInactive ? {} : { isActive: true, deletedAt: null }),
      },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createComponent(
    ctx: UserContext,
    caseTypeId: string,
    input: { name?: string; description?: string | null; isMandatory?: boolean; displayOrder?: number },
  ): Promise<CaseTypeComponent> {
    const name = (input.name ?? '').trim();
    if (!name || name.length > 200) throw new ValidationError('name is required and must be 200 characters or fewer.');
    if (input.description != null && input.description.length > 2000) throw new ValidationError('description must be 2000 characters or fewer.');
    if (input.displayOrder !== undefined && (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)) {
      throw new ValidationError('displayOrder must be an integer >= 0.');
    }
    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadTypeForComponentWrite(tx, ctx.tenantId, caseTypeId);
      await this.assertNoDuplicateActiveName(tx, ctx.tenantId, type.id, name);
      const component = await tx.caseTypeComponent.create({
        data: {
          tenantId: ctx.tenantId,
          caseTypeId: type.id,
          name,
          description: input.description ?? null,
          isMandatory: input.isMandatory ?? false,
          displayOrder: input.displayOrder ?? 0,
        },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_COMPONENT_CREATED', 'CaseTypeComponent', component.id, 'CREATE', { caseTypeId: type.id, name }));
      return component;
    }, TX_OPTS);
  }

  async updateComponent(
    ctx: UserContext,
    caseTypeId: string,
    componentId: string,
    input: { name?: string; description?: string | null; isMandatory?: boolean; displayOrder?: number; isActive?: boolean },
  ): Promise<CaseTypeComponent> {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 200)) {
      throw new ValidationError('name is required and must be 200 characters or fewer.');
    }
    if (input.description != null && input.description.length > 2000) throw new ValidationError('description must be 2000 characters or fewer.');
    if (input.displayOrder !== undefined && (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)) {
      throw new ValidationError('displayOrder must be an integer >= 0.');
    }
    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadTypeForComponentWrite(tx, ctx.tenantId, caseTypeId);
      const component = await tx.caseTypeComponent.findFirst({ where: { id: componentId, tenantId: ctx.tenantId, caseTypeId: type.id } });
      if (!component) throw new ResourceNotFoundError();

      const nextName = input.name !== undefined ? input.name.trim() : component.name;
      const nextActive = input.isActive !== undefined ? input.isActive : component.isActive;
      // A rename or a reactivation must not collide with another active component's name.
      if (nextActive && (input.name !== undefined || (input.isActive === true && !component.isActive))) {
        await this.assertNoDuplicateActiveName(tx, ctx.tenantId, type.id, nextName, component.id);
      }

      const updated = await tx.caseTypeComponent.update({
        where: { id: component.id },
        data: {
          ...(input.name !== undefined ? { name: nextName } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isMandatory !== undefined ? { isMandatory: input.isMandatory } : {}),
          ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_COMPONENT_UPDATED', 'CaseTypeComponent', component.id, 'UPDATE', { caseTypeId: type.id }, { name: component.name, isActive: component.isActive }));
      return updated;
    }, TX_OPTS);
  }

  /** Loads a case type for a component write and rejects archived/soft-deleted ones (422). */
  private async loadTypeForComponentWrite(tx: Prisma.TransactionClient, tenantId: string, caseTypeId: string): Promise<CaseType> {
    const type = await this.loadType(tx, tenantId, caseTypeId);
    if (type.status === CaseTypeStatus.ARCHIVED || type.deletedAt) {
      throw new BusinessRuleViolationError('Components cannot be configured on an archived case type.');
    }
    return type;
  }

  /** Serializes duplicate-name checks on the parent CaseType row (no partial unique index). */
  private async assertNoDuplicateActiveName(
    tx: Prisma.TransactionClient,
    tenantId: string,
    caseTypeId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "CaseType" WHERE id = ${caseTypeId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    const clash = await tx.caseTypeComponent.findFirst({
      where: {
        tenantId,
        caseTypeId,
        name,
        isActive: true,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new DuplicateResourceError(`An active component named "${name}" already exists on this case type.`);
  }

  // ─── Component documents (the preset lines a component requires) ─────────────
  async listComponentDocuments(
    ctx: UserContext,
    caseTypeId: string,
    componentId: string,
    includeInactive = false,
  ): Promise<CaseTypeComponentDocument[]> {
    // Readable even for archived/inactive types and components, so a case that
    // retains an archived policy can still render what it requires.
    await this.loadType(this.prisma, ctx.tenantId, caseTypeId);
    const component = await this.prisma.caseTypeComponent.findFirst({ where: { id: componentId, tenantId: ctx.tenantId, caseTypeId } });
    if (!component) throw new ResourceNotFoundError();
    return this.prisma.caseTypeComponentDocument.findMany({
      where: {
        tenantId: ctx.tenantId,
        componentId,
        ...(includeInactive ? {} : { isActive: true, deletedAt: null }),
      },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createComponentDocument(
    ctx: UserContext,
    caseTypeId: string,
    componentId: string,
    input: { name?: string; dedupeKey?: string; description?: string | null; isMandatory?: boolean; displayOrder?: number },
  ): Promise<CaseTypeComponentDocument> {
    const name = (input.name ?? '').trim();
    if (!name || name.length > 200) throw new ValidationError('name is required and must be 200 characters or fewer.');
    if (input.description != null && input.description.length > 2000) throw new ValidationError('description must be 2000 characters or fewer.');
    if (input.displayOrder !== undefined && (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)) {
      throw new ValidationError('displayOrder must be an integer >= 0.');
    }
    if (input.isMandatory !== undefined && typeof input.isMandatory !== 'boolean') throw new ValidationError('isMandatory must be a boolean.');
    // An explicitly supplied key is normalized too, so it can never diverge from
    // the form the merge lookup uses.
    const dedupeKey = normalizeDedupeKey(input.dedupeKey !== undefined ? input.dedupeKey : name);
    if (!dedupeKey) throw new ValidationError('Document name cannot be empty or whitespace only.');

    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadTypeForComponentWrite(tx, ctx.tenantId, caseTypeId);
      const component = await this.loadComponentForWrite(tx, ctx.tenantId, type.id, componentId);
      await this.assertNoDuplicateActiveDedupeKey(tx, ctx.tenantId, component.id, dedupeKey);
      const doc = await tx.caseTypeComponentDocument.create({
        data: {
          tenantId: ctx.tenantId,
          caseTypeId: type.id,
          componentId: component.id,
          name,
          dedupeKey,
          description: input.description ?? null,
          isMandatory: input.isMandatory ?? false,
          displayOrder: input.displayOrder ?? 0,
        },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_COMPONENT_DOCUMENT_CREATED', 'CaseTypeComponentDocument', doc.id, 'CREATE', { caseTypeId: type.id, componentId: component.id, dedupeKey }));
      return doc;
    }, TX_OPTS);
  }

  async updateComponentDocument(
    ctx: UserContext,
    caseTypeId: string,
    componentId: string,
    componentDocumentId: string,
    input: { name?: string; description?: string | null; isMandatory?: boolean; displayOrder?: number; isActive?: boolean; dedupeKey?: string },
  ): Promise<CaseTypeComponentDocument> {
    // dedupeKey is the merge identity: changing it would silently re-partition
    // existing shared requirements, so it is rejected outright, never ignored.
    if (Object.prototype.hasOwnProperty.call(input, 'dedupeKey')) throw new ValidationError('dedupeKey is immutable.');
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed || trimmed.length > 200) throw new ValidationError('name is required and must be 200 characters or fewer.');
      if (!normalizeDedupeKey(trimmed)) throw new ValidationError('Document name cannot be empty or whitespace only.');
    }
    if (input.description != null && input.description.length > 2000) throw new ValidationError('description must be 2000 characters or fewer.');
    if (input.displayOrder !== undefined && (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)) {
      throw new ValidationError('displayOrder must be an integer >= 0.');
    }
    if (input.isMandatory !== undefined && typeof input.isMandatory !== 'boolean') throw new ValidationError('isMandatory must be a boolean.');

    return this.prisma.$transaction(async (tx) => {
      const type = await this.loadTypeForComponentWrite(tx, ctx.tenantId, caseTypeId);
      const component = await this.loadComponentForWrite(tx, ctx.tenantId, type.id, componentId);
      const doc = await tx.caseTypeComponentDocument.findFirst({ where: { id: componentDocumentId, tenantId: ctx.tenantId, componentId: component.id } });
      if (!doc) throw new ResourceNotFoundError();

      // Reactivating must not collide with another active line. A rename never
      // touches dedupeKey, so a rename alone can never collide.
      if (input.isActive === true && !doc.isActive) {
        await this.assertNoDuplicateActiveDedupeKey(tx, ctx.tenantId, component.id, doc.dedupeKey, doc.id);
      }

      const updated = await tx.caseTypeComponentDocument.update({
        where: { id: doc.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isMandatory !== undefined ? { isMandatory: input.isMandatory } : {}),
          ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TYPE_COMPONENT_DOCUMENT_UPDATED', 'CaseTypeComponentDocument', doc.id, 'UPDATE', { caseTypeId: type.id, componentId: component.id }, { name: doc.name, isActive: doc.isActive }));
      return updated;
    }, TX_OPTS);
  }

  /** Loads a component for a document write; rejects inactive/soft-deleted ones (422). */
  private async loadComponentForWrite(
    tx: Prisma.TransactionClient,
    tenantId: string,
    caseTypeId: string,
    componentId: string,
  ): Promise<CaseTypeComponent> {
    const component = await tx.caseTypeComponent.findFirst({ where: { id: componentId, tenantId, caseTypeId } });
    if (!component) throw new ResourceNotFoundError();
    if (!component.isActive || component.deletedAt) {
      throw new BusinessRuleViolationError('Documents cannot be configured on an archived component.');
    }
    return component;
  }

  /** Serializes duplicate dedupeKey checks on the parent component row (no partial unique index). */
  private async assertNoDuplicateActiveDedupeKey(
    tx: Prisma.TransactionClient,
    tenantId: string,
    componentId: string,
    dedupeKey: string,
    excludeId?: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "CaseTypeComponent" WHERE id = ${componentId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    const clash = await tx.caseTypeComponentDocument.findFirst({
      where: {
        tenantId,
        componentId,
        dedupeKey,
        isActive: true,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new DuplicateResourceError(`An active document with key "${dedupeKey}" already exists on this component.`);
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

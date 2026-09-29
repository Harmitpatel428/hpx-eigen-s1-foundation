import {
  PrismaClient,
  Prisma,
  CaseFieldStatus,
  CaseFieldType,
  CaseFieldConditionOperator,
  CaseFieldRuleEffectType,
  CaseFieldDefinition,
  CaseFieldOption,
  CaseFieldRule,
} from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ValidationError,
  ResourceNotFoundError,
  DuplicateResourceError,
  BusinessRuleViolationError,
} from '../types/exceptions';
import {
  isSelectType,
  validateValidationRules,
  validateVisibility,
  operatorAllowedForType,
  validateScalarConditionValue,
  assertNoOptionCycle,
} from './case-field.validation';

export interface UserContext {
  tenantId: string;
  userId: string;
  actorIp?: string;
  actorUserAgent?: string;
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const TX_OPTS = { maxWait: 5000, timeout: 15000 };

/** A field is frozen (definition edits blocked) once READ_ONLY or ARCHIVED. */
function isFrozen(status: CaseFieldStatus): boolean {
  return status === CaseFieldStatus.READ_ONLY || status === CaseFieldStatus.ARCHIVED;
}

function mapP2002(err: unknown, message: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new DuplicateResourceError(message);
  }
  throw err;
}

export class CaseFieldService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  // ═══════════════════════ FIELD DEFINITIONS ═══════════════════════

  async listFields(ctx: UserContext, includeArchived = false): Promise<CaseFieldDefinition[]> {
    return this.prisma.caseFieldDefinition.findMany({
      where: { tenantId: ctx.tenantId, ...(includeArchived ? {} : { deletedAt: null }) },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async getField(ctx: UserContext, id: string): Promise<CaseFieldDefinition> {
    return this.loadField(this.prisma, ctx.tenantId, id);
  }

  private async loadField(
    client: PrismaClient | Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<CaseFieldDefinition> {
    // tenantId in the filter makes cross-tenant access a 404.
    const row = await client.caseFieldDefinition.findFirst({ where: { id, tenantId } });
    if (!row) throw new ResourceNotFoundError();
    return row;
  }

  async createField(
    ctx: UserContext,
    input: {
      key?: string;
      name?: string;
      description?: string | null;
      type?: string;
      owningDepartmentId?: string;
      validationRules?: unknown;
      visibility?: unknown;
      reportable?: boolean;
      filterable?: boolean;
      sortable?: boolean;
      displayOrder?: number;
    },
  ): Promise<CaseFieldDefinition> {
    const key = (input.key ?? '').trim();
    const name = (input.name ?? '').trim();
    if (!KEY_RE.test(key) || key.length > 64) {
      throw new ValidationError('key must be lowercase snake_case (start with a letter), 64 chars max.');
    }
    if (!name || name.length > 200) throw new ValidationError('name is required and must be 200 characters or fewer.');
    const type = input.type as CaseFieldType;
    if (!Object.values(CaseFieldType).includes(type)) throw new ValidationError('type is not a valid case field type.');
    if (!input.owningDepartmentId) throw new ValidationError('owningDepartmentId is required.');

    const rules = input.validationRules ?? {};
    const visibility = input.visibility ?? {};
    validateValidationRules(type, rules);
    validateVisibility(visibility);

    // owningDepartment must belong to the same tenant.
    const dept = await this.prisma.department.findFirst({
      where: { id: input.owningDepartmentId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!dept) throw new ValidationError('owningDepartmentId does not reference a department in this organization.');

    const existing = await this.prisma.caseFieldDefinition.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key } },
    });
    if (existing) throw new DuplicateResourceError(`A case field with key "${key}" already exists.`);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const field = await tx.caseFieldDefinition.create({
          data: {
            tenantId: ctx.tenantId,
            key,
            name,
            description: input.description ?? null,
            type,
            status: CaseFieldStatus.DRAFT,
            owningDepartmentId: input.owningDepartmentId!,
            validationRules: rules as Prisma.InputJsonValue,
            visibility: visibility as Prisma.InputJsonValue,
            reportable: input.reportable ?? false,
            filterable: input.filterable ?? false,
            sortable: input.sortable ?? false,
            displayOrder: input.displayOrder ?? 0,
          },
        });
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId,
          eventType: 'CASE_FIELD_CREATED',
          entityType: 'CaseFieldDefinition',
          entityId: field.id,
          actorUserId: ctx.userId,
          actorIp: ctx.actorIp,
          actorUserAgent: ctx.actorUserAgent,
          operation: 'CREATE',
          payload: { key, name, type },
          afterState: { status: field.status },
        });
        return field;
      }, TX_OPTS);
    } catch (err) {
      mapP2002(err, `A case field with key "${key}" already exists.`);
    }
  }

  async updateField(
    ctx: UserContext,
    id: string,
    input: {
      key?: string;
      type?: string;
      name?: string;
      description?: string | null;
      validationRules?: unknown;
      visibility?: unknown;
      reportable?: boolean;
      filterable?: boolean;
      sortable?: boolean;
      isActive?: boolean;
      displayOrder?: number;
    },
  ): Promise<CaseFieldDefinition> {
    return this.prisma.$transaction(async (tx) => {
      const field = await this.loadField(tx, ctx.tenantId, id);
      if (isFrozen(field.status)) {
        throw new BusinessRuleViolationError(`A ${field.status} field cannot be edited.`);
      }
      // key and type are immutable.
      if (input.key !== undefined && input.key.trim() !== field.key) {
        throw new ValidationError('key is immutable and cannot be changed.');
      }
      if (input.type !== undefined && input.type !== field.type) {
        throw new ValidationError('type is immutable and cannot be changed.');
      }
      if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 200)) {
        throw new ValidationError('name is required and must be 200 characters or fewer.');
      }
      if (input.validationRules !== undefined) validateValidationRules(field.type, input.validationRules);
      if (input.visibility !== undefined) validateVisibility(input.visibility);

      const data: Prisma.CaseFieldDefinitionUpdateInput = {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.validationRules !== undefined ? { validationRules: input.validationRules as Prisma.InputJsonValue } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility as Prisma.InputJsonValue } : {}),
        ...(input.reportable !== undefined ? { reportable: input.reportable } : {}),
        ...(input.filterable !== undefined ? { filterable: input.filterable } : {}),
        ...(input.sortable !== undefined ? { sortable: input.sortable } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      };
      const updated = await tx.caseFieldDefinition.update({ where: { id }, data });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_UPDATED',
        entityType: 'CaseFieldDefinition',
        entityId: id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: data as Prisma.JsonObject,
        beforeState: { name: field.name, status: field.status },
      });
      return updated;
    }, TX_OPTS);
  }

  /** DRAFT -> ACTIVE (sets isActive=true). */
  async activateField(ctx: UserContext, id: string): Promise<CaseFieldDefinition> {
    return this.transitionField(ctx, id, {
      from: [CaseFieldStatus.DRAFT],
      to: CaseFieldStatus.ACTIVE,
      isActive: true,
      eventType: 'CASE_FIELD_ACTIVATED',
      illegal: 'Only a DRAFT field can be activated.',
    });
  }

  /** ACTIVE -> READ_ONLY. */
  async setFieldReadOnly(ctx: UserContext, id: string): Promise<CaseFieldDefinition> {
    return this.transitionField(ctx, id, {
      from: [CaseFieldStatus.ACTIVE],
      to: CaseFieldStatus.READ_ONLY,
      eventType: 'CASE_FIELD_SET_READ_ONLY',
      illegal: 'Only an ACTIVE field can be set read-only.',
    });
  }

  /** {DRAFT,ACTIVE,READ_ONLY} -> ARCHIVED (sets deletedAt, isActive=false). Blocked if referenced by an active rule. */
  async archiveField(ctx: UserContext, id: string): Promise<CaseFieldDefinition> {
    return this.prisma.$transaction(async (tx) => {
      const field = await this.loadField(tx, ctx.tenantId, id);
      if (field.status === CaseFieldStatus.ARCHIVED) {
        throw new BusinessRuleViolationError('Field is already archived.');
      }
      const ruleRefs = await tx.caseFieldRule.count({
        where: {
          tenantId: ctx.tenantId,
          deletedAt: null,
          OR: [{ conditionFieldId: id }, { targetFieldId: id }],
        },
      });
      if (ruleRefs > 0) {
        throw new BusinessRuleViolationError('Field is referenced by an active rule; archive or remove those rules first.');
      }
      const updated = await tx.caseFieldDefinition.update({
        where: { id },
        data: { status: CaseFieldStatus.ARCHIVED, isActive: false, deletedAt: new Date() },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_ARCHIVED',
        entityType: 'CaseFieldDefinition',
        entityId: id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: { status: CaseFieldStatus.ARCHIVED },
        beforeState: { status: field.status },
      });
      return updated;
    }, TX_OPTS);
  }

  /** Hard delete — only a DRAFT field with no options and no rule references. */
  async hardDeleteField(ctx: UserContext, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const field = await this.loadField(tx, ctx.tenantId, id);
      if (field.status !== CaseFieldStatus.DRAFT) {
        throw new BusinessRuleViolationError('Only a DRAFT field can be hard-deleted; archive it instead.');
      }
      const optionCount = await tx.caseFieldOption.count({ where: { fieldId: id } });
      const ruleCount = await tx.caseFieldRule.count({
        where: { OR: [{ conditionFieldId: id }, { targetFieldId: id }] },
      });
      // ponytail: no case-values table yet — the future "no values" precondition goes here.
      if (optionCount > 0 || ruleCount > 0) {
        throw new BusinessRuleViolationError('Field is in use (options or rules exist); archive it instead.');
      }
      await tx.caseFieldDefinition.delete({ where: { id } });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_DELETED',
        entityType: 'CaseFieldDefinition',
        entityId: id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'DELETE',
        payload: { key: field.key },
        beforeState: { status: field.status },
      });
    }, TX_OPTS);
  }

  private async transitionField(
    ctx: UserContext,
    id: string,
    spec: { from: CaseFieldStatus[]; to: CaseFieldStatus; isActive?: boolean; eventType: string; illegal: string },
  ): Promise<CaseFieldDefinition> {
    return this.prisma.$transaction(async (tx) => {
      const field = await this.loadField(tx, ctx.tenantId, id);
      if (!spec.from.includes(field.status)) {
        throw new BusinessRuleViolationError(spec.illegal);
      }
      const updated = await tx.caseFieldDefinition.update({
        where: { id },
        data: { status: spec.to, ...(spec.isActive !== undefined ? { isActive: spec.isActive } : {}) },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: spec.eventType,
        entityType: 'CaseFieldDefinition',
        entityId: id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: { status: spec.to },
        beforeState: { status: field.status },
      });
      return updated;
    }, TX_OPTS);
  }

  // ═══════════════════════ FIELD OPTIONS ═══════════════════════════

  async listOptions(ctx: UserContext, fieldId: string, includeArchived = false): Promise<CaseFieldOption[]> {
    await this.loadField(this.prisma, ctx.tenantId, fieldId); // 404 if cross-tenant / missing
    return this.prisma.caseFieldOption.findMany({
      where: { tenantId: ctx.tenantId, fieldId, ...(includeArchived ? {} : { deletedAt: null }) },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createOption(
    ctx: UserContext,
    fieldId: string,
    input: { key?: string; label?: string; displayOrder?: number; parentOptionId?: string | null },
  ): Promise<CaseFieldOption> {
    const key = (input.key ?? '').trim();
    const label = (input.label ?? '').trim();
    if (!KEY_RE.test(key) || key.length > 64) {
      throw new ValidationError('key must be lowercase snake_case (start with a letter), 64 chars max.');
    }
    if (!label || label.length > 200) throw new ValidationError('label is required and must be 200 characters or fewer.');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const field = await this.loadField(tx, ctx.tenantId, fieldId);
        if (isFrozen(field.status)) {
          throw new BusinessRuleViolationError(`Options cannot be added to a ${field.status} field.`);
        }
        if (!isSelectType(field.type)) {
          throw new BusinessRuleViolationError('Options are only allowed on SELECT and MULTI_SELECT fields.');
        }
        if (input.parentOptionId) {
          await this.assertValidParent(tx, ctx.tenantId, fieldId, null, input.parentOptionId);
        }
        const option = await tx.caseFieldOption.create({
          data: {
            tenantId: ctx.tenantId,
            fieldId,
            key,
            label,
            displayOrder: input.displayOrder ?? 0,
            parentOptionId: input.parentOptionId ?? null,
          },
        });
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId,
          eventType: 'CASE_FIELD_OPTION_CREATED',
          entityType: 'CaseFieldOption',
          entityId: option.id,
          actorUserId: ctx.userId,
          actorIp: ctx.actorIp,
          actorUserAgent: ctx.actorUserAgent,
          operation: 'CREATE',
          payload: { fieldId, key, label },
        });
        return option;
      }, TX_OPTS);
    } catch (err) {
      mapP2002(err, `An option with key "${key}" already exists on this field.`);
    }
  }

  async updateOption(
    ctx: UserContext,
    fieldId: string,
    optionId: string,
    input: { key?: string; label?: string; displayOrder?: number; isActive?: boolean; parentOptionId?: string | null },
  ): Promise<CaseFieldOption> {
    return this.prisma.$transaction(async (tx) => {
      const field = await this.loadField(tx, ctx.tenantId, fieldId);
      if (isFrozen(field.status)) {
        throw new BusinessRuleViolationError(`Options cannot be edited on a ${field.status} field.`);
      }
      const option = await tx.caseFieldOption.findFirst({ where: { id: optionId, tenantId: ctx.tenantId, fieldId } });
      if (!option) throw new ResourceNotFoundError();
      if (input.key !== undefined && input.key.trim() !== option.key) {
        throw new ValidationError('option key is immutable and cannot be changed.');
      }
      if (input.label !== undefined && (!input.label.trim() || input.label.trim().length > 200)) {
        throw new ValidationError('label is required and must be 200 characters or fewer.');
      }
      if (input.parentOptionId !== undefined && input.parentOptionId !== null) {
        await this.assertValidParent(tx, ctx.tenantId, fieldId, optionId, input.parentOptionId);
      }
      const data: Prisma.CaseFieldOptionUpdateInput = {
        ...(input.label !== undefined ? { label: input.label.trim() } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.parentOptionId !== undefined
          ? { parentOption: input.parentOptionId ? { connect: { id: input.parentOptionId } } : { disconnect: true } }
          : {}),
      };
      const updated = await tx.caseFieldOption.update({ where: { id: optionId }, data });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_OPTION_UPDATED',
        entityType: 'CaseFieldOption',
        entityId: optionId,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: { fieldId },
        beforeState: { label: option.label, isActive: option.isActive },
      });
      return updated;
    }, TX_OPTS);
  }

  async archiveOption(ctx: UserContext, fieldId: string, optionId: string): Promise<CaseFieldOption> {
    return this.prisma.$transaction(async (tx) => {
      await this.loadField(tx, ctx.tenantId, fieldId);
      const option = await tx.caseFieldOption.findFirst({ where: { id: optionId, tenantId: ctx.tenantId, fieldId } });
      if (!option) throw new ResourceNotFoundError();
      if (option.deletedAt) throw new BusinessRuleViolationError('Option is already archived.');
      const ruleRefs = await tx.caseFieldRule.count({
        where: { tenantId: ctx.tenantId, deletedAt: null, conditionOptionId: optionId },
      });
      if (ruleRefs > 0) {
        throw new BusinessRuleViolationError('Option is referenced by an active rule; archive or remove those rules first.');
      }
      const updated = await tx.caseFieldOption.update({
        where: { id: optionId },
        data: { isActive: false, deletedAt: new Date() },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_OPTION_ARCHIVED',
        entityType: 'CaseFieldOption',
        entityId: optionId,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: { fieldId },
        beforeState: { isActive: option.isActive },
      });
      return updated;
    }, TX_OPTS);
  }

  /** Validates a proposed parentOptionId: same field, same tenant, not archived, no cycle. */
  private async assertValidParent(
    tx: Prisma.TransactionClient,
    tenantId: string,
    fieldId: string,
    optionId: string | null,
    parentOptionId: string,
  ): Promise<void> {
    const parent = await tx.caseFieldOption.findFirst({
      where: { id: parentOptionId, tenantId, fieldId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      throw new ValidationError('parentOptionId must reference an active option on the same field.');
    }
    const all = await tx.caseFieldOption.findMany({
      where: { tenantId, fieldId },
      select: { id: true, parentOptionId: true },
    });
    const parents = new Map<string, string | null>(all.map((o) => [o.id, o.parentOptionId]));
    assertNoOptionCycle(optionId, parentOptionId, parents);
  }

  // ═══════════════════════ RULES ═══════════════════════════════════

  async listRules(ctx: UserContext, includeArchived = false): Promise<CaseFieldRule[]> {
    return this.prisma.caseFieldRule.findMany({
      where: { tenantId: ctx.tenantId, ...(includeArchived ? {} : { deletedAt: null }) },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async getRule(ctx: UserContext, id: string): Promise<CaseFieldRule> {
    const row = await this.prisma.caseFieldRule.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!row) throw new ResourceNotFoundError();
    return row;
  }

  async createRule(
    ctx: UserContext,
    input: {
      name?: string;
      description?: string | null;
      priority?: number;
      conditionFieldId?: string;
      conditionOperator?: string;
      conditionValue?: unknown;
      conditionOptionId?: string | null;
      effectType?: string;
      targetFieldId?: string;
    },
  ): Promise<CaseFieldRule> {
    const name = (input.name ?? '').trim();
    if (!name || name.length > 200) throw new ValidationError('name is required and must be 200 characters or fewer.');

    return this.prisma.$transaction(async (tx) => {
      const resolved = await this.validateRuleInput(tx, ctx.tenantId, input);
      const rule = await tx.caseFieldRule.create({
        data: {
          tenantId: ctx.tenantId,
          name,
          description: input.description ?? null,
          priority: input.priority ?? 0,
          conditionFieldId: resolved.conditionFieldId,
          conditionOperator: resolved.conditionOperator,
          conditionValue: resolved.conditionValue as Prisma.InputJsonValue,
          conditionOptionId: resolved.conditionOptionId,
          effectType: CaseFieldRuleEffectType.REQUIRE_FIELD,
          targetFieldId: resolved.targetFieldId,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_RULE_CREATED',
        entityType: 'CaseFieldRule',
        entityId: rule.id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'CREATE',
        payload: { name, conditionFieldId: resolved.conditionFieldId, targetFieldId: resolved.targetFieldId },
      });
      return rule;
    }, TX_OPTS);
  }

  async updateRule(
    ctx: UserContext,
    id: string,
    input: {
      name?: string;
      description?: string | null;
      isActive?: boolean;
      priority?: number;
      conditionFieldId?: string;
      conditionOperator?: string;
      conditionValue?: unknown;
      conditionOptionId?: string | null;
      effectType?: string;
      targetFieldId?: string;
    },
  ): Promise<CaseFieldRule> {
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.caseFieldRule.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!rule) throw new ResourceNotFoundError();
      if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 200)) {
        throw new ValidationError('name is required and must be 200 characters or fewer.');
      }
      // Revalidate the full condition/target set against merged values.
      const merged = {
        conditionFieldId: input.conditionFieldId ?? rule.conditionFieldId,
        conditionOperator: input.conditionOperator ?? rule.conditionOperator,
        conditionValue: input.conditionValue !== undefined ? input.conditionValue : rule.conditionValue,
        conditionOptionId: input.conditionOptionId !== undefined ? input.conditionOptionId : rule.conditionOptionId,
        effectType: input.effectType ?? rule.effectType,
        targetFieldId: input.targetFieldId ?? rule.targetFieldId,
      };
      const resolved = await this.validateRuleInput(tx, ctx.tenantId, merged);
      const updated = await tx.caseFieldRule.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          conditionFieldId: resolved.conditionFieldId,
          conditionOperator: resolved.conditionOperator,
          conditionValue: resolved.conditionValue as Prisma.InputJsonValue,
          conditionOptionId: resolved.conditionOptionId,
          effectType: CaseFieldRuleEffectType.REQUIRE_FIELD,
          targetFieldId: resolved.targetFieldId,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_RULE_UPDATED',
        entityType: 'CaseFieldRule',
        entityId: id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: { conditionFieldId: resolved.conditionFieldId, targetFieldId: resolved.targetFieldId },
        beforeState: { name: rule.name, isActive: rule.isActive },
      });
      return updated;
    }, TX_OPTS);
  }

  async archiveRule(ctx: UserContext, id: string): Promise<CaseFieldRule> {
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.caseFieldRule.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!rule) throw new ResourceNotFoundError();
      if (rule.deletedAt) throw new BusinessRuleViolationError('Rule is already archived.');
      const updated = await tx.caseFieldRule.update({
        where: { id },
        data: { isActive: false, deletedAt: new Date() },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_RULE_ARCHIVED',
        entityType: 'CaseFieldRule',
        entityId: id,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: {},
        beforeState: { isActive: rule.isActive },
      });
      return updated;
    }, TX_OPTS);
  }

  /**
   * Validates a rule's condition/target against tenant state. Returns the resolved,
   * type-checked values. Cross-tenant / missing fields -> 404; everything else -> 400/422.
   */
  private async validateRuleInput(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      conditionFieldId?: string;
      conditionOperator?: string | CaseFieldConditionOperator;
      conditionValue?: unknown;
      conditionOptionId?: string | null;
      effectType?: string | CaseFieldRuleEffectType;
      targetFieldId?: string;
    },
  ): Promise<{
    conditionFieldId: string;
    conditionOperator: CaseFieldConditionOperator;
    conditionValue: unknown;
    conditionOptionId: string | null;
    targetFieldId: string;
  }> {
    if (input.effectType !== undefined && input.effectType !== CaseFieldRuleEffectType.REQUIRE_FIELD) {
      throw new ValidationError('effectType must be REQUIRE_FIELD.');
    }
    if (!input.conditionFieldId || !input.targetFieldId) {
      throw new ValidationError('conditionFieldId and targetFieldId are required.');
    }
    if (input.conditionFieldId === input.targetFieldId) {
      throw new BusinessRuleViolationError('A rule cannot reference the same field as both condition and target.');
    }
    const operator = input.conditionOperator as CaseFieldConditionOperator;
    if (!Object.values(CaseFieldConditionOperator).includes(operator)) {
      throw new ValidationError('conditionOperator is not a valid operator.');
    }

    // Both fields must exist in this tenant (else 404) and be neither ARCHIVED nor READ_ONLY.
    const conditionField = await tx.caseFieldDefinition.findFirst({ where: { id: input.conditionFieldId, tenantId } });
    if (!conditionField) throw new ResourceNotFoundError();
    const targetField = await tx.caseFieldDefinition.findFirst({ where: { id: input.targetFieldId, tenantId } });
    if (!targetField) throw new ResourceNotFoundError();
    for (const [field, label] of [[conditionField, 'condition'], [targetField, 'target']] as const) {
      if (field.status === CaseFieldStatus.ARCHIVED || field.status === CaseFieldStatus.READ_ONLY) {
        throw new BusinessRuleViolationError(`The ${label} field is ${field.status} and cannot be used in a rule.`);
      }
    }

    if (!operatorAllowedForType(conditionField.type, operator)) {
      throw new ValidationError(`Operator ${operator} is not compatible with a ${conditionField.type} field.`);
    }

    const O = CaseFieldConditionOperator;
    let conditionValue: unknown = null;
    let conditionOptionId: string | null = null;

    if (operator === O.IS_EMPTY || operator === O.IS_NOT_EMPTY) {
      // presence check — no value, no option
      conditionValue = null;
      conditionOptionId = null;
    } else if (conditionField.type === CaseFieldType.SELECT) {
      // EQUALS / NOT_EQUALS on a single-select → conditionOptionId
      if (!input.conditionOptionId) {
        throw new ValidationError('conditionOptionId is required for a SELECT equality condition.');
      }
      await this.assertOptionBelongs(tx, tenantId, conditionField.id, input.conditionOptionId);
      conditionOptionId = input.conditionOptionId;
      conditionValue = null;
    } else if (conditionField.type === CaseFieldType.MULTI_SELECT) {
      // IN / NOT_IN → array of option ids
      const arr = input.conditionValue;
      if (!Array.isArray(arr) || arr.length === 0 || !arr.every((v) => typeof v === 'string')) {
        throw new ValidationError('conditionValue must be a non-empty array of option ids for a MULTI_SELECT condition.');
      }
      for (const optId of arr as string[]) {
        await this.assertOptionBelongs(tx, tenantId, conditionField.id, optId);
      }
      conditionValue = arr;
      conditionOptionId = null;
    } else {
      // scalar operators on all other types
      validateScalarConditionValue(conditionField.type, input.conditionValue);
      conditionValue = input.conditionValue;
      conditionOptionId = null;
    }

    return {
      conditionFieldId: conditionField.id,
      conditionOperator: operator,
      conditionValue,
      conditionOptionId,
      targetFieldId: targetField.id,
    };
  }

  private async assertOptionBelongs(
    tx: Prisma.TransactionClient,
    tenantId: string,
    fieldId: string,
    optionId: string,
  ): Promise<void> {
    const opt = await tx.caseFieldOption.findFirst({
      where: { id: optionId, tenantId, fieldId, deletedAt: null },
      select: { id: true },
    });
    if (!opt) throw new ValidationError('conditionOptionId must reference an active option on the condition field.');
  }
}

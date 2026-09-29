import {
  PrismaClient,
  Prisma,
  CaseFieldStatus,
  CaseFieldDefinition,
} from '@prisma/client';
import { AuditService } from './audit.service';
import {
  ValidationError,
  ResourceNotFoundError,
  BusinessRuleViolationError,
  OptimisticLockError,
} from '../types/exceptions';
import {
  coerceValue,
  conditionMet,
  isPresent,
  isMultiSelect,
  isSingleSelect,
  StoredValue,
  TypedValue,
} from './case-field-value.validation';

export interface UserContext {
  tenantId: string;
  userId: string;
  actorIp?: string;
  actorUserAgent?: string;
}

const TX_OPTS = { maxWait: 5000, timeout: 15000 };

export interface PatchEntry {
  fieldId: string;
  value?: unknown;
  optionId?: string | null;
  optionIds?: string[];
  version?: number;
}

export class CaseFieldValueService {
  private readonly audit: AuditService;
  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Cross-tenant / missing / deleted case → 404. */
  private async loadCase(
    client: PrismaClient | Prisma.TransactionClient,
    tenantId: string,
    caseId: string,
  ): Promise<{ id: string }> {
    const row = await client.docCase.findFirst({
      where: { id: caseId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new ResourceNotFoundError();
    return row;
  }

  private toStored(v: {
    valueText: string | null; valueNumber: Prisma.Decimal | null; valueBoolean: boolean | null;
    valueDate: Date | null; optionId: string | null; selections: { optionId: string }[];
    field: { type: CaseFieldDefinition['type'] };
  }): StoredValue {
    return {
      fieldType: v.field.type,
      valueText: v.valueText,
      valueNumber: v.valueNumber != null ? Number(v.valueNumber) : null,
      valueBoolean: v.valueBoolean,
      valueDate: v.valueDate,
      optionId: v.optionId,
      optionIds: v.selections.map((s) => s.optionId),
    };
  }

  // ─── GET /cases/:caseId/field-values ────────────────────────────
  // Type-aware (Phase 4): a typed case returns ONLY its placed fields;
  // an untyped case returns the tenant-global ACTIVE/READ_ONLY catalog.
  async getValues(ctx: UserContext, caseId: string) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, caseTypeId: true },
    });
    if (!docCase) throw new ResourceNotFoundError();

    const values = await this.prisma.caseFieldValue.findMany({
      where: { tenantId: ctx.tenantId, caseId, deletedAt: null },
      include: { selections: { select: { optionId: true } } },
    });

    if (docCase.caseTypeId) {
      const placements = await this.prisma.caseTypeFieldPlacement.findMany({
        where: {
          tenantId: ctx.tenantId,
          caseTypeId: docCase.caseTypeId,
          field: { deletedAt: null, status: { in: [CaseFieldStatus.ACTIVE, CaseFieldStatus.READ_ONLY] } },
        },
        include: { field: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      });
      return { fields: placements.map((p) => p.field), values };
    }

    const fields = await this.prisma.caseFieldDefinition.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, status: { in: [CaseFieldStatus.ACTIVE, CaseFieldStatus.READ_ONLY] } },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { fields, values };
  }

  // ─── PATCH /cases/:caseId/field-values ──────────────────────────
  async patchValues(ctx: UserContext, caseId: string, entries: PatchEntry[]) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError('values must be a non-empty array.');
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.fieldId || typeof e.fieldId !== 'string') throw new ValidationError('each entry requires a fieldId.');
      if (seen.has(e.fieldId)) throw new ValidationError(`duplicate fieldId in batch: ${e.fieldId}`);
      seen.add(e.fieldId);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.loadCase(tx, ctx.tenantId, caseId);
      const changedFieldIds: string[] = [];

      for (const entry of entries) {
        const field = await tx.caseFieldDefinition.findFirst({ where: { id: entry.fieldId, tenantId: ctx.tenantId } });
        if (!field) throw new ValidationError(`Unknown field: ${entry.fieldId}`);
        if (field.status === CaseFieldStatus.ARCHIVED) {
          throw new BusinessRuleViolationError(`Field "${field.key}" is archived and cannot accept new values.`);
        }

        const typed: TypedValue = coerceValue(field, entry);

        // Option membership + not-archived / selectable checks (DB-backed).
        if (!typed.isClear && isSingleSelect(field.type) && typed.optionId) {
          await this.assertSelectable(tx, ctx.tenantId, field.id, typed.optionId);
        }
        if (!typed.isClear && isMultiSelect(field.type) && typed.optionIds) {
          for (const oid of typed.optionIds) await this.assertSelectable(tx, ctx.tenantId, field.id, oid);
        }

        const existing = await tx.caseFieldValue.findUnique({
          where: { tenantId_caseId_fieldId: { tenantId: ctx.tenantId, caseId, fieldId: field.id } },
          include: { selections: { select: { optionId: true } } },
        });

        // Optimistic lock: when updating an existing row and a version is supplied, it must match.
        if (existing && entry.version !== undefined && entry.version !== existing.version) {
          throw new OptimisticLockError();
        }

        const before = existing
          ? this.snapshot(this.toStored({ ...existing, field }))
          : null;

        // Build the typed column write (clear zeroes every column).
        const data = {
          valueText: typed.valueText ?? null,
          valueNumber: typed.valueNumber ?? null,
          valueBoolean: typed.valueBoolean ?? null,
          valueDate: typed.valueDate ?? null,
          optionId: typed.optionId ?? null,
        };

        let valueId: string;
        if (existing) {
          const updated = await tx.caseFieldValue.update({
            where: { id: existing.id },
            data: { ...data, version: existing.version + 1, deletedAt: null },
          });
          valueId = updated.id;
        } else {
          const created = await tx.caseFieldValue.create({
            data: { tenantId: ctx.tenantId, caseId, fieldId: field.id, ...data },
          });
          valueId = created.id;
        }

        // MULTI_SELECT child rows: replace wholesale.
        if (isMultiSelect(field.type)) {
          await tx.caseFieldValueOption.deleteMany({ where: { valueId } });
          if (!typed.isClear && typed.optionIds && typed.optionIds.length) {
            await tx.caseFieldValueOption.createMany({
              data: typed.optionIds.map((optionId) => ({ tenantId: ctx.tenantId, valueId, optionId })),
            });
          }
        }

        const after = typed.isClear
          ? null
          : this.snapshot(this.toStored({
              valueText: data.valueText, valueNumber: data.valueNumber as unknown as Prisma.Decimal | null,
              valueBoolean: data.valueBoolean, valueDate: data.valueDate, optionId: data.optionId,
              selections: (typed.optionIds ?? []).map((optionId) => ({ optionId })), field,
            }));

        await tx.caseFieldValueHistory.create({
          data: {
            tenantId: ctx.tenantId,
            caseId,
            fieldId: field.id,
            valueId,
            operation: typed.isClear ? 'CLEAR' : existing ? 'UPDATE' : 'SET',
            beforeValue: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            afterValue: (after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            actorUserId: ctx.userId,
          },
        });
        changedFieldIds.push(field.id);
      }

      // ONE coarse hash-chain audit row for the whole batch.
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'CASE_FIELD_VALUES_UPDATED',
        entityType: 'CaseFieldValue',
        entityId: caseId,
        actorUserId: ctx.userId,
        actorIp: ctx.actorIp,
        actorUserAgent: ctx.actorUserAgent,
        operation: 'UPDATE',
        payload: { caseId, changedFieldIds },
      });

      const values = await tx.caseFieldValue.findMany({
        where: { tenantId: ctx.tenantId, caseId, deletedAt: null },
        include: { selections: { select: { optionId: true } } },
      });
      return { values };
    }, TX_OPTS);
  }

  // ─── POST /cases/:caseId/field-values/validate ──────────────────
  // Type-aware (Phase 4): a typed case evaluates REQUIRE_FIELD rules only within
  // its placed field set — rules whose condition OR target field is not placed
  // are ignored. An untyped case evaluates all tenant rules.
  async validateValues(ctx: UserContext, caseId: string) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, caseTypeId: true },
    });
    if (!docCase) throw new ResourceNotFoundError();

    const [rawValues, rules] = await Promise.all([
      this.prisma.caseFieldValue.findMany({
        where: { tenantId: ctx.tenantId, caseId, deletedAt: null },
        include: { selections: { select: { optionId: true } }, field: { select: { type: true } } },
      }),
      this.prisma.caseFieldRule.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, isActive: true },
      }),
    ]);

    let placedFieldIds: Set<string> | null = null;
    if (docCase.caseTypeId) {
      const placements = await this.prisma.caseTypeFieldPlacement.findMany({
        where: { tenantId: ctx.tenantId, caseTypeId: docCase.caseTypeId },
        select: { fieldId: true },
      });
      placedFieldIds = new Set(placements.map((p) => p.fieldId));
    }

    const stored = new Map<string, StoredValue>();
    for (const v of rawValues) stored.set(v.fieldId, this.toStored(v));

    const missing: Array<{ ruleId: string; targetFieldId: string }> = [];
    for (const rule of rules) {
      // In a typed case, skip rules that reach outside the placed field set.
      if (placedFieldIds && (!placedFieldIds.has(rule.conditionFieldId) || !placedFieldIds.has(rule.targetFieldId))) {
        continue;
      }
      const fires = conditionMet(
        rule.conditionOperator,
        rule.conditionValue,
        rule.conditionOptionId,
        stored.get(rule.conditionFieldId),
      );
      if (fires && !isPresent(stored.get(rule.targetFieldId))) {
        missing.push({ ruleId: rule.id, targetFieldId: rule.targetFieldId });
      }
    }
    return { valid: missing.length === 0, missing };
  }

  // ─── GET /cases/:caseId/field-values/history ────────────────────
  async getHistory(ctx: UserContext, caseId: string) {
    await this.loadCase(this.prisma, ctx.tenantId, caseId);
    return this.prisma.caseFieldValueHistory.findMany({
      where: { tenantId: ctx.tenantId, caseId },
      orderBy: { changedAt: 'desc' },
    });
  }

  /** Option must belong to the field, same tenant, not archived, and selectable (isActive). */
  private async assertSelectable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    fieldId: string,
    optionId: string,
  ): Promise<void> {
    const opt = await tx.caseFieldOption.findFirst({
      where: { id: optionId, tenantId, fieldId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!opt) {
      throw new BusinessRuleViolationError('Selected option is not an active option on this field.');
    }
  }

  private snapshot(s: StoredValue): Prisma.JsonObject {
    return {
      valueText: s.valueText,
      valueNumber: s.valueNumber,
      valueBoolean: s.valueBoolean,
      valueDate: s.valueDate ? s.valueDate.toISOString() : null,
      optionId: s.optionId,
      optionIds: s.optionIds,
    };
  }
}

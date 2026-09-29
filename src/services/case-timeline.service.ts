import {
  PrismaClient,
  Prisma,
  CaseStageStatus,
  CaseTypeStatus,
  CaseTimelineStatus,
  CaseStageTemplate,
  CaseTimeline,
  CaseStage,
} from '@prisma/client';
import { AuditService } from './audit.service';
import { CaseFieldValueService } from './case-field-value.service';
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
const TERMINAL: CaseStageStatus[] = [CaseStageStatus.COMPLETED, CaseStageStatus.SKIPPED];

function mapP2002(err: unknown, message: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new DuplicateResourceError(message);
  throw err;
}

export class CaseTimelineService {
  private readonly audit: AuditService;
  private readonly values: CaseFieldValueService;
  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
    this.values = new CaseFieldValueService(prisma);
  }

  private auditRow(ctx: UserContext, eventType: string, entityType: string, entityId: string, payload: Record<string, unknown>, beforeState?: Record<string, unknown>) {
    return {
      tenantId: ctx.tenantId, eventType, entityType, entityId,
      actorUserId: ctx.userId, actorIp: ctx.actorIp, actorUserAgent: ctx.actorUserAgent,
      operation: 'UPDATE', payload, ...(beforeState ? { beforeState } : {}),
    };
  }

  private async loadType(client: PrismaClient | Prisma.TransactionClient, tenantId: string, caseTypeId: string) {
    const t = await client.caseType.findFirst({ where: { id: caseTypeId, tenantId } });
    if (!t) throw new ResourceNotFoundError();
    return t;
  }

  // ═══════════════════════ STAGE TEMPLATES ═════════════════════════
  async listTemplates(ctx: UserContext, caseTypeId: string, includeArchived = false): Promise<CaseStageTemplate[]> {
    await this.loadType(this.prisma, ctx.tenantId, caseTypeId);
    return this.prisma.caseStageTemplate.findMany({
      where: { tenantId: ctx.tenantId, caseTypeId, ...(includeArchived ? {} : { deletedAt: null }) },
      orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createTemplate(ctx: UserContext, caseTypeId: string, input: any): Promise<CaseStageTemplate> {
    const key = (input.key ?? '').trim();
    const label = (input.label ?? '').trim();
    if (!KEY_RE.test(key) || key.length > 64) throw new ValidationError('key must be lowercase snake_case (start with a letter), 64 chars max.');
    if (!label || label.length > 200) throw new ValidationError('label is required and must be 200 characters or fewer.');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.loadType(tx, ctx.tenantId, caseTypeId);
        const t = await tx.caseStageTemplate.create({
          data: {
            tenantId: ctx.tenantId, caseTypeId, key, label,
            sequence: input.sequence ?? 0,
            durationValue: input.durationValue ?? null,
            durationType: input.durationType ?? null,
            externalWaiting: input.externalWaiting ?? false,
            bufferDays: input.bufferDays ?? null,
            dependsOnPrevious: input.dependsOnPrevious ?? true,
            enforceRequiredOnComplete: input.enforceRequiredOnComplete ?? false,
          },
        });
        await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_STAGE_TEMPLATE_CREATED', 'CaseStageTemplate', t.id, { caseTypeId, key }));
        return t;
      }, TX_OPTS);
    } catch (err) { mapP2002(err, `A stage template with key "${key}" already exists on this case type.`); }
  }

  async updateTemplate(ctx: UserContext, caseTypeId: string, templateId: string, input: any): Promise<CaseStageTemplate> {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.caseStageTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenantId, caseTypeId } });
      if (!t) throw new ResourceNotFoundError();
      if (t.deletedAt) throw new BusinessRuleViolationError('An archived stage template cannot be edited.');
      if (input.key !== undefined && input.key.trim() !== t.key) throw new ValidationError('key is immutable and cannot be changed.');
      if (input.label !== undefined && (!input.label.trim() || input.label.trim().length > 200)) throw new ValidationError('label is required and must be 200 characters or fewer.');
      const data: Prisma.CaseStageTemplateUpdateInput = {
        ...(input.label !== undefined ? { label: input.label.trim() } : {}),
        ...(input.durationValue !== undefined ? { durationValue: input.durationValue } : {}),
        ...(input.durationType !== undefined ? { durationType: input.durationType } : {}),
        ...(input.externalWaiting !== undefined ? { externalWaiting: input.externalWaiting } : {}),
        ...(input.bufferDays !== undefined ? { bufferDays: input.bufferDays } : {}),
        ...(input.dependsOnPrevious !== undefined ? { dependsOnPrevious: input.dependsOnPrevious } : {}),
        ...(input.enforceRequiredOnComplete !== undefined ? { enforceRequiredOnComplete: input.enforceRequiredOnComplete } : {}),
      };
      const updated = await tx.caseStageTemplate.update({ where: { id: templateId }, data });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_STAGE_TEMPLATE_UPDATED', 'CaseStageTemplate', templateId, { caseTypeId }));
      return updated;
    }, TX_OPTS);
  }

  async archiveTemplate(ctx: UserContext, caseTypeId: string, templateId: string): Promise<CaseStageTemplate> {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.caseStageTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenantId, caseTypeId } });
      if (!t) throw new ResourceNotFoundError();
      if (t.deletedAt) throw new BusinessRuleViolationError('Stage template is already archived.');
      const updated = await tx.caseStageTemplate.update({ where: { id: templateId }, data: { deletedAt: new Date() } });
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_STAGE_TEMPLATE_ARCHIVED', 'CaseStageTemplate', templateId, { caseTypeId }));
      return updated;
    }, TX_OPTS);
  }

  /** Reorder: orderedIds sets sequence = array index. All ids must be non-archived templates of the type. */
  async reorderTemplates(ctx: UserContext, caseTypeId: string, orderedIds: string[]): Promise<CaseStageTemplate[]> {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) throw new ValidationError('orderedIds must be a non-empty array.');
    return this.prisma.$transaction(async (tx) => {
      await this.loadType(tx, ctx.tenantId, caseTypeId);
      const existing = await tx.caseStageTemplate.findMany({ where: { tenantId: ctx.tenantId, caseTypeId, deletedAt: null }, select: { id: true } });
      const existingIds = new Set(existing.map((e) => e.id));
      if (orderedIds.length !== existingIds.size || !orderedIds.every((id) => existingIds.has(id))) {
        throw new ValidationError('orderedIds must list exactly the non-archived stage templates of this case type.');
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.caseStageTemplate.update({ where: { id: orderedIds[i] }, data: { sequence: i } });
      }
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_STAGE_TEMPLATE_REORDERED', 'CaseStageTemplate', caseTypeId, { caseTypeId, orderedIds }));
      return tx.caseStageTemplate.findMany({ where: { tenantId: ctx.tenantId, caseTypeId, deletedAt: null }, orderBy: { sequence: 'asc' } });
    }, TX_OPTS);
  }

  // ═══════════════════════ TIMELINE ════════════════════════════════
  private async loadCase(client: PrismaClient | Prisma.TransactionClient, tenantId: string, caseId: string) {
    const c = await client.docCase.findFirst({ where: { id: caseId, tenantId, deletedAt: null }, select: { id: true, caseTypeId: true } });
    if (!c) throw new ResourceNotFoundError();
    return c;
  }

  async getTimeline(ctx: UserContext, caseId: string) {
    await this.loadCase(this.prisma, ctx.tenantId, caseId);
    const timeline = await this.prisma.caseTimeline.findFirst({
      where: { caseId, tenantId: ctx.tenantId },
      include: { stages: { orderBy: { sequence: 'asc' } } },
    });
    return { timeline, stages: timeline?.stages ?? [] };
  }

  async createTimeline(ctx: UserContext, caseId: string) {
    const docCase = await this.loadCase(this.prisma, ctx.tenantId, caseId);
    if (!docCase.caseTypeId) throw new BusinessRuleViolationError('This case has no case type; a timeline cannot be created.');

    return this.prisma.$transaction(async (tx) => {
      const type = await tx.caseType.findFirst({ where: { id: docCase.caseTypeId!, tenantId: ctx.tenantId } });
      if (!type) throw new ResourceNotFoundError();
      if (type.status !== CaseTypeStatus.ACTIVE) throw new BusinessRuleViolationError('The case type is not ACTIVE; a timeline cannot be created.');

      const existing = await tx.caseTimeline.findUnique({ where: { caseId } });
      if (existing) throw new DuplicateResourceError('This case already has a timeline.');

      const templates = await tx.caseStageTemplate.findMany({
        where: { tenantId: ctx.tenantId, caseTypeId: type.id, deletedAt: null },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
      });
      if (templates.length === 0) throw new BusinessRuleViolationError('The case type has no stage templates; a timeline cannot be created.');

      const timeline = await tx.caseTimeline.create({
        data: { tenantId: ctx.tenantId, caseId, caseTypeId: type.id, status: CaseTimelineStatus.ACTIVE },
      });
      await tx.caseStage.createMany({
        data: templates.map((tpl, i) => ({
          tenantId: ctx.tenantId, timelineId: timeline.id, templateId: tpl.id,
          key: tpl.key, label: tpl.label, sequence: i, status: CaseStageStatus.PENDING,
          durationValue: tpl.durationValue, durationType: tpl.durationType,
          externalWaiting: tpl.externalWaiting, bufferDays: tpl.bufferDays,
          dependsOnPrevious: tpl.dependsOnPrevious, enforceRequiredOnComplete: tpl.enforceRequiredOnComplete,
        })),
      });
      await this.recomputeReadiness(tx, timeline.id);
      await this.audit.appendInTx(tx, this.auditRow(ctx, 'CASE_TIMELINE_CREATED', 'CaseTimeline', timeline.id, { caseId, caseTypeId: type.id, stageCount: templates.length }));

      const stages = await tx.caseStage.findMany({ where: { timelineId: timeline.id }, orderBy: { sequence: 'asc' } });
      return { timeline, stages };
    }, TX_OPTS);
  }

  // ═══════════════════════ STAGE ACTIONS ═══════════════════════════
  private async loadStage(tx: Prisma.TransactionClient, tenantId: string, caseId: string, stageId: string) {
    const stage = await tx.caseStage.findFirst({
      where: { id: stageId, tenantId, timeline: { caseId } },
      include: { timeline: { select: { id: true, caseId: true } } },
    });
    if (!stage) throw new ResourceNotFoundError();
    return stage;
  }

  /** Only flips PENDING<->READY based on predecessor terminality; never touches started/terminal stages. */
  private async recomputeReadiness(tx: Prisma.TransactionClient, timelineId: string): Promise<void> {
    const stages = await tx.caseStage.findMany({ where: { timelineId }, orderBy: { sequence: 'asc' } });
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (s.status !== CaseStageStatus.PENDING && s.status !== CaseStageStatus.READY) continue;
      const prev = i > 0 ? stages[i - 1] : null;
      const eligible = !s.dependsOnPrevious || !prev || TERMINAL.includes(prev.status);
      const desired = eligible ? CaseStageStatus.READY : CaseStageStatus.PENDING;
      if (s.status !== desired) await tx.caseStage.update({ where: { id: s.id }, data: { status: desired } });
    }
  }

  /** Timeline COMPLETED iff every stage is terminal; otherwise ACTIVE. */
  private async syncTimelineStatus(tx: Prisma.TransactionClient, timelineId: string): Promise<void> {
    const stages = await tx.caseStage.findMany({ where: { timelineId }, select: { status: true } });
    const allTerminal = stages.length > 0 && stages.every((s) => TERMINAL.includes(s.status));
    await tx.caseTimeline.update({ where: { id: timelineId }, data: { status: allTerminal ? CaseTimelineStatus.COMPLETED : CaseTimelineStatus.ACTIVE } });
  }

  private async writeTransition(
    tx: Prisma.TransactionClient, ctx: UserContext, stage: CaseStage & { timeline: { caseId: string } },
    from: CaseStageStatus, to: CaseStageStatus, stageEvent: string, note: string | null,
  ): Promise<void> {
    await tx.caseStageEvent.create({
      data: { tenantId: ctx.tenantId, caseId: stage.timeline.caseId, stageId: stage.id, eventType: stageEvent, fromStatus: from, toStatus: to, actorUserId: ctx.userId, note },
    });
    await this.recomputeReadiness(tx, stage.timelineId);
    await this.syncTimelineStatus(tx, stage.timelineId);
    await this.audit.appendInTx(tx, this.auditRow(ctx, `CASE_STAGE_${stageEvent}`, 'CaseStage', stage.id, { caseId: stage.timeline.caseId, toStatus: to }, { status: from }));
  }

  async startStage(ctx: UserContext, caseId: string, stageId: string): Promise<CaseStage> {
    return this.prisma.$transaction(async (tx) => {
      const stage = await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      if (stage.status !== CaseStageStatus.READY) throw new BusinessRuleViolationError('Only a READY stage can be started.');
      const updated = await tx.caseStage.update({ where: { id: stage.id }, data: { status: CaseStageStatus.IN_PROGRESS, startedAt: new Date() } });
      await this.writeTransition(tx, ctx, stage, stage.status, CaseStageStatus.IN_PROGRESS, 'STARTED', null);
      return updated;
    }, TX_OPTS);
  }

  async completeStage(ctx: UserContext, caseId: string, stageId: string, opts: { override?: boolean; reason?: string }): Promise<CaseStage> {
    return this.prisma.$transaction(async (tx) => {
      const stage = await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      if (stage.status !== CaseStageStatus.IN_PROGRESS) throw new BusinessRuleViolationError('Only an IN_PROGRESS stage can be completed.');

      let note: string | null = null;
      if (stage.enforceRequiredOnComplete) {
        const { valid, missing } = await this.values.validateValues(ctx, caseId);
        if (!valid) {
          if (!opts.override) {
            throw new BusinessRuleViolationError(`Required fields are not satisfied (${missing.length}); override required to complete.`);
          }
          if (!opts.reason || !opts.reason.trim()) throw new ValidationError('A reason is required to override required-field enforcement.');
          note = `OVERRIDE: ${opts.reason.trim()}`;
        }
      }
      const updated = await tx.caseStage.update({ where: { id: stage.id }, data: { status: CaseStageStatus.COMPLETED, completedAt: new Date() } });
      await this.writeTransition(tx, ctx, stage, stage.status, CaseStageStatus.COMPLETED, 'COMPLETED', note);
      return updated;
    }, TX_OPTS);
  }

  async skipStage(ctx: UserContext, caseId: string, stageId: string, reason?: string): Promise<CaseStage> {
    if (!reason || !reason.trim()) throw new ValidationError('A reason is required to skip a stage.');
    const SKIPPABLE: CaseStageStatus[] = [CaseStageStatus.PENDING, CaseStageStatus.READY, CaseStageStatus.IN_PROGRESS, CaseStageStatus.WAITING_EXTERNAL];
    return this.prisma.$transaction(async (tx) => {
      const stage = await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      if (!SKIPPABLE.includes(stage.status)) throw new BusinessRuleViolationError(`A ${stage.status} stage cannot be skipped.`);
      const updated = await tx.caseStage.update({ where: { id: stage.id }, data: { status: CaseStageStatus.SKIPPED } });
      await this.writeTransition(tx, ctx, stage, stage.status, CaseStageStatus.SKIPPED, 'SKIPPED', reason.trim());
      return updated;
    }, TX_OPTS);
  }

  async reopenStage(ctx: UserContext, caseId: string, stageId: string): Promise<CaseStage> {
    return this.prisma.$transaction(async (tx) => {
      const stage = await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      let to: CaseStageStatus;
      let data: Prisma.CaseStageUpdateInput;
      if (stage.status === CaseStageStatus.COMPLETED) { to = CaseStageStatus.IN_PROGRESS; data = { status: to, completedAt: null }; }
      else if (stage.status === CaseStageStatus.SKIPPED) { to = CaseStageStatus.READY; data = { status: to }; }
      else throw new BusinessRuleViolationError('Only a COMPLETED or SKIPPED stage can be reopened.');
      const updated = await tx.caseStage.update({ where: { id: stage.id }, data });
      await this.writeTransition(tx, ctx, stage, stage.status, to, 'REOPENED', null);
      return updated;
    }, TX_OPTS);
  }

  async pauseStage(ctx: UserContext, caseId: string, stageId: string): Promise<CaseStage> {
    return this.prisma.$transaction(async (tx) => {
      const stage = await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      if (stage.status !== CaseStageStatus.IN_PROGRESS) throw new BusinessRuleViolationError('Only an IN_PROGRESS stage can be paused.');
      const updated = await tx.caseStage.update({ where: { id: stage.id }, data: { status: CaseStageStatus.WAITING_EXTERNAL } });
      await this.writeTransition(tx, ctx, stage, stage.status, CaseStageStatus.WAITING_EXTERNAL, 'PAUSED', null);
      return updated;
    }, TX_OPTS);
  }

  async resumeStage(ctx: UserContext, caseId: string, stageId: string): Promise<CaseStage> {
    return this.prisma.$transaction(async (tx) => {
      const stage = await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      if (stage.status !== CaseStageStatus.WAITING_EXTERNAL) throw new BusinessRuleViolationError('Only a WAITING_EXTERNAL stage can be resumed.');
      const updated = await tx.caseStage.update({ where: { id: stage.id }, data: { status: CaseStageStatus.IN_PROGRESS } });
      await this.writeTransition(tx, ctx, stage, stage.status, CaseStageStatus.IN_PROGRESS, 'RESUMED', null);
      return updated;
    }, TX_OPTS);
  }

  async listStageEvents(ctx: UserContext, caseId: string, stageId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.loadStage(tx, ctx.tenantId, caseId, stageId);
      return tx.caseStageEvent.findMany({ where: { tenantId: ctx.tenantId, stageId }, orderBy: { createdAt: 'desc' } });
    }, TX_OPTS);
  }
}

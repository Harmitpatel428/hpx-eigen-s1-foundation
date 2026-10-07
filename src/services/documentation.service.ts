import {
  PrismaClient,
  DocDocumentStatus,
  DocCaseStatus,
  DocEventType,
  DocNoteType,
  DocStorageType,
  DocPresetCategory,
  Prisma,
  CaseFieldType,
  CaseFieldConditionOperator,
} from '@prisma/client';
import { operatorAllowedForType, validateScalarConditionValue } from './case-field.validation';
import { normalizeDedupeKey } from './case-type.service';
import { AuditService } from './audit.service';
import { logger } from '../utils/logger';
import {
  ValidationError,
  ResourceNotFoundError,
  BusinessRuleViolationError,
  DuplicateResourceError,
} from '../types/exceptions';

export interface TenantContext {
  tenantId: string;
  userId: string;
}

// ─── Status transition validation ────────────────────────────────────────────

const VALID_TRANSITIONS: Record<DocDocumentStatus, DocDocumentStatus[]> = {
  REQUESTED:           ['PENDING_COLLECTION', 'NOT_APPLICABLE', 'WAIVED'],
  PENDING_COLLECTION:  ['RECEIVED', 'NOT_APPLICABLE', 'WAIVED', 'EXPIRED'],
  RECEIVED:            ['UNDER_VERIFICATION', 'PENDING_COLLECTION'],
  UNDER_VERIFICATION:  ['APPROVED', 'REJECTED'],
  APPROVED:            ['EXPIRED'],
  REJECTED:            ['RE_REQUESTED', 'WAIVED', 'MANAGER_APPROVED'],
  RE_REQUESTED:        ['PENDING_COLLECTION', 'RECEIVED'],
  EXPIRED:             ['RE_REQUESTED'],
  NOT_APPLICABLE:      [],
  WAIVED:              [],
  MANAGER_APPROVED:    [],
};

function assertValidTransition(from: DocDocumentStatus, to: DocDocumentStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new BusinessRuleViolationError();
  }
}

// ─── Progress calculator (called after any document state change) ─────────────

function calcProgress(docs: Array<{
  isMandatory: boolean;
  status: DocDocumentStatus;
  deletedAt: Date | null;
}>) {
  const active = docs.filter(d => !d.deletedAt && d.status !== 'NOT_APPLICABLE');
  const totalDocs         = active.length;
  const mandatoryDocs     = active.filter(d => d.isMandatory).length;
  const receivedDocs      = active.filter(d =>
    ['RECEIVED', 'UNDER_VERIFICATION', 'APPROVED', 'MANAGER_APPROVED', 'WAIVED'].includes(d.status)
  ).length;
  const verifiedDocs      = active.filter(d =>
    ['UNDER_VERIFICATION', 'APPROVED'].includes(d.status)
  ).length;
  const approvedDocs      = active.filter(d =>
    ['APPROVED', 'MANAGER_APPROVED'].includes(d.status)
  ).length;
  const rejectedDocs      = active.filter(d => d.status === 'REJECTED').length;
  const mandatoryApproved = active.filter(d =>
    d.isMandatory && ['APPROVED', 'MANAGER_APPROVED', 'WAIVED'].includes(d.status)
  ).length;
  const completionPercent = totalDocs > 0 ? Math.round((approvedDocs / totalDocs) * 100) : 0;
  const isReady           = mandatoryDocs === 0 || mandatoryApproved >= mandatoryDocs;

  return { totalDocs, receivedDocs, verifiedDocs, approvedDocs, rejectedDocs, mandatoryDocs, mandatoryApproved, completionPercent, isReady };
}

// ─── Case recalculation status groups (race-safe guard) ───────────────────────
// A case in a RECALC_MUTABLE status has its status recomputed on every document
// event. A TERMINAL case is frozen — never touched. A PROTECTED_NON_TERMINAL
// case (mid-handoff) gets its progress counters refreshed but its status is
// left alone, since recalc has no business overriding a handoff-owned status.
const RECALC_MUTABLE_STATUSES: DocCaseStatus[] = ['ACTIVE', 'DOCUMENTATION_READY'];
const TERMINAL_STATUSES: DocCaseStatus[] = ['CLOSED', 'CANCELLED', 'CLOSED_NO_DOCS'];
// Not queried directly (the guard excludes TERMINAL_STATUSES via `notIn` instead, so a
// concurrent transition into terminal is still handled safely) — kept for readability
// and to name the statuses the progress-only branch below applies to.
const PROTECTED_NON_TERMINAL_STATUSES: DocCaseStatus[] = ['INCOMING', 'RETURNED', 'TRANSFERRED_TO_PROCESS'];

// ─── Smart suggestion keyword map ────────────────────────────────────────────

const SUGGESTION_LIBRARY: Array<{ keywords: string[]; documents: string[] }> = [
  {
    keywords: ['manufacturing', 'subsidy', 'udyam', 'msme', 'factory'],
    documents: ['Aadhaar Card', 'PAN Card', 'GST Certificate', 'Udyam Certificate', 'Electricity Bill', 'Bank Statement', 'Cancelled Cheque', 'Factory License'],
  },
  {
    keywords: ['loan', 'bank', 'credit', 'finance', 'mortgage'],
    documents: ['Aadhaar Card', 'PAN Card', 'Bank Statement (6 months)', 'ITR (2 years)', 'Salary Slips', 'Form 16', 'Property Papers', 'CIBIL Report'],
  },
  {
    keywords: ['gst', 'registration', 'tax'],
    documents: ['PAN Card', 'Aadhaar Card', 'Business Registration Certificate', 'Bank Statement', 'Electricity Bill', 'Rent Agreement'],
  },
  {
    keywords: ['property', 'real estate', 'land', 'plot', 'house'],
    documents: ['Sale Deed', 'Title Deed', 'Encumbrance Certificate', 'Property Tax Receipt', 'NOC from Society', 'Building Plan Approval'],
  },
  {
    keywords: ['import', 'export', 'customs', 'iec', 'dgft'],
    documents: ['IEC Certificate', 'GST Certificate', 'Bank Account Details', 'Business PAN', 'RCMC Certificate', 'Digital Signature Certificate'],
  },
  {
    keywords: ['startup', 'incorporation', 'company', 'llp', 'pvt'],
    documents: ['MOA', 'AOA', 'Certificate of Incorporation', 'PAN Card (Company)', 'GST Certificate', 'Digital Signature Certificate', 'Director KYC'],
  },
  {
    keywords: ['kyc', 'compliance', 'aml', 'verification'],
    documents: ['Aadhaar Card', 'PAN Card', 'Passport', 'Voter ID', 'Bank Statement', 'Address Proof', 'Photograph'],
  },
  {
    keywords: ['insurance', 'policy', 'claim'],
    documents: ['Policy Document', 'Aadhaar Card', 'PAN Card', 'Hospital Bills', 'Discharge Summary', 'Doctor Prescription', 'Bank Details'],
  },
];

export function getSuggestions(presetName: string): string[] {
  const lower = presetName.toLowerCase();
  const matched = new Set<string>();
  for (const entry of SUGGESTION_LIBRARY) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      entry.documents.forEach(d => matched.add(d));
    }
  }
  return Array.from(matched);
}

// ─── Multi-policy assignment helpers ─────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGN_ALLOWED_STATUSES: DocCaseStatus[] = ['INCOMING', 'RETURNED', 'ACTIVE', 'DOCUMENTATION_READY'];
const DESELECT_SAFE_STATUSES: DocDocumentStatus[] = ['REQUESTED', 'PENDING_COLLECTION'];

export interface PolicyInput {
  caseTypeId: string;
  componentIds?: string[];
  proposalDate?: string | null;
  actualDate?: string | null;
}
export interface AssignPoliciesInput {
  policies: PolicyInput[];
  primaryCaseTypeId?: string | null;
}

/** Parses an omitted/null/empty/YYYY-MM-DD date input to a UTC Date or null; throws 400 on malformed. */
function parseDateInput(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError('Dates must be a YYYY-MM-DD string, null, or empty.');
  const d = new Date(`${v}T00:00:00.000Z`);
  if (isNaN(d.getTime())) throw new ValidationError('Invalid date.');
  return d;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every(x => sa.has(x));
}

// ═════════════════════════════════════════════════════════════════════════════
// DocumentationService
// ═════════════════════════════════════════════════════════════════════════════

export class DocumentationService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  // ─── PRESETS ───────────────────────────────────────────────────────────────

  async createPreset(
    ctx: TenantContext,
    input: {
      name: string;
      description?: string;
      category?: DocPresetCategory;
      color?: string;
      icon?: string;
      items: Array<{
        name: string;
        description?: string;
        isMandatory?: boolean;
        isBlocking?: boolean;
        displayOrder?: number;
        verificationRequired?: boolean;
        expiryTrackingEnabled?: boolean;
        expiryDays?: number;
        metadataFields?: unknown[];
        notes?: string;
        conditionRule?: unknown;
      }>;
    }
  ) {
    if (!input.name?.trim()) throw new ValidationError('Preset name is required.');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.docPreset.findFirst({
        where: { tenantId: ctx.tenantId, name: input.name.trim(), deletedAt: null },
      });
      if (existing) throw new DuplicateResourceError();

      const preset = await tx.docPreset.create({
        data: {
          tenantId:    ctx.tenantId,
          name:        input.name.trim(),
          description: input.description ?? null,
          category:    input.category ?? 'CUSTOM',
          color:       input.color ?? null,
          icon:        input.icon ?? null,
          version:     1,
          createdBy:   ctx.userId,
          items: {
            create: input.items.map((item, idx) => ({
              tenantId:              ctx.tenantId,
              name:                  item.name,
              description:           item.description ?? null,
              isMandatory:           item.isMandatory ?? true,
              isBlocking:            item.isBlocking ?? false,
              displayOrder:          item.displayOrder ?? idx,
              verificationRequired:  item.verificationRequired ?? true,
              expiryTrackingEnabled: item.expiryTrackingEnabled ?? false,
              expiryDays:            item.expiryDays ?? null,
              metadataFields:        (item.metadataFields as Prisma.InputJsonValue) ?? [],
              notes:                 item.notes ?? null,
              conditionRule:         (item.conditionRule as Prisma.InputJsonValue) ?? null,
            })),
          },
        },
        include: { items: { where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } } },
      });

      // Snapshot v1
      await tx.docPresetVersion.create({
        data: {
          presetId:  preset.id,
          tenantId:  ctx.tenantId,
          version:   1,
          snapshot:  { preset, items: preset.items } as unknown as Prisma.InputJsonValue,
          changedBy: ctx.userId,
          changeNote: 'Initial version',
        },
      });

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_PRESET_CREATED', entityType: 'DocPreset', entityId: preset.id,
        operation: 'CREATE', payload: { name: preset.name, category: preset.category },
      });

      return preset;
    });
  }

  async updatePreset(
    ctx: TenantContext,
    presetId: string,
    input: {
      name?: string;
      description?: string;
      category?: DocPresetCategory;
      color?: string;
      icon?: string;
      isActive?: boolean;
      changeNote?: string;
      items?: Array<{
        id?: string;
        name: string;
        description?: string;
        isMandatory?: boolean;
        isBlocking?: boolean;
        displayOrder?: number;
        verificationRequired?: boolean;
        expiryTrackingEnabled?: boolean;
        expiryDays?: number;
        metadataFields?: unknown[];
        notes?: string;
        conditionRule?: unknown;
      }>;
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const preset = await tx.docPreset.findFirst({
        where: { id: presetId, tenantId: ctx.tenantId, deletedAt: null },
        include: { items: { where: { deletedAt: null } } },
      });
      if (!preset) throw new ResourceNotFoundError();

      if (input.name && input.name.trim() !== preset.name) {
        const dup = await tx.docPreset.findFirst({
          where: { tenantId: ctx.tenantId, name: input.name.trim(), deletedAt: null, id: { not: presetId } },
        });
        if (dup) throw new DuplicateResourceError();
      }

      const newVersion = preset.version + 1;

      // Snapshot the old version before mutating
      await tx.docPresetVersion.create({
        data: {
          presetId:  presetId,
          tenantId:  ctx.tenantId,
          version:   preset.version,
          snapshot:  { preset, items: preset.items } as unknown as Prisma.InputJsonValue,
          changedBy: ctx.userId,
          changeNote: input.changeNote ?? `Updated to v${newVersion}`,
        },
      });

      // If items supplied, replace all (soft-delete old, create new)
      if (input.items !== undefined) {
        await tx.docPresetItem.updateMany({
          where: { presetId, tenantId: ctx.tenantId, deletedAt: null },
          data:  { deletedAt: new Date() },
        });
        await tx.docPresetItem.createMany({
          data: input.items.map((item, idx) => ({
            presetId,
            tenantId:              ctx.tenantId,
            name:                  item.name,
            description:           item.description ?? null,
            isMandatory:           item.isMandatory ?? true,
            isBlocking:            item.isBlocking ?? false,
            displayOrder:          item.displayOrder ?? idx,
            verificationRequired:  item.verificationRequired ?? true,
            expiryTrackingEnabled: item.expiryTrackingEnabled ?? false,
            expiryDays:            item.expiryDays ?? null,
            metadataFields:        (item.metadataFields as Prisma.InputJsonValue) ?? [],
            notes:                 item.notes ?? null,
            conditionRule:         (item.conditionRule as Prisma.InputJsonValue) ?? null,
          })),
        });
      }

      const updated = await tx.docPreset.update({
        where: { id: presetId },
        data: {
          name:       input.name?.trim() ?? preset.name,
          description: input.description !== undefined ? input.description : preset.description,
          category:   input.category ?? preset.category,
          color:      input.color !== undefined ? input.color : preset.color,
          icon:       input.icon !== undefined ? input.icon : preset.icon,
          isActive:   input.isActive !== undefined ? input.isActive : preset.isActive,
          version:    newVersion,
          updatedBy:  ctx.userId,
        },
        include: { items: { where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } } },
      });

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_PRESET_UPDATED', entityType: 'DocPreset', entityId: presetId,
        operation: 'UPDATE',
        payload: { name: updated.name, newVersion },
        beforeState: { version: preset.version },
        afterState:  { version: newVersion },
      });

      return updated;
    });
  }

  async listPresets(ctx: TenantContext, includeInactive = false) {
    return this.prisma.docPreset.findMany({
      where: {
        tenantId:  ctx.tenantId,
        deletedAt: null,
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: {
        items: { where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } },
        _count: { select: { cases: true } },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async getPreset(ctx: TenantContext, presetId: string) {
    const preset = await this.prisma.docPreset.findFirst({
      where: { id: presetId, tenantId: ctx.tenantId, deletedAt: null },
      include: {
        items:          { where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } },
        versionHistory: { orderBy: { version: 'desc' }, take: 20 },
        _count:         { select: { cases: true } },
      },
    });
    if (!preset) throw new ResourceNotFoundError();
    return preset;
  }

  async deletePreset(ctx: TenantContext, presetId: string) {
    return this.prisma.$transaction(async (tx) => {
      const preset = await tx.docPreset.findFirst({
        where: { id: presetId, tenantId: ctx.tenantId, deletedAt: null },
        include: { _count: { select: { cases: true } } },
      });
      if (!preset) throw new ResourceNotFoundError();
      if (preset._count.cases > 0) throw new BusinessRuleViolationError();

      await tx.docPreset.update({
        where: { id: presetId },
        data:  { deletedAt: new Date(), updatedBy: ctx.userId },
      });

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_PRESET_DELETED', entityType: 'DocPreset', entityId: presetId,
        operation: 'DELETE', payload: { name: preset.name },
      });
    });
  }

  // ─── CASES ─────────────────────────────────────────────────────────────────

  async createCase(
    ctx: TenantContext,
    input: {
      leadId:    string;
      presetId?: string;
      assignedTo?: string;
      dueDate?:  Date;
      priority?: number;
      notes?:    string;
    }
  ) {
    if (!input.leadId) throw new ValidationError('leadId is required.');

    const createdId = await this.prisma.$transaction(async (tx) => {
      // Verify lead exists in this tenant
      const lead = await tx.lead.findFirst({
        where: { id: input.leadId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!lead) throw new ResourceNotFoundError();

      // One case per lead
      const existing = await tx.docCase.findFirst({
        where: { tenantId: ctx.tenantId, leadId: input.leadId, deletedAt: null },
      });
      if (existing) throw new DuplicateResourceError();

      let presetSnapshot: { items: Array<{ name: string; description?: string | null; isMandatory: boolean; isBlocking: boolean; displayOrder: number; verificationRequired: boolean; expiryTrackingEnabled: boolean; expiryDays?: number | null; metadataFields: unknown; notes?: string | null; conditionRule?: unknown }> } | null = null;
      let presetVersion: number | null = null;

      if (input.presetId) {
        const preset = await tx.docPreset.findFirst({
          where: { id: input.presetId, tenantId: ctx.tenantId, deletedAt: null, isActive: true },
          include: { items: { where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } } },
        });
        if (!preset) throw new ResourceNotFoundError();
        presetSnapshot = preset;
        presetVersion  = preset.version;
      }

      const docCase = await tx.docCase.create({
        data: {
          tenantId:     ctx.tenantId,
          leadId:       input.leadId,
          presetId:     input.presetId ?? null,
          presetVersion,
          assignedTo:   input.assignedTo ?? null,
          dueDate:      input.dueDate ?? null,
          priority:     input.priority ?? 0,
          notes:        input.notes ?? null,
          createdBy:    ctx.userId,
          status:       'ACTIVE',
        },
      });

      // Create document entries from preset items
      const documents: Array<{ id: string }> = [];
      if (presetSnapshot) {
        for (const item of presetSnapshot.items) {
          const doc = await tx.docCaseDocument.create({
            data: {
              tenantId:              ctx.tenantId,
              caseId:                docCase.id,
              name:                  item.name,
              description:           item.description ?? null,
              isMandatory:           item.isMandatory,
              isBlocking:            item.isBlocking,
              displayOrder:          item.displayOrder,
              verificationRequired:  item.verificationRequired,
              expiryTrackingEnabled: item.expiryTrackingEnabled,
              metadataValues:        {},
              status:                'REQUESTED',
            },
          });
          documents.push(doc);
        }

        // Recalculate progress
        const allDocs = await tx.docCaseDocument.findMany({
          where: { caseId: docCase.id, deletedAt: null },
          select: { isMandatory: true, status: true, deletedAt: true },
        });
        const progress = calcProgress(allDocs);
        await tx.docCase.update({ where: { id: docCase.id }, data: { ...progress } });

        // Increment preset usage count
        await tx.docPreset.update({
          where: { id: input.presetId! },
          data:  { usageCount: { increment: 1 } },
        });
      }

      // Timeline event
      await tx.docCaseEvent.create({
        data: {
          tenantId:    ctx.tenantId,
          caseId:      docCase.id,
          eventType:   'CASE_CREATED',
          actorUserId: ctx.userId,
          payload:     { leadId: input.leadId, presetId: input.presetId ?? null } as unknown as Prisma.InputJsonValue,
        },
      });

      if (input.presetId) {
        await tx.docCaseEvent.create({
          data: {
            tenantId:  ctx.tenantId,
            caseId:    docCase.id,
            eventType: 'PRESET_APPLIED',
            actorUserId: ctx.userId,
            payload:   { presetId: input.presetId, version: presetVersion } as unknown as Prisma.InputJsonValue,
          },
        });
      }

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_CASE_CREATED', entityType: 'DocCase', entityId: docCase.id,
        operation: 'CREATE', payload: { leadId: input.leadId, presetId: input.presetId ?? null, documentCount: documents.length },
      });

      return docCase.id;
    });

    // Read AFTER commit: getCaseById uses a separate connection that can't see uncommitted rows.
    return this.getCaseById(ctx, createdId);
  }

  async listCases(
    ctx: TenantContext,
    filters: {
      status?:      DocCaseStatus;
      assignedTo?:  string;
      isReady?:     boolean;
      search?:      string;
      page?:        number;
      pageSize?:    number;
      fieldFilters?: { fieldId: string; operator: string; value?: unknown }[];
      sortBy?:      string;
      sortDir?:     string;
    } = {}
  ) {
    const SORTABLE = ['createdAt', 'priority', 'completionPercent', 'targetDate'];
    if (filters.sortBy !== undefined && !SORTABLE.includes(filters.sortBy)) {
      throw new ValidationError(`sortBy must be one of: ${SORTABLE.join(', ')}.`);
    }
    if (filters.sortDir !== undefined && filters.sortDir !== 'asc' && filters.sortDir !== 'desc') {
      throw new ValidationError('sortDir must be asc or desc.');
    }
    const dir = (filters.sortDir ?? 'desc') as 'asc' | 'desc';
    const orderBy: Prisma.DocCaseOrderByWithRelationInput[] = !filters.sortBy
      ? [{ priority: 'desc' }, { createdAt: 'desc' }]
      : filters.sortBy === 'targetDate'
        ? [{ timeline: { targetDate: dir } }]
        : [{ [filters.sortBy]: dir }];
    const fieldClauses = await this.buildFieldFilterClauses(ctx.tenantId, filters.fieldFilters);

    const page     = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, filters.pageSize ?? 25);
    const skip     = (page - 1) * pageSize;

    const where: Prisma.DocCaseWhereInput = {
      tenantId:  ctx.tenantId,
      deletedAt: null,
      ...(fieldClauses.length ? { AND: fieldClauses } : {}),
      ...(filters.status     ? { status: filters.status }     : {}),
      ...(filters.assignedTo ? { assignedTo: filters.assignedTo } : {}),
      ...(filters.isReady !== undefined ? { isReady: filters.isReady } : {}),
      ...(filters.search ? {
        lead: {
          OR: [
            { firstName: { contains: filters.search, mode: 'insensitive' } },
            { lastName:  { contains: filters.search, mode: 'insensitive' } },
            { company:   { contains: filters.search, mode: 'insensitive' } },
          ],
        },
      } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.docCase.findMany({
        where,
        include: {
          lead:   { select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true } },
          preset: { select: { id: true, name: true, category: true, color: true, icon: true } },
          _count: { select: { documents: true, caseNotes: true, reminders: true } },
          mandateRequests: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      this.prisma.docCase.count({ where }),
    ]);

    // Flatten the single latest mandate request into a scalar status for list rows.
    const data = rows.map(({ mandateRequests, ...c }) => ({
      ...c,
      latestMandateStatus: mandateRequests[0]?.status ?? null,
    }));

    return { data, total, page, pageSize };
  }

  /** Validates fieldFilters (400 on any problem) and returns one tenant-scoped DocCase clause per filter. */
  private async buildFieldFilterClauses(
    tenantId: string,
    fieldFilters?: { fieldId: string; operator: string; value?: unknown }[],
  ): Promise<Prisma.DocCaseWhereInput[]> {
    if (!fieldFilters?.length) return [];
    if (fieldFilters.length > 5) throw new ValidationError('At most 5 field filters are allowed.');
    const O = CaseFieldConditionOperator;
    const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const clauses: Prisma.DocCaseWhereInput[] = [];
    for (const f of fieldFilters) {
      if (!f || typeof f.fieldId !== 'string' || typeof f.operator !== 'string') {
        throw new ValidationError('Each field filter needs fieldId and operator.');
      }
      const field = isUuid(f.fieldId)
        ? await this.prisma.caseFieldDefinition.findFirst({
            where: { id: f.fieldId, tenantId, deletedAt: null },
            select: { id: true, type: true, filterable: true },
          })
        : null;
      if (!field) throw new ValidationError('Unknown field in filter.');
      if (field.filterable !== true) throw new ValidationError('Field is not filterable.');
      if (!(Object.values(O) as string[]).includes(f.operator)) throw new ValidationError('Unknown filter operator.');
      const op = f.operator as CaseFieldConditionOperator;
      if (!operatorAllowedForType(field.type, op)) {
        throw new ValidationError(`Operator ${op} is not allowed for a ${field.type} field.`);
      }
      const base = { fieldId: field.id, tenantId, deletedAt: null };
      if (op === O.IS_EMPTY)     { clauses.push({ fieldValues: { none: base } }); continue; }
      if (op === O.IS_NOT_EMPTY) { clauses.push({ fieldValues: { some: base } }); continue; }

      if (field.type === CaseFieldType.MULTI_SELECT) {
        const ids = f.value;
        if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) {
          throw new ValidationError('value must be a non-empty array of option ids.');
        }
        if (!ids.every((x) => isUuid(x as string))) throw new ValidationError('option id must be a valid UUID.');
        const hit = { ...base, selections: { some: { optionId: { in: ids as string[] } } } };
        clauses.push({ fieldValues: op === O.IN ? { some: hit } : { none: hit } });
        continue;
      }
      if (field.type === CaseFieldType.SELECT) {
        if (typeof f.value !== 'string') throw new ValidationError('value must be an option id.');
        if (!isUuid(f.value)) throw new ValidationError('option id must be a valid UUID.');
        clauses.push({ fieldValues: { some: { ...base, optionId: op === O.EQUALS ? f.value : { not: f.value } } } });
        continue;
      }
      validateScalarConditionValue(field.type, f.value);
      const col = field.type === CaseFieldType.BOOLEAN ? 'valueBoolean'
        : field.type === CaseFieldType.DATE || field.type === CaseFieldType.DATETIME ? 'valueDate'
        : typeof f.value === 'number' ? 'valueNumber' : 'valueText';
      const v = col === 'valueDate' ? new Date(f.value as string) : (f.value as string | number | boolean);
      if (v instanceof Date && isNaN(v.getTime())) throw new ValidationError('value is not a valid date.');
      const cond = op === O.EQUALS ? v
        : op === O.NOT_EQUALS ? { not: v }
        : op === O.GREATER_THAN ? { gt: v } : { lt: v };
      clauses.push({ fieldValues: { some: { ...base, [col]: cond } } });
    }
    return clauses;
  }

  async getCaseById(ctx: TenantContext, caseId: string) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      include: {
        lead:   { select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true, status: true } },
        preset: { select: { id: true, name: true, category: true, color: true, icon: true } },
        documents: {
          where:   { deletedAt: null },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            storageRefs: { orderBy: { createdAt: 'desc' } },
            // Active provenance only: which components require this requirement.
            componentSources: {
              where:   { deletedAt: null },
              orderBy: [{ displayOrderAtLink: 'asc' }, { createdAt: 'asc' }],
              include: {
                component:         { select: { id: true, name: true } },
                componentDocument: { select: { id: true, name: true, isActive: true, deletedAt: true } },
              },
            },
          },
        },
        // Firm/client uploaded files (unified Document store). R5 payload contract —
        // active only, storageKey excluded (view-url is the only path to bytes).
        uploadedDocuments: {
          where:   { deletedAt: null, isActive: true },
          orderBy: [{ createdAt: 'desc' }],
          select: {
            id: true, category: true, name: true, originalFilename: true, mimeType: true,
            sizeBytes: true, checksum: true, status: true, sourceChannel: true,
            uploadedByParty: true, uploadedByUserId: true, clientVisible: true, internalNote: true,
            isActive: true, receivedAt: true, expiresAt: true, versionOfId: true, requirementId: true,
            verifiedAt: true, rejectedAt: true, rejectionReason: true, createdAt: true,
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          take:    100,
        },
        caseNotes: {
          where:   { deletedAt: null },
          orderBy: { createdAt: 'desc' },
        },
        reminders: {
          where:   { isTriggered: false },
          orderBy: { reminderDate: 'asc' },
        },
        overrides: {
          orderBy: { allowedAt: 'desc' },
        },
        policyAssignments: {
          where:   { deletedAt: null },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            caseType:   { select: { id: true, name: true, key: true, status: true, deletedAt: true } },
            components: {
              where:   { deletedAt: null },
              orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
              include: { component: { select: { id: true, name: true, description: true, isMandatory: true, displayOrder: true, isActive: true, deletedAt: true } } },
            },
          },
        },
        _count: { select: { documents: true } },
      },
    });
    if (!docCase) throw new ResourceNotFoundError();

    // Shape policy assignments for the client: flag the effective primary (first by
    // displayOrder) and reshape component selections. If no active assignment rows
    // exist but a legacy caseTypeId is set, emit a read-only-only derived entry so the
    // edit dialog can prefill — this sentinel (id `legacy:…`) is never persisted and the
    // FE must send the plain caseTypeId on first real save.
    const { policyAssignments, documents, ...rest } = docCase;

    // Flatten each document's component provenance for the client. Every other
    // document field (including requirementDedupeKey / isComponentMerged) rides
    // along untouched.
    const shapedDocuments = documents.map(d => {
      const { componentSources, ...doc } = d;
      return {
        ...doc,
        componentSources: componentSources.map(s => ({
          id:                   s.id,
          componentId:          s.componentId,
          componentName:        s.component.name,
          componentDocumentId:  s.componentDocumentId,
          componentDocumentName: s.componentDocument?.name ?? null,
          policyAssignmentId:   s.policyAssignmentId,
          policyComponentId:    s.policyComponentId,
          isMandatoryAtLink:    s.isMandatoryAtLink,
          displayOrderAtLink:   s.displayOrderAtLink,
          componentDocument:    s.componentDocument ? { isActive: s.componentDocument.isActive, deletedAt: s.componentDocument.deletedAt } : null,
        })),
      };
    });
    let shapedAssignments = policyAssignments.map((pa, i) => ({
      id:           pa.id,
      caseTypeId:   pa.caseTypeId,
      proposalDate: pa.proposalDate,
      actualDate:   pa.actualDate,
      displayOrder: pa.displayOrder,
      isPrimary:    i === 0,
      derived:      false,
      caseType:     pa.caseType,
      components:   pa.components.map(c => ({ selectionId: c.id, componentId: c.componentId, displayOrder: c.displayOrder, component: c.component })),
    }));

    if (shapedAssignments.length === 0 && docCase.caseTypeId) {
      const ct = await this.prisma.caseType.findFirst({
        where:  { id: docCase.caseTypeId, tenantId: ctx.tenantId },
        select: { id: true, name: true, key: true, status: true, deletedAt: true },
      });
      if (ct) {
        shapedAssignments = [{
          id: `legacy:${ct.id}`, caseTypeId: ct.id, proposalDate: null, actualDate: null,
          displayOrder: 0, isPrimary: true, derived: true, caseType: ct, components: [],
        }];
      }
    }

    return { ...rest, documents: shapedDocuments, policyAssignments: shapedAssignments };
  }

  // ─── Multi-policy assignment ─────────────────────────────────────────────────
  /**
   * Assign one or more policies (CaseTypes) to a case, configure components per
   * policy, generate/retire the requirement documents, and sync DocCase.caseTypeId
   * to the primary policy. One transaction, row-locked, recalc at the end.
   */
  async assignPolicies(ctx: TenantContext, caseId: string, input: AssignPoliciesInput) {
    // ── Structural validation (400) ──
    if (!UUID_RE.test(caseId)) throw new ValidationError('caseId must be a UUID.');
    const policies = input?.policies;
    if (!Array.isArray(policies)) throw new ValidationError('policies must be an array.');
    if (policies.length === 0) throw new ValidationError('policies must be a non-empty array.');
    if (policies.length > 25) throw new ValidationError('A case may have at most 25 policies.');

    const seenType = new Set<string>();
    for (const p of policies) {
      if (!p || typeof p !== 'object') throw new ValidationError('Each policy must be an object.');
      if (typeof p.caseTypeId !== 'string' || !UUID_RE.test(p.caseTypeId)) throw new ValidationError('Each policy.caseTypeId must be a UUID.');
      if (seenType.has(p.caseTypeId)) throw new ValidationError('Duplicate caseTypeId in policies.');
      seenType.add(p.caseTypeId);
      if (p.componentIds !== undefined) {
        if (!Array.isArray(p.componentIds)) throw new ValidationError('componentIds must be an array.');
        if (p.componentIds.length > 100) throw new ValidationError('A policy may have at most 100 components.');
        const seenComp = new Set<string>();
        for (const cid of p.componentIds) {
          if (typeof cid !== 'string' || !UUID_RE.test(cid)) throw new ValidationError('Each componentId must be a UUID.');
          if (seenComp.has(cid)) throw new ValidationError('Duplicate componentId in a policy.');
          seenComp.add(cid);
        }
      }
      parseDateInput(p.proposalDate);
      parseDateInput(p.actualDate);
    }
    if (input.primaryCaseTypeId != null) {
      if (!UUID_RE.test(input.primaryCaseTypeId)) throw new ValidationError('primaryCaseTypeId must be a UUID.');
      if (!seenType.has(input.primaryCaseTypeId)) throw new ValidationError('primaryCaseTypeId must be one of the submitted policies.');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock the case row (serializes concurrent assigns + doc generation).
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "DocCase" WHERE id = ${caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) throw new ResourceNotFoundError();
      const docCase = await tx.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true, caseTypeId: true, status: true } });
      if (!docCase) throw new ResourceNotFoundError();
      if (!ASSIGN_ALLOWED_STATUSES.includes(docCase.status)) {
        throw new BusinessRuleViolationError(`Policies cannot be assigned to a case with status ${docCase.status}.`);
      }

      // 2. Current active assignments + referenced case types.
      const current = await tx.docCasePolicyAssignment.findMany({
        where:   { tenantId: ctx.tenantId, caseId, deletedAt: null },
        include: { components: { where: { deletedAt: null }, select: { componentId: true } } },
      });
      const currentByType = new Map(current.map(a => [a.caseTypeId, a]));

      const types = await tx.caseType.findMany({ where: { tenantId: ctx.tenantId, id: { in: policies.map(p => p.caseTypeId) } } });
      const typeById = new Map(types.map(t => [t.id, t]));
      for (const p of policies) if (!typeById.has(p.caseTypeId)) throw new ResourceNotFoundError(); // 404 missing/cross-tenant

      // A legacy caseTypeId with no active row is treated as retained (drift tolerant).
      const isRetained = (caseTypeId: string) => currentByType.has(caseTypeId) || caseTypeId === docCase.caseTypeId;
      const isActiveType = (caseTypeId: string) => typeById.get(caseTypeId)!.status === 'ACTIVE';

      // Newly-added policies must be ACTIVE; retained archived ones may stay.
      for (const p of policies) {
        if (!isRetained(p.caseTypeId) && !isActiveType(p.caseTypeId)) throw new BusinessRuleViolationError('Policy must be ACTIVE.');
      }

      // 3. Effective primary + persisted order (primary at displayOrder 0).
      let primaryId = input.primaryCaseTypeId ?? null;
      if (primaryId) {
        if (policies.some(p => isActiveType(p.caseTypeId)) && !isActiveType(primaryId)) throw new BusinessRuleViolationError('The primary policy must be ACTIVE.');
      } else {
        primaryId = (policies.find(p => isActiveType(p.caseTypeId)) ?? policies[0]).caseTypeId;
      }
      const orderedTypeIds = [primaryId, ...policies.map(p => p.caseTypeId).filter(id => id !== primaryId)];
      const orderIndex = new Map(orderedTypeIds.map((id, i) => [id, i]));

      // 4/5. Per-policy: validate selection, upsert assignment, diff component rows.
      for (const p of policies) {
        const type = typeById.get(p.caseTypeId)!;
        const existing = currentByType.get(p.caseTypeId);
        const retained = isRetained(p.caseTypeId);
        const currentSel = existing ? existing.components.map(c => c.componentId) : [];
        const incoming = p.componentIds !== undefined ? p.componentIds : (retained ? currentSel : []);
        const unchanged = sameSet(incoming, currentSel);
        const typeArchived = type.status === 'ARCHIVED' || type.deletedAt != null;

        if (retained && typeArchived && !unchanged) {
          throw new BusinessRuleViolationError('Component selection for an archived retained policy cannot be changed.');
        }

        const activeComps = await tx.caseTypeComponent.findMany({ where: { tenantId: ctx.tenantId, caseTypeId: p.caseTypeId, isActive: true, deletedAt: null }, select: { id: true, displayOrder: true } });
        const activeIds = new Set(activeComps.map(c => c.id));
        const hasActiveComps = activeComps.length > 0;

        // The active-component requirement applies to newly-added policies, and to
        // retained policies whose selection changed. Unchanged retained selections
        // (date-only edits) are exempt.
        if (!retained || !unchanged) {
          // Validate every incoming component belongs to this policy (400) and that
          // newly-selected ones are active (422). Already-selected inactive ones stay.
          if (incoming.length > 0) {
            const comps = await tx.caseTypeComponent.findMany({ where: { tenantId: ctx.tenantId, id: { in: incoming } }, select: { id: true, caseTypeId: true, isActive: true, deletedAt: true } });
            const compById = new Map(comps.map(c => [c.id, c]));
            for (const cid of incoming) {
              const c = compById.get(cid);
              if (!c || c.caseTypeId !== p.caseTypeId) throw new ValidationError('A selected component does not belong to its policy.');
              if (!currentSel.includes(cid) && (!c.isActive || c.deletedAt)) throw new BusinessRuleViolationError('A newly selected component is inactive.');
            }
          }
          if (hasActiveComps && !incoming.some(cid => activeIds.has(cid))) {
            throw new BusinessRuleViolationError('Select at least one active component for this policy.');
          }
        }

        const propProvided = p.proposalDate !== undefined;
        const actProvided = p.actualDate !== undefined;
        const displayOrder = orderIndex.get(p.caseTypeId)!;
        const assignment = await tx.docCasePolicyAssignment.upsert({
          where:  { tenantId_caseId_caseTypeId: { tenantId: ctx.tenantId, caseId, caseTypeId: p.caseTypeId } },
          create: {
            tenantId: ctx.tenantId, caseId, caseTypeId: p.caseTypeId, displayOrder, createdBy: ctx.userId,
            proposalDate: propProvided ? parseDateInput(p.proposalDate) : null,
            actualDate:   actProvided ? parseDateInput(p.actualDate) : null,
          },
          update: {
            deletedAt: null, displayOrder,
            ...(propProvided ? { proposalDate: parseDateInput(p.proposalDate) } : {}),
            ...(actProvided ? { actualDate: parseDateInput(p.actualDate) } : {}),
          },
        });

        // Component selection diff (skip when retained + unchanged — pure date edit).
        if (!retained || !unchanged) {
          const compOrder = new Map(activeComps.map(c => [c.id, c.displayOrder]));
          const allSel = await tx.docCasePolicyComponent.findMany({ where: { tenantId: ctx.tenantId, policyAssignmentId: assignment.id } });
          const selByComp = new Map(allSel.map(s => [s.componentId, s]));
          for (const cid of incoming) {
            const row = selByComp.get(cid);
            if (row) {
              // Reviving a selection also clears documentsMaterializedAt so the
              // component's CURRENT active presets materialize again.
              if (row.deletedAt) await tx.docCasePolicyComponent.update({ where: { id: row.id }, data: { deletedAt: null, documentsMaterializedAt: null } });
            } else {
              await tx.docCasePolicyComponent.create({ data: { tenantId: ctx.tenantId, caseId, policyAssignmentId: assignment.id, componentId: cid, displayOrder: compOrder.get(cid) ?? 0, createdBy: ctx.userId } });
            }
          }
          for (const s of allSel) {
            if (!s.deletedAt && !incoming.includes(s.componentId)) {
              await tx.docCasePolicyComponent.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
            }
          }
        }
      }

      // 6. Soft-delete assignments (and their active component rows) no longer present.
      const keepTypeIds = new Set(policies.map(p => p.caseTypeId));
      for (const a of current) {
        if (!keepTypeIds.has(a.caseTypeId)) {
          await tx.docCasePolicyComponent.updateMany({ where: { tenantId: ctx.tenantId, policyAssignmentId: a.id, deletedAt: null }, data: { deletedAt: new Date() } });
          await tx.docCasePolicyAssignment.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
        }
      }

      // 7. Generate / retire requirement documents from the resulting selections.
      await this._syncPolicyDocuments(tx, ctx.tenantId, caseId);

      // 8. Sync DocCase.caseTypeId to the effective primary.
      await tx.docCase.update({ where: { id: caseId }, data: { caseTypeId: primaryId } });

      // 9. Recalc progress/status via the single chokepoint.
      await this._recalcAndUpdateCase(tx, caseId, ctx.tenantId);

      // 10. One audit row (ids only).
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'DOC_CASE_POLICY_ASSIGNMENT_UPDATED',
        entityType: 'DocCase',
        entityId: caseId,
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { primaryCaseTypeId: primaryId, caseTypeIds: policies.map(p => p.caseTypeId) },
        beforeState: { caseTypeId: docCase.caseTypeId },
      });

      return this.getCaseById(ctx, caseId);
    }, { maxWait: 5000, timeout: 20000 });
  }

  /**
   * Reconcile DocCaseDocument rows against the case's component-document presets.
   *
   * A selected component does NOT itself create a requirement — only its active
   * CaseTypeComponentDocument preset lines do, and lines that normalize to the
   * same dedupeKey across components collapse into ONE shared requirement whose
   * provenance lives in DocCaseDocumentComponentSource. One upload against the
   * shared row therefore satisfies every component that required it.
   *
   * Three ordered phases; removal runs first so a deselect+reselect in the same
   * save lands correctly. The caller already holds a FOR UPDATE lock on the
   * DocCase row, which serializes displayOrder allocation and all source writes.
   */
  private async _syncPolicyDocuments(tx: Prisma.TransactionClient, tenantId: string, caseId: string) {
    const touched = new Set<string>();

    // ── Phase A: removal ──
    // Every document whose links were dropped goes into the reconciliation set,
    // whether it is merged, adopted-manual or legacy.
    const deletedSel = await tx.docCasePolicyComponent.findMany({ where: { tenantId, caseId, deletedAt: { not: null } }, select: { id: true } });
    for (const s of deletedSel) {
      const links = await tx.docCaseDocumentComponentSource.findMany({ where: { tenantId, policyComponentId: s.id, deletedAt: null }, select: { id: true, documentId: true } });
      for (const l of links) {
        await tx.docCaseDocumentComponentSource.update({ where: { id: l.id }, data: { deletedAt: new Date() } });
        touched.add(l.documentId);
      }
      // Legacy fallback: documents generated by the pre-dedupe rule point at the
      // selection directly and may have no link rows at all.
      const legacy = await tx.docCaseDocument.findMany({ where: { tenantId, caseId, policyComponentId: s.id, deletedAt: null }, select: { id: true } });
      for (const d of legacy) touched.add(d.id);
    }

    // ── Phase B: materialization ──
    // NOT gated on documentsMaterializedAt: a preset added to a component AFTER a
    // case already selected it must still surface, so every run reconciles the
    // full current preset set for every active selection. Idempotent via the
    // mergeKey lookup + (policyComponentId, componentDocumentId) source upsert
    // inside _materializePresetForSelection. documentsMaterializedAt is still
    // stamped as a first-materialization record but no longer decides what runs.
    const active = await tx.docCasePolicyComponent.findMany({
      where:   { tenantId, caseId, deletedAt: null },
      include: { policyAssignment: { select: { id: true, displayOrder: true } } },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const ordered = [...active].sort((a, b) =>
      (a.policyAssignment.displayOrder - b.policyAssignment.displayOrder) || (a.displayOrder - b.displayOrder),
    );

    for (const sel of ordered) {
      const presets = await tx.caseTypeComponentDocument.findMany({
        where:   { tenantId, componentId: sel.componentId, isActive: true, deletedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      });
      for (const preset of presets) {
        touched.add(await this._materializePresetForSelection(tx, tenantId, caseId, sel, preset));
      }
      // Record first materialization; it no longer gates (see Phase B note).
      if (!sel.documentsMaterializedAt) {
        await tx.docCasePolicyComponent.update({ where: { id: sel.id }, data: { documentsMaterializedAt: new Date() } });
      }
    }

    // ── Phase C: reconcile every touched document ──
    for (const docId of touched) await this._reconcilePolicyDocument(tx, tenantId, docId);
  }

  /**
   * Materialize ONE component-document preset for ONE active selection:
   * find → revive → adopt → create the shared requirement, then upsert the
   * (policyComponentId, componentDocumentId) source link with current values.
   * Returns the affected document id for Phase C reconciliation. Idempotent:
   * repeated calls neither duplicate the shared doc (mergeKey lookup) nor the
   * link (unique triple). Shared by _syncPolicyDocuments and
   * propagateActiveComponentDocument.
   */
  private async _materializePresetForSelection(
    tx: Prisma.TransactionClient,
    tenantId: string,
    caseId: string,
    selection: { id: string; componentId: string; policyAssignmentId: string },
    preset: { id: string; name: string; description: string | null; isMandatory: boolean; displayOrder: number; dedupeKey: string },
  ): Promise<string> {
    const mergeKey = `compdoc:${preset.dedupeKey}`;

    // 1. A document already carrying this key wins; prefer an active row, else
    //    revive the newest soft-deleted one (soft-deleted implies safe).
    let doc = await tx.docCaseDocument.findFirst({
      where:   { tenantId, caseId, requirementDedupeKey: mergeKey, deletedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!doc) {
      const revivable = await tx.docCaseDocument.findFirst({
        where:   { tenantId, caseId, requirementDedupeKey: mergeKey, deletedAt: { not: null } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      if (revivable) doc = await tx.docCaseDocument.update({ where: { id: revivable.id }, data: { deletedAt: null } });
    }

    // 2. Otherwise adopt a matching manual document rather than duplicating it.
    //    Adoption sets ONLY the key and never flips isComponentMerged, so the
    //    safe-delete origin gate keeps protecting a user-created row.
    if (!doc) {
      const candidates = await tx.docCaseDocument.findMany({
        where: {
          tenantId, caseId, deletedAt: null,
          requirementDedupeKey: null, policyComponentId: null, policyAssignmentId: null, isComponentMerged: false,
        },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const manual = candidates.find(c => normalizeDedupeKey(c.name) === preset.dedupeKey);
      if (manual) doc = await tx.docCaseDocument.update({ where: { id: manual.id }, data: { requirementDedupeKey: mergeKey } });
    }

    // 3. Otherwise create the shared requirement, appended after the current max
    //    (reads see prior creates in this same transaction). Policy pointers stay
    //    null: a merged row has N sources, so a 1:1 pointer would lie.
    if (!doc) {
      const max = await tx.docCaseDocument.aggregate({ where: { caseId, deletedAt: null }, _max: { displayOrder: true } });
      doc = await tx.docCaseDocument.create({
        data: {
          tenantId, caseId,
          name:                 preset.name,
          description:          preset.description,
          isMandatory:          preset.isMandatory,
          displayOrder:         (max._max.displayOrder ?? 0) + 1,
          verificationRequired: true,
          status:               'REQUESTED',
          metadataValues:       {},
          requirementDedupeKey: mergeKey,
          isComponentMerged:    true,
        },
      });
    }

    // 4. Upsert the link, always writing current values — a revived link must
    //    never keep pointing at a document that has since been replaced.
    const existingLink = await tx.docCaseDocumentComponentSource.findFirst({
      where: { tenantId, policyComponentId: selection.id, componentDocumentId: preset.id },
    });
    const linkData = {
      documentId:         doc.id,
      policyAssignmentId: selection.policyAssignmentId,
      componentId:        selection.componentId,
      isMandatoryAtLink:  preset.isMandatory,
      displayOrderAtLink: preset.displayOrder,
    };
    if (existingLink) {
      await tx.docCaseDocumentComponentSource.update({ where: { id: existingLink.id }, data: { ...linkData, deletedAt: null } });
    } else {
      await tx.docCaseDocumentComponentSource.create({
        data: { tenantId, caseId, policyComponentId: selection.id, componentDocumentId: preset.id, ...linkData },
      });
    }
    return doc.id;
  }

  /**
   * Recompute a touched document's mandatory flag from its active sources, and
   * retire it when no component still requires it and it is safe to remove.
   * Shared by _syncPolicyDocuments (Phase C) and propagateActiveComponentDocument.
   */
  private async _reconcilePolicyDocument(tx: Prisma.TransactionClient, tenantId: string, docId: string): Promise<void> {
    const doc = await tx.docCaseDocument.findFirst({
      where:   { id: docId, tenantId },
      include: { _count: { select: { storageRefs: true, events: true } } },
    });
    if (!doc) return;
    const sources = await tx.docCaseDocumentComponentSource.findMany({
      where:  { tenantId, documentId: doc.id, deletedAt: null },
      select: { isMandatoryAtLink: true },
    });

    if (sources.length > 0) {
      const isMandatory = sources.some(s => s.isMandatoryAtLink);
      await tx.docCaseDocument.update({
        where: { id: doc.id },
        // Never leave a document soft-deleted while active sources point at it.
        data:  { isMandatory, ...(doc.deletedAt ? { deletedAt: null } : {}) },
      });
      return;
    }

    // No sources left. Drop the mandatory flag, then retire the row only if it
    // originated from the component system and is still untouched.
    await tx.docCaseDocument.update({ where: { id: doc.id }, data: { isMandatory: false } });
    const componentOwned = doc.isComponentMerged || doc.policyComponentId != null;
    if (!componentOwned || !doc.requirementDedupeKey || doc.deletedAt) return;
    // Prisma cannot filter a relation _count, so active files need their own count.
    const activeFiles = await tx.document.count({ where: { tenantId, requirementId: doc.id, deletedAt: null, isActive: true } });
    const untouched =
      activeFiles === 0 && doc._count.storageRefs === 0 && doc._count.events === 0 &&
      (doc.notes == null || doc.notes === '') &&
      !doc.clientVisible && doc.clientVisibleAt == null &&
      doc.receivedAt == null && doc.verifiedAt == null && !doc.isWaived &&
      DESELECT_SAFE_STATUSES.includes(doc.status);
    if (untouched) await tx.docCaseDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
  }

  /**
   * Push one newly-active component-document preset into every case that already
   * has an active selection of the component. One locked transaction per case;
   * terminal and transferred-to-process cases are skipped. Best-effort from the
   * CRUD router — any case missed here self-heals on its next assignPolicies save
   * (Phase B no longer gates on documentsMaterializedAt).
   */
  async propagateActiveComponentDocument(ctx: TenantContext, componentId: string, componentDocumentId: string): Promise<void> {
    const preset = await this.prisma.caseTypeComponentDocument.findFirst({
      where: { id: componentDocumentId, tenantId: ctx.tenantId, componentId, isActive: true, deletedAt: null },
    });
    if (!preset) return; // archived/missing → nothing to propagate

    const selections = await this.prisma.docCasePolicyComponent.findMany({
      where:  { tenantId: ctx.tenantId, componentId, deletedAt: null },
      select: { id: true, caseId: true, componentId: true, policyAssignmentId: true },
    });
    const byCase = new Map<string, typeof selections>();
    for (const s of selections) {
      const arr = byCase.get(s.caseId) ?? [];
      arr.push(s);
      byCase.set(s.caseId, arr);
    }

    for (const [caseId, sels] of byCase) {
      await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "DocCase" WHERE id = ${caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
        if (locked.length === 0) return;
        const dc = await tx.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null }, select: { status: true } });
        // Skip terminal + TRANSFERRED_TO_PROCESS: the allow-list is exactly the
        // complement of those statuses.
        if (!dc || !ASSIGN_ALLOWED_STATUSES.includes(dc.status)) return;
        for (const sel of sels) {
          const docId = await this._materializePresetForSelection(tx, ctx.tenantId, caseId, sel, preset);
          await this._reconcilePolicyDocument(tx, ctx.tenantId, docId);
        }
        await this._recalcAndUpdateCase(tx, caseId, ctx.tenantId);
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId,
          eventType: 'COMPONENT_DOCUMENT_MATERIALIZED',
          entityType: 'DocCase',
          entityId: caseId,
          actorUserId: ctx.userId,
          operation: 'UPDATE',
          payload: { componentId, componentDocumentId },
        });
      }, { maxWait: 5000, timeout: 20000 });
    }
  }

  /**
   * One-time / manual reconcile: materialize the current component-document
   * presets for a single case's active selections. Same engine as the document
   * sync inside assignPolicies (Phase A/B/C via _syncPolicyDocuments), minus the
   * policy-selection diff — so it reuses _materializePresetForSelection for every
   * active selection without copying logic. Idempotent (mergeKey dedupe +
   * source-triple upsert). Skips terminal / transferred cases. Used only by
   * scripts/reconcile-component-documents.ts; not wired to any route or boot.
   */
  async reconcileCaseComponentDocuments(ctx: TenantContext, caseId: string): Promise<{ status: string; before: number; after: number; skipped: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "DocCase" WHERE id = ${caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) throw new ResourceNotFoundError();
      const dc = await tx.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null }, select: { status: true } });
      if (!dc) throw new ResourceNotFoundError();
      if (!ASSIGN_ALLOWED_STATUSES.includes(dc.status)) {
        return { status: dc.status, before: 0, after: 0, skipped: true };
      }
      const before = await tx.docCaseDocument.count({ where: { caseId, tenantId: ctx.tenantId, deletedAt: null } });
      await this._syncPolicyDocuments(tx, ctx.tenantId, caseId);
      await this._recalcAndUpdateCase(tx, caseId, ctx.tenantId);
      const after = await tx.docCaseDocument.count({ where: { caseId, tenantId: ctx.tenantId, deletedAt: null } });
      if (after !== before) {
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId,
          eventType: 'COMPONENT_DOCUMENT_MATERIALIZED',
          entityType: 'DocCase',
          entityId: caseId,
          actorUserId: ctx.userId,
          operation: 'UPDATE',
          payload: { reconcile: true, before, after },
        });
      }
      return { status: dc.status, before, after, skipped: false };
    }, { maxWait: 5000, timeout: 20000 });
  }

  async getDashboardKPIs(ctx: TenantContext) {
    const [
      totalCases,
      activeCases,
      readyCases,
      transferredCases,
      pendingVerification,
      overdueDocCount,
    ] = await this.prisma.$transaction([
      this.prisma.docCase.count({ where: { tenantId: ctx.tenantId, deletedAt: null } }),
      this.prisma.docCase.count({ where: { tenantId: ctx.tenantId, deletedAt: null, status: 'ACTIVE' } }),
      this.prisma.docCase.count({ where: { tenantId: ctx.tenantId, deletedAt: null, isReady: true, status: 'DOCUMENTATION_READY' } }),
      this.prisma.docCase.count({ where: { tenantId: ctx.tenantId, deletedAt: null, status: 'TRANSFERRED_TO_PROCESS' } }),
      this.prisma.docCaseDocument.count({ where: { tenantId: ctx.tenantId, deletedAt: null, status: 'UNDER_VERIFICATION' } }),
      this.prisma.docCaseDocument.count({ where: { tenantId: ctx.tenantId, deletedAt: null, status: 'EXPIRED' } }),
    ]);

    // Today's activity
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEvents = await this.prisma.docCaseEvent.count({
      where: { tenantId: ctx.tenantId, createdAt: { gte: today } },
    });

    // Rejected documents (active cases)
    const rejectedDocs = await this.prisma.docCaseDocument.count({
      where: { tenantId: ctx.tenantId, deletedAt: null, status: 'REJECTED' },
    });

    return {
      totalCases,
      activeCases,
      readyCases,
      transferredCases,
      pendingVerification,
      overdueDocCount,
      rejectedDocs,
      todayActivity: todayEvents,
    };
  }

  // ─── DOCUMENTS ─────────────────────────────────────────────────────────────

  async addDocumentToCase(
    ctx: TenantContext,
    caseId: string,
    input: {
      name:                  string;
      description?:          string;
      isMandatory?:          boolean;
      isBlocking?:           boolean;
      displayOrder?:         number;
      verificationRequired?: boolean;
      expiryTrackingEnabled?: boolean;
      notes?:                string;
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const docCase = await tx.docCase.findFirst({
        where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!docCase) throw new ResourceNotFoundError();
      if (!['ACTIVE', 'DOCUMENTATION_READY'].includes(docCase.status)) throw new BusinessRuleViolationError();

      const maxOrder = await tx.docCaseDocument.aggregate({
        where:   { caseId, deletedAt: null },
        _max:    { displayOrder: true },
      });

      const doc = await tx.docCaseDocument.create({
        data: {
          tenantId:              ctx.tenantId,
          caseId,
          name:                  input.name,
          description:           input.description ?? null,
          isMandatory:           input.isMandatory ?? true,
          isBlocking:            input.isBlocking ?? false,
          displayOrder:          input.displayOrder ?? (maxOrder._max.displayOrder ?? 0) + 1,
          verificationRequired:  input.verificationRequired ?? true,
          expiryTrackingEnabled: input.expiryTrackingEnabled ?? false,
          notes:                 input.notes ?? null,
          status:                'REQUESTED',
          metadataValues:        {},
        },
      });

      await this._recalcAndUpdateCase(tx, caseId, ctx.tenantId);

      return doc;
    });
  }

  async updateDocumentStatus(
    ctx: TenantContext,
    documentId: string,
    input: {
      status:            DocDocumentStatus;
      remarks?:          string;
      rejectionReason?:  string;
      waivedReason?:     string;
      expiryDate?:       Date;
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.docCaseDocument.findFirst({
        where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null },
        include: { case: true },
      });
      if (!doc) throw new ResourceNotFoundError();

      assertValidTransition(doc.status, input.status);

      const now = new Date();
      const updateData: Prisma.DocCaseDocumentUpdateInput = {
        status: input.status,
        notes:  input.remarks ? (doc.notes ? `${doc.notes}\n${input.remarks}` : input.remarks) : doc.notes,
        ...(input.status === 'RECEIVED'            ? { receivedAt: now } : {}),
        ...(input.status === 'APPROVED'            ? { verifiedAt: now, verifiedBy: ctx.userId, verificationRemarks: input.remarks ?? null } : {}),
        ...(input.status === 'REJECTED'            ? { rejectionReason: input.rejectionReason ?? null } : {}),
        ...(input.status === 'WAIVED'              ? { isWaived: true, waivedBy: ctx.userId, waivedReason: input.waivedReason ?? null } : {}),
        ...(input.status === 'UNDER_VERIFICATION'  ? { verifiedBy: ctx.userId } : {}),
        ...(input.expiryDate                       ? { expiryDate: input.expiryDate } : {}),
      };

      await tx.docCaseDocument.update({ where: { id: documentId }, data: updateData });

      // Determine event type
      const eventTypeMap: Partial<Record<DocDocumentStatus, DocEventType>> = {
        RECEIVED:           'DOCUMENT_RECEIVED',
        UNDER_VERIFICATION: 'DOCUMENT_VERIFIED',
        APPROVED:           'DOCUMENT_APPROVED',
        REJECTED:           'DOCUMENT_REJECTED',
        WAIVED:             'DOCUMENT_WAIVED',
      };

      await tx.docCaseEvent.create({
        data: {
          tenantId:    ctx.tenantId,
          caseId:      doc.caseId,
          documentId,
          eventType:   eventTypeMap[input.status] ?? 'DOCUMENT_STATUS_CHANGED',
          actorUserId: ctx.userId,
          fromStatus:  doc.status,
          toStatus:    input.status,
          remarks:     input.remarks ?? null,
          payload:     {} as Prisma.InputJsonValue,
        },
      });

      await this._recalcAndUpdateCase(tx, doc.caseId, ctx.tenantId);

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_DOCUMENT_STATUS_CHANGED', entityType: 'DocCaseDocument', entityId: documentId,
        operation: 'UPDATE',
        payload:   { documentName: doc.name, fromStatus: doc.status, toStatus: input.status },
        beforeState: { status: doc.status },
        afterState:  { status: input.status },
      });

      return tx.docCaseDocument.findFirst({
        where: { id: documentId },
        include: { storageRefs: true },
      });
    });
  }

  async addStorageRef(
    ctx: TenantContext,
    documentId: string,
    input: {
      storageType: DocStorageType;
      reference:   string;
      label?:      string;
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.docCaseDocument.findFirst({
        where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc) throw new ResourceNotFoundError();

      const ref = await tx.docStorageRef.create({
        data: {
          tenantId:    ctx.tenantId,
          documentId,
          storageType: input.storageType,
          reference:   input.reference,
          label:       input.label ?? null,
          addedBy:     ctx.userId,
        },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId:    ctx.tenantId,
          caseId:      doc.caseId,
          documentId,
          eventType:   'STORAGE_REF_ADDED',
          actorUserId: ctx.userId,
          payload:     { storageType: input.storageType, label: input.label ?? null } as unknown as Prisma.InputJsonValue,
        },
      });

      return ref;
    });
  }

  async addNote(
    ctx: TenantContext,
    caseId: string,
    input: { noteType: DocNoteType; content: string }
  ) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!docCase) throw new ResourceNotFoundError();

    const note = await this.prisma.docCaseNote.create({
      data: {
        tenantId:  ctx.tenantId,
        caseId,
        noteType:  input.noteType,
        content:   input.content,
        createdBy: ctx.userId,
      },
    });

    await this.prisma.docCaseEvent.create({
      data: {
        tenantId:    ctx.tenantId,
        caseId,
        eventType:   'NOTE_ADDED',
        actorUserId: ctx.userId,
        payload:     { noteType: input.noteType } as unknown as Prisma.InputJsonValue,
      },
    });

    return note;
  }

  async addReminder(
    ctx: TenantContext,
    caseId: string,
    input: { reminderDate: Date; dueDate?: Date; message?: string; documentId?: string }
  ) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!docCase) throw new ResourceNotFoundError();

    return this.prisma.docReminder.create({
      data: {
        tenantId:    ctx.tenantId,
        caseId,
        documentId:  input.documentId ?? null,
        reminderDate: input.reminderDate,
        dueDate:     input.dueDate ?? null,
        message:     input.message ?? null,
        createdBy:   ctx.userId,
      },
    });
  }

  // ─── MANAGER OVERRIDE ──────────────────────────────────────────────────────

  async managerOverride(
    ctx: TenantContext,
    caseId: string,
    input: { reason: string; expiresAt?: Date }
  ) {
    if (!input.reason?.trim()) throw new ValidationError('Override reason is required.');

    return this.prisma.$transaction(async (tx) => {
      const docCase = await tx.docCase.findFirst({
        where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!docCase) throw new ResourceNotFoundError();

      const override = await tx.docManagerOverride.create({
        data: {
          tenantId:     ctx.tenantId,
          caseId,
          overriddenBy: ctx.userId,
          reason:       input.reason.trim(),
          expiresAt:    input.expiresAt ?? null,
        },
      });

      await tx.docCase.update({
        where: { id: caseId },
        data:  { isReady: true, status: 'DOCUMENTATION_READY' },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId:    ctx.tenantId,
          caseId,
          eventType:   'MANAGER_OVERRIDE',
          actorUserId: ctx.userId,
          remarks:     input.reason,
          payload:     {} as Prisma.InputJsonValue,
        },
      });

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_MANAGER_OVERRIDE', entityType: 'DocCase', entityId: caseId,
        operation: 'UPDATE', payload: { reason: input.reason },
      });

      return override;
    });
  }

  // ─── TRANSFER TO PROCESS ───────────────────────────────────────────────────

  async transferToProcess(ctx: TenantContext, caseId: string) {
    return this.prisma.$transaction(async (tx) => {
      const docCase = await tx.docCase.findFirst({
        where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!docCase) throw new ResourceNotFoundError();

      // Must be ready or have manager override
      if (!docCase.isReady) {
        const override = await tx.docManagerOverride.findFirst({
          where: { caseId, tenantId: ctx.tenantId },
          orderBy: { allowedAt: 'desc' },
        });
        if (!override) throw new BusinessRuleViolationError();
      }

      if (docCase.status === 'TRANSFERRED_TO_PROCESS') throw new BusinessRuleViolationError();

      const now = new Date();
      await tx.docCase.update({
        where: { id: caseId },
        data: {
          status:        'TRANSFERRED_TO_PROCESS',
          transferredAt: now,
          transferredBy: ctx.userId,
        },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId:    ctx.tenantId,
          caseId,
          eventType:   'TRANSFERRED_TO_PROCESS',
          actorUserId: ctx.userId,
          payload:     { transferredAt: now.toISOString() } as unknown as Prisma.InputJsonValue,
        },
      });

      await this.audit.log({
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOC_CASE_TRANSFERRED', entityType: 'DocCase', entityId: caseId,
        operation: 'UPDATE', payload: { status: 'TRANSFERRED_TO_PROCESS' },
      });

      return tx.docCase.findFirst({ where: { id: caseId }, include: { lead: true, preset: true } });
    });
  }

  /**
   * Apply a validated DocCaseDocument status transition inside an EXISTING transaction.
   * Used by DocumentService when a firm upload lands on a requirement. Returns:
   *  'applied'     — transition performed (+ event + case recalc)
   *  'noop'        — target equals current status
   *  'unreachable' — not a valid next status; caller leaves the status and logs a divergence (I3/I6)
   */
  async transitionRequirementInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    requirementId: string,
    toStatus: DocDocumentStatus,
  ): Promise<'applied' | 'noop' | 'unreachable'> {
    const doc = await tx.docCaseDocument.findFirst({
      where: { id: requirementId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, status: true, caseId: true },
    });
    if (!doc) throw new ResourceNotFoundError();
    if (doc.status === toStatus) return 'noop';
    if (!VALID_TRANSITIONS[doc.status].includes(toStatus)) return 'unreachable';

    const now = new Date();
    await tx.docCaseDocument.update({
      where: { id: requirementId },
      data: {
        status: toStatus,
        ...(toStatus === 'RECEIVED' ? { receivedAt: now } : {}),
        ...(toStatus === 'APPROVED' ? { verifiedAt: now, verifiedBy: ctx.userId } : {}),
      },
    });
    const eventTypeMap: Partial<Record<DocDocumentStatus, DocEventType>> = {
      RECEIVED: 'DOCUMENT_RECEIVED', UNDER_VERIFICATION: 'DOCUMENT_VERIFIED', APPROVED: 'DOCUMENT_APPROVED',
      REJECTED: 'DOCUMENT_REJECTED', WAIVED: 'DOCUMENT_WAIVED',
    };
    await tx.docCaseEvent.create({
      data: {
        tenantId: ctx.tenantId, caseId: doc.caseId, documentId: requirementId,
        eventType: eventTypeMap[toStatus] ?? 'DOCUMENT_STATUS_CHANGED', actorUserId: ctx.userId,
        fromStatus: doc.status, toStatus, payload: {} as Prisma.InputJsonValue,
      },
    });
    await this._recalcAndUpdateCase(tx, doc.caseId, ctx.tenantId);
    return 'applied';
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async _recalcAndUpdateCase(
    tx: Prisma.TransactionClient,
    caseId: string,
    tenantId: string
  ) {
    const current = await tx.docCase.findFirst({
      where: { id: caseId, tenantId, deletedAt: null },
      select: { status: true },
    });
    if (!current) return;

    if (TERMINAL_STATUSES.includes(current.status)) {
      logger.debug(
        { caseId, tenantId, currentStatus: current.status, reason: 'TERMINAL_SKIP' },
        'Case recalc skipped: case is terminal'
      );
      return;
    }

    const docs = await tx.docCaseDocument.findMany({
      where: { caseId, tenantId },
      select: { isMandatory: true, status: true, deletedAt: true },
    });
    const progress = calcProgress(docs);
    const newStatus: DocCaseStatus = progress.isReady ? 'DOCUMENTATION_READY' : 'ACTIVE';

    const statusResult = await tx.docCase.updateMany({
      where: { id: caseId, tenantId, deletedAt: null, status: { in: RECALC_MUTABLE_STATUSES } },
      data: { ...progress, status: newStatus },
    });

    if (statusResult.count === 0) {
      // Case was not in a recalc-mutable status (PROTECTED_NON_TERMINAL, e.g. mid-handoff) —
      // refresh progress counters only, never the status. Excluding TERMINAL_STATUSES here
      // (rather than matching PROTECTED_NON_TERMINAL_STATUSES) keeps this race-safe: a case
      // that transitioned into terminal between step 1 and here is correctly left untouched.
      const protectedResult = await tx.docCase.updateMany({
        where: { id: caseId, tenantId, deletedAt: null, status: { notIn: TERMINAL_STATUSES } },
        data: { ...progress },
      });

      if (protectedResult.count === 1) {
        logger.debug(
          { caseId, tenantId, currentStatus: current.status, reason: 'PROTECTED_STATUS_SKIP', statusUpdateCount: statusResult.count, protectedUpdateCount: protectedResult.count },
          'Case recalc: status update skipped (protected non-terminal status), progress refreshed'
        );
      } else {
        // count === 0: the case moved to a terminal status (or vanished) concurrently between
        // step 1 and here — ambiguous outcome, not a clean PROTECTED_STATUS_SKIP.
        logger.warn(
          { caseId, tenantId, currentStatus: current.status, reason: 'STATUS_CHANGED_CONCURRENTLY', statusUpdateCount: statusResult.count, protectedUpdateCount: protectedResult.count },
          'Case recalc: status changed concurrently, no update applied'
        );
      }
    }
  }
}

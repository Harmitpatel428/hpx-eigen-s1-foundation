import {
  PrismaClient,
  DocDocumentStatus,
  DocCaseStatus,
  DocEventType,
  DocNoteType,
  DocStorageType,
  DocPresetCategory,
  Prisma,
} from '@prisma/client';
import { AuditService } from './audit.service';
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

    return this.prisma.$transaction(async (tx) => {
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

      return this.getCaseById(ctx, docCase.id);
    });
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
    } = {}
  ) {
    const page     = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, filters.pageSize ?? 25);
    const skip     = (page - 1) * pageSize;

    const where: Prisma.DocCaseWhereInput = {
      tenantId:  ctx.tenantId,
      deletedAt: null,
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

    const [data, total] = await this.prisma.$transaction([
      this.prisma.docCase.findMany({
        where,
        include: {
          lead:   { select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true } },
          preset: { select: { id: true, name: true, category: true, color: true, icon: true } },
          _count: { select: { documents: true, caseNotes: true, reminders: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.docCase.count({ where }),
    ]);

    return { data, total, page, pageSize };
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
          include: { storageRefs: { orderBy: { createdAt: 'desc' } } },
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
        _count: { select: { documents: true } },
      },
    });
    if (!docCase) throw new ResourceNotFoundError();
    return docCase;
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

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async _recalcAndUpdateCase(
    tx: Prisma.TransactionClient,
    caseId: string,
    tenantId: string
  ) {
    const docs = await tx.docCaseDocument.findMany({
      where: { caseId, tenantId },
      select: { isMandatory: true, status: true, deletedAt: true },
    });
    const progress = calcProgress(docs);

    let newStatus: DocCaseStatus = 'ACTIVE';
    if (progress.isReady) newStatus = 'DOCUMENTATION_READY';

    await tx.docCase.update({
      where: { id: caseId },
      data: { ...progress, status: newStatus },
    });
  }
}

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, DocCaseStatus, DocDocumentStatus, DocNoteType, DocStorageType, DocPresetCategory, DocumentStatus, DocumentSourceChannel } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { DocumentationService, getSuggestions } from '../services/documentation.service';
import { DocumentService } from '../services/document.service';
import { DocActivitiesService, DocActivityFilter } from '../services/doc-activities.service';
import { DocActivityType } from '@prisma/client';
import { checkFirmUploadUrlAttempts } from '../services/auth/RateLimitService';
import { ValidationError } from '../types/exceptions';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { CaseReportsService } from '../services/case-reports.service';
import archiver from 'archiver';
import { logger } from '../utils/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRM_SOURCE_CHANNELS = ['WHATSAPP', 'EMAIL', 'PHYSICAL', 'FIRM_UPLOAD', 'OTHER'] as const;
const DOC_MIME_ALLOWLIST = ['application/pdf', 'image/jpeg', 'image/png'];
const DOC_MAX_BYTES = 5 * 1024 * 1024;

/** One safe ZIP path segment: strip path separators + control chars, collapse whitespace, fall back if empty. */
function safeSegment(s: string, fallback: string): string {
  const cleaned = String(s ?? '').replace(/[/\\]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

/** Dedupe a filename within a set by inserting " (n)" before the extension; tracks lowercased names. */
function dedupeName(used: Set<string>, name: string): string {
  const take = (n: string) => { used.add(n.toLowerCase()); return n; };
  if (!used.has(name.toLowerCase())) return take(name);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (used.has(`${base} (${n})${ext}`.toLowerCase())) n++;
  return take(`${base} (${n})${ext}`);
}

/** Read a permission from the authed user's manifest (string scope or V2 decision). */
function hasPermission(req: Request, slug: string): boolean {
  const perms = (req as AuthenticatedRequest).user?.permissions as Record<string, unknown> | undefined;
  const v = perms?.[slug];
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return true;
  return (v as { allowed?: boolean }).allowed === true;
}

export function createDocumentationRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc      = new DocumentationService(prisma);
  const docFiles = new DocumentService(prisma);
  const docActs  = new DocActivitiesService(prisma);

  // ─── PRESETS ───────────────────────────────────────────────────────────────

  /** GET /api/v1/documentation/presets */
  router.get('/presets', authMiddleware, permissionMiddleware('doc:preset:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const includeInactive = req.query.includeInactive === 'true';
        const presets = await svc.listPresets({ tenantId, userId }, includeInactive);
        res.json({ success: true, data: presets });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/presets/suggestions */
  router.post('/presets/suggestions', authMiddleware, permissionMiddleware('doc:preset:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { name } = req.body as { name: string };
        if (!name?.trim()) throw new ValidationError('name is required.');
        res.json({ success: true, data: getSuggestions(name) });
      } catch (err) { next(err); }
    }
  );

  /** GET /api/v1/documentation/presets/:id */
  router.get('/presets/:id', authMiddleware, permissionMiddleware('doc:preset:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const preset = await svc.getPreset({ tenantId, userId }, req.params.id);
        res.json({ success: true, data: preset });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/presets */
  router.post('/presets', authMiddleware, permissionMiddleware('doc:preset:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { name, description, category, color, icon, items = [] } = req.body as {
          name: string;
          description?: string;
          category?: DocPresetCategory;
          color?: string;
          icon?: string;
          items?: Array<{
            name: string; description?: string; isMandatory?: boolean; isBlocking?: boolean;
            displayOrder?: number; verificationRequired?: boolean; expiryTrackingEnabled?: boolean;
            expiryDays?: number; metadataFields?: unknown[]; notes?: string; conditionRule?: unknown;
          }>;
        };
        if (!name?.trim()) throw new ValidationError('name is required.');
        const preset = await svc.createPreset({ tenantId, userId }, { name, description, category, color, icon, items });
        res.status(201).json({ success: true, data: preset });
      } catch (err) { next(err); }
    }
  );

  /** PUT /api/v1/documentation/presets/:id */
  router.put('/presets/:id', authMiddleware, permissionMiddleware('doc:preset:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const updated = await svc.updatePreset({ tenantId, userId }, req.params.id, req.body);
        res.json({ success: true, data: updated });
      } catch (err) { next(err); }
    }
  );

  /** DELETE /api/v1/documentation/presets/:id */
  router.delete('/presets/:id', authMiddleware, permissionMiddleware('doc:preset:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        await svc.deletePreset({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) { next(err); }
    }
  );

  // ─── CASES ─────────────────────────────────────────────────────────────────

  /** GET /api/v1/documentation/cases */
  router.get('/cases', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { status, assignedTo, isReady, search, page, pageSize, fieldFilters, sortBy, sortDir } = req.query as {
          status?: string; assignedTo?: string; isReady?: string; search?: string;
          page?: string; pageSize?: string; fieldFilters?: string; sortBy?: string; sortDir?: string;
        };
        // ponytail: fieldFilters is a JSON-encoded query param — keeps GET /cases as the one list endpoint rather than adding POST /cases/search
        let parsedFilters: { fieldId: string; operator: string; value?: unknown }[] | undefined;
        if (fieldFilters !== undefined) {
          try { parsedFilters = JSON.parse(fieldFilters); } catch { throw new ValidationError('fieldFilters must be valid JSON.'); }
          if (!Array.isArray(parsedFilters)) throw new ValidationError('fieldFilters must be a JSON array.');
        }
        // Callers without doc:case:view-all only see cases they are assigned to / own (union scope).
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const result = await svc.listCases({ tenantId, userId }, {
          restrictToUserId: canViewAll ? undefined : userId,
          status:     status as DocCaseStatus | undefined,
          assignedTo,
          isReady:    isReady !== undefined ? isReady === 'true' : undefined,
          search,
          fieldFilters: parsedFilters, sortBy, sortDir,
          page:       page     ? parseInt(page)     : undefined,
          pageSize:   pageSize ? parseInt(pageSize) : undefined,
        });
        res.json({ success: true, ...result });
      } catch (err) { next(err); }
    }
  );

  // ── Operational reports (engine-gated; literal paths, no collision with /cases/:id) ──
  const reports = new CaseReportsService(prisma);
  const reportGates = [authMiddleware, requireCaseEngineEnabled(prisma), permissionMiddleware('doc:view')];
  const ctxOf = (req: Request) => { const { tenantId, userId } = (req as AuthenticatedRequest).user; return { tenantId, userId }; };

  router.get('/reports/overdue-by-stage', ...reportGates, permissionMiddleware('case-timeline:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try { res.json({ success: true, data: await reports.overdueByStage(ctxOf(req)) }); } catch (err) { next(err); }
    }
  );
  router.get('/reports/on-time-vs-late', ...reportGates, permissionMiddleware('case-timeline:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try { res.json({ success: true, data: await reports.onTimeVsLate(ctxOf(req)) }); } catch (err) { next(err); }
    }
  );
  router.get('/reports/cases-by-option', ...reportGates,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const fieldId = req.query.fieldId;
        if (typeof fieldId !== 'string' || !UUID_RE.test(fieldId)) throw new ValidationError('fieldId (uuid) is required.');
        res.json({ success: true, data: await reports.casesByOption(ctxOf(req), fieldId) });
      } catch (err) { next(err); }
    }
  );

  /** GET /api/v1/documentation/dashboard */
  router.get('/dashboard', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const kpis = await svc.getDashboardKPIs({ tenantId, userId }, { restrictToUserId: canViewAll ? undefined : userId });
        res.json({ success: true, data: kpis });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases */
  router.post('/cases', authMiddleware, permissionMiddleware('doc:create'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { leadId, presetId, assignedTo, dueDate, priority, notes } = req.body as {
          leadId: string; presetId?: string; assignedTo?: string;
          dueDate?: string; priority?: number; notes?: string;
        };
        if (!leadId) throw new ValidationError('leadId is required.');
        const docCase = await svc.createCase({ tenantId, userId }, {
          leadId, presetId, assignedTo,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          priority, notes,
        });
        res.status(201).json({ success: true, data: docCase });
      } catch (err) { next(err); }
    }
  );

  /** GET /api/v1/documentation/cases/:id */
  router.get('/cases/:id', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const docCase = await svc.getCaseById({ tenantId, userId }, req.params.id, { restrictToUserId: canViewAll ? undefined : userId });
        res.json({ success: true, data: docCase });
      } catch (err) { next(err); }
    }
  );

  // ─── DOC ACTIVITIES (Documentation-only; never surfaces in Sales /activities) ──

  const VALID_DOC_FILTERS: DocActivityFilter[] = ['ALL', 'DUE_TODAY', 'UPCOMING', 'OVERDUE', 'MINE'];

  /** GET /api/v1/documentation/activities?filter=&page=&pageSize= */
  router.get('/activities', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const filter = (req.query.filter as DocActivityFilter) ?? 'ALL';
        if (!VALID_DOC_FILTERS.includes(filter)) throw new ValidationError('Invalid filter value.');
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;
        if (page < 1 || isNaN(page)) throw new ValidationError('page must be a positive integer.');
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) throw new ValidationError('pageSize must be between 1 and 200.');
        const result = await docActs.listGlobal(
          { tenantId, userId }, canViewAll ? undefined : userId, filter, page, pageSize,
        );
        res.json({ success: true, ...result });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:caseId/activities */
  router.post('/cases/:caseId/activities', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const { type, subject, scheduledAt, metadata } = req.body as {
          type: DocActivityType; subject: string; scheduledAt?: string; metadata?: Record<string, unknown>;
        };
        const activity = await docActs.create(
          { tenantId, userId }, canViewAll ? undefined : userId, req.params.caseId,
          { type, subject, scheduledAt, metadata },
        );
        res.status(201).json({ success: true, data: activity });
      } catch (err) { next(err); }
    }
  );

  /** PATCH /api/v1/documentation/activities/:id — update follow-up date and/or notes in place */
  router.patch('/activities/:id', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const { scheduledAt, notes } = req.body as { scheduledAt?: string; notes?: string };
        const updated = await docActs.update(
          { tenantId, userId }, canViewAll ? undefined : userId, req.params.id, { scheduledAt, notes },
        );
        res.json({ success: true, data: updated });
      } catch (err) { next(err); }
    }
  );

  /** PATCH /api/v1/documentation/activities/:id/complete */
  router.patch('/activities/:id/complete', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const { nextFollowUp, note } = req.body as { nextFollowUp?: string; note?: string };
        const completed = await docActs.complete(
          { tenantId, userId }, canViewAll ? undefined : userId, req.params.id, { nextFollowUp, note },
        );
        res.json({ success: true, data: completed });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/activities/bulk-complete — complete many visible PENDING activities */
  router.post('/activities/bulk-complete', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const { ids } = req.body as { ids?: string[] };
        const result = await docActs.bulkComplete({ tenantId, userId }, canViewAll ? undefined : userId, ids ?? []);
        res.json({ success: true, ...result });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:id/transfer */
  router.post('/cases/:id/transfer', authMiddleware, permissionMiddleware('doc:transfer'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { remarks } = (req.body ?? {}) as { remarks?: unknown };
        if (remarks !== undefined && remarks !== null) {
          if (typeof remarks !== 'string') throw new ValidationError('remarks must be a string.');
          if (remarks.length > 2000) throw new ValidationError('remarks must be 2000 characters or fewer.');
        }
        const result = await svc.transferToProcess(
          { tenantId, userId }, req.params.id, typeof remarks === 'string' ? remarks : undefined,
        );
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:id/override */
  router.post('/cases/:id/override', authMiddleware, permissionMiddleware('doc:override'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { reason, expiresAt } = req.body as { reason: string; expiresAt?: string };
        if (!reason?.trim()) throw new ValidationError('reason is required.');
        const result = await svc.managerOverride({ tenantId, userId }, req.params.id, {
          reason,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        });
        res.status(201).json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:id/notes */
  router.post('/cases/:id/notes', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { noteType, content } = req.body as { noteType: DocNoteType; content: string };
        if (!content?.trim()) throw new ValidationError('content is required.');
        const note = await svc.addNote({ tenantId, userId }, req.params.id, {
          noteType: noteType ?? 'INTERNAL', content,
        });
        res.status(201).json({ success: true, data: note });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:id/reminders */
  router.post('/cases/:id/reminders', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { reminderDate, dueDate, message, documentId } = req.body as {
          reminderDate: string; dueDate?: string; message?: string; documentId?: string;
        };
        if (!reminderDate) throw new ValidationError('reminderDate is required.');
        const reminder = await svc.addReminder({ tenantId, userId }, req.params.id, {
          reminderDate: new Date(reminderDate),
          dueDate:      dueDate ? new Date(dueDate) : undefined,
          message, documentId,
        });
        res.status(201).json({ success: true, data: reminder });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:id/documents */
  router.post('/cases/:id/documents', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { name, description, isMandatory, isBlocking, displayOrder, verificationRequired, expiryTrackingEnabled, notes } = req.body as {
          name: string; description?: string; isMandatory?: boolean; isBlocking?: boolean;
          displayOrder?: number; verificationRequired?: boolean; expiryTrackingEnabled?: boolean; notes?: string;
        };
        if (!name?.trim()) throw new ValidationError('name is required.');
        const doc = await svc.addDocumentToCase({ tenantId, userId }, req.params.id, {
          name, description, isMandatory, isBlocking, displayOrder, verificationRequired, expiryTrackingEnabled, notes,
        });
        res.status(201).json({ success: true, data: doc });
      } catch (err) { next(err); }
    }
  );

  // ─── DOCUMENTS ─────────────────────────────────────────────────────────────

  /** PATCH /api/v1/documentation/documents/:id/status */
  router.patch('/documents/:id/status', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { status, remarks, rejectionReason, expiryDate } = req.body as {
          status: DocDocumentStatus; remarks?: string; rejectionReason?: string;
          expiryDate?: string;
        };
        if (!status) throw new ValidationError('status is required.');
        const doc = await svc.updateDocumentStatus({ tenantId, userId }, req.params.id, {
          status, remarks, rejectionReason,
          expiryDate: expiryDate ? new Date(expiryDate) : undefined,
        }, hasPermission(req, 'doc:verify'));
        res.json({ success: true, data: doc });
      } catch (err) { next(err); }
    }
  );

  /** PATCH /api/v1/documentation/documents/:id/verify */
  router.patch('/documents/:id/verify', authMiddleware, permissionMiddleware('doc:verify'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { result, remarks } = req.body as { result: 'APPROVED' | 'REJECTED'; remarks?: string; rejectionReason?: string; documentDate?: string };
        if (!result || !['APPROVED', 'REJECTED'].includes(result)) throw new ValidationError('result must be APPROVED or REJECTED.');
        const doc = await svc.updateDocumentStatus({ tenantId, userId }, req.params.id, {
          status:           result as DocDocumentStatus,
          remarks,
          rejectionReason:  req.body.rejectionReason,
          documentDate:     req.body.documentDate,
        }, true); // route already enforces doc:verify
        res.json({ success: true, data: doc });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/documents/:id/storage-refs */
  router.post('/documents/:id/storage-refs', authMiddleware, permissionMiddleware('doc:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { storageType, reference, label } = req.body as {
          storageType: DocStorageType; reference: string; label?: string;
        };
        if (!storageType || !reference?.trim()) throw new ValidationError('storageType and reference are required.');
        const ref = await svc.addStorageRef({ tenantId, userId }, req.params.id, { storageType, reference, label });
        res.status(201).json({ success: true, data: ref });
      } catch (err) { next(err); }
    }
  );

  // ─── UNIFIED DOCUMENT FILES (firm direct upload) ─────────────────────────────

  /** POST /api/v1/documentation/cases/:caseId/files/upload-url */
  router.post('/cases/:caseId/files/upload-url', authMiddleware, permissionMiddleware('doc:upload'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.caseId)) throw new ValidationError('Invalid caseId.');
        const { fileName, contentType, fileSizeBytes } = req.body as { fileName?: string; contentType?: string; fileSizeBytes?: number };
        if (!fileName || typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255) throw new ValidationError('fileName is required (1-255 characters).');
        if (!contentType || typeof contentType !== 'string' || !DOC_MIME_ALLOWLIST.includes(contentType)) throw new ValidationError(`contentType must be one of: ${DOC_MIME_ALLOWLIST.join(', ')}.`);
        if (typeof fileSizeBytes !== 'number' || !Number.isInteger(fileSizeBytes) || fileSizeBytes < 1 || fileSizeBytes > DOC_MAX_BYTES) throw new ValidationError(`fileSizeBytes must be an integer between 1 and ${DOC_MAX_BYTES}.`);
        await checkFirmUploadUrlAttempts(userId, tenantId);
        const result = await docFiles.uploadUrl({ tenantId, userId }, req.params.caseId, { fileName, contentType, fileSizeBytes });
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:caseId/files/confirm-upload */
  router.post('/cases/:caseId/files/confirm-upload', authMiddleware, permissionMiddleware('doc:upload'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.caseId)) throw new ValidationError('Invalid caseId.');
        const b = req.body as Record<string, unknown>;
        if (typeof b.uploadId !== 'string' || !UUID_RE.test(b.uploadId)) throw new ValidationError('uploadId is required (uuid).');
        if (typeof b.fileName !== 'string' || b.fileName.length < 1 || b.fileName.length > 255) throw new ValidationError('fileName is required (1-255 characters).');
        if (b.category !== 'REQUIREMENT' && b.category !== 'GENERAL') throw new ValidationError("category must be 'REQUIREMENT' or 'GENERAL'.");
        if (b.category === 'GENERAL' && (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.length > 200)) throw new ValidationError('name is required for a GENERAL document (1-200 characters).');
        if (b.name !== undefined && b.name !== null && (typeof b.name !== 'string' || b.name.length > 200)) throw new ValidationError('name must be at most 200 characters.');
        if (b.category === 'REQUIREMENT' && (typeof b.requirementId !== 'string' || !UUID_RE.test(b.requirementId))) throw new ValidationError('requirementId (uuid) is required for a REQUIREMENT document.');
        if (typeof b.sourceChannel !== 'string' || !(FIRM_SOURCE_CHANNELS as readonly string[]).includes(b.sourceChannel)) throw new ValidationError(`sourceChannel must be one of: ${FIRM_SOURCE_CHANNELS.join(', ')}.`);
        if (b.internalNote !== undefined && b.internalNote !== null && (typeof b.internalNote !== 'string' || b.internalNote.length > 2000)) throw new ValidationError('internalNote must be at most 2000 characters.');
        if (b.clientVisible !== undefined && typeof b.clientVisible !== 'boolean') throw new ValidationError('clientVisible must be a boolean.');
        if (b.verify !== undefined && typeof b.verify !== 'boolean') throw new ValidationError('verify must be a boolean.');

        const caseRow = await prisma.docCase.findFirst({ where: { id: req.params.caseId, tenantId }, select: { createdAt: true } });
        let receivedAt: Date | null = null;
        if (b.receivedAt !== undefined && b.receivedAt !== null) {
          const d = new Date(b.receivedAt as string);
          if (isNaN(d.getTime()) || d.getTime() > Date.now() || (caseRow && d.getTime() < caseRow.createdAt.getTime())) throw new ValidationError('receivedAt must be an ISO datetime no later than now and no earlier than the case creation.');
          receivedAt = d;
        }
        let expiresAt: Date | null = null;
        if (b.expiresAt !== undefined && b.expiresAt !== null) {
          const d = new Date(b.expiresAt as string);
          if (isNaN(d.getTime()) || d.getTime() <= Date.now()) throw new ValidationError('expiresAt must be a future ISO datetime.');
          expiresAt = d;
        }

        const result = await docFiles.confirmUpload(
          { tenantId, userId }, req.params.caseId,
          {
            uploadId: b.uploadId, fileName: b.fileName as string, category: b.category,
            name: b.name as string | undefined, requirementId: b.requirementId as string | undefined,
            sourceChannel: b.sourceChannel as DocumentSourceChannel, internalNote: b.internalNote as string | undefined,
            clientVisible: b.clientVisible as boolean | undefined, expiresAt, receivedAt,
            verify: b.verify as boolean | undefined,
          },
          hasPermission(req, 'doc:verify'),
        );
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** GET /api/v1/documentation/files/:id/view-url */
  router.get('/files/:id/view-url', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid document id.');
        const canViewAll = !!(req as AuthenticatedRequest).user.permissions['doc:case:view-all'];
        const result = await docFiles.getViewUrl({ tenantId, userId }, req.params.id, { restrictToUserId: canViewAll ? undefined : userId });
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** GET /api/v1/documentation/cases/:caseId/documents/download-all — streaming ZIP of a case's documents.
   *  Same view predicate as the single-document download (doc:view + doc:case:view-all → unrestricted, else
   *  the owner/assignee union-scope). One authorization point; streamed, never buffered or staged to disk. */
  router.get('/cases/:caseId/documents/download-all', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      const { tenantId, userId } = (req as AuthenticatedRequest).user;
      const caseId = req.params.caseId;
      const ctx = { tenantId, userId };
      try {
        if (!UUID_RE.test(caseId)) throw new ValidationError('Invalid case id.');
        const canViewAll = hasPermission(req, 'doc:case:view-all');
        // Preflight ALL validation before a byte is sent: case within tenant/scope (404 if not), ≥1 doc (else 409).
        const { company, documents } = await docFiles.listCaseDocumentsForDownload(
          ctx, caseId, { restrictToUserId: canViewAll ? undefined : userId },
        );
        if (documents.length === 0) {
          res.status(409).json({ code: 'NO_DOCUMENTS', message: 'This case has no documents to download.' });
          return;
        }

        const folder = safeSegment(company, 'Documents');
        const totalBytes = documents.reduce((n, d) => n + (d.sizeBytes || 0), 0);
        await docFiles.auditDownloadAll(ctx, caseId, 'started', { count: documents.length, totalBytes });

        // Headers before the first byte. X-Total-Bytes drives the client's determinate progress.
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${folder}-documents.zip"`);
        res.setHeader('X-Total-Bytes', String(totalBytes));
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Bytes, Content-Disposition');

        const archive = archiver('zip', { zlib: { level: 6 } });
        let aborted = false;
        archive.on('error', (err: Error) => {
          aborted = true;
          logger.error({ caseId, err: err.message }, 'Download-all archive error');
          res.destroy(err); // truncate the response so the client detects failure
        });
        archive.pipe(res);

        const used = new Set<string>();
        for (const doc of documents) {
          const name = dedupeName(used, safeSegment(doc.name, 'document'));
          archive.append(await docFiles.streamDocument(doc.storageKey), { name: `${folder}/${name}` });
        }
        await archive.finalize();

        await docFiles.auditDownloadAll(ctx, caseId, aborted ? 'failed' : 'completed', { count: documents.length, totalBytes });
      } catch (err) {
        if (!res.headersSent) { next(err); return; } // preflight error → normal pipeline (404/403/409/400)
        logger.error({ caseId, err: (err as Error).message }, 'Download-all failed mid-stream');
        await docFiles.auditDownloadAll(ctx, caseId, 'failed', { mid: true }).catch(() => {});
        res.destroy(err as Error);
      }
    }
  );

  /** PATCH /api/v1/documentation/files/:id/status */
  router.patch('/files/:id/status', authMiddleware, permissionMiddleware('doc:file:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid document id.');
        const { status, rejectionReason } = req.body as { status?: string; rejectionReason?: string };
        if (!status || !(status in DocumentStatus)) throw new ValidationError('A valid status is required.');
        const result = await docFiles.updateStatus(
          { tenantId, userId }, req.params.id,
          { status: status as DocumentStatus, rejectionReason },
          hasPermission(req, 'doc:verify'),
        );
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/files/:id/replace */
  router.post('/files/:id/replace', authMiddleware, permissionMiddleware('doc:upload'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid document id.');
        const b = req.body as Record<string, unknown>;
        if (typeof b.uploadId !== 'string' || !UUID_RE.test(b.uploadId)) throw new ValidationError('uploadId is required (uuid).');
        if (typeof b.fileName !== 'string' || b.fileName.length < 1 || b.fileName.length > 255) throw new ValidationError('fileName is required (1-255 characters).');
        if (typeof b.sourceChannel !== 'string' || !(FIRM_SOURCE_CHANNELS as readonly string[]).includes(b.sourceChannel)) throw new ValidationError(`sourceChannel must be one of: ${FIRM_SOURCE_CHANNELS.join(', ')}.`);
        // E1: category/requirementId/requirementStatus are derived, never accepted.
        if ('category' in b || 'requirementId' in b || 'requirementStatus' in b) throw new ValidationError('category, requirementId and requirementStatus are derived on replace and must not be provided.');
        if (b.name !== undefined && b.name !== null && (typeof b.name !== 'string' || b.name.length > 200)) throw new ValidationError('name must be at most 200 characters.');
        if (b.internalNote !== undefined && b.internalNote !== null && (typeof b.internalNote !== 'string' || b.internalNote.length > 2000)) throw new ValidationError('internalNote must be at most 2000 characters.');
        if (b.clientVisible !== undefined && typeof b.clientVisible !== 'boolean') throw new ValidationError('clientVisible must be a boolean.');
        if (b.verify !== undefined && typeof b.verify !== 'boolean') throw new ValidationError('verify must be a boolean.');
        let expiresAt: Date | null = null;
        if (b.expiresAt !== undefined && b.expiresAt !== null) {
          const d = new Date(b.expiresAt as string);
          if (isNaN(d.getTime()) || d.getTime() <= Date.now()) throw new ValidationError('expiresAt must be a future ISO datetime.');
          expiresAt = d;
        }
        const result = await docFiles.replace(
          { tenantId, userId }, req.params.id,
          {
            uploadId: b.uploadId, fileName: b.fileName as string, sourceChannel: b.sourceChannel as DocumentSourceChannel,
            internalNote: b.internalNote as string | undefined, clientVisible: b.clientVisible as boolean | undefined,
            verify: b.verify as boolean | undefined, name: b.name as string | undefined, expiresAt,
          },
          hasPermission(req, 'doc:verify'),
        );
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
    }
  );

  /** DELETE /api/v1/documentation/files/:id */
  router.delete('/files/:id', authMiddleware, permissionMiddleware('doc:file:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid document id.');
        await docFiles.softDelete({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) { next(err); }
    }
  );

  return router;
}

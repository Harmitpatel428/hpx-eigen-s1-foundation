import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, DocCaseStatus, DocDocumentStatus, DocNoteType, DocStorageType, DocPresetCategory, DocumentStatus, DocumentSourceChannel } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { DocumentationService, getSuggestions } from '../services/documentation.service';
import { DocumentService } from '../services/document.service';
import { ValidationError } from '../types/exceptions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRM_SOURCE_CHANNELS = ['WHATSAPP', 'EMAIL', 'PHYSICAL', 'FIRM_UPLOAD', 'OTHER'] as const;
const DOC_MIME_ALLOWLIST = ['application/pdf', 'image/jpeg', 'image/png'];
const DOC_MAX_BYTES = 5 * 1024 * 1024;

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
        const { status, assignedTo, isReady, search, page, pageSize } = req.query as {
          status?: string; assignedTo?: string; isReady?: string; search?: string;
          page?: string; pageSize?: string;
        };
        const result = await svc.listCases({ tenantId, userId }, {
          status:     status as DocCaseStatus | undefined,
          assignedTo,
          isReady:    isReady !== undefined ? isReady === 'true' : undefined,
          search,
          page:       page     ? parseInt(page)     : undefined,
          pageSize:   pageSize ? parseInt(pageSize) : undefined,
        });
        res.json({ success: true, ...result });
      } catch (err) { next(err); }
    }
  );

  /** GET /api/v1/documentation/dashboard */
  router.get('/dashboard', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const kpis = await svc.getDashboardKPIs({ tenantId, userId });
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
        const docCase = await svc.getCaseById({ tenantId, userId }, req.params.id);
        res.json({ success: true, data: docCase });
      } catch (err) { next(err); }
    }
  );

  /** POST /api/v1/documentation/cases/:id/transfer */
  router.post('/cases/:id/transfer', authMiddleware, permissionMiddleware('doc:transfer'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const result = await svc.transferToProcess({ tenantId, userId }, req.params.id);
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
        const { status, remarks, rejectionReason, waivedReason, expiryDate } = req.body as {
          status: DocDocumentStatus; remarks?: string; rejectionReason?: string;
          waivedReason?: string; expiryDate?: string;
        };
        if (!status) throw new ValidationError('status is required.');
        const doc = await svc.updateDocumentStatus({ tenantId, userId }, req.params.id, {
          status, remarks, rejectionReason, waivedReason,
          expiryDate: expiryDate ? new Date(expiryDate) : undefined,
        });
        res.json({ success: true, data: doc });
      } catch (err) { next(err); }
    }
  );

  /** PATCH /api/v1/documentation/documents/:id/verify */
  router.patch('/documents/:id/verify', authMiddleware, permissionMiddleware('doc:verify'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { result, remarks } = req.body as { result: 'APPROVED' | 'REJECTED'; remarks?: string; rejectionReason?: string };
        if (!result || !['APPROVED', 'REJECTED'].includes(result)) throw new ValidationError('result must be APPROVED or REJECTED.');
        const doc = await svc.updateDocumentStatus({ tenantId, userId }, req.params.id, {
          status:           result as DocDocumentStatus,
          remarks,
          rejectionReason:  req.body.rejectionReason,
        });
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
        // F4: verify and requirementStatus are mutually exclusive.
        if (b.verify === true && b.requirementStatus !== undefined && b.requirementStatus !== null) throw new ValidationError('Choose verify or an explicit requirementStatus, not both.');

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
            verify: b.verify as boolean | undefined, requirementStatus: b.requirementStatus as DocDocumentStatus | undefined,
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
        const result = await docFiles.getViewUrl({ tenantId, userId }, req.params.id);
        res.json({ success: true, data: result });
      } catch (err) { next(err); }
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

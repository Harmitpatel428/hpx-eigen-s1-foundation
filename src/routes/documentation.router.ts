import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, DocCaseStatus, DocDocumentStatus, DocNoteType, DocStorageType, DocPresetCategory } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { DocumentationService, getSuggestions } from '../services/documentation.service';
import { ValidationError } from '../types/exceptions';

export function createDocumentationRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc    = new DocumentationService(prisma);

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

  return router;
}

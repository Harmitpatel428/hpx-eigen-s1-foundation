import { Router, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { CaseTypeService, UserContext } from '../services/case-type.service';
import { DocumentationService } from '../services/documentation.service';
import { ValidationError } from '../types/exceptions';
import { logger } from '../utils/logger';

const VIEW = 'case-type:view';
const MANAGE = 'case-type:manage';
const PUBLISH = 'case-type:publish';

function ctxOf(req: Request): UserContext {
  const u = (req as AuthenticatedRequest).user;
  const ua = req.headers['user-agent'];
  return { tenantId: u.tenantId, userId: u.userId, actorIp: req.ip, actorUserAgent: Array.isArray(ua) ? ua[0] : ua };
}

/**
 * Propagate a component-document preset into live cases, best-effort: the preset
 * is already persisted, so a propagation failure is logged, not surfaced —
 * missed cases pick it up on their next assignPolicies save.
 */
async function propagate(docService: DocumentationService, ctx: UserContext, componentId: string, componentDocumentId: string): Promise<void> {
  try {
    await docService.propagateActiveComponentDocument(ctx, componentId, componentDocumentId);
  } catch (err) {
    logger.warn({ err, componentId, componentDocumentId }, 'component-document propagation failed; cases will self-heal on next save');
  }
}
const wantsArchived = (req: Request) => String(req.query.includeArchived) === 'true';

export function createCaseTypesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new CaseTypeService(prisma);
  // Component-document writes propagate into live cases via the doc service.
  const docService = new DocumentationService(prisma);

  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  // ─── Catalog ───────────────────────────────────────────────────
  router.get('/', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.listTypes(ctxOf(req), wantsArchived(req)) }); } catch (e) { next(e); }
  });
  router.post('/', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await service.createType(ctxOf(req), req.body) }); } catch (e) { next(e); }
  });
  router.get('/:caseTypeId', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.getType(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });
  router.patch('/:caseTypeId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.updateType(ctxOf(req), req.params.caseTypeId, req.body) }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/publish', permissionMiddleware(PUBLISH), async (req, res, next) => {
    try { res.json({ success: true, data: await service.publishType(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/archive', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.archiveType(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });

  // ─── Placements ────────────────────────────────────────────────
  router.get('/:caseTypeId/fields', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.listPlacements(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/fields', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await service.addPlacement(ctxOf(req), req.params.caseTypeId, req.body) }); } catch (e) { next(e); }
  });
  router.patch('/:caseTypeId/fields/:fieldId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.updatePlacement(ctxOf(req), req.params.caseTypeId, req.params.fieldId, req.body) }); } catch (e) { next(e); }
  });
  router.delete('/:caseTypeId/fields/:fieldId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { await service.removePlacement(ctxOf(req), req.params.caseTypeId, req.params.fieldId); res.json({ success: true, data: { caseTypeId: req.params.caseTypeId, fieldId: req.params.fieldId } }); } catch (e) { next(e); }
  });

  // ─── Components ─────────────────────────────────────────────────
  router.get('/:caseTypeId/components', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.listComponents(ctxOf(req), req.params.caseTypeId, String(req.query.includeInactive) === 'true') }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/components', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await service.createComponent(ctxOf(req), req.params.caseTypeId, req.body) }); } catch (e) { next(e); }
  });
  router.patch('/:caseTypeId/components/:componentId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.updateComponent(ctxOf(req), req.params.caseTypeId, req.params.componentId, req.body) }); } catch (e) { next(e); }
  });

  // ─── Component documents ────────────────────────────────────────
  router.get('/:caseTypeId/components/:componentId/documents', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.listComponentDocuments(ctxOf(req), req.params.caseTypeId, req.params.componentId, String(req.query.includeInactive) === 'true') }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/components/:componentId/documents', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const doc = await service.createComponentDocument(ctx, req.params.caseTypeId, req.params.componentId, req.body);
      // Best-effort propagation into cases already using this component. A failure
      // here must not fail the create — any missed case self-heals on its next
      // assignPolicies save (Phase B no longer gates on documentsMaterializedAt).
      await propagate(docService, ctx, req.params.componentId, doc.id);
      res.status(201).json({ success: true, data: doc });
    } catch (e) { next(e); }
  });
  router.patch('/:caseTypeId/components/:componentId/documents/:componentDocumentId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const doc = await service.updateComponentDocument(ctx, req.params.caseTypeId, req.params.componentId, req.params.componentDocumentId, req.body);
      // Reactivation (or any PATCH that leaves/sets the preset active) propagates;
      // propagateActiveComponentDocument no-ops when the preset is not active.
      if (req.body?.isActive === true) await propagate(docService, ctx, req.params.componentId, doc.id);
      res.json({ success: true, data: doc });
    } catch (e) { next(e); }
  });

  return router;
}

/** PATCH /api/v1/cases/:caseId/case-type — assign/clear a case's type (doc:edit). */
export function createCaseTypeAssignmentRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const service = new CaseTypeService(prisma);
  const docService = new DocumentationService(prisma);

  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.patch('/', permissionMiddleware('doc:edit'), async (req, res, next) => {
    try {
      const caseId = (req.params as { caseId: string }).caseId;
      const body = (req.body ?? {}) as { caseTypeId?: string | null; policies?: unknown; primaryCaseTypeId?: string | null };
      const hasLegacy = Object.prototype.hasOwnProperty.call(body, 'caseTypeId');
      const hasPolicies = Object.prototype.hasOwnProperty.call(body, 'policies');
      if (hasLegacy && hasPolicies) throw new ValidationError('Provide either caseTypeId or policies, not both.');
      if (!hasLegacy && !hasPolicies) throw new ValidationError('Provide either caseTypeId or policies.');

      if (hasPolicies) {
        // New multi-policy shape → full component/document management.
        const data = await docService.assignPolicies(ctxOf(req), caseId, {
          policies: body.policies as never,
          primaryCaseTypeId: body.primaryCaseTypeId ?? null,
        });
        res.json({ success: true, data });
      } else {
        // Legacy compatibility-only path: sets/clears DocCase.caseTypeId, no policy rows/docs.
        const data = await service.assignCaseType(ctxOf(req), caseId, body.caseTypeId ?? null);
        res.json({ success: true, data });
      }
    } catch (e) { next(e); }
  });

  return router;
}

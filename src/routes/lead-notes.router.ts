import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadNotesService } from '../services/lead-notes.service';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';
import { buildOwnerFilter, type ScopeType } from '../utils/scope.helper';
import { assertLeadInScope, leadOwnerFilter } from '../utils/lead-scope.helper';
import { leadInScope } from '../utils/atomic-scope';

export function createLeadNotesRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const notesService = new LeadNotesService(prisma);

  // Owner-scope gate for the read endpoints: true iff the lead is in the caller's visible set.
  async function leadVisible(req: Request): Promise<boolean> {
    const { userId, tenantId, scope, teamId, departmentId } = (req as AuthenticatedRequest).user;
    const ownerFilter = await buildOwnerFilter(
      (scope ?? 'OWN') as ScopeType, userId, teamId ?? null, departmentId ?? null, prisma, true
    );
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.leadId, tenantId, deletedAt: null, ...ownerFilter },
      select: { id: true },
    });
    return !!lead;
  }

  // Write gate: the lead must be in the caller's scope AND the note must belong to that lead
  // (the service looks notes up by id only, so a foreign noteId under the caller's own leadId must 404).
  async function assertNoteInScope(req: Request, leadId: string, noteId: string): Promise<void> {
    const user = (req as AuthenticatedRequest).user;
    await assertLeadInScope(user, prisma, leadId);
    const note = await prisma.leadNote.findFirst({ where: { id: noteId, leadId, tenantId: user.tenantId }, select: { id: true } });
    if (!note) throw new ResourceNotFoundError();
  }

  // Scope fragment folded into the note write's own WHERE (note belongs to the lead AND the lead is in scope).
  async function noteWriteScope(req: Request, leadId: string) {
    const user = (req as AuthenticatedRequest).user;
    return { leadId, lead: leadInScope(user.tenantId, await leadOwnerFilter(user, prisma)) };
  }

  // GET /api/v1/leads/:leadId/notes/summary (count + latest)
  router.get(
    '/summary',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;
        if (!(await leadVisible(req))) { res.status(404).json({ error: { message: 'Lead not found.' } }); return; }

        const summary =await notesService.getNotesSummary({ tenantId, userId }, leadId);
        res.json({ data: summary });
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /api/v1/leads/:leadId/notes
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;
        if (!(await leadVisible(req))) { res.status(404).json({ error: { message: 'Lead not found.' } }); return; }
        const { limit = '15', skip = '0' } = req.query;

        const notes = await notesService.listNotes(
          { tenantId, userId },
          leadId,
          parseInt(limit as string, 10),
          parseInt(skip as string, 10)
        );

        res.json({ data: notes });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/v1/leads/:leadId/notes
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        await assertLeadInScope((req as AuthenticatedRequest).user, prisma, req.params.leadId);
        const { leadId } = req.params;
        const { content, followUpDate, followUpTime } = req.body as {
          content: string;
          followUpDate?: string;
          followUpTime?: string;
        };

        if (!content || content.trim().length === 0) {
          throw new ValidationError('Note content is required.');
        }

        if (content.length > 500) {
          throw new ValidationError('Note exceeds 500 characters. Maximum is 500 characters.');
        }

        let parsedFollowUpDate: Date | undefined;
        if (followUpDate) {
          parsedFollowUpDate = new Date(followUpDate);
          if (isNaN(parsedFollowUpDate.getTime())) {
            throw new ValidationError('Invalid follow-up date format.');
          }
        }

        if (followUpTime && !/^\d{2}:\d{2}$/.test(followUpTime)) {
          throw new ValidationError('Follow-up time must be in HH:mm format.');
        }

        const note = await notesService.createNote(
          { tenantId, userId },
          leadId,
          content,
          parsedFollowUpDate,
          followUpTime
        );

        res.status(201).json({ data: note });
      } catch (err) {
        next(err);
      }
    }
  );

  // PATCH /api/v1/leads/:leadId/notes/:noteId
  router.patch(
    '/:noteId',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { leadId, noteId } = req.params;
        await assertNoteInScope(req, leadId, noteId);
        const { content, followUpDate, followUpTime } = req.body as {
          content?: string;
          followUpDate?: string | null;
          followUpTime?: string | null;
        };

        if (content !== undefined && content.length > 500) {
          throw new ValidationError('Note exceeds 500 characters. Maximum is 500 characters.');
        }

        if (followUpTime && !/^\d{2}:\d{2}$/.test(followUpTime)) {
          throw new ValidationError('Follow-up time must be in HH:mm format.');
        }

        let parsedFollowUpDate: Date | undefined | null;
        if (followUpDate !== undefined) {
          if (followUpDate === null) {
            parsedFollowUpDate = null;
          } else {
            parsedFollowUpDate = new Date(followUpDate);
            if (isNaN(parsedFollowUpDate.getTime())) {
              throw new ValidationError('Invalid follow-up date format.');
            }
          }
        }

        const note = await notesService.updateNote(
          { tenantId, userId },
          noteId,
          content,
          parsedFollowUpDate,
          followUpTime,
          await noteWriteScope(req, leadId)
        );

        res.json({ data: note });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /api/v1/leads/:leadId/notes/:noteId
  router.delete(
    '/:noteId',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { leadId, noteId } = req.params;
        await assertNoteInScope(req, leadId, noteId);

        await notesService.deleteNote({ tenantId, userId }, noteId, await noteWriteScope(req, leadId));

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

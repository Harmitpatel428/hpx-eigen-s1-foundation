import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadNotesService } from '../services/lead-notes.service';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createLeadNotesRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const notesService = new LeadNotesService(prisma);

  // GET /api/v1/leads/:leadId/notes/summary (count + latest)
  router.get(
    '/summary',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;

        const summary = await notesService.getNotesSummary({ tenantId, userId }, leadId);
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
          followUpTime
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
        const { noteId } = req.params;

        await notesService.deleteNote({ tenantId, userId }, noteId);

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

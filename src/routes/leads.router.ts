import { Router, Request, Response, NextFunction } from 'express';
import {
  PrismaClient,
  LeadStatus,
  LeadSource,
  LeadStage,
  LeadPriority,
  OpportunityCurrency,
  Prisma,
} from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadService } from '../services/lead.service';
import { ValidationError } from '../types/exceptions';
import { buildOwnerFilter, ScopeType } from '../utils/scope.helper';

export function createLeadsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const leadService = new LeadService(prisma);

  // ─── POST /api/v1/leads ───────────────────────────────────────────
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('lead:create'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const {
          firstName,
          lastName,
          email,
          phone,
          company,
          source,
          notes,
          ownerId,
          score,
          stage,
          followUpDate,
          expectedValue,
          priority,
          expectedCloseDate,
          country,
          state,
          city,
          area,
          postalCode,
          freeformAddress,
          customFieldValues,
          tagNames,
        } = req.body as {
          firstName: string;
          lastName: string;
          email?: string;
          phone?: string;
          company?: string;
          source?: LeadSource;
          notes?: string;
          ownerId?: string;
          score?: number;
          stage?: LeadStage;
          followUpDate?: string | null;
          expectedValue?: number | string;
          priority?: LeadPriority;
          expectedCloseDate?: string;
          country?: string;
          state?: string;
          city?: string;
          area?: string;
          postalCode?: string;
          freeformAddress?: string;
          customFieldValues?: Array<{ fieldId: string; value: string | null }>;
          tagNames?: string[];
        };

        if (!firstName || !lastName) {
          throw new ValidationError('firstName and lastName are required.');
        }

        if (Array.isArray(customFieldValues)) {
          if (customFieldValues.length > 50) throw new ValidationError('Maximum 50 custom field values per lead.');
          for (const v of customFieldValues) {
            if (typeof v.value === 'string' && v.value.length > 1000) throw new ValidationError('Custom field value must be 1,000 characters or fewer.');
          }
        }

        if (stage && !Object.values(LeadStage).includes(stage)) {
          throw new ValidationError(
            `stage must be one of: ${Object.values(LeadStage).join(', ')}`
          );
        }

        if (priority && !Object.values(LeadPriority).includes(priority)) {
          throw new ValidationError(
            `priority must be one of: ${Object.values(LeadPriority).join(', ')}`
          );
        }

        const lead = await leadService.createLead(
          { tenantId, userId },
          {
            firstName,
            lastName,
            email,
            phone,
            company,
            source,
            notes,
            ownerId,
            score,
            stage,
            followUpDate,
            expectedValue,
            priority,
            expectedCloseDate,
            country,
            state,
            city,
            area,
            postalCode,
            freeformAddress,
            customFieldValues: Array.isArray(customFieldValues) ? customFieldValues : undefined,
            tagNames: Array.isArray(tagNames) ? tagNames : undefined,
          }
        );

        res.status(201).json({ data: lead });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/check-duplicates ──────────────────────────
  // Must be defined before /:id to avoid route conflict
  router.get(
    '/check-duplicates',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { email, phone, company, firstName, lastName, excludeId } = req.query as {
          email?: string;
          phone?: string;
          company?: string;
          firstName?: string;
          lastName?: string;
          excludeId?: string;
        };

        const duplicates = await leadService.checkDuplicates(
          { tenantId, userId: (req as AuthenticatedRequest).user.userId },
          { email, phone, company, firstName, lastName, excludeId }
        );

        res.json({ data: duplicates });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/deleted ──────────────────────────────────
  // Must be defined before /:id to avoid route conflict
  router.get(
    '/deleted',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;
        if (page < 1 || isNaN(page)) throw new ValidationError('page must be a positive integer.');
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) throw new ValidationError('pageSize must be between 1 and 200.');
        const result = await leadService.listDeleted({ tenantId, userId }, page, pageSize);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/bulk-assign/preview ─────────────────────
  router.post(
    '/bulk-assign/preview',
    authMiddleware,
    permissionMiddleware('lead:assign'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { leadIds, departmentId } = req.body as { leadIds: string[]; departmentId: string };
        if (!Array.isArray(leadIds) || leadIds.length === 0) throw new ValidationError('leadIds array is required.');
        if (leadIds.length > 200) throw new ValidationError('Maximum 200 leads per bulk operation.');
        if (!departmentId) throw new ValidationError('departmentId is required.');
        const result = await leadService.previewAutoAssign({ tenantId, userId }, leadIds, departmentId);
        res.json({ data: result });
      } catch (err) { next(err); }
    }
  );

  // ─── POST /api/v1/leads/bulk-assign ─────────────────────────────
  router.post(
    '/bulk-assign',
    authMiddleware,
    permissionMiddleware('lead:assign'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { leadIds, mode, userId: targetUserId, departmentId } = req.body as {
          leadIds: string[];
          mode: 'MANUAL' | 'AUTO';
          userId?: string;
          departmentId?: string;
        };
        if (!Array.isArray(leadIds) || leadIds.length === 0) throw new ValidationError('leadIds array is required.');
        if (leadIds.length > 200) throw new ValidationError('Maximum 200 leads per bulk operation.');
        if (mode !== 'MANUAL' && mode !== 'AUTO') throw new ValidationError('mode must be MANUAL or AUTO.');
        const result = await leadService.bulkAssign({ tenantId, userId }, { leadIds, mode, userId: targetUserId, departmentId });
        res.json({ data: result });
      } catch (err) { next(err); }
    }
  );

  // ─── POST /api/v1/leads/bulk-delete ─────────────────────────────
  // Must be defined before /:id to avoid route conflict
  router.post(
    '/bulk-delete',
    authMiddleware,
    permissionMiddleware('lead:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { ids } = req.body as { ids: string[] };
        if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('ids array is required.');
        if (ids.length > 200) throw new ValidationError('Maximum 200 leads per bulk operation.');
        const result = await leadService.bulkSoftDelete({ tenantId, userId }, ids);
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/bulk-restore ────────────────────────────
  // Must be defined before /:id to avoid route conflict
  router.post(
    '/bulk-restore',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { ids } = req.body as { ids: string[] };
        if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('ids array is required.');
        if (ids.length > 200) throw new ValidationError('Maximum 200 leads per bulk operation.');
        const result = await leadService.bulkRestore({ tenantId, userId }, ids);
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/bulk-permanent-delete ───────────────────
  // Must be defined before /:id to avoid route conflict
  router.post(
    '/bulk-permanent-delete',
    authMiddleware,
    permissionMiddleware('lead:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { ids } = req.body as { ids: string[] };
        if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('ids array is required.');
        if (ids.length > 200) throw new ValidationError('Maximum 200 leads per bulk operation.');
        const result = await leadService.bulkPermanentDelete({ tenantId, userId }, ids);
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/import ───────────────────────────────────
  // Must be defined before /:id to avoid route conflict
  router.post(
    '/import',
    authMiddleware,
    permissionMiddleware('lead:create'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { rows, onDuplicates = 'skip' } = req.body as {
          rows: Array<{
            firstName: string; lastName: string; email?: string; phone?: string;
            company?: string; source?: string; stage?: string; priority?: string;
            notes?: string; score?: number; expectedValue?: number | string;
            expectedCloseDate?: string; country?: string; state?: string; city?: string;
            area?: string; postalCode?: string; freeformAddress?: string; ownerId?: string;
          }>;
          onDuplicates?: 'skip' | 'overwrite';
        };

        if (!Array.isArray(rows) || rows.length === 0) throw new ValidationError('rows must be a non-empty array.');
        if (rows.length > 5000) throw new ValidationError('Maximum 5,000 rows per import.');
        if (onDuplicates !== 'skip' && onDuplicates !== 'overwrite') throw new ValidationError('onDuplicates must be "skip" or "overwrite".');

        // Batch duplicate detection — one query for all emails + phones
        const emails = rows.map(r => r.email).filter(Boolean) as string[];
        const phones = rows.map(r => r.phone).filter(Boolean) as string[];
        const dupeWhere: any[] = [];
        if (emails.length) dupeWhere.push({ email: { in: emails } });
        if (phones.length) dupeWhere.push({ phone: { in: phones } });

        const existing = dupeWhere.length
          ? await prisma.lead.findMany({
              where: { tenantId, deletedAt: null, OR: dupeWhere },
              select: { id: true, email: true, phone: true },
            })
          : [];

        const existingEmails = new Set(existing.map(e => e.email).filter(Boolean));
        const existingPhones = new Set(existing.map(e => e.phone).filter(Boolean));

        const toCreate: typeof rows = [];
        const toUpdate: Array<{ id: string; row: typeof rows[0] }> = [];
        const duplicates: Array<{ row: number; email?: string; phone?: string }> = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const isDuplicate =
            (row.email && existingEmails.has(row.email)) ||
            (row.phone && existingPhones.has(row.phone));
          if (isDuplicate) {
            duplicates.push({ row: i + 1, email: row.email, phone: row.phone });
            if (onDuplicates === 'overwrite') {
              const ex = existing.find(e =>
                (row.email && e.email === row.email) || (row.phone && e.phone === row.phone)
              );
              if (ex) toUpdate.push({ id: ex.id, row });
            }
          } else {
            toCreate.push(row);
          }
        }

        // Create in 100-row chunks via createMany
        // ponytail: createMany skips tagNames/customFieldValues — acceptable for CSV import
        let imported = 0;
        const errors: Array<{ row: number; message: string }> = [];
        const CHUNK = 100;
        for (let start = 0; start < toCreate.length; start += CHUNK) {
          const chunk = toCreate.slice(start, start + CHUNK);
          try {
            const result = await prisma.lead.createMany({
              data: chunk.map(row => ({
                tenantId,
                ownerId: row.ownerId || null,
                firstName: row.firstName,
                lastName: row.lastName,
                email: row.email ?? null,
                phone: row.phone ?? null,
                company: row.company ?? null,
                source: (row.source as LeadSource | undefined) ?? LeadSource.OTHER,
                status: LeadStatus.NEW,
                stage: (row.stage as LeadStage | undefined) ?? LeadStage.NEW,
                priority: (row.priority as LeadPriority | undefined) ?? LeadPriority.MEDIUM,
                notes: row.notes ?? null,
                score: typeof row.score === 'number' ? row.score : 0,
                expectedValue: row.expectedValue !== undefined
                  ? new Prisma.Decimal(Number(row.expectedValue))
                  : new Prisma.Decimal(0),
                expectedCloseDate: row.expectedCloseDate ? new Date(row.expectedCloseDate) : null,
                country: row.country ?? null,
                state: row.state ?? null,
                city: row.city ?? null,
                area: row.area ?? null,
                postalCode: row.postalCode ?? null,
                freeformAddress: row.freeformAddress ?? null,
                customFieldValues: [],
              })),
              skipDuplicates: false,
            });
            imported += result.count;
          } catch (err: any) {
            errors.push({ row: start + 1, message: err.message ?? 'Chunk insert failed' });
          }
        }

        // Overwrite duplicates individually
        for (const { id, row } of toUpdate) {
          try {
            await prisma.lead.update({
              where: { id },
              data: {
                firstName: row.firstName,
                lastName: row.lastName,
                company: row.company ?? null,
                source: row.source as LeadSource | undefined,
                stage: row.stage as LeadStage | undefined,
                priority: row.priority as LeadPriority | undefined,
                notes: row.notes ?? null,
                score: typeof row.score === 'number' ? row.score : undefined,
                expectedValue: row.expectedValue !== undefined
                  ? new Prisma.Decimal(Number(row.expectedValue))
                  : undefined,
                expectedCloseDate: row.expectedCloseDate ? new Date(row.expectedCloseDate) : undefined,
                country: row.country ?? null,
                state: row.state ?? null,
                city: row.city ?? null,
                area: row.area ?? null,
                postalCode: row.postalCode ?? null,
                freeformAddress: row.freeformAddress ?? null,
              },
            });
            imported++;
          } catch (err: any) {
            errors.push({ row: -1, message: err.message ?? 'Update failed' });
          }
        }

        res.json({
          data: {
            imported,
            skipped: onDuplicates === 'skip' ? duplicates.length : 0,
            duplicates,
            failed: errors.length,
            errors,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads ────────────────────────────────────────────
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          userId,
          tenantId,
          teamId,
          departmentId,
          scope,
        } = (req as AuthenticatedRequest).user;

        const status = req.query.status as LeadStatus | undefined;
        const ownerId = req.query.ownerId as string | undefined;
        const search = req.query.search as string | undefined;
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize
          ? parseInt(req.query.pageSize as string, 10)
          : 50;

        if (status && !Object.values(LeadStatus).includes(status)) {
          throw new ValidationError(
            `status must be one of: ${Object.values(LeadStatus).join(', ')}`
          );
        }
        if (page < 1 || isNaN(page)) {
          throw new ValidationError('page must be a positive integer.');
        }
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) {
          throw new ValidationError('pageSize must be between 1 and 200.');
        }

        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType,
          userId,
          teamId,
          departmentId,
          prisma,
          true  // Lead has managerId; include delegation-chain visibility in OWN scope
        );

        const whereClause: Prisma.LeadWhereInput = {
          tenantId,
          deletedAt: { equals: null },
          ...ownerFilter,
        };

        if (status) whereClause.status = status;
        // Only let ORGANIZATION-scope users (admins) filter by an arbitrary ownerId.
        // Scoped users already have their visibility constrained by ownerFilter.
        if (ownerId && Object.keys(ownerFilter).length === 0) {
          whereClause.ownerId = ownerId;
        }
        if (search) {
          whereClause.OR = [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { company: { contains: search, mode: 'insensitive' } },
          ];
        }

        const skip = (page - 1) * pageSize;
        const [data, total] = await Promise.all([
          prisma.lead.findMany({
            where: whereClause,
            skip,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: {
              tags: { include: { tag: true } },
            },
          }),
          prisma.lead.count({ where: whereClause }),
        ]);

        // Batch-load owner names to avoid N+1
        const ownerIds = [...new Set(data.filter((l: any) => l.ownerId).map((l: any) => l.ownerId as string))];
        const owners = ownerIds.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: ownerIds }, tenantId },
              select: { id: true, firstName: true, lastName: true },
            })
          : [];
        const ownerMap = Object.fromEntries(owners.map((u: any) => [u.id, u]));

        const enriched = data.map((l: any) => ({
          ...l,
          tags: (l.tags ?? []).map((a: any) => a.tag),
          owner: l.ownerId ? (ownerMap[l.ownerId] ?? null) : null,
        }));

        res.json({ data: enriched, total, page, pageSize });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/:id ────────────────────────────────────────
  router.get(
    '/:id',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const lead = await leadService.getLeadById({ tenantId, userId }, req.params.id);
        res.json(lead);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── PUT /api/v1/leads/:id ────────────────────────────────────────
  router.put(
    '/:id',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userReq = req as AuthenticatedRequest;
        const { userId, tenantId, decision } = userReq.user;
        const {
          firstName,
          lastName,
          email,
          phone,
          company,
          source,
          notes,
          ownerId,
          status,
          score,
          stage,
          followUpDate,
          expectedValue,
          priority,
          expectedCloseDate,
          country,
          state,
          city,
          area,
          postalCode,
          freeformAddress,
          customFieldValues,
          tagNames,
        } = req.body as {
          firstName?: string;
          lastName?: string;
          email?: string;
          phone?: string;
          company?: string;
          source?: LeadSource;
          notes?: string;
          ownerId?: string;
          status?: LeadStatus;
          score?: number;
          stage?: LeadStage;
          followUpDate?: string | null;
          expectedValue?: number | string;
          priority?: LeadPriority;
          expectedCloseDate?: string | null;
          country?: string;
          state?: string;
          city?: string;
          area?: string;
          postalCode?: string;
          freeformAddress?: string | null;
          customFieldValues?: Array<{ fieldId: string; value: string | null }>;
          tagNames?: string[];
        };

        if (Array.isArray(customFieldValues)) {
          if (customFieldValues.length > 50) throw new ValidationError('Maximum 50 custom field values per lead.');
          for (const v of customFieldValues) {
            if (typeof v.value === 'string' && v.value.length > 1000) throw new ValidationError('Custom field value must be 1,000 characters or fewer.');
          }
        }

        if (stage && !Object.values(LeadStage).includes(stage)) {
          throw new ValidationError(
            `stage must be one of: ${Object.values(LeadStage).join(', ')}`
          );
        }

        if (priority && !Object.values(LeadPriority).includes(priority)) {
          throw new ValidationError(
            `priority must be one of: ${Object.values(LeadPriority).join(', ')}`
          );
        }

        const lead = await leadService.updateLead(
          { tenantId, userId },
          decision,
          req.params.id,
          {
            firstName,
            lastName,
            email,
            phone,
            company,
            source,
            notes,
            ownerId,
            status,
            score,
            stage,
            followUpDate,
            expectedValue,
            priority,
            expectedCloseDate,
            country,
            state,
            city,
            area,
            postalCode,
            freeformAddress,
            customFieldValues: Array.isArray(customFieldValues) ? customFieldValues : undefined,
            tagNames: Array.isArray(tagNames) ? tagNames : undefined,
          }
        );

        res.json({ data: lead });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/:id/convert ──────────────────────────────
  router.post(
    '/:id/convert',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { contact, opportunity } = req.body as {
          contact: {
            firstName: string;
            lastName: string;
            email?: string;
            phone?: string;
            title?: string;
            company?: string;
          };
          opportunity: {
            title: string;
            value: number;
            currency?: OpportunityCurrency;
            expectedCloseDate?: string;
          };
        };

        if (!contact || !opportunity) {
          throw new ValidationError('contact and opportunity details are required.');
        }
        if (!contact.firstName || !contact.lastName) {
          throw new ValidationError('contact.firstName and contact.lastName are required.');
        }
        if (!opportunity.title || opportunity.value === undefined) {
          throw new ValidationError('opportunity.title and opportunity.value are required.');
        }

        const result = await leadService.convertLead(
          { tenantId, userId },
          req.params.id,
          {
            contact,
            opportunity: {
              ...opportunity,
              expectedCloseDate: opportunity.expectedCloseDate
                ? new Date(opportunity.expectedCloseDate)
                : undefined,
            },
          }
        );

        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── DELETE /api/v1/leads/:id ─────────────────────────────────────
  router.delete(
    '/:id',
    authMiddleware,
    permissionMiddleware('lead:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        await leadService.deleteLead({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/:id/restore ─────────────────────────────
  router.post(
    '/:id/restore',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        await leadService.restoreLead({ tenantId, userId }, req.params.id);
        res.json({ message: 'Lead restored.' });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── DELETE /api/v1/leads/:id/permanent ─────────────────────────
  router.delete(
    '/:id/permanent',
    authMiddleware,
    permissionMiddleware('lead:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        await leadService.permanentDeleteLead({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

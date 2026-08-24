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
import { LeadService, FOLLOW_UP_REQUIRED_STAGES } from '../services/lead.service';
import { ValidationError } from '../types/exceptions';
import { checkImportRateLimit, checkBulkOperationLimit } from '../services/auth/RateLimitService';
import { buildOwnerFilter, ScopeType } from '../utils/scope.helper';

export function createLeadsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const leadService = new LeadService(prisma);

  // Shared filter parsing for GET / (list) and GET /export — single source of
  // truth for status/stage/assignee/role/search so both endpoints always agree.
  const buildLeadFilterWhere = async (req: Request): Promise<Prisma.LeadWhereInput> => {
    const { userId, tenantId, teamId, departmentId, scope } = (req as AuthenticatedRequest).user;
    const status = req.query.status as LeadStatus | undefined;
    const stage = req.query.stage as LeadStage | undefined;
    const ownerId = req.query.ownerId as string | undefined;
    const roleId = req.query.roleId as string | undefined;
    const search = req.query.search as string | undefined;

    if (status && !Object.values(LeadStatus).includes(status)) {
      throw new ValidationError(
        `status must be one of: ${Object.values(LeadStatus).join(', ')}`
      );
    }
    if (stage && !Object.values(LeadStage).includes(stage)) {
      throw new ValidationError(
        `stage must be one of: ${Object.values(LeadStage).join(', ')}`
      );
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
    if (stage) whereClause.stage = stage;

    // Role/assignee narrowing goes through AND so it composes with — and can
    // never widen — the scope's ownerFilter above.
    const conjuncts: Prisma.LeadWhereInput[] = [];
    if (ownerId === 'UNASSIGNED') {
      conjuncts.push({ ownerId: null });
    } else if (ownerId && Object.keys(ownerFilter).length === 0) {
      // Only ORGANIZATION-scope users (admins) may target an arbitrary owner;
      // scoped users are already constrained by ownerFilter.
      conjuncts.push({ ownerId });
    }
    if (roleId) {
      // User/UserRole/Role are NOT tenant-scoped by db.ts — explicit tenant +
      // soft-delete filters here are load-bearing.
      const roleUsers = await prisma.userRole.findMany({
        where: { roleId, role: { tenantId, deletedAt: null } },
        select: { userId: true },
      });
      // `in: []` intentionally matches nothing when the role has no users.
      conjuncts.push({ ownerId: { in: roleUsers.map((u) => u.userId) } });
    }
    if (conjuncts.length > 0) whereClause.AND = conjuncts;

    if (search) {
      whereClause.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
      ];
    }

    return whereClause;
  };

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
        await checkBulkOperationLimit(userId, tenantId);
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
        await checkImportRateLimit(tenantId, req.ip ?? '');
        const { rows, onDuplicates = 'skip' } = req.body as {
          rows: Array<{
            firstName: string; lastName: string; email?: string; phone?: string;
            company?: string; source?: string; stage?: string; priority?: string;
            notes?: string; score?: number; expectedValue?: number | string;
            followUpDate?: string; expectedCloseDate?: string;
            country?: string; state?: string; city?: string;
            area?: string; postalCode?: string; freeformAddress?: string; ownerId?: string;
          }>;
          onDuplicates?: 'skip' | 'overwrite';
        };

        if (!Array.isArray(rows) || rows.length === 0) throw new ValidationError('rows must be a non-empty array.');
        if (rows.length > 5000) throw new ValidationError('Maximum 5,000 rows per import.');
        if (onDuplicates !== 'skip' && onDuplicates !== 'overwrite') throw new ValidationError('onDuplicates must be "skip" or "overwrite".');

        // Per-row validation: skip invalid rows, import valid ones
        const SELECTABLE_STAGES_IMPORT = new Set<string>([LeadStage.NEW, LeadStage.QUALIFIED, LeadStage.INTERESTED, LeadStage.FOLLOW_UP, LeadStage.CALL_BACK_REQUESTED, LeadStage.CALL_NOT_RECEIVED, LeadStage.OTHER, LeadStage.DISQUALIFIED]);
        const STAGE_ALIASES: Record<string, string> = {
          'FOLLOW UP': 'FOLLOW_UP', 'FOLLOW-UP': 'FOLLOW_UP',
          'CALLBACK': 'CALL_BACK_REQUESTED', 'CALL BACK': 'CALL_BACK_REQUESTED', 'CALL-BACK': 'CALL_BACK_REQUESTED',
          'NOT RECEIVED': 'CALL_NOT_RECEIVED', 'CALL NOT RECEIVED': 'CALL_NOT_RECEIVED',
        };
        const SOURCE_ALIASES: Record<string, LeadSource> = {
          LINKEDIN: LeadSource.SOCIAL_MEDIA, FACEBOOK: LeadSource.SOCIAL_MEDIA,
          TWITTER: LeadSource.SOCIAL_MEDIA, INSTAGRAM: LeadSource.SOCIAL_MEDIA,
          YOUTUBE: LeadSource.SOCIAL_MEDIA, SOCIAL: LeadSource.SOCIAL_MEDIA,
          WEB: LeadSource.WEBSITE, TRADESHOW: LeadSource.TRADE_SHOW, TRADE_SHOWS: LeadSource.TRADE_SHOW,
          EMAIL_CAMPAIGNS: LeadSource.EMAIL_CAMPAIGN, EMAILCAMPAIGN: LeadSource.EMAIL_CAMPAIGN,
        };
        const normalizeSource = (v: string | undefined): LeadSource => {
          if (!v) return LeadSource.OTHER;
          const up = v.trim().toUpperCase();
          if (SOURCE_ALIASES[up]) return SOURCE_ALIASES[up]!;
          if ((Object.values(LeadSource) as string[]).includes(up)) return up as LeadSource;
          return LeadSource.OTHER;
        };
        const normalizeStage = (v: string | undefined): string | undefined => {
          if (!v) return v;
          const up = v.trim().toUpperCase();
          return STAGE_ALIASES[up] ?? up;
        };
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const toUuidOrNull = (v: string | undefined): string | null => (v && UUID_RE.test(v) ? v : null);
        const rowErrors: Array<{ row: number; message: string }> = [];
        const invalidRowIndices = new Set<number>();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          // Normalize stage + source in-place before validation
          if (row.stage) row.stage = normalizeStage(row.stage);
          if (!row.firstName || !row.lastName) {
            rowErrors.push({ row: i + 1, message: 'firstName and lastName are required.' });
            invalidRowIndices.add(i);
            continue;
          }
          if (row.stage && !SELECTABLE_STAGES_IMPORT.has(row.stage)) {
            rowErrors.push({ row: i + 1, message: `Stage "${row.stage}" is not valid for import. Use one of: ${[...SELECTABLE_STAGES_IMPORT].join(', ')}.` });
            invalidRowIndices.add(i);
            continue;
          }
          // Follow-up-required stages must carry a parseable follow-up date —
          // same rule as create/update; import bypasses leadService so it
          // re-checks here (INTERESTED included via FOLLOW_UP_REQUIRED_STAGES).
          const stageEnum = row.stage as LeadStage | undefined;
          if (stageEnum && FOLLOW_UP_REQUIRED_STAGES.has(stageEnum)) {
            const d = row.followUpDate ? new Date(row.followUpDate) : null;
            if (!d || isNaN(d.getTime())) {
              rowErrors.push({
                row: i + 1,
                message: stageEnum === LeadStage.INTERESTED
                  ? 'Follow-up Date is required for Interested leads.'
                  : `followUpDate is required for stage ${row.stage}.`,
              });
              invalidRowIndices.add(i);
              continue;
            }
          }
          // Normalize + validate priority (import writes it directly via
          // createMany — an invalid enum would fail the whole chunk).
          if (row.priority !== undefined && row.priority !== null && String(row.priority).trim() !== '') {
            const up = String(row.priority).trim().toUpperCase();
            if (!(Object.values(LeadPriority) as string[]).includes(up)) {
              rowErrors.push({ row: i + 1, message: `Priority "${row.priority}" is not valid. Use one of: ${Object.values(LeadPriority).join(', ')}.` });
              invalidRowIndices.add(i);
              continue;
            }
            row.priority = up;
          } else {
            row.priority = undefined;
          }
        }
        if (invalidRowIndices.size === rows.length) {
          return res.status(400).json({ error: { message: 'All rows failed validation.', code: 'IMPORT_VALIDATION_FAILED', errors: rowErrors } });
        }

        // Batch duplicate detection — one query for all emails + phones (valid rows only)
        const emails = rows.filter((_, i) => !invalidRowIndices.has(i)).map(r => r.email).filter(Boolean) as string[];
        const phones = rows.filter((_, i) => !invalidRowIndices.has(i)).map(r => r.phone).filter(Boolean) as string[];
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
          if (invalidRowIndices.has(i)) continue;
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
        let raceSkipped = 0; // rows silently dropped by DB unique constraint (TOCTOU race)
        const errors: Array<{ row: number; message: string }> = [];
        const CHUNK = 100;
        for (let start = 0; start < toCreate.length; start += CHUNK) {
          const chunk = toCreate.slice(start, start + CHUNK);
          try {
            const result = await prisma.lead.createMany({
              data: chunk.map(row => ({
                tenantId,
                ownerId: toUuidOrNull(row.ownerId),
                firstName: row.firstName,
                lastName: row.lastName,
                // Normalize empty strings to null so the partial unique index treats them
                // as absent rather than as a (tenantId, '') unique constraint value.
                email: row.email || null,
                phone: row.phone || null,
                company: row.company || null,
                source: normalizeSource(row.source),
                status: LeadStatus.NEW,
                stage: (row.stage as LeadStage | undefined) ?? LeadStage.NEW,
                priority: (row.priority as LeadPriority | undefined) ?? LeadPriority.MEDIUM,
                notes: row.notes ?? null,
                score: typeof row.score === 'number' ? row.score : 0,
                expectedValue: row.expectedValue !== undefined
                  ? new Prisma.Decimal(Number(row.expectedValue))
                  : new Prisma.Decimal(0),
                followUpDate: row.followUpDate ? new Date(row.followUpDate) : null,
                expectedCloseDate: row.expectedCloseDate ? new Date(row.expectedCloseDate) : null,
                country: row.country ?? null,
                state: row.state ?? null,
                city: row.city ?? null,
                area: row.area ?? null,
                postalCode: row.postalCode ?? null,
                freeformAddress: row.freeformAddress ?? null,
                customFieldValues: [],
              })),
              skipDuplicates: true,
            });
            imported += result.count;
            // Count rows the DB skipped due to concurrent import racing the same unique key
            raceSkipped += chunk.length - result.count;
          } catch (err: any) {
            errors.push({ row: start + 1, message: err.message ?? 'Chunk insert failed' });
          }
        }

        // Overwrite duplicates individually
        for (const { id, row } of toUpdate) {
          try {
            const updateResult = await prisma.lead.updateMany({
              where: { id, tenantId, deletedAt: null },
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
                followUpDate: row.followUpDate ? new Date(row.followUpDate) : null,
                country: row.country ?? null,
                state: row.state ?? null,
                city: row.city ?? null,
                area: row.area ?? null,
                postalCode: row.postalCode ?? null,
                freeformAddress: row.freeformAddress ?? null,
              },
            });
            if (updateResult.count > 0) {
              imported++;
            } else {
              // Row was deleted or moved to another tenant between detection and update
              errors.push({ row: -1, message: 'Overwrite target no longer exists or is inaccessible' });
            }
          } catch (err: any) {
            errors.push({ row: -1, message: err.message ?? 'Update failed' });
          }
        }

        const allErrors = [...rowErrors, ...errors];
        res.json({
          data: {
            imported,
            skipped: (onDuplicates === 'skip' ? duplicates.length : 0) + raceSkipped + invalidRowIndices.size,
            duplicates,
            failed: allErrors.length,
            errors: allErrors,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/stage-counts ──────────────────────────────
  router.get(
    '/stage-counts',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId, teamId, departmentId, scope } = (req as AuthenticatedRequest).user;

        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType,
          userId, teamId, departmentId, prisma, true
        );

        const where: Prisma.LeadWhereInput = {
          tenantId,
          deletedAt: { equals: null },
          ...ownerFilter,
        };

        const grouped = await prisma.lead.groupBy({
          by: ['stage'],
          where,
          _count: { id: true },
        });

        const counts: Record<string, number> = {};
        for (const g of grouped) {
          if (g.stage) counts[g.stage] = g._count.id;
        }

        res.json({ data: counts });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/assignment-summary ────────────────────────
  // Assignment distribution for higher-authority users: leads per owner,
  // unassigned count, how many the requesting user assigned (managerId
  // tracks the last assigner — see Lead.managerId in schema.prisma), and
  // role-grouped assignee options (roleGroups) for the dashboard filter.
  // Same tenant/scope filters as GET /leads.
  router.get(
    '/assignment-summary',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId, teamId, departmentId, scope } = (req as AuthenticatedRequest).user;

        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType,
          userId, teamId, departmentId, prisma, true
        );

        const where: Prisma.LeadWhereInput = {
          tenantId,
          deletedAt: { equals: null },
          ...ownerFilter,
        };

        const grouped = await prisma.lead.groupBy({
          by: ['ownerId'],
          where,
          _count: { id: true },
        });

        const unassigned = grouped.find(g => g.ownerId === null)?._count.id ?? 0;
        const ownerGroups = grouped.filter((g): g is typeof g & { ownerId: string } => g.ownerId !== null);

        const owners = ownerGroups.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: ownerGroups.map(g => g.ownerId) }, tenantId },
              select: { id: true, firstName: true, lastName: true },
            })
          : [];
        const nameById = Object.fromEntries(owners.map(u => [u.id, u]));

        const perOwner = ownerGroups
          .map(g => ({
            userId: g.ownerId,
            firstName: nameById[g.ownerId]?.firstName ?? null,
            lastName: nameById[g.ownerId]?.lastName ?? null,
            count: g._count.id,
          }))
          .sort((a, b) => b.count - a.count);

        const assignedByMe = await prisma.lead.count({ where: { ...where, managerId: userId } });

        // Role-grouped assignee options for the dashboard filter: every active
        // tenant user under their role(s) with live lead counts (0 when they own
        // none). User/UserRole/Role bypass db.ts scoping — explicit tenant +
        // soft-delete filters are load-bearing here.
        const allUsers = await prisma.user.findMany({
          where: { tenantId, deletedAt: null },
          select: { id: true, firstName: true, lastName: true },
        });
        const userById = new Map(allUsers.map((u) => [u.id, u]));
        const userRoles = allUsers.length > 0
          ? await prisma.userRole.findMany({
              where: {
                userId: { in: allUsers.map((u) => u.id) },
                role: { tenantId, deletedAt: null },
              },
              select: { userId: true, role: { select: { id: true, name: true } } },
            })
          : [];
        const countByOwner = new Map(ownerGroups.map((g) => [g.ownerId, g._count.id]));

        type AssigneeUser = { userId: string; firstName: string | null; lastName: string | null; count: number };
        const roleGroupsMap = new Map<string, { roleId: string; roleName: string; users: AssigneeUser[] }>();
        for (const ur of userRoles) {
          let group = roleGroupsMap.get(ur.role.id);
          if (!group) {
            group = { roleId: ur.role.id, roleName: ur.role.name, users: [] };
            roleGroupsMap.set(ur.role.id, group);
          }
          const u = userById.get(ur.userId);
          group.users.push({
            userId: ur.userId,
            firstName: u?.firstName ?? null,
            lastName: u?.lastName ?? null,
            count: countByOwner.get(ur.userId) ?? 0,
          });
        }
        const displayName = (u: AssigneeUser) => `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
        const roleGroups = [...roleGroupsMap.values()]
          .map((g) => ({
            ...g,
            users: g.users.sort((a, b) => b.count - a.count || displayName(a).localeCompare(displayName(b))),
          }))
          .sort((a, b) => a.roleName.localeCompare(b.roleName));

        res.json({ data: { total: unassigned + perOwner.reduce((s, o) => s + o.count, 0), unassigned, assignedByMe, perOwner, roleGroups } });
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
        const { userId, tenantId } = (req as AuthenticatedRequest).user;

        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize
          ? parseInt(req.query.pageSize as string, 10)
          : 50;

        if (page < 1 || isNaN(page)) {
          throw new ValidationError('page must be a positive integer.');
        }
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) {
          throw new ValidationError('pageSize must be between 1 and 200.');
        }

        const whereClause = await buildLeadFilterWhere(req);

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

        // Batch-load last meaningful activity per lead (single groupBy, no N+1)
        const leadIds = data.map((l: any) => l.id as string);
        const activityMaxes = leadIds.length > 0
          ? await (prisma as any).leadActivity.groupBy({
              by: ['leadId'],
              where: { leadId: { in: leadIds }, deletedAt: { equals: null } },
              _max: { createdAt: true },
            })
          : [];
        const activityMap: Record<string, string | null> = Object.fromEntries(
          activityMaxes.map((a: any) => [a.leadId, a._max.createdAt ? new Date(a._max.createdAt).toISOString() : null])
        );

        const enriched = data.map((l: any) => ({
          ...l,
          tags: (l.tags ?? []).map((a: any) => a.tag),
          owner: l.ownerId ? (ownerMap[l.ownerId] ?? null) : null,
          lastMeaningfulActivityAt: activityMap[l.id] ?? null,
        }));

        res.json({ data: enriched, total, page, pageSize });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/export ─────────────────────────────────────
  // Full-fidelity CSV source: every stored lead field plus owner/role info,
  // tags, and notes aggregated from LeadNote (real notes no longer live in
  // lead.notes). Same filters as GET /, or an explicit ?ids= list for
  // export-selected. Defined before /:id to avoid route conflict.
  router.get(
    '/export',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId, teamId, departmentId, scope } = (req as AuthenticatedRequest).user;
        const idsParam = req.query.ids as string | undefined;

        let where: Prisma.LeadWhereInput;
        if (idsParam !== undefined) {
          // Export-selected: explicit id list, still bounded by scope + tenant.
          const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
          if (ids.length === 0 || ids.length > 200) {
            throw new ValidationError('ids must contain between 1 and 200 comma-separated lead ids.');
          }
          const ownerFilter = await buildOwnerFilter(
            (scope ?? 'OWN') as ScopeType, userId, teamId, departmentId, prisma, true
          );
          where = { tenantId, deletedAt: { equals: null }, ...ownerFilter, id: { in: ids } };
        } else {
          where = await buildLeadFilterWhere(req);
        }

        const EXPORT_CAP = 10000;
        const leads = await prisma.lead.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: EXPORT_CAP,
          include: { tags: { include: { tag: true } } },
        });

        // Owner names + role names. User/UserRole/Role bypass db.ts scoping —
        // explicit tenant/soft-delete filters are load-bearing here.
        const ownerIds = [...new Set(leads.map((l) => l.ownerId).filter((v): v is string => Boolean(v)))];
        const owners = ownerIds.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: ownerIds }, tenantId },
              select: { id: true, firstName: true, lastName: true },
            })
          : [];
        const rolesByUser = new Map<string, string[]>();
        if (ownerIds.length > 0) {
          const userRoles = await prisma.userRole.findMany({
            where: { userId: { in: ownerIds }, role: { tenantId, deletedAt: null } },
            select: { userId: true, role: { select: { name: true } } },
          });
          for (const ur of userRoles) {
            const names = rolesByUser.get(ur.userId) ?? [];
            names.push(ur.role.name);
            rolesByUser.set(ur.userId, names);
          }
        }
        const ownerById = Object.fromEntries(owners.map((u) => [u.id, u]));

        // Notes aggregated from LeadNote, oldest → newest, newlines preserved.
        const leadIds = leads.map((l) => l.id);
        const notes = leadIds.length > 0
          ? await prisma.leadNote.findMany({
              where: { leadId: { in: leadIds }, deletedAt: { equals: null } },
              orderBy: [{ leadId: 'asc' }, { createdAt: 'asc' }],
              select: { leadId: true, content: true },
            })
          : [];
        const notesByLead = new Map<string, string[]>();
        for (const n of notes) {
          const list = notesByLead.get(n.leadId) ?? [];
          list.push(n.content);
          notesByLead.set(n.leadId, list);
        }

        const data = leads.map((l) => ({
          ...l,
          tags: ((l.tags as Array<{ tag: unknown }>) ?? []).map((a) => a.tag),
          owner: l.ownerId
            ? {
                id: l.ownerId,
                firstName: ownerById[l.ownerId]?.firstName ?? null,
                lastName: ownerById[l.ownerId]?.lastName ?? null,
                roleNames: rolesByUser.get(l.ownerId) ?? [],
              }
            : null,
          notesCount: notesByLead.get(l.id)?.length ?? 0,
          notesText: (notesByLead.get(l.id) ?? []).join('\n'),
        }));

        res.json({ data, total: data.length, truncated: leads.length >= EXPORT_CAP });
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

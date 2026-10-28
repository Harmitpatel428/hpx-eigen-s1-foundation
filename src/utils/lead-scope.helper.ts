import { PrismaClient } from '@prisma/client';
import { buildOwnerFilter, ScopeType, LeadOwnerFilter } from './scope.helper';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ResourceNotFoundError } from '../types/exceptions';

/** Owner-scope WHERE fragment for the caller, for Lead queries (incl. managerId delegation). */
export async function leadOwnerFilter(
  user: AuthenticatedRequest['user'],
  prisma: PrismaClient,
): Promise<LeadOwnerFilter> {
  return buildOwnerFilter(
    (user.scope ?? 'OWN') as ScopeType, user.userId, user.teamId ?? null, user.departmentId ?? null, prisma, true,
  );
}

/**
 * Write-side scope gate: throws 404 unless the lead is in the caller's visible set.
 * `deleted: false` (default) requires an active lead; `true` requires a soft-deleted one
 * (restore / permanent delete — soft-delete does not change ownership).
 */
export async function assertLeadInScope(
  user: AuthenticatedRequest['user'],
  prisma: PrismaClient,
  leadId: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  const filter = await leadOwnerFilter(user, prisma);
  const ok = await prisma.lead.findFirst({
    where: { id: leadId, tenantId: user.tenantId, deletedAt: opts.deleted ? { not: null } : null, ...filter },
    select: { id: true },
  });
  if (!ok) throw new ResourceNotFoundError();
}

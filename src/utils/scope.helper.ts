/**
 * ABAC Scope Helper — builds Prisma ownerId filter fragments.
 *
 * Used by all CRM controllers (leads, contacts, opportunities) to enforce
 * data visibility based on the authenticated user's ScopeType.
 *
 * OWN          → records owned by the requesting user
 * TEAM         → records owned by any member of the user's team
 * DEPARTMENT   → records owned by any member of the user's department
 * ORGANIZATION → all tenant records (no ownership filter)
 */
import { PrismaClient } from '@prisma/client';

export type ScopeType = 'OWN' | 'TEAM' | 'DEPARTMENT' | 'ORGANIZATION';

// Base filter — works for all CRM models (Contact, Opportunity, Lead without delegation)
export type OwnerFilter =
  | { ownerId: string }
  | { ownerId: { in: string[] } }
  | Record<string, never>;

// Lead-only extension — includes managerId for delegation-chain visibility
export type LeadOwnerFilter =
  | OwnerFilter
  | { OR: Array<{ ownerId: string } | { managerId: string }> };

/**
 * Build the ownerId where-clause fragment for a given ABAC scope.
 *
 * For TEAM and DEPARTMENT scopes, this fetches the member user IDs from the DB.
 * These results are NOT cached — they're expected to be small sets in practice
 * (<100 users per team/department). Add a Redis cache here in a future phase
 * if query profiling identifies this as a hot path.
 *
 * Pass includeManagerId=true only for Lead queries — Lead is the only model with
 * a managerId field (delegation chain visibility for OWN scope).
 */
export async function buildOwnerFilter(
  scope: ScopeType, userId: string, teamId: string | null,
  departmentId: string | null, prisma: PrismaClient, includeManagerId: true
): Promise<LeadOwnerFilter>;
export async function buildOwnerFilter(
  scope: ScopeType, userId: string, teamId: string | null,
  departmentId: string | null, prisma: PrismaClient, includeManagerId?: false
): Promise<OwnerFilter>;
export async function buildOwnerFilter(
  scope: ScopeType,
  userId: string,
  teamId: string | null,
  departmentId: string | null,
  prisma: PrismaClient,
  includeManagerId = false
): Promise<LeadOwnerFilter> {
  switch (scope) {
    case 'OWN':
      return includeManagerId
        ? { OR: [{ ownerId: userId }, { managerId: userId }] }
        : { ownerId: userId };

    case 'TEAM': {
      if (!teamId) {
        // User has no team — fall back to OWN scope
        return { ownerId: userId };
      }
      const members = await prisma.user.findMany({
        where: { teamId, deletedAt: { equals: null } },
        select: { id: true },
      });
      return { ownerId: { in: members.map((m) => m.id) } };
    }

    case 'DEPARTMENT': {
      if (!departmentId) {
        // User has no department — fall back to OWN scope
        return { ownerId: userId };
      }
      const members = await prisma.user.findMany({
        where: { departmentId, deletedAt: { equals: null } },
        select: { id: true },
      });
      return { ownerId: { in: members.map((m) => m.id) } };
    }

    case 'ORGANIZATION':
    default:
      // No ownership filter — user sees all tenant records
      return {};
  }
}

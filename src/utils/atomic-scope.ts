import { Prisma } from '@prisma/client';
import { ResourceNotFoundError } from '../types/exceptions';
import type { LeadOwnerFilter } from './scope.helper';

/**
 * Relation filter "the parent lead is live, in-tenant and inside the caller's scope" — spread it
 * into a child model's `where` (`lead: leadInScope(...)`) so scope and write are ONE statement.
 */
export function leadInScope(tenantId: string, filter: LeadOwnerFilter) {
  return { is: { tenantId, deletedAt: null, ...filter } as Prisma.LeadWhereInput };
}

/**
 * Await a scope-folded single-row write. A Prisma P2025 ("no row matched the WHERE") means the row
 * is gone, out of scope, or was reassigned after the pre-check — report it as 404, never a 200/500.
 */
export async function orNotFound<T>(write: PromiseLike<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') throw new ResourceNotFoundError();
    throw err;
  }
}

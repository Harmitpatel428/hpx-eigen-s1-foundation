import { Prisma } from '@prisma/client';
import { normalizePhone, isPhoneLikeTerm } from './phone.util';

/**
 * Prisma WHERE fragment: matches leads whose LeadPhone history contains
 * the normalized term. Spans ACTIVE + INACTIVE rows (historical search).
 * Uses equals for index-backed lookup; legacy lead.phone contains fallback
 * stays in callers for gradual migration.
 */
export function phoneSearchCondition(
  term: string,
  tenantId: string,
): Prisma.LeadWhereInput | null {
  if (!isPhoneLikeTerm(term)) return null;

  const normalized = normalizePhone(term);
  if (!normalized) return null;

  return {
    phones: {
      some: {
        tenantId,
        phoneNormalized: { equals: normalized },
      },
    },
  };
}

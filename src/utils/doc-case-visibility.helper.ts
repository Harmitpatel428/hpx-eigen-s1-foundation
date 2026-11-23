import { Prisma } from '@prisma/client';

/**
 * Union scope for Documentation cases: a caller WITHOUT `doc:case:view-all`
 * sees only cases they are assigned to (Sales→Doc or Doc→Process) or own via
 * the lead. `restrictToUserId` is undefined for full-queue callers (no filter).
 *
 * Mirrors the inline OR used by DocumentationService.listCases/getCaseById.
 * Those pre-date this helper and are left untouched; new code uses this.
 */
export function docCaseVisibilityWhere(restrictToUserId?: string): Prisma.DocCaseWhereInput {
  if (!restrictToUserId) return {};
  return {
    OR: [
      { assignedTo: restrictToUserId },
      { processAssignedTo: restrictToUserId },
      { lead: { ownerId: restrictToUserId } },
    ],
  };
}

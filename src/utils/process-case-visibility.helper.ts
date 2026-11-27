import { Prisma } from '@prisma/client';

/**
 * Process-queue visibility: a caller WITHOUT `process:case:view-all` sees only
 * the cases assigned to them (processAssignedTo = self). Full-queue callers
 * (Process Manager / admin) pass `undefined` → no extra filter.
 *
 * Always AND'd with tenantId + deletedAt: null + the Process status set by the
 * caller. Mirrors doc-case-visibility.helper.ts (narrower — Process cares only
 * about its own assignment, not Sales ownership or the doc assignee).
 */
export function processCaseVisibilityWhere(restrictToUserId?: string): Prisma.DocCaseWhereInput {
  return restrictToUserId ? { processAssignedTo: restrictToUserId } : {};
}

/**
 * Production boundary: the Documentation "Assigned" column shipped 2026-11-19
 * (frontend 306b0d7 / backend 8e1f96d, alongside the owner-resolution fix 8dab098).
 *
 * Cases created BEFORE this date predate the "Assign" action (which writes Lead.ownerId),
 * so their DocCase.assignedTo — set at creation / handoff-accept — IS the real assignee.
 * Cases created ON/AFTER it follow the modern rule that 8dab098 locked in: only a formal
 * owner counts; a bare assignedTo is a transient handoff state, not an assignment.
 *
 * ponytail: createdAt is a proxy for assignment time and the boundary is a day, not the
 * exact deploy instant — rows assigned within ~a day of release can misclassify. Set this
 * to the real prod deploy timestamp to tighten it; if unsure, err later (more rows treated
 * as historical = more assignees shown, which is the bug we are fixing).
 */
export const ASSIGNED_COLUMN_RELEASE_DATE = new Date('2026-11-19T00:00:00Z');

/**
 * Resolve the user shown in the Documentation "Assigned" column.
 *
 *  1. Lead.ownerId — the "Assign" action writes this; a formal owner always wins and is
 *     never shadowed by the fallback. An owner that is set but unresolvable (deactivated /
 *     cross-tenant) returns null rather than resurrecting a stale historical name.
 *  2. DocCase.assignedTo — ONLY for legacy cases (createdAt < releaseDate). Without this,
 *     pre-feature cases render "—" despite being assigned. Gated so a modern handoff
 *     (assignedTo set, no owner) stays unassigned, preserving the 8dab098 invariant.
 *
 * `userMap` is a tenant-scoped id→user lookup, so an id from another tenant never resolves.
 */
export function resolveDocAssignee<T>(
  ownerId: string | null | undefined,
  assignedTo: string | null | undefined,
  createdAt: Date,
  userMap: Map<string, T>,
  releaseDate: Date = ASSIGNED_COLUMN_RELEASE_DATE,
): T | null {
  if (ownerId) return userMap.get(ownerId) ?? null;
  if (assignedTo && createdAt < releaseDate) return userMap.get(assignedTo) ?? null;
  return null;
}

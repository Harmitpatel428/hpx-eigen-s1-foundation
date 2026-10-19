/**
 * Documentation → Process handoff state machine (Option B).
 *
 * The outbound mirror of src/domain/handoff.ts: a case is handed to Process as
 * PENDING_PROCESS_REVIEW and only becomes Process-owned (TRANSFERRED_TO_PROCESS)
 * once Process explicitly accepts. Process may return it (with a mandatory
 * reason) while it is still pending review; after acceptance it is Process-owned
 * and a CRM-side return is no longer allowed.
 *
 * Pure functions only: no Prisma, no I/O. Every rule here is re-checked
 * server-side before any write — the frontend copy is display-only.
 */
import { DocCaseStatus, ProcessHandoffState, ProcessReturnReason } from '@prisma/client';
// Reuse the inbound module's result shape so both state machines speak the same contract.
import type { TransitionCheck } from './handoff';

export type ProcessHandoffAction =
  | 'TRANSFER' // Documentation hands a ready case to Process
  | 'ACCEPT'   // Process takes ownership
  | 'RETURN';  // Process sends it back to Documentation (reason required)

const ALLOW: TransitionCheck = { allowed: true };
const deny = (reason: string): TransitionCheck => ({ allowed: false, reason });

// ─── Single source of truth for status preconditions ────────────────────────
// canTransition AND the Phase-3 preconditioned updateMany both derive from these
// sets, so the in-memory guard and the DB WHERE clause can never drift apart.
const TRANSFER_FROM_STATUS: DocCaseStatus[] = [
  DocCaseStatus.ACTIVE,
  DocCaseStatus.DOCUMENTATION_READY,
  DocCaseStatus.RETURNED_TO_DOCUMENTATION,
];
const TRANSFER_FROM_PHSTATE: ProcessHandoffState[] = [
  ProcessHandoffState.NONE,
  ProcessHandoffState.RETURNED,
];
const PENDING_STATUS: DocCaseStatus[] = [DocCaseStatus.PENDING_PROCESS_REVIEW];
const PENDING_PHSTATE: ProcessHandoffState[] = [ProcessHandoffState.PENDING_REVIEW];

export interface StatusPrecondition {
  status: DocCaseStatus[];
  processHandoffState: ProcessHandoffState[];
}

/**
 * The WHERE-clause descriptor Phase 3 feeds into a preconditioned updateMany:
 *   updateMany({ where: { id, tenantId, status: { in: pre.status },
 *                         processHandoffState: { in: pre.processHandoffState } }, ... })
 * A 0-row result means another actor moved the case first (duplicate/stale) →
 * reject. Readiness (isReady / manager override) for TRANSFER is enforced
 * separately in the service, exactly as the inbound machine leaves isReady to
 * its service; it is not derivable from status alone.
 */
export function precondition(action: ProcessHandoffAction): StatusPrecondition {
  switch (action) {
    case 'TRANSFER':
      return { status: [...TRANSFER_FROM_STATUS], processHandoffState: [...TRANSFER_FROM_PHSTATE] };
    case 'ACCEPT':
    case 'RETURN':
      return { status: [...PENDING_STATUS], processHandoffState: [...PENDING_PHSTATE] };
  }
}

/**
 * Guard a Doc→Process transition on state legality alone. Allowed IFF the
 * current (status, processHandoffState) satisfies `precondition(action)` — the
 * two are kept identical on purpose (see the coherence test).
 */
export function canTransition(
  action: ProcessHandoffAction,
  status: DocCaseStatus,
  processHandoffState: ProcessHandoffState,
): TransitionCheck {
  switch (action) {
    case 'TRANSFER':
      if (status === DocCaseStatus.PENDING_PROCESS_REVIEW || status === DocCaseStatus.TRANSFERRED_TO_PROCESS)
        return deny('This case is already with Process.');
      if (
        status === DocCaseStatus.CLOSED ||
        status === DocCaseStatus.CANCELLED ||
        status === DocCaseStatus.CLOSED_NO_DOCS
      )
        return deny('This case is closed.');
      if (!TRANSFER_FROM_STATUS.includes(status) || !TRANSFER_FROM_PHSTATE.includes(processHandoffState))
        return deny('Only a Documentation-owned case can be transferred to Process.');
      return ALLOW;

    case 'ACCEPT':
      if (!PENDING_STATUS.includes(status) || !PENDING_PHSTATE.includes(processHandoffState))
        return deny('Only a case pending Process review can be accepted.');
      return ALLOW;

    // Return is valid only before Process accepts. Once accepted, Process owns
    // the case and must use a Process correction flow instead.
    case 'RETURN':
      if (!PENDING_STATUS.includes(status) || !PENDING_PHSTATE.includes(processHandoffState))
        return deny('Only a case pending Process review can be returned to Documentation.');
      return ALLOW;

    default:
      return deny('Unknown action.');
  }
}

/**
 * Return validation: a reason from ProcessReturnReason is always required; a
 * free-text note is required only when the reason is OTHER. (Ratified binding
 * 2026-10-19 — supersedes the design doc's "note >=10 chars always".)
 */
export function checkReturnReason(
  reason: ProcessReturnReason | null | undefined,
  note: string | null | undefined,
): TransitionCheck {
  if (!reason) return deny('A return reason is required.');
  if (!Object.values(ProcessReturnReason).includes(reason)) return deny('Invalid return reason.');
  if (reason === ProcessReturnReason.OTHER && !(note && note.trim().length > 0))
    return deny('A note is required when the return reason is OTHER.');
  return ALLOW;
}

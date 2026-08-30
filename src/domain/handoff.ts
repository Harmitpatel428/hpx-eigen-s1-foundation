/**
 * Handoff state machine and Fix & Resend gating.
 *
 * This module is the source of truth. The frontend has a mirror copy for
 * display hints only — every rule here is re-checked server-side before any
 * write, because the client copy is trivially bypassed.
 *
 * Pure functions only: no Prisma, no I/O. That is what makes it testable.
 */
import { DocCaseStatus, HandoffState, HandoffReturnReason } from '@prisma/client';

// ─── Ageing ladder ───────────────────────────────────────────────────────────
// Hours since handoff. Drives the Documentation inbox badge colour.

export const HANDOFF_AGING_THRESHOLDS = {
  FRESH: 24,    // < 24 h
  STALE: 48,    // 24–48 h
  WARNING: 96,  // 48–96 h
  CRITICAL: 168 // 96–168 h (7 days), then OVERDUE
} as const;

export type HandoffAge = 'FRESH' | 'STALE' | 'WARNING' | 'CRITICAL' | 'OVERDUE';

export function getHandoffAge(handoffAt: Date, now: Date = new Date()): HandoffAge {
  const hours = (now.getTime() - handoffAt.getTime()) / 3_600_000;
  if (hours < HANDOFF_AGING_THRESHOLDS.FRESH) return 'FRESH';
  if (hours < HANDOFF_AGING_THRESHOLDS.STALE) return 'STALE';
  if (hours < HANDOFF_AGING_THRESHOLDS.WARNING) return 'WARNING';
  if (hours < HANDOFF_AGING_THRESHOLDS.CRITICAL) return 'CRITICAL';
  return 'OVERDUE';
}

/** A returned case auto-drops the lead to Follow-Up 7 days later. */
export const AUTO_DROP_DAYS = 7;

export function computeAutoDropAt(returnedAt: Date): Date {
  return new Date(returnedAt.getTime() + AUTO_DROP_DAYS * 24 * 3_600_000);
}

// ─── Manager review lock ─────────────────────────────────────────────────────

export const MANAGER_REVIEW_RETURN_THRESHOLD = 2;

export function shouldRequireManagerReview(returnCount: number): boolean {
  return returnCount >= MANAGER_REVIEW_RETURN_THRESHOLD;
}

// ─── Transition guards ───────────────────────────────────────────────────────

export type HandoffAction =
  | 'CONFIRM'   // Sales hands a qualified lead to Documentation
  | 'ACCEPT'    // Documentation takes ownership
  | 'REJECT'    // Documentation refuses BEFORE accepting
  | 'RETURN'    // Documentation sends back AFTER accepting
  | 'RESEND'    // Sales fixes and re-submits
  | 'AUTO_DROP';

export interface TransitionCheck {
  allowed: boolean;
  /** Machine-readable reason, safe to surface to staff (never to portal clients). */
  reason?: string;
}

const ALLOW: TransitionCheck = { allowed: true };
const deny = (reason: string): TransitionCheck => ({ allowed: false, reason });

/**
 * Reject and Return are deliberately separate actions with separate guards and
 * separate audit events. Collapsing them would lose the distinction between
 * "Documentation never took this on" and "Documentation owned it and gave it
 * back", which drives different Sales workflows and different SLA clocks.
 */
export function canTransition(
  action: HandoffAction,
  status: DocCaseStatus,
  handoffState: HandoffState,
  managerReviewRequired: boolean,
): TransitionCheck {
  switch (action) {
    case 'CONFIRM':
      if (handoffState !== HandoffState.NONE)
        return deny('This lead has already been handed off.');
      return ALLOW;

    case 'ACCEPT':
      if (status !== DocCaseStatus.INCOMING)
        return deny('Only an incoming handoff can be accepted.');
      return ALLOW;

    // Reject is valid ONLY before acceptance.
    case 'REJECT':
      if (status !== DocCaseStatus.INCOMING)
        return deny('This case has already been accepted — use Return instead.');
      return ALLOW;

    // Return is valid ONLY after acceptance, and never once Process owns the case.
    case 'RETURN':
      if (status === DocCaseStatus.TRANSFERRED_TO_PROCESS)
        return deny('Process owns this case. Use a Process correction flow.');
      if (status === DocCaseStatus.CLOSED || status === DocCaseStatus.CANCELLED)
        return deny('This case is closed.');
      if (status !== DocCaseStatus.ACTIVE && status !== DocCaseStatus.DOCUMENTATION_READY)
        return deny('Only an accepted case can be returned.');
      return ALLOW;

    case 'RESEND':
      if (managerReviewRequired)
        return deny('Manager review is required before this case can be resent.');
      if (status !== DocCaseStatus.INCOMING && status !== DocCaseStatus.RETURNED)
        return deny('Only a rejected or returned case can be resent.');
      if (handoffState !== HandoffState.RETURNED && handoffState !== HandoffState.NONE)
        return deny('This case is not awaiting a fix.');
      return ALLOW;

    case 'AUTO_DROP':
      if (status !== DocCaseStatus.RETURNED)
        return deny('Only a returned case can auto-drop.');
      return ALLOW;

    default:
      return deny('Unknown action.');
  }
}

// ─── Fix & Resend gating ─────────────────────────────────────────────────────

export interface ResendContext {
  returnReasonCode: HandoffReturnReason | null;
  resolutionNote: string;
  /** Phone on the lead when it was returned. */
  phoneAtHandoff: string | null;
  /** Phone on the lead right now. */
  currentPhone: string | null;
  /** True when an approved PortalContactChangeRequest covers this case. */
  hasApprovedContactOverride: boolean;
  presetAtHandoff: string | null;
  currentPreset: string | null;
}

export const MIN_RESOLUTION_NOTE_LENGTH = 10;

/**
 * A resend must prove the underlying problem was actually fixed — a note alone
 * is not evidence. Each reason code has its own proof obligation.
 */
export function checkResendAllowed(ctx: ResendContext): TransitionCheck {
  const note = ctx.resolutionNote?.trim() ?? '';
  if (note.length < MIN_RESOLUTION_NOTE_LENGTH)
    return deny(`A resolution note of at least ${MIN_RESOLUTION_NOTE_LENGTH} characters is required.`);

  switch (ctx.returnReasonCode) {
    case HandoffReturnReason.WRONG_OR_MISSING_CONTACT: {
      if (ctx.hasApprovedContactOverride) return ALLOW;
      const before = (ctx.phoneAtHandoff ?? '').replace(/\D/g, '');
      const now = (ctx.currentPhone ?? '').replace(/\D/g, '');
      if (!now)
        return deny('A contact number is required before this case can be resent.');
      if (before === now)
        return deny('The contact number has not changed. Update it, or get an approved portal contact override.');
      return ALLOW;
    }

    case HandoffReturnReason.WRONG_PRESET: {
      if (!ctx.currentPreset)
        return deny('A document preset must be selected before resending.');
      if (ctx.presetAtHandoff === ctx.currentPreset)
        return deny('The document preset has not changed.');
      return ALLOW;
    }

    // A compliance rejection is never self-service — it needs a manager.
    case HandoffReturnReason.COMPLIANCE_ISSUE:
      return deny('Compliance issues require manager review before resending.');

    // A duplicate is resolved by closing one of the cases, not by resending.
    case HandoffReturnReason.DUPLICATE_CASE:
      return deny('Duplicate cases require manager review before resending.');

    default:
      return ALLOW;
  }
}

/**
 * Reasons that force manager review immediately, regardless of return count.
 * Duplicate-case rejection is an explicit override requirement.
 */
const ALWAYS_MANAGER_REVIEW: HandoffReturnReason[] = [
  HandoffReturnReason.DUPLICATE_CASE,
  HandoffReturnReason.COMPLIANCE_ISSUE,
];

export function requiresManagerReviewAfterReturn(
  returnCount: number,
  reason: HandoffReturnReason | null,
): boolean {
  if (reason && ALWAYS_MANAGER_REVIEW.includes(reason)) return true;
  return shouldRequireManagerReview(returnCount);
}

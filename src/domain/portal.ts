/**
 * Client portal rules: activation, session policy, and the single generic
 * failure response.
 *
 * Pure functions only — no Prisma, no I/O.
 */
import crypto from 'crypto';
import { DocCaseStatus } from '@prisma/client';

// ─── Auth policy ─────────────────────────────────────────────────────────────

export const PORTAL_AUTH = {
  MAX_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 30,
  SESSION_MINUTES: 15,
  TOKEN_BYTES: 32,
} as const;

/**
 * The ONLY response any portal verification failure may produce.
 *
 * Wrong case number, wrong digits, case not found, portal not activated, case
 * closed, and locked out must be indistinguishable to the caller. Anything else
 * turns the endpoint into a case-number oracle.
 */
export const PORTAL_VERIFICATION_FAILED = {
  error: 'VERIFICATION_FAILED',
  message: "We couldn't verify those details.",
} as const;

export const PORTAL_HTTP_STATUS = 401;

// ─── Session tokens ──────────────────────────────────────────────────────────

/** 32 random bytes, base64url. Returned to the client once and never stored raw. */
export function generateSessionToken(): string {
  return crypto.randomBytes(PORTAL_AUTH.TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + PORTAL_AUTH.SESSION_MINUTES * 60_000);
}

/**
 * Constant-time compare of the 4 phone digits.
 *
 * `timingSafeEqual` throws on length mismatch, so compare fixed-width SHA-256
 * digests instead of the raw strings — that keeps the comparison constant-time
 * for wrong-length input too.
 */
export function safeCompareDigits(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ─── Activation ──────────────────────────────────────────────────────────────

export const PORTAL_CLOSED_STATUSES: DocCaseStatus[] = [
  DocCaseStatus.CLOSED,
  DocCaseStatus.CANCELLED,
  // closeWithoutDocs deactivates the portal; without this entry any activation path
  // (publish, contact change, manual activate, backfill) could switch it back on.
  DocCaseStatus.CLOSED_NO_DOCS,
];

/**
 * Single status source of truth for the portal: a case is portal-eligible in
 * any status except the closed ones. Activation (enable + manual activate) uses
 * the SAME predicate as access, so a case can never be stranded — permitted to
 * hold a portal by the access gate yet forbidden from ever activating one.
 * Activation still requires its explicit trigger (a client-visible publish or an
 * audited manual activation); eligibility only removes the status dead-end.
 */
export function isPortalEligibleStatus(status: DocCaseStatus): boolean {
  return !PORTAL_CLOSED_STATUSES.includes(status);
}

export interface PortalAccessInput {
  portalEnabledAt: Date | null;
  portalPhoneLast4: string | null;
  status: DocCaseStatus;
}

/**
 * A portal is reachable only once portalEnabledAt is set (at handoff or an
 * approved contact change, i.e. as soon as a phone snapshot exists), and only
 * while the case is open. Callers must not surface
 * WHY this returned false to an unauthenticated client.
 */
export function isPortalAccessible(input: PortalAccessInput): boolean {
  if (!input.portalEnabledAt) return false;
  if (!input.portalPhoneLast4) return false;
  if (!isPortalEligibleStatus(input.status)) return false;
  return true;
}

// ─── Client-facing projections ───────────────────────────────────────────────

/**
 * Client-facing document status: the 11 internal DocDocumentStatus values collapse to THREE
 * client-meaningful categories, and two are withheld entirely.
 *
 * Policy (product-owner decision 2026-11-03, widening the prior 2-value RECEIVED/PENDING collapse):
 *  - ACTION_REQUIRED ← REQUESTED, PENDING_COLLECTION, REJECTED, RE_REQUESTED, EXPIRED
 *  - AWAITING_REVIEW ← RECEIVED, UNDER_VERIFICATION
 *  - APPROVED        ← APPROVED, MANAGER_APPROVED
 *  - null (not delivered) ← NOT_APPLICABLE, WAIVED (nothing actionable for the client)
 *  - unknown/future value → ACTION_REQUIRED (safe default; never crash)
 *
 * Still excluded by security policy: rejection reasons, storage/download references, internal
 * verification notes. REJECTED folds into ACTION_REQUIRED with NO reason — a client never sees an
 * internal verification judgement, only that the document needs their attention.
 */
export type ClientDocStatus = 'ACTION_REQUIRED' | 'AWAITING_REVIEW' | 'APPROVED';

const CLIENT_DOC_STATUS: Record<string, ClientDocStatus | null> = {
  REQUESTED: 'ACTION_REQUIRED',
  PENDING_COLLECTION: 'ACTION_REQUIRED',
  REJECTED: 'ACTION_REQUIRED',
  RE_REQUESTED: 'ACTION_REQUIRED',
  EXPIRED: 'ACTION_REQUIRED',
  RECEIVED: 'AWAITING_REVIEW',
  UNDER_VERIFICATION: 'AWAITING_REVIEW',
  APPROVED: 'APPROVED',
  MANAGER_APPROVED: 'APPROVED',
  NOT_APPLICABLE: null,
  WAIVED: null,
};

export function toClientDocStatus(status: string): ClientDocStatus | null {
  return status in CLIENT_DOC_STATUS ? CLIENT_DOC_STATUS[status] : 'ACTION_REQUIRED';
}

export const PORTAL_PROGRESS_STAGES = [
  { key: 'RECEIVED', label: 'Application received' },
  { key: 'IN_REVIEW', label: 'Documents under review' },
  { key: 'VERIFIED', label: 'Verification complete' },
  { key: 'PROCESSING', label: 'Processing' },
  { key: 'COMPLETED', label: 'Case completed' },
] as const;

/** Map internal case status onto the 5 client-facing progress stages. */
export function progressStageFor(status: DocCaseStatus): string {
  switch (status) {
    case DocCaseStatus.INCOMING:
    case DocCaseStatus.RETURNED:
      return 'RECEIVED';
    case DocCaseStatus.ACTIVE:
      return 'IN_REVIEW';
    case DocCaseStatus.DOCUMENTATION_READY:
      return 'VERIFIED';
    // Handed to Process (awaiting acceptance) or accepted — the client sees "processing".
    case DocCaseStatus.PENDING_PROCESS_REVIEW:
    case DocCaseStatus.TRANSFERRED_TO_PROCESS:
      return 'PROCESSING';
    // Process sent it back; Documentation is reworking it — back to "under review".
    case DocCaseStatus.RETURNED_TO_DOCUMENTATION:
      return 'IN_REVIEW';
    case DocCaseStatus.CLOSED:
      return 'COMPLETED';
    default:
      return 'RECEIVED';
  }
}

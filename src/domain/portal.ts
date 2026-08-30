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

const PORTAL_CLOSED_STATUSES: DocCaseStatus[] = [
  DocCaseStatus.CLOSED,
  DocCaseStatus.CANCELLED,
];

export interface PortalAccessInput {
  portalEnabledAt: Date | null;
  portalPhoneLast4: string | null;
  status: DocCaseStatus;
}

/**
 * A portal is reachable only after a first client-visible publish set
 * portalEnabledAt, and only while the case is open. Callers must not surface
 * WHY this returned false to an unauthenticated client.
 */
export function isPortalAccessible(input: PortalAccessInput): boolean {
  if (!input.portalEnabledAt) return false;
  if (!input.portalPhoneLast4) return false;
  if (PORTAL_CLOSED_STATUSES.includes(input.status)) return false;
  return true;
}

// ─── Client-facing projections ───────────────────────────────────────────────

/**
 * Internal document statuses collapse to two client-facing words.
 *
 * REJECTED must never reach the portal: a client seeing "rejected" on a
 * document they submitted generates a support call and leaks an internal
 * verification judgement. Pending is the honest client-facing state.
 */
export function toClientDocStatus(status: string): 'RECEIVED' | 'PENDING' {
  return ['RECEIVED', 'UNDER_VERIFICATION', 'VERIFIED', 'APPROVED', 'MANAGER_APPROVED'].includes(status)
    ? 'RECEIVED'
    : 'PENDING';
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
    case DocCaseStatus.TRANSFERRED_TO_PROCESS:
      return 'PROCESSING';
    case DocCaseStatus.CLOSED:
      return 'COMPLETED';
    default:
      return 'RECEIVED';
  }
}

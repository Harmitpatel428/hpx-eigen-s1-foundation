/**
 * Mandate Lifecycle — Frontend API Contract
 *
 * Generated from backend router (mandate.router.ts) and service (mandate.service.ts).
 * All 8 endpoints documented with request/response shapes and HTTP status codes.
 *
 * A9 ENFORCEMENT: No response ever contains storageKey, uploadTokenHash, or raw tokens
 * beyond the single sendMandate response.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export type MandateRequestStatus =
  | 'PENDING_UPLOAD'
  | 'UPLOADED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export type AllowedContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MANDATE_POLICY = {
  MAX_FILE_SIZE_BYTES: 5_242_880,
  TOKEN_EXPIRY_DAYS: 7,
  PRESIGNED_URL_SECONDS: 900,
  ALLOWED_CONTENT_TYPES: ['application/pdf', 'image/jpeg', 'image/png'] as const,
} as const;

// ─── Shared Envelope ────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  error: string;
  message: string;
}

// ─── 1. POST /api/v1/cases/:caseId/mandate/send ────────────────────────────
// Auth: Bearer token + mandate:send permission

export interface SendMandateRequest {
  mandateType: string;   // 1-200 chars
  description?: string;  // max 1000 chars
  sendEmail?: boolean;
}

export interface SendMandateResponse {
  mandateRequestId: string;
  uploadToken: string;   // raw token — returned ONCE, never persisted
  expiresAt: string;     // ISO 8601
}

// Status codes: 201 created | 400 validation | 403 forbidden | 404 case not found/wrong tenant | 422 case closed or UPLOADED block

// ─── 2. POST /api/v1/mandate/upload-url ─────────────────────────────────────
// Auth: NONE (token in body is the credential)

export interface RequestUploadUrlRequest {
  token: string;          // UUID
  fileName: string;       // 1-255 chars
  contentType: AllowedContentType;
  fileSizeBytes: number;  // positive int, max 5_242_880
}

export interface RequestUploadUrlResponse {
  uploadUrl: string;      // presigned PUT URL (15 min expiry)
  uploadId: string;       // UUID — pass to confirm-upload
  expiresAt: string;      // ISO 8601
}

// Status codes: 200 ok | 400 validation | 410 expired/wrong status | 429 rate limited | 503 service unavailable

// ─── 3. POST /api/v1/mandate/confirm-upload ─────────────────────────────────
// Auth: NONE (token in body is the credential)

export interface ConfirmUploadRequest {
  token: string;     // UUID
  uploadId: string;  // UUID from upload-url response
  fileName: string;  // 1-255 chars
}

export interface ConfirmUploadResponse {
  uploadId: string;
  status: 'UPLOADED';
}

// Status codes: 200 ok | 400 validation | 409 file missing or already confirmed | 410 expired/wrong status | 413 oversize | 415 bad content type | 429 rate limited | 503 service unavailable

// ─── 4. POST /api/v1/mandate/:id/verify ─────────────────────────────────────
// Auth: Bearer token + mandate:verify permission

// No request body

export interface VerifyMandateResponse {
  id: string;
  status: 'VERIFIED';
  verifiedAt: string;  // ISO 8601
}

// Status codes: 200 ok | 400 invalid id | 403 forbidden | 404 not found/wrong tenant | 422 not in UPLOADED status

// ─── 5. POST /api/v1/mandate/:id/reject ─────────────────────────────────────
// Auth: Bearer token + mandate:verify permission

export interface RejectMandateRequest {
  reason: string;  // 1-1000 chars
}

export interface RejectMandateResponse {
  id: string;
  status: 'REJECTED';
  rejectedAt: string;     // ISO 8601
  rejectionReason: string;
}

// Status codes: 200 ok | 400 validation | 403 forbidden | 404 not found/wrong tenant | 422 not in UPLOADED status

// ─── 6. POST /api/v1/mandate/:id/regenerate-link ────────────────────────────
// Auth: Bearer token + mandate:send permission

// No request body

export interface RegenerateLinkResponse {
  mandateRequestId: string;  // NEW request id (old is SUPERSEDED)
  uploadToken: string;       // raw token — returned ONCE
  expiresAt: string;         // ISO 8601
}

// Status codes: 201 created | 400 invalid id | 403 forbidden | 404 not found/wrong tenant | 422 not in PENDING_UPLOAD/REJECTED/EXPIRED

// ─── 7. GET /api/v1/mandate/uploads/:uploadId/view-url ─────────────────────
// Auth: Bearer token + mandate:view permission
// NOTE: uploadId here is the MandateUpload DB record id, NOT the R2 path-segment uploadId

export interface GetViewUrlResponse {
  viewUrl: string;          // presigned GET URL (15 min expiry)
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  expiresAt: string;        // ISO 8601
}

// Status codes: 200 ok | 400 invalid id | 403 forbidden | 404 not found/wrong tenant

// ─── 8. GET /api/v1/cases/:caseId/mandate ───────────────────────────────────
// Auth: Bearer token + mandate:view permission

export interface MandateUploadSummary {
  id: string;
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  uploadedAt: string;  // ISO 8601
}

export interface MandateRequestSummary {
  id: string;
  mandateType: string;
  status: MandateRequestStatus;
  sentToEmail: string | null;   // masked (e.g. "ha***@gmail.com")
  sentByUserId: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  tokenExpiresAt: string;
  createdAt: string;
  uploads: MandateUploadSummary[];
}

export interface ListForCaseResponse {
  requests: MandateRequestSummary[];
}

// Status codes: 200 ok | 400 invalid caseId | 403 forbidden | 404 case not found/wrong tenant

// ─── Error Shapes ───────────────────────────────────────────────────────────

/**
 * All error responses follow this shape:
 * { error: ERROR_CODE, message: string }
 *
 * Error codes by HTTP status:
 *   400 VALIDATION_ERROR        — malformed input
 *   403 FORBIDDEN               — missing permission (from auth middleware)
 *   404 NOT_FOUND               — resource not found or wrong tenant
 *   409 CONFLICT                — file missing in R2 or already confirmed
 *   410 GONE                    — token expired or request in terminal status
 *   413 PAYLOAD_TOO_LARGE       — file exceeds 5 MB
 *   415 UNSUPPORTED_MEDIA_TYPE  — content type not in allowlist
 *   422 BUSINESS_RULE_VIOLATION — case closed, UPLOADED blocks new send, etc.
 *   429 RATE_LIMIT_EXCEEDED     — 5 attempts/hr per token hash
 *   503 SERVICE_UNAVAILABLE     — Redis/R2 down (fail-closed)
 */
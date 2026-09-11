import crypto from 'crypto';
import { MandateRequestStatus } from '@prisma/client';

export const MANDATE_POLICY = {
  TOKEN_EXPIRY_DAYS: 7,
  PRESIGNED_URL_SECONDS: 900,
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024,
  ALLOWED_CONTENT_TYPES: ['application/pdf', 'image/jpeg', 'image/png'] as readonly string[],
} as const;

export function generateUploadToken(): string {
  return crypto.randomUUID();
}

export function hashUploadToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function tokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + MANDATE_POLICY.TOKEN_EXPIRY_DAYS * 24 * 60 * 60_000);
}

export function isTokenExpired(expiresAt: Date): boolean {
  return new Date() >= expiresAt;
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\x00/\\:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '.')
    .substring(0, 255);
}

export function mandateStagingKey(
  tenantId: string, requestId: string, uploadId: string, fileName: string,
): string {
  return `tenants/${tenantId}/mandates/${requestId}/staging/${uploadId}/${sanitizeFileName(fileName)}`;
}

export function mandateFinalKey(
  tenantId: string, requestId: string, uploadId: string, fileName: string,
): string {
  return `tenants/${tenantId}/mandates/${requestId}/uploads/${uploadId}/${sanitizeFileName(fileName)}`;
}

export function isAllowedContentType(contentType: string): boolean {
  return MANDATE_POLICY.ALLOWED_CONTENT_TYPES.includes(contentType);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.length <= 2 ? local[0] : local.substring(0, 2);
  return `${visible}***@${domain}`;
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '****' + phone.slice(-4);
}

const VALID_TRANSITIONS: Record<MandateRequestStatus, MandateRequestStatus[]> = {
  PENDING_UPLOAD: ['UPLOADED', 'EXPIRED', 'SUPERSEDED'],
  UPLOADED:       ['VERIFIED', 'REJECTED', 'SUPERSEDED'],
  VERIFIED:       [],
  REJECTED:       ['SUPERSEDED'],
  EXPIRED:        ['SUPERSEDED'],
  SUPERSEDED:     [],
};

export function canTransitionMandate(from: MandateRequestStatus, to: MandateRequestStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
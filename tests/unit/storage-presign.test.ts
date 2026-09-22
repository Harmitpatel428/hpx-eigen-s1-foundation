/**
 * R2 presign unit (Testing ID R2) — the signed upload URL cryptographically binds
 * the authorized Content-Length, so the client cannot PUT an object larger than the
 * server sanctioned. Content-Type is NOT bound by the presign signature (aws-sdk v3
 * does not sign it for a presigned PUT); it is enforced server-side at confirm via
 * isAllowedContentType + the headObject/magic-byte gate (covered by firm-upload and
 * mandate-lifecycle). Signing is local — no network. See ponytail: comment below.
 */
import { describe, it, expect } from '@jest/globals';
import { storageService } from '../../src/services/storage.service';

describe('R2 presign binds Content-Length (R2)', () => {
  it('upload URL signs content-length; expiry is in the future', async () => {
    process.env.R2_ACCOUNT_ID = 'test-acct';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';

    const { url, expiresAt } = await storageService.generateUploadUrl(
      'doc-uploads/t/c/d/file.pdf',
      'application/pdf',
      5 * 1024 * 1024,
      900,
    );

    const signed = (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').toLowerCase();
    // ponytail: Content-Length is the header the presign actually binds; Content-Type
    // enforcement lives at confirm (magic-byte gate), not in this signature.
    expect(signed).toContain('content-length');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

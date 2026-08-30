import { DocCaseStatus } from '@prisma/client';
import {
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  safeCompareDigits,
  isPortalAccessible,
  toClientDocStatus,
  progressStageFor,
  PORTAL_AUTH,
  PORTAL_VERIFICATION_FAILED,
  PORTAL_HTTP_STATUS,
} from '../../src/domain/portal';
import {
  generateCaseNumber,
  isValidCaseNumber,
  normaliseCaseNumber,
  phoneLast4,
} from '../../src/domain/caseNumber';

describe('case number', () => {
  it('accepts a canonical id', () => {
    expect(isValidCaseNumber('HPX-7K3M-92QD')).toBe(true);
  });

  it('accepts lowercase by normalising case', () => {
    expect(isValidCaseNumber('hpx-7k3m-92qd')).toBe(true);
  });

  it.each([
    ['HPX-7K3M', 'too short'],
    ['ABC-7K3M-92QD', 'wrong prefix'],
    ['HPX7K3M92QD', 'missing dashes'],
    ['HPX-7K3M-92QDX', 'too long'],
    ['', 'empty'],
  ])('rejects %s (%s)', (input) => {
    expect(isValidCaseNumber(input)).toBe(false);
  });

  // The ambiguous-glyph exclusion is a real requirement: clients read these aloud.
  it.each(['HPX-I23M-92QD', 'HPX-O23M-92QD', 'HPX-023M-92QD', 'HPX-123M-92QD'])(
    'rejects ambiguous glyph in %s', (input) => {
      expect(isValidCaseNumber(input)).toBe(false);
    });

  it('generates ids that pass its own validator', () => {
    for (let i = 0; i < 200; i++) {
      expect(isValidCaseNumber(generateCaseNumber())).toBe(true);
    }
  });

  it('never emits an ambiguous glyph', () => {
    const joined = Array.from({ length: 300 }, () => generateCaseNumber()).join('');
    expect(joined).not.toMatch(/[IO01]/);
  });

  it('does not repeat within a large sample', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateCaseNumber()));
    expect(ids.size).toBe(2000);
  });

  describe('normalisation', () => {
    it.each([
      ['hpx7k3m92qd', 'HPX-7K3M-92QD'],
      ['HPX 7K3M 92QD', 'HPX-7K3M-92QD'],
      ['7k3m92qd', 'HPX-7K3M-92QD'],
      ['hpx-7k3m', 'HPX-7K3M'],
    ])('%s → %s', (input, expected) => {
      expect(normaliseCaseNumber(input)).toBe(expected);
    });
  });

  describe('phoneLast4', () => {
    it.each([
      ['9876543210', '3210'],
      ['+91 98765-43210', '3210'],
      ['(555) 000-1234', '1234'],
    ])('%s → %s', (input, expected) => {
      expect(phoneLast4(input)).toBe(expected);
    });
  });
});

describe('portal session tokens', () => {
  it('generates a token with at least 32 bytes of entropy', () => {
    const token = generateSessionToken();
    expect(Buffer.from(token, 'base64url').length).toBe(PORTAL_AUTH.TOKEN_BYTES);
    expect(PORTAL_AUTH.TOKEN_BYTES).toBeGreaterThanOrEqual(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateSessionToken()));
    expect(tokens.size).toBe(1000);
  });

  it('hashes to a 64-char sha256 hex digest', () => {
    expect(hashSessionToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically', () => {
    const t = generateSessionToken();
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
  });

  // The raw token must not be derivable from what is stored.
  it('produces a hash that differs from the token', () => {
    const t = generateSessionToken();
    expect(hashSessionToken(t)).not.toBe(t);
  });

  it('expires 15 minutes out', () => {
    const from = new Date('2026-08-01T10:00:00.000Z');
    expect(sessionExpiry(from).toISOString()).toBe('2026-08-01T10:15:00.000Z');
    expect(PORTAL_AUTH.SESSION_MINUTES).toBe(15);
  });
});

describe('safeCompareDigits', () => {
  it('matches identical digits', () => {
    expect(safeCompareDigits('3210', '3210')).toBe(true);
  });

  it('rejects different digits', () => {
    expect(safeCompareDigits('3210', '3211')).toBe(false);
  });

  // timingSafeEqual throws on length mismatch; hashing first must prevent that.
  it('rejects a length mismatch without throwing', () => {
    expect(() => safeCompareDigits('3210', '321')).not.toThrow();
    expect(safeCompareDigits('3210', '321')).toBe(false);
    expect(safeCompareDigits('', '3210')).toBe(false);
  });
});

// Override 11.
describe('portal activation', () => {
  const active = {
    portalEnabledAt: new Date('2026-08-01T00:00:00.000Z'),
    portalPhoneLast4: '3210',
    status: DocCaseStatus.ACTIVE,
  };

  it('is accessible once enabled with a phone on an open case', () => {
    expect(isPortalAccessible(active)).toBe(true);
  });

  it('is NOT accessible before the first client-visible publish', () => {
    expect(isPortalAccessible({ ...active, portalEnabledAt: null })).toBe(false);
  });

  it('is NOT accessible without a portal phone', () => {
    expect(isPortalAccessible({ ...active, portalPhoneLast4: null })).toBe(false);
  });

  it.each([DocCaseStatus.CLOSED, DocCaseStatus.CANCELLED])('is NOT accessible when %s', (status) => {
    expect(isPortalAccessible({ ...active, status })).toBe(false);
  });

  it('stays accessible while transferred to Process', () => {
    expect(isPortalAccessible({ ...active, status: DocCaseStatus.TRANSFERRED_TO_PROCESS })).toBe(true);
  });
});

// Override 15 — the client must never see an internal verification judgement.
describe('client-facing document status', () => {
  it.each(['RECEIVED', 'UNDER_VERIFICATION', 'VERIFIED', 'APPROVED', 'MANAGER_APPROVED'])(
    '%s collapses to RECEIVED', (s) => {
      expect(toClientDocStatus(s)).toBe('RECEIVED');
    });

  it.each(['REQUESTED', 'PENDING_COLLECTION', 'RE_REQUESTED', 'EXPIRED', 'NOT_APPLICABLE', 'WAIVED'])(
    '%s collapses to PENDING', (s) => {
      expect(toClientDocStatus(s)).toBe('PENDING');
    });

  it('never surfaces REJECTED to the client', () => {
    expect(toClientDocStatus('REJECTED')).toBe('PENDING');
    expect(['RECEIVED', 'PENDING']).toContain(toClientDocStatus('REJECTED'));
  });
});

describe('progress stage mapping', () => {
  it.each([
    [DocCaseStatus.INCOMING, 'RECEIVED'],
    [DocCaseStatus.RETURNED, 'RECEIVED'],
    [DocCaseStatus.ACTIVE, 'IN_REVIEW'],
    [DocCaseStatus.DOCUMENTATION_READY, 'VERIFIED'],
    [DocCaseStatus.TRANSFERRED_TO_PROCESS, 'PROCESSING'],
    [DocCaseStatus.CLOSED, 'COMPLETED'],
  ])('%s → %s', (status, expected) => {
    expect(progressStageFor(status)).toBe(expected);
  });
});

// Override 3.
describe('generic failure contract', () => {
  it('is a single fixed shape', () => {
    expect(PORTAL_VERIFICATION_FAILED).toEqual({
      error: 'VERIFICATION_FAILED',
      message: "We couldn't verify those details.",
    });
  });

  it('uses one status code for every failure', () => {
    expect(PORTAL_HTTP_STATUS).toBe(401);
  });

  it('leaks nothing about which factor failed', () => {
    const body = JSON.stringify(PORTAL_VERIFICATION_FAILED).toLowerCase();
    for (const leak of ['phone', 'digit', 'case id', 'case number', 'locked', 'attempt', 'not found', 'expired']) {
      expect(body).not.toContain(leak);
    }
  });

  it('enforces a 5-attempt / 30-minute lockout policy', () => {
    expect(PORTAL_AUTH.MAX_ATTEMPTS).toBe(5);
    expect(PORTAL_AUTH.LOCKOUT_MINUTES).toBe(30);
  });
});

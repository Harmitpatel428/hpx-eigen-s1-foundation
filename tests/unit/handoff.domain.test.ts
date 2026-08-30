import { DocCaseStatus, HandoffState, HandoffReturnReason } from '@prisma/client';
import {
  canTransition,
  checkResendAllowed,
  computeAutoDropAt,
  getHandoffAge,
  requiresManagerReviewAfterReturn,
  shouldRequireManagerReview,
  MIN_RESOLUTION_NOTE_LENGTH,
  AUTO_DROP_DAYS,
} from '../../src/domain/handoff';

const NONE = HandoffState.NONE;
const ACCEPTED = HandoffState.ACCEPTED;
const RETURNED_STATE = HandoffState.RETURNED;

describe('handoff state machine', () => {
  describe('REJECT is valid only before acceptance', () => {
    it('allows reject while INCOMING', () => {
      expect(canTransition('REJECT', DocCaseStatus.INCOMING, HandoffState.HANDED_OFF, false).allowed).toBe(true);
    });

    it('blocks reject once ACTIVE — must use Return instead', () => {
      const r = canTransition('REJECT', DocCaseStatus.ACTIVE, ACCEPTED, false);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/already been accepted/i);
    });

    it('blocks reject once transferred to Process', () => {
      expect(canTransition('REJECT', DocCaseStatus.TRANSFERRED_TO_PROCESS, ACCEPTED, false).allowed).toBe(false);
    });
  });

  describe('RETURN is valid only after acceptance', () => {
    it('allows return while ACTIVE', () => {
      expect(canTransition('RETURN', DocCaseStatus.ACTIVE, ACCEPTED, false).allowed).toBe(true);
    });

    it('allows return while DOCUMENTATION_READY', () => {
      expect(canTransition('RETURN', DocCaseStatus.DOCUMENTATION_READY, ACCEPTED, false).allowed).toBe(true);
    });

    it('blocks return while still INCOMING — reject is the pre-acceptance path', () => {
      const r = canTransition('RETURN', DocCaseStatus.INCOMING, HandoffState.HANDED_OFF, false);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/only an accepted case/i);
    });

    // Override 5 — the hard security boundary.
    it('BLOCKS return once the case is TRANSFERRED_TO_PROCESS', () => {
      const r = canTransition('RETURN', DocCaseStatus.TRANSFERRED_TO_PROCESS, ACCEPTED, false);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Process owns this case/i);
    });

    it('blocks return on a CLOSED case', () => {
      expect(canTransition('RETURN', DocCaseStatus.CLOSED, ACCEPTED, false).allowed).toBe(false);
    });

    it('blocks return on a CANCELLED case', () => {
      expect(canTransition('RETURN', DocCaseStatus.CANCELLED, ACCEPTED, false).allowed).toBe(false);
    });
  });

  describe('ACCEPT', () => {
    it('allows accept from INCOMING', () => {
      expect(canTransition('ACCEPT', DocCaseStatus.INCOMING, HandoffState.HANDED_OFF, false).allowed).toBe(true);
    });

    it('blocks double-accept', () => {
      expect(canTransition('ACCEPT', DocCaseStatus.ACTIVE, ACCEPTED, false).allowed).toBe(false);
    });
  });

  describe('CONFIRM', () => {
    it('allows a first handoff', () => {
      expect(canTransition('CONFIRM', DocCaseStatus.INCOMING, NONE, false).allowed).toBe(true);
    });

    it('blocks re-confirming an already handed-off lead', () => {
      expect(canTransition('CONFIRM', DocCaseStatus.INCOMING, HandoffState.HANDED_OFF, false).allowed).toBe(false);
    });
  });

  // Override 9 — the manager review lock must actually block the transition.
  describe('RESEND and the manager review lock', () => {
    it('allows resend on a returned case with no lock', () => {
      expect(canTransition('RESEND', DocCaseStatus.RETURNED, RETURNED_STATE, false).allowed).toBe(true);
    });

    it('BLOCKS resend when managerReviewRequired is set', () => {
      const r = canTransition('RESEND', DocCaseStatus.RETURNED, RETURNED_STATE, true);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/manager review is required/i);
    });

    it('blocks resend on an active case', () => {
      expect(canTransition('RESEND', DocCaseStatus.ACTIVE, ACCEPTED, false).allowed).toBe(false);
    });
  });
});

describe('manager review threshold', () => {
  it('does not trigger on the first return', () => {
    expect(shouldRequireManagerReview(1)).toBe(false);
  });

  it('triggers at exactly 2 returns', () => {
    expect(shouldRequireManagerReview(2)).toBe(true);
  });

  it('stays on beyond 2', () => {
    expect(shouldRequireManagerReview(5)).toBe(true);
  });

  // Override 10 — duplicate-case rejection needs manager review immediately.
  it('forces review on a DUPLICATE_CASE reason even at count 1', () => {
    expect(requiresManagerReviewAfterReturn(1, HandoffReturnReason.DUPLICATE_CASE)).toBe(true);
  });

  it('forces review on a COMPLIANCE_ISSUE reason even at count 1', () => {
    expect(requiresManagerReviewAfterReturn(1, HandoffReturnReason.COMPLIANCE_ISSUE)).toBe(true);
  });

  it('does not force review on an ordinary reason at count 1', () => {
    expect(requiresManagerReviewAfterReturn(1, HandoffReturnReason.INCOMPLETE_INFORMATION)).toBe(false);
  });
});

// Overrides 6, 7, 8.
describe('Fix & Resend gating', () => {
  const base = {
    returnReasonCode: HandoffReturnReason.INCOMPLETE_INFORMATION,
    resolutionNote: 'Added the missing GST registration document.',
    phoneAtHandoff: '9876543210',
    currentPhone: '9876543210',
    hasApprovedContactOverride: false,
    presetAtHandoff: 'preset-a',
    currentPreset: 'preset-a',
  };

  it('requires a resolution note', () => {
    const r = checkResendAllowed({ ...base, resolutionNote: '' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/resolution note/i);
  });

  it('rejects a note shorter than the minimum', () => {
    expect(checkResendAllowed({ ...base, resolutionNote: 'ok' }).allowed).toBe(false);
    expect('x'.repeat(MIN_RESOLUTION_NOTE_LENGTH).length).toBe(MIN_RESOLUTION_NOTE_LENGTH);
  });

  it('allows an ordinary resend with a sufficient note', () => {
    expect(checkResendAllowed(base).allowed).toBe(true);
  });

  describe('WRONG_OR_MISSING_CONTACT', () => {
    const contact = { ...base, returnReasonCode: HandoffReturnReason.WRONG_OR_MISSING_CONTACT };

    it('blocks when the phone has not changed', () => {
      const r = checkResendAllowed(contact);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/has not changed/i);
    });

    it('allows when the phone actually changed', () => {
      expect(checkResendAllowed({ ...contact, currentPhone: '9000011111' }).allowed).toBe(true);
    });

    it('ignores pure formatting differences', () => {
      const r = checkResendAllowed({ ...contact, currentPhone: '987-654-3210' });
      expect(r.allowed).toBe(false);
    });

    it('allows when an approved portal contact override exists', () => {
      expect(checkResendAllowed({ ...contact, hasApprovedContactOverride: true }).allowed).toBe(true);
    });

    it('blocks when the phone was removed entirely', () => {
      expect(checkResendAllowed({ ...contact, currentPhone: null }).allowed).toBe(false);
    });
  });

  describe('WRONG_PRESET', () => {
    const preset = { ...base, returnReasonCode: HandoffReturnReason.WRONG_PRESET };

    it('blocks when the preset is unchanged', () => {
      const r = checkResendAllowed(preset);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/preset has not changed/i);
    });

    it('allows when the preset changed', () => {
      expect(checkResendAllowed({ ...preset, currentPreset: 'preset-b' }).allowed).toBe(true);
    });

    it('blocks when no preset is selected', () => {
      expect(checkResendAllowed({ ...preset, currentPreset: null }).allowed).toBe(false);
    });
  });

  it('blocks self-service resend for COMPLIANCE_ISSUE', () => {
    expect(checkResendAllowed({
      ...base, returnReasonCode: HandoffReturnReason.COMPLIANCE_ISSUE,
    }).allowed).toBe(false);
  });

  it('blocks self-service resend for DUPLICATE_CASE', () => {
    expect(checkResendAllowed({
      ...base, returnReasonCode: HandoffReturnReason.DUPLICATE_CASE,
    }).allowed).toBe(false);
  });
});

describe('ageing ladder', () => {
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);

  it.each([
    [1, 'FRESH'],
    [23, 'FRESH'],
    [25, 'STALE'],
    [47, 'STALE'],
    [50, 'WARNING'],
    [95, 'WARNING'],
    [100, 'CRITICAL'],
    [167, 'CRITICAL'],
    [169, 'OVERDUE'],
  ])('%i hours old → %s', (hours, expected) => {
    expect(getHandoffAge(at(hours as number))).toBe(expected);
  });
});

describe('auto-drop', () => {
  it('is exactly 7 days after the return', () => {
    const returnedAt = new Date('2026-08-01T10:00:00.000Z');
    expect(computeAutoDropAt(returnedAt).toISOString()).toBe('2026-08-08T10:00:00.000Z');
    expect(AUTO_DROP_DAYS).toBe(7);
  });
});

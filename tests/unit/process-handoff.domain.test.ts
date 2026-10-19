import { DocCaseStatus, ProcessHandoffState, ProcessReturnReason } from '@prisma/client';
import {
  canTransition,
  checkReturnReason,
  precondition,
  ProcessHandoffAction,
} from '../../src/domain/process-handoff';

const S = DocCaseStatus;
const P = ProcessHandoffState;
const R = ProcessReturnReason;

// Representative processHandoffState each status pairs with in practice.
const PH_FOR_STATUS: Record<DocCaseStatus, ProcessHandoffState> = {
  [S.INCOMING]: P.NONE,
  [S.ACTIVE]: P.NONE,
  [S.RETURNED]: P.NONE,
  [S.DOCUMENTATION_READY]: P.NONE,
  [S.PENDING_PROCESS_REVIEW]: P.PENDING_REVIEW,
  [S.RETURNED_TO_DOCUMENTATION]: P.RETURNED,
  [S.TRANSFERRED_TO_PROCESS]: P.ACCEPTED,
  [S.CLOSED]: P.NONE,
  [S.CANCELLED]: P.NONE,
  [S.CLOSED_NO_DOCS]: P.NONE,
};

const ALL_STATUS = Object.values(S);
const ALL_PH = Object.values(P);

// Expected legal (status) per action, using the natural paired processHandoffState.
const LEGAL: Record<ProcessHandoffAction, DocCaseStatus[]> = {
  TRANSFER: [S.ACTIVE, S.DOCUMENTATION_READY, S.RETURNED_TO_DOCUMENTATION],
  ACCEPT: [S.PENDING_PROCESS_REVIEW],
  RETURN: [S.PENDING_PROCESS_REVIEW],
};

describe('process-handoff state machine (Doc → Process, Option B)', () => {
  describe('exhaustive transition matrix (natural status/state pairing)', () => {
    (['TRANSFER', 'ACCEPT', 'RETURN'] as ProcessHandoffAction[]).forEach((action) => {
      ALL_STATUS.forEach((status) => {
        const expected = LEGAL[action].includes(status);
        it(`${action} from ${status} → ${expected ? 'allowed' : 'denied'}`, () => {
          const r = canTransition(action, status, PH_FOR_STATUS[status]);
          expect(r.allowed).toBe(expected);
          if (!expected) expect(r.reason).toBeTruthy();
        });
      });
    });
  });

  describe('guard ⇔ precondition coherence (the concurrency contract)', () => {
    // canTransition must be allowed IFF the current (status, processHandoffState)
    // satisfies the precondition descriptor Phase 3 feeds into updateMany.
    (['TRANSFER', 'ACCEPT', 'RETURN'] as ProcessHandoffAction[]).forEach((action) => {
      it(`${action}: allowed iff inside precondition sets, across the full grid`, () => {
        const pre = precondition(action);
        for (const status of ALL_STATUS) {
          for (const ph of ALL_PH) {
            const inPre = pre.status.includes(status) && pre.processHandoffState.includes(ph);
            expect(canTransition(action, status, ph).allowed).toBe(inPre);
          }
        }
      });
    });

    it('exposes the exact WHERE descriptors', () => {
      expect(precondition('TRANSFER')).toEqual({
        status: [S.ACTIVE, S.DOCUMENTATION_READY, S.RETURNED_TO_DOCUMENTATION],
        processHandoffState: [P.NONE, P.RETURNED],
      });
      expect(precondition('ACCEPT')).toEqual({
        status: [S.PENDING_PROCESS_REVIEW],
        processHandoffState: [P.PENDING_REVIEW],
      });
      expect(precondition('RETURN')).toEqual({
        status: [S.PENDING_PROCESS_REVIEW],
        processHandoffState: [P.PENDING_REVIEW],
      });
    });
  });

  describe('duplicate-transfer prevention', () => {
    it('rejects transfer when already pending Process review', () => {
      expect(canTransition('TRANSFER', S.PENDING_PROCESS_REVIEW, P.PENDING_REVIEW).allowed).toBe(false);
    });
    it('rejects transfer when Process already owns it', () => {
      expect(canTransition('TRANSFER', S.TRANSFERRED_TO_PROCESS, P.ACCEPTED).allowed).toBe(false);
    });
    it('allows re-transfer after a return', () => {
      expect(canTransition('TRANSFER', S.RETURNED_TO_DOCUMENTATION, P.RETURNED).allowed).toBe(true);
    });
  });

  describe('return reason / note rules (reason mandatory; note mandatory iff OTHER)', () => {
    it('rejects a return with no reason', () => {
      const r = checkReturnReason(null, 'some note');
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/reason is required/i);
    });
    it('accepts a non-OTHER reason with no note', () => {
      expect(checkReturnReason(R.MISSING_DOCUMENT, null).allowed).toBe(true);
      expect(checkReturnReason(R.DATA_MISMATCH, '').allowed).toBe(true);
    });
    it('rejects OTHER with an empty / whitespace note', () => {
      expect(checkReturnReason(R.OTHER, '').allowed).toBe(false);
      expect(checkReturnReason(R.OTHER, '   ').allowed).toBe(false);
    });
    it('accepts OTHER with a real note', () => {
      expect(checkReturnReason(R.OTHER, 'client sent the wrong entity name').allowed).toBe(true);
    });
  });

  it('unknown action is denied', () => {
    // @ts-expect-error — exercising the exhaustive default guard
    expect(canTransition('NOPE', S.PENDING_PROCESS_REVIEW, P.PENDING_REVIEW).allowed).toBe(false);
  });
});

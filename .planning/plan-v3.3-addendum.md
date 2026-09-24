# Plan v3.3 — Testing Addendum & Errata (Phase 1 Firm Direct Upload)

Authoritative closure reference. Records the certification testing IDs, their semantics, and three
errata discovered during implementation.

## 1. G1 — status PATCH/DELETE concurrency (tests T1–T3)
Semantics: PATCH and DELETE run inside an interactive transaction whose FIRST statement is the B1.3
case lock (`SELECT id FROM "DocCase" WHERE id=$1 AND "tenantId"=$2 AND "deletedAt" IS NULL FOR UPDATE`).
Inside the tx the Document is re-read `{id, tenantId, deletedAt:null}`. PATCH validates
DOCUMENT_STATUS_TRANSITIONS against the FRESH in-tx status (invalid → 422 listing the fresh state's
targets) and requires `isActive=true` else 409 ("document replaced; act on the current version").
DELETE is allowed on inactive (replaced) rows → soft-delete + audit DOCUMENT_REMOVED.
- T1: two concurrent conflicting PATCHes on one RECEIVED document → exactly one 200 and one 422;
  final status = winner; exactly one DOCUMENT_STATUS_CHANGED audit row.
- T2: PATCH on a row deactivated by replace → 409.
- T3: DELETE on inactive/replaced row → 204; deletedAt set; DOCUMENT_REMOVED audited.

**ERRATUM 1:** T1 uses the sink pair →VERIFIED vs →REJECTED (schedule-independent one-200/one-422:
each is terminal w.r.t. the other under the transition table). The earlier example pair →VERIFIED vs
→UNDER_REVIEW was order-dependent (if UNDER_REVIEW commits first, VERIFIED is still legal → two 200s)
and is VOID.

## 2. G2 — staging disposition (test T4)
Staging object is deleted on rejection codes 400 / 403 / 409 / 422, and RETAINED only on 503
(scanner unavailable → retry). Applies to BOTH the mandate and the document confirm endpoints.
- T4: document confirm — (a) verify:true without doc:verify → 403 AND staging deleted;
  (b) duplicate active requirement → 409 AND staging deleted. Mandate-side equivalents already
  asserted (magic-byte 400, infected 422, scanner 503-retain).

## 3. F6 — coexistence event (test T5)
New DocEventType `MANDATE_VERIFIED_RETAINED` added via an isolated additive migration (M6 pattern:
only `ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS`). Emitted inside the firm-confirm tx EXACTLY
when the supersede step finds ≥1 prior VERIFIED MandateRequest for the case; DocCaseEvent payload
`{caseId, newRequestId, retainedRequestIds}`; plus a matching `audit.appendInTx` entry
`MANDATE_VERIFIED_RETAINED` with the same metadata.
- T5: firm confirm over a prior VERIFIED → exactly one such event + matching audit row; firm confirm
  with no prior VERIFIED → none.

## 4. E3 — lifecycle timestamp symmetry (tests T6)
enter VERIFIED (confirm-verify, PATCH, or replace-verify) → verifiedAt=now, verifiedByUserId=actor.
VERIFIED → REJECTED | EXPIRED → verifiedAt=null, verifiedByUserId=null.
enter REJECTED → rejectedAt=now, rejectedByUserId=actor, rejectionReason (required, R7).
enter ARCHIVED → prior timestamp values preserved.

**ERRATUM 2:** VERIFIED → REJECTED is UNREACHABLE under the R4 transition table
(`VERIFIED → [EXPIRED, ARCHIVED]`; `REJECTED` is "no in-place change"). The verifiedAt-nulling branch
is therefore proven via VERIFIED → EXPIRED; rejection timestamps are proven via RECEIVED → REJECTED.
Do NOT "fix" the state machine to make VERIFIED → REJECTED reachable.

## 5. I2 — duplicate-checksum pre-flight (ruling)
Client-side only: compute SHA-256 via `crypto.subtle` on file selection; compare against the checksums
of ACTIVE documents in the getCaseById (R5) payload for the same case and same target bucket (same
requirementId, or the general bucket when the target is general). On match, show a NON-BLOCKING dialog
("An identical file is already attached. Continue as a new version?"). No server-side duplicate
detection is added. The server's `duplicate_active_requirement` 409 message is surfaced distinctly
(server text, not a generic failure). Pure helper `findDuplicateByChecksum(activeDocs, checksum, target)`
with a runnable self-check.

## 6. R2 — presign errata (ERRATUM 3)
aws-sdk v3 presigned PUT binds Content-Length (signed header) but NOT Content-Type. Content-Type is
declared at init and enforced server-side at confirm via the headObject contentType allowlist + magic
bytes on BOTH the mandate and document endpoints. The storage-presign unit test asserts this true
invariant (Content-Length signed). No security regression: size cryptographically bound, type
server-truth.

## 7. Note — staging sweep axes
The staging sweep RETENTION default is 24h; the 6h value is the sweep INTERVAL. These are distinct
axes and were mistaken for a deviation. Not a deviation; do not re-raise.

## 8. Operational Caveat (Virus Scanner)
The system's fail-closed guarantee in production is CONFIG-DEPENDENT. It requires
`VIRUS_SCAN_ENABLED='true'`. If this flag is set to false in any environment (including production),
the system deliberately fails OPEN (accepts unscanned uploads) and logs a policy bypass warning. This
is an intentional operational escape hatch for scanner outages, not a defect.

## 9. Test Gate Determinism
The backend gate command is `jest --runInBand`. Earlier intermittent exit-1s on an otherwise fully
green tree were root-caused to a same-millisecond timestamp race in `tests/lead-notes.test.ts` (a
`.not.toEqual`/`.not.toBe` assertion that required the clock to advance a full millisecond between
create and edit); this is fixed. It was NOT a worker-teardown handle leak, as first hypothesized.
`--runInBand` is retained because the suite is already serialized (`maxWorkers:1`): it is
semantics-neutral (identical test order and behavior), gives a truthful process exit code, and avoids
worker-spawn overhead. A residual, rare worker-mode teardown exit anomaly (observed once with zero test
failures, not reproduced across three clean in-band runs) is tracked at low priority in the closure
cleanup task. Forward path for parallelism: split unit vs DB-integration suites and parallelize only the
unit suites.

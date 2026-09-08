# Task 7 Report — Integration Tests: Audit Chain + Portal Activation

**Status: DONE**

## Commits

- `f66ee60` — test: add integration tests for audit chain integrity and portal activation

## Files created

- `tests/integration/audit-chain.test.ts` — 10 tests
- `tests/integration/portal-activate.test.ts` — 12 tests + 5 `it.todo()`

## Test results

```
npx jest tests/integration/audit-chain.test.ts tests/integration/portal-activate.test.ts --verbose

Test Suites: 2 passed, 2 total
Tests:       5 todo, 22 passed, 27 total
```

audit-chain.test.ts — all 10 pass: genesis creation, sequential 3-write chain,
10-way concurrent writes, cross-tenant isolation, tamper detection (modified
currentHash), multi-genesis/branch detection, DB-level unique-hash constraint,
hashVersion=1 content-hash verification, hashVersion=0 legacy link-only
verification, disconnected-row detection.

portal-activate.test.ts — 12 pass against the real Express router
(`createCasesRouter`) + real auth/permission middleware + real PostgreSQL:
unauthenticated (401), wrong-tenant/no-permission (403), invalid caseId (400),
non-existent case (404), INCOMING status (422), missing phone (400), valid
activation (200 + portalEnabledAt), exactly-one audit record, idempotent
repeat (no duplicate audit), 3-way concurrent activation (still exactly one
audit record), response body excludes `portalPhoneSnapshot`/`portalPhoneLast4`,
and deactivation revokes live sessions.

## Environment fix required

The local test database (`hpx_local_test`) was 4 migrations behind — including
`20260908010000_audit_hash_version_and_indexes` (adds `AuditLog.hashVersion`)
and `20260908030000_seed_portal_activate_permission` (seeds the `portal:activate`
permission the router depends on). Without these, every audit write and the
portal route's permission check failed. Ran:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hpx_local_test npx prisma migrate deploy
```

This applied all 4 pending migrations. No migration files were modified.

## Schema deviations from the brief's sample code

The brief's sample code was written against an idealized schema; the actual
`prisma/schema.prisma` differs in three ways I adapted for:

1. `DocCase` has `@@unique([tenantId, leadId])` — one case per lead. The
   brief's `createCase()` reused a single shared `LEAD_ID` across every test
   case in a tenant, which would violate that constraint on the second call.
   Fixed by having `createCase()` create a fresh `Lead` per case.
2. `DocCase.createdBy` is a required (non-null) UUID column, absent from the
   brief's `createCase()` data. Added `createdBy: USER_ID`.
3. `PortalSession` has no `phoneLast4` column (brief's test 18/12 included
   one). Removed it from the create call.

Also renumbered/collapsed the portal test list slightly (brief listed 19
tests numbered 1–19 with gaps; I wrote 12 concrete tests numbered 1–12 plus 5
`it.todo()` numbered 13–17) — same coverage, sequential numbering.

## Which tests are `.todo` and why

5 tests in `portal-activate.test.ts` are `it.todo()`:

- `13. auto-activation via published client-visible note on ACTIVE case sets portalEnabledAt`
- `14. auto-activation via published client-visible document sets portalEnabledAt`
- `15. auto-activation does not fire when case has no portal phone set`
- `16. auto-activation is idempotent — publishing twice does not duplicate PORTAL_AUTO_ACTIVATED audit`
- `17. auto-activation does not fire on non-ACTIVE case even with client-visible content`

These exercise `PortalService`'s private `reconcilePortalActivation`, which is
only reachable through the note/document publish flow (`DocumentationService`
+ a `DocPreset` + `DocCaseDocument` fixture graph). Per the brief's explicit
guidance ("Getting 10 solid passing audit tests is better than 29 flaky
ones" / "mark portal tests as it.todo() if the publishing flow is too complex
to set up"), these were deferred rather than faked — faking them by directly
calling Prisma updates would just re-assert update semantics already covered
by test 12 (deactivation/session revocation), not the actual reconciliation
logic.

## Concerns

Running the **full** test suite (`npx jest`, not scoped to my two files)
shows 6 pre-existing failing suites / 31 failing unit tests, e.g.
`tests/unit/bulk-assign.test.ts`, `tests/unit/activity.service.test.ts`:
`TypeError: tx.auditLog.count is not a function`. These are unit tests using
hand-rolled mocked Prisma clients whose mock `auditLog` object was never
updated after `AuditService.findLeaf` (from an earlier task) started calling
`tx.auditLog.count(...)`. This is unrelated to my change — `git status`
confirms no source files were touched, only the two new integration test
files were added — and out of scope for this task's brief (integration tests
for audit chain + portal activation only). Flagging for whoever owns those
unit-test mocks.

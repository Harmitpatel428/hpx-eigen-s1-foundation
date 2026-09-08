# Task 6 Report — Shared Enable/Disable Helpers + Align Auto-Activation

- Status: DONE

- Commits: 2db06d1 — refactor: shared portal enable/disable helpers with audit + ACTIVE enforcement (branch: main, hpx-eigen-s1-foundation)

- tsc result: `npx tsc --noEmit` passed clean (no output, exit 0).

## What changed (src/services/portal.service.ts)

1. Added private `enablePortalInTx` — race-safe conditional `updateMany` (not deleted, not already enabled, `status === ACTIVE`, phone set), audits `PORTAL_ACTIVATED`/`PORTAL_AUTO_ACTIVATED` only on the actual transition via `this.audit.appendInTx`, idempotent otherwise.
2. Added private `disablePortalInTx` — conditional clear of `portalEnabledAt`, revokes all live `PortalSession`s, audits `PORTAL_DEACTIVATED` via `appendInTx`, idempotent no-op if already disabled.
3. Refactored `activatePortal` to delegate the update+audit to `enablePortalInTx`, keeping the post-hoc diagnostic branch (already-enabled / wrong status / no phone / fallback) for the manual caller's error messages.
4. Replaced `reconcilePortalActivation` body per brief: `canActivate` now additionally requires `docCase.status === DocCaseStatus.ACTIVE`; activation/deactivation now route through the shared helpers (so both paths get AuditLog entries, not just DocCaseEvent); `lastClientVisiblePublishAt` update and `docCaseEvent` creation kept as a separate step gated on `published`; returns `tx.docCase.findFirstOrThrow(...)`.

Verified `DocEventType.CLIENT_VISIBLE_PUBLISHED` exists in `prisma/schema.prisma` (line 1047) before reusing it — brief's code was safe as written.

## Verification performed

- `npx tsc --noEmit` — clean.
- Confirmed only `src/services/portal.service.ts` changed (`git status`), on `main`, 7 commits ahead of origin (consistent with prior tasks in this chain — not pushed).

## Concerns

None. No TODOs/placeholders added. Every activation/deactivation path (manual `activatePortal` and auto `reconcilePortalActivation`) now writes an AuditLog entry, and `disablePortalInTx` always revokes sessions before returning — both global constraints from the brief are satisfied.

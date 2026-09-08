# Task 5 Report: Portal Activate Endpoint + Permission Migration

- Status: DONE
- Commits: 536f331 — "feat: add POST /cases/:caseId/portal/activate endpoint"
- tsc result: `npx tsc --noEmit` exits 0, no errors.

## What was done

1. **Migration:** `prisma/migrations/20260908030000_seed_portal_activate_permission/migration.sql` — seeds `portal:activate` permission (module `Client Portal`) and grants it to the `Organization Admin` role, following the exact pattern of the existing `20260830010000_seed_handoff_portal_permissions` migration (`ON CONFLICT` guards on both inserts).

2. **Route:** `src/routes/handoff.router.ts` — added `POST /:caseId/portal/activate` in `createCasesRouter`, placed after `portal-sessions/revoke` and before `return router`. Uses existing `authMiddleware`, `permissionMiddleware('portal:activate')`, and existing `ValidationError` import (no new imports needed — `permissionMiddleware` and `ValidationError` were already imported). UUID-format check on `caseId` before hitting the service.

3. **Service:** `src/services/portal.service.ts` — added `activatePortal(ctx, caseId)` after `revokeSessions` and before `activeSessionStats`. Implements the race-safe conditional-`updateMany` pattern: one atomic update where clause enforces tenant scope, not-deleted, not-already-enabled, `ACTIVE` status, and `portalPhoneLast4` present. On `count === 1`, appends a `PORTAL_ACTIVATED` audit event via `this.audit.appendInTx(tx, ...)` inside the same transaction. On `count === 0`, re-reads the case to produce a specific error (already enabled → idempotent success; wrong status → `BusinessRuleViolationError`; no phone → `ValidationError`; not found → `ResourceNotFoundError`).

## Constraints verified

- No portal activation path without audit logging — audit write happens inside the same `$transaction` as the state change, so activation cannot commit without the audit row.
- Response shape is `{ caseId, portalEnabledAt, alreadyEnabled }` only — no `portalPhoneSnapshot`, no `portalPhoneLast4`.
- Audit payload is `{ caseId, activationType: 'MANUAL' }` only — no phone digits, full or partial, in audit metadata.
- No TODOs/placeholders.

## Note on brief's stated method placement

The brief said to place `activatePortal` "after `revokeSessions` and before `reconcilePortalActivation`" — but in the actual file, `reconcilePortalActivation` (a private method) is defined earlier (around line 275), well before `revokeSessions` (line 435). That ordering as literally stated isn't achievable. Placed the new method directly after `revokeSessions` and before `activeSessionStats`, which matches the "Portal administration (staff side)" section grouping and mirrors the route's position in the router (right after `portal-sessions/revoke`).

## Concerns

None. `tsc --noEmit` is clean, migration SQL matches the schema/pattern of the prior permission-seed migration verbatim, and the route/service wiring reuses existing imports without modification.

# Deployment runbook — database migration + permission cache

> Base deploy: see [`docs/deploy.md`](deploy.md) (Docker/ClamAV path, currently
> the rollback path) and [`docs/deploy-native.md`](deploy-native.md) (the live
> native-Node posture, Stage 2). This document does not repeat that material —
> it covers one thing: the database half of a deploy, and why the permission
> seed step must run every time migrations run.

## (a) Canonical deploy sequence

1. Deploy application code (see `docs/deploy.md` / `docs/deploy-native.md` for
   the platform-specific build/start commands).
2. `npx prisma migrate deploy`
3. Seed permissions — run **`npm run deploy:db`**, which chains steps 2 and 3
   (this is also what all three production entry points run automatically —
   see RESOLVED below). The underlying seed command is `npm run
   prisma:seed-permissions`, i.e. `tsx prisma/seed-permissions.ts` (local
   binary; `tsx` is a declared devDependency).
4. Verify: see (d) below.

`deploy:db` script (`package.json`):
```
"deploy:db": "npx prisma migrate deploy && npm run prisma:seed-permissions"
```

## (b) Why step 3 is mandatory

Some migrations grant permissions via raw SQL (`INSERT INTO "Permission"` /
`"RolePermission"` rows) instead of going through the seed script. Raw-SQL
inserts do **not** bump the Redis `perm_version` key that the permission
cache is keyed on. `prisma/seed-permissions.ts` is what actually calls
`invalidatePermissionCache` per tenant (see the two call sites in that file,
once for the tenant loop and once per admin-email assignment). Skipping the
seed after such a migration means:

- Cached permission manifests (Redis TTL 3600s) keep serving the **old**
  permission set.
- Newly granted slugs are invisible to already-cached sessions.
- Organization Admins get **403** on newly gated routes for up to 3600s after
  the migration lands, even though the DB rows are correct.

## (c) Rule

Every future migration that inserts `Permission` / `RolePermission` rows via
raw SQL **must** be followed by the permission seed (`npm run
prisma:seed-permissions`, or `npm run deploy:db` if migrations haven't run
yet) in the same deploy. Do not rely on the Redis TTL to "catch up" — that's
a silent up-to-60-minute outage for admins on the new capability.

## (d) Verification

After running `npm run deploy:db` (or the equivalent manual sequence):

1. Log in as an Organization Admin.
2. Exercise a route gated by a recently added permission slug, e.g.:
   ```
   POST /api/v1/settings/crm/case-operations-engine
   { "enabled": true }
   ```
3. Confirm the response is **not** a 403, and that a `TENANT_ENGINE_FLAG_UPDATED`
   audit row was written for the tenant.

## (e) Environment rule

Use `prisma migrate deploy` in **all** environments (local, CI reconciliation,
staging, production). Do **not** use `prisma migrate dev` outside local schema
reconciliation work — it is currently broken by pre-existing schema drift
(DROP INDEX / ALTER COLUMN DROP DEFAULT differences between `schema.prisma`
and the migration history) and will prompt to generate a corrective migration
you don't want in a deploy context.

## (f) Rollback notes

- Phase 1 (Case Operations Engine governance) migrations are additive only.
  Rollback = redeploy the previous application code; do **not** revert
  applied migrations without an explicit reviewed plan.
- The engine feature flag `caseOperationsEngineEnabled` is a per-tenant kill
  switch, independent of any code rollback:
  ```
  POST /api/v1/settings/crm/case-operations-engine
  { "enabled": false }
  ```

## RESOLVED — production deploy path now runs the seed automatically

`render-deploy.sh`, `render.yaml` (`startCommand`), and `Dockerfile` (`CMD`)
all now run `npm run deploy:db` (`prisma migrate deploy && prisma:seed-permissions`)
instead of a bare `prisma migrate deploy`. Step 3 above is automated in every
deploy path — no manual post-deploy seed step is required.

Failure semantics are fail-loud by construction, not by extra scripting: each
entry point chains the seed with `&&` (`render.yaml`, `Dockerfile`) or relies
on `render-deploy.sh`'s existing `set -e`, so a non-zero exit from either half
of `deploy:db` aborts before the app starts (`exec npm run start` / `node
dist/src/server.js` never runs).

`tsx` (the seed's TS runner) is now a declared `devDependency` and
`prisma:seed-permissions` invokes the local `node_modules/.bin/tsx` binary
directly (no `npx` registry fetch at boot). The seed also now closes the
Redis client (`redisClose()`) in its `finally`, alongside `prisma.$disconnect()`
— without this the lazy-connect ioredis client (once touched by
`invalidatePermissionCache`) keeps the event loop alive and the process never
exits when `REDIS_URL` is set, which would hang the deploy.

The manual sequence in (a)–(c) above remains the documented fallback for any
environment outside Render's three entry points (e.g. a bare VM or a manual
hotfix run).

## CI

`.github/workflows/ci.yml` does not run `prisma migrate deploy` — it only
runs `npm ci` and `npm run build` (`prisma generate && tsc`) against no
database. No CI change was needed for this runbook.

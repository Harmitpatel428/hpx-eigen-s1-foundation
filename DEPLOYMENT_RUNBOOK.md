# DEPLOYMENT RUNBOOK — Security Audit Release (Phases 1–3)

Covers the backend (`hpx-eigen-s1-foundation`) + frontend (`hpx-eigen-frontend`) security-audit release:
capability-based Documentation pool, tenant/owner scope enforcement on lead reads + subresources,
atomic (TOCTOU-free) scope gates on mutations, auth/portal/invite/guard hardening, and dependency fixes.

Execute top-to-bottom. Do each step in staging first.

---

## 1. Environment Variables

| Var | Required | Value | Why |
|-----|----------|-------|-----|
| `TRUST_PROXY_HOPS` | **YES (prod)** | Integer = number of trusted proxy hops in front of the app (e.g. `1` behind a single Render/Vercel/ELB load balancer). | Express `app.set('trust proxy', N)`. Portal `/verify` lockout, invite/refresh IP limits, and audit IPs now key on `req.ip`. **If unset, it defaults to `false` and every client appears as the load-balancer IP → the portal brute-force lockout collapses to one shared bucket.** Set it to the REAL hop count; too high re-introduces `X-Forwarded-For` spoofing, too low collapses buckets. |
| `DATABASE_URL` | YES | Pooled host for the app (Neon pooled, `pgbouncer=true`); `migrate deploy` uses the DIRECT host. | Existing. |
| `JWT_SECRET`, `REDIS_URL`, `SENTRY_DSN` | YES/as-configured | — | Existing. |
| `VIRUS_SCAN_ENABLED` | prod: `true` | — | Existing; uploads fail-closed when the scanner is provisioned. |
| `FIRM_UPLOAD_URL_CAP_PER_HOUR` | optional | default 100 | Existing. |
| `SEED_ADMIN_EMAILS` | seed-time only | comma-list | Assigns Organization Admin during seed; omit to skip user-role assignment. |

No new env var other than **`TRUST_PROXY_HOPS`**.

---

## 2. Data Migrations / Seed (run AFTER `prisma migrate deploy`)

**No schema migration in this release** — the new permissions are seed-managed.

### 2a. Seed permissions (creates markers, grants, bumps perm_version)
```bash
# From the backend repo root, against prod DATABASE_URL:
npx tsx prisma/seed-permissions.ts
```
This is idempotent and:
- Upserts the new permission slugs `lead:receive:documentation` and `doc:case:view-all` into the catalog.
- Grants both to the `Documentation Manager` preset; grants `lead:receive:documentation` to an existing `Documentation Executive` role (never creates it).
- Re-grants Organization Admin ALL permissions (so admins hold both markers).
- Calls `invalidatePermissionCache(tenantId)` per tenant → `INCR tenant:{id}:perm_version` in Redis → every cached permission manifest rebuilds on next request. **This cache-bust is mandatory** or holders won't see the new markers until TTL.

### 2b. Marker grants for tenant-renamed roles
The grants in 2a key on the role NAMES `Documentation Manager` / `Documentation Executive`. A tenant whose equivalent roles are named differently will NOT receive the markers. For each such tenant, grant by hand (example):
```sql
-- Pool marker to the tenant's Documentation-assignee roles:
INSERT INTO "RolePermission" ("roleId","permissionId")
SELECT r.id, p.id FROM "Role" r, "Permission" p
WHERE r."tenantId" = '<TENANT_ID>' AND r.name IN ('<their doc mgr role>','<their doc exec role>')
  AND p.slug = 'lead:receive:documentation'
ON CONFLICT DO NOTHING;
-- Full-queue marker to the manager role only:
INSERT INTO "RolePermission" ("roleId","permissionId")
SELECT r.id, p.id FROM "Role" r, "Permission" p
WHERE r."tenantId" = '<TENANT_ID>' AND r.name = '<their doc mgr role>'
  AND p.slug = 'doc:case:view-all'
ON CONFLICT DO NOTHING;
```
Then bump the cache: re-run 2a, or `INCR tenant:<TENANT_ID>:perm_version` in Redis.

### 2c. `UserRole.scopeType` audit (least privilege) — REVIEW, then targeted fix
Lead/case visibility is driven by `UserRole.scopeType` (most-permissive across a user's roles). Only admin-equivalent assignments should be `ORGANIZATION`; everyone else `OWN`. **Review first:**
```sql
SELECT u.email, r.name AS role, ur."scopeType"
FROM "UserRole" ur
JOIN "User" u ON u.id = ur."userId"
JOIN "Role" r ON r.id = ur."roleId"
WHERE ur."scopeType" <> 'OWN' AND r.name <> 'Organization Admin'
ORDER BY u.email;
```
For each row that is NOT a deliberate superior, tighten it:
```sql
UPDATE "UserRole" ur SET "scopeType" = 'OWN'
FROM "Role" r
WHERE ur."roleId" = r.id AND ur."scopeType" <> 'OWN' AND r.name <> 'Organization Admin'
  AND ur."userId" = '<USER_ID>' AND ur."roleId" = '<ROLE_ID>';
```
(Dev already fixed `doc-demo` + `proc-demo` ORGANIZATION→OWN; prod needs its own review.) A `scopeType` change made directly in SQL does NOT bump `perm_version` — the role-assignment API does; after a manual SQL change, `INCR tenant:<id>:perm_version` so live sessions re-resolve scope.

---

## 3. Rollback Plan

The scope gates are now folded into the mutation WHERE (atomic). Symptom of a bad rollout: **legitimate users get 404 on leads/cases/opportunities they should see/edit.**
1. **First suspect DATA, not code:** a user wrongly at `OWN` who needs broader. Fix via 2c (grant the correct `scopeType`) + perm_version bump. This is reversible and targeted — prefer it over a code revert.
2. **Code revert (if the gates themselves misbehave):** revert the security commit(s) on `main`:
   ```bash
   git revert --no-edit <C3_HASH>   # IDOR/scope/TOCTOU + pool
   git revert --no-edit <C2_HASH>   # auth/portal/invite/guards
   ```
   Redeploy. Reverting restores the prior (less-strict) behavior. Do NOT revert `chore(deps)` unless a dependency regression is proven.
3. Portal lockout acting up after `TRUST_PROXY_HOPS` set wrong → correct the hop count (do not unset; unset = spoofable).

---

## 4. Infrastructure Checklist (prod-only — not verifiable from dev)

- [ ] `TRUST_PROXY_HOPS` set to the real proxy hop count.
- [ ] `VIRUS_SCAN_ENABLED=true` and a scanner provisioned.
- [ ] DB role is least-privilege (no DDL/superuser for the app role).
- [ ] Connection-pool caps set (pooled `DATABASE_URL` / pgbouncer) to survive the serial-load spikes.
- [ ] CI runs `npm audit` (both repos) as a gate.
- [ ] Seed re-run (step 2a) executed post-deploy and `perm_version` confirmed bumped.

---

## 5. Known Dependency Residuals (not blocking this release)

- **Frontend `npm audit` — BLOCKED by an npm tooling bug** (`Cannot read properties of null (reading 'edgesOut')`) caused by the wrapper-workspace lockfile. `--no-workspaces` and `--package-lock-only` do NOT avoid it. **Manual override (run on the FE repo OUTSIDE the `H:\HPX Eigen Reborn` wrapper, i.e. a standalone clone):**
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  npm audit fix        # fixes zod High + others without --force
  ```
  Re-run the FE build + vitest after. 12 vulns outstanding until done (incl. `zod` High, GHSA-mrhx-c7xc-m3w5).
- **Backend: 6 LOW dev-only vulns** in the `jest`/`jest-cli` chain need `npm audit fix --force` (a jest MAJOR bump) → likely test-harness breakage; deferred as a separate dev-tooling upgrade, not part of a security release. No runtime/prod impact.
- Backend prod Critical/High (`proxy-addr`, `qs`) are FIXED in this release (`chore(deps)` commit).

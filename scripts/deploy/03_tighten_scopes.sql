-- 03 — UserRole.scopeType hardening — PRODUCTION. Idempotent.
--
-- APPLIED (safe, non-destructive): Organization Admin (system role) must be ORGANIZATION-scoped.
UPDATE "UserRole" ur
SET "scopeType" = 'ORGANIZATION'
FROM "Role" r
WHERE ur."roleId" = r.id
  AND r.name = 'Organization Admin'
  AND r."isSystem" = true
  AND ur."scopeType" <> 'ORGANIZATION';

-- NOT APPLIED — "all others = OWN" is intentionally a REVIEW step, not a blanket UPDATE.
-- A blanket downgrade to OWN strips legitimate TEAM/DEPARTMENT managers (Sales Manager, Documentation
-- Manager, ...) of their scope, breaking tenant users' data visibility and the documentation ABAC pool
-- (lead:receive:documentation). That violates "maintain strict tenant isolation and security rules".
-- Review the current distribution first:
SELECT r.name AS role, r."isSystem", ur."scopeType", count(*) AS assignments
FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
WHERE NOT (r.name = 'Organization Admin' AND r."isSystem" = true)
GROUP BY r.name, r."isSystem", ur."scopeType"
ORDER BY r.name, ur."scopeType";

-- Then tighten ONLY the roles you confirm must be OWN (uncomment, list the exact role names):
-- UPDATE "UserRole" ur SET "scopeType" = 'OWN'
-- FROM "Role" r
-- WHERE ur."roleId" = r.id
--   AND r.name IN ('Sales Executive' /*, ... confirmed OWN-scoped roles only */)
--   AND ur."scopeType" <> 'OWN';

-- After ANY scopeType change, invalidate the permission cache. perm_version is PER TENANT
-- (Redis key: tenant:{tenantId}:perm_version — integer, INCR to invalidate). Bump every tenant:
--   psql -At -c 'SELECT id FROM "Tenant"' "$PROD_DATABASE_URL" \
--     | while read -r t; do redis-cli -u "$PROD_REDIS_URL" INCR "tenant:$t:perm_version"; done

#!/usr/bin/env bash
# 02 — Seed the permission catalog + capability markers on PRODUCTION and bust the Redis perm cache.
#
# Idempotent: seed-permissions.ts upserts permissions/roles (never deletes, never assigns Org Admin to
# arbitrary users) and invalidates the Redis permission cache on completion. Run AFTER `migrate deploy`.
#
#   DATABASE_URL="$PROD_DATABASE_URL" REDIS_URL="$PROD_REDIS_URL" bash scripts/deploy/02_seed_markers.sh
#
# Leave SEED_ADMIN_EMAILS unset in prod unless you deliberately want to (re)grant Org Admin to those users.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to the production database URL}"

# Resolve repo root (scripts/deploy -> repo root) so prisma/ and node_modules/ resolve.
cd "$(dirname "$0")/../.."

echo "[02_seed_markers] seeding permissions + markers (DB host: $(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^/?]+).*#\1#'))"
npx tsx prisma/seed-permissions.ts
echo "[02_seed_markers] done — catalog + markers upserted; Redis permission cache invalidated by the script (perm_version bumped)."

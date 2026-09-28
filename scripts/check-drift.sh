#!/bin/bash
# check-drift.sh — fails CI if schema.prisma and the migration history diverge
# beyond the one accepted, permanent exception (LeadPhone's partial index —
# see scripts/expected-drift.sql for why Prisma can't express it).
#
# Requires a scratch Postgres reachable at SHADOW_DATABASE_URL (CI: the
# postgres service in ci.yml). This is disposable scratch space for
# `prisma migrate diff` — never point it at a real dev/prod database.
set -e

if [ -z "$SHADOW_DATABASE_URL" ]; then
  echo "SHADOW_DATABASE_URL is not set. Cannot run drift check."
  exit 1
fi

ACTUAL=$(npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script)

# Normalize: strip comment lines and blank lines so the comparison survives
# incidental whitespace/comment changes on either side.
EXPECTED=$(grep -v '^--' scripts/expected-drift.sql | grep -v '^[[:space:]]*$')
ACTUAL_NORM=$(echo "$ACTUAL" | grep -v '^--' | grep -v '^[[:space:]]*$')

if [ "$ACTUAL_NORM" != "$EXPECTED" ]; then
  echo "Prisma schema/migration drift detected beyond the accepted baseline."
  echo "--- expected (scripts/expected-drift.sql, comments stripped) ---"
  echo "$EXPECTED"
  echo "--- actual (migrate diff --script, comments stripped) ---"
  echo "$ACTUAL_NORM"
  echo ""
  echo "If this drift is a deliberate, reviewed schema change, update"
  echo "scripts/expected-drift.sql to match. Otherwise fix schema.prisma or"
  echo "add a corrective migration."
  exit 1
fi

echo "No unexpected drift — only the accepted LeadPhone partial-index baseline."

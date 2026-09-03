#!/bin/bash
# backup-db.sh — take a restorable, compressed logical backup of a Postgres DB.
#
# Uses pg_dump custom format (-Fc): compressed, and restorable selectively
# (whole DB, a single table, or a single schema) with pg_restore.
#
# Usage:
#   ./scripts/backup-db.sh                 # backs up $DATABASE_URL
#   ./scripts/backup-db.sh "postgresql://user:pass@host:5432/db"
#
# NOTE: A logical dump is a point-in-time copy, NOT a substitute for the
# managed daily backups + PITR that must be enabled on the hosting provider
# (see docs/RESTORE_RUNBOOK.md). Use this for local snapshots and for pulling
# an off-box copy before risky operations.
set -euo pipefail

URL="${1:-${DATABASE_URL:-}}"
if [ -z "$URL" ]; then
  echo "❌ No DATABASE_URL given (arg or env)."; exit 1
fi

DB=$(echo "$URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
mkdir -p "$OUT_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/${DB}-${TS}.dump"

echo "→ Dumping '${DB}' to ${FILE}"
# NOTE: options MUST precede the connection URL — libpq's getopt stops parsing
# options at the first bare positional, so `pg_dump "$URL" -Fc` drops -Fc.
pg_dump -Fc -f "$FILE" "$URL"

# Verify the archive is well-formed and restorable by listing its contents.
if pg_restore -l "$FILE" >/dev/null 2>&1; then
  SIZE=$(du -h "$FILE" | cut -f1)
  echo "✅ Backup OK (${SIZE}). Archive verified readable by pg_restore."
  echo "   Restore whole DB : pg_restore -d <target_url> --clean --if-exists \"$FILE\""
  echo "   Restore one table: pg_restore -d <target_url> --data-only -t <Table> \"$FILE\""
  echo "⚠  Move a copy OFF this machine (encrypted, off-region). A backup that only"
  echo "   lives next to the DB is not a backup."
else
  echo "❌ Archive failed verification — DO NOT trust this backup."; exit 1
fi

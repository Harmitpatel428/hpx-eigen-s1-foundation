#!/usr/bin/env bash
# backup-offsite.sh — encrypted, off-box logical backup (WP-0 / reg #6).
# =============================================================================
# Complements the managed provider backups + PITR (see docs/RESTORE_RUNBOOK.md).
# This produces an ENCRYPTED custom-format dump for an off-region, restricted-delete
# store, so a single compromised host cannot read the backup.
#
# WINDOWS-SAFE BY DESIGN: two FILE-BASED steps, never a binary pipe. On Git-Bash /
# PowerShell, `pg_dump -Fc | gpg` corrupts the binary stream — so we write the dump
# to a file first, then encrypt the file.
#
# ENCRYPTION: asymmetric (gpg --recipient) so no shared passphrase is stored.
#   The private key MUST live SEPARATELY from the app/Render secrets (a compromised
#   app host must not be able to decrypt backups) AND be backed up in its own
#   location — a lost private key makes every backup an unrecoverable brick.
#
# USAGE:
#   BACKUP_RECIPIENT=<gpg-key-id-or-email> ./scripts/db/backup-offsite.sh "<db_url>"
#   # then upload $OUT_DIR/<db>-<ts>.dump.gpg to the off-region bucket (human step).
#
# RESTORE (mirror — also file-based; see RESTORE_RUNBOOK.md):
#   gpg --output dump.dump --decrypt dump.dump.gpg
#   pg_restore --no-owner --dbname="<target_url>" dump.dump
# =============================================================================
set -euo pipefail

URL="${1:-${DATABASE_URL:-}}"
RECIP="${BACKUP_RECIPIENT:-}"
[ -z "$URL" ]   && { echo "❌ No DB URL (arg or DATABASE_URL)."; exit 1; }
[ -z "$RECIP" ] && { echo "❌ No BACKUP_RECIPIENT (gpg key id/email)."; exit 1; }

DB=$(echo "$URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')
OUT_DIR="$(cd "$(dirname "$0")/../.." && pwd)/backups"
mkdir -p "$OUT_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="$OUT_DIR/${DB}-${TS}.dump"
ENC="$DUMP.gpg"

# Step 1 — dump to a FILE (options precede the URL: libpq getopt stops at the URL).
echo "→ pg_dump -Fc -f $DUMP"
pg_dump -Fc -f "$DUMP" "$URL"

# Step 2 — encrypt the FILE to the recipient (asymmetric; no passphrase at rest).
echo "→ gpg --encrypt --recipient $RECIP → $ENC"
gpg --yes --output "$ENC" --encrypt --recipient "$RECIP" "$DUMP"

# Verify the plaintext dump is a well-formed archive before we discard it.
if pg_restore -l "$DUMP" >/dev/null 2>&1; then
  rm -f "$DUMP"   # keep only the encrypted artifact
  echo "✅ Encrypted backup OK: $ENC ($(du -h "$ENC" | cut -f1))"
  echo "⚠  Upload OFF-REGION (restricted-delete). Store the gpg PRIVATE KEY separately"
  echo "   from app secrets and back it up — a lost key bricks every backup."
else
  echo "❌ Dump failed pg_restore -l verification — not encrypting a bad dump."; exit 1
fi

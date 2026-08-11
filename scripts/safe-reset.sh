#!/bin/bash
# safe-reset.sh — development-only database reset guard
# Refuses to run migrate reset if:
#   - NODE_ENV is production
#   - DATABASE_URL contains production host indicators
#   - DATABASE_URL is not set

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL is not set. Cannot determine target database."
  exit 1
fi

if [ "$NODE_ENV" = "production" ]; then
  echo "❌ Refusing migrate reset: NODE_ENV=production"
  exit 1
fi

# Block known production host patterns
PROD_PATTERNS=("render.com" "railway.app" "supabase.com" "neon.tech" "amazonaws.com" "azure" "heroku")
for pattern in "${PROD_PATTERNS[@]}"; do
  if echo "$DATABASE_URL" | grep -qi "$pattern"; then
    echo "❌ Refusing migrate reset: DATABASE_URL contains '$pattern' — looks like production."
    echo "   If this is intentional, run prisma migrate reset directly."
    exit 1
  fi
done

echo "⚠️  About to run prisma migrate reset against: $(echo "$DATABASE_URL" | sed 's|://[^@]*@|://[REDACTED]@|')"
echo "   This will DELETE ALL DATA in that database."
read -p "   Type 'yes' to confirm: " confirm

if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

npx prisma migrate reset

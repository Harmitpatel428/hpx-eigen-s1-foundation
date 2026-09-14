#!/bin/bash
# Render Deployment Script for HPX Eigen Backend
# This script runs migrations and starts the application on Render

set -e

echo "🚀 HPX Eigen Backend — Render Deployment"
echo "========================================="

# 0. Pre-flight: virus scanning must be configured in production
if [ "$VIRUS_SCAN_ENABLED" != "true" ]; then
  echo "⚠️  WARNING: VIRUS_SCAN_ENABLED is not 'true'. Mandate uploads will fail closed (503)."
fi
if [ -z "$CLAMD_HOST" ] || [ -z "$CLAMD_PORT" ]; then
  echo "⚠️  WARNING: CLAMD_HOST/CLAMD_PORT not set. Virus scanning will be unavailable."
fi

# 1. Generate Prisma Client
echo "📦 Generating Prisma Client..."
npx prisma generate

# 2. Run pending migrations
echo "🗄️  Running database migrations..."
npx prisma migrate deploy

# 3. Seed database (optional — only if database is empty)
if [ "$SEED_DATABASE" = "true" ]; then
  echo "🌱 Seeding database..."
  npm run prisma:seed
fi

# 4. Start the application
echo "✅ Migrations complete!"
echo "🚀 Starting application..."
exec npm run start

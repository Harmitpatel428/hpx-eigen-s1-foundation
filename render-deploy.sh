#!/bin/bash
# Render Deployment Script for HPX Eigen Backend
# This script runs migrations and starts the application on Render

set -e

echo "🚀 HPX Eigen Backend — Render Deployment"
echo "========================================="

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

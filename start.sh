#!/bin/sh
echo "Applying database migrations..."
npx prisma migrate deploy
echo "Starting server..."
npm run start

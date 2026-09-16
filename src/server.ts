import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { logger } from './utils/logger';
import { prisma } from './db';
import { redisClose } from './redis';
import { RecycleBinCleanupService } from './services/recycle-bin-cleanup.service';
import { expirePendingMandates } from './workers/mandate-expiry.worker';
import { isStorageConfigured } from './services/storage.service';
import { virusScanService } from './services/virus-scan.service';
import { assertClientUrlsNotLocalhost } from './config/production-url-guard';

const PORT = Number(process.env.PORT ?? 3000);

// Fail fast at boot if a client-facing base URL still points at localhost in prod.
assertClientUrlsNotLocalhost();

const server = app.listen(PORT, '0.0.0.0');

server.on('listening', () => {
  logger.info(
    {
      port: PORT,
      host: '0.0.0.0',
      env: process.env.NODE_ENV ?? 'development',
      pid: process.pid,
    },
    '[HPX Eigen S1] Server running'
  );
  const storageState = isStorageConfigured() ? 'configured' : 'NOT configured (uploads disabled)';
  logger.info({ storage: storageState }, `[HPX Eigen S1] storage provider: ${storageState}`);
  const scanState = virusScanService.isEnabled() ? 'enabled' : 'DISABLED';
  logger.info({ virusScan: scanState }, `[HPX Eigen S1] virus scanning: ${scanState}`);
  if (!virusScanService.isEnabled() && (process.env.NODE_ENV ?? 'development') === 'production') {
    logger.warn('[HPX Eigen S1] SECURITY: virus scanning is DISABLED in production — uploads are ACCEPTED UNSCANNED (policy bypass). Set VIRUS_SCAN_ENABLED=true to restore fail-closed scanning.');
  }
});

// ─── Recycle bin 14-day purge ────────────────────────────────────────────────
// Startup sweep + daily interval. purgeExpired is idempotent and catches
// per-model errors; the outer catch is belt-and-braces so a thrown cleanup
// can never take down the process on an unref'd timer.
const recycleBinCleanup = new RecycleBinCleanupService(prisma as unknown as Record<string, any>);
async function purgeRecycleBin(): Promise<void> {
  try {
    const purged = await recycleBinCleanup.purgeExpired();
    const total = Object.values(purged).reduce((sum, n) => sum + Math.max(n, 0), 0);
    if (total > 0) logger.info({ purged }, 'Recycle bin purge complete');
  } catch (err) {
    logger.error({ err }, 'Recycle bin purge failed');
  }
}
void purgeRecycleBin();
const purgeTimer = setInterval(() => void purgeRecycleBin(), 24 * 60 * 60 * 1000);
purgeTimer.unref();

// ─── Mandate expiry (hourly) ────────────────────────────────────────────────
const mandateExpiryTimer = setInterval(() => void expirePendingMandates(prisma), 60 * 60 * 1000);
mandateExpiryTimer.unref();

interface ServerError extends NodeJS.ErrnoException {
  address?: string;
  port?: number;
}

server.on('error', (err: ServerError) => {
  logger.fatal(
    {
      err,
      code: err.code,
      syscall: err.syscall,
      address: err.address,
      port: err.port,
    },
    'Failed to start HTTP server'
  );

  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught Exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled Promise Rejection');
  process.exit(1);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Graceful shutdown initiated');

  server.close(async () => {
    try {
      await prisma.$disconnect();
      await redisClose();
    } finally {
      process.exit(0);
    }
  });
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

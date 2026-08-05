import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { logger } from './utils/logger';
import { prisma } from './db';
import { redisClose } from './redis';

const PORT = Number(process.env.PORT ?? 3000);

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
});

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

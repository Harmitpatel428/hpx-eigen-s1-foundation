import { logger } from '../utils/logger';

export const RECYCLE_BIN_RETENTION_DAYS = 14;

/**
 * Entities that participate in a Recycle Bin flow (soft-delete → restore /
 * permanent-delete endpoints). Add an entry here when another entity type
 * gets its own recycle-bin routes — the purge picks it up automatically.
 */
const RECYCLE_BIN_MODELS = ['lead'] as const;

/**
 * Permanently deletes soft-deleted records older than the retention window
 * (`deletedAt <= now - 14 days`, server time). Runs outside any request
 * context, so the db.ts tenant/deletedAt extensions do not apply here.
 *
 * Idempotent by construction (deleteMany on the cutoff); safe to rerun and
 * safe under concurrent app instances — Postgres row locking makes duplicate
 * sweeps a no-op. One model failing does not block the others.
 */
export class RecycleBinCleanupService {
  // ponytail: prisma delegate lookup is dynamic by design — the model list is
  // config, not code. Type-safety loss is contained to this file.
  private readonly delegates: Array<{ name: string; deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> }>;

  constructor(prisma: Record<string, any>) {
    this.delegates = RECYCLE_BIN_MODELS.map(name => ({ name, deleteMany: prisma[name]?.deleteMany?.bind(prisma[name]) }));
  }

  async purgeExpired(): Promise<Record<string, number>> {
    const cutoff = new Date(Date.now() - RECYCLE_BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged: Record<string, number> = {};

    for (const { name, deleteMany } of this.delegates) {
      if (typeof deleteMany !== 'function') {
        logger.error({ model: name }, 'Recycle bin cleanup: model has no deleteMany delegate');
        purged[name] = -1;
        continue;
      }
      try {
        const result = await deleteMany({ where: { deletedAt: { lte: cutoff } } });
        purged[name] = result.count;
      } catch (err) {
        logger.error({ err, model: name }, 'Recycle bin cleanup failed for model');
        purged[name] = -1;
      }
    }

    return purged;
  }
}

import { PrismaClient, Prisma, CaseStageStatus, StagePerformanceSummary } from '@prisma/client';
import { activeTimeDays, summarize, StageEventLite } from './case-performance.stats';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Samples = one per COMPLETED stage (reopen→recomplete is the same CaseStage row, so still one sample).
 * caseTypeId null = tenant-wide (all case types). Manual tenant scoping.
 * ponytail: O(comparable completed stages x their events) per call, run inside the completion tx; accepted ceiling.
 */
async function computeSummary(client: Client, tenantId: string, caseTypeId: string | null, stageKey: string) {
  const stages = await client.caseStage.findMany({
    where: {
      tenantId, key: stageKey, status: CaseStageStatus.COMPLETED, completedAt: { not: null },
      ...(caseTypeId ? { timeline: { caseTypeId } } : {}),
    },
    select: { id: true, completedAt: true },
  });
  if (stages.length === 0) return summarize([]);
  const events = await client.caseStageEvent.findMany({
    where: { tenantId, stageId: { in: stages.map((s) => s.id) } },
    orderBy: { createdAt: 'asc' },
    select: { stageId: true, toStatus: true, createdAt: true },
  });
  const byStage = new Map<string, StageEventLite[]>();
  for (const e of events) {
    const list = byStage.get(e.stageId) ?? [];
    list.push({ toStatus: e.toStatus, createdAt: e.createdAt });
    byStage.set(e.stageId, list);
  }
  return summarize(stages.map((s) => ({ activeDays: activeTimeDays(byStage.get(s.id) ?? []), completedAt: s.completedAt! })));
}

async function refreshOne(client: Client, tenantId: string, caseTypeId: string | null, stageKey: string): Promise<void> {
  const s = await computeSummary(client, tenantId, caseTypeId, stageKey);
  const data = { sampleCount: s.sampleCount, medianDays: s.medianDays, recentMedianDays: s.recentMedianDays };
  if (caseTypeId) {
    await client.stagePerformanceSummary.upsert({
      where: { tenantId_caseTypeId_stageKey: { tenantId, caseTypeId, stageKey } },
      create: { tenantId, caseTypeId, stageKey, ...data },
      update: data,
    });
    return;
  }
  // NULL caseTypeId is distinct in the compound unique, so Prisma upsert cannot target it; hit the
  // partial unique index (column form) atomically so concurrent completions cannot duplicate the row.
  await client.$executeRaw`
    INSERT INTO "StagePerformanceSummary" ("id","tenantId","caseTypeId","stageKey","sampleCount","medianDays","recentMedianDays","updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, NULL, ${stageKey}, ${data.sampleCount}, ${data.medianDays}::double precision, ${data.recentMedianDays}::double precision, NOW())
    ON CONFLICT ("tenantId","stageKey") WHERE "caseTypeId" IS NULL
    DO UPDATE SET "sampleCount" = EXCLUDED."sampleCount", "medianDays" = EXCLUDED."medianDays",
                  "recentMedianDays" = EXCLUDED."recentMedianDays", "updatedAt" = NOW()`;
}

/** Recompute BOTH dimensions: (tenant, caseTypeId, stageKey) and tenant-wide (tenant, null, stageKey). Audit-silent. */
export async function refreshSummaryInTx(
  tx: Client, tenantId: string, caseTypeId: string | null, stageKey: string,
): Promise<void> {
  if (caseTypeId) await refreshOne(tx, tenantId, caseTypeId, stageKey);
  await refreshOne(tx, tenantId, null, stageKey);
}

/** Read the row; if missing, compute+persist it (lazy-create) and return it. */
export async function loadOrCreateSummary(
  client: Client, tenantId: string, caseTypeId: string | null, stageKey: string,
): Promise<StagePerformanceSummary> {
  const find = () => client.stagePerformanceSummary.findFirst({ where: { tenantId, caseTypeId, stageKey } });
  const existing = await find();
  if (existing) return existing;
  await refreshOne(client, tenantId, caseTypeId, stageKey);
  return (await find())!;
}

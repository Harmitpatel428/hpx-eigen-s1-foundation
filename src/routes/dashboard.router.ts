import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    tenantId: string;
    departmentId: string | null;
  };
}

/**
 * Maps department name to logical type for routing metrics.
 * Mirrors frontend logic exactly.
 */
function getDepartmentType(name: string): 'SALES' | 'PROCESS' | 'DOCUMENTATION' {
  const n = name.toLowerCase();
  if (n.includes('sales')) return 'SALES';
  if (n.includes('process')) return 'PROCESS';
  if (n.includes('documentation') || n.includes('doc')) return 'DOCUMENTATION';
  return 'SALES';
}

export function createDashboardRouter(prisma: PrismaClient): Router {
  const router = Router();

  /**
   * GET /api/v1/dashboard/metrics
   * Returns department-specific KPIs.
   * Requires: Authorization: Bearer <token>
   * Optional: X-Department-Id (falls back to user's primary department)
   */
  router.get('/metrics', async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { userId, tenantId, departmentId: legacyDeptId } = authReq.user;
      const requestedDeptId = req.headers['x-department-id'] as string || legacyDeptId;

      if (!requestedDeptId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_DEPARTMENT', message: 'No department context available.' }
        });
      }

      // ─── UUID validation — guard against Postgres ::uuid cast crash ────
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(requestedDeptId)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_DEPARTMENT', message: 'Invalid department identifier format.' }
        });
      }

      // ─── Verify user has access to the requested department ──────────────
      // Uses User.departmentId (the correct column in the current schema).
      // The legacy Assignment table query was referencing "userId" which does
      // not exist on that model — fixed here to prevent the 500 crash.
      const userRecord = await prisma.user.findFirst({
        where: {
          id: userId,
          tenantId,
          departmentId: requestedDeptId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!userRecord) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied to this department.' }
        });
      }

      // ─── Resolve department ────────────────────────────────────────
      const department = await prisma.department.findFirst({
        where: { id: requestedDeptId, tenantId },
        select: { id: true, name: true }
      });

      if (!department) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Department not found.' }
        });
      }

      const deptType = getDepartmentType(department.name);

      // ─── Route to metric generator ─────────────────────────────────
      let metrics: Record<string, unknown>;
      switch (deptType) {
        case 'SALES':
          metrics = await getSalesMetrics(prisma, tenantId);
          break;
        case 'PROCESS':
          metrics = await getProcessMetrics(prisma, tenantId);
          break;
        case 'DOCUMENTATION':
          metrics = await getDocumentationMetrics(prisma, tenantId);
          break;
        default:
          metrics = await getSalesMetrics(prisma, tenantId);
      }

      return res.json({
        success: true,
        data: metrics,
        meta: {
          departmentId: department.id,
          departmentName: department.name,
          departmentType: deptType,
          generatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('[DashboardRouter] GET /metrics failed:', error);
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to generate dashboard metrics.' }
      });
    }
  });

  return router;
}

// ─── SALES METRICS (Real data from existing schema) ─────────────────

async function getSalesMetrics(prisma: PrismaClient, tenantId: string) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [
    pipelineAgg,
    activeDeals,
    winRateResult,
    velocityResult
  ] = await Promise.all([
    // Pipeline value: sum of open opportunities
    prisma.opportunity.aggregate({
      where: {
        tenantId,
        stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST'] }
      },
      _sum: { value: true }
    }),

    // Active deals count
    prisma.opportunity.count({
      where: {
        tenantId,
        stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST'] }
      }
    }),

    // Win rate (last 90 days)
    prisma.$queryRaw<{ win_rate: number }[]>`
      SELECT 
        CASE 
          WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(
            COUNT(*) FILTER (WHERE stage = 'CLOSED_WON') * 100.0 / COUNT(*), 
            2
          )
        END as win_rate
      FROM "Opportunity"
      WHERE "tenantId" = ${tenantId}::uuid
      AND "createdAt" >= ${ninetyDaysAgo}
    `,

    // Average velocity: days from created → closed (WON only, last 90 days)
    prisma.$queryRaw<{ avg_velocity: number }[]>`
      SELECT 
        COALESCE(
          AVG(
            EXTRACT(EPOCH FROM ("actualClose" - "createdAt")) / 86400
          ), 
          0
        ) as avg_velocity
      FROM "Opportunity"
      WHERE "tenantId" = ${tenantId}::uuid
      AND stage = 'CLOSED_WON'
      AND "closedAt" IS NOT NULL
      AND "createdAt" >= ${ninetyDaysAgo}
    `
  ]);

  return {
    pipelineValue: pipelineAgg?._sum?.value?.toNumber() ?? 0,
    activeDeals,
    winRate: Number(winRateResult[0]?.win_rate ?? 0),
    avgVelocity: Math.round(Number(velocityResult[0]?.avg_velocity ?? 0)),
    currency: 'INR'
  };
}

// ─── PROCESS METRICS (Scaffolded — requires ProcessTask table) ──────

async function getProcessMetrics(prisma: PrismaClient, tenantId: string) {
  // NOTE: When ProcessTask table is added to schema, replace with real queries.
  // For now, return zero-state with correct shape so UI renders.

  return {
    activeTasks: 0,
    completionRate: 0,
    avgProcessingTime: 0,
    pendingVerifications: 0,
    unit: 'days',
    _note: 'ProcessTask table required for real metrics'
  };
}

// ─── DOCUMENTATION METRICS (Scaffolded — requires Document table) ────

async function getDocumentationMetrics(prisma: PrismaClient, tenantId: string) {
  // NOTE: When Document table is added to schema, replace with real queries.
  // For now, return zero-state with correct shape so UI renders.

  return {
    activeDrafts: 0,
    reviewTurnaround: 0,
    complianceRate: 0,
    pendingSignatures: 0,
    unit: 'hours',
    _note: 'Document table required for real metrics'
  };
}

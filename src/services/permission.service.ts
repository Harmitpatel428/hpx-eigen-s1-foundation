/**
 * PermissionService — RBAC+ABAC permission resolution with Redis caching.
 *
 * Cache strategy (per-user direct key, synchronous invalidation):
 *
 *   Key:  perm:manifest:{userId}
 *   TTL:  PERM_CACHE_TTL (3600s) — safety net only; NOT the primary invalidation mechanism.
 *
 * Invalidation:
 *   On any UserRole, RolePermission, or Role mutation, call invalidatePermissionCache(userId).
 *   This issues a synchronous DEL on perm:manifest:{userId}, guaranteeing the stale entry
 *   is removed *immediately* — not after TTL expiry. The next request for that user triggers
 *   a single cache-miss DB query and re-populates the key.
 *
 * Zero-DB-Query Cache Hit:
 *   authMiddleware calls getPermissionManifest(userId, tenantId).
 *   If the Redis key exists and deserializes cleanly → return without any Prisma call.
 *   The ONLY DB I/O on the hot path is the first request after a cold start or invalidation.
 *
 * Fail-Secure Policy:
 *   - Redis unavailable → fall through to DB (degraded, not broken).
 *   - Corrupt JSON in Redis → log warning, DEL the corrupt key, fall through to DB.
 *   - DB returns zero roles for a user → cache the empty manifest and return deny-all.
 *     (An empty manifest is a valid state — the user has no permissions assigned.)
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { redisGet, redisSet, redisDel, redisKeys } from '../redis';
import { AuthorizationError } from '../types/exceptions';
import { PolicyEngineService } from './policy-engine.service';
import { AuthorizationDecision } from '../types/authorization';
import { OutboxService } from './outbox.service';
import { logger } from '../utils/logger';

/** Compiled permission manifest: { [slug]: ScopeType | AuthorizationDecision } */
export type PermissionManifest = Record<string, string | AuthorizationDecision>;

const PERM_CACHE_TTL = 3600; // seconds — safety-net TTL only

const SCOPE_ORDER: Record<string, number> = {
  OWN: 1,
  TEAM: 2,
  DEPARTMENT: 3,
  ORGANIZATION: 4,
};

export class PermissionService {
  private readonly policyEngine: PolicyEngineService;

  constructor(private readonly prisma: PrismaClient) {
    this.policyEngine = new PolicyEngineService(prisma);
  }

  /**
   * Fetch or build the permission manifest for a user.
   *
   * Hot path (cache hit):
   *   1. GET perm:manifest:{userId} from Redis
   *   2. JSON.parse and return → ZERO DB queries
   *
   * Cold path (cache miss):
   *   1. Run single optimized Prisma query: UserRole → Role → RolePermission → Permission
   *   2. Compile most-permissive scope per slug
   *   3. SET perm:manifest:{userId} with TTL
   *   4. Return manifest
   */
  async getPermissionManifest(
    tx: PrismaClient, userId: string,
    tenantId: string
  ): Promise<PermissionManifest> {
    const useV2 = process.env.USE_POLICY_ENGINE === 'true';

    if (useV2) {
      return this._getManifestV2(tx, userId);
    }

    return this._getManifestV1(tx, userId, tenantId);
  }

  // ─── V1: RBAC path ──────────────────────────────────────────────────────────

  private async _getManifestV1(tx: PrismaClient, userId: string, tenantId: string): Promise<PermissionManifest> {
    const cacheKey = redisKeys.userManifest(userId);

    // 1. Attempt O(1) Redis hit
    const cached = await redisGet(cacheKey);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as PermissionManifest;
      } catch {
        // Corrupt payload — log, evict immediately, and fall through to DB
        logger.warn({ userId, cacheKey }, '[PermissionService] Corrupt manifest in Redis. Evicting and rebuilding.');
        await redisDel(cacheKey);
      }
    }

    // 2. Cache miss — single optimized query
    const manifest = await this._buildV1ManifestFromDB(tx, userId, tenantId);

    // 3. Cache result (even empty manifests are cached — empty = deny-all, which is valid)
    await redisSet(cacheKey, JSON.stringify(manifest), PERM_CACHE_TTL);

    return manifest;
  }

  /**
   * Single Prisma query joining all 4 tables in one traversal.
   * UserRole → Role → RolePermission → Permission
   * No N+1. No separate permission.findMany().
   */
  private async _buildV1ManifestFromDB(tx: PrismaClient, userId: string, tenantId: string): Promise<PermissionManifest> {
    const userRoles = await tx.userRole.findMany({
      where: {
        userId,
        role: { tenantId, deletedAt: null },
      },
      select: {
        scopeType: true,
        role: {
          select: {
            permissions: {
              select: {
                permission: { select: { slug: true } },
              },
            },
          },
        },
      },
    });

    const manifest: PermissionManifest = {};

    for (const userRole of userRoles) {
      for (const rp of userRole.role.permissions) {
        const slug = rp.permission.slug;
        const scope = userRole.scopeType;

        const existing = manifest[slug];
        if (!existing || (SCOPE_ORDER[scope] ?? 0) > (SCOPE_ORDER[existing as string] ?? 0)) {
          manifest[slug] = scope;
        }
      }
    }

    return manifest;
  }

  // ─── V2: Policy Engine path ──────────────────────────────────────────────────

  private async _getManifestV2(tx: PrismaClient, userId: string): Promise<PermissionManifest> {
    const cacheKey = redisKeys.userManifest(userId);

    // 1. Attempt O(1) Redis hit — no DB call for "" lookup
    const cached = await redisGet(cacheKey);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as PermissionManifest;
      } catch {
        logger.warn({ userId, cacheKey }, '[PermissionService] Corrupt V2 manifest in Redis. Evicting and rebuilding.');
        await redisDel(cacheKey);
      }
    }

    // 2. Cache miss — must fetch membership ID from DB (single lookup, unavoidable)
    const user = await tx.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      // No membership → empty deny-all manifest, cached to prevent thundering herd
      await redisSet(cacheKey, JSON.stringify({}), PERM_CACHE_TTL);
      return {};
    }

    const allPerms = await tx.permission.findMany({ select: { slug: true } });
    const slugs = allPerms.map(p => p.slug);
    const manifest = await this.policyEngine.authorizeMany(tx, userId, slugs);

    await redisSet(cacheKey, JSON.stringify(manifest), PERM_CACHE_TTL);
    return manifest;
  }

  // ─── Invalidation ─────────────────────────────────────────────────────────

  /**
   * Synchronously invalidate a single user's permission manifest.
   *
   * Uses DEL — NOT INCR — guaranteeing the stale key is removed immediately.
   * The next request for this user will trigger a fresh DB build.
   *
   * Call this whenever a UserRole, RolePermission, or Role is mutated for this user.
   */
  async invalidatePermissionCache(tx: PrismaClient, userId: string): Promise<void> {
    const cacheKey = redisKeys.userManifest(userId);
    const result = await redisDel(cacheKey);

    if (result === null) {
      // Redis unavailable — log as a security warning; next request will hit DB
      logger.warn(
        { userId, cacheKey },
        '[PermissionService] SECURITY WARNING: Cache invalidation could not be confirmed — Redis unavailable. User will receive fresh permissions on next DB-fallback request.'
      );
    }
  }

  /**
   * Bulk invalidation — evict manifests for all members of a tenant.
   * Required when a Tenant-scoped Role or RolePermission is mutated.
   * Fetches all affected userIds and issues individual DEL operations.
   */
  async invalidateTenantPermissionCache(tx: PrismaClient, tenantId: string): Promise<void> {
    const users = await tx.userRole.findMany({
      where: { role: { tenantId, deletedAt: null } },
      select: { userId: true },
      distinct: ['userId'],
    });

    await Promise.all(
      users.map(u => this.invalidatePermissionCache(tx, u.userId))
    );

    const outboxService = new OutboxService(tx as any);
    await outboxService.publish(tx as any, 'PermissionCacheInvalidated', { tenantId }, tenantId);
  }
}

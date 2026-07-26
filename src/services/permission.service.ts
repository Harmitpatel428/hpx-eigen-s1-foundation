/**
 * PermissionService — RBAC+ABAC permission resolution with Redis version caching.
 *
 * Cache strategy (thundering-herd safe):
 *   Redis key: tenant:{tenantId}:perm_version  (integer, no TTL)
 *   Redis key: tenant:{tenantId}:user:{userId}:perms:v{version}  (JSON, TTL = 3600s)
 *
 * On any role/assignment change: INCR perm_version.
 * Stale vN keys are orphaned and expire via TTL.
 * Next request misses vN+1, rebuilds from DB, caches vN+1.
 */
import { PrismaClient } from '@prisma/client';
import { redisGet, redisSet, redisIncr, redisKeys } from '../redis';
import { AppException, RetryTag } from '../types/exceptions';
import { PolicyEngineService } from './policy-engine.service';
import { AuthorizationDecision } from '../types/authorization';
import { OutboxService } from './outbox.service';

/** Compiled permission manifest: { [slug]: ScopeType } */
export type PermissionManifest = Record<string, string | AuthorizationDecision>;

const PERM_CACHE_TTL = 3600; // seconds

export class PermissionService {
  private readonly policyEngine: PolicyEngineService;

  constructor(private readonly prisma: PrismaClient) {
    this.policyEngine = new PolicyEngineService(prisma);
  }

  /**
   * Fetch or build the permission manifest for a user.
   * Returns a flat object: { "lead:create": "TEAM", "contact:view": "OWN" }
   *
   * Cache miss path:
   *   1. Read perm_version from Redis (default 1 if missing)
   *   2. Check user perms key for that version
   *   3. On miss, build from DB and cache
   */
  async getPermissionManifest(
    userId: string,
    tenantId: string
  ): Promise<PermissionManifest> {
    const useV2 = process.env.USE_POLICY_ENGINE === 'true';

    if (useV2) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user?.v2MembershipId) return {};

      const versionStr = await redisGet(`membership:${user.v2MembershipId}:perm_version`);
      const version = versionStr ? parseInt(versionStr, 10) : 1;

      const cacheKey = `membership:${user.v2MembershipId}:perms:v${version}`;
      const cached = await redisGet(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as PermissionManifest;
        } catch {
          // Corrupt cache — fall through to DB
        }
      }

      const allPerms = await this.prisma.permission.findMany({ select: { slug: true } });
      const slugs = allPerms.map(p => p.slug);
      
      const manifest = await this.policyEngine.authorizeMany(user.v2MembershipId, slugs);
      
      if (Object.keys(manifest).length > 0) {
        await redisSet(cacheKey, JSON.stringify(manifest), PERM_CACHE_TTL);
        if (!versionStr) {
          await redisSet(`membership:${user.v2MembershipId}:perm_version`, String(version));
        }
      }
      return manifest;
    }

    // Fetch current version (fallback to 1 if Redis unavailable or key missing)
    const versionStr = await redisGet(redisKeys.permVersion(tenantId));
    const version = versionStr ? parseInt(versionStr, 10) : 1;

    // Attempt cache hit
    const cacheKey = redisKeys.userPerms(tenantId, userId, version);
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PermissionManifest;
      } catch {
        // Corrupt cache — fall through to DB
      }
    }

    // Cache miss — build from DB
    const manifest = await this.buildManifestFromDB(userId, tenantId);

    if (Object.keys(manifest).length === 0) {
      return manifest;
    }

    // Write to Redis (non-blocking — failure is non-fatal)
    await redisSet(cacheKey, JSON.stringify(manifest), PERM_CACHE_TTL);

    // Ensure perm_version key exists in Redis for future invalidations
    if (!versionStr) {
      await redisSet(redisKeys.permVersion(tenantId), String(version));
    }

    return manifest;
  }

  /**
   * Invalidate all cached permissions for a tenant by incrementing perm_version.
   * All existing vN user-permission keys will be orphaned and expire via TTL.
   * Call this whenever a Role, RolePermission, or UserRole is mutated.
   */
  async invalidatePermissionCache(id: string): Promise<void> {
    const useV2 = process.env.USE_POLICY_ENGINE === 'true';
    const key = useV2 ? `membership:${id}:perm_version` : redisKeys.permVersion(id);
    const result = await redisIncr(key);
    if (result === null) {
      process.stderr.write(`[PermissionService] Cache invalidation skipped for key ${key} — Redis unavailable.\n`);
    }

    const outboxService = new OutboxService(this.prisma as any);
    const eventPayload = useV2 ? { membershipId: id } : { tenantId: id };
    await outboxService.publish('PermissionCacheInvalidated', eventPayload, useV2 ? undefined : id);
  }

  /**
   * Build permission manifest directly from DB.
   * Joins: UserRole → Role → RolePermission → Permission
   *
   * The effective scope for a permission slug is the MOST PERMISSIVE scope
   * across all roles assigned to the user (ORGANIZATION > DEPARTMENT > TEAM > OWN).
   */
  async buildManifestFromDB(
    userId: string,
    tenantId: string
  ): Promise<PermissionManifest> {
    const scopeOrder: Record<string, number> = {
      OWN: 1,
      TEAM: 2,
      DEPARTMENT: 3,
      ORGANIZATION: 4,
    };

    // Fetch user's active role assignments for this tenant
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        role: { tenantId, deletedAt: null },
      },
      select: {
        scopeType: true,
        role: {
          select: {
            permissions: {
              select: { permission: { select: { slug: true } } },
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

        // Keep the most permissive scope if this slug appears in multiple roles
        const existing = manifest[slug];
        if (
          !existing ||
          (scopeOrder[scope] ?? 0) > (scopeOrder[existing as string] ?? 0)
        ) {
          manifest[slug] = scope;
        }
      }
    }

    return manifest;
  }
}

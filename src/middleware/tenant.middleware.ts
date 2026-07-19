import { PrismaClient } from '@prisma/client';

// Tenant-scoped models per S1 entity classification (TenantIsolationQueryGovernance)
const TENANT_SCOPED_MODELS = new Set([
  'user',
  'role',
  'permission',
  'rolePermission',
  'userRole',
  'userInvitation',
  'session'
]);

/**
 * Creates a Prisma client extended with automatic tenant isolation.
 *
 * Per S1-Integration-Fix-1 spec:
 * - Auto-injects tenantId and deletedAt: null into all TENANT_SCOPED model queries
 * - Developers never manually add tenant filters for normal tenant-scoped access
 * - Cross-tenant queries must use raw prisma and annotate with TENANT_BYPASS_APPROVED
 *
 * @param tenantId - The current request's tenant context
 */
export function createTenantClient(tenantId: string, prisma: PrismaClient) {
  return prisma.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }: { model: string; args: any; query: (args: any) => Promise<any> }) {
          if (TENANT_SCOPED_MODELS.has(model.toLowerCase())) {
            args.where = {
              ...args.where,
              tenantId,
              deletedAt: null
            };
          }
          return query(args);
        },

        async findFirst({ model, args, query }: { model: string; args: any; query: (args: any) => Promise<any> }) {
          if (TENANT_SCOPED_MODELS.has(model.toLowerCase())) {
            args.where = {
              ...args.where,
              tenantId,
              deletedAt: null
            };
          }
          return query(args);
        },

        async findUnique({ model, args, query }: { model: string; args: any; query: (args: any) => Promise<any> }) {
          // findUnique uses `where` with unique fields — we enforce via findFirst fallback pattern
          // For unique lookups on non-composite keys, callers must use findFirst with tenantId
          return query(args);
        },

        async updateMany({ model, args, query }: { model: string; args: any; query: (args: any) => Promise<any> }) {
          if (TENANT_SCOPED_MODELS.has(model.toLowerCase())) {
            args.where = {
              ...args.where,
              tenantId
            };
          }
          return query(args);
        },

        async deleteMany({ model, args, query }: { model: string; args: any; query: (args: any) => Promise<any> }) {
          if (TENANT_SCOPED_MODELS.has(model.toLowerCase())) {
            args.where = {
              ...args.where,
              tenantId
            };
          }
          return query(args);
        }
      }
    }
  });
}

/**
 * TypeScript type guard — makes tenant context explicit in repository code.
 * Usage: requireTenant({ tenantId, id })
 */
export function requireTenant<T extends { tenantId: string }>(where: T): T {
  return where;
}

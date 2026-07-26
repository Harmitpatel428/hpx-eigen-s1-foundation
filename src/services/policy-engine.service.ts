import { PrismaClient } from '@prisma/client';
import { AuthorizationDecision, ScopeType } from '../types/authorization';

const SCOPE_ORDER: Record<ScopeType, number> = {
  OWN: 1,
  TEAM: 2,
  DEPARTMENT: 3,
  ORGANIZATION: 4
};

export class PolicyEngineService {
  constructor(private readonly prisma: PrismaClient) {}

  async authorize(membershipId: string, permissionSlug: string): Promise<AuthorizationDecision> {
    const now = new Date();
    
    // a. Check PermissionOverride
    const override = await this.prisma.permissionOverride.findUnique({
      where: {
        membershipId_permissionSlug: {
          membershipId,
          permissionSlug
        }
      }
    });

    let rolesEvaluated: string[] = [];

    if (override && (!override.expiresAt || override.expiresAt > now)) {
      if (override.overrideType === 'DENY') {
        return {
          allowed: false,
          reason: 'EXPLICIT_DENY',
          evaluationSource: 'OVERRIDE',
          rolesEvaluated,
          sourceRoles: [],
          policyVersion: 2,
          evaluatedAt: now,
          expiresAt: override.expiresAt ?? undefined
        };
      }
      
      if (override.overrideType === 'ALLOW') {
        return {
          allowed: true,
          reason: 'EXPLICIT_ALLOW',
          effectiveScope: 'ORGANIZATION',
          evaluationSource: 'OVERRIDE',
          rolesEvaluated,
          sourceRoles: [],
          policyVersion: 2,
          evaluatedAt: now,
          expiresAt: override.expiresAt ?? undefined
        };
      }
    }

    // b. Fetch all MembershipRole records (active)
    const membershipRoles = await this.prisma.membershipRole.findMany({
      where: {
        membershipId,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      include: {
        role: {
          include: {
            permissions: {
              where: {
                permission: { slug: permissionSlug }
              }
            }
          }
        }
      }
    });

    rolesEvaluated = membershipRoles.map(mr => mr.role.name);
    const sourceRoles: string[] = [];
    let effectiveScope: ScopeType | undefined = undefined;

    // c. For each role, check if it grants permission
    for (const mr of membershipRoles) {
      if (mr.role.permissions.length > 0) {
        sourceRoles.push(mr.role.name);
        const scope = mr.scopeType as ScopeType;
        if (!effectiveScope || SCOPE_ORDER[scope] > SCOPE_ORDER[effectiveScope]) {
          effectiveScope = scope;
        }
      }
    }

    // d. If no matching role grants permission
    if (sourceRoles.length === 0) {
      return {
        allowed: false,
        reason: 'NO_GRANT',
        evaluationSource: 'DATABASE',
        rolesEvaluated,
        sourceRoles: [],
        policyVersion: 2,
        evaluatedAt: now
      };
    }

    // f. Return ROLE_GRANT
    return {
      allowed: true,
      reason: 'ROLE_GRANT',
      effectiveScope,
      evaluationSource: 'DATABASE',
      rolesEvaluated,
      sourceRoles,
      policyVersion: 2,
      evaluatedAt: now
    };
  }

  async authorizeMany(membershipId: string, slugs: string[]): Promise<Record<string, AuthorizationDecision>> {
    const results: Record<string, AuthorizationDecision> = {};
    const now = new Date();
    
    const overrides = await this.prisma.permissionOverride.findMany({
      where: {
        membershipId,
        permissionSlug: { in: slugs }
      }
    });
    
    const membershipRoles = await this.prisma.membershipRole.findMany({
      where: {
        membershipId,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      include: {
        role: {
          include: {
            permissions: {
              where: {
                permission: { slug: { in: slugs } }
              },
              include: {
                permission: true
              }
            }
          }
        }
      }
    });

    const rolesEvaluated = membershipRoles.map(mr => mr.role.name);

    for (const slug of slugs) {
      const override = overrides.find(o => o.permissionSlug === slug);
      if (override && (!override.expiresAt || override.expiresAt > now)) {
        if (override.overrideType === 'DENY') {
          results[slug] = {
            allowed: false,
            reason: 'EXPLICIT_DENY',
            evaluationSource: 'OVERRIDE',
            rolesEvaluated,
            sourceRoles: [],
            policyVersion: 2,
            evaluatedAt: now,
            expiresAt: override.expiresAt ?? undefined
          };
          continue;
        }
        if (override.overrideType === 'ALLOW') {
          results[slug] = {
            allowed: true,
            reason: 'EXPLICIT_ALLOW',
            effectiveScope: 'ORGANIZATION',
            evaluationSource: 'OVERRIDE',
            rolesEvaluated,
            sourceRoles: [],
            policyVersion: 2,
            evaluatedAt: now,
            expiresAt: override.expiresAt ?? undefined
          };
          continue;
        }
      }

      const sourceRoles: string[] = [];
      let effectiveScope: ScopeType | undefined = undefined;

      for (const mr of membershipRoles) {
        const hasPerm = mr.role.permissions.some(rp => rp.permission.slug === slug);
        if (hasPerm) {
          sourceRoles.push(mr.role.name);
          const scope = mr.scopeType as ScopeType;
          if (!effectiveScope || SCOPE_ORDER[scope] > SCOPE_ORDER[effectiveScope]) {
            effectiveScope = scope;
          }
        }
      }

      if (sourceRoles.length === 0) {
        results[slug] = {
          allowed: false,
          reason: 'NO_GRANT',
          evaluationSource: 'DATABASE',
          rolesEvaluated,
          sourceRoles: [],
          policyVersion: 2,
          evaluatedAt: now
        };
      } else {
        results[slug] = {
          allowed: true,
          reason: 'ROLE_GRANT',
          effectiveScope,
          evaluationSource: 'DATABASE',
          rolesEvaluated,
          sourceRoles,
          policyVersion: 2,
          evaluatedAt: now
        };
      }
    }

    return results;
  }
}

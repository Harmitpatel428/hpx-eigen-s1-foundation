export type AuthorizationReason =
  | 'EXPLICIT_DENY'
  | 'EXPLICIT_ALLOW'
  | 'ROLE_GRANT'
  | 'NO_GRANT'
  | 'EXPIRED_GRANT'
  | 'TENANT_SUSPENDED';

export type EvaluationSource = 'CACHE' | 'DATABASE' | 'OVERRIDE';

export type ScopeType = 'OWN' | 'TEAM' | 'DEPARTMENT' | 'ORGANIZATION';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
  effectiveScope?: ScopeType;
  evaluationSource: EvaluationSource;
  rolesEvaluated: string[];
  sourceRoles: string[];
  policyVersion: number;
  evaluatedAt: Date;
  expiresAt?: Date;
  scopeTargetIds?: string[];
}

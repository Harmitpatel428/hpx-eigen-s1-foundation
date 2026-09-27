/**
 * Phase 1 (A) — single source of truth for the 35 reconciled/new permission slugs
 * (19 legacy split-brain slugs + 16 new Case Operations Engine slugs).
 *
 * Any future slug must be added to the migration, seed-permissions.ts, AND this
 * list together.
 */
export const ENGINE_PERMISSION_SLUGS: string[] = [
  // Handoff (19 legacy — reconciliation)
  'handoff:submit',
  'handoff:accept',
  'handoff:reject',
  'handoff:return',
  'handoff:resend',
  'handoff:manager_review',
  // Client Portal
  'portal:view',
  'portal:publish',
  'portal:contact_request',
  'portal:contact_approve',
  'portal:preview',
  'portal:session_revoke',
  'portal:activate',
  // Case lifecycle
  'cases:generate-id',
  'cases:close',
  'cases:reopen',
  // Mandate lifecycle
  'mandate:send',
  'mandate:verify',
  'mandate:view',
  // Case Operations Engine (16 new)
  'case-engine:manage',
  'case-field:view',
  'case-field:manage',
  'case-type:view',
  'case-type:manage',
  'case-type:publish',
  'case-timeline:view',
  'case-timeline:manage',
  'case-stage:start',
  'case-stage:complete',
  'case-stage:skip',
  'case-stage:reopen',
  'case-stage:override',
  'case-exception:approve',
  'case-calendar:manage',
  'sla:unlock',
];

export const CASE_ENGINE_MANAGE_SLUG = 'case-engine:manage';

-- Phase 1 (A): permission split-brain reconciliation + Case Operations Engine permissions.
--
-- Reconciliation: 19 legacy slugs below were already seeded via raw-SQL migrations
-- (20260830010000, 20260908030000, 20260909110000, 20260911110000) but were never added
-- to prisma/seed-permissions.ts's PERMISSIONS array. This INSERT is a no-op for those 19
-- in any environment that already ran those migrations (ON CONFLICT DO NOTHING); it exists
-- so a *fresh* environment that seeds permissions from seed-permissions.ts alone (without
-- replaying every historical migration) still ends up with the same 19 rows. module and
-- description below are copied verbatim from each slug's original migration.
--
-- New: 16 Case Operations Engine slugs (module 'Case Engine').
--
-- No DELETE/UPDATE/REVOKE. Additive and idempotent.

INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  -- Handoff (from 20260830010000)
  (gen_random_uuid(), 'handoff:submit',          'Handoff',       'Confirm a qualified lead and hand it off to Documentation'),
  (gen_random_uuid(), 'handoff:accept',          'Handoff',       'Accept an incoming handoff into Documentation'),
  (gen_random_uuid(), 'handoff:reject',          'Handoff',       'Reject an incoming handoff before acceptance'),
  (gen_random_uuid(), 'handoff:return',          'Handoff',       'Return a case to Sales after acceptance'),
  (gen_random_uuid(), 'handoff:resend',          'Handoff',       'Fix and resend a rejected or returned handoff'),
  (gen_random_uuid(), 'handoff:manager_review',  'Handoff',       'Clear the manager review lock after repeated returns'),
  -- Client Portal (from 20260830010000 and 20260908030000)
  (gen_random_uuid(), 'portal:view',             'Client Portal', 'View client portal status and settings'),
  (gen_random_uuid(), 'portal:publish',          'Client Portal', 'Publish notes and documents to the client portal'),
  (gen_random_uuid(), 'portal:contact_request',  'Client Portal', 'Request a change to the portal contact number'),
  (gen_random_uuid(), 'portal:contact_approve',  'Client Portal', 'Approve a portal contact change and revoke active sessions'),
  (gen_random_uuid(), 'portal:preview',          'Client Portal', 'Open the internal staff preview of a client portal'),
  (gen_random_uuid(), 'portal:session_revoke',   'Client Portal', 'Revoke active client portal sessions'),
  (gen_random_uuid(), 'portal:activate',         'Client Portal', 'Activate client portal access for a DocCase'),
  -- Case lifecycle (from 20260909110000)
  (gen_random_uuid(), 'cases:generate-id',       'Documentation', 'Manually generate a Case ID for a DocCase'),
  (gen_random_uuid(), 'cases:close',             'Documentation', 'Close a case without documentation'),
  (gen_random_uuid(), 'cases:reopen',            'Documentation', 'Reopen a closed case'),
  -- Mandate lifecycle (from 20260911110000)
  (gen_random_uuid(), 'mandate:send',            'Documentation', 'Send mandate upload requests to clients'),
  (gen_random_uuid(), 'mandate:verify',          'Documentation', 'Verify or reject uploaded mandate documents'),
  (gen_random_uuid(), 'mandate:view',            'Documentation', 'View mandate requests and uploads for a case'),
  -- Case Operations Engine (new)
  (gen_random_uuid(), 'case-engine:manage',      'Case Engine',   'Enable or disable the Case Operations Engine for the tenant'),
  (gen_random_uuid(), 'case-field:view',         'Case Engine',   'View custom case field definitions'),
  (gen_random_uuid(), 'case-field:manage',       'Case Engine',   'Create, edit, and delete custom case field definitions'),
  (gen_random_uuid(), 'case-type:view',          'Case Engine',   'View case type definitions'),
  (gen_random_uuid(), 'case-type:manage',        'Case Engine',   'Create and edit case type definitions'),
  (gen_random_uuid(), 'case-type:publish',       'Case Engine',   'Publish a case type definition for use on new cases'),
  (gen_random_uuid(), 'case-timeline:view',      'Case Engine',   'View a case timeline and its stage history'),
  (gen_random_uuid(), 'case-timeline:manage',    'Case Engine',   'Configure the stages and structure of a case timeline'),
  (gen_random_uuid(), 'case-stage:start',        'Case Engine',   'Start a case stage'),
  (gen_random_uuid(), 'case-stage:complete',     'Case Engine',   'Complete a case stage'),
  (gen_random_uuid(), 'case-stage:skip',         'Case Engine',   'Skip a case stage'),
  (gen_random_uuid(), 'case-stage:reopen',       'Case Engine',   'Reopen a completed or skipped case stage'),
  (gen_random_uuid(), 'case-stage:override',     'Case Engine',   'Override case stage requirements (manager)'),
  (gen_random_uuid(), 'case-exception:approve',  'Case Engine',   'Approve an exception raised against a case'),
  (gen_random_uuid(), 'case-calendar:manage',    'Case Engine',   'Manage case calendar scheduling and deadlines'),
  (gen_random_uuid(), 'sla:unlock',              'Case Engine',   'Unlock an SLA-locked case action')
ON CONFLICT ("slug") DO NOTHING;

-- Grant the 16 NEW Case Operations Engine permissions to each tenant's Organization Admin role.
-- (The 19 legacy slugs already have their Organization Admin grants from their original migrations.)
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN (
    'case-engine:manage',
    'case-field:view', 'case-field:manage',
    'case-type:view', 'case-type:manage', 'case-type:publish',
    'case-timeline:view', 'case-timeline:manage',
    'case-stage:start', 'case-stage:complete', 'case-stage:skip', 'case-stage:reopen', 'case-stage:override',
    'case-exception:approve',
    'case-calendar:manage',
    'sla:unlock'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Phase 1-B permissions. Seeded via migration (not `db push`) so every
-- environment gets them — a missing Permission row previously caused a P0 where
-- the UI silently rendered nothing.

INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'handoff:submit',          'Handoff',       'Confirm a qualified lead and hand it off to Documentation'),
  (gen_random_uuid(), 'handoff:accept',          'Handoff',       'Accept an incoming handoff into Documentation'),
  (gen_random_uuid(), 'handoff:reject',          'Handoff',       'Reject an incoming handoff before acceptance'),
  (gen_random_uuid(), 'handoff:return',          'Handoff',       'Return a case to Sales after acceptance'),
  (gen_random_uuid(), 'handoff:resend',          'Handoff',       'Fix and resend a rejected or returned handoff'),
  (gen_random_uuid(), 'handoff:manager_review',  'Handoff',       'Clear the manager review lock after repeated returns'),
  (gen_random_uuid(), 'portal:view',             'Client Portal', 'View client portal status and settings'),
  (gen_random_uuid(), 'portal:publish',          'Client Portal', 'Publish notes and documents to the client portal'),
  (gen_random_uuid(), 'portal:contact_request',  'Client Portal', 'Request a change to the portal contact number'),
  (gen_random_uuid(), 'portal:contact_approve',  'Client Portal', 'Approve a portal contact change and revoke active sessions'),
  (gen_random_uuid(), 'portal:preview',          'Client Portal', 'Open the internal staff preview of a client portal'),
  (gen_random_uuid(), 'portal:session_revoke',   'Client Portal', 'Revoke active client portal sessions')
ON CONFLICT ("slug") DO NOTHING;

-- Grant everything above to each tenant's Organization Admin role.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN (
    'handoff:submit', 'handoff:accept', 'handoff:reject', 'handoff:return',
    'handoff:resend', 'handoff:manager_review',
    'portal:view', 'portal:publish', 'portal:contact_request',
    'portal:contact_approve', 'portal:preview', 'portal:session_revoke'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

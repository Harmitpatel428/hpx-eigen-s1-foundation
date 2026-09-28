-- Drift item #5 (Workstream F forensics, wsF-report.md).
-- Migration 20260830000000_phase_1b_handoff_portal hand-named this index
-- PortalAuthAttempt_lookup_idx; schema.prisma's @@index([caseNumber, ipAddress,
-- attemptedAt]) implies Prisma's canonical name
-- PortalAuthAttempt_caseNumber_ipAddress_attemptedAt_idx. Same columns, same
-- order, purely cosmetic drift. Confirmed (PRE-APPLY GATE) that nothing in
-- code/SQL/docs references the old name outside the migration that created
-- it. ALTER INDEX ... RENAME is catalog-only -- instant, non-locking.
ALTER INDEX "PortalAuthAttempt_lookup_idx" RENAME TO "PortalAuthAttempt_caseNumber_ipAddress_attemptedAt_idx";

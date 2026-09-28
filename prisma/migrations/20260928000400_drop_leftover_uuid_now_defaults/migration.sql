-- Drift items #6-14 (Workstream F forensics, wsF-report.md).
-- schema.prisma declares `id String @id @default(uuid())` and
-- `updatedAt DateTime @updatedAt` for these 9 tables — both client-side
-- Prisma defaults, never DB-level ones. Each table was created by a
-- hand-written raw-SQL migration that used the Postgres-idiomatic
-- DEFAULT gen_random_uuid() / DEFAULT now() instead, leaving a DB-level
-- default schema.prisma never asked for. This is the same anti-pattern
-- already reconciled once in this repo for LeadActivity/LeadNote/LeadTag via
-- migration 20260817044504_add_departments_teams_docs_invoices_drop_v2_auth;
-- this migration repeats that reconciliation for the 9 tables created since.
-- PRE-APPLY GATE confirmed: no raw-SQL insert into any of these 9 tables
-- omits id/updatedAt (all rely on Prisma Client or supply both explicitly),
-- so dropping the DB default changes no accepted INSERT. Metadata-only,
-- no table rewrite, no lock beyond a brief catalog update.
ALTER TABLE "Conversation"               ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "LeadPhone"                  ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "MandateRequest"             ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "MandateUpload"              ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "Message"                    ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PortalAuthAttempt"          ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PortalContactChangeRequest" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PortalSession"              ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "WhatsAppChannel"             ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;

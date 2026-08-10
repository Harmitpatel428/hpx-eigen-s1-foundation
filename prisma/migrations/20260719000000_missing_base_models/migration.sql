-- Missing enums and models that were applied to the DB directly without migrations.
-- Must run between s1_s2_full_schema and auth_v2_phase1_schema.

-- CreateEnum
CREATE TYPE "VerificationTokenStatus" AS ENUM ('PENDING', 'USED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PasswordResetTokenStatus" AS ENUM ('PENDING', 'USED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvitationEmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('OWN', 'TEAM', 'DEPARTMENT', 'ORGANIZATION');

-- AlterTable UserInvitation: add emailStatus
ALTER TABLE "UserInvitation" ADD COLUMN "emailStatus" "InvitationEmailStatus" NOT NULL DEFAULT 'PENDING';

-- Restructure UserRole: surrogate PK → composite PK, add scopeType, remove extra columns
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_assignedBy_fkey";
DROP INDEX "UserRole_userId_idx";
DROP INDEX "UserRole_roleId_idx";
DROP INDEX "UserRole_deletedAt_idx";
DROP INDEX "UserRole_userId_roleId_key";
DROP INDEX "UserRole_userId_invitationId_key";
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_pkey";
ALTER TABLE "UserRole" DROP COLUMN "id";
ALTER TABLE "UserRole" DROP COLUMN "invitationId";
ALTER TABLE "UserRole" DROP COLUMN "assignedAt";
ALTER TABLE "UserRole" DROP COLUMN "assignedBy";
ALTER TABLE "UserRole" DROP COLUMN "createdAt";
ALTER TABLE "UserRole" DROP COLUMN "deletedAt";
ALTER TABLE "UserRole" ADD COLUMN "scopeType" "ScopeType" NOT NULL DEFAULT 'OWN';
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "roleId");
CREATE INDEX "UserRole_userId_idx" ON "UserRole"("userId");

-- CreateTable VerificationToken
CREATE TABLE "VerificationToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "VerificationTokenStatus" NOT NULL DEFAULT 'PENDING',
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VerificationToken_tokenHash_key" ON "VerificationToken"("tokenHash");
CREATE INDEX "VerificationToken_userId_status_expiresAt_idx" ON "VerificationToken"("userId", "status", "expiresAt");
CREATE INDEX "VerificationToken_tokenHash_status_idx" ON "VerificationToken"("tokenHash", "status");

ALTER TABLE "VerificationToken" ADD CONSTRAINT "VerificationToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable PasswordResetToken
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "PasswordResetTokenStatus" NOT NULL DEFAULT 'PENDING',
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_status_expiresAt_idx" ON "PasswordResetToken"("userId", "status", "expiresAt");
CREATE INDEX "PasswordResetToken_tokenHash_status_idx" ON "PasswordResetToken"("tokenHash", "status");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

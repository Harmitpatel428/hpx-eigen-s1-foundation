/*
  Warnings:

  - You are about to drop the column `action` on the `Permission` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Permission` table. All the data in the column will be lost.
  - You are about to drop the column `deletedAt` on the `Permission` table. All the data in the column will be lost.
  - You are about to drop the column `resource` on the `Permission` table. All the data in the column will be lost.
  - You are about to drop the column `tenantId` on the `Permission` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Permission` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `Role` table. All the data in the column will be lost.
  - The primary key for the `RolePermission` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `createdAt` on the `RolePermission` table. All the data in the column will be lost.
  - You are about to drop the column `deletedAt` on the `RolePermission` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `RolePermission` table. All the data in the column will be lost.
  - You are about to drop the column `email` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `password` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `v2IdentityId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `v2MembershipId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `v2MigrationStatus` on the `User` table. All the data in the column will be lost.
  - The primary key for the `UserRole` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `assignedAt` on the `UserRole` table. All the data in the column will be lost.
  - You are about to drop the column `assignedBy` on the `UserRole` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `UserRole` table. All the data in the column will be lost.
  - You are about to drop the column `deletedAt` on the `UserRole` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `UserRole` table. All the data in the column will be lost.
  - You are about to drop the column `invitationId` on the `UserRole` table. All the data in the column will be lost.
  - You are about to drop the `Assignment` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[slug]` on the table `Permission` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenantId,identityId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `module` to the `Permission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `slug` to the `Permission` table without a default value. This is not possible if the table is not empty.
  - Made the column `description` on table `Permission` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED');

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "Permission" DROP CONSTRAINT "Permission_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Role" DROP CONSTRAINT "Role_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_assignedBy_fkey";

-- DropIndex
DROP INDEX "Permission_deletedAt_idx";

-- DropIndex
DROP INDEX "Permission_tenantId_idx";

-- DropIndex
DROP INDEX "Permission_tenantId_resource_action_key";

-- DropIndex
DROP INDEX "RolePermission_permissionId_idx";

-- DropIndex
DROP INDEX "RolePermission_roleId_idx";

-- DropIndex
DROP INDEX "RolePermission_roleId_permissionId_key";

-- DropIndex
DROP INDEX "User_tenantId_email_key";

-- DropIndex
DROP INDEX "UserRole_deletedAt_idx";

-- DropIndex
DROP INDEX "UserRole_roleId_idx";

-- DropIndex
DROP INDEX "UserRole_userId_invitationId_key";

-- DropIndex
DROP INDEX "UserRole_userId_roleId_key";

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "ownerId" UUID;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "expectedValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stage" "LeadStage" NOT NULL DEFAULT 'NEW';

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "customOpportunityType" TEXT,
ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "opportunityTypeId" UUID;

-- AlterTable
ALTER TABLE "Permission" DROP COLUMN "action",
DROP COLUMN "createdAt",
DROP COLUMN "deletedAt",
DROP COLUMN "resource",
DROP COLUMN "tenantId",
DROP COLUMN "updatedAt",
ADD COLUMN     "module" TEXT NOT NULL,
ADD COLUMN     "slug" TEXT NOT NULL,
ALTER COLUMN "description" SET NOT NULL;

-- AlterTable
ALTER TABLE "Role" DROP COLUMN "description",
ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "deletedAt",
DROP COLUMN "id",
ADD CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId");

-- AlterTable
ALTER TABLE "User" DROP COLUMN "email",
DROP COLUMN "password",
DROP COLUMN "v2IdentityId",
DROP COLUMN "v2MembershipId",
DROP COLUMN "v2MigrationStatus",
ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "identityId" UUID,
ADD COLUMN     "teamId" UUID;

-- AlterTable
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_pkey",
DROP COLUMN "assignedAt",
DROP COLUMN "assignedBy",
DROP COLUMN "createdAt",
DROP COLUMN "deletedAt",
DROP COLUMN "id",
DROP COLUMN "invitationId",
ADD COLUMN     "scopeType" "ScopeType" NOT NULL DEFAULT 'OWN',
ADD CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "roleId");

-- DropTable
DROP TABLE "Assignment";

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "departmentId" UUID,
    "name" TEXT NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentAssignment" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamAssignment" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_tenantId_idx" ON "Department"("tenantId");

-- CreateIndex
CREATE INDEX "Team_tenantId_departmentId_idx" ON "Team"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "DepartmentAssignment_departmentId_idx" ON "DepartmentAssignment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentAssignment_membershipId_departmentId_key" ON "DepartmentAssignment"("membershipId", "departmentId");

-- CreateIndex
CREATE INDEX "TeamAssignment_teamId_idx" ON "TeamAssignment"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamAssignment_membershipId_teamId_key" ON "TeamAssignment"("membershipId", "teamId");

-- CreateIndex
CREATE INDEX "Contact_tenantId_departmentId_idx" ON "Contact"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "Contact_tenantId_ownerId_idx" ON "Contact"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_departmentId_idx" ON "Lead"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_departmentId_idx" ON "Opportunity"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_opportunityTypeId_idx" ON "Opportunity"("tenantId", "opportunityTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_slug_key" ON "Permission"("slug");

-- CreateIndex
CREATE INDEX "User_teamId_deletedAt_idx" ON "User"("teamId", "deletedAt");

-- CreateIndex
CREATE INDEX "User_departmentId_deletedAt_idx" ON "User"("departmentId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_identityId_key" ON "User"("tenantId", "identityId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_opportunityTypeId_fkey" FOREIGN KEY ("opportunityTypeId") REFERENCES "OpportunityType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentAssignment" ADD CONSTRAINT "DepartmentAssignment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "OrganizationMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentAssignment" ADD CONSTRAINT "DepartmentAssignment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamAssignment" ADD CONSTRAINT "TeamAssignment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "OrganizationMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamAssignment" ADD CONSTRAINT "TeamAssignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

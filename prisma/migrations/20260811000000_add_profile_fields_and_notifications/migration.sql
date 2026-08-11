-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ROLE_ASSIGNED', 'ROLE_CHANGED', 'USER_INVITED', 'USER_ACTIVATED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED', 'LEAD_ASSIGNED', 'LEAD_STATUS_CHANGED', 'IMPORT_COMPLETED', 'IMPORT_FAILED', 'EXPORT_COMPLETED', 'SYSTEM_ANNOUNCEMENT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_tenantId_recipientUserId_readAt_idx" ON "Notification"("tenantId", "recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_recipientUserId_createdAt_idx" ON "Notification"("tenantId", "recipientUserId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

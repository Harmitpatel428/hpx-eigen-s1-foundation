-- AlterTable
ALTER TABLE "DocCaseDocument" ADD COLUMN     "requireDate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireNote" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "status" SET DEFAULT 'PENDING_COLLECTION';

-- AlterTable
ALTER TABLE "CaseTypeComponentDocument" ADD COLUMN     "requireDate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireNote" BOOLEAN NOT NULL DEFAULT false;


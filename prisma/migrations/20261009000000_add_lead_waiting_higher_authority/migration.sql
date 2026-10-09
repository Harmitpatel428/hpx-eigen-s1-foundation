-- Manual "work completed, waiting for higher authority" flag on Lead (additive).
ALTER TABLE "Lead" ADD COLUMN "waitingHigherAuthority" BOOLEAN NOT NULL DEFAULT false;

-- Add personContactId to Lead — direct FK to the auto-created person contact.
ALTER TABLE "Lead" ADD COLUMN "personContactId" UUID;

-- Unique: each lead has at most one person contact
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_personContactId_key" UNIQUE ("personContactId");

-- FK to Contact (SET NULL on delete so soft-delete + guard both work)
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_personContactId_fkey"
  FOREIGN KEY ("personContactId") REFERENCES "Contact"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

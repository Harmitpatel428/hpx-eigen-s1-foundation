-- Phase D: Conversation + Message tables for channel-aware messaging.
-- Each Conversation is scoped to one Lead + one WhatsAppChannel.
-- Messages record both inbound (webhook) and outbound (send API) traffic.

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'RESOLVED', 'ARCHIVED');
CREATE TYPE "MessageDirection"   AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "MessageType"        AS ENUM ('TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'TEMPLATE');

-- ── Conversation ──────────────────────────────────────────────────────────────

CREATE TABLE "Conversation" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"  UUID         NOT NULL,
  "leadId"    UUID         NOT NULL,
  "channelId" UUID         NOT NULL,
  "status"    "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "metadata"  JSONB        NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_leadId_channelId_key" ON "Conversation"("leadId", "channelId");
CREATE INDEX "Conversation_tenantId_idx"  ON "Conversation"("tenantId");
CREATE INDEX "Conversation_leadId_idx"    ON "Conversation"("leadId");
CREATE INDEX "Conversation_channelId_idx" ON "Conversation"("channelId");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_leadId_fkey"
    FOREIGN KEY ("leadId")    REFERENCES "Lead"("id")            ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "WhatsAppChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Message ───────────────────────────────────────────────────────────────────

CREATE TABLE "Message" (
  "id"             UUID              NOT NULL DEFAULT gen_random_uuid(),
  "conversationId" UUID              NOT NULL,
  "direction"      "MessageDirection" NOT NULL,
  "type"           "MessageType"     NOT NULL DEFAULT 'TEXT',
  "body"           TEXT              NOT NULL,
  "externalId"     TEXT,
  "sentAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Message_conversationId_idx"           ON "Message"("conversationId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

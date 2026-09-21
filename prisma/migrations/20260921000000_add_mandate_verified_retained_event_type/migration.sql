-- F6: coexistence event. New DocEventType emitted when a firm mandate upload retains a prior
-- VERIFIED mandate as history. Isolated migration — ALTER TYPE ... ADD VALUE must not be used in
-- the same transaction that adds it.
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'MANDATE_VERIFIED_RETAINED';

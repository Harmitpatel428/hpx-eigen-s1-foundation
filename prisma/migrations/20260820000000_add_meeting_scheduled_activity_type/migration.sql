-- ADD VALUE is safe in Postgres — does not require recreating the type or converting existing rows.
ALTER TYPE "LeadActivityType" ADD VALUE IF NOT EXISTS 'MEETING_SCHEDULED';

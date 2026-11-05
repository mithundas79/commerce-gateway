BEGIN;

-- Shared across worker processes, so another queued job cannot bypass a provider cooldown.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS worker_not_before timestamptz NOT NULL DEFAULT '-infinity';

COMMIT;

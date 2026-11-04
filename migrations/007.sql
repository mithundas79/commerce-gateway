BEGIN;

ALTER TABLE connections ADD COLUMN IF NOT EXISTS shopify_shop_id text;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS authorization_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE connections ADD COLUMN IF NOT EXISTS lifecycle_hold boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS connections_shopify_identity_idx ON connections(shopify_shop_id);
ALTER TABLE shopify_apps ADD COLUMN IF NOT EXISTS webhook_bindings text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS shopify_apps_webhook_bindings_idx ON shopify_apps USING gin(webhook_bindings);

-- Retain authenticated receipts without retaining webhook bodies or customer information.
CREATE TABLE IF NOT EXISTS shopify_lifecycle_events (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  topic text NOT NULL,
  body_hash text NOT NULL,
  generation uuid NOT NULL,
  tenant_id uuid REFERENCES tenants(id),
  connection_id uuid,
  shop text,
  status text NOT NULL CHECK (status IN ('pending','processed','ignored','action_required')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(client_id,topic,body_hash,generation)
);
CREATE INDEX IF NOT EXISTS shopify_lifecycle_ready_idx ON shopify_lifecycle_events(next_attempt_at)
  WHERE status='pending';

COMMIT;

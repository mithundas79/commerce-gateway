BEGIN;

ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS browser_binding_hash text;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS return_url text;
-- Pre-upgrade states lack a browser binding and cannot safely be completed.
DELETE FROM oauth_states WHERE browser_binding_hash IS NULL;
ALTER TABLE oauth_states ALTER COLUMN browser_binding_hash SET NOT NULL;

CREATE TABLE IF NOT EXISTS shopify_apps (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  client_id text NOT NULL,
  secret_ciphertext text NOT NULL,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL,
  allowed_return_urls text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One Shopify app/shop authorization must never be silently transferred across tenants.
CREATE TABLE IF NOT EXISTS shopify_shop_owners (
  client_id text NOT NULL,
  shop text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (client_id, shop)
);

CREATE TABLE IF NOT EXISTS oauth_browser_starts (
  ticket_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shop text NOT NULL,
  return_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_browser_starts_expiry_idx ON oauth_browser_starts(expires_at);

COMMIT;

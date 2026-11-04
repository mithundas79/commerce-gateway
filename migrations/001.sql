BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys(tenant_id);

CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shop text NOT NULL,
  token_ciphertext text NOT NULL,
  scopes text[] NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, shop),
  UNIQUE(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shop text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = 'product_title_update'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retry', 'recovering', 'succeeded', 'failed', 'uncertain')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  lease_until timestamptz,
  fence_token bigint NOT NULL DEFAULT 0,
  dispatch_started_at timestamptz,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, id),
  UNIQUE(tenant_id, connection_id, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS operations_ready_idx ON operations(next_attempt_at, created_at)
  WHERE status IN ('queued', 'retry', 'recovering');
CREATE INDEX IF NOT EXISTS operations_expired_lease_idx ON operations(lease_until)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS operations_tenant_idx ON operations(tenant_id, created_at);

COMMIT;

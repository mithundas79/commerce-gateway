BEGIN;

CREATE TABLE IF NOT EXISTS notification_endpoints (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  version uuid NOT NULL,
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  secret_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS notification_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
  endpoint_version uuid NOT NULL,
  endpoint_url text NOT NULL,
  secret_ciphertext text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','retry','delivered','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  lease_until timestamptz,
  fence_token bigint NOT NULL DEFAULT 0,
  last_error text,
  last_http_status integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_events_ready_idx ON notification_events(next_attempt_at,created_at)
  WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS notification_events_lease_idx ON notification_events(lease_until)
  WHERE status = 'delivering';
CREATE INDEX IF NOT EXISTS notification_events_tenant_idx ON notification_events(tenant_id,created_at);

CREATE OR REPLACE FUNCTION enqueue_operation_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('succeeded','failed','uncertain') THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status IN ('succeeded','failed','uncertain') THEN RETURN NEW; END IF;
    END IF;
    INSERT INTO notification_events(id,tenant_id,operation_id,endpoint_version,endpoint_url,secret_ciphertext,body)
    SELECT NEW.id,NEW.tenant_id,NEW.id,e.version,e.url,e.secret_ciphertext,
      jsonb_build_object('id',NEW.id,'type','operation.completed',
        'occurredAt',COALESCE(NEW.completed_at,clock_timestamp()),
        'data',jsonb_build_object('operationId',NEW.id,'connectionId',NEW.connection_id,
          'kind',NEW.kind,'status',NEW.status,'result',NEW.result,
          'error',CASE WHEN NEW.error IS NULL THEN NULL ELSE jsonb_build_object('code',
            CASE WHEN NEW.error->>'code' ~ '^[A-Z0-9_]{1,80}$' THEN NEW.error->>'code' ELSE 'OPERATION_FAILED' END) END))::text
    FROM notification_endpoints e WHERE e.tenant_id=NEW.tenant_id AND e.enabled
    ON CONFLICT(operation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS operations_completion_notification ON operations;
CREATE TRIGGER operations_completion_notification AFTER INSERT OR UPDATE OF status ON operations
  FOR EACH ROW EXECUTE FUNCTION enqueue_operation_completion();

CREATE OR REPLACE FUNCTION immutable_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.operation_id,NEW.endpoint_version,NEW.endpoint_url,NEW.secret_ciphertext,NEW.body)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.operation_id,OLD.endpoint_version,OLD.endpoint_url,OLD.secret_ciphertext,OLD.body) THEN
    RAISE EXCEPTION 'Notification event identity, payload and destination are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS notification_event_immutable ON notification_events;
CREATE TRIGGER notification_event_immutable BEFORE UPDATE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION immutable_notification_event();

COMMIT;

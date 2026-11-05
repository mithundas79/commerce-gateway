BEGIN;

CREATE SEQUENCE IF NOT EXISTS operation_queue_sequence;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS queue_sequence bigint;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS ordering_released_at timestamptz;

-- The migration's table lock prevents concurrent inserts while the existing queue is ordered.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS position FROM operations
)
UPDATE operations o SET queue_sequence = ordered.position FROM ordered WHERE ordered.id = o.id;
SELECT setval('operation_queue_sequence', COALESCE(MAX(queue_sequence), 0) + 1, false) FROM operations;
ALTER TABLE operations ALTER COLUMN queue_sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS operations_queue_sequence_idx ON operations(queue_sequence);
CREATE INDEX IF NOT EXISTS operations_product_order_idx
  ON operations(tenant_id, connection_id, kind, (payload->>'productId'), queue_sequence)
  WHERE status IN ('queued','running','retry','recovering')
    OR (status = 'uncertain' AND ordering_released_at IS NULL);

CREATE OR REPLACE FUNCTION assign_operation_queue_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE existing_sequence bigint;
BEGIN
  -- A committed replay avoids locks and sequence consumption altogether.
  SELECT queue_sequence INTO existing_sequence FROM operations
    WHERE tenant_id=NEW.tenant_id AND connection_id=NEW.connection_id
      AND kind=NEW.kind AND idempotency_key=NEW.idempotency_key;
  IF FOUND THEN NEW.queue_sequence := existing_sequence; RETURN NEW; END IF;

  -- Concurrent equal keys, including changed payloads, serialize before allocating a position.
  PERFORM pg_advisory_xact_lock(hashtextextended('operation-idempotency:' ||
    jsonb_build_array(NEW.tenant_id,NEW.connection_id,NEW.kind,NEW.idempotency_key)::text, 0));
  SELECT queue_sequence INTO existing_sequence FROM operations
    WHERE tenant_id=NEW.tenant_id AND connection_id=NEW.connection_id
      AND kind=NEW.kind AND idempotency_key=NEW.idempotency_key;
  IF FOUND THEN NEW.queue_sequence := existing_sequence; RETURN NEW; END IF;

  -- Allocate after locking the resource. Later committed inserts cannot hide an earlier
  -- uncommitted position from workers, even when separate API instances enqueue concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended('operation-product:' ||
    jsonb_build_array(NEW.tenant_id,NEW.connection_id,NEW.kind,NEW.payload->>'productId')::text, 0));
  NEW.queue_sequence := nextval('operation_queue_sequence');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS operations_assign_queue_sequence ON operations;
CREATE TRIGGER operations_assign_queue_sequence BEFORE INSERT ON operations
  FOR EACH ROW EXECUTE FUNCTION assign_operation_queue_sequence();

CREATE OR REPLACE FUNCTION preserve_operation_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.connection_id,NEW.kind,NEW.idempotency_key,NEW.payload,NEW.queue_sequence,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.connection_id,OLD.kind,OLD.idempotency_key,OLD.payload,OLD.queue_sequence,OLD.created_at) THEN
    RAISE EXCEPTION 'Operation identity, payload and queue position are immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed','uncertain') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal operation status is immutable';
  END IF;
  IF NEW.ordering_released_at IS DISTINCT FROM OLD.ordering_released_at
    AND (OLD.status <> 'uncertain' OR NEW.ordering_released_at IS NULL OR OLD.ordering_released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only an unresolved uncertain operation can release its ordering hold';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS operations_preserve_order_identity ON operations;
CREATE TRIGGER operations_preserve_order_identity BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION preserve_operation_order_identity();

COMMIT;

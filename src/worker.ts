import type { Pool } from 'pg';

export type OperationStatus = 'queued' | 'running' | 'retry' | 'recovering' | 'succeeded' | 'failed' | 'uncertain';
export interface Operation {
  id: string;
  tenant_id: string;
  connection_id: string;
  kind: 'product_title_update';
  payload: { productId: string; title: string };
  status: OperationStatus;
  attempt_count: number;
  deadline_at: Date | string;
  fence_token: string | number;
  dispatch_started_at: Date | string | null;
  authorization_generation?: string;
}
export interface ProductContext {
  tenantId: string;
  connectionId: string;
  productId: string;
  signal: AbortSignal;
  operationId?: string;
  fenceToken?: string | number;
  authorizationGeneration?: string;
}
export interface OperationProvider {
  readProductTitle(context: ProductContext): Promise<string | null>;
  updateProductTitle(context: ProductContext & { title: string }): Promise<unknown>;
}
export interface WorkerOptions {
  pool: Pick<Pool, 'query'>;
  provider: OperationProvider;
  /** Optional extra tenant policy check, in addition to the mandatory DB scope check. */
  authorize?: (operation: Operation, signal: AbortSignal) => Promise<boolean>;
  timeoutMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
  /** Invoked by startWorker after a successful DB-backed poll, including an empty queue. */
  onHealthy?: () => Promise<void> | void;
  /** Invoked after failed DB-backed polls so a runtime can withdraw its shared heartbeat. */
  onUnhealthy?: () => Promise<void> | void;
}

type SafeError = { code: string; retryable?: boolean; ambiguous?: boolean; retryAfterMs?: number };

function validateOptions(options: WorkerOptions): void {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const leaseMs = options.leaseMs ?? 90_000;
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(leaseMs) || timeoutMs <= 0
    || leaseMs < timeoutMs * 3 + 1_000 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Worker lease must exceed three call timeouts plus one second; attempts must be positive');
  }
}

function safeError(error: unknown): SafeError {
  if (!error || typeof error !== 'object') return { code: 'PROVIDER_ERROR' };
  const e = error as Record<string, unknown>;
  return {
    code: typeof e.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'PROVIDER_ERROR',
    retryable: e.retryable === true,
    // Only an explicit false is proof the provider rejected the write.
    ambiguous: e.ambiguous !== false,
    retryAfterMs: typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)
      ? Math.max(0, e.retryAfterMs) : undefined,
  };
}

async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Provider deadline exceeded'), {
            code: 'PROVIDER_TIMEOUT', retryable: true, ambiguous: true,
          }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Atomic claim also reclaims crashed workers. The incremented token fences all later writes. */
export async function claimOperation(pool: Pick<Pool, 'query'>, leaseMs = 90_000): Promise<Operation | null> {
  const result = await pool.query<Operation>(`
    WITH candidate AS (
      SELECT o.id,c.authorization_generation FROM operations o
      JOIN connections c ON c.id = o.connection_id AND c.tenant_id = o.tenant_id
      WHERE ((o.status IN ('queued', 'retry', 'recovering') AND o.next_attempt_at <= clock_timestamp())
         OR (o.status = 'running' AND o.lease_until <= clock_timestamp()))
        AND (NOT c.lifecycle_hold OR o.deadline_at <= clock_timestamp())
        AND (c.worker_not_before <= clock_timestamp() OR o.deadline_at <= clock_timestamp())
        AND (o.deadline_at <= clock_timestamp() OR NOT EXISTS (
          SELECT 1 FROM operations prior WHERE prior.tenant_id = o.tenant_id
            AND prior.connection_id = o.connection_id AND prior.kind = o.kind
            AND prior.payload->>'productId' = o.payload->>'productId'
            AND prior.queue_sequence < o.queue_sequence
            AND (prior.status IN ('queued','running','retry','recovering')
              OR (prior.status = 'uncertain' AND prior.ordering_released_at IS NULL))
        ))
      ORDER BY o.next_attempt_at, o.queue_sequence
      FOR UPDATE OF o SKIP LOCKED LIMIT 1
    )
    UPDATE operations o SET status = 'running', attempt_count = attempt_count + 1,
      fence_token = fence_token + 1,
      lease_until = clock_timestamp() + ($1::double precision * interval '1 millisecond'),
      updated_at = clock_timestamp()
    FROM candidate c WHERE o.id = c.id RETURNING o.*,c.authorization_generation
  `, [leaseMs]);
  return result.rows[0] ?? null;
}

/** Runs at most one durable job. No network request is made inside a database transaction. */
export async function runWorkerOnce(options: WorkerOptions): Promise<boolean> {
  validateOptions(options);
  const { pool, provider } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const leaseMs = options.leaseMs ?? 90_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const operation = await claimOperation(pool, leaseMs);
  if (!operation) return false;
  const now = options.now ?? Date.now;
  const deadline = new Date(operation.deadline_at).getTime();
  let dispatched = operation.dispatch_started_at !== null;
  const finish = async (status: OperationStatus, result: unknown, error: SafeError | null, delayMs = 0, cooldownMs = 0) => {
    await pool.query(`
      WITH finished AS (
      UPDATE operations SET status = $4, result = $5::jsonb, error = $6::jsonb,
        lease_until = NULL, next_attempt_at = clock_timestamp() + ($7::double precision * interval '1 millisecond'),
        dispatch_started_at = CASE WHEN $8::boolean THEN dispatch_started_at ELSE NULL END,
        completed_at = CASE WHEN $4 IN ('succeeded','failed','uncertain') THEN clock_timestamp() ELSE NULL END,
        updated_at = clock_timestamp()
      WHERE id = $1 AND tenant_id = $2 AND fence_token = $3 AND status = 'running'
        AND lease_until > clock_timestamp()
      RETURNING tenant_id, connection_id
      )
      UPDATE connections c SET worker_not_before = GREATEST(c.worker_not_before,
        clock_timestamp() + ($9::double precision * interval '1 millisecond'))
      FROM finished f WHERE c.id = f.connection_id AND c.tenant_id = f.tenant_id AND $9 > 0
    `, [operation.id, operation.tenant_id, operation.fence_token, status,
      result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error), delayMs, dispatched, cooldownMs]);
  };
  const retry = async (error: SafeError) => {
    const cap = options.maxBackoffMs ?? 60_000;
    const exponential = Math.min(cap, (options.baseBackoffMs ?? 1_000) * 2 ** Math.min(20, operation.attempt_count - 1));
    const jitter = exponential * (0.5 + (options.random ?? Math.random)() * 0.5);
    const delay = Math.max(jitter, error.retryAfterMs ?? 0);
    const cooldownMs = error.code === 'RATE_LIMITED' || error.code === 'SHOPIFY_THROTTLED' ? delay : 0;
    if (now() >= deadline || operation.attempt_count >= maxAttempts) {
      await finish(dispatched ? 'uncertain' : 'failed', null, {
        code: now() >= deadline ? 'DEADLINE_EXCEEDED' : 'ATTEMPTS_EXHAUSTED',
      }, 0, cooldownMs);
      return;
    }
    // Wake at the deadline even when a provider's retry-after exceeds our remaining budget.
    await finish(dispatched ? 'recovering' : 'retry', null, error, Math.max(0, Math.min(delay, deadline - now())), cooldownMs);
  };
  if (!Number.isFinite(deadline) || now() >= deadline || operation.attempt_count > maxAttempts) {
    await finish(dispatched ? 'uncertain' : 'failed', null, { code: 'DEADLINE_OR_ATTEMPTS_EXCEEDED' });
    return true;
  }
  if (operation.kind !== 'product_title_update'
    || !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(operation.payload?.productId ?? '')
    || typeof operation.payload?.title !== 'string' || !operation.payload.title.trim()
    || operation.payload.title.length > 255) {
    await finish(dispatched ? 'uncertain' : 'failed', null, { code: 'INVALID_OPERATION' });
    return true;
  }
  try {
    const connection = await pool.query(`
      SELECT id FROM connections WHERE id = $1 AND tenant_id = $2
        AND revoked_at IS NULL AND NOT lifecycle_hold AND 'write_products' = ANY(scopes)
    `, [operation.connection_id, operation.tenant_id]);
    const allowed = connection.rows.length > 0 && (!options.authorize
      || await bounded(signal => options.authorize!(operation, signal), Math.min(timeoutMs, deadline - now())));
    if (!allowed) {
      await finish(dispatched ? 'uncertain' : 'failed', null, { code: 'CONNECTION_NOT_AUTHORIZED' });
      return true;
    }
    const context = { tenantId: operation.tenant_id, connectionId: operation.connection_id,
      productId: operation.payload.productId, operationId: operation.id, fenceToken: operation.fence_token,
      authorizationGeneration: operation.authorization_generation };
    if (dispatched) {
      const title = await bounded(signal => provider.readProductTitle({ ...context, signal }), Math.min(timeoutMs, Math.max(1, deadline - now())));
      if (title === operation.payload.title) {
        await finish('succeeded', { productId: operation.payload.productId, title, recovered: true }, null);
      } else {
        // An unobserved dispatched write can still arrive later. Never blindly write it again.
        await retry({ code: 'READBACK_UNCONFIRMED', retryable: true, ambiguous: true });
      }
      return true;
    }
    // This committed marker closes the crash gap between sending a write and storing its response.
    const marked = await pool.query(`
      UPDATE operations SET dispatch_started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND tenant_id = $2 AND fence_token = $3 AND status = 'running'
        AND lease_until > clock_timestamp() AND deadline_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM connections c WHERE c.id = operations.connection_id
          AND c.tenant_id = operations.tenant_id AND c.revoked_at IS NULL AND NOT c.lifecycle_hold
          AND 'write_products' = ANY(c.scopes) AND c.worker_not_before <= clock_timestamp())
        AND NOT EXISTS (
          SELECT 1 FROM operations prior WHERE prior.tenant_id = operations.tenant_id
            AND prior.connection_id = operations.connection_id AND prior.kind = operations.kind
            AND prior.payload->>'productId' = operations.payload->>'productId'
            AND prior.queue_sequence < operations.queue_sequence
            AND (prior.status IN ('queued','running','retry','recovering')
              OR (prior.status = 'uncertain' AND prior.ordering_released_at IS NULL))
        )
      RETURNING id
    `, [operation.id, operation.tenant_id, operation.fence_token]);
    if (marked.rows.length === 0) {
      // A concurrent cooldown/revocation can land after claim. Release a still-owned lease;
      // a stale worker's completion remains fenced and simply affects no row.
      await retry({ code: 'DISPATCH_PRECONDITION_CHANGED', retryable: true, ambiguous: false });
      return true;
    }
    if (now() >= deadline) {
      await finish('failed', null, { code: 'DEADLINE_EXCEEDED' });
      return true;
    }
    dispatched = true;
    try {
      await bounded(signal => provider.updateProductTitle({ ...context, title: operation.payload.title, signal }),
        Math.min(timeoutMs, Math.max(1, deadline - now())));
      await finish('succeeded', { productId: operation.payload.productId, title: operation.payload.title }, null);
    } catch (error) {
      const safe = safeError(error);
      if (safe.ambiguous !== false) {
        await retry(safe);
      } else {
        dispatched = false;
        if (safe.retryable) await retry(safe);
        else await finish('failed', null, safe);
      }
    }
  } catch (error) {
    // Authorization/readback failures are safe to retry; dispatched jobs remain readback-only.
    await retry(safeError(error));
  }
  return true;
}

/** Operator-only acknowledgement after reconciliation; it does not prove Shopify has no delayed request. */
export async function releaseUncertainOperation(
  pool: Pick<Pool, 'query'>,
  input: { tenantId: string; operationId: string },
): Promise<boolean> {
  const result = await pool.query(`
    UPDATE operations SET ordering_released_at = COALESCE(ordering_released_at, clock_timestamp()),
      updated_at = clock_timestamp()
    WHERE id = $1 AND tenant_id = $2 AND status = 'uncertain' RETURNING id
  `, [input.operationId, input.tenantId]);
  return result.rows.length === 1;
}

/** Graceful stop finishes the current bounded call, then stops claiming jobs. */
export async function startWorker(options: WorkerOptions & { signal: AbortSignal; pollMs?: number }): Promise<void> {
  validateOptions(options);
  while (!options.signal.aborted) {
    let worked = false;
    try {
      worked = await runWorkerOnce(options);
      await options.onHealthy?.();
    } catch {
      // DB outages leave durable rows available for lease reclamation. Avoid an outage busy-loop.
      try { await options.onUnhealthy?.(); } catch { /* Heartbeat removal must not stop lease recovery. */ }
    }
    if (!worked && !options.signal.aborted) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, options.pollMs ?? 1_000);
        options.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}

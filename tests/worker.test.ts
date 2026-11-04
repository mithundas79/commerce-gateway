import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { claimOperation, runWorkerOnce, type Operation, type OperationProvider } from '../src/worker.js';

const now = Date.now();
const base: Operation = {
  id: '00000000-0000-4000-8000-000000000001',
  tenant_id: '00000000-0000-4000-8000-000000000002',
  connection_id: '00000000-0000-4000-8000-000000000003',
  kind: 'product_title_update', payload: { productId: 'gid://shopify/Product/123', title: 'Oak' },
  status: 'running', attempt_count: 1, deadline_at: new Date(now + 60_000),
  fence_token: '7', dispatch_started_at: null,
};

function fixture(overrides: Partial<Operation> = {}, settings: { scope?: boolean; fence?: boolean; empty?: boolean } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const events: string[] = [];
  const operation = { ...base, ...overrides };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('WITH candidate')) return { rows: settings.empty ? [] : [operation] };
      if (sql.includes('SELECT id FROM connections')) return { rows: settings.scope === false ? [] : [{ id: operation.connection_id }] };
      if (sql.includes('SET dispatch_started_at')) {
        events.push('marker-committed');
        return { rows: settings.fence === false ? [] : [{ id: operation.id }] };
      }
      events.push('completion');
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pick<Pool, 'query'>;
  let reads = 0;
  let writes = 0;
  const provider: OperationProvider = {
    readProductTitle: async () => { reads++; return 'Oak'; },
    updateProductTitle: async context => {
      writes++;
      events.push('write');
      assert.equal(context.tenantId, base.tenant_id);
      assert.equal(context.connectionId, base.connection_id);
      assert.equal(context.productId, base.payload.productId);
      return {};
    },
  };
  const options = { pool, provider, now: () => now, random: () => 0, timeoutMs: 10, leaseMs: 2_000 };
  return {
    calls, events, options, provider,
    get reads() { return reads; }, get writes() { return writes; },
    get finish() { return calls.find(c => c.sql.includes('SET status = $4'))!; },
  };
}

test('empty queue returns false; claims use SKIP LOCKED and increment fencing tokens', async () => {
  const f = fixture({}, { empty: true });
  assert.equal(await runWorkerOnce(f.options), false);
  assert.match(f.calls[0]!.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(f.calls[0]!.sql, /fence_token = fence_token \+ 1/);
  assert.equal(f.writes, 0);
});

test('successful write commits dispatch marker first and fences tenant-scoped completion', async () => {
  const f = fixture();
  assert.equal(await runWorkerOnce(f.options), true);
  assert.deepEqual(f.events, ['marker-committed', 'write', 'completion']);
  assert.equal(f.finish.params[3], 'succeeded');
  assert.deepEqual(f.finish.params.slice(0, 3), [base.id, base.tenant_id, '7']);
  assert.match(f.finish.sql, /fence_token = \$3/);
  assert.match(f.finish.sql, /lease_until > clock_timestamp\(\)/);
  assert.match(f.calls[1]!.sql, /tenant_id = \$2/);
  assert.match(f.calls[1]!.sql, /'write_products' = ANY\(scopes\)/);
});

test('ambiguous write enters recovery with durable marker and backoff', async () => {
  const f = fixture();
  f.provider.updateProductTitle = async () => { throw new Error('Network broke with SECRET_TOKEN'); };
  await runWorkerOnce(f.options);
  assert.equal(f.finish.params[3], 'recovering');
  assert.equal(f.finish.params[6], 500);
  assert.equal(f.finish.params[7], true);
  assert.doesNotMatch(String(f.finish.params[5]), /SECRET_TOKEN/);
});

test('crash after dispatch recovers by readback without repeating the write', async () => {
  const f = fixture({ dispatch_started_at: new Date(now - 1_000), attempt_count: 2 });
  await runWorkerOnce(f.options);
  assert.equal(f.reads, 1);
  assert.equal(f.writes, 0);
  assert.equal(f.finish.params[3], 'succeeded');
  assert.equal(JSON.parse(String(f.finish.params[4])).recovered, true);
});

test('unconfirmed readback never redispatches and eventually becomes uncertain', async () => {
  const f = fixture({ dispatch_started_at: new Date(now - 1_000), attempt_count: 8 });
  f.provider.readProductTitle = async () => 'Old title';
  await runWorkerOnce(f.options);
  assert.equal(f.writes, 0);
  assert.equal(f.finish.params[3], 'uncertain');
  assert.equal(JSON.parse(String(f.finish.params[5])).code, 'ATTEMPTS_EXHAUSTED');
});

test('definitively rejected throttled write can retry and clears dispatch ambiguity', async () => {
  const f = fixture();
  f.provider.updateProductTitle = async () => {
    throw { code: 'SHOPIFY_THROTTLED', retryable: true, ambiguous: false, retryAfterMs: 2_000 };
  };
  await runWorkerOnce(f.options);
  assert.equal(f.finish.params[3], 'retry');
  assert.equal(f.finish.params[6], 2_000);
  assert.equal(f.finish.params[7], false);
});

test('definitive validation errors are terminal', async () => {
  const f = fixture();
  f.provider.updateProductTitle = async () => {
    throw { code: 'SHOPIFY_USER_ERROR', retryable: false, ambiguous: false };
  };
  await runWorkerOnce(f.options);
  assert.equal(f.finish.params[3], 'failed');
  assert.equal(f.finish.params[7], false);
});

test('revoked or insufficient-scope connection prevents provider dispatch', async () => {
  const f = fixture({}, { scope: false });
  await runWorkerOnce(f.options);
  assert.equal(f.writes, 0);
  assert.equal(f.finish.params[3], 'failed');
  assert.equal(JSON.parse(String(f.finish.params[5])).code, 'CONNECTION_NOT_AUTHORIZED');
});

test('stale worker cannot dispatch after a newer worker reclaimed the lease', async () => {
  const f = fixture({}, { fence: false });
  await runWorkerOnce(f.options);
  assert.equal(f.writes, 0);
  assert.equal(f.calls.filter(c => c.sql.includes('SET status = $4')).length, 0);
});

test('expired deadline fails undispatched work and marks dispatched work uncertain', async () => {
  for (const dispatched of [false, true]) {
    const f = fixture({ deadline_at: new Date(now - 1), dispatch_started_at: dispatched ? new Date(now - 10) : null });
    await runWorkerOnce(f.options);
    assert.equal(f.writes, 0);
    assert.equal(f.reads, 0);
    assert.equal(f.finish.params[3], dispatched ? 'uncertain' : 'failed');
  }
});

test('bounded provider timeout aborts and retains recovery-only marker', async () => {
  const f = fixture();
  let aborted = false;
  f.provider.updateProductTitle = async ({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; });
  });
  await runWorkerOnce(f.options);
  assert.equal(aborted, true);
  assert.equal(f.finish.params[3], 'recovering');
  assert.equal(JSON.parse(String(f.finish.params[5])).code, 'PROVIDER_TIMEOUT');
});

test('malformed durable payload is rejected before provider access', async () => {
  const f = fixture({ payload: { productId: 'gid://shopify/Order/123', title: 'Oak' } });
  await runWorkerOnce(f.options);
  assert.equal(f.writes, 0);
  assert.equal(f.finish.params[3], 'failed');
});

test('claimOperation supports an empty queue without a transaction connection', async () => {
  const f = fixture({}, { empty: true });
  assert.equal(await claimOperation(f.options.pool), null);
});

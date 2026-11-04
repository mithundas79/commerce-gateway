import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../../src/admin.js';
import { buildApi } from '../../src/api.js';
import { releaseUncertainOperation, runWorkerOnce, type OperationProvider } from '../../src/worker.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL ordering tests');
const schema = `ordering_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 16, options: `-c search_path=${schema}` });
const tenantId = randomUUID();
const otherTenant = randomUUID();
const connectionId = randomUUID();
const key = `ordering-${randomUUID()}`;
const productId = 'gid://shopify/Product/123';
const otherProduct = 'gid://shopify/Product/456';
let app: ReturnType<typeof buildApi>;

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => {
  if (app) await app.close();
  await pool.query('TRUNCATE operations, oauth_states, api_keys, connections, tenants CASCADE');
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'FIFO fixture']);
  await pool.query('INSERT INTO api_keys(id,tenant_id,token_hash) VALUES($1,$2,$3)',
    [randomUUID(), tenantId, createHash('sha256').update(key).digest('hex')]);
  await pool.query('INSERT INTO connections(id,tenant_id,shop,token_ciphertext,scopes) VALUES($1,$2,$3,$4,$5)',
    [connectionId, tenantId, 'ordering.myshopify.com', 'fixture-unused', ['read_products', 'write_products']]);
  app = buildApi({ pool, readProducts: async () => ({ products: [], pageInfo: { hasNextPage: false, endCursor: null } }) });
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); }
});

const insertSql = `INSERT INTO operations(id,tenant_id,connection_id,kind,idempotency_key,payload,deadline_at)
  VALUES($1,$2,$3,'product_title_update',$4,$5::jsonb,$6) RETURNING id,queue_sequence`;
const values = (id: string, title: string, product = productId, deadline = new Date(Date.now() + 300_000)) =>
  [id, tenantId, connectionId, id, JSON.stringify({ productId: product, title }), deadline];
async function enqueue(title: string, product = productId, deadline?: Date): Promise<string> {
  const id = randomUUID();
  await pool.query(insertSql, values(id, title, product, deadline));
  return id;
}
async function status(id: string) {
  return (await pool.query('SELECT status,attempt_count FROM operations WHERE id=$1', [id])).rows[0];
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, message = 'Expected worker did not reach test barrier'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5_000);
    })]);
  } finally { clearTimeout(timer!); }
}
const options = (provider: OperationProvider) => ({ pool, provider, timeoutMs: 10_000, leaseMs: 60_000 });

test('same-product writes are FIFO across concurrent workers while another product runs in parallel', async () => {
  const first = await enqueue('Older');
  const second = await enqueue('Newer');
  const independent = await enqueue('Independent', otherProduct);
  const started = deferred();
  const release = deferred();
  const writes: string[] = [];
  let oldFinished = false;
  const provider: OperationProvider = {
    readProductTitle: async () => 'Older',
    updateProductTitle: async context => {
      writes.push(context.title);
      if (context.title === 'Older') { started.resolve(); await release.promise; oldFinished = true; }
      if (context.title === 'Newer') assert.equal(oldFinished, true);
    },
  };
  const original = runWorkerOnce(options(provider));
  try {
    await bounded(started.promise);
    await Promise.all(Array.from({ length: 8 }, () => runWorkerOnce(options(provider))));
    assert.equal((await status(independent)).status, 'succeeded');
    assert.equal((await status(second)).status, 'queued');
    assert.equal((await status(second)).attempt_count, 0);
    assert.deepEqual(writes, ['Older', 'Independent']);
  } finally { release.resolve(); await original; }
  await Promise.all(Array.from({ length: 8 }, () => runWorkerOnce(options(provider))));
  assert.equal((await status(first)).status, 'succeeded');
  assert.equal((await status(second)).status, 'succeeded');
  assert.deepEqual(writes, ['Older', 'Independent', 'Newer']);
});

test('backoff retains the product position without blocking unrelated products or deadlocking retries', async () => {
  const first = await enqueue('Older');
  const second = await enqueue('Newer');
  const independent = await enqueue('Independent', otherProduct);
  const writes: string[] = [];
  let rejected = false;
  const provider: OperationProvider = {
    readProductTitle: async () => 'Older',
    updateProductTitle: async ({ title }) => {
      writes.push(title);
      if (title === 'Older' && !rejected) {
        rejected = true;
        throw { code: 'TRANSIENT', retryable: true, ambiguous: false };
      }
    },
  };
  const worker = { ...options(provider), baseBackoffMs: 60_000 };
  await runWorkerOnce(worker);
  assert.equal((await status(first)).status, 'retry');
  await runWorkerOnce(worker);
  assert.equal((await status(independent)).status, 'succeeded');
  assert.equal(await runWorkerOnce(worker), false);
  assert.equal((await status(second)).attempt_count, 0);
  await pool.query('UPDATE operations SET next_attempt_at=now() WHERE id=$1', [first]);
  await runWorkerOnce(worker);
  await runWorkerOnce(worker);
  assert.deepEqual(writes, ['Older', 'Independent', 'Older', 'Newer']);
  assert.equal((await status(second)).status, 'succeeded');
});

test('reclaimed ambiguous write holds the product through readback before its successor dispatches', async () => {
  const first = await enqueue('Older');
  const second = await enqueue('Newer');
  await pool.query(`UPDATE operations SET status='running',attempt_count=1,fence_token=1,
    lease_until=now()-interval '1 second',dispatch_started_at=now()-interval '2 seconds' WHERE id=$1`, [first]);
  const started = deferred();
  const release = deferred();
  const writes: string[] = [];
  const provider: OperationProvider = {
    readProductTitle: async () => { started.resolve(); await release.promise; return 'Older'; },
    updateProductTitle: async ({ title }) => { writes.push(title); },
  };
  const recovering = runWorkerOnce(options(provider));
  try {
    await bounded(started.promise);
    assert.equal(await runWorkerOnce(options(provider)), false);
    assert.equal((await status(second)).attempt_count, 0);
  } finally { release.resolve(); await recovering; }
  assert.equal((await status(first)).status, 'succeeded');
  await runWorkerOnce(options(provider));
  assert.deepEqual(writes, ['Newer']);
});

test('uncertain outcome blocks the product until tenant-scoped operator acknowledgement', async () => {
  const first = await enqueue('Older');
  const second = await enqueue('Newer');
  await pool.query(`UPDATE operations SET status='running',attempt_count=1,fence_token=1,
    lease_until=now()-interval '1 second',dispatch_started_at=now()-interval '2 seconds' WHERE id=$1`, [first]);
  const writes: string[] = [];
  const provider: OperationProvider = {
    readProductTitle: async () => 'Unconfirmed',
    updateProductTitle: async ({ title }) => { writes.push(title); },
  };
  await runWorkerOnce({ ...options(provider), maxAttempts: 2 });
  assert.equal((await status(first)).status, 'uncertain');
  assert.equal(await runWorkerOnce(options(provider)), false);
  const blocked = await app.inject({ url: `/v1/operations/${second}`, headers: { authorization: `Bearer ${key}` } });
  assert.equal(blocked.statusCode, 200);
  assert.deepEqual(blocked.json().operation.blockedBy, { operationId: first, status: 'uncertain' });
  await enqueue('Independent', otherProduct);
  assert.equal(await runWorkerOnce(options(provider)), true);
  assert.deepEqual(writes, ['Independent']);
  assert.equal(await releaseUncertainOperation(pool, { tenantId: otherTenant, operationId: first }), false);
  assert.equal(await runWorkerOnce(options(provider)), false);
  assert.equal(await releaseUncertainOperation(pool, { tenantId, operationId: first }), true);
  assert.equal(await releaseUncertainOperation(pool, { tenantId, operationId: first }), true);
  assert.equal((await status(first)).status, 'uncertain');
  await runWorkerOnce(options(provider));
  assert.deepEqual(writes, ['Independent', 'Newer']);
  const released = await app.inject({ url: `/v1/operations/${first}`, headers: { authorization: `Bearer ${key}` } });
  assert.ok(released.json().operation.orderingReleasedAt);
  assert.equal(await releaseUncertainOperation(pool, { tenantId, operationId: second }), false);
});

test('blocked waiters expire without writing and an expired head releases the next live operation', async () => {
  const first = await enqueue('Older');
  await pool.query("UPDATE operations SET status='retry',next_attempt_at=now()+interval '1 minute' WHERE id=$1", [first]);
  const expired = await enqueue('Expired follower', productId, new Date(Date.now() - 10_000));
  const writes: string[] = [];
  const provider: OperationProvider = {
    readProductTitle: async () => 'Older',
    updateProductTitle: async ({ title }) => { writes.push(title); },
  };
  await runWorkerOnce(options(provider));
  assert.equal((await status(expired)).status, 'failed');
  assert.equal((await status(first)).status, 'retry');
  assert.deepEqual(writes, []);
  const successor = await enqueue('Live successor');
  await pool.query("UPDATE operations SET deadline_at=now()-interval '1 second',next_attempt_at=now() WHERE id=$1", [first]);
  await runWorkerOnce(options(provider));
  assert.equal((await status(first)).status, 'failed');
  await runWorkerOnce(options(provider));
  assert.equal((await status(successor)).status, 'succeeded');
  assert.deepEqual(writes, ['Live successor']);
});

test('a waiter behind an unresolved uncertain outcome can still expire safely', async () => {
  const first = await enqueue('Older');
  await pool.query("UPDATE operations SET status='uncertain',completed_at=now(),dispatch_started_at=now() WHERE id=$1", [first]);
  const expired = await enqueue('Expired follower', productId, new Date(Date.now() - 10_000));
  let calls = 0;
  const provider: OperationProvider = {
    readProductTitle: async () => { calls++; return 'Unused'; },
    updateProductTitle: async () => { calls++; },
  };
  await runWorkerOnce(options(provider));
  assert.equal((await status(expired)).status, 'failed');
  assert.equal((await status(first)).status, 'uncertain');
  assert.equal(calls, 0);
});

test('concurrent duplicate submissions and committed replays preserve the original sequence', async () => {
  const submit = () => app.inject({ method: 'POST', url: `/v1/connections/${connectionId}/product-title-updates`,
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'duplicate-sequence' },
    payload: { productId, title: 'One operation' } });
  const responses = await Promise.all(Array.from({ length: 24 }, submit));
  assert.ok(responses.every(response => response.statusCode === 202));
  assert.equal(responses.filter(response => response.json().replayed === false).length, 1);
  const row = (await pool.query('SELECT id,queue_sequence FROM operations')).rows[0];
  assert.equal((await pool.query('SELECT last_value FROM operation_queue_sequence')).rows[0].last_value, row.queue_sequence);
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query(`SELECT pg_advisory_xact_lock(hashtextextended('operation-product:' ||
      jsonb_build_array($1::uuid,$2::uuid,'product_title_update',$3::text)::text,0))`, [tenantId, connectionId, productId]);
    assert.equal((await bounded(submit(), 'Committed replay unnecessarily waited for the resource lock')).statusCode, 202);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  assert.equal((await pool.query('SELECT last_value FROM operation_queue_sequence')).rows[0].last_value, row.queue_sequence);
});

test('an uncommitted earlier enqueue prevents a later same-product position from becoming visible', async () => {
  const first = randomUUID();
  const second = randomUUID();
  const original = await pool.connect();
  const later = await pool.connect();
  let laterInsert: Promise<unknown> | undefined;
  try {
    await original.query('BEGIN');
    await original.query(insertSql, values(first, 'Older'));
    const pid = (await later.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    laterInsert = later.query(insertSql, values(second, 'Newer'));
    await bounded((async () => {
      while (!(await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted`, [pid])).rows.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })(), 'Later enqueue did not wait for the earlier product transaction');
    const provider: OperationProvider = { readProductTitle: async () => 'Unused', updateProductTitle: async () => { throw new Error('No operation should be visible'); } };
    assert.equal(await runWorkerOnce(options(provider)), false);
    await original.query('COMMIT');
    await laterInsert;
    const ordered = (await pool.query('SELECT id FROM operations ORDER BY queue_sequence')).rows.map(row => row.id);
    assert.deepEqual(ordered, [first, second]);
  } finally {
    await original.query('ROLLBACK');
    await laterInsert?.catch(() => undefined);
    original.release(); later.release();
  }
});

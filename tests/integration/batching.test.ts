import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { bootstrap, migrate } from '../../src/admin.js';
import { buildApi } from '../../src/api.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL batching tests');

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const schema = `batching_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 24 });
  let app: ReturnType<typeof buildApi> | undefined;
  try {
    await migrate(pool);
    const tenant = randomUUID();
    const connection = randomUUID();
    const apiKey = `batching-${randomUUID()}`;
    await bootstrap(pool, { TENANT_ID: tenant, API_KEY: apiKey });
    await pool.query(`INSERT INTO connections(id,tenant_id,shop,token_ciphertext,scopes)
      VALUES($1,$2,'batching.myshopify.com','unused',ARRAY['write_products'])`, [connection, tenant]);
    const started = barrier();
    const first = barrier();
    const commit = barrier();
    const state = { first: true, lookups: 0, commits: 0, inserts: 0, waitingCommit: false, holdCommit: false, failBatch: false, locks: 0 };
    const tracked = {
      async query(sql: string, values: unknown[]) {
        if (sql.startsWith('INSERT INTO operations') && state.first) {
          state.first = false;
          started.release();
          await first.promise;
        }
        const result = await pool.query(sql, values);
        if (sql.includes('FROM operations WHERE tenant_id = $1') && sql.includes('idempotency_key = $3')) state.lookups++;
        return result;
      },
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values: unknown[]) {
            if (sql === 'SELECT pg_advisory_xact_lock($1::bigint)') state.locks++;
            if (sql === 'COMMIT') {
              state.waitingCommit = true;
              if (state.holdCommit) await commit.promise;
              state.commits++;
            }
            const result = await client.query(sql, values);
            if (sql.startsWith('INSERT INTO operations')) {
              state.inserts++;
              if (state.failBatch && state.inserts === 2) throw new Error('Injected batch rollback');
            }
            return result;
          },
          release: (broken: boolean) => client.release(broken),
        };
      },
    } as unknown as Pool;
    app = buildApi({ pool: tracked, readProducts: async () => { throw new Error('Enqueue must not call Shopify'); } });
    const activeApp = app;
    const submit = (key: string, title = key, productId = 'gid://shopify/Product/123') => activeApp.inject({
      method: 'POST', url: `/v1/connections/${connection}/product-title-updates`,
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key }, payload: { productId, title },
    }).then(response => response);
    async function accumulate(entries: Array<[string, string?]>) {
      const head = submit('immediate');
      await until(() => !state.first, 'The first enqueue did not start immediately');
      const rest: ReturnType<typeof submit>[] = [];
      // HTTP authorization and replay lookups can finish out of submission order.
      // Admit each waiter before the next, keeping every response blocked behind the head.
      for (const [key, title] of entries) {
        rest.push(submit(key, title));
        await until(() => state.lookups >= rest.length, 'Concurrent enqueues did not accumulate');
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return { head, rest };
    }
    return { pool, tenant, connection, state, first, commit, submit, accumulate,
      close: async () => { first.release(); commit.release(); await activeApp.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
  } catch (error) {
    await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error;
  }
}

test('an immediate enqueue drains accumulated arrivals into one durable bounded commit with individual replay/conflict responses', async () => {
  const f = await fixture();
  try {
    f.state.holdCommit = true;
    const { head, rest } = await f.accumulate([['one'], ['two'], ['one'], ['one', 'changed'], ['three']]);
    let acknowledged = 0;
    for (const response of rest) void response.then(() => { acknowledged++; });
    f.first.release();
    assert.equal((await head).statusCode, 202);
    await until(() => f.state.waitingCommit, 'The accumulated batch did not reach commit');
    assert.equal(acknowledged, 0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM operations')).rows[0].n, 1);
    f.commit.release();
    const responses = await Promise.all(rest);
    assert.deepEqual(responses.map(response => response.statusCode), [202, 202, 202, 409, 202]);
    assert.equal(responses[0].json().replayed, false);
    assert.equal(responses[2].json().replayed, true);
    assert.equal(responses[0].json().operation.id, responses[2].json().operation.id);
    assert.equal(f.state.commits, 1);
    const rows = (await f.pool.query(`SELECT idempotency_key,extract(epoch FROM deadline_at-created_at)::int AS ttl
      FROM operations ORDER BY queue_sequence`)).rows;
    assert.deepEqual(rows.map(row => row.idempotency_key), ['immediate', 'one', 'two', 'three']);
    assert.ok(rows.every(row => row.ttl === 900));
  } finally { await f.close(); }
});

test('unexpected batch failure rolls back every accumulated row without acknowledging work and replay can safely retry', async () => {
  const f = await fixture();
  try {
    f.state.failBatch = true;
    const { head, rest } = await f.accumulate([['rollback-one'], ['rollback-two'], ['rollback-three']]);
    f.first.release();
    assert.equal((await head).statusCode, 202);
    assert.ok((await Promise.all(rest)).every(response => response.statusCode === 500));
    assert.deepEqual((await f.pool.query('SELECT idempotency_key FROM operations')).rows.map(row => row.idempotency_key), ['immediate']);
    f.state.failBatch = false;
    const retried = await f.submit('rollback-one');
    assert.equal(retried.statusCode, 202);
    assert.equal(retried.json().replayed, false);
  } finally { await f.close(); }
});

test('a hold installed after request authorization prevents every accumulated enqueue', async () => {
  const f = await fixture();
  try {
    const { head, rest } = await f.accumulate([['held-one'], ['held-two']]);
    await f.pool.query('UPDATE connections SET lifecycle_hold=true WHERE id=$1', [f.connection]);
    f.first.release();
    assert.ok((await Promise.all([head, ...rest])).every(response => response.statusCode === 404));
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM operations')).rows[0].n, 0);
    assert.equal((await f.pool.query('SELECT lifecycle_hold FROM connections')).rows[0].lifecycle_hold, true);
  } finally { await f.close(); }
});

test('upfront idempotency locks let a separate writer finish before the batch takes its product lock', async () => {
  const f = await fixture();
  const independent = await f.pool.connect();
  try {
    await independent.query('BEGIN');
    await independent.query(`SELECT pg_advisory_xact_lock(hashtextextended('operation-idempotency:' ||
      jsonb_build_array($1::uuid,$2::uuid,'product_title_update','separate-writer')::text,0))`, [f.tenant, f.connection]);
    const { head, rest } = await f.accumulate([['batch-first'], ['separate-writer']]);
    f.first.release();
    assert.equal((await head).statusCode, 202);
    await until(() => f.state.locks > 0, 'The batch did not acquire upfront idempotency locks');
    assert.equal(f.state.inserts, 0);
    await independent.query(`SET LOCAL statement_timeout='3s'`);
    await independent.query(`INSERT INTO operations(id,tenant_id,connection_id,kind,idempotency_key,payload,deadline_at)
      VALUES($1,$2,$3,'product_title_update','separate-writer','{"productId":"gid://shopify/Product/123","title":"separate-writer"}',now()+interval '15 minutes')`, [randomUUID(), f.tenant, f.connection]);
    await independent.query('COMMIT');
    const responses = await Promise.all(rest);
    assert.ok(responses.every(response => response.statusCode === 202));
    assert.equal(responses[1].json().replayed, true);
    assert.deepEqual((await f.pool.query('SELECT idempotency_key FROM operations ORDER BY queue_sequence')).rows.map(row => row.idempotency_key), ['immediate', 'separate-writer', 'batch-first']);
  } finally { await independent.query('ROLLBACK'); independent.release(); await f.close(); }
});

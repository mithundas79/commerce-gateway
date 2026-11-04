import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { buildApi } from '../../src/api.js';
import { migrate } from '../../src/admin.js';
import { runWorkerOnce, type OperationProvider, type ProductContext } from '../../src/worker.js';
import { ShopifyConnector } from '../../src/shopify.js';
import { configureNotificationEndpoint } from '../../src/notifications.js';

// An explicitly invoked integration run must fail when PostgreSQL is unavailable.
// No SQL emulator can establish SKIP LOCKED, unique constraint or lease behavior.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL integration tests');
const schema = `qa_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 32, options: `-c search_path=${schema}` });
let tenantA: string;
let tenantB: string;
let connectionA: string;
let connectionB: string;
let keyA: string;
let keyB: string;
let app: ReturnType<typeof buildApi>;
const productId = 'gid://shopify/Product/123';

function shopifyHttpFixture(options: { readTitle?: string; shop?: string; writeStatus?: number; onWrite?: () => Promise<void> | void } = {}) {
  const counts = { reads: 0, writes: 0 };
  const connector = new ShopifyConnector({ fetch: async (url, init) => {
    assert.equal(String(url), `https://${options.shop ?? 'qa-a.myshopify.com'}/admin/api/2026-10/graphql.json`);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    const product = { id: productId, title: options.readTitle ?? 'Updated title', updatedAt: '2026-01-01T00:00:00Z' };
    let data;
    if (body.query.includes('mutation ProductTitleUpdate')) {
      counts.writes++;
      if (options.writeStatus) return new Response('{}', { status: options.writeStatus,
        headers: { 'retry-after': '60', 'x-shopify-api-version': '2026-10' } });
      assert.deepEqual(body.variables, { product: { id: productId, title: 'Updated title' } });
      await options.onWrite?.();
      data = { productUpdate: { product: { ...product, title: 'Updated title' }, userErrors: [] } };
    } else {
      counts.reads++;
      assert.deepEqual(body.variables, { id: productId });
      data = { product };
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json', 'x-shopify-api-version': '2026-10' } });
  } });
  const credentials = async (context: ProductContext) => {
    const row = (await pool.query('SELECT shop FROM connections WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL',
      [context.tenantId, context.connectionId])).rows[0];
    assert.ok(row, 'Provider context must resolve within its own tenant');
    return { ...context, shop: row.shop, accessToken: 'fixture-access-token' };
  };
  const provider: OperationProvider = {
    readProductTitle: async (context) => (await connector.readProductTitle(await credentials(context)))?.title ?? null,
    updateProductTitle: async (context) => connector.updateProductTitle({ ...await credentials(context), title: context.title }),
  };
  return { provider, counts };
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});

beforeEach(async () => {
  if (app) await app.close();
  await pool.query('TRUNCATE operations, oauth_states, api_keys, connections, tenants CASCADE');
  tenantA = randomUUID(); tenantB = randomUUID();
  connectionA = randomUUID(); connectionB = randomUUID();
  keyA = `qa-a-${randomUUID()}`; keyB = `qa-b-${randomUUID()}`;
  for (const [tenant, connection, key, shop] of [
    [tenantA, connectionA, keyA, 'qa-a.myshopify.com'],
    [tenantB, connectionB, keyB, 'qa-b.myshopify.com'],
  ]) {
    await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, 'QA fixture']);
    await pool.query('INSERT INTO api_keys(id,tenant_id,token_hash) VALUES($1,$2,$3)',
      [randomUUID(), tenant, createHash('sha256').update(key).digest('hex')]);
    await pool.query('INSERT INTO connections(id,tenant_id,shop,token_ciphertext,scopes) VALUES($1,$2,$3,$4,$5)',
      [connection, tenant, shop, 'test-only-encrypted-placeholder', ['read_products', 'write_products']]);
  }
  const products = new ShopifyConnector({ fetch: async (url, init) => {
    assert.equal(String(url), 'https://qa-a.myshopify.com/admin/api/2026-10/graphql.json');
    assert.equal(JSON.parse(String(init?.body)).variables.first, 3);
    return new Response(JSON.stringify({ data: { products: {
      nodes: [{ id: productId, title: 'Fixture', updatedAt: '2026-01-01T00:00:00Z' }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } }), { headers: { 'x-shopify-api-version': '2026-10' } });
  } });
  app = buildApi({ pool, readProducts: async (connection, options) => {
    assert.equal(connection.tenant_id, tenantA);
    assert.equal(connection.id, connectionA);
    assert.equal(options.first, 3);
    return products.listProducts({ shop: connection.shop, accessToken: 'fixture-access-token', ...options });
  } });
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { await admin.end(); }
});

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const enqueue = (key = keyA, connection = connectionA, idempotencyKey = 'request-1', title = 'Updated title') => app.inject({
  method: 'POST', url: `/v1/connections/${connection}/product-title-updates`,
  headers: { ...auth(key), 'idempotency-key': idempotencyKey }, payload: { productId, title },
});

test('health, authentication and product reads use real database authorization', async () => {
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  assert.equal((await app.inject('/readyz')).statusCode, 200);
  assert.equal((await app.inject('/v1/connections')).statusCode, 401);
  const response = await app.inject({ url: `/v1/connections/${connectionA}/products?first=3`, headers: auth(keyA) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().products[0].id, productId);
  await pool.query('UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1', [tenantA]);
  assert.equal((await app.inject({ url: '/v1/connections', headers: auth(keyA) })).statusCode, 401);
});

test('tenant boundaries apply to connections, products, writes and operation IDs', async () => {
  const listed = await app.inject({ url: '/v1/connections', headers: auth(keyA) });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().connections.map((row: { id: string }) => row.id), [connectionA]);
  assert.ok(!listed.body.includes('token_ciphertext'));
  assert.ok(!listed.body.includes('test-only-encrypted-placeholder'));
  assert.equal((await app.inject({ url: `/v1/connections/${connectionB}/products`, headers: auth(keyA) })).statusCode, 404);
  assert.equal((await enqueue(keyA, connectionB)).statusCode, 404);
  const own = await enqueue();
  assert.equal(own.statusCode, 202);
  assert.equal((await app.inject({ url: own.headers.location as string, headers: auth(keyB) })).statusCode, 404);
  await assert.rejects(pool.query(
    `INSERT INTO operations(id,tenant_id,connection_id,kind,idempotency_key,payload,deadline_at)
     VALUES($1,$2,$3,'product_title_update','illegal','{}',now()+interval '1 minute')`,
    [randomUUID(), tenantA, connectionB]), (error: unknown) => (error as { code: string }).code === '23503');
});

test('24 concurrent equal requests create exactly one durable operation; changed payload conflicts', async () => {
  const responses = await Promise.all(Array.from({ length: 24 }, () => enqueue()));
  assert.ok(responses.every((response) => response.statusCode === 202));
  assert.equal(new Set(responses.map((response) => response.json().operation.id)).size, 1);
  assert.equal(responses.filter((response) => !response.json().replayed).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM operations')).rows[0].count, 1);
  assert.equal((await enqueue(keyA, connectionA, 'request-1', 'Conflicting title')).statusCode, 409);
  const other = await enqueue(keyB, connectionB);
  assert.equal(other.statusCode, 202);
  assert.notEqual(other.json().operation.id, responses[0].json().operation.id);
});

test('revoked connections and invalid mutation input cannot enter the queue', async () => {
  assert.equal((await enqueue(keyA, connectionA, 'request-1', ' ')).statusCode, 400);
  assert.equal((await enqueue(keyA, connectionA, 'request-1', 'x'.repeat(256))).statusCode, 400);
  await pool.query('UPDATE connections SET revoked_at=now() WHERE id=$1', [connectionA]);
  assert.equal((await enqueue()).statusCode, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM operations')).rows[0].count, 0);
});

test('parallel workers claim a queued mutation once and persist the result across API restart', async () => {
  const submitted = await enqueue();
  const id = submitted.json().operation.id;
  const { provider, counts } = shopifyHttpFixture({ onWrite: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); } });
  await Promise.all(Array.from({ length: 8 }, () => runWorkerOnce({ pool, provider })));
  assert.equal(counts.writes, 1);
  assert.equal((await pool.query('SELECT status FROM operations WHERE id=$1', [id])).rows[0].status, 'succeeded');
  await app.close();
  app = buildApi({ pool, readProducts: async () => { throw new Error('unused'); } });
  const response = await app.inject({ url: `/v1/operations/${id}`, headers: auth(keyA) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().operation.status, 'succeeded');
  assert.equal((await enqueue()).json().operation.id, id);
  assert.equal(counts.writes, 1);
});

test('expired dispatched leases reconcile a committed write without dispatching again', async () => {
  const id = (await enqueue()).json().operation.id;
  await pool.query(`UPDATE operations SET status='running',attempt_count=1,fence_token=1,
    lease_until=now()-interval '1 second',dispatch_started_at=now()-interval '2 seconds' WHERE id=$1`, [id]);
  const { provider, counts } = shopifyHttpFixture();
  await runWorkerOnce({ pool, provider });
  assert.equal(counts.reads, 1);
  assert.equal(counts.writes, 0);
  assert.equal((await pool.query('SELECT status FROM operations WHERE id=$1', [id])).rows[0].status, 'succeeded');
});

test('expired dispatched lease with different readback becomes uncertain without a second write', async () => {
  const id = (await enqueue()).json().operation.id;
  await pool.query(`UPDATE operations SET status='running',attempt_count=1,fence_token=1,
    lease_until=now()-interval '1 second',dispatch_started_at=now()-interval '2 seconds' WHERE id=$1`, [id]);
  const { provider, counts } = shopifyHttpFixture({ readTitle: 'A different title' });
  await runWorkerOnce({ pool, provider, maxAttempts: 2 });
  assert.equal((await pool.query('SELECT status FROM operations WHERE id=$1', [id])).rows[0].status, 'uncertain');
  await runWorkerOnce({ pool, provider });
  assert.equal(counts.writes, 0);
});

test('a reclaimed lease fences a late completion from the original worker', async () => {
  const id = (await enqueue()).json().operation.id;
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const { provider, counts } = shopifyHttpFixture({ readTitle: 'Original title', onWrite: async () => {
    writeStarted();
    await released;
  } });
  const original = runWorkerOnce({ pool, provider });
  try {
    await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Mutation did not start')), 2000))]);
    await pool.query("UPDATE operations SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
    await runWorkerOnce({ pool, provider });
    releaseWrite();
    await original;
    const row = (await pool.query('SELECT status,fence_token,result FROM operations WHERE id=$1', [id])).rows[0];
    assert.equal(row.status, 'recovering');
    assert.equal(String(row.fence_token), '2');
    assert.equal(row.result, null);
    assert.equal(counts.writes, 1);
    assert.equal(counts.reads, 1);
  } finally {
    releaseWrite();
    await original;
  }
});

test('terminal operation commits create one tenant-scoped immutable notification in the same transaction', async () => {
  await configureNotificationEndpoint(pool, {
    tenantId: tenantA, url: 'https://hooks.merchant-domain.com/events', secretCiphertext: 'encrypted-test-placeholder',
  });
  const idA = (await enqueue()).json().operation.id;
  const idB = (await enqueue(keyB, connectionB)).json().operation.id;
  const transaction = await pool.connect();
  try {
    await transaction.query('BEGIN');
    await transaction.query("UPDATE operations SET status='succeeded',completed_at=now() WHERE id=$1", [idA]);
    assert.equal((await transaction.query('SELECT count(*)::int AS count FROM notification_events')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM notification_events')).rows[0].count, 0);
    await transaction.query('ROLLBACK');
  } finally { transaction.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM notification_events')).rows[0].count, 0);
  await pool.query("UPDATE operations SET status='succeeded',completed_at=now() WHERE id=ANY($1::uuid[])", [[idA, idB]]);
  await pool.query("UPDATE operations SET status='succeeded' WHERE id=$1", [idA]);
  const events = (await pool.query('SELECT * FROM notification_events')).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].tenant_id, tenantA);
  assert.equal(events[0].operation_id, idA);
  assert.equal(JSON.parse(events[0].body).data.operationId, idA);
  for (const field of ['body', 'endpoint_url', 'secret_ciphertext']) {
    await assert.rejects(pool.query(`UPDATE notification_events SET ${field}=$1 WHERE id=$2`, ['mutated', events[0].id]),
      /immutable/);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM notification_events')).rows[0].count, 1);
});

test('Shopify Retry-After blocks later jobs on the same connection while another tenant can progress', async () => {
  await enqueue();
  const { provider, counts } = shopifyHttpFixture({ writeStatus: 429 });
  await runWorkerOnce({ pool, provider });
  assert.equal(counts.writes, 1);
  const later = (await enqueue(keyA, connectionA, 'later-request')).json().operation.id;
  assert.equal(await runWorkerOnce({ pool, provider }), false);
  assert.equal(counts.writes, 1);
  const otherId = (await enqueue(keyB, connectionB)).json().operation.id;
  const other = shopifyHttpFixture({ shop: 'qa-b.myshopify.com' });
  assert.equal(await runWorkerOnce({ pool, provider: other.provider }), true);
  assert.equal(other.counts.writes, 1);
  assert.equal((await pool.query('SELECT status FROM operations WHERE id=$1', [otherId])).rows[0].status, 'succeeded');
  await pool.query('UPDATE connections SET worker_not_before=now() WHERE id=$1', [connectionA]);
  const unblocked = shopifyHttpFixture();
  assert.equal(await runWorkerOnce({ pool, provider: unblocked.provider }), true);
  assert.equal((await pool.query('SELECT status FROM operations WHERE id=$1', [later])).rows[0].status, 'succeeded');
  assert.equal(unblocked.counts.writes, 1);
});

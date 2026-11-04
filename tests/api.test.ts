import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { buildApi, getTenantId, type Connection, type ProductPage } from '../src/api.js';
import { ConnectorError } from '../src/shopify.js';

const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '10000000-0000-4000-8000-000000000002';
const connectionA = '20000000-0000-4000-8000-000000000001';
const connectionB = '20000000-0000-4000-8000-000000000002';
const keyA = 'test_api_key_for_tenant_a';
const keyB = 'test_api_key_for_tenant_b';
const auth = (key = keyA) => ({ authorization: `Bearer ${key}` });
const payload = { productId: 'gid://shopify/Product/123', title: 'New product title' };
const page: ProductPage = { products: [{ id: payload.productId, title: 'Current title', updatedAt: '2026-11-04T00:00:00Z' }], pageInfo: { hasNextPage: false, endCursor: null } };

function fixture() {
  const hashes = new Map([[createHash('sha256').update(keyA).digest('hex'), tenantA], [createHash('sha256').update(keyB).digest('hex'), tenantB]]);
  const connections: Connection[] = [
    { id: connectionA, tenant_id: tenantA, shop: 'alpha.myshopify.com', scopes: ['read_products', 'write_products'], created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' },
    { id: connectionB, tenant_id: tenantB, shop: 'beta.myshopify.com', scopes: ['read_products'], created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' },
  ];
  const operations: Array<Record<string, any>> = [];
  const queries: Array<{ sql: string; values: any[] }> = [];
  let unavailable = false;
  const pool = {
    async query(sql: string, values: any[] = []) {
      queries.push({ sql, values });
      if (unavailable) throw new Error('database password=do-not-leak');
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM api_keys')) {
        assert.match(sql, /token_hash = \$1 AND revoked_at IS NULL/);
        assert.match(values[0], /^[a-f0-9]{64}$/);
        return { rows: hashes.has(values[0]) ? [{ tenant_id: hashes.get(values[0]) }] : [] };
      }
      if (sql.startsWith('INSERT INTO operations')) {
        assert.match(sql, /FROM connections WHERE tenant_id = \$2 AND id = \$3 AND revoked_at IS NULL/);
        assert.match(sql, /ON CONFLICT \(tenant_id, connection_id, kind, idempotency_key\) DO NOTHING/);
        assert.equal(values[5], 900000);
        if (!connections.some((c) => c.tenant_id === values[1] && c.id === values[2])) return { rows: [] };
        if (operations.some((o) => o.tenant_id === values[1] && o.connection_id === values[2] && o.idempotency_key === values[3])) return { rows: [] };
        const row = { id: values[0], tenant_id: values[1], connection_id: values[2], idempotency_key: values[3], kind: 'product_title_update', payload: JSON.parse(values[4]), status: 'queued', attempt_count: 0, result: null, error: null, created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z', completed_at: null };
        operations.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM connections')) {
        assert.match(sql, /WHERE tenant_id = \$1/);
        assert.match(sql, /revoked_at IS NULL/);
        if (sql.includes('ORDER BY id DESC')) return { rows: connections.filter((c) => c.tenant_id === values[0] && (!values[1] || c.id < values[1]))
          .sort((a,b) => b.id.localeCompare(a.id)).slice(0,values[2]) };
        return { rows: connections.filter((c) => c.tenant_id === values[0] && (!values[1] || c.id === values[1])) };
      }
      if (sql.includes('FROM operations')) {
        assert.match(sql, /WHERE tenant_id = \$1/);
        return { rows: operations.filter((o) => o.tenant_id === values[0] && (sql.includes('idempotency_key = $3') ? o.connection_id === values[1] && o.idempotency_key === values[2] : o.id === values[1])) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const reads: Array<{ connection: Connection; options: { first: number; after?: string } }> = [];
  const app = buildApi({ pool, readProducts: async (connection, options) => { reads.push({ connection, options }); return page; } });
  return { app, pool, connections, operations, queries, reads, hashes, unavailable: () => { unavailable = true; } };
}

test('health and readiness differ when the database is unavailable', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  assert.equal((await f.app.inject('/healthz')).statusCode, 200);
  assert.equal((await f.app.inject('/readyz')).statusCode, 200);
  f.unavailable();
  assert.equal((await f.app.inject('/healthz')).statusCode, 200);
  const response = await f.app.inject('/readyz');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'unavailable' });
});

test('authentication hashes bearer keys and rejects unknown, missing, and revoked keys', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  for (const headers of [{}, auth('unknown'), { authorization: 'Basic test' }, { authorization: 'Bearer a b' }]) {
    const response = await f.app.inject({ url: '/v1/connections', headers });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
  assert.equal((await f.app.inject({ url: '/v1/connections', headers: auth() })).statusCode, 200);
  f.hashes.delete(createHash('sha256').update(keyA).digest('hex'));
  assert.equal((await f.app.inject({ url: '/v1/connections', headers: auth() })).statusCode, 401);
  assert.ok(f.queries.every((q) => !q.values.includes(keyA) && !q.values.includes(keyB)));
});

test('connection reads are tenant scoped and omit all encrypted credentials', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  const response = await f.app.inject({ url: '/v1/connections', headers: auth() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().connections.length, 1);
  assert.equal(response.json().connections[0].id, connectionA);
  assert.doesNotMatch(response.body, /secret-|token_ciphertext|tenant_id|beta/);
});

test('product reads pass a tenant scoped connection and bounded cursor to the connector', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  const response = await f.app.inject({ url: `/v1/connections/${connectionA}/products?first=7&after=cursor`, headers: auth() });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), page);
  assert.deepEqual(f.reads[0].options, { first: 7, after: 'cursor' });
  assert.equal(f.reads[0].connection.tenant_id, tenantA);
  assert.equal((await f.app.inject({ url: `/v1/connections/${connectionB}/products`, headers: auth() })).statusCode, 404);
  assert.equal(f.reads.length, 1);
  for (const query of ['first=0', 'first=101', 'first=1.1', 'first=1&first=2', 'after=' + 'a'.repeat(2049), 'unknown=true']) {
    assert.equal((await f.app.inject({ url: `/v1/connections/${connectionA}/products?${query}`, headers: auth() })).statusCode, 400, query);
  }
  assert.equal(f.reads.length, 1);
});

test('title updates persist once, replay identical requests, and reject conflicting payloads', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  const request = { method: 'POST' as const, url: `/v1/connections/${connectionA}/product-title-updates`, headers: { ...auth(), 'idempotency-key': 'change-123' }, payload };
  const first = await f.app.inject(request);
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().replayed, false);
  assert.equal(first.json().operation.status, 'queued');
  assert.equal(first.headers.location, `/v1/operations/${first.json().operation.id}`);
  assert.doesNotMatch(first.body, /tenant_id|secret-|idempotency_key|payload|fence_token/);
  const repeat = await f.app.inject(request);
  assert.equal(repeat.statusCode, 202);
  assert.equal(repeat.json().replayed, true);
  assert.equal(repeat.json().operation.id, first.json().operation.id);
  const conflict = await f.app.inject({ ...request, payload: { ...payload, title: 'Different title' } });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), { error: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.app.inject({ ...request, payload: { ...payload, productId: 'gid://shopify/Product/456' } })).statusCode, 409);
  assert.equal(f.operations.length, 1);
  assert.deepEqual(f.operations[0].payload, payload);
});

test('write validation rejects malformed bodies and missing or invalid idempotency keys before enqueue', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  const url = `/v1/connections/${connectionA}/product-title-updates`;
  for (const body of [{ ...payload, title: '' }, { ...payload, title: '  ' }, { ...payload, title: 'x'.repeat(256) }, { ...payload, title: '🌳'.repeat(128) }, { ...payload, title: 42 }, { ...payload, productId: '123' }, { ...payload, extra: true }, { title: 'missing product' }]) {
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { ...auth(), 'idempotency-key': 'valid' }, payload: body })).statusCode, 400);
  }
  for (const key of [undefined, 'with spaces', 'x'.repeat(129)]) {
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { ...auth(), ...(key === undefined ? {} : { 'idempotency-key': key }) }, payload })).statusCode, 400);
  }
  assert.equal((await f.app.inject({ method: 'POST', url, headers: { ...auth(), 'idempotency-key': 'valid' }, payload: { ...payload, title: 'x'.repeat(17000) } })).statusCode, 413);
  assert.equal(f.operations.length, 0);
});

test('cross tenant writes and operation status reads cannot access another tenant', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  const write = await f.app.inject({ method: 'POST', url: `/v1/connections/${connectionA}/product-title-updates`, headers: { ...auth(), 'idempotency-key': 'shared-key' }, payload });
  const id = write.json().operation.id;
  assert.equal((await f.app.inject({ method: 'POST', url: `/v1/connections/${connectionA}/product-title-updates`, headers: { ...auth(keyB), 'idempotency-key': 'shared-key' }, payload })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `/v1/operations/${id}`, headers: auth(keyB) })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `/v1/operations/${id}`, headers: auth() })).statusCode, 200);
  const independent = await f.app.inject({ method: 'POST', url: `/v1/connections/${connectionB}/product-title-updates`, headers: { ...auth(keyB), 'idempotency-key': 'shared-key' }, payload });
  assert.equal(independent.statusCode, 202);
  assert.equal(independent.json().replayed, false);
  assert.equal(f.operations.length, 2);
});

test('database and provider failures do not expose internal errors or credentials', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  f.unavailable();
  const database = await f.app.inject({ url: '/v1/connections', headers: auth() });
  assert.equal(database.statusCode, 500);
  assert.deepEqual(database.json(), { error: 'INTERNAL_ERROR' });
  const app = buildApi({ pool: { query: async (sql: string) => {
    if (sql.includes('api_keys')) return { rows: [{ tenant_id: tenantA }] };
    return { rows: [{ id: connectionA, tenant_id: tenantA, token_ciphertext: 'secret' }] };
  } } as unknown as Pool, readProducts: async () => { throw new Error('access_token=secret'); } });
  t.after(() => app.close());
  const provider = await app.inject({ url: `/v1/connections/${connectionA}/products`, headers: auth() });
  assert.equal(provider.statusCode, 502);
  assert.deepEqual(provider.json(), { error: 'PROVIDER_UNAVAILABLE', retryable: true });
});

test('additional routes inherit authentication and receive the verified tenant', async (t) => {
  const f = fixture(); t.after(() => f.app.close());
  f.app.get('/v1/example', async (request) => ({ tenantId: getTenantId(request) }));
  assert.equal((await f.app.inject('/v1/example')).statusCode, 401);
  assert.deepEqual((await f.app.inject({ url: '/v1/example', headers: auth() })).json(), { tenantId: tenantA });
});

test('public OAuth callbacks can be registered without exposing protected routes', async (t) => {
  const app = buildApi({ pool: { query: async () => { throw new Error('Should not query authentication'); } } as unknown as Pool,
    readProducts: async () => page, publicRoutes: ['/oauth/callback'] });
  t.after(() => app.close());
  app.get('/oauth/callback', async () => ({ received: true }));
  assert.equal((await app.inject('/oauth/callback?code=secret')).statusCode, 200);
  assert.equal((await app.inject('/v1/connections')).statusCode, 401);
});

test('connection keyset pagination traverses more than 100 tenant connections without omissions or foreign rows', async (t) => {
  const f=fixture();t.after(() => f.app.close());
  for(let i=2;i<=151;i++) f.connections.push({...f.connections[0],id:`21000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`});
  let cursor:string|undefined;const ids:string[]=[];
  do {
    const response=await f.app.inject({url:'/v1/connections?first=100'+(cursor?`&after=${cursor}`:''),headers:auth()});
    assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
    const body=response.json();ids.push(...body.connections.map((c:any) => c.id));
    cursor=body.pageInfo.hasNextPage?body.pageInfo.endCursor:undefined;
  } while(cursor);
  assert.equal(ids.length,151);assert.equal(new Set(ids).size,151);assert.equal(ids.includes(connectionB),false);
  for(const query of ['first=0','first=101','after=invalid','unknown=x']) assert.equal((await f.app.inject({url:`/v1/connections?${query}`,headers:auth()})).statusCode,400);
});

test('product error responses distinguish merchant reapproval, permissions, throttling and transient retries', async (t) => {
  for(const scenario of [
    {error:new ConnectorError('AUTHENTICATION','secret upstream detail',401),status:409,code:'CONNECTION_REAUTHORIZATION_REQUIRED',retryable:false},
    {error:new ConnectorError('PERMISSION','secret upstream detail',403),status:403,code:'CONNECTION_PERMISSION_REQUIRED',retryable:false},
    {error:new ConnectorError('RATE_LIMITED','secret upstream detail',429,true,false,2500),status:429,code:'PROVIDER_RATE_LIMITED',retryable:true,retryAfter:'3'},
    {error:new ConnectorError('TRANSIENT','secret upstream detail',503,true),status:503,code:'PROVIDER_UNAVAILABLE',retryable:true,retryAfter:'1'},
    {error:new ConnectorError('API_VERSION_MISMATCH','secret upstream detail'),status:502,code:'PROVIDER_API_VERSION_MISMATCH',retryable:false},
  ]) {
    const f=fixture();t.after(() => f.app.close());
    const app=buildApi({pool:f.pool,readProducts:async() => {throw scenario.error;}});t.after(() => app.close());
    const response=await app.inject({url:`/v1/connections/${connectionA}/products`,headers:auth()});
    assert.equal(response.statusCode,scenario.status);assert.equal(response.json().error,scenario.code);
    assert.equal(response.json().retryable,scenario.retryable);assert.doesNotMatch(response.body,/secret upstream detail/);
    if(scenario.retryAfter) assert.equal(response.headers['retry-after'],scenario.retryAfter);
  }
});

test('structured request logs redact OAuth callback URLs, codes, state, bearer values and cookies', async (t) => {
  const lines:string[]=[];
  const app=buildApi({pool:{query:async() => {throw new Error('Public callback must not authenticate');}} as unknown as Pool,
    readProducts:async() => page,logger:true,loggerStream:{write:line => {lines.push(line);}},publicRoutes:['/oauth/shopify/callback']});
  t.after(() => app.close());
  app.get('/oauth/shopify/callback',async() => ({received:true}));
  const response=await app.inject({url:'/oauth/shopify/callback?code=raw-sensitive-code&state=raw-sensitive-state',
    headers:{authorization:'Bearer raw-sensitive-bearer',cookie:'session=raw-sensitive-cookie'}});
  assert.equal(response.statusCode,200);assert.ok(lines.length>=2,'Actual incoming and completed request log lines are captured');
  const logs=lines.join('');
  assert.match(logs,/incoming request/);assert.match(logs,/request completed/);
  for(const value of ['raw-sensitive-code','raw-sensitive-state','raw-sensitive-bearer','raw-sensitive-cookie','/oauth/shopify/callback']) {
    assert.equal(logs.includes(value),false,`Sensitive log value: ${value}`);
  }
  assert.ok(lines.some(line => JSON.parse(line).req?.url==='[Redacted]'));
});

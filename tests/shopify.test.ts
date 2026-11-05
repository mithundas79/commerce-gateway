import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorError, ShopifyConnector, validateShop } from '../src/shopify.js';

const credentials = { shop: 'demo.myshopify.com', accessToken: 'secret-token' };
const item = { id: 'gid://shopify/Product/12', title: 'New title', updatedAt: '2026-11-04T12:00:00Z' };
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'x-shopify-api-version': '2026-10', ...headers } });
function error(code: string, ambiguous = false, retryable = false) {
  return (err: unknown) => err instanceof ConnectorError && err.code === code && err.ambiguous === ambiguous && err.retryable === retryable;
}

test('shop validation prevents SSRF hosts, URL forms and noncanonical names', () => {
  assert.equal(validateShop(credentials.shop), credentials.shop);
  for (const shop of ['https://demo.myshopify.com', 'demo.myshopify.com.evil.test', 'demo.myshopify.com:443', 'demo.myshopify.com/', '-demo.myshopify.com', 'demo-.myshopify.com', 'demo..myshopify.com', 'DEMO.myshopify.com']) assert.throws(() => validateShop(shop));
});

test('product list sends latest pinned GraphQL version and supports bounded pagination', async () => {
  const calls: any[] = [];
  const api = new ShopifyConnector({ fetch: async (url, init) => {
    calls.push({ url, init });
    return response({ data: { products: { nodes: [{ ...item, status: 'DRAFT' }], pageInfo: { hasNextPage: true, endCursor: 'cursor' } } } });
  } });
  const result = await api.listProducts({ ...credentials, first: 10, after: 'previous' });
  assert.deepEqual(result, { products: [{ ...item, status: 'DRAFT' }], pageInfo: { hasNextPage: true, endCursor: 'cursor' } });
  assert.equal(calls[0].url, 'https://demo.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(calls[0].init.headers['X-Shopify-Access-Token'], credentials.accessToken);
  assert.equal(calls[0].init.redirect, 'error');
  assert.match(JSON.parse(calls[0].init.body).query, /nodes \{ id title updatedAt status \}/);
  assert.deepEqual(JSON.parse(calls[0].init.body).variables, { first: 10, after: 'previous' });
  await assert.rejects(api.listProducts({ ...credentials, first: 251 }), error('VALIDATION'));
  assert.equal(calls.length, 1);
});

test('title-only mutation uses variables and productUpdate ProductUpdateInput', async () => {
  let sent: any;
  const api = new ShopifyConnector({ fetch: async (_url, init) => {
    sent = JSON.parse(init!.body as string);
    return response({ data: { productUpdate: { product: item, userErrors: [] } } });
  } });
  assert.deepEqual(await api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), item);
  assert.match(sent.query, /\$product: ProductUpdateInput!/);
  assert.deepEqual(sent.variables, { product: { id: item.id, title: item.title } });
});

test('reads support reconciliation of missing products', async () => {
  const api = new ShopifyConnector({ fetch: async () => response({ data: { product: null } }) });
  assert.equal(await api.readProductTitle({ ...credentials, productId: item.id }), null);
});

test('transport and 5xx mutations are ambiguous and never retried automatically', async () => {
  for (const fetcher of [async () => { throw new Error('socket reset'); }, async () => response({}, 503), async () => new Response('{')]) {
    let calls = 0;
    const api = new ShopifyConnector({ fetch: async () => { calls++; return fetcher(); } });
    await assert.rejects(api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), error('AMBIGUOUS_WRITE', true));
    assert.equal(calls, 1);
  }
  const api = new ShopifyConnector({ fetch: async () => { throw new Error('socket reset'); } });
  await assert.rejects(api.listProducts(credentials), error('TRANSIENT', false, true));
});

test('rate limits safely retry; authentication and permissions stay terminal', async () => {
  for (const [reply, code, retryable] of [
    [response({}, 429, { 'retry-after': '2' }), 'RATE_LIMITED', true],
    [response({ errors: [{ extensions: { code: 'THROTTLED' } }] }), 'RATE_LIMITED', true],
    [response({}, 401), 'AUTHENTICATION', false],
    [response({}, 403), 'PERMISSION', false],
    [response({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] }), 'PERMISSION', false],
  ] as const) {
    const api = new ShopifyConnector({ fetch: async () => reply });
    await assert.rejects(api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), error(code, false, retryable));
  }
});

test('partial GraphQL mutations and malformed result must reconcile', async () => {
  for (const body of [
    { data: { productUpdate: { product: item } }, errors: [{ extensions: { code: 'THROTTLED' } }] },
    { data: { productUpdate: { product: { ...item, title: 'different' }, userErrors: [] } } },
  ]) {
    const api = new ShopifyConnector({ fetch: async () => response(body) });
    await assert.rejects(api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), error('AMBIGUOUS_WRITE', true));
  }
});

test('definite Shopify validation rejection does not become an ambiguous write', async () => {
  const api = new ShopifyConnector({ fetch: async () => response({ data: { productUpdate: { product: null, userErrors: [{ field: ['title'], message: 'Invalid title' }] } } }) });
  await assert.rejects(api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), error('UPSTREAM_REJECTED'));
});

test('API version mismatch is terminal for reads and ambiguous for writes', async () => {
  const api = new ShopifyConnector({ fetch: async () => response({}, 200, { 'x-shopify-api-version': '2027-01' }) });
  await assert.rejects(api.listProducts(credentials), error('API_VERSION_MISMATCH'));
  await assert.rejects(api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), error('API_VERSION_MISMATCH', true));
});

test('external cancellation and timeout abort in-flight request', async () => {
  const api = new ShopifyConnector({ timeoutMs: 10, fetch: async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (init!.signal!.aborted) reject(new Error('aborted'));
      // Keep the test alive; AbortSignal.timeout itself does not hold the event loop.
      const keepAlive = setTimeout(() => reject(new Error('test timeout')), 100);
      init!.signal!.addEventListener('abort', () => clearTimeout(keepAlive), { once: true });
    });
  } });
  await assert.rejects(api.updateProductTitle({ ...credentials, productId: item.id, title: item.title }), error('AMBIGUOUS_WRITE', true));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.listProducts({ ...credentials, signal: controller.signal }), error('TRANSIENT', false, true));
});

test('catalog reads reject missing and malformed product statuses', async () => {
  for (const status of [undefined, null, 1, '']) {
    const api = new ShopifyConnector({ fetch: async () => response({ data: { products: {
      nodes: [{ ...item, status }], pageInfo: { hasNextPage: false, endCursor: null },
    } } }) });
    await assert.rejects(api.listProducts(credentials), error('TRANSIENT', false, true));
  }
});

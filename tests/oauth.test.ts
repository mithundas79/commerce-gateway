import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ConnectorError } from '../src/shopify.js';
import { ShopifyOAuth, hashOAuthValue, verifyOAuthHmac, verifyShopifyWebhook, type OAuthState, type OfflineTokens, type ShopifyAppConfig } from '../src/oauth.js';

const app: ShopifyAppConfig = { clientId: 'client', clientSecret: 'client-secret', redirectUri: 'https://gateway.example/oauth/callback', scopes: ['read_products', 'write_products'], allowedReturnUrls: ['https://client.example/connected'] };
const browserBinding = 'secure-browser-cookie-at-least-32-bytes';
const shop = 'demo.myshopify.com';
const epoch = Date.parse('2026-11-04T12:00:00Z');
function fixture(reply = { access_token: 'offline-access', refresh_token: 'offline-refresh', expires_in: 3600, refresh_token_expires_in: 7_776_000, scope: 'write_products' }) {
  const states = new Map<string, OAuthState>();
  const tokens = new Map<string, OfflineTokens>();
  const calls: { url: any; init: RequestInit }[] = [];
  let now = epoch;
  let fetcher = async () => new Response(JSON.stringify(reply));
  // Mirrors an atomic DB consume and distributed lock for deterministic race coverage.
  const locks = new Map<string, Promise<unknown>>();
  const service = new ShopifyOAuth({
    getApp: async tenantId => { assert.ok(['tenant-a', 'tenant-b'].includes(tenantId)); return app; },
    now: () => now,
    states: {
      create: async state => { states.set(state.stateHash, state); },
      get: async hash => states.get(hash),
      consume: async (hash, binding, expectedShop, time) => {
        const value = states.get(hash);
        if (!value || value.browserBindingHash !== binding || value.shop !== expectedShop || value.expiresAt <= time) return undefined;
        states.delete(hash); return value;
      },
    },
    tokens: {
      get: async (tenant, domain) => tokens.get(`${tenant}:${domain}`),
      save: async (tenant, domain, value) => { tokens.set(`${tenant}:${domain}`, value); },
      delete: async (tenant, domain) => { tokens.delete(`${tenant}:${domain}`); },
      withLock: async (key, work) => {
        const previous = locks.get(key) ?? Promise.resolve();
        const running = previous.catch(() => {}).then(work);
        locks.set(key, running);
        return running;
      },
    },
    fetch: async (url, init) => { calls.push({ url, init: init! }); return fetcher(); },
  });
  return { service, states, tokens, calls, setNow: (time: number) => { now = time; }, setFetch: (fetch: typeof fetcher) => { fetcher = fetch; } };
}
function callback(state: string, overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({ state, shop, code: 'authorization-code', timestamp: String(epoch / 1000), ...overrides });
  const message = [...query.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
  query.set('hmac', createHmac('sha256', app.clientSecret).update(message).digest('hex'));
  return query;
}

test('standalone offline authorization uses tenant-bound hashed state and exact return allowlist', async () => {
  const f = fixture();
  const result = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding, returnUrl: app.allowedReturnUrls[0] });
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin, `https://${shop}`);
  assert.equal(url.searchParams.get('redirect_uri'), app.redirectUri);
  assert.equal(url.searchParams.get('grant_options[]'), null);
  const saved = f.states.get(hashOAuthValue(result.state))!;
  assert.equal(saved.tenantId, 'tenant-a');
  assert.equal(saved.browserBindingHash, hashOAuthValue(browserBinding));
  assert.equal(JSON.stringify(saved).includes(result.state), false);
  await assert.rejects(f.service.start({ tenantId: 'tenant-a', shop, browserBinding, returnUrl: 'https://client.example/connected?redirect=evil' }));
  await assert.rejects(f.service.start({ tenantId: 'tenant-a', shop: `${shop}.evil.test`, browserBinding }));
});

test('signed callback exchanges once for expiring offline pair and returns no secrets', async () => {
  const f = fixture();
  const start = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding });
  const query = callback(start.state);
  const result = await f.service.complete({ query, browserBinding });
  assert.deepEqual(result, { tenantId: 'tenant-a', shop, scopes: app.scopes });
  assert.equal(f.calls[0].url, `https://${shop}/admin/oauth/access_token`);
  const params = f.calls[0].init.body as URLSearchParams;
  assert.equal(params.get('expiring'), '1');
  assert.equal(params.get('code'), 'authorization-code');
  assert.equal(params.get('client_secret'), app.clientSecret);
  assert.equal(f.tokens.get(`tenant-a:${shop}`)?.expiresAt, epoch + 3_600_000);
  assert.equal(f.tokens.has(`tenant-b:${shop}`), false);
  await assert.rejects(f.service.complete({ query, browserBinding }));
  assert.equal(f.calls.length, 1);
});

test('callback verifies HMAC, browser binding, shop, timestamp and duplicate parameters before exchange', async () => {
  for (const mode of ['hmac', 'browser', 'shop', 'timestamp', 'duplicate']) {
    const f = fixture();
    const start = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding });
    const query = callback(start.state, mode === 'shop' ? { shop: 'other.myshopify.com' } : mode === 'timestamp' ? { timestamp: '0' } : {});
    if (mode === 'hmac') query.set('hmac', 'a'.repeat(64));
    if (mode === 'duplicate') query.append('shop', shop);
    await assert.rejects(f.service.complete({ query, browserBinding: mode === 'browser' ? 'wrong-cookie' : browserBinding }));
    assert.equal(f.calls.length, 0);
  }
});

test('state expires and concurrent callback replay loses atomic consume', async () => {
  const f = fixture();
  const start = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding });
  const results = await Promise.allSettled([f.service.complete({ query: callback(start.state), browserBinding }), f.service.complete({ query: callback(start.state), browserBinding })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 1);
  const next = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding });
  f.setNow(epoch + 10 * 60_000);
  await assert.rejects(f.service.complete({ query: callback(next.state), browserBinding }));
});

test('callback consumes state even if code exchange fails; merchant restarts authorization', async () => {
  const f = fixture(); f.setFetch(async () => new Response('{}', { status: 503 }));
  const start = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding });
  await assert.rejects(f.service.complete({ query: callback(start.state), browserBinding }));
  await assert.rejects(f.service.complete({ query: callback(start.state), browserBinding }));
  assert.equal(f.calls.length, 1);
});

test('refresh rotates access and refresh pair once for concurrent readers', async () => {
  const f = fixture();
  f.tokens.set(`tenant-a:${shop}`, { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: epoch + 10_000, refreshTokenExpiresAt: epoch + 1_000_000, scopes: app.scopes });
  const [first, second] = await Promise.all([f.service.accessToken('tenant-a', shop), f.service.accessToken('tenant-a', shop)]);
  assert.equal(first, 'offline-access'); assert.equal(second, first);
  assert.equal(f.calls.length, 1);
  const params = f.calls[0].init.body as URLSearchParams;
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'old-refresh');
  assert.equal(f.tokens.get(`tenant-a:${shop}`)?.refreshToken, 'offline-refresh');
});

test('transient refresh preserves old pair; terminal invalid token clears pair', async () => {
  const f = fixture();
  const old = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: epoch, refreshTokenExpiresAt: epoch + 1_000_000, scopes: app.scopes };
  f.tokens.set(`tenant-a:${shop}`, old);
  f.setFetch(async () => { throw new Error('lost response'); });
  await assert.rejects(f.service.accessToken('tenant-a', shop), (e: any) => e instanceof ConnectorError && e.retryable);
  assert.deepEqual(f.tokens.get(`tenant-a:${shop}`), old);
  f.setFetch(async () => new Response('{"error":"invalid_request"}', { status: 401 }));
  await assert.rejects(f.service.accessToken('tenant-a', shop), (e: any) => e instanceof ConnectorError && e.code === 'AUTHENTICATION');
  assert.equal(f.tokens.has(`tenant-a:${shop}`), false);
});

test('refuses nonexpiring token pair or insufficient granted scopes', async () => {
  for (const reply of [
    { access_token: 'legacy', scope: 'write_products' },
    { access_token: 'token', refresh_token: 'refresh', expires_in: 3600, refresh_token_expires_in: 86400, scope: 'read_products' },
  ]) {
    const f = fixture(); f.setFetch(async () => new Response(JSON.stringify(reply)));
    const start = await f.service.start({ tenantId: 'tenant-a', shop, browserBinding });
    await assert.rejects(f.service.complete({ query: callback(start.state), browserBinding }));
    assert.equal(f.tokens.size, 0);
  }
});

test('webhook HMAC covers raw bytes and malformed HMAC is rejected', () => {
  const bytes = Buffer.from('{ "shop_id": 1 }');
  const signed = createHmac('sha256', app.clientSecret).update(bytes).digest('base64');
  assert.equal(verifyShopifyWebhook(bytes, signed, app.clientSecret), true);
  assert.equal(verifyShopifyWebhook(Buffer.from('{"shop_id":1}'), signed, app.clientSecret), false);
  assert.equal(verifyShopifyWebhook(bytes, 'invalid', app.clientSecret), false);
  assert.equal(verifyOAuthHmac(new URLSearchParams('hmac=bad'), app.clientSecret), false);
});

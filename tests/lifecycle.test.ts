import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { buildApi } from '../src/api.js';
import { registerShopifyWebhooks, shopifyWebhookRoute, webhookBinding, webhookSubscriptions, type ShopifyLifecycle } from '../src/lifecycle.js';
import type { PostgresStore } from '../src/store.js';

const config={clientId:'app-id',clientSecret:'private-app-secret',redirectUri:'https://gateway.example/oauth/shopify/callback',scopes:['write_products'],allowedReturnUrls:[]};
const shop='demo.myshopify.com';

test('topic URLs use a distinct HMAC domain and cannot be swapped across apps or topics',() => {
  const binding=webhookBinding(config,'shop-redact');
  assert.match(binding,/^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(binding,webhookBinding(config,'customers-redact'));
  assert.notEqual(binding,webhookBinding({...config,clientId:'other-app'},'shop-redact'));
  assert.notEqual(binding,createHmac('sha256',config.clientSecret).update('shop-redact').digest('base64url'));
  const toml=webhookSubscriptions(config,'https://gateway.example');
  assert.equal((toml.match(/\[\[webhooks.subscriptions\]\]/g) ?? []).length,4);
  for(const topic of ['app/uninstalled','customers/data_request','customers/redact','shop/redact']) assert.ok(toml.includes(`"${topic}"`));
  assert.ok(toml.includes('api_version = "2026-10"'));
});

test('registered raw webhook route verifies original bytes, topic capability, payload and headers before side effects',async () => {
  const calls:any[]=[];
  const pool={query:async () => ({rows:[{tenant_id:'tenant'}]})} as unknown as Pool;
  const store={getApp:async () => config} as unknown as PostgresStore;
  const lifecycle={receive:async (...args:any[]) => {calls.push(args);return 'receipt';},process:async () => {}} as unknown as ShopifyLifecycle;
  const app=buildApi({pool,publicRoutes:[shopifyWebhookRoute],readProducts:async () => {throw new Error('Unexpected API read');}});
  registerShopifyWebhooks(app,pool,store,lifecycle);
  try {
    const raw=Buffer.from('{ "shop_id": 123, "shop_domain": "demo.myshopify.com" }\n');
    const url=`/webhooks/shopify/app-id/shop-redact/${webhookBinding(config,'shop-redact')}`;
    const headers={'content-type':'application/json','x-shopify-topic':'shop/redact','x-shopify-shop-domain':shop,
      'x-shopify-hmac-sha256':createHmac('sha256',config.clientSecret).update(raw).digest('base64')};
    const response=await app.inject({method:'POST',url,headers,payload:raw});
    assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{accepted:true});
    assert.deepEqual(calls[0][3],raw);assert.deepEqual(calls[0][2],{shopId:'123',shop});
    assert.deepEqual(calls[0][4],['tenant']);
    for(const [change,expected] of [
      [{payload:JSON.stringify(JSON.parse(raw.toString()))},401],
      [{headers:{...headers,'x-shopify-hmac-sha256':'malformed'}},401],
      [{headers:{...headers,'x-shopify-topic':'app/uninstalled'}},400],
      [{headers:{...headers,'x-shopify-shop-domain':'other.myshopify.com'}},400],
      [{url:url.replace('shop-redact/','customers-redact/')},401],
      [{url:url.replace('app-id/','other-app/')},401],
    ] as const) {
      const result=await app.inject(Object.assign({method:'POST' as const,url,headers,payload:raw},change));
      assert.equal(result.statusCode,expected);
    }
    assert.equal(calls.length,1);
    const malformed=Buffer.from('{');
    assert.equal((await app.inject({method:'POST',url,headers:{...headers,'x-shopify-hmac-sha256':createHmac('sha256',config.clientSecret).update(malformed).digest('base64')},payload:malformed})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers:{...headers,'content-type':'text/plain'},payload:raw})).statusCode,415);
  } finally {await app.close();}
});

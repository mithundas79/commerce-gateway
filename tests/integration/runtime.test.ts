import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap, migrate, revokeApiKey } from '../../src/admin.js';
import { PostgresStore } from '../../src/store.js';
import { ShopifyOAuth } from '../../src/oauth.js';
import { createRuntime } from '../../src/main.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL integration tests');
const master = 'a1'.repeat(32);

async function fixture() {
  const schema = `runtime_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
  await migrate(pool);
  const tenant = randomUUID();
  const key = `runtime-${randomUUID()}`;
  await bootstrap(pool,{TENANT_ID:tenant,API_KEY:key});
  const store = new PostgresStore(pool,master);
  const config = {clientId:'fixture-shared-app',clientSecret:'fixture-client-secret',redirectUri:'https://gateway.example/oauth/shopify/callback',scopes:['write_products'],allowedReturnUrls:['https://client.example/connected']};
  await store.configureApp(tenant,config);
  return {pool,store,tenant,key,config,close:async () => {await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();}};
}

test('PostgreSQL serializes independent refresh stores and atomically persists rotated encrypted token pair',async () => {
  const f = await fixture();
  try {
    const shop = 'runtime.myshopify.com';
    await f.store.withLock(`${f.tenant}:${shop}`,() => f.store.save(f.tenant,shop,{accessToken:'expired-access',refreshToken:'old-refresh',expiresAt:Date.now()-1,refreshTokenExpiresAt:Date.now()+3_600_000,scopes:['write_products']}));
    const otherStore = new PostgresStore(f.pool,master);
    let refreshes = 0;
    const fetcher: typeof fetch = async (_url,init) => {
      refreshes++;
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),'old-refresh');
      await new Promise(resolve => setTimeout(resolve,100));
      return new Response(JSON.stringify({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600,refresh_token_expires_in:7_776_000,scope:'write_products'}));
    };
    const services = [f.store,otherStore].map(store => new ShopifyOAuth({getApp:tenant => store.getApp(tenant),states:store,tokens:store,fetch:fetcher}));
    assert.deepEqual(await Promise.all(services.map(service => service.accessToken(f.tenant,shop))),['rotated-access','rotated-access']);
    assert.equal(refreshes,1);
    assert.equal((await f.store.get(f.tenant,shop))?.refreshToken,'rotated-refresh');
    const ciphertext = (await f.pool.query('SELECT token_ciphertext FROM connections WHERE tenant_id=$1',[f.tenant])).rows[0].token_ciphertext;
    assert.ok(!ciphertext.includes('rotated-access') && !ciphertext.includes('rotated-refresh'));
    await assert.rejects(f.store.configureApp(f.tenant,{...f.config,clientId:'different-app'}),/Revoke active connections/);

    const tenantB = randomUUID();
    await bootstrap(f.pool,{TENANT_ID:tenantB,API_KEY:`runtime-b-${randomUUID()}`});
    await f.store.configureApp(tenantB,f.config);
    let exchanged = false;
    await assert.rejects(otherStore.withLock(`${tenantB}:${shop}`,async () => {exchanged=true;}),/another tenant/);
    assert.equal(exchanged,false);
  } finally {await f.close();}
});

test('real PostgreSQL browser start and HMAC callback enforce cookie binding and one-use state',async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  let reads = 0; let writes = 0;
  globalThis.fetch = async (url,init) => {
    if (String(url).includes('/graphql.json')) {
      assert.equal(String(url),'https://runtime.myshopify.com/admin/api/2026-10/graphql.json');
      assert.equal((init?.headers as Record<string,string>)['X-Shopify-Access-Token'],'callback-access');
      const body = JSON.parse(String(init?.body));
      const product = {id:'gid://shopify/Product/123',title:'Fixture title',updatedAt:'2026-11-04T00:00:00Z'};
      if (body.query.includes('mutation ProductTitleUpdate')) {
        writes++;
        return new Response(JSON.stringify({data:{productUpdate:{product:{...product,title:body.variables.product.title},userErrors:[]}}}));
      }
      reads++;
      return new Response(JSON.stringify({data:{product}}));
    }
    exchanges++;
    return new Response(JSON.stringify({access_token:'callback-access',refresh_token:'callback-refresh',expires_in:3600,refresh_token_expires_in:7_776_000,scope:'write_products'}));
  };
  const {app,provider} = createRuntime(f.pool,master,'https://gateway.example');
  try {
    const connect = await app.inject({method:'POST',url:'/v1/shopify/connect',headers:{authorization:`Bearer ${f.key}`},payload:{shop:'runtime.myshopify.com',returnUrl:'https://client.example/connected'}});
    assert.equal(connect.statusCode,200);
    const startUrl = new URL(connect.json().browserStartUrl);
    const start = await app.inject({method:'GET',url:startUrl.pathname+startUrl.search});
    assert.equal(start.statusCode,302);
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const params = new URLSearchParams({state,shop:'runtime.myshopify.com',code:'fixture-code',timestamp:String(Math.floor(Date.now()/1000))});
    const message = [...params].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('&');
    params.set('hmac',createHmac('sha256',f.config.clientSecret).update(message).digest('hex'));
    const url = `/oauth/shopify/callback?${params}`;
    const cookie = (start.headers['set-cookie'] as string).split(';',1)[0]!;
    const unbound = await app.inject({method:'GET',url});
    assert.equal(unbound.statusCode,403); assert.equal(exchanges,0);
    const completed = await app.inject({method:'GET',url,headers:{cookie}});
    assert.equal(completed.statusCode,302);
    assert.equal(completed.headers.location,'https://client.example/connected');
    assert.equal(exchanges,1);
    assert.equal((await f.store.get(f.tenant,'runtime.myshopify.com'))?.accessToken,'callback-access');
    const replay = await app.inject({method:'GET',url,headers:{cookie}});
    assert.equal(replay.statusCode,403); assert.equal(exchanges,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM oauth_states')).rows[0].count,0);
    const connection = (await f.pool.query('SELECT id FROM connections WHERE tenant_id=$1',[f.tenant])).rows[0];
    const context = {tenantId:f.tenant,connectionId:connection.id,productId:'gid://shopify/Product/123',signal:new AbortController().signal};
    assert.equal(await provider.readProductTitle(context),'Fixture title');
    await provider.updateProductTitle({...context,title:'Changed title'});
    assert.equal(reads,1); assert.equal(writes,1); assert.equal(exchanges,1);
    await assert.rejects(provider.readProductTitle({...context,tenantId:randomUUID()}),/not authorized/);
    await f.pool.query('UPDATE connections SET revoked_at=now() WHERE id=$1',[connection.id]);
    await assert.rejects(provider.updateProductTitle({...context,title:'Must not dispatch'}),/not authorized/);
    assert.equal(writes,1);
    await revokeApiKey(f.pool,{TENANT_ID:f.tenant,API_KEY:f.key});
    const revokedKey = await app.inject({method:'GET',url:'/v1/connections',headers:{authorization:`Bearer ${f.key}`}});
    assert.equal(revokedKey.statusCode,401);
    await assert.rejects(bootstrap(f.pool,{TENANT_ID:f.tenant,API_KEY:f.key}),/revoked/);
  } finally {globalThis.fetch=originalFetch; await app.close(); await f.close();}
});

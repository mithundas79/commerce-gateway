import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap, migrate } from '../../src/admin.js';
import { createRuntime } from '../../src/main.js';
import { webhookBinding, lifecycleTopics } from '../../src/lifecycle.js';
import { PostgresStore } from '../../src/store.js';
import { runWorkerOnce } from '../../src/worker.js';
import { encryptSecret } from '../../src/crypto.js';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL lifecycle tests');
const master='a1'.repeat(32);
const shop='lifecycle.myshopify.com';
const config={clientId:'lifecycle-app',clientSecret:'lifecycle-secret',redirectUri:'https://gateway.example/oauth/shopify/callback',scopes:['write_products'],allowedReturnUrls:[]};

async function fixture() {
  const schema=`lifecycle_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
  let runtime:ReturnType<typeof createRuntime> | undefined;
  try {
  await migrate(pool);
  const tenant=randomUUID();const key=`lifecycle-${randomUUID()}`;await bootstrap(pool,{TENANT_ID:tenant,API_KEY:key});
  const store=new PostgresStore(pool,master);await store.configureApp(tenant,config);
  async function install(domain=shop,shopId='123') {
    await store.withLock(`${tenant}:${domain}`,() => store.save(tenant,domain,{shopId,authorizationId:randomUUID(),accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+3_600_000,refreshTokenExpiresAt:Date.now()+7_776_000_000,scopes:['write_products']}));
    return (await pool.query('SELECT * FROM connections WHERE tenant_id=$1 AND shop=$2',[tenant,domain])).rows[0];
  }
  const connection=await install();
  const nativeFetch=globalThis.fetch;
  runtime=createRuntime(pool,master,'https://gateway.example',false,{fetch:async (url,init) => {
    if(globalThis.fetch===nativeFetch) throw new Error('Lifecycle test Shopify transport must be mocked');
    return globalThis.fetch(url,init);
  }});
  const activeRuntime=runtime;
  async function send(topic:keyof typeof lifecycleTopics,payload:object,headers:Record<string,string>={},app=config) {
    const raw=Buffer.from(JSON.stringify(payload));
    const response=await activeRuntime.app.inject({method:'POST',url:`/webhooks/shopify/${app.clientId}/${topic}/${webhookBinding(app,topic)}`,
      headers:{'content-type':'application/json','x-shopify-topic':lifecycleTopics[topic],'x-shopify-shop-domain':shop,
        'x-shopify-hmac-sha256':createHmac('sha256',app.clientSecret).update(raw).digest('base64'),...headers},payload:raw});
    await activeRuntime.lifecycle.reconcile();
    return response;
  }
  async function operation(status='queued',dispatched=false) {
    const id=randomUUID();await pool.query(`INSERT INTO operations(id,tenant_id,connection_id,kind,idempotency_key,payload,status,dispatch_started_at,deadline_at)
      VALUES($1,$2,$3,'product_title_update',$6,'{"productId":"gid://shopify/Product/1","title":"Private title"}',$4,CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,clock_timestamp()+interval '1 hour')`,[id,tenant,connection.id,status,dispatched,id]);return id;
  }
  return {pool,store,tenant,key,connection,runtime:activeRuntime,send,install,operation,close:async () => {await activeRuntime.app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
  } catch(error) {
    await runtime?.app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;
  }
}

test('fresh 401 uninstall invalidates tokens, fences queued/in-flight work, and body receipts survive changed unsigned delivery IDs',async () => {
  const f=await fixture();const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async () => {requests++;return new Response('{}',{status:401});};
  try {
    const queued=await f.operation();const running=await f.operation('running',true);
    const other=await f.install('other.myshopify.com','456');
    const payload={id:123,myshopify_domain:shop,email:'never-retain@example.com'};
    assert.equal((await f.send('app-uninstalled',payload)).statusCode,200);
    const connection=(await f.pool.query('SELECT * FROM connections WHERE id=$1',[f.connection.id])).rows[0];
    assert.ok(connection.revoked_at);assert.equal(connection.token_ciphertext,'');assert.equal(connection.lifecycle_hold,true);
    const jobs=(await f.pool.query('SELECT id,status,fence_token,error FROM operations ORDER BY id')).rows;
    assert.equal(jobs.find(row => row.id===queued).status,'failed');assert.equal(jobs.find(row => row.id===running).status,'uncertain');
    assert.ok(jobs.every(row => Number(row.fence_token)===1));
    assert.equal((await f.pool.query('SELECT revoked_at FROM connections WHERE id=$1',[other.id])).rows[0].revoked_at,null);
    assert.equal((await f.send('app-uninstalled',payload,{'x-shopify-webhook-id':randomUUID(),'x-shopify-triggered-at':'2099-01-01'})).statusCode,200);
    assert.equal(requests,1);assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM shopify_lifecycle_events')).rows[0].n,1);
    assert.ok(!JSON.stringify((await f.pool.query('SELECT * FROM shopify_lifecycle_events')).rows).includes('never-retain'));
  } finally {globalThis.fetch=original;await f.close();}
});

test('all compliance topics are handled and shop redaction erases only the owning app/shop including outbound snapshots',async () => {
  const f=await fixture();const original=globalThis.fetch;globalThis.fetch=async () => new Response('{}',{status:401});
  try {
    const op=await f.operation();
    await f.pool.query(`INSERT INTO notification_endpoints(tenant_id,version,url,secret_ciphertext) VALUES($1,$2,'https://client.example/events','encrypted')`,[f.tenant,randomUUID()]);
    const customer={id:991,email:'customer-private@example.com'};
    for(const [topic,extra] of [['customers-data-request',{orders_requested:[],data_request:{id:77}}],['customers-redact',{orders_to_redact:[]}]] as const) {
      assert.equal((await f.send(topic,{shop_id:123,shop_domain:shop,customer,...extra})).statusCode,200);
    }
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM operations')).rows[0].n,1);
    await f.send('app-uninstalled',{id:123,myshopify_domain:shop});
    assert.equal((await f.pool.query('SELECT operation_id FROM notification_events')).rows[0].operation_id,op);
    assert.equal((await f.send('shop-redact',{shop_id:123,shop_domain:shop})).statusCode,200);
    for(const table of ['connections','operations','notification_events','shopify_shop_owners']) assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,table);
    const receipts=(await f.pool.query('SELECT * FROM shopify_lifecycle_events')).rows;
    assert.ok(receipts.every(row => row.shop===null && row.tenant_id===null && row.connection_id===null));
    assert.ok(!JSON.stringify(receipts).includes('customer-private'));
    assert.equal((await f.send('shop-redact',{shop_id:123,shop_domain:shop})).statusCode,200);
  } finally {globalThis.fetch=original;await f.close();}
});

test('id-only signed uninstall resolves persisted identity and stale events preserve reinstalled credentials',async () => {
  const f=await fixture();const original=globalThis.fetch;
  globalThis.fetch=async () => new Response(JSON.stringify({data:{shop:{id:'gid://shopify/Shop/123',myshopifyDomain:shop}}}));
  try {
    const generation=f.connection.authorization_generation;
    const installed=await f.install();assert.notEqual(installed.authorization_generation,generation);
    assert.equal((await f.send('app-uninstalled',{id:123,myshopify_domain:null})).statusCode,200);
    assert.equal((await f.send('shop-redact',{shop_id:123,shop_domain:shop})).statusCode,200);
    const current=(await f.pool.query('SELECT * FROM connections WHERE id=$1',[f.connection.id])).rows[0];
    assert.equal(current.revoked_at,null);assert.equal(current.lifecycle_hold,false);assert.ok(current.token_ciphertext);
    assert.deepEqual((await f.pool.query('SELECT status FROM shopify_lifecycle_events')).rows.map(row => row.status),['ignored','ignored']);
    assert.equal((await f.send('app-uninstalled',{id:456,myshopify_domain:shop})).statusCode,400);
    assert.equal((await f.send('app-uninstalled',{id:123,myshopify_domain:null},{'x-shopify-shop-domain':'other.myshopify.com'})).statusCode,400);
  } finally {globalThis.fetch=original;await f.close();}
});

test('outages and permission denial retain durable receipts, block queued work, retry boundedly, and surface action required',async () => {
  const f=await fixture();const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async () => {requests++;return new Response('{}',{status:503});};
  try {
    await f.operation();
    assert.equal((await f.send('app-uninstalled',{id:123,myshopify_domain:shop})).statusCode,200);
    let event=(await f.pool.query('SELECT * FROM shopify_lifecycle_events')).rows[0];
    assert.equal(event.status,'pending');assert.equal(event.last_error,'TRANSIENT');
    assert.equal((await f.runtime.app.inject({method:'GET',url:`/v1/connections/${f.connection.id}/products`,headers:{authorization:`Bearer ${f.key}`}})).statusCode,404);
    assert.equal(await runWorkerOnce({pool:f.pool,provider:{readProductTitle:async () => {throw new Error('Must not dispatch');},updateProductTitle:async () => {throw new Error('Must not dispatch');}}}),false);
    globalThis.fetch=async () => new Response('{}',{status:403});
    await f.pool.query(`UPDATE shopify_lifecycle_events SET attempt_count=7,next_attempt_at='-infinity'`);await f.runtime.lifecycle.reconcile();
    event=(await f.pool.query('SELECT * FROM shopify_lifecycle_events')).rows[0];assert.equal(event.status,'action_required');assert.equal(event.last_error,'PERMISSION');
    assert.equal((await f.pool.query('SELECT revoked_at FROM connections')).rows[0].revoked_at,null);assert.equal(requests,1);
  } finally {globalThis.fetch=original;await f.close();}
});

test('expired credentials refresh for proof and an invalid refresh remains observable without erasing shop data',async () => {
  const f=await fixture();const original=globalThis.fetch;let refreshes=0;
  globalThis.fetch=async url => {
    if(String(url).includes('/oauth/access_token')) {refreshes++;return new Response('{}',{status:401});}
    throw new Error('Expired access token must not be used');
  };
  try {
    await f.store.withLock(`${f.tenant}:${shop}`,() => f.store.save(f.tenant,shop,{shopId:'123',accessToken:'expired',refreshToken:'refresh',expiresAt:Date.now()-1,refreshTokenExpiresAt:Date.now()+3600000,scopes:['write_products']}));
    await f.operation();
    assert.equal((await f.send('shop-redact',{shop_id:123,shop_domain:shop})).statusCode,200);
    const event=(await f.pool.query('SELECT status,last_error FROM shopify_lifecycle_events')).rows[0];assert.equal(event.status,'action_required');assert.equal(event.last_error,'AUTHENTICATION');assert.equal(refreshes,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM operations')).rows[0].n,1);assert.equal((await f.pool.query('SELECT lifecycle_hold FROM connections')).rows[0].lifecycle_hold,true);
  } finally {globalThis.fetch=original;await f.close();}
});

test('a concurrent reinstall supersedes an old provider proof and a later identical uninstall can still invalidate the new installation',async () => {
  const f=await fixture();const original=globalThis.fetch;
  let started!:()=>void;let release!:()=>void;
  const entered=new Promise<void>(resolve => {started=resolve;});
  const blocked=new Promise<void>(resolve => {release=resolve;});
  globalThis.fetch=async () => {started();await blocked;return new Response('{}',{status:401});};
  try {
    const payload={id:123,myshopify_domain:shop};
    const delivered=f.send('app-uninstalled',payload);
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered,delivered.then(response => {throw new Error(`Delivery finished before proof (${response.statusCode}): ${response.body}`);}),
        new Promise<never>((_,reject) => {timer=setTimeout(() => reject(new Error('Provider proof did not start within 10 seconds')),10000);})]);
    } finally {if(timer) clearTimeout(timer);}
    const reinstalled=await f.install();release();await delivered;
    let current=(await f.pool.query('SELECT * FROM connections WHERE id=$1',[f.connection.id])).rows[0];
    assert.equal(current.authorization_generation,reinstalled.authorization_generation);assert.equal(current.revoked_at,null);assert.equal(current.lifecycle_hold,false);
    // A first-seen old event delivered to the new installation is harmless while its token works.
    globalThis.fetch=async () => new Response(JSON.stringify({data:{shop:{id:'gid://shopify/Shop/123',myshopifyDomain:shop}}}));
    await f.send('app-uninstalled',payload);
    assert.equal((await f.pool.query('SELECT revoked_at FROM connections')).rows[0].revoked_at,null);
    // An identical body after a real uninstall must be rechecked, even if previously ignored.
    globalThis.fetch=async () => new Response('{}',{status:401});await f.send('app-uninstalled',payload);
    current=(await f.pool.query('SELECT * FROM connections')).rows[0];assert.ok(current.revoked_at);assert.equal(current.token_ciphertext,'');
  } finally {release?.();globalThis.fetch=original;await f.close();}
});

test('a different tenant using the same public app ID and its own secret cannot forge another owner lifecycle event',async () => {
  const f=await fixture();const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async () => {requests++;return new Response('{}',{status:401});};
  try {
    const attacker=randomUUID();await bootstrap(f.pool,{TENANT_ID:attacker,API_KEY:`attacker-${randomUUID()}`});
    const wrongSecret={...config,clientSecret:'different-tenant-secret'};await f.store.configureApp(attacker,wrongSecret);
    assert.equal((await f.send('app-uninstalled',{id:123,myshopify_domain:shop},{},wrongSecret)).statusCode,401);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM shopify_lifecycle_events')).rows[0].n,0);
    assert.equal((await f.pool.query('SELECT lifecycle_hold FROM connections')).rows[0].lifecycle_hold,false);assert.equal(requests,0);
  } finally {globalThis.fetch=original;await f.close();}
});

test('an expired access token can refresh into an active installation without clearing the hold before proof',async () => {
  const f=await fixture();const original=globalThis.fetch;let refreshes=0;
  globalThis.fetch=async url => {
    if(String(url).includes('/oauth/access_token')) {refreshes++;return new Response(JSON.stringify({access_token:'rotated',refresh_token:'rotated-refresh',expires_in:3600,refresh_token_expires_in:7776000,scope:'write_products'}));}
    assert.equal((await f.pool.query('SELECT lifecycle_hold FROM connections')).rows[0].lifecycle_hold,true);
    return new Response(JSON.stringify({data:{shop:{id:'gid://shopify/Shop/123',myshopifyDomain:shop}}}));
  };
  try {
    const tokens=(await f.store.get(f.tenant,shop))!;
    await f.store.withLock(`${f.tenant}:${shop}`,() => f.store.save(f.tenant,shop,{...tokens,expiresAt:Date.now()-1}));
    await f.send('shop-redact',{shop_id:123,shop_domain:shop});assert.equal(refreshes,1);
    const current=(await f.pool.query('SELECT * FROM connections')).rows[0];assert.equal(current.lifecycle_hold,false);assert.equal(current.revoked_at,null);
    assert.equal(current.authorization_generation,f.connection.authorization_generation);assert.equal((await f.store.get(f.tenant,shop))?.accessToken,'rotated');
  } finally {globalThis.fetch=original;await f.close();}
});

test('indexed topic capabilities bound secret lookups with 1000 tenants sharing one app and reject unsafe numeric IDs',async () => {
  const f=await fixture();const original=globalThis.fetch;
  globalThis.fetch=async () => new Response('{}',{status:401});
  try {
    const tenants=(await f.pool.query(`INSERT INTO tenants(id,name) SELECT gen_random_uuid(),'shared-app-fixture' FROM generate_series(1,1000) RETURNING id`)).rows;
    const bindings=(await f.pool.query('SELECT webhook_bindings FROM shopify_apps WHERE tenant_id=$1',[f.tenant])).rows[0].webhook_bindings;
    const rows=tenants.map(row => ({tenant:row.id,ciphertext:encryptSecret(config.clientSecret,master,`app:${row.id}`)}));
    await f.pool.query(`INSERT INTO shopify_apps(tenant_id,client_id,secret_ciphertext,redirect_uri,scopes,webhook_bindings)
      SELECT x.tenant::uuid,$2,x.ciphertext,$3,ARRAY['write_products'],$4 FROM jsonb_to_recordset($1::jsonb) AS x(tenant text,ciphertext text)`,[JSON.stringify(rows),config.clientId,config.redirectUri,bindings]);
    let loads=0;const getApp=f.runtime.store.getApp.bind(f.runtime.store);
    f.runtime.store.getApp=async tenant => {loads++;return getApp(tenant);};
    const raw='{"shop_id":9007199254740993,"shop_domain":"lifecycle.myshopify.com"}';
    const url=`/webhooks/shopify/${config.clientId}/shop-redact/${webhookBinding(config,'shop-redact')}`;
    const headers={'content-type':'application/json','x-shopify-topic':'shop/redact','x-shopify-shop-domain':shop,'x-shopify-hmac-sha256':createHmac('sha256',config.clientSecret).update(raw).digest('base64')};
    assert.equal((await f.runtime.app.inject({method:'POST',url,headers,payload:raw})).statusCode,400);assert.equal(loads,1);
    loads=0;
    const unmatched=url.slice(0,-43)+'Z'.repeat(43);
    assert.equal((await f.runtime.app.inject({method:'POST',url:unmatched,headers,payload:raw})).statusCode,401);assert.equal(loads,0);
    loads=0;
    assert.equal((await f.send('app-uninstalled',{id:123,myshopify_domain:shop})).statusCode,200);assert.equal(loads,2);
  } finally {globalThis.fetch=original;await f.close();}
});

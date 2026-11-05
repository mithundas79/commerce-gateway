import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { bootstrap, migrate } from '../../src/admin.js';
import { encryptSecret } from '../../src/crypto.js';
import { createRuntime } from '../../src/main.js';
import { lifecycleTopics, webhookBinding } from '../../src/oauth.js';
import { ConnectorError } from '../../src/shopify.js';
import { PostgresStore } from '../../src/store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL ownership tests');
const master = 'a1'.repeat(32);
const originalShop = 'original.myshopify.com';
const aliasShop = 'renamed.myshopify.com';
const otherShop = 'unrelated.myshopify.com';
const config = {
  clientId: 'stable-identity-app', clientSecret: 'synthetic-app-secret',
  redirectUri: 'https://gateway.example/oauth/shopify/callback',
  scopes: ['write_products'], allowedReturnUrls: [],
};

async function fixture(legacy = false) {
  const schema = `ownership_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
  let directory: string | undefined;
  try {
    if (legacy) {
      directory = await mkdtemp(join(tmpdir(),'gateway-legacy-identity-'));
      const migrations = new URL('../../migrations/',import.meta.url);
      for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql') && name < '008.sql')) {
        await copyFile(new URL(name,migrations),join(directory,name));
      }
      await migrate(pool,pathToFileURL(directory+sep));
    } else await migrate(pool);
    const tenant = randomUUID();
    const otherTenant = randomUUID();
    for (const id of [tenant,otherTenant]) await bootstrap(pool,{TENANT_ID:id,API_KEY:`synthetic-key-${id}`});
    const store = new PostgresStore(pool,master);
    for (const id of [tenant,otherTenant]) await store.configureApp(id,config);
    async function install(owner: string, shop: string, shopId: string, accessToken = 'synthetic-access') {
      const tokens = {shopId,authorizationId:randomUUID(),accessToken,refreshToken:'synthetic-refresh',
        expiresAt:Date.now()+3_600_000,refreshTokenExpiresAt:Date.now()+7_776_000_000,scopes:['write_products']};
      await store.withLock(`${owner}:${shop}`,() => store.save(owner,shop,tokens));
      return (await pool.query('SELECT * FROM connections WHERE tenant_id=$1 AND shop=$2',[owner,shop])).rows[0];
    }
    async function seedLegacy(owner: string, shop: string, shopId: string) {
      const tokens = {shopId,accessToken:'legacy-access',refreshToken:'legacy-refresh',
        expiresAt:Date.now()+3_600_000,refreshTokenExpiresAt:Date.now()+7_776_000_000,scopes:['write_products']};
      await pool.query('INSERT INTO shopify_shop_owners(client_id,shop,tenant_id) VALUES($1,$2,$3)',[config.clientId,shop,owner]);
      await pool.query(`INSERT INTO connections(id,tenant_id,shop,shopify_shop_id,token_ciphertext,scopes)
        VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),owner,shop,shopId,
        encryptSecret(JSON.stringify(tokens),master,`token:${owner}:${shop}`),tokens.scopes]);
    }
    async function snapshot() {
      return {
        connections:(await pool.query('SELECT * FROM connections ORDER BY id')).rows,
        owners:(await pool.query('SELECT * FROM shopify_shop_owners ORDER BY client_id,shop')).rows,
      };
    }
    return {pool,store,tenant,otherTenant,install,seedLegacy,snapshot,close:async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      if (directory) await rm(directory,{recursive:true,force:true});
    }};
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (directory) await rm(directory,{recursive:true,force:true});
    throw error;
  }
}

function reconciliation(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === 'IDENTITY_RECONCILIATION_REQUIRED' && error.status === 409;
}

test('stable app/shop identity rejects sequential aliases and preserves normal renewal, reinstall and other merchants',async () => {
  const f = await fixture();
  try {
    const first = await f.install(f.tenant,originalShop,'123');
    await f.install(f.otherTenant,otherShop,'456','unrelated-access');
    const before = await f.snapshot();
    await assert.rejects(f.install(f.otherTenant,aliasShop,'123'),reconciliation);
    await assert.rejects(f.install(f.tenant,aliasShop,'123'),reconciliation);
    await assert.rejects(f.install(f.tenant,originalShop,'999'),reconciliation);
    await assert.rejects(f.install(f.tenant,'invalid-id.myshopify.com',''),reconciliation);
    assert.deepEqual(await f.snapshot(),before);
    const renewed = await f.install(f.tenant,originalShop,'123','renewed-access');
    assert.equal(renewed.id,first.id);
    assert.notEqual(renewed.authorization_generation,first.authorization_generation);
    await f.store.withLock(`${f.tenant}:${originalShop}`,() => f.store.delete(f.tenant,originalShop));
    await assert.rejects(f.install(f.otherTenant,aliasShop,'123'),reconciliation);
    const reinstalled = await f.install(f.tenant,originalShop,'123','reinstalled-access');
    assert.equal(reinstalled.id,first.id);
    assert.equal(reinstalled.revoked_at,null);
    assert.equal((await f.store.get(f.otherTenant,otherShop))?.accessToken,'unrelated-access');
    const registry = (await f.pool.query('SELECT * FROM shopify_shop_id_owners ORDER BY shop_id')).rows;
    assert.equal(registry.length,2);
    assert.equal(registry[0].tenant_id,f.tenant);
    assert.equal(registry[0].shop,originalShop);
  } finally {await f.close();}
});

test('concurrent callbacks using different domains and tenants claim a stable app/shop identity exactly once',async () => {
  const f = await fixture();
  try {
    for (let index=0;index<6;index++) {
      const domains = [`owner-${index}.myshopify.com`,`alias-${index}.myshopify.com`];
      const owners = [f.tenant,f.otherTenant];
      const shopId = String(1000+index);
      const results = await Promise.allSettled(owners.map((owner,i) => f.install(owner,domains[i]!,shopId)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
      const failure = results.find(result => result.status === 'rejected');
      assert.ok(failure?.status === 'rejected' && reconciliation(failure.reason));
      const winner = results.findIndex(result => result.status === 'fulfilled');
      const registry = (await f.pool.query('SELECT * FROM shopify_shop_id_owners WHERE client_id=$1 AND shop_id=$2',[config.clientId,shopId])).rows;
      assert.equal(registry.length,1);
      assert.equal(registry[0].tenant_id,owners[winner]);
      assert.equal(registry[0].shop,domains[winner]);
      const connections = (await f.pool.query('SELECT tenant_id,shop FROM connections WHERE shopify_shop_id=$1',[shopId])).rows;
      assert.deepEqual(connections,[{tenant_id:owners[winner],shop:domains[winner]}]);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM shopify_shop_owners WHERE shop=ANY($1::text[])',[domains])).rows[0].n,1);
    }
  } finally {await f.close();}
});

test('the same numeric shop ID is independent across different Shopify app client IDs',async () => {
  const f = await fixture();
  try {
    await f.install(f.tenant,originalShop,'123');
    await f.store.configureApp(f.otherTenant,{...config,clientId:'different-app'});
    await f.install(f.otherTenant,otherShop,'123');
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM shopify_shop_id_owners WHERE shop_id=$1',['123'])).rows[0].n,2);
  } finally {await f.close();}
});

test('runtime OAuth callbacks expose actionable alias conflicts and preserve existing credentials',async () => {
  const f = await fixture();
  const runtime = createRuntime(f.pool,master,'https://gateway.example',false,{fetch:async url => {
    if (String(url).includes('/oauth/access_token')) return new Response(JSON.stringify({
      access_token:'new-alias-access',refresh_token:'new-alias-refresh',expires_in:3600,
      refresh_token_expires_in:7_776_000,scope:'write_products',
    }));
    return new Response(JSON.stringify({data:{shop:{id:'gid://shopify/Shop/123',myshopifyDomain:aliasShop}}}));
  }});
  try {
    await f.install(f.tenant,originalShop,'123');
    const before = await f.snapshot();
    const binding = 'B'.repeat(43);
    const started = await runtime.oauth.start({tenantId:f.otherTenant,shop:aliasShop,browserBinding:binding});
    const query = new URLSearchParams({shop:aliasShop,state:started.state,code:'synthetic-code',timestamp:String(Math.floor(Date.now()/1000))});
    const message = [...query.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,value]) => `${key}=${value}`).join('&');
    query.set('hmac',createHmac('sha256',config.clientSecret).update(message).digest('hex'));
    const response = await runtime.app.inject({url:'/oauth/shopify/callback?'+query,headers:{cookie:`__Host-shopify_oauth=${binding}`}});
    assert.equal(response.statusCode,409);
    assert.deepEqual(response.json(),{error:'SHOP_IDENTITY_RECONCILIATION_REQUIRED'});
    assert.deepEqual(await f.snapshot(),before);
    assert.equal((await f.store.get(f.tenant,originalShop))?.accessToken,'synthetic-access');
  } finally {await runtime.app.close();await f.close();}
});

test('legacy identity migration backfills unique owners and rolls back ambiguous aliases without changing any merchant',async () => {
  for (const ambiguous of [false,true]) {
    const f = await fixture(true);
    try {
      await f.seedLegacy(f.tenant,originalShop,'123');
      await f.seedLegacy(f.otherTenant,otherShop,ambiguous ? '123' : '456');
      const before = await f.snapshot();
      if (ambiguous) {
        await assert.rejects(migrate(f.pool),/SHOPIFY_IDENTITY_RECONCILIATION_REQUIRED/);
        assert.equal((await f.pool.query("SELECT to_regclass('shopify_shop_id_owners') AS registry")).rows[0].registry,null);
        assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='008.sql'")).rows[0].n,0);
      } else {
        await migrate(f.pool);
        const registry = (await f.pool.query('SELECT shop_id,tenant_id,shop FROM shopify_shop_id_owners ORDER BY shop_id')).rows;
        assert.deepEqual(registry,[{shop_id:'123',tenant_id:f.tenant,shop:originalShop},{shop_id:'456',tenant_id:f.otherTenant,shop:otherShop}]);
      }
      assert.deepEqual(await f.snapshot(),before);
    } finally {await f.close();}
  }
});

test('lifecycle aliases cannot erase a known merchant and verified redaction removes only its stable identifier',async () => {
  const f = await fixture();
  const runtime = createRuntime(f.pool,master,'https://gateway.example',false,{fetch:async () => new Response('{}',{status:401})});
  try {
    await f.install(f.tenant,originalShop,'123');
    const other = await f.install(f.otherTenant,otherShop,'456','unrelated-access');
    const before = await f.snapshot();
    async function send(topic: 'app-uninstalled'|'shop-redact',shop: string,shopId: number) {
      const payload = topic === 'app-uninstalled' ? {id:shopId,myshopify_domain:shop} : {shop_id:shopId,shop_domain:shop};
      const raw = Buffer.from(JSON.stringify(payload));
      return runtime.app.inject({method:'POST',url:`/webhooks/shopify/${config.clientId}/${topic}/${webhookBinding(config,topic)}`,
        headers:{'content-type':'application/json','x-shopify-topic':lifecycleTopics[topic],'x-shopify-shop-domain':shop,
          'x-shopify-hmac-sha256':createHmac('sha256',config.clientSecret).update(raw).digest('base64')},payload:raw});
    }
    assert.equal((await send('shop-redact',aliasShop,123)).statusCode,409);
    assert.deepEqual(await f.snapshot(),before);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM shopify_lifecycle_events')).rows[0].n,0);
    assert.equal((await send('app-uninstalled',originalShop,123)).statusCode,200);
    await runtime.lifecycle.reconcile();
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM shopify_shop_id_owners WHERE shop_id=$1',['123'])).rows[0].n,1);
    assert.equal((await send('shop-redact',originalShop,123)).statusCode,200);
    await runtime.lifecycle.reconcile();
    assert.deepEqual((await f.pool.query('SELECT * FROM shopify_shop_id_owners')).rows.map(row => ({shop_id:row.shop_id,tenant_id:row.tenant_id,shop:row.shop})),[{shop_id:'456',tenant_id:f.otherTenant,shop:otherShop}]);
    assert.deepEqual((await f.pool.query('SELECT * FROM connections WHERE id=$1',[other.id])).rows[0],other);
    assert.equal((await f.store.get(f.otherTenant,otherShop))?.accessToken,'unrelated-access');
  } finally {await runtime.app.close();await f.close();}
});

test('a queued erasure with inconsistent stable ownership becomes action required and preserves all merchant data',async () => {
  const f = await fixture();
  const runtime = createRuntime(f.pool,master,'https://gateway.example',false,{fetch:async () => new Response('{}',{status:401})});
  try {
    const connection = await f.install(f.tenant,originalShop,'123');
    const other = await f.install(f.otherTenant,otherShop,'456','unrelated-access');
    const raw = Buffer.from(JSON.stringify({shop_id:123,shop_domain:originalShop}));
    const eventId = await runtime.lifecycle.receive(config.clientId,'shop-redact',{shopId:'123',shop:originalShop},raw,
      webhookBinding(config,'shop-redact'),createHmac('sha256',config.clientSecret).update(raw).digest('base64'),originalShop);
    assert.ok(eventId);
    await f.pool.query('DELETE FROM shopify_shop_id_owners WHERE client_id=$1 AND shop_id=$2',[config.clientId,'123']);
    await runtime.lifecycle.process(eventId);
    const event = (await f.pool.query('SELECT status,last_error FROM shopify_lifecycle_events WHERE id=$1',[eventId])).rows[0];
    assert.deepEqual(event,{status:'action_required',last_error:'IDENTITY_RECONCILIATION_REQUIRED'});
    const held = (await f.pool.query('SELECT * FROM connections WHERE id=$1',[connection.id])).rows[0];
    assert.equal(held.revoked_at,null);
    assert.equal(held.token_ciphertext,connection.token_ciphertext);
    assert.equal(held.lifecycle_hold,true);
    assert.deepEqual((await f.pool.query('SELECT * FROM connections WHERE id=$1',[other.id])).rows[0],other);
  } finally {await runtime.app.close();await f.close();}
});

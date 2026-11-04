import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../src/crypto.js';
import { bootstrap, revokeApiKey, publicBaseUrl, runAdmin } from '../src/admin.js';
import { createRuntime, readBinding } from '../src/main.js';
import { cleanupExpiredOAuth, PostgresStore } from '../src/store.js';

const master = 'a1'.repeat(32);
const tenant = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const key = 'test-api-key-of-at-least-32-characters';
const hash = (value:string) => createHash('sha256').update(value).digest('hex');

test('secrets use random authenticated ciphertext bound to tenant and purpose', () => {
  const a = encryptSecret('access-token',master,`token:${tenant}:demo.myshopify.com`);
  assert.notEqual(a,encryptSecret('access-token',master,`token:${tenant}:demo.myshopify.com`));
  assert.ok(!a.includes('access-token'));
  assert.equal(decryptSecret(a,master,`token:${tenant}:demo.myshopify.com`),'access-token');
  assert.throws(() => decryptSecret(a,master,`token:${other}:demo.myshopify.com`),/authenticated/);
  assert.throws(() => decryptSecret(a,'b2'.repeat(32),`token:${tenant}:demo.myshopify.com`),/authenticated/);
  const parts = a.split('.'); parts[2] = 'A'.repeat(22);
  assert.throws(() => decryptSecret(parts.join('.'),master,`token:${tenant}:demo.myshopify.com`),/authenticated/);
  assert.throws(() => encryptSecret('value','bad','test'),/64 hexadecimal/);
});

test('bootstrap stores only a hash, commits idempotently and rejects ownership conflicts transactionally', async () => {
  for (const owner of [tenant,other]) {
    const calls: { sql:string; values?:unknown[] }[] = [];
    const client = { query:async (sql:string,values?:unknown[]) => {
      calls.push({sql,values}); return {rows:sql.startsWith('SELECT') ? [{tenant_id:owner,revoked_at:null}] : []};
    }, release() {} };
    const pool = { connect:async () => client } as unknown as Pool;
    const work = bootstrap(pool,{TENANT_ID:tenant,API_KEY:key});
    if (owner === tenant) await work; else await assert.rejects(work,/another tenant/);
    const insert = calls.find(call => call.sql.startsWith('INSERT INTO api_keys'))!;
    assert.equal(insert.values?.[1],hash(key));
    assert.ok(!JSON.stringify(calls).includes(key));
    assert.equal(calls.at(-1)?.sql,owner === tenant ? 'COMMIT' : 'ROLLBACK');
  }
});

test('public origin and browser cookies reject ambiguous or unsafe values', () => {
  assert.equal(publicBaseUrl('https://gateway.example/'),'https://gateway.example');
  for (const value of ['http://gateway.example','https://gateway.example/path','https://user:pass@gateway.example','https://gateway.example?secret=x']) assert.throws(() => publicBaseUrl(value));
  const binding = 'a'.repeat(43);
  assert.equal(readBinding(`other=x; __Host-shopify_oauth=${binding}`),binding);
  assert.equal(readBinding(`__Host-shopify_oauth=${binding}; __Host-shopify_oauth=${binding}`),'');
  assert.equal(readBinding('__Host-shopify_oauth=short'),'');
});

test('key revocation scopes updates to tenant and hashes raw key',async () => {
  let values:unknown[] = [];
  let sql = '';
  const pool = {query:async (query:string,params:unknown[]) => {sql=query; values=params; return {rows:[{id:'key-id'}]};}} as unknown as Pool;
  await revokeApiKey(pool,{TENANT_ID:tenant,API_KEY:key});
  assert.match(sql,/WHERE tenant_id=\$1 AND token_hash=\$2/);
  assert.deepEqual(values,[tenant,hash(key)]);
  await assert.rejects(revokeApiKey({query:async () => ({rows:[]})} as unknown as Pool,{TENANT_ID:other,API_KEY:key}),/not found for this tenant/);
});

test('backend connect issues one-use browser ticket; browser start sets secure binding before consent', async () => {
  let ticketHash = '';
  let savedState: unknown[] | undefined;
  const tickets = new Map<string,any>();
  const queries: string[] = [];
  const pool = { query:async (sql:string,values:unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('FROM api_keys')) return {rows:values[0] === hash(key) ? [{tenant_id:tenant}] : []};
    if (sql.includes('FROM shopify_apps')) return {rows:[{tenant_id:tenant,client_id:'app-id',secret_ciphertext:encryptSecret('client-secret',master,`app:${tenant}`),redirect_uri:'https://gateway.example/oauth/shopify/callback',scopes:['write_products'],allowed_return_urls:['https://client.example/done']}]};
    if (sql.startsWith('INSERT INTO oauth_browser_starts')) {
      ticketHash = values[0] as string;
      tickets.set(ticketHash,{tenant_id:values[1],shop:values[2],return_url:values[3]}); return {rows:[]};
    }
    if (sql.startsWith('DELETE FROM oauth_browser_starts')) {
      const row = tickets.get(values[0] as string); tickets.delete(values[0] as string); return {rows:row ? [row] : []};
    }
    if (sql.startsWith('INSERT INTO oauth_states')) { savedState = values; return {rows:[]}; }
    if (sql.includes('FROM oauth_states')) return {rows:[]};
    throw new Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Pool;
  const {app} = createRuntime(pool,master,'https://gateway.example');
  try {
    const unauthorized = await app.inject({method:'POST',url:'/v1/shopify/connect',payload:{shop:'demo.myshopify.com'}});
    assert.equal(unauthorized.statusCode,401);
    const connected = await app.inject({method:'POST',url:'/v1/shopify/connect',headers:{authorization:`Bearer ${key}`},payload:{shop:'demo.myshopify.com',returnUrl:'https://client.example/done'}});
    assert.equal(connected.statusCode,200);
    const response = connected.json();
    assert.deepEqual(Object.keys(response).sort(),['browserStartUrl','expiresIn']);
    const url = new URL(response.browserStartUrl);
    assert.equal(ticketHash,hash(url.searchParams.get('ticket')!));
    const started = await app.inject({method:'GET',url:url.pathname+url.search});
    assert.equal(started.statusCode,302);
    assert.match(started.headers.location!,/^https:\/\/demo\.myshopify\.com\/admin\/oauth\/authorize\?/);
    const cookie = started.headers['set-cookie'] as string;
    assert.match(cookie,/^__Host-shopify_oauth=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const binding = readBinding(cookie);
    assert.equal(savedState?.[3],hash(binding));
    assert.equal(savedState?.[1],tenant);
    assert.ok(!JSON.stringify(savedState).includes(binding));
    const replay = await app.inject({method:'GET',url:url.pathname+url.search});
    assert.equal(replay.statusCode,403);
    const forged = await app.inject({method:'GET',url:'/oauth/shopify/callback?state='+ 'b'.repeat(43)+'&shop=demo.myshopify.com'});
    assert.equal(forged.statusCode,403);
    assert.ok(!forged.body.includes('client-secret'));
  } finally { await app.close(); }
});

test('cross-process refresh lock verifies app/shop ownership before invoking exchange and always releases', async () => {
  const calls: {sql:string;values:unknown[]}[] = [];
  let released = false;
  const client = { query:async (sql:string,values:unknown[] = []) => {
    calls.push({sql,values});
    if (sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
    if (sql.includes('FROM shopify_apps')) return {rows:[{client_id:'shared-app'}]};
    if (sql.includes('FROM shopify_shop_owners')) return {rows:[{tenant_id:other}]};
    return {rows:[]};
  }, release() {released=true;} };
  const store = new PostgresStore({connect:async () => client} as unknown as Pool,master);
  let exchanged = false;
  await assert.rejects(store.withLock(`${tenant}:demo.myshopify.com`,async () => {exchanged=true;}),/another tenant/);
  assert.equal(exchanged,false); assert.equal(released,true);
  assert.deepEqual(calls.filter(call => call.sql.includes('pg_advisory_unlock')).map(call => call.values[0]),[`shopify-owner:shared-app:demo.myshopify.com`,`shopify:${tenant}`]);
  await assert.rejects(store.save(tenant,'demo.myshopify.com',{} as any),/distributed lock/);
});

test('admin help works without database or secret environment', async () => {
  await runAdmin(['--help'],{});
  await assert.rejects(runAdmin(['invalid'],{}),/Unknown command/);
});

test('OAuth orphan cleanup uses a bounded database-time batch and preserves operation history',async () => {
  let sql = ''; let values:unknown[] = [];
  const pool = {query:async (query:string,params:unknown[]) => {sql=query;values=params;return {rows:[{states:3,browser_starts:2}]};}} as unknown as Pool;
  assert.deepEqual(await cleanupExpiredOAuth(pool,25),{states:3,browserStarts:2});
  assert.deepEqual(values,[25]);
  assert.match(sql,/expires_at <= statement_timestamp\(\)/);
  assert.equal((sql.match(/LIMIT \$1 FOR UPDATE SKIP LOCKED/g) ?? []).length,2);
  assert.ok(!sql.includes('operations'));
  await assert.rejects(cleanupExpiredOAuth(pool,0),/batch/);
  await assert.rejects(cleanupExpiredOAuth(pool,10001),/batch/);
});

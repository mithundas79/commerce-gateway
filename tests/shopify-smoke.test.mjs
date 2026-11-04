import assert from 'node:assert/strict';
import test from 'node:test';
import { runShopifySmoke,smokeConfig } from '../scripts/shopify-smoke.mjs';

const connection='20000000-0000-4000-8000-000000000001';
const product='gid://shopify/Product/123';
const env={SHOPIFY_SMOKE_ALLOW_MUTATION:'1',SHOPIFY_SMOKE_EXPECTED_DEV_STORE:'disposable.myshopify.com',
  SHOPIFY_SMOKE_DISPOSABLE_ACK:'disposable.myshopify.com',SHOPIFY_SMOKE_GATEWAY_ORIGIN:'https://gateway.example.com',
  SHOPIFY_SMOKE_BEARER:'secret-bearer-never-log',SHOPIFY_SMOKE_CONNECTION_ID:connection,
  SHOPIFY_SMOKE_RUN_ID:'30000000-0000-4000-8000-000000000001',SHOPIFY_SMOKE_PRODUCT_GID:product,
  SHOPIFY_SMOKE_ORIGINAL_TITLE:'Exact original test title',SHOPIFY_SMOKE_WAIT_MS:'1000',SHOPIFY_SMOKE_POLL_MS:'1000'};

function fixture(mode='success') {
  const config=smokeConfig(env),jobs=new Map(),requests=[],writes=[];
  let title=config.originalTitle,readErrors=0;
  const response=(body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const fetch=async(value,options) => {
    const url=new URL(value);requests.push({url,options});
    assert.equal(url.origin,config.origin);assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,`Bearer ${env.SHOPIFY_SMOKE_BEARER}`);assert.ok(options.signal instanceof AbortSignal);
    if(url.pathname==='/v1/connections') return response({connections:[{id:connection,shop:mode==='wrong-shop'?'other.myshopify.com':config.shop,scopes:['read_products','write_products']}],pageInfo:{hasNextPage:false,endCursor:connection}});
    if(url.pathname===`/v1/connections/${connection}/products`) {
      if(mode==='readback-network-error' && title===config.temporaryTitle && readErrors++<3) throw new Error('secret network error');
      return response({products:[{id:'gid://shopify/Product/999',title:'Never mutate this product'},{id:product,title}],pageInfo:{hasNextPage:false,endCursor:null}});
    }
    if(url.pathname===`/v1/connections/${connection}/product-title-updates`) {
      const payload=JSON.parse(options.body),key=options.headers['idempotency-key'];writes.push({payload,key});
      assert.equal(payload.productId,product);assert.deepEqual(Object.keys(payload).sort(),['productId','title']);
      let operation=jobs.get(key),replayed=Boolean(operation);
      if(!operation || mode==='broken-idempotency') {
        operation={id:`40000000-0000-4000-8000-${(jobs.size+1).toString(16).padStart(12,'0')}`,connectionId:connection,kind:'product_title_update',status:'queued',payload,key};
        jobs.set(mode==='broken-idempotency'?key+':'+jobs.size:key,operation);
      }
      if(mode==='unknown-dispatch' && key.endsWith(':temporary')) throw new Error('key='+env.SHOPIFY_SMOKE_BEARER);
      return response({operation,replayed},202);
    }
    if(url.pathname.startsWith('/v1/operations/')) {
      const operation=[...jobs.values()].find(job => job.id===url.pathname.split('/').at(-1));assert.ok(operation);
      const temporary=operation.key.includes(':temporary');
      if(mode==='pending' && temporary) operation.status='running';
      else if(mode==='uncertain-unapplied' && temporary) operation.status='uncertain';
      else if(['uncertain-applied','uncertain-released'].includes(mode) && temporary) {
        operation.status='uncertain';title=operation.payload.title;
        if(mode==='uncertain-released') operation.orderingReleasedAt='2026-11-04T00:00:00Z';
      } else if(mode==='definitive-failure' && temporary) operation.status='failed';
      else {operation.status='succeeded';title=operation.payload.title;}
      if(mode==='external-change' && temporary) title='Another writer changed this title';
      return response({operation});
    }
    throw new Error('Unexpected mock request');
  };
  return {requests,writes,jobs,config,fetch,sleep:async() => {},getTitle:() => title,setTitle:value => {title=value;}};
}

test('live smoke requires exact opt-in, disposable shop acknowledgement, HTTPS origin, IDs and original title',() => {
  for(const override of [{SHOPIFY_SMOKE_ALLOW_MUTATION:'0'},{SHOPIFY_SMOKE_DISPOSABLE_ACK:'other.myshopify.com'},
    {SHOPIFY_SMOKE_GATEWAY_ORIGIN:'http://gateway.example.com'},{SHOPIFY_SMOKE_GATEWAY_ORIGIN:'https://user:secret@gateway.example.com'},
    {SHOPIFY_SMOKE_GATEWAY_ORIGIN:'https://gateway.example.com/path'},{SHOPIFY_SMOKE_PRODUCT_GID:'123'},
    {SHOPIFY_SMOKE_CONNECTION_ID:'not-a-uuid'},{SHOPIFY_SMOKE_RUN_ID:''},{SHOPIFY_SMOKE_ORIGINAL_TITLE:''}]) {
    assert.throws(() => smokeConfig({...env,...override}));
  }
});

test('successful acceptance writes only exact target, proves idempotent replay and restores/readbacks original',async() => {
  const f=fixture(),report=await runShopifySmoke(env,f);
  assert.equal(report.passed,true);assert.equal(report.restored,true);assert.equal(report.manualReconciliationRequired,false);
  assert.equal(f.getTitle(),env.SHOPIFY_SMOKE_ORIGINAL_TITLE);assert.equal(f.writes.length,3);
  assert.equal(f.writes[0].key,f.writes[1].key);assert.notEqual(f.writes[1].key,f.writes[2].key);
  assert.equal(f.jobs.size,2);assert.equal(report.temporaryOperationIds.length,1);assert.ok(report.restoreOperationId);
  const log=JSON.stringify(report);for(const secret of [env.SHOPIFY_SMOKE_BEARER,env.SHOPIFY_SMOKE_GATEWAY_ORIGIN,env.SHOPIFY_SMOKE_ORIGINAL_TITLE,f.config.temporaryTitle]) assert.equal(log.includes(secret),false);
});

test('shop or exact original title mismatch prevents every write',async() => {
  for(const mode of ['wrong-shop','wrong-title']) {
    const f=fixture(mode);if(mode==='wrong-title') f.setTitle('Unexpected current title');
    const report=await runShopifySmoke(env,f);assert.equal(report.passed,false);assert.equal(f.writes.length,0);
    assert.equal(report.manualReconciliationRequired,false);
  }
});

test('temporary readback failure still executes safe restore and records failed acceptance',async() => {
  const f=fixture('readback-network-error'),report=await runShopifySmoke(env,f);
  assert.equal(report.passed,false);assert.equal(report.restored,true);assert.equal(report.error,'GATEWAY_REQUEST_UNCONFIRMED');
  assert.equal(f.getTitle(),env.SHOPIFY_SMOKE_ORIGINAL_TITLE);assert.equal(f.writes.at(-1).payload.title,env.SHOPIFY_SMOKE_ORIGINAL_TITLE);
});

test('pending or unknown temporary operations never enqueue a restore that could race a late write',async() => {
  for(const mode of ['pending','unknown-dispatch']) {
    const f=fixture(mode),report=await runShopifySmoke(env,f);
    assert.equal(report.passed,false);assert.equal(report.manualReconciliationRequired,true);assert.equal(report.restoreOperationId,null);
    assert.ok(f.writes.every(write => write.key.endsWith(':temporary')));
    if(mode==='unknown-dispatch') {assert.equal(f.writes.length,3);assert.equal(new Set(f.writes.map(w => w.key)).size,1);}
  }
});

test('uncertain outcomes require admin ordering release and unique marker readback before restore',async() => {
  for(const mode of ['uncertain-unapplied','uncertain-applied']) {
    const f=fixture(mode),report=await runShopifySmoke(env,f);
    assert.equal(report.passed,false);assert.equal(report.manualReconciliationRequired,true);assert.equal(report.restoreOperationId,null);
    assert.equal(f.writes.length,2);
  }
  const reconciled=fixture('uncertain-released'),report=await runShopifySmoke(env,reconciled);
  assert.equal(report.passed,true);assert.equal(report.restored,true);assert.equal(reconciled.getTitle(),env.SHOPIFY_SMOKE_ORIGINAL_TITLE);
});

test('external product edits are preserved and reported for manual reconciliation',async() => {
  const f=fixture('external-change'),report=await runShopifySmoke(env,f);
  assert.equal(report.passed,false);assert.equal(report.manualReconciliationRequired,true);assert.equal(report.error,'EXTERNAL_TITLE_CHANGE_DETECTED');
  assert.equal(f.getTitle(),'Another writer changed this title');assert.equal(f.writes.length,2);
});

test('idempotency failure settles all known temporary operations before restoring and still fails acceptance',async() => {
  const f=fixture('broken-idempotency'),report=await runShopifySmoke(env,f);
  assert.equal(report.passed,false);assert.equal(report.error,'IDEMPOTENCY_VERIFICATION_FAILED');assert.equal(report.restored,true);
  assert.equal(report.temporaryOperationIds.length,2);assert.equal(f.getTitle(),env.SHOPIFY_SMOKE_ORIGINAL_TITLE);
});

test('resume uses the same run marker and idempotency key after original outcome is reconciled',async() => {
  const f=fixture();f.setTitle(f.config.temporaryTitle);
  const denied=await runShopifySmoke(env,f);assert.equal(denied.passed,false);assert.equal(f.writes.length,0);
  const report=await runShopifySmoke({...env,SHOPIFY_SMOKE_RESUME:'1'},f);
  assert.equal(report.passed,true);assert.equal(report.restored,true);
  assert.equal(f.writes[0].key,`smoke:${env.SHOPIFY_SMOKE_RUN_ID}:temporary`);
});

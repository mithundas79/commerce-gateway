import assert from 'node:assert/strict';
import test from 'node:test';
import { browserStart, completedRunStatus, labOptions, localGatewayFetch, shopifySettings } from '../release/windows-lab.mjs';

const argumentsForLab=['--settings','C:/private/source.env','--origin','https://gateway.example.com',
  '--shop','disposable.myshopify.com','--bash','C:/Program Files/Git/bin/bash.exe'];

test('settings loader selects only Shopify app settings and treats shell expressions literally',()=>{
  const values=shopifySettings(`DATABASE_URL=secret-database\nMASTER_KEY=unrelated-secret\nSHOPIFY_CLIENT_ID=client-id\nSHOPIFY_CLIENT_SECRET='$(throw secret)'\n`);
  assert.deepEqual(values,{SHOPIFY_CLIENT_ID:'client-id',SHOPIFY_CLIENT_SECRET:'$(throw secret)',SHOPIFY_SCOPES:'write_products'});
  assert.equal(Object.hasOwn(values,'DATABASE_URL'),false);
  assert.equal(Object.hasOwn(values,'MASTER_KEY'),false);
});

test('settings loader accepts quoted literal values and export without evaluating them',()=>{
  assert.deepEqual(shopifySettings('\uFEFFexport SHOPIFY_CLIENT_ID="app-id"\r\nSHOPIFY_CLIENT_SECRET="${UNRELATED_SECRET}"\r\nSHOPIFY_SCOPES=read_products,write_products'),
    {SHOPIFY_CLIENT_ID:'app-id',SHOPIFY_CLIENT_SECRET:'${UNRELATED_SECRET}',SHOPIFY_SCOPES:'read_products,write_products'});
});

test('settings loader rejects duplicates, oversized data, missing secret, and multiline quoting',()=>{
  for(const value of [
    'SHOPIFY_CLIENT_ID=a\nSHOPIFY_CLIENT_ID=b\nSHOPIFY_CLIENT_SECRET=c',
    'x'.repeat(65_537),
    'SHOPIFY_CLIENT_ID=a',
    'SHOPIFY_CLIENT_ID=a\nSHOPIFY_CLIENT_SECRET="line\nbreak"',
    'SHOPIFY_CLIENT_ID=a\nSHOPIFY_CLIENT_SECRET=c\nSHOPIFY_SCOPES=read_products',
  ]) assert.throws(()=>shopifySettings(value));
});

test('setup defaults to no mutation and requires a canonical HTTPS origin and exact shop',()=>{
  assert.equal(labOptions(argumentsForLab)['--mutate'],undefined);
  for(const origin of ['http://gateway.example.com','https://gateway.example.com/','https://user:password@gateway.example.com','https://gateway.example.com/path','https://gateway.example.com?next=secret']) {
    const args=[...argumentsForLab];args[3]=origin;assert.throws(()=>labOptions(args));
  }
  for(const shop of ['disposable.myshopify.com.evil.test','https://disposable.myshopify.com','DISPOSABLE.myshopify.com']) {
    const args=[...argumentsForLab];args[5]=shop;assert.throws(()=>labOptions(args));
  }
  assert.throws(()=>labOptions([...argumentsForLab,'--resume']));
  assert.throws(()=>labOptions([...argumentsForLab,'--new-run']));
  assert.throws(()=>labOptions([...argumentsForLab,'--settings','other.env']));
});

test('mutation input reuses all existing smoke guards before installation',()=>{
  const mutation=[...argumentsForLab,'--mutate','--ack','disposable.myshopify.com','--product','gid://shopify/Product/123','--title','Exact disposable product'];
  assert.equal(labOptions(mutation)['--mutate'],true);
  assert.equal(labOptions([...mutation,'--new-run'])['--new-run'],true);
  assert.throws(()=>labOptions([...mutation,'--new-run','--resume']));
  for(const [index,value] of [[11,'other.myshopify.com'],[13,'123'],[15,'']]) {
    const args=[...mutation];args[index]=value;assert.throws(()=>labOptions(args));
  }
  assert.throws(()=>labOptions([...argumentsForLab,'--mutate']));
});

test('authenticated smoke transport always uses literal loopback and refuses redirects',async()=>{
  const calls=[];
  const request=localGatewayFetch('https://gateway.example.com','3000',async(url,init)=>{calls.push({url,init});return 'response';});
  assert.equal(await request('https://gateway.example.com/v1/connections?first=100',{headers:{authorization:'Bearer offline-test-key'},redirect:'follow'}),'response');
  assert.equal(calls[0].url,'http://127.0.0.1:3000/v1/connections?first=100');
  assert.equal(calls[0].init.redirect,'error');
  assert.equal(calls[0].init.headers.authorization,'Bearer offline-test-key');
  await request('https://gateway.example.com//evil.example.com/path');
  assert.equal(new URL(calls[1].url).hostname,'127.0.0.1');
  for(const value of ['https://evil.example.com/v1/connections','http://gateway.example.com/v1/connections','https://user:password@gateway.example.com/v1/connections']) assert.throws(()=>request(value));
  assert.equal(calls.length,2);
  for(const port of ['0','65536','3000/path','3000@evil.example.com']) assert.throws(()=>localGatewayFetch('https://gateway.example.com',port));
});

test('cached success is explicitly historical and carries no fresh passed assertion',()=>{
  const report=completedRunStatus({runId:'offline-run',report:{passed:true,restored:true}});
  assert.equal(report.historical,true);
  assert.equal(report.freshAcceptance,false);
  assert.equal(report.lastRunPassed,true);
  assert.equal(Object.hasOwn(report,'passed'),false);
});

test('only a same-origin single-use browser start is allowed to reach the browser',()=>{
  const origin='https://gateway.example.com';
  const valid=origin+'/oauth/shopify/start?ticket='+'a'.repeat(43);
  assert.equal(browserStart(valid,origin),valid);
  for(const value of [valid.replace(origin,'https://evil.example.com'),valid+'&extra=value',valid+'&ticket='+'b'.repeat(43),valid+'#fragment',origin+'/v1/shopify/connect?ticket='+'a'.repeat(43),origin+'/oauth/shopify/start?ticket=short']) assert.throws(()=>browserStart(value,origin));
});

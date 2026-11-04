import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserStart, completedRunStatus, labOptions, localGatewayFetch, runLab, shopifySettings } from '../release/windows-lab.mjs';

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

test('prepare-only rejects every mutation and recovery argument before installation',()=>{
  assert.equal(labOptions([...argumentsForLab,'--prepare-only'])['--prepare-only'],true);
  for(const args of [['--mutate'],['--resume'],['--new-run'],['--ack','disposable.myshopify.com'],['--product','gid://shopify/Product/123'],['--title','Exact title']]) {
    assert.throws(()=>labOptions([...argumentsForLab,'--prepare-only',...args]),/PREPARE_ONLY_CONFLICTS_WITH_MUTATION_OR_RECOVERY/);
  }
});

test('prepare-only executes setup and exits before OAuth, browser, polling, and smoke',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'commerce-gateway-prepare-test-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    await rm(directory,{recursive:true,force:true});
  });
  const tenant='11111111-1111-4111-8111-111111111111',bearer='a'.repeat(64);
  await mkdir(join(directory,'.secrets'));
  await writeFile(join(directory,'.env'),`TENANT_ID=${tenant}\nHOST_PORT=3000\n`);
  await writeFile(join(directory,'.secrets/bootstrap-api-key'),bearer);
  const settings=join(directory,'shopify-settings.env');
  await writeFile(settings,'SHOPIFY_CLIENT_ID=offline-app-id\nSHOPIFY_CLIENT_SECRET=offline-app-secret\nUNRELATED=ignore-this-value\n');
  const args=[...argumentsForLab,'--prepare-only'];args[1]=settings;
  const stages=[],reports=[];
  t.mock.method(console,'log',value=>reports.push(JSON.parse(value)));
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://gateway.example.com/readyz');
    assert.equal(init.headers.authorization,undefined);
    assert.equal(init.redirect,'error');
    stages.push('public-ready');return new Response('{}');
  });
  const command=async(name,args,options)=>{
    if(name===argumentsForLab[7]) {assert.equal(options.capture,true);stages.push('install');return '';}
    assert.equal(name,'docker');
    if(args[0]==='ps' || args[0]==='volume') return '';
    const admin=args.at(-1);
    assert.ok(['migrate','bootstrap','configure-shopify'].includes(admin));stages.push(admin);
    if(admin==='bootstrap') assert.equal(options.env.API_KEY,bearer);
    if(admin==='configure-shopify') {
      assert.equal(options.env.SHOPIFY_CLIENT_SECRET,'offline-app-secret');
      assert.equal(options.env.UNRELATED,undefined);
      assert.equal(options.env.SHOPIFY_RETURN_URLS,'');
    }
    assert.equal(args.includes(bearer),false);
    assert.equal(args.includes('offline-app-secret'),false);
    return '';
  };
  const report=await runLab(labOptions(args),{root:directory,platform:'win32',execute:command});
  assert.deepEqual(stages,['install','migrate','bootstrap','public-ready','configure-shopify']);
  assert.deepEqual(report,{acceptance:'windows-disposable-lab-setup',prepared:true,callbackUrl:'https://gateway.example.com/oauth/shopify/callback'});
  assert.deepEqual(reports,[report]);
  assert.deepEqual(await readdir(join(directory,'.secrets')),['bootstrap-api-key']);
  assert.equal((await readFile(join(directory,'.env'),'utf8')).includes('offline-app-secret'),false);
  const statePath=join(directory,'.secrets/windows-lab-run.json');
  const completedState={smokeStarted:true,report:{passed:true,restored:true}};
  await writeFile(statePath,JSON.stringify(completedState));
  stages.length=0;reports.length=0;
  assert.deepEqual(await runLab(labOptions(args),{root:directory,platform:'win32',execute:command}),report);
  assert.deepEqual(stages,['install','migrate','bootstrap','public-ready','configure-shopify']);
  assert.deepEqual(JSON.parse(await readFile(statePath,'utf8')),completedState);
  await writeFile(statePath,JSON.stringify({smokeStarted:true,report:{passed:false,restored:false}}));
  stages.length=0;reports.length=0;
  await assert.rejects(runLab(labOptions(args),{root:directory,platform:'win32',execute:command}),/PRIOR_RUN_REQUIRES_EXPLICIT_RESUME_AND_RECONCILIATION/);
  assert.deepEqual(stages,[]);
  assert.deepEqual(reports,[]);
});

test('PowerShell prepare-only wrapper preserves its handoff and rejects conflicting parameters',{skip:process.platform!=='win32'},()=>{
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const invoke=args=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{cwd:repo,encoding:'utf8',windowsHide:true});
  const prepared=invoke(['-File','tests/windows-lab-wrapper.test.ps1','-PrepareOnly']);
  assert.equal(prepared.status,0);
  assert.match(prepared.stdout,/WINDOWS_LAB_WRAPPER_ARGUMENTS_PASSED/);
  for(const conflict of [['-AllowMutation'],['-Resume'],['-NewRun'],['-DisposableStoreAck','disposable.myshopify.com'],['-ProductGid','gid://shopify/Product/123'],['-OriginalTitle','Exact title']]) {
    const result=invoke(['-File','release/windows-lab.ps1','-ShopifyEnvPath','C:/offline-nonexistent.env','-PublicOrigin','https://gateway.example.com','-Shop','disposable.myshopify.com','-PrepareOnly',...conflict]);
    assert.equal(result.status,1);
    assert.match(result.stderr,/PREPARE_ONLY_CONFLICTS_WITH_MUTATION_OR_RECOVERY/);
  }
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

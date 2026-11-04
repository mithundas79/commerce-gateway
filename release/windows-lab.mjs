import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShopifySmoke, smokeConfig } from '../scripts/shopify-smoke.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const settingsKeys=new Set(['SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_SCOPES']);
const fail=code => {throw new Error(code);};

// Parse a small literal dotenv subset. Values are never evaluated or interpolated.
export function shopifySettings(text) {
  if(Buffer.byteLength(text)>65_536) fail('SETTINGS_FILE_TOO_LARGE');
  const result={};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if(!match || !settingsKeys.has(match[1])) continue;
    const key=match[1];let value=match[2].trim();
    if(Object.hasOwn(result,key)) fail('DUPLICATE_SHOPIFY_SETTING');
    if(value.startsWith('"') || value.startsWith("'")) {
      const quote=value[0];
      if(value.length<2 || value.at(-1)!==quote || value.slice(1,-1).includes(quote)) fail('UNSUPPORTED_SHOPIFY_SETTING_FORMAT');
      value=value.slice(1,-1);
    } else if(/\s/.test(value)) fail('UNSUPPORTED_SHOPIFY_SETTING_FORMAT');
    if(!value || /[\u0000-\u001f\u007f]/.test(value) || value.length>4096) fail('INVALID_SHOPIFY_SETTING');
    result[key]=value;
  }
  if(!result.SHOPIFY_CLIENT_ID || !result.SHOPIFY_CLIENT_SECRET) fail('SHOPIFY_APP_CREDENTIALS_REQUIRED');
  result.SHOPIFY_SCOPES ??= 'write_products';
  const scopes=result.SHOPIFY_SCOPES.split(',').map(x=>x.trim());
  if(!scopes.includes('write_products') || scopes.some(x=>!/^[a-z][a-z0-9_]*$/.test(x))) fail('PRODUCT_WRITE_SCOPE_REQUIRED');
  return result;
}

export function labOptions(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    const name=args[i];
    if(!['--settings','--origin','--shop','--bash','--mutate','--ack','--product','--title','--resume','--new-run'].includes(name) || Object.hasOwn(options,name)) fail('INVALID_LAB_ARGUMENTS');
    options[name]=['--mutate','--resume','--new-run'].includes(name)?true:args[++i];
    if(options[name]===undefined) fail('INVALID_LAB_ARGUMENTS');
  }
  let url;
  try {url=new URL(options['--origin']);} catch {fail('VERIFIED_HTTPS_ORIGIN_REQUIRED');}
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash
    || options['--origin']!==url.origin) fail('VERIFIED_HTTPS_ORIGIN_REQUIRED');
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(options['--shop']??'')) fail('EXACT_SHOP_REQUIRED');
  if(!options['--settings'] || !options['--bash']) fail('SETTINGS_AND_GIT_BASH_PATH_REQUIRED');
  if(options['--resume'] && !options['--mutate']) fail('RESUME_REQUIRES_MUTATION_OPT_IN');
  if(options['--new-run'] && (!options['--mutate'] || options['--resume'])) fail('NEW_RUN_REQUIRES_MUTATION_OPT_IN_WITHOUT_RESUME');
  if(options['--mutate']) smokeConfig(smokeEnvironment(options,'a'.repeat(64),randomUUID(),randomUUID()));
  return options;
}

function smokeEnvironment(options,bearer,connectionId,runId) {
  return {SHOPIFY_SMOKE_GATEWAY_ORIGIN:options['--origin'],SHOPIFY_SMOKE_BEARER:bearer,
    SHOPIFY_SMOKE_EXPECTED_DEV_STORE:options['--shop'],SHOPIFY_SMOKE_DISPOSABLE_ACK:options['--ack'],
    SHOPIFY_SMOKE_ALLOW_MUTATION:options['--mutate']?'1':'0',SHOPIFY_SMOKE_CONNECTION_ID:connectionId,
    SHOPIFY_SMOKE_PRODUCT_GID:options['--product'],SHOPIFY_SMOKE_ORIGINAL_TITLE:options['--title'],
    SHOPIFY_SMOKE_RUN_ID:runId,SHOPIFY_SMOKE_RESUME:options['--resume']?'1':'0'};
}

export function browserStart(value,origin) {
  let url;
  try {url=new URL(value);} catch {fail('INVALID_BROWSER_START');}
  if(url.origin!==origin || url.pathname!=='/oauth/shopify/start' || url.username || url.password || url.hash
    || [...url.searchParams.keys()].join(',')!=='ticket' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('ticket')??'')) fail('INVALID_BROWSER_START');
  return url.href;
}

// Preserve the smoke command's public HTTPS URL validation while confining its
// authenticated transport to this Windows host's installed loopback service.
export function localGatewayFetch(publicOrigin,port,request=fetch) {
  if(!/^[0-9]{1,5}$/.test(port) || Number(port)<1 || Number(port)>65535) fail('INVALID_INSTALL_HOST_PORT');
  const localOrigin=`http://127.0.0.1:${Number(port)}`;
  return (value,init={})=>{
    const source=new URL(value);
    if(source.origin!==publicOrigin || source.username || source.password || source.hash) fail('UNEXPECTED_SMOKE_REQUEST_ORIGIN');
    const target=new URL(localOrigin);target.pathname=source.pathname;target.search=source.search;
    return request(target.href,{...init,redirect:'error'});
  };
}

export function completedRunStatus(state) {
  return {acceptance:'windows-disposable-lab-history',historical:true,freshAcceptance:false,
    lastRunPassed:true,restored:true,runId:state.runId};
}

function execute(command,args,{env=process.env,capture=false}={}) {
  return new Promise((resolvePromise,reject) => {
    const child=spawn(command,args,{cwd:root,env,windowsHide:true,shell:false,stdio:['ignore',capture?'pipe':'inherit','pipe']});
    let output='';
    if(capture) child.stdout.on('data',chunk=>{output+=chunk;if(output.length>262_144) child.kill();});
    // External failures get fixed error codes. Child stderr may include settings.
    child.stderr.on('data',()=>{});
    child.on('error',()=>reject(new Error('LAB_COMMAND_UNAVAILABLE')));
    child.on('close',code=>code===0?resolvePromise(output):reject(new Error('LAB_COMMAND_FAILED')));
  });
}

async function jsonRequest(origin,path,bearer,init={}) {
  try {
    const response=await fetch(origin+path,{...init,redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{'content-type':'application/json',...(bearer?{authorization:`Bearer ${bearer}`}:{})}});
    if(!response.ok) fail('GATEWAY_REQUEST_FAILED');
    const text=await response.text();if(text.length>2_097_152) fail('GATEWAY_RESPONSE_TOO_LARGE');
    return JSON.parse(text);
  } catch {fail('GATEWAY_REQUEST_FAILED');}
}

async function exactConnection(options,bearer,localOrigin) {
  let after;const cursors=new Set();
  for(let page=0;page<100;page++) {
    const body=await jsonRequest(localOrigin,'/v1/connections?first=100'+(after?'&after='+encodeURIComponent(after):''),bearer);
    if(!Array.isArray(body.connections)) fail('INVALID_CONNECTION_RESPONSE');
    const matching=body.connections.filter(row=>row.shop===options['--shop']);
    if(matching.length>1) fail('AMBIGUOUS_SHOP_CONNECTION');
    if(matching.length) {
      const row=matching[0];
      if(!uuid.test(row.id??'') || !Array.isArray(row.scopes) || !row.scopes.includes('write_products')
        || !Number.isFinite(Date.parse(row.updatedAt))) fail('INVALID_SHOP_CONNECTION');
      return row;
    }
    if(!body.pageInfo?.hasNextPage) return null;
    after=body.pageInfo.endCursor;
    if(!uuid.test(after??'') || cursors.has(after)) fail('INVALID_CONNECTION_PAGINATION');
    cursors.add(after);
  }
  fail('CONNECTION_SCAN_BOUND_EXCEEDED');
}

async function loadState(path) {
  try {return JSON.parse(await readFile(path,'utf8'));}
  catch(error) {if(error.code==='ENOENT') return null;fail('INVALID_LAB_RECOVERY_STATE');}
}

async function saveState(path,state) {
  const file=await open(path+'.pending','w',0o600);
  try {await file.writeFile(JSON.stringify(state)+'\n');await file.sync();} finally {await file.close();}
  await rename(path+'.pending',path);
}

export async function runLab(options) {
  if(process.platform!=='win32') fail('WINDOWS_REQUIRED');
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0') fail('TLS_VERIFICATION_REQUIRED');
  const settingsPath=resolve(options['--settings']);
  if(settingsPath===resolve(root,'.env')) fail('USE_SEPARATE_SHOPIFY_SETTINGS_FILE');
  const settings=shopifySettings(await readFile(settingsPath,'utf8'));
  // Never inherit settings that could redirect Docker/Compose or disable TLS verification.
  const cleanEnv={...process.env};
  for(const key of Object.keys(cleanEnv)) if(/^(?:SHOPIFY_|COMPOSE_|DOCKER_|POSTGRES_|MASTER_KEY$|TENANT_ID$|API_KEY$|PUBLIC_BASE_URL$|HOST_PORT$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|BASH_ENV$|ENV$)/i.test(key)) delete cleanEnv[key];
  const docker=(args,extra={})=>execute('docker',args,{env:cleanEnv,capture:true,...extra});
  const labels=await docker(['ps','-a','--filter','label=com.docker.compose.project=commerce-gateway','--format','{{.Label "com.docker.compose.project.working_dir"}}']);
  const normalized=value=>value.replaceAll('\\','/').replace(/^\/([a-z])\//i,'$1:/').toLowerCase();
  if(labels.trim().split(/\r?\n/).filter(Boolean).some(value=>normalized(value)!==normalized(root))) fail('DOCKER_PROJECT_BELONGS_TO_ANOTHER_DIRECTORY');
  let installSettings=null;
  try {installSettings=await readFile(resolve(root,'.env'),'utf8');} catch(error) {if(error.code!=='ENOENT') fail('INSTALL_SETTINGS_UNREADABLE');}
  const volumes=await docker(['volume','ls','--filter','label=com.docker.compose.project=commerce-gateway','--format','{{.Name}}']);
  if(!installSettings && (labels.trim() || volumes.trim())) fail('EXISTING_DOCKER_PROJECT_REQUIRES_ITS_ORIGINAL_INSTALLATION');
  await mkdir(resolve(root,'.secrets'),{recursive:true,mode:0o700});
  const lockPath=resolve(root,'.secrets/windows-lab.lock');
  let lock;
  try {lock=await open(lockPath,'wx',0o600);} catch {fail('LAB_LOCK_PRESENT_VERIFY_NO_OTHER_LAB_IS_RUNNING');}
  try {
    const statePath=resolve(root,'.secrets/windows-lab-run.json');
    let state=await loadState(statePath);
    if(state?.smokeStarted) {
      for(const [name,value] of [['origin',options['--origin']],['shop',options['--shop']],['product',options['--product']],['title',options['--title']]]) if(state[name]!==value) fail('RECOVERY_INPUT_MISMATCH');
      if(!uuid.test(state.runId??'') || !uuid.test(state.connectionId??'')) fail('INVALID_LAB_RECOVERY_STATE');
      if(state.report?.passed && state.report?.restored) {
        if(options['--new-run']) {await rename(statePath,statePath+'.'+state.runId+'.completed');state=null;}
        else {const report=completedRunStatus(state);console.log(JSON.stringify(report));return report;}
      }
      if(state && !options['--resume']) fail('PRIOR_RUN_REQUIRES_EXPLICIT_RESUME_AND_RECONCILIATION');
    } else if(options['--resume']) fail('NO_SMOKE_RUN_TO_RESUME');
    await execute(options['--bash'],['--noprofile','--norc',resolve(root,'release/install.sh').replaceAll('\\','/'),options['--origin']],{env:cleanEnv});
    installSettings=await readFile(resolve(root,'.env'),'utf8');
    const tenantLines=installSettings.split(/\r?\n/).filter(line=>line.startsWith('TENANT_ID='));
    if(tenantLines.length!==1 || !uuid.test(tenantLines[0].slice(10))) fail('INVALID_INSTALL_TENANT');
    const portLines=installSettings.split(/\r?\n/).filter(line=>line.startsWith('HOST_PORT='));
    if(portLines.length!==1) fail('INVALID_INSTALL_HOST_PORT');
    const port=portLines[0].slice(10);
    const localFetch=localGatewayFetch(options['--origin'],port);
    const localOrigin=`http://127.0.0.1:${Number(port)}`;
    const bearer=(await readFile(resolve(root,'.secrets/bootstrap-api-key'),'utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(bearer)) fail('INVALID_INSTALL_BEARER');
    const compose=['compose','--project-name','commerce-gateway','--env-file','.env','-f','compose.yaml'];
    const tenant=tenantLines[0].slice(10);
    await docker([...compose,'run','--rm','--no-deps','-T','api','node','dist/admin.js','migrate']);
    await docker([...compose,'run','--rm','--no-deps','-T','-e','TENANT_ID','-e','API_KEY','api','node','dist/admin.js','bootstrap'],{env:{...cleanEnv,TENANT_ID:tenant,API_KEY:bearer}});
    await jsonRequest(options['--origin'],'/readyz');
    let connection;
    if(state?.smokeStarted) {
      connection=await exactConnection(options,bearer,localOrigin);
      if(connection?.id!==state.connectionId) fail('RECOVERY_CONNECTION_MISMATCH');
    } else {
      await docker([...compose,'run','--rm','--no-deps','-T','-e','TENANT_ID','-e','SHOPIFY_CLIENT_ID','-e','SHOPIFY_CLIENT_SECRET','-e','SHOPIFY_SCOPES','-e','SHOPIFY_RETURN_URLS','api','node','dist/admin.js','configure-shopify'],
        {env:{...cleanEnv,...settings,TENANT_ID:tenant,SHOPIFY_RETURN_URLS:''}});
      const previous=await exactConnection(options,bearer,localOrigin);
      const started=await jsonRequest(localOrigin,'/v1/shopify/connect',bearer,{method:'POST',body:JSON.stringify({shop:options['--shop']})});
      const url=browserStart(started.browserStartUrl,options['--origin']);
      await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-Process -FilePath $env:CG_LAB_BROWSER_START | Out-Null'],{env:{...cleanEnv,CG_LAB_BROWSER_START:url},capture:true});
      console.log('Approve the exact requested development shop in your browser. Waiting for its completed OAuth connection.');
      const deadline=Date.now()+900_000;
      do {
        connection=await exactConnection(options,bearer,localOrigin);
        if(connection && (!previous || connection.updatedAt!==previous.updatedAt)) break;
        connection=null;await new Promise(resolvePromise=>setTimeout(resolvePromise,2000));
      } while(Date.now()<deadline);
      if(!connection) fail('SHOP_APPROVAL_WAIT_EXPIRED_RERUN_TO_RESTART_OAUTH');
    }
    if(!options['--mutate']) {
      const products=await jsonRequest(localOrigin,`/v1/connections/${connection.id}/products?first=1`,bearer);
      if(!Array.isArray(products.products)) fail('INVALID_PRODUCT_READ');
      const report={acceptance:'windows-disposable-lab',connected:true,readVerified:true,mutationRequested:false};
      console.log(JSON.stringify(report));return report;
    }
    state ??= {origin:options['--origin'],shop:options['--shop'],product:options['--product'],title:options['--title'],runId:randomUUID(),connectionId:connection.id};
    state.smokeStarted=true;await saveState(statePath,state);
    const report=await runShopifySmoke(smokeEnvironment(options,bearer,connection.id,state.runId),{fetch:localFetch});
    state.report=report;await saveState(statePath,state);
    console.log(JSON.stringify(report));return report;
  } finally {await lock.close();await unlink(lockPath);}
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.length>2?process.argv.slice(2):JSON.parse(process.env.CG_LAB_OPTIONS_JSON??'[]');
    delete process.env.CG_LAB_OPTIONS_JSON;
    if(!Array.isArray(args) || args.some(value=>typeof value!=='string')) fail('INVALID_LAB_ARGUMENTS');
    const result=await runLab(labOptions(args));if(result.passed===false) process.exitCode=1;
  }
  catch(error) {
    const code=/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'LAB_STEP_FAILED';
    console.error(JSON.stringify({acceptance:'windows-disposable-lab',passed:false,error:code}));process.exitCode=1;
  }
}

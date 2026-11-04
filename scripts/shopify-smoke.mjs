import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

class SmokeError extends Error {
  constructor(code) { super(code); this.code=code; }
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const terminal=new Set(['succeeded','failed','uncertain']);
const pause=ms => new Promise(resolve => setTimeout(resolve,ms));

export function smokeConfig(env) {
  if(env.SHOPIFY_SMOKE_ALLOW_MUTATION!=='1') throw new SmokeError('EXPLICIT_MUTATION_OPT_IN_REQUIRED');
  const shop=env.SHOPIFY_SMOKE_EXPECTED_DEV_STORE;
  if(typeof shop!=='string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)
    || env.SHOPIFY_SMOKE_DISPOSABLE_ACK!==shop) throw new SmokeError('EXACT_DISPOSABLE_STORE_ACK_REQUIRED');
  let url;
  try {url=new URL(env.SHOPIFY_SMOKE_GATEWAY_ORIGIN);} catch {throw new SmokeError('HTTPS_GATEWAY_ORIGIN_REQUIRED');}
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new SmokeError('HTTPS_GATEWAY_ORIGIN_REQUIRED');
  const bearer=env.SHOPIFY_SMOKE_BEARER;
  if(typeof bearer!=='string' || !/^[A-Za-z0-9._~+\/-]{1,512}=*$/.test(bearer) || bearer.length>512) throw new SmokeError('GATEWAY_BEARER_REQUIRED');
  const connectionId=env.SHOPIFY_SMOKE_CONNECTION_ID,runId=env.SHOPIFY_SMOKE_RUN_ID,productId=env.SHOPIFY_SMOKE_PRODUCT_GID;
  if(!uuid.test(connectionId ?? '') || !uuid.test(runId ?? '')) throw new SmokeError('EXACT_CONNECTION_AND_RUN_UUID_REQUIRED');
  if(typeof productId!=='string' || !/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/.test(productId)) throw new SmokeError('EXACT_PRODUCT_GID_REQUIRED');
  const originalTitle=env.SHOPIFY_SMOKE_ORIGINAL_TITLE;
  if(typeof originalTitle!=='string' || !originalTitle.trim() || originalTitle.length>255) throw new SmokeError('EXACT_ORIGINAL_TITLE_REQUIRED');
  const integer=(name,fallback,min,max) => {
    const value=env[name]===undefined?fallback:Number(env[name]);
    if(!Number.isSafeInteger(value) || value<min || value>max) throw new SmokeError('INVALID_SMOKE_TIME_BOUND');
    return value;
  };
  const temporaryTitle=`__commerce_gateway_smoke__${runId}__`;
  if(originalTitle===temporaryTitle) throw new SmokeError('TEMPORARY_TITLE_COLLISION');
  return {origin:url.origin,shop,bearer,connectionId,runId,productId,originalTitle,temporaryTitle,
    resume:env.SHOPIFY_SMOKE_RESUME==='1',timeoutMs:integer('SHOPIFY_SMOKE_HTTP_TIMEOUT_MS',10_000,1000,30_000),
    waitMs:integer('SHOPIFY_SMOKE_WAIT_MS',120_000,1000,900_000),pollMs:integer('SHOPIFY_SMOKE_POLL_MS',1000,100,5000)};
}

export async function runShopifySmoke(env=process.env,dependencies={}) {
  const config=smokeConfig(env),request=dependencies.fetch ?? globalThis.fetch,sleep=dependencies.sleep ?? pause;
  const report={acceptance:'shopify-disposable-product',runId:config.runId,passed:false,restored:false,
    manualReconciliationRequired:false,temporaryOperationIds:[],restoreOperationId:null,error:null};
  const known=new Map();let temporaryMayExist=false,unknownDispatch=false,mutationVerified=false,idempotencyVerified=false;
  const http=async(path,init={},expected=200) => {
    for(let attempt=0;attempt<3;attempt++) {
      let response;
      try {response=await request(config.origin+path,{...init,redirect:'error',
        headers:{authorization:`Bearer ${config.bearer}`,'content-type':'application/json',...init.headers},signal:AbortSignal.timeout(config.timeoutMs)});}
      catch {if(attempt<2) {await sleep(1000);continue;} throw new SmokeError('GATEWAY_REQUEST_UNCONFIRMED');}
      if(response.status===expected) {
        try {
          const reader=response.body?.getReader();if(!reader) throw new Error();
          const chunks=[];let length=0;
          while(true) {const {done,value}=await reader.read();if(done) break;length+=value.length;if(length>2_097_152) {await reader.cancel();throw new Error();}chunks.push(value);}
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {throw new SmokeError('INVALID_GATEWAY_RESPONSE');}
      }
      await response.body?.cancel();
      if([429,502,503,504].includes(response.status) && attempt<2) {
        const seconds=Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(seconds)&&seconds>0?Math.min(5000,seconds*1000):1000);continue;
      }
      throw new SmokeError(`GATEWAY_HTTP_${response.status}`);
    }
    throw new SmokeError('GATEWAY_REQUEST_UNCONFIRMED');
  };
  const find=async(kind,target) => {
    let after;const cursors=new Set();
    for(let page=0;page<100;page++) {
      const path=kind==='connections'?'/v1/connections':`/v1/connections/${config.connectionId}/products`;
      const body=await http(path+'?first=100'+(after?'&after='+encodeURIComponent(after):''));
      const rows=body[kind];if(!Array.isArray(rows)) throw new SmokeError('INVALID_GATEWAY_RESPONSE');
      const found=rows.find(row => row?.id===target);if(found) return found;
      if(!body.pageInfo?.hasNextPage) return null;
      const cursor=body.pageInfo.endCursor;
      if(typeof cursor!=='string' || !cursor || cursor.length>2048 || cursors.has(cursor)) throw new SmokeError('INVALID_PAGINATION');
      cursors.add(cursor);after=cursor;
    }
    throw new SmokeError('CATALOG_SCAN_BOUND_EXCEEDED');
  };
  const readTitle=async() => {
    const product=await find('products',config.productId);
    if(!product || typeof product.title!=='string') throw new SmokeError('EXACT_PRODUCT_NOT_FOUND');
    return product.title;
  };
  const enqueue=async(title,phase) => {
    const body=await http(`/v1/connections/${config.connectionId}/product-title-updates`,{
      method:'POST',headers:{'idempotency-key':`smoke:${config.runId}:${phase}`},body:JSON.stringify({productId:config.productId,title}),
    },202);
    const operation=body.operation;
    if(!operation || !uuid.test(operation.id ?? '') || operation.connectionId!==config.connectionId || operation.kind!=='product_title_update'
      || typeof body.replayed!=='boolean') throw new SmokeError('INVALID_OPERATION_RESPONSE');
    return body;
  };
  const settle=async(id) => {
    const attempts=Math.ceil(config.waitMs/config.pollMs)+1;
    for(let i=0;i<attempts;i++) {
      const body=await http(`/v1/operations/${id}`),operation=body.operation;
      if(!operation || operation.id!==id || operation.connectionId!==config.connectionId || operation.kind!=='product_title_update') throw new SmokeError('INVALID_OPERATION_STATUS');
      if(terminal.has(operation.status)) return operation.status;
      if(!['queued','running','retry','recovering'].includes(operation.status)) throw new SmokeError('INVALID_OPERATION_STATUS');
      if(i+1<attempts) await sleep(config.pollMs);
    }
    throw new SmokeError('OPERATION_STILL_PENDING');
  };
  try {
    const connection=await find('connections',config.connectionId);
    if(!connection || connection.shop!==config.shop) throw new SmokeError('EXACT_STORE_CONNECTION_MISMATCH');
    if(!Array.isArray(connection.scopes) || !connection.scopes.includes('write_products')) throw new SmokeError('PRODUCT_WRITE_SCOPE_REQUIRED');
    const current=await readTitle();
    if(current!==config.originalTitle && !(config.resume && current===config.temporaryTitle)) throw new SmokeError('ORIGINAL_TITLE_MISMATCH');
    temporaryMayExist=true;unknownDispatch=true;
    const first=await enqueue(config.temporaryTitle,'temporary');
    known.set(first.operation.id,null);unknownDispatch=false;
    report.temporaryOperationIds=[...known.keys()];
    const repeat=await enqueue(config.temporaryTitle,'temporary');
    known.set(repeat.operation.id,null);report.temporaryOperationIds=[...known.keys()];
    if(repeat.operation.id!==first.operation.id || !repeat.replayed) throw new SmokeError('IDEMPOTENCY_VERIFICATION_FAILED');
    idempotencyVerified=true;
    const status=await settle(first.operation.id);known.set(first.operation.id,status);
    if(status==='failed') throw new SmokeError('TEMPORARY_OPERATION_FAILED');
    if(await readTitle()!==config.temporaryTitle) throw new SmokeError(status==='uncertain'?'TEMPORARY_OUTCOME_UNRECONCILED':'TEMPORARY_READBACK_MISMATCH');
    mutationVerified=true;
  } catch(error) {report.error=error instanceof SmokeError?error.code:'SMOKE_STEP_FAILED';}
  finally {
    if(temporaryMayExist) {
      try {
        if(unknownDispatch || !known.size) throw new SmokeError('TEMPORARY_OPERATION_ID_UNKNOWN');
        for(const [id,status] of known) if(!terminal.has(status)) known.set(id,await settle(id));
        const current=await readTitle();
        if(current===config.originalTitle) {
          // An uncertain temporary write can still arrive later; reading the original
          // title does not prove it was rejected. Leave it for explicit reconciliation.
          if([...known.values()].includes('uncertain')) throw new SmokeError('TEMPORARY_OUTCOME_UNRECONCILED');
          report.restored=true;
        } else if(current===config.temporaryTitle) {
          // A unique run marker reconciles an uncertain terminal write. All known
          // temporary jobs are terminal before restoration is ever enqueued.
          const restored=await enqueue(config.originalTitle,'restore');report.restoreOperationId=restored.operation.id;
          const status=await settle(restored.operation.id);
          if(await readTitle()!==config.originalTitle) throw new SmokeError('RESTORE_READBACK_MISMATCH');
          report.restored=true;
          if(status==='failed') throw new SmokeError('RESTORE_OPERATION_FAILED');
        } else throw new SmokeError('EXTERNAL_TITLE_CHANGE_DETECTED');
      } catch(error) {
        report.manualReconciliationRequired=true;
        report.error=error instanceof SmokeError?error.code:'RESTORE_VERIFICATION_FAILED';
      }
    }
  }
  report.passed=mutationVerified && idempotencyVerified && report.restored && report.error===null;
  return report;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const report=await runShopifySmoke();process.stdout.write(JSON.stringify(report)+'\n');if(!report.passed) process.exitCode=1;}
  catch(error) {process.stderr.write(JSON.stringify({acceptance:'shopify-disposable-product',passed:false,
    error:error instanceof SmokeError?error.code:'SMOKE_CONFIGURATION_FAILED'})+'\n');process.exitCode=1;}
}

import { createHmac, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Pool } from 'pg';

type Database = Pick<Pool, 'query'>;
export interface Destination { address: string; family: 4 | 6 }
export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export interface NotificationEvent {
  id: string; tenant_id: string; endpoint_version: string; endpoint_url: string;
  secret_ciphertext: string; body: string; attempt_count: number;
  deadline_at: Date | string; fence_token: string | number;
}
export interface DeliveryResult { statusCode: number; retryAfterMs?: number }
export type NotificationSender = (url: URL, destination: Destination, body: string,
  headers: Record<string, string>, timeoutMs: number) => Promise<DeliveryResult>;
export interface NotificationOptions {
  pool: Database;
  decryptSecret: (ciphertext: string, tenantId: string) => string;
  lookup?: Lookup;
  send?: NotificationSender;
  timeoutMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
  onHealthy?: () => Promise<void> | void;
  onUnhealthy?: () => Promise<void> | void;
}

class DeliveryError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}

const denied4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as const) denied4.addSubnet(network,prefix,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
const denied6 = new BlockList();
for (const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) {
  denied6.addSubnet(network,prefix,'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied4.check(address,'ipv4');
  if (family === 6) return !address.includes('%') && global6.check(address,'ipv6') && !denied6.check(address,'ipv6');
  return false;
}

export function validateNotificationUrl(value: string): URL {
  if (value.length > 2048) throw new DeliveryError('INVALID_ENDPOINT');
  let url: URL;
  try { url = new URL(value); } catch { throw new DeliveryError('INVALID_ENDPOINT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || isIP(url.hostname.replace(/^\[|\]$/g,'')) || !url.hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)
    || url.hostname.endsWith('.')) throw new DeliveryError('INVALID_ENDPOINT');
  return url;
}

export async function resolveNotificationDestination(url: URL, lookup: Lookup = hostname => dnsLookup(hostname,{all:true,verbatim:true})): Promise<Destination> {
  const records = await lookup(url.hostname);
  // Reject mixed public/private answers as well as private-only destinations.
  if (!records.length || records.length > 64 || records.some(r => !isPublicAddress(r.address) || isIP(r.address) !== r.family)) {
    throw new DeliveryError('UNSAFE_DESTINATION');
  }
  return { address: records[0].address, family: records[0].family as 4 | 6 };
}

export function notificationSignature(secret: string, timestamp: string, eventId: string, body: string): string {
  return `sha256=${createHmac('sha256',secret).update(`${timestamp}.${eventId}.${body}`).digest('hex')}`;
}

export async function configureNotificationEndpoint(pool: Database, input: {
  tenantId: string; url: string; secretCiphertext: string; enabled?: boolean;
}): Promise<void> {
  const url = validateNotificationUrl(input.url);
  if (!input.secretCiphertext || input.secretCiphertext.length > 8192) throw new Error('Encrypted notification secret required');
  await pool.query(`INSERT INTO notification_endpoints(tenant_id,version,url,secret_ciphertext,enabled)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET version=EXCLUDED.version,
    url=EXCLUDED.url,secret_ciphertext=EXCLUDED.secret_ciphertext,enabled=EXCLUDED.enabled,updated_at=clock_timestamp()`,
  [input.tenantId,randomUUID(),url.href,input.secretCiphertext,input.enabled ?? true]);
}

export async function disableNotificationEndpoint(pool: Database, tenantId: string): Promise<void> {
  await pool.query('UPDATE notification_endpoints SET enabled=false,updated_at=clock_timestamp() WHERE tenant_id=$1',[tenantId]);
}

/** Native HTTPS bypasses proxy environment variables and pins the validated DNS answer.
 * TLS still verifies the original hostname; redirects are never followed. */
export const sendPinnedNotification: NotificationSender = (url,destination,body,headers,timeoutMs) => new Promise((resolve,reject) => {
  let settled = false;
  const done = (error?: Error, result?: DeliveryResult) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) reject(error); else resolve(result!);
  };
  const request = httpsRequest(url,{
    method:'POST',agent:false,family:destination.family,servername:url.hostname,
    lookup: (_hostname,_options,callback) => callback(null,destination.address,destination.family),
    headers: { ...headers,'content-type':'application/json','content-length':String(Buffer.byteLength(body)) },
  },response => {
    const statusCode = response.statusCode ?? 0;
    const retryAfter = response.headers['retry-after'];
    const seconds = typeof retryAfter === 'string' && /^\d{1,8}$/.test(retryAfter) ? Number(retryAfter) : 0;
    // No response body is needed. Destroy it so a malicious receiver cannot stream unbounded bytes.
    response.destroy();
    done(undefined,{statusCode,...(seconds ? {retryAfterMs:Math.min(seconds * 1000,3_600_000)} : {})});
  });
  const timer = setTimeout(() => { request.destroy(); done(new DeliveryError('DELIVERY_TIMEOUT',true)); },timeoutMs);
  request.on('error',() => done(new DeliveryError('DELIVERY_NETWORK_ERROR',true)));
  request.end(body);
});

async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(),new Promise<never>((_,reject) => {
    timer=setTimeout(() => reject(new DeliveryError('DNS_TIMEOUT',true)),timeoutMs);
  })]); } finally { if(timer) clearTimeout(timer); }
}

export async function runNotificationOnce(options: NotificationOptions): Promise<boolean> {
  const timeoutMs=options.timeoutMs ?? 10_000, leaseMs=options.leaseMs ?? 60_000;
  const maxAttempts=options.maxAttempts ?? 8;
  const baseBackoffMs=options.baseBackoffMs ?? 30_000,maxBackoffMs=options.maxBackoffMs ?? 3_600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(leaseMs) || leaseMs < timeoutMs*3+1000
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100
    || !Number.isSafeInteger(baseBackoffMs) || baseBackoffMs<1 || baseBackoffMs>86_400_000
    || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs<baseBackoffMs || maxBackoffMs>86_400_000) throw new Error('Invalid notification worker bounds');
  const claim=await options.pool.query<NotificationEvent>(`WITH candidate AS (
    SELECT id FROM notification_events WHERE (status IN ('pending','retry') AND next_attempt_at<=clock_timestamp())
      OR (status='delivering' AND lease_until<=clock_timestamp())
    ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE notification_events e SET status='delivering',attempt_count=attempt_count+1,fence_token=fence_token+1,
      lease_until=clock_timestamp()+($1::double precision * interval '1 millisecond'),updated_at=clock_timestamp()
    FROM candidate c WHERE e.id=c.id RETURNING e.*`,[leaseMs]);
  const event=claim.rows[0]; if(!event) return false;
  const now=options.now ?? Date.now;
  const deadline=new Date(event.deadline_at).getTime();
  const finish=async(status:'delivered'|'retry'|'failed',code:string|null,httpStatus:number|null,delayMs=0) => {
    await options.pool.query(`UPDATE notification_events SET status=$4,last_error=$5,last_http_status=$6,
      next_attempt_at=clock_timestamp()+($7::double precision * interval '1 millisecond'),lease_until=NULL,
      completed_at=CASE WHEN $4 IN ('delivered','failed') THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND fence_token=$3 AND status='delivering' AND lease_until>clock_timestamp()`,
    [event.id,event.tenant_id,event.fence_token,status,code,httpStatus,delayMs]);
  };
  if(!Number.isFinite(deadline) || now()>=deadline || event.attempt_count>maxAttempts) {
    await finish('failed','DELIVERY_BUDGET_EXHAUSTED',null); return true;
  }
  let code='DELIVERY_NETWORK_ERROR',retryable=true,httpStatus:number|null=null,retryAfterMs=0;
  try {
    const endpoint=await options.pool.query<{version:string;enabled:boolean}>(
      'SELECT version,enabled FROM notification_endpoints WHERE tenant_id=$1',[event.tenant_id]);
    if(!endpoint.rows[0]?.enabled || endpoint.rows[0].version!==event.endpoint_version) throw new DeliveryError('ENDPOINT_CHANGED_OR_DISABLED');
    const url=validateNotificationUrl(event.endpoint_url);
    const destination=await bounded(() => resolveNotificationDestination(url,options.lookup),Math.min(timeoutMs,Math.max(1,deadline-now())));
    let secret:string;
    try { secret=options.decryptSecret(event.secret_ciphertext,event.tenant_id); }
    catch { throw new DeliveryError('SIGNING_SECRET_UNAVAILABLE'); }
    if(Buffer.byteLength(secret)<32 || Buffer.byteLength(secret)>4096) throw new DeliveryError('INVALID_SIGNING_SECRET');
    const live=await options.pool.query(`SELECT e.id FROM notification_events e JOIN notification_endpoints c ON c.tenant_id=e.tenant_id
      WHERE e.id=$1 AND e.tenant_id=$2 AND e.fence_token=$3 AND e.status='delivering'
        AND e.lease_until>clock_timestamp() AND e.deadline_at>clock_timestamp()
        AND c.enabled AND c.version=e.endpoint_version`,[event.id,event.tenant_id,event.fence_token]);
    if(!live.rows[0]) return true;
    const timestamp=String(Math.floor(now()/1000));
    const result=await (options.send ?? sendPinnedNotification)(url,destination,event.body,{
      'x-commerce-event-id':event.id,'x-commerce-timestamp':timestamp,
      'x-commerce-signature':notificationSignature(secret,timestamp,event.id,event.body),
    },Math.min(timeoutMs,Math.max(1,deadline-now())));
    httpStatus=result.statusCode;
    if(httpStatus>=200 && httpStatus<300) { await finish('delivered',null,httpStatus); return true; }
    code=httpStatus>=300 && httpStatus<400 ? 'REDIRECT_REJECTED' : `HTTP_${httpStatus}`;
    retryable=httpStatus===408 || httpStatus===425 || httpStatus===429 || httpStatus>=500;
    retryAfterMs=result.retryAfterMs ?? 0;
  } catch(error) {
    if(error instanceof DeliveryError) { code=error.code; retryable=error.retryable; }
    // Never persist raw URLs, receiver response bodies, secrets, or exception messages.
  }
  if(!retryable || event.attempt_count>=maxAttempts || now()>=deadline) await finish('failed',code,httpStatus);
  else {
    const exponential=Math.min(maxBackoffMs,baseBackoffMs*2**Math.min(20,event.attempt_count-1));
    const jitter=exponential*(0.5+(options.random ?? Math.random)()*0.5);
    await finish('retry',code,httpStatus,Math.max(0,Math.min(Math.max(jitter,retryAfterMs),deadline-now())));
  }
  return true;
}

export async function startNotifications(options: NotificationOptions & {signal:AbortSignal;pollMs?:number}): Promise<void> {
  while(!options.signal.aborted) {
    let worked=false;
    try { worked=await runNotificationOnce(options); await options.onHealthy?.(); }
    catch { try { await options.onUnhealthy?.(); } catch { /* Health reporting must not terminate recovery. */ } }
    if(!worked && !options.signal.aborted) await new Promise<void>(resolve => {
      const done=() => {clearTimeout(timer);options.signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,options.pollMs ?? 1000);
      options.signal.addEventListener('abort',done,{once:true});
    });
  }
}

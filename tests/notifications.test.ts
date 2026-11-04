import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { configureNotificationEndpoint, disableNotificationEndpoint, isPublicAddress,
  notificationSignature, resolveNotificationDestination, runNotificationOnce,
  validateNotificationUrl, type NotificationEvent, type NotificationOptions } from '../src/notifications.js';

const now=Date.parse('2026-11-04T00:00:00Z');
const secret='tenant-specific-secret-'.repeat(3);
const tenantId='10000000-0000-4000-8000-000000000001';
const eventId='20000000-0000-4000-8000-000000000001';
const version='30000000-0000-4000-8000-000000000001';

function fixture() {
  const event:NotificationEvent & {status:string;last_error?:string|null;last_http_status?:number|null;delay?:number}={
    id:eventId,tenant_id:tenantId,endpoint_version:version,endpoint_url:'https://hooks.example.com/completion',
    secret_ciphertext:'ciphertext-only',body:JSON.stringify({id:eventId,type:'operation.completed',data:{status:'succeeded'}}),
    attempt_count:0,deadline_at:new Date(now+86_400_000),fence_token:0,status:'pending',
  };
  const endpoint={enabled:true,version};
  const calls:Array<{url:URL;destination:{address:string;family:number};body:string;headers:Record<string,string>}>=[];
  let live=true;
  const pool={query:async(sql:string,values:any[]=[]) => {
    if(sql.includes('WITH candidate AS')) {
      assert.match(sql,/FOR UPDATE SKIP LOCKED/);
      if(event.status==='delivered' || event.status==='failed') return {rows:[]};
      event.attempt_count++; event.fence_token=Number(event.fence_token)+1; event.status='delivering';
      return {rows:[{...event}]};
    }
    if(sql.includes('SELECT version,enabled')) { assert.equal(values[0],tenantId); return {rows:[endpoint]}; }
    if(sql.includes('SELECT e.id')) {
      assert.match(sql,/e\.tenant_id=\$2/); assert.match(sql,/e\.fence_token=\$3/);
      assert.deepEqual(values,[eventId,tenantId,event.fence_token]);
      return {rows:live ? [{id:eventId}] : []};
    }
    if(sql.startsWith('UPDATE notification_events SET')) {
      assert.match(sql,/tenant_id=\$2 AND fence_token=\$3/);
      assert.match(sql,/lease_until>clock_timestamp\(\)/);
      assert.deepEqual(values.slice(0,3),[eventId,tenantId,event.fence_token]);
      [event.status,event.last_error,event.last_http_status,event.delay]=values.slice(3);
      return {rows:[]};
    }
    throw new Error('Unexpected SQL');
  }} as unknown as Pool;
  const options:NotificationOptions={pool,decryptSecret:(_ciphertext,tenant) => {assert.equal(tenant,tenantId);return secret;},
    lookup:async() => [{address:'1.1.1.1',family:4}],now:() => now,random:() => 0,
    send:async(url,destination,body,headers) => {calls.push({url,destination,body,headers});return {statusCode:204};}};
  return {event,endpoint,calls,options,setLive:(value:boolean) => {live=value;}};
}

test('webhook URLs enforce public HTTPS authority without credentials, alternate ports, or IP literals',() => {
  assert.equal(validateNotificationUrl('https://hooks.example.com/a?b=c').href,'https://hooks.example.com/a?b=c');
  for(const value of ['http://hooks.example.com','https://user:secret@hooks.example.com','https://hooks.example.com:8443',
    'https://127.0.0.1','https://2130706433','https://[::1]','https://1.1.1.1','https://localhost',
    'https://service.local','https://service.internal','https://hooks.example.com.','https://hooks.example.com/#fragment','https://'+ 'a'.repeat(2050)]) {
    assert.throws(() => validateNotificationUrl(value),undefined,value);
  }
});

test('address checks reject metadata, private, mapped, reserved and transition ranges',() => {
  for(const address of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.1.1',
    '192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
    '::','::1','::ffff:127.0.0.1','::ffff:1.1.1.1','fe80::1','fc00::1','ff02::1','2001:db8::1','2002:7f00:1::','3fff::1','not-an-ip']) {
    assert.equal(isPublicAddress(address),false,address);
  }
  for(const address of ['1.1.1.1','8.8.8.8','2001:4860:4860::8888','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address);
});

test('DNS validation rejects mixed answers and pins the exact public address',async() => {
  const url=validateNotificationUrl('https://hooks.example.com');
  await assert.rejects(resolveNotificationDestination(url,async() => [{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]));
  await assert.rejects(resolveNotificationDestination(url,async() => []));
  await assert.rejects(resolveNotificationDestination(url,async() => [{address:'1.1.1.1',family:6}]));
  assert.deepEqual(await resolveNotificationDestination(url,async() => [{address:'1.1.1.1',family:4}]),{address:'1.1.1.1',family:4});
});

test('HMAC signs exact body, timestamp and immutable event identity with tenant-specific secret',() => {
  const body='{"data":{"status":"succeeded"}}',timestamp='1793750400';
  const signature=notificationSignature(secret,timestamp,eventId,body);
  assert.equal(signature,'sha256='+createHmac('sha256',secret).update(timestamp+'.'+eventId+'.'+body).digest('hex'));
  for(const changed of [notificationSignature('other tenant secret',timestamp,eventId,body),
    notificationSignature(secret,timestamp+'1',eventId,body),notificationSignature(secret,timestamp,eventId+'1',body),
    notificationSignature(secret,timestamp,eventId,body+' ')]) assert.notEqual(signature,changed);
});

test('successful delivery signs headers and stores a fenced durable delivered status',async() => {
  const f=fixture();assert.equal(await runNotificationOnce(f.options),true);
  assert.equal(f.event.status,'delivered');assert.equal(f.event.last_http_status,204);assert.equal(f.calls.length,1);
  const call=f.calls[0];assert.equal(call.body,f.event.body);assert.equal(call.headers['x-commerce-event-id'],eventId);
  assert.deepEqual(call.destination,{address:'1.1.1.1',family:4});
  assert.equal(call.headers['x-commerce-signature'],notificationSignature(secret,call.headers['x-commerce-timestamp'],eventId,call.body));
  assert.equal(await runNotificationOnce(f.options),false);
});

test('retryable failures back off, preserve identity/body, and stop visibly at attempt limit',async() => {
  const f=fixture();f.options.maxAttempts=2;
  f.options.send=async(_url,_destination,body,headers) => {
    assert.equal(body,f.event.body);assert.equal(headers['x-commerce-event-id'],eventId);
    return {statusCode:429,retryAfterMs:120_000};
  };
  await runNotificationOnce(f.options);assert.equal(f.event.status,'retry');assert.equal(f.event.delay,120_000);
  await runNotificationOnce(f.options);assert.equal(f.event.status,'failed');assert.equal(f.event.last_error,'HTTP_429');
  assert.equal(f.event.last_http_status,429);assert.equal(f.event.attempt_count,2);
});

test('redirects and permanent receiver failures never follow a new destination or retry',async() => {
  for(const statusCode of [301,302,307,308,400,401,403,404,410]) {
    const f=fixture();let sends=0;f.options.send=async() => {sends++;return {statusCode};};
    await runNotificationOnce(f.options);assert.equal(f.event.status,'failed');assert.equal(sends,1);
    assert.equal(f.event.last_error,statusCode<400?'REDIRECT_REJECTED':`HTTP_${statusCode}`);
  }
});

test('unsafe DNS rebinding, expired budgets, rotated configuration and stale claims prevent outbound requests',async() => {
  const unsafe=fixture();unsafe.options.lookup=async() => [{address:'169.254.169.254',family:4}];
  await runNotificationOnce(unsafe.options);assert.equal(unsafe.event.status,'failed');assert.equal(unsafe.event.last_error,'UNSAFE_DESTINATION');assert.equal(unsafe.calls.length,0);
  const expired=fixture();expired.event.deadline_at=new Date(now-1);
  await runNotificationOnce(expired.options);assert.equal(expired.event.status,'failed');assert.equal(expired.calls.length,0);
  const rotated=fixture();rotated.endpoint.version='new-version';
  await runNotificationOnce(rotated.options);assert.equal(rotated.event.status,'failed');assert.equal(rotated.event.last_error,'ENDPOINT_CHANGED_OR_DISABLED');assert.equal(rotated.calls.length,0);
  const disabled=fixture();disabled.endpoint.enabled=false;
  await runNotificationOnce(disabled.options);assert.equal(disabled.event.status,'failed');assert.equal(disabled.calls.length,0);
  const stale=fixture();stale.setLive(false);
  await runNotificationOnce(stale.options);assert.equal(stale.calls.length,0);
});

test('raw network errors and failed secret decryption never enter persisted error records',async() => {
  const f=fixture();f.options.send=async() => {throw new Error('https://user:password@private.example; signature=secret');};
  await runNotificationOnce(f.options);assert.equal(f.event.status,'retry');assert.equal(f.event.last_error,'DELIVERY_NETWORK_ERROR');
  const invalid=fixture();invalid.options.decryptSecret=() => {throw new Error('master-key=secret');};
  await runNotificationOnce(invalid.options);assert.equal(invalid.event.status,'failed');assert.equal(invalid.event.last_error,'SIGNING_SECRET_UNAVAILABLE');
});

test('admin configuration normalizes URLs, versions changes and never stores plaintext signing secrets',async() => {
  const calls:Array<{sql:string;values:any[]}>=[];
  const pool={query:async(sql:string,values:any[]) => {calls.push({sql,values});return {rows:[]};}} as unknown as Pool;
  await configureNotificationEndpoint(pool,{tenantId,url:'https://HOOKS.example.com:443/completion',secretCiphertext:'encrypted-envelope'});
  assert.equal(calls[0].values[0],tenantId);assert.match(calls[0].values[1],/^[a-f0-9-]{36}$/);
  assert.equal(calls[0].values[2],'https://hooks.example.com/completion');assert.equal(calls[0].values[3],'encrypted-envelope');
  assert.match(calls[0].sql,/ON CONFLICT\(tenant_id\) DO UPDATE SET version=EXCLUDED.version/);
  await disableNotificationEndpoint(pool,tenantId);assert.deepEqual(calls[1].values,[tenantId]);
  await assert.rejects(configureNotificationEndpoint(pool,{tenantId,url:'http://unsafe.example.com',secretCiphertext:'encrypted'}));
  assert.equal(calls.length,2);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureUninstallWebhook, WebhookSetupError } from '../src/shopify-webhooks.js';
import { webhookBinding } from '../src/oauth.js';

const app={clientId:'test-app',clientSecret:'synthetic-secret',redirectUri:'https://gateway.example/oauth/shopify/callback',scopes:['write_products'],allowedReturnUrls:[]};
const options={app,shop:'demo.myshopify.com',accessToken:'synthetic-token',origin:'https://gateway.example'};
const uri=`${options.origin}/webhooks/shopify/test-app/app-uninstalled/${webhookBinding(app,'app-uninstalled')}`;
const subscription={id:'gid://shopify/WebhookSubscription/123',topic:'APP_UNINSTALLED',uri,format:'JSON',apiVersion:{handle:'2026-10'}};
const list=(nodes:unknown[]=[],hasNextPage=false) => ({webhookSubscriptions:{nodes,pageInfo:{hasNextPage}}});
const created={webhookSubscriptionCreate:{webhookSubscription:{id:subscription.id},userErrors:[]}};
const response=(data:unknown,version='2026-10') => new Response(JSON.stringify({data}),{headers:{'x-shopify-api-version':version}});
const code=(expected:string) => (error:unknown) => error instanceof WebhookSetupError && error.code===expected;

test('uninstall setup uses pinned shop API, creates once, independently reads back and returns no capability or token',async () => {
  const calls:any[]=[];
  const responses=[list(),created,list([subscription])];
  const receipt=await ensureUninstallWebhook({...options,fetch:async (url,init) => {
    assert.equal(url,'https://demo.myshopify.com/admin/api/2026-10/graphql.json');
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    assert.equal((init?.headers as any)['X-Shopify-Access-Token'],options.accessToken);
    calls.push(JSON.parse(init!.body as string));return response(responses.shift());
  }});
  assert.equal(calls.length,3);
  assert.match(calls[0].query,/topics:\[APP_UNINSTALLED\]/);
  assert.deepEqual(calls[1].variables,{subscription:{uri,format:'JSON'}});
  assert.equal(calls[2].query,calls[0].query);
  assert.deepEqual(receipt,{shop:options.shop,topic:'APP_UNINSTALLED',subscriptionId:subscription.id,apiVersion:'2026-10',verified:true});
  assert.ok(!JSON.stringify(receipt).includes(uri));assert.ok(!JSON.stringify(receipt).includes(options.accessToken));
});

test('repeat setup verifies existing subscription without mutation',async () => {
  let calls=0;
  await ensureUninstallWebhook({...options,fetch:async (_url,init) => {
    calls++;assert.match(JSON.parse(init!.body as string).query,/^query /);return response(list([subscription]));
  }});
  assert.equal(calls,1);
});

test('conflicting, duplicate and truncated subscription sets fail closed without writes',async () => {
  for (const data of [list([{...subscription,uri:'https://old.example/private'}]),list([subscription,subscription]),
    list([],true),list([{...subscription,format:'XML'}]),list([{...subscription,apiVersion:{handle:'2026-07'}}])]) {
    let calls=0;
    await assert.rejects(ensureUninstallWebhook({...options,fetch:async () => {calls++;return response(data);}}),code('SUBSCRIPTION_CONFLICT'));
    assert.equal(calls,1);
  }
});

test('ambiguous creation reconciles by read and never replays the mutation',async () => {
  for (const committed of [true,false]) {
    let calls=0;let mutations=0;
    const work=ensureUninstallWebhook({...options,fetch:async (_url,init) => {
      calls++;
      if (JSON.parse(init!.body as string).query.startsWith('mutation')) {mutations++;throw new Error(`secret ${uri}`);}
      return response(list(calls>2 && committed ? [subscription] : []));
    }});
    if (committed) assert.equal((await work).verified,true);
    else await assert.rejects(work,code('PROVIDER_REQUEST_FAILED'));
    assert.equal(mutations,1);
  }
});

test('uninstall setup rejects missing readback, wrong versions, provider errors and unsafe destinations',async () => {
  let calls=0;
  await assert.rejects(ensureUninstallWebhook({...options,fetch:async () => response(++calls===2 ? created : list())}),code('READBACK_FAILED'));
  for (const reply of [response(list(),'2026-07'),new Response('bad JSON',{headers:{'x-shopify-api-version':'2026-10'}}),
    response({}),new Response('',{status:401}),new Response(JSON.stringify({data:{},errors:[{message:uri}]}),{headers:{'x-shopify-api-version':'2026-10'}})]) {
    await assert.rejects(ensureUninstallWebhook({...options,fetch:async () => reply}),error => error instanceof WebhookSetupError && !error.message.includes(uri));
  }
  const noNetwork=async ():Promise<Response> => {assert.fail('Unsafe configuration must not make a request');};
  await assert.rejects(ensureUninstallWebhook({...options,shop:'demo.myshopify.com.evil.example',fetch:noNetwork}));
  await assert.rejects(ensureUninstallWebhook({...options,origin:'http://localhost',fetch:noNetwork}),code('HTTPS_REQUIRED'));
  await assert.rejects(ensureUninstallWebhook({...options,origin:'https://gateway.example/path',fetch:noNetwork}),code('HTTPS_REQUIRED'));
});

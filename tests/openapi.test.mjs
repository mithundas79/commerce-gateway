import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const document=JSON.parse(await readFile(new URL('../openapi.json',import.meta.url),'utf8'));
const resolveRef=reference => {
  assert.ok(reference.startsWith('#/'),'Public contract uses local references');
  return reference.slice(2).split('/').reduce((node,key) => {assert.ok(node && Object.hasOwn(node,key),`Unresolved reference: ${reference}`);return node[key];},document);
};
// A small dependency-free example checker; the published artifact uses standard
// OpenAPI 3.1/JSON Schema and can also be consumed by a full external validator.
function check(schema,value,path='$') {
  if(schema.$ref) return check(resolveRef(schema.$ref),value,path);
  if(schema.allOf) for(const part of schema.allOf) check(part,value,path);
  if(schema.anyOf) {
    assert.ok(schema.anyOf.some(part => {try {check(part,value,path);return true;} catch {return false;}}),`${path}: no union branch matched`);
    return;
  }
  if(Object.hasOwn(schema,'const')) assert.deepEqual(value,schema.const,path);
  if(schema.enum) assert.ok(schema.enum.includes(value),path);
  if(schema.type==='null') assert.equal(value,null,path);
  if(schema.type==='string') {
    assert.equal(typeof value,'string',path);
    if(schema.minLength!==undefined) assert.ok([...value].length>=schema.minLength,path);
    if(schema.maxLength!==undefined) assert.ok([...value].length<=schema.maxLength,path);
    if(schema['x-maxUtf16CodeUnits']!==undefined) assert.ok(value.length<=schema['x-maxUtf16CodeUnits'],path);
    if(schema.pattern) assert.match(value,new RegExp(schema.pattern),path);
    if(schema.format==='uuid') assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,path);
    if(schema.format==='date-time') assert.ok(Number.isFinite(Date.parse(value)),path);
    if(schema.format==='uri') assert.ok(new URL(value),path);
  }
  if(schema.type==='boolean') assert.equal(typeof value,'boolean',path);
  if(['number','integer'].includes(schema.type)) {
    assert.equal(typeof value,'number',path);assert.ok(Number.isFinite(value),path);
    if(schema.type==='integer') assert.ok(Number.isInteger(value),path);
    if(schema.minimum!==undefined) assert.ok(value>=schema.minimum,path);
    if(schema.maximum!==undefined) assert.ok(value<=schema.maximum,path);
  }
  if(schema.type==='array') {
    assert.ok(Array.isArray(value),path);
    if(schema.maxItems!==undefined) assert.ok(value.length<=schema.maxItems,path);
    for(const item of value) check(schema.items,item,path+'[]');
  }
  if(schema.type==='object') {
    assert.ok(value && typeof value==='object' && !Array.isArray(value),path);
    for(const key of schema.required ?? []) assert.ok(Object.hasOwn(value,key),`${path}.${key} required`);
    for(const [key,item] of Object.entries(value)) {
      if(schema.properties?.[key]) check(schema.properties[key],item,path+'.'+key);
      else if(schema.additionalProperties===false) assert.fail(`${path}.${key} unexpected`);
    }
  }
}

test('OpenAPI 3.1 route map matches every implemented Fastify customer route',async() => {
  assert.equal(document.openapi,'3.1.0');assert.equal(document.jsonSchemaDialect,'https://json-schema.org/draft/2020-12/schema');
  const sources=await Promise.all(['api.ts','main.ts'].map(name => readFile(new URL('../src/'+name,import.meta.url),'utf8')));
  const implemented=[];
  for(const source of sources) for(const match of source.matchAll(/app\.(get|post)(?:<[\s\S]*?>)?\(\s*(['"])(\/[^'"]+)\2/g)) {
    implemented.push(match[1].toUpperCase()+' '+match[3].replace(/:([A-Za-z]+)/g,'{$1}'));
  }
  const documented=Object.entries(document.paths).flatMap(([path,operations]) => Object.keys(operations).map(method => method.toUpperCase()+' '+path));
  assert.equal(implemented.length,10);assert.deepEqual(documented.sort(),implemented.sort());
  assert.equal(document.servers[0].url,'https://{gatewayHost}');
});

test('tenant bearer, capability/callback boundaries, idempotency header and polling link remain explicit',() => {
  assert.equal(document.components.securitySchemes.gatewayBearer.scheme,'bearer');
  for(const [path,operations] of Object.entries(document.paths)) for(const operation of Object.values(operations)) {
    if(path.startsWith('/v1/')) assert.deepEqual(operation.security ?? document.security,[{gatewayBearer:[]}]);
    for(const parameter of operation.parameters ?? []) assert.notEqual(parameter.name,'tenantId');
  }
  assert.deepEqual(document.paths['/healthz'].get.security,[]);
  assert.deepEqual(document.paths['/readyz'].get.security,[]);
  assert.deepEqual(document.paths['/oauth/shopify/start'].get.security,[{browserStartTicket:[]}]);
  assert.deepEqual(document.paths['/oauth/shopify/callback'].get.security,[{oauthBrowserBinding:[],shopifyCallbackHmac:[]}]);
  const enqueue=document.paths['/v1/connections/{connectionId}/product-title-updates'].post;
  const key=enqueue.parameters.find(parameter => parameter.name==='Idempotency-Key');
  assert.equal(key.required,true);assert.equal(key.in,'header');assert.equal(key.schema.maxLength,128);
  assert.ok(enqueue.responses['202'].headers.Location);
  assert.equal(enqueue.responses['202'].links.OperationStatus.operationId,'getOperation');
  assert.equal(enqueue.responses['202'].links.OperationStatus.parameters.operationId,'$response.body#/operation/id');
  assert.equal(document.components.responses.Unauthorized.headers['WWW-Authenticate'].schema.const,'Bearer');
});

test('success schemas require public identity, status, pagination and ordering fields without credentials',() => {
  const schemas=document.components.schemas;
  assert.deepEqual(schemas.TitleUpdate.required,['productId','title']);assert.equal(schemas.TitleUpdate.additionalProperties,false);
  for(const field of ['id','connectionId','kind','status','attemptCount','result','error','createdAt','updatedAt','completedAt','orderingReleasedAt']) {
    assert.ok(schemas.Operation.required.includes(field),field);
  }
  assert.ok(schemas.OperationStatusResponse.properties.operation.allOf.some(part => part.required?.includes('blockedBy')));
  assert.deepEqual(schemas.ConnectionPage.required,['connections','pageInfo']);assert.equal(schemas.ConnectionPage.properties.connections.maxItems,100);
  assert.equal(schemas.ProductPage.properties.products.maxItems,100);
  assert.ok(schemas.OperationStatus.enum.includes('uncertain'));
  for(const schema of Object.values(schemas)) for(const name of Object.keys(schema.properties ?? {})) assert.doesNotMatch(name,/token|secret|ciphertext|fence|^lease|tenantId/i);
  assert.ok(document.paths['/v1/connections/{connectionId}/products'].get.responses['429'].headers['Retry-After']);
});

test('all references resolve and JSON response examples satisfy their declared success/error shapes',() => {
  let examples=0;
  const walk=node => {
    if(!node || typeof node!=='object') return;
    if(node.$ref) resolveRef(node.$ref);
    if(node.schema && Object.hasOwn(node,'example')) {check(node.schema,node.example);examples++;}
    for(const value of Object.values(node)) if(value && typeof value==='object') walk(value);
  };
  walk(document);assert.ok(examples>=20);
  assert.throws(() => check(document.components.schemas.EnqueueResponse,{operation:{id:'bad'},replayed:false}));
  assert.throws(() => check(document.components.schemas.TitleUpdate,{productId:'gid://shopify/Product/123',title:'   '}));
});

test('outgoing notification contract requires event identity, timestamp, raw-body HMAC and terminal payload',() => {
  const operation=document.webhooks.operationCompleted.post;
  assert.deepEqual(operation.parameters.map(parameter => parameter.name),['x-commerce-event-id','x-commerce-timestamp','x-commerce-signature']);
  assert.ok(operation.parameters.every(parameter => parameter.required));
  assert.deepEqual(operation.security,[{notificationHmac:[]}]);
  assert.deepEqual(document.components.schemas.CompletionEvent.properties.data.properties.status.enum,['succeeded','failed','uncertain']);
  assert.match(operation.description,/at least once/);assert.match(operation.description,/deduplicate/);
});

test('runtime API responses match the published health, tenant, mutation and provider contract', async t => {
  const { buildApi } = await import('../src/api.js');
  const { ConnectorError } = await import('../src/shopify.js');
  const { createHash } = await import('node:crypto');
  const tenant = '10000000-0000-4000-8000-000000000001';
  const connectionId = '20000000-0000-4000-8000-000000000001';
  const foreignId = '20000000-0000-4000-8000-000000000002';
  const apiKey = 'contract-test-key';
  const tokenHash = createHash('sha256').update(apiKey).digest('hex');
  const headers = { authorization: `Bearer ${apiKey}` };
  const now = '2026-11-04T12:00:00.000Z';
  const connection = { id: connectionId, tenant_id: tenant, shop: 'demo.myshopify.com', scopes: ['write_products'], created_at: now, updated_at: now };
  let operation;
  let failProbe = false;
  let failAuthentication = false;
  let providerError;
  const pool = { async query(sql, values = []) {
    if (sql.includes('FROM api_keys')) {
      if (failAuthentication) throw new Error('secret database failure');
      return { rows: values[0] === tokenHash ? [{ tenant_id: tenant }] : [] };
    }
    if (sql === 'SELECT 1') {
      if (failProbe) throw new Error('secret database failure');
      return { rows: [{ ready: 1 }] };
    }
    if (sql.startsWith('INSERT INTO operations')) {
      if (operation) return { rows: [] };
      operation = { id: values[0], connection_id: connectionId, kind: 'product_title_update', payload: JSON.parse(values[4]), status: 'queued', attempt_count: 0, created_at: now, updated_at: now };
      return { rows: [operation] };
    }
    if (sql.includes('FROM operations')) return { rows: operation ? [{ ...operation, blocked_by: null }] : [] };
    if (sql.includes('FROM connections')) return { rows: !values[1] || values[1] === connectionId ? [connection] : [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const page = { products: [{ id: 'gid://shopify/Product/123', title: 'Sample', status: 'DRAFT', updatedAt: now }], pageInfo: { hasNextPage: false, endCursor: null } };
  const app = buildApi({ pool, readProducts: async () => {
    if (providerError) throw providerError;
    return page;
  } });
  t.after(() => app.close());
  async function request(method, path, url, expectedStatus, options = {}) {
    const response = await app.inject({ method, url, headers, ...options });
    assert.equal(response.statusCode, expectedStatus, response.body);
    const entry = document.paths[path][method.toLowerCase()].responses[String(expectedStatus)];
    assert.ok(entry, `Undocumented ${method} ${path} status ${expectedStatus}`);
    const declared = entry.$ref ? resolveRef(entry.$ref) : entry;
    check(declared.content['application/json'].schema, response.json());
    assert.equal(response.headers['cache-control'], 'no-store');
    return response;
  }
  for (const path of ['/healthz', '/readyz', '/v1/health']) await request('GET', path, path, 200);
  await request('GET', '/v1/health', '/v1/health', 401, { headers: {} });
  await request('GET', '/v1/health', '/v1/health', 401, { headers: { authorization: 'Bearer unknown-key' } });
  failProbe = true;
  await request('GET', '/readyz', '/readyz', 503);
  await request('GET', '/v1/health', '/v1/health', 503);
  failProbe = false;
  failAuthentication = true;
  await request('GET', '/v1/health', '/v1/health', 503);
  failAuthentication = false;
  await request('GET', '/v1/connections', '/v1/connections', 200);
  await request('GET', '/v1/connections', '/v1/connections?first=101', 400);
  await request('GET', '/v1/connections', '/v1/connections', 401, { headers: {} });
  const productsPath = '/v1/connections/{connectionId}/products';
  await request('GET', productsPath, `/v1/connections/${connectionId}/products`, 200);
  await request('GET', productsPath, `/v1/connections/${foreignId}/products`, 404);
  for (const [code, status] of [['AUTHENTICATION', 409], ['PERMISSION', 403], ['RATE_LIMITED', 429], ['TRANSIENT', 503], ['API_VERSION_MISMATCH', 502]]) {
    providerError = new ConnectorError(code, 'secret upstream detail', status, true, false, 2500);
    const response = await request('GET', productsPath, `/v1/connections/${connectionId}/products`, status);
    assert.ok(!response.body.includes('secret'));
    if (status === 429 || status === 503) assert.equal(response.headers['retry-after'], '3');
  }
  providerError = undefined;
  const writePath = '/v1/connections/{connectionId}/product-title-updates';
  const writeUrl = `/v1/connections/${connectionId}/product-title-updates`;
  const payload = { productId: page.products[0].id, title: 'Updated title' };
  const writeOptions = { headers: { ...headers, 'idempotency-key': 'contract-write-1' }, payload };
  const first = await request('POST', writePath, writeUrl, 202, writeOptions);
  const repeat = await request('POST', writePath, writeUrl, 202, writeOptions);
  assert.equal(first.json().replayed, false);
  assert.equal(repeat.json().replayed, true);
  assert.equal(first.json().operation.id, repeat.json().operation.id);
  assert.equal(first.headers.location, `/v1/operations/${first.json().operation.id}`);
  await request('GET', '/v1/operations/{operationId}', first.headers.location, 200);
  await request('POST', writePath, writeUrl, 409, { ...writeOptions, payload: { ...payload, title: 'Conflict' } });
  await request('POST', writePath, writeUrl, 400, { ...writeOptions, payload: { ...payload, title: '   ' } });
  await request('POST', writePath, writeUrl, 413, { ...writeOptions, payload: { ...payload, title: 'x'.repeat(17000) } });
});

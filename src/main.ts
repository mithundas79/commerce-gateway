import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { buildApi, getTenantId, type Connection } from './api.js';
import { publicBaseUrl, required } from './admin.js';
import { decryptSecret, validateMasterKey } from './crypto.js';
import { ShopifyOAuth, hashOAuthValue } from './oauth.js';
import { ConnectorError, ShopifyConnector, validateShop } from './shopify.js';
import { PostgresStore } from './store.js';
import { startWorker, type ProductContext } from './worker.js';
import { startNotifications } from './notifications.js';

const cookieName = '__Host-shopify_oauth';
const cookieAttributes = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export function readBinding(cookie: string | undefined): string {
  const values = (cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
  if (values.length !== 1) return '';
  const value = values[0]!.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

export function createRuntime(pool: Pool, masterKey: string, baseUrl: string, logger = false) {
  const base = publicBaseUrl(baseUrl);
  const store = new PostgresStore(pool, masterKey);
  const oauth = new ShopifyOAuth({ getApp: tenant => store.getApp(tenant), states: store, tokens: store });
  const connector = new ShopifyConnector();
  const app = buildApi({ pool, logger, publicRoutes: ['/oauth/shopify/start','/oauth/shopify/callback'],
    readProducts: async (connection: Connection, options) => connector.listProducts({ shop: connection.shop, accessToken: await oauth.accessToken(connection.tenant_id,connection.shop), ...options }),
  });

  app.post<{ Body: { shop: string; returnUrl?: string } }>('/v1/shopify/connect', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['shop'], properties: { shop: { type:'string', maxLength:253 }, returnUrl: { type:'string', maxLength:2048 } } } },
  }, async (request, reply) => {
    const tenant = getTenantId(request);
    let shop: string;
    try { shop = validateShop(request.body.shop); } catch { return reply.code(400).send({ error:'INVALID_SHOP' }); }
    const config = await store.getApp(tenant);
    if (request.body.returnUrl !== undefined && !config.allowedReturnUrls.includes(request.body.returnUrl)) return reply.code(400).send({ error:'INVALID_RETURN_URL' });
    const ticket = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO oauth_browser_starts (ticket_hash,tenant_id,shop,return_url,expires_at) VALUES ($1,$2,$3,$4,now()+interval '2 minutes')`, [hashOAuthValue(ticket),tenant,shop,request.body.returnUrl ?? null]);
    return reply.header('cache-control','no-store').send({ browserStartUrl: `${base}/oauth/shopify/start?ticket=${ticket}`, expiresIn:120 });
  });

  app.get('/oauth/shopify/start', async (request, reply) => {
    reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
    const query = new URL(request.url,base).searchParams;
    const ticket = query.get('ticket');
    if (!ticket || query.getAll('ticket').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return reply.code(403).send({ error:'INVALID_BROWSER_START' });
    const row = (await pool.query('DELETE FROM oauth_browser_starts WHERE ticket_hash=$1 AND expires_at>now() RETURNING *', [hashOAuthValue(ticket)])).rows[0];
    if (!row) return reply.code(403).send({ error:'INVALID_BROWSER_START' });
    const binding = randomBytes(32).toString('base64url');
    const started = await oauth.start({ tenantId:row.tenant_id, shop:row.shop, browserBinding:binding, ...(row.return_url ? { returnUrl:row.return_url } : {}) });
    return reply.header('set-cookie',`${cookieName}=${binding}; ${cookieAttributes}; Max-Age=600`).redirect(started.authorizationUrl);
  });

  app.get('/oauth/shopify/callback', async (request, reply) => {
    reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
    try {
      const completed = await oauth.complete({ query:new URL(request.url,base).searchParams, browserBinding:readBinding(request.headers.cookie) });
      reply.header('set-cookie',`${cookieName}=; ${cookieAttributes}; Max-Age=0`);
      if (completed.returnUrl) return reply.redirect(completed.returnUrl);
      return { connected:true, shop:completed.shop };
    } catch (error) {
      const status = error instanceof ConnectorError && error.status < 500 ? error.status : 502;
      return reply.code(status).send({ error:'OAUTH_FAILED' });
    }
  });

  async function credentials(context: ProductContext) {
    context.signal.throwIfAborted();
    const row = (await pool.query('SELECT shop FROM connections WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL AND \'write_products\'=ANY(scopes)', [context.tenantId,context.connectionId])).rows[0];
    if (!row) throw new ConnectorError('PERMISSION','Connection is not authorized',403);
    const accessToken = await oauth.accessToken(context.tenantId,row.shop);
    context.signal.throwIfAborted();
    return { shop:row.shop as string, accessToken, productId:context.productId, signal:context.signal };
  }
  const provider = {
    readProductTitle: async (context:ProductContext) => (await connector.readProductTitle(await credentials(context)))?.title ?? null,
    updateProductTitle: async (context:ProductContext & { title:string }) => connector.updateProductTitle({ ...await credentials(context), title:context.title }),
  };
  return { app, store, oauth, provider };
}

export async function main(env = process.env): Promise<void> {
  const master = required(env,'MASTER_KEY'); validateMasterKey(master);
  const base = publicBaseUrl(required(env,'PUBLIC_BASE_URL'));
  const role = env.ROLE ?? 'api';
  if (!['api','worker'].includes(role)) throw new Error('ROLE must be api or worker');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const pool = new Pool({ connectionString:required(env,'DATABASE_URL'), max:10, connectionTimeoutMillis:10_000, idleTimeoutMillis:30_000, statement_timeout:30_000 });
  pool.on('error', () => { console.error('Database pool connection failed'); });
  const { app,provider } = createRuntime(pool,master,base,env.NODE_ENV !== 'test');
  const stop = new AbortController();
  const shutdown = () => { stop.abort(); if (role === 'api') void app.close(); };
  process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);
  try {
    await pool.query('SELECT 1');
    if (role === 'api') {
      await app.listen({ port,host:'0.0.0.0' });
      await new Promise<void>(resolve => { if (stop.signal.aborted) resolve(); else stop.signal.addEventListener('abort',() => resolve(),{ once:true }); });
    } else {
      const heartbeat = '/tmp/worker-heartbeat';
      await rm(heartbeat,{ force:true });
      let workerHealthy = false;
      let notificationsHealthy = false;
      let heartbeatUpdate = Promise.resolve();
      const publishHeartbeat = () => {
        heartbeatUpdate = heartbeatUpdate.catch(() => {}).then(() => workerHealthy && notificationsHealthy
          ? writeFile(heartbeat,String(Date.now()),{ mode:0o600 })
          : rm(heartbeat,{ force:true }));
        return heartbeatUpdate;
      };
      try {
        await Promise.all([
          startWorker({ pool,provider,signal:stop.signal,
            onHealthy:() => {workerHealthy=true; return publishHeartbeat();},
            onUnhealthy:() => {workerHealthy=false; return publishHeartbeat();} }),
          startNotifications({ pool,signal:stop.signal,decryptSecret:(ciphertext,tenant) => decryptSecret(ciphertext,master,`notification:${tenant}`),
            onHealthy:() => {notificationsHealthy=true; return publishHeartbeat();},
            onUnhealthy:() => {notificationsHealthy=false; return publishHeartbeat();} }),
        ]);
      } finally { stop.abort(); await heartbeatUpdate.catch(() => {}); await rm(heartbeat,{ force:true }); }
    }
  } finally {
    process.removeListener('SIGTERM',shutdown); process.removeListener('SIGINT',shutdown);
    await app.close(); await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error('Gateway startup failed. Check configuration and database availability.'); process.exitCode = 1; });
}

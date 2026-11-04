import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { hashOAuthValue, lifecycleTopics, ShopifyOAuth, verifyShopifyWebhook, webhookBinding, type LifecycleTopic as Topic } from './oauth.js';
import { ConnectorError, ShopifyConnector, validateShop } from './shopify.js';
import { PostgresStore } from './store.js';

export const shopifyWebhookRoute = '/webhooks/shopify/:clientId/:topic/:binding';
export { lifecycleTopics, webhookBinding, webhookSubscriptions } from './oauth.js';

function sameBinding(provided: string, expected: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(provided) && timingSafeEqual(Buffer.from(provided),Buffer.from(expected));
}
function identifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}
function identity(payload: any, topic: Topic): { shopId: string; shop?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid payload');
  const shopId = identifier(topic === 'app-uninstalled' ? payload.id : payload.shop_id);
  if (!shopId) throw new Error('Missing signed shop identity');
  const domain = topic === 'app-uninstalled' ? payload.myshopify_domain : payload.shop_domain;
  const shop = domain == null && topic === 'app-uninstalled' ? undefined : validateShop(domain);
  if (topic === 'customers-data-request' && (!payload.data_request || !identifier(payload.data_request.id) || !Array.isArray(payload.orders_requested))) throw new Error('Invalid data request');
  if (topic === 'customers-redact' && !Array.isArray(payload.orders_to_redact)) throw new Error('Invalid customer redaction');
  if (topic.startsWith('customers-')) {
    if (!payload.customer || (!identifier(payload.customer.id) && (typeof payload.customer.email !== 'string' || !payload.customer.email.length || payload.customer.email.length>320))) throw new Error('Missing customer identity');
    const orders=topic === 'customers-data-request' ? payload.orders_requested : payload.orders_to_redact;
    if (!orders.every((id:unknown) => identifier(id))) throw new Error('Invalid order identity');
  }
  return {shopId,...(shop ? {shop} : {})};
}

interface LifecycleEvent {
  id: string; client_id: string; topic: Topic; generation: string; tenant_id: string;
  connection_id: string; shop: string; status: string; attempt_count: number; fence_token: string;
}

export class ShopifyLifecycle {
  constructor(private readonly pool: Pool, private readonly store: PostgresStore,
    private readonly oauth: ShopifyOAuth, private readonly connector: ShopifyConnector) {}

  private async transaction<T>(tenant: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='2s'");
      // Same lock as OAuth refresh and app reconfiguration, with no network inside the transaction.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shopify:${tenant}`]);
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async receive(clientId: string, topic: Topic, signed: {shopId:string;shop?:string}, body: Buffer, binding: string, hmac: string, headerShop: unknown): Promise<string | undefined> {
    // Only the HMAC-authenticated payload chooses the shop. Header values never choose a tenant.
    const found = await this.pool.query(`SELECT c.* FROM connections c
      JOIN shopify_apps a ON a.tenant_id=c.tenant_id
      JOIN shopify_shop_owners o ON o.client_id=a.client_id AND o.shop=c.shop AND o.tenant_id=c.tenant_id
      WHERE a.client_id=$1 AND (($2::text IS NOT NULL AND c.shop=$2) OR ($2::text IS NULL AND c.shopify_shop_id=$3))`,[clientId,signed.shop ?? null,signed.shopId]);
    if (found.rows.length !== 1) {
      const receipt = await this.pool.query(`SELECT id FROM shopify_lifecycle_events WHERE client_id=$1 AND topic=$2 AND body_hash=$3
        AND status='processed' LIMIT 1`,[clientId,topic,createHash('sha256').update(body).digest('hex')]);
      if (receipt.rows.length) return undefined;
      // An id-only event cannot be attributed to a legacy connection without authenticated shop ID.
      if (!signed.shop) throw new ConnectorError('VALIDATION','Shop identity requires reconciliation',400);
      return undefined;
    }
    const connection = found.rows[0];
    const ownerApp=await this.store.getApp(connection.tenant_id);
    if (ownerApp.clientId!==clientId || !sameBinding(binding,webhookBinding(ownerApp,topic)) || !verifyShopifyWebhook(body,hmac,ownerApp.clientSecret)) throw new ConnectorError('AUTHENTICATION','Shop app signature mismatch',401);
    if (headerShop !== connection.shop) throw new ConnectorError('VALIDATION','Shop header mismatch',400);
    if (connection.shopify_shop_id && connection.shopify_shop_id !== signed.shopId) throw new ConnectorError('VALIDATION','Shop identity mismatch',400);
    return this.transaction(connection.tenant_id,async db => {
      const current = (await db.query('SELECT authorization_generation FROM connections WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[connection.id,connection.tenant_id])).rows[0];
      if (current?.authorization_generation !== connection.authorization_generation) throw new ConnectorError('TRANSIENT','Installation changed',503,true);
      const id = randomUUID();
      const result = await db.query(`INSERT INTO shopify_lifecycle_events
        (id,client_id,topic,body_hash,generation,tenant_id,connection_id,shop,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(client_id,topic,body_hash,generation) DO UPDATE SET status=EXCLUDED.status,
          attempt_count=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE shopify_lifecycle_events.status='ignored' RETURNING id`,
      [id,clientId,topic,createHash('sha256').update(body).digest('hex'),connection.authorization_generation,connection.tenant_id,connection.id,connection.shop,
        topic.startsWith('customers-') ? 'processed' : 'pending']);
      if (!result.rows[0]) return undefined;
      if (!topic.startsWith('customers-')) {
        await db.query('UPDATE connections SET lifecycle_hold=true WHERE id=$1 AND tenant_id=$2',[connection.id,connection.tenant_id]);
      }
      return result.rows[0].id as string;
    });
  }

  /** Proof runs outside DB transactions. The generation is checked again before any deletion. */
  async process(id: string): Promise<void> {
    const event = (await this.pool.query<LifecycleEvent>(`UPDATE shopify_lifecycle_events SET attempt_count=attempt_count+1,
      fence_token=fence_token+1,
      next_attempt_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp()
      WHERE id=$1 AND status='pending' AND next_attempt_at<=clock_timestamp() RETURNING *`,[id])).rows[0];
    if (!event) return;
    let inactive = false;
    let tokenSnapshot: string | undefined;
    try {
      const row = (await this.pool.query('SELECT authorization_generation,revoked_at FROM connections WHERE id=$1 AND tenant_id=$2',[event.connection_id,event.tenant_id])).rows[0];
      if (!row || row.authorization_generation !== event.generation) return await this.complete(event,false,'ignored');
      const tokens = await this.store.get(event.tenant_id,event.shop);
      if (!tokens) {
        inactive = (await this.pool.query(`SELECT id FROM shopify_lifecycle_events WHERE client_id=$1 AND generation=$2
          AND topic='app-uninstalled' AND status='processed' LIMIT 1`,[event.client_id,event.generation])).rows.length > 0;
        if (!inactive) throw new ConnectorError('AUTHENTICATION','Installation requires reconciliation',401);
        tokenSnapshot='';
      } else {
        const accessToken = await this.oauth.accessToken(event.tenant_id,event.shop);
        const snapshot = await this.store.getTokenSnapshot(event.tenant_id,event.shop);
        const current = snapshot?.tokens;
        tokenSnapshot=snapshot?.ciphertext;
        if (!current || current.accessToken !== accessToken) throw new ConnectorError('TRANSIENT','Credentials changed during reconciliation',503,true);
        try { await this.connector.readShopIdentity({shop:event.shop,accessToken}); }
        catch (error) {
          // An expired token or failed refresh does not prove that the merchant uninstalled.
          if (error instanceof ConnectorError && error.code === 'AUTHENTICATION' && current && current.expiresAt > Date.now()+60_000) inactive=true;
          else throw error;
        }
      }
      await this.complete(event,inactive,inactive ? 'processed' : 'ignored',tokenSnapshot);
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : 'TRANSIENT';
      const actionRequired = code === 'AUTHENTICATION' || event.attempt_count >= 8;
      await this.pool.query(`UPDATE shopify_lifecycle_events SET status=$2,last_error=$3,updated_at=clock_timestamp()
        WHERE id=$1 AND status='pending' AND fence_token=$4`,[event.id,actionRequired ? 'action_required' : 'pending',code,event.fence_token]);
    }
  }

  private async complete(event: LifecycleEvent, inactive: boolean, status: 'processed'|'ignored',tokenSnapshot?: string): Promise<void> {
    await this.transaction(event.tenant_id,async db => {
      const receipt=(await db.query('SELECT status,fence_token FROM shopify_lifecycle_events WHERE id=$1 FOR UPDATE',[event.id])).rows[0];
      if (receipt?.status!=='pending' || receipt.fence_token!==event.fence_token) return;
      const current = (await db.query(`SELECT c.authorization_generation,c.token_ciphertext,a.client_id FROM connections c
        JOIN shopify_apps a ON a.tenant_id=c.tenant_id WHERE c.id=$1 AND c.tenant_id=$2 FOR UPDATE OF c`,[event.connection_id,event.tenant_id])).rows[0];
      const sameInstallation = current?.authorization_generation === event.generation && current.client_id === event.client_id;
      if (!sameInstallation) status='ignored';
      if (sameInstallation && inactive && tokenSnapshot !== undefined && current.token_ciphertext !== tokenSnapshot) throw new ConnectorError('TRANSIENT','Credentials changed during reconciliation',503,true);
      if (sameInstallation && inactive) {
        await db.query(`UPDATE connections SET revoked_at=clock_timestamp(),token_ciphertext='',lifecycle_hold=true,updated_at=clock_timestamp()
          WHERE id=$1 AND tenant_id=$2`,[event.connection_id,event.tenant_id]);
        // Incrementing the fence prevents workers already holding leases from committing.
        await db.query(`UPDATE operations SET status=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE 'uncertain' END,
          error='{"code":"SHOPIFY_UNINSTALLED"}'::jsonb,fence_token=fence_token+1,lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE connection_id=$1 AND tenant_id=$2 AND status IN ('queued','retry','recovering','running')`,[event.connection_id,event.tenant_id]);
        await db.query('DELETE FROM oauth_states WHERE tenant_id=$1 AND shop=$2',[event.tenant_id,event.shop]);
        await db.query('DELETE FROM oauth_browser_starts WHERE tenant_id=$1 AND shop=$2',[event.tenant_id,event.shop]);
        if (event.topic === 'shop-redact') {
          await db.query('DELETE FROM notification_events WHERE operation_id IN (SELECT id FROM operations WHERE tenant_id=$1 AND connection_id=$2)',[event.tenant_id,event.connection_id]);
          await db.query('DELETE FROM operations WHERE tenant_id=$1 AND connection_id=$2',[event.tenant_id,event.connection_id]);
          await db.query('DELETE FROM connections WHERE tenant_id=$1 AND id=$2',[event.tenant_id,event.connection_id]);
          await db.query('DELETE FROM shopify_shop_owners WHERE client_id=$1 AND shop=$2 AND tenant_id=$3',[event.client_id,event.shop,event.tenant_id]);
          await db.query(`UPDATE shopify_lifecycle_events SET tenant_id=NULL,connection_id=NULL,shop=NULL,
            status=CASE WHEN status IN ('pending','action_required') THEN 'ignored' ELSE status END
            WHERE tenant_id=$1 AND shop=$2 AND client_id=$3`,[event.tenant_id,event.shop,event.client_id]);
        }
      }
      await db.query(`UPDATE shopify_lifecycle_events SET status=$2,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1`,[event.id,status]);
      if (sameInstallation && !inactive) {
        await db.query(`UPDATE connections SET lifecycle_hold=EXISTS(SELECT 1 FROM shopify_lifecycle_events
          WHERE connection_id=$1 AND generation=$2 AND status IN ('pending','action_required')) WHERE id=$1 AND tenant_id=$3`,[event.connection_id,event.generation,event.tenant_id]);
      }
    });
  }

  async reconcile(): Promise<void> {
    const events = await this.pool.query(`SELECT id FROM shopify_lifecycle_events WHERE status='pending'
      AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT 1`);
    for (const event of events.rows) await this.process(event.id);
  }

  async start(signal: AbortSignal, healthy: () => Promise<void>, unhealthy: () => Promise<void>): Promise<void> {
    while (!signal.aborted) {
      try { await this.reconcile(); await healthy(); }
      catch { await unhealthy(); }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const done = () => {clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
        const timer=setTimeout(done,1000);
        signal.addEventListener('abort',done,{once:true});
      });
    }
  }
}

export function registerShopifyWebhooks(app: FastifyInstance, pool: Pool, store: PostgresStore, lifecycle: ShopifyLifecycle): void {
  app.register(async scope => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done) => done(null,body));
    scope.post<{Params:{clientId:string;topic:Topic;binding:string};Body:Buffer}>('/webhooks/shopify/:clientId/:topic/:binding',{bodyLimit:1024*1024},async (request,reply) => {
      const {clientId,topic,binding} = request.params;
      if (!Object.hasOwn(lifecycleTopics,topic) || clientId.length>200) return reply.code(400).send({error:'INVALID_WEBHOOK'});
      if (!/^[A-Za-z0-9_-]{43}$/.test(binding)) return reply.code(401).send({error:'INVALID_WEBHOOK_SIGNATURE'});
      // Indexed capabilities select at most one secret even when thousands of tenants share an app.
      const candidate = (await pool.query(`SELECT tenant_id FROM shopify_apps
        WHERE client_id=$1 AND webhook_bindings @> ARRAY[$2]::text[] LIMIT 1`,[clientId,hashOAuthValue(binding)])).rows[0];
      if (!candidate) return reply.code(401).send({error:'INVALID_WEBHOOK_SIGNATURE'});
      const config = await store.getApp(candidate.tenant_id);
      const hmac=String(request.headers['x-shopify-hmac-sha256'] ?? '');
      if (config.clientId!==clientId || !sameBinding(binding,webhookBinding(config,topic)) || !verifyShopifyWebhook(request.body,hmac,config.clientSecret)) return reply.code(401).send({error:'INVALID_WEBHOOK_SIGNATURE'});
      if (request.headers['x-shopify-topic'] !== lifecycleTopics[topic]) return reply.code(400).send({error:'WEBHOOK_TOPIC_MISMATCH'});
      let signed: ReturnType<typeof identity>;
      try { signed=identity(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(request.body)),topic); }
      catch { return reply.code(400).send({error:'INVALID_WEBHOOK_PAYLOAD'}); }
      if (signed.shop && request.headers['x-shopify-shop-domain'] !== signed.shop) return reply.code(400).send({error:'WEBHOOK_SHOP_MISMATCH'});
      try {
        await lifecycle.receive(clientId,topic,signed,request.body,binding,hmac,request.headers['x-shopify-shop-domain']);
        return {accepted:true};
      } catch (error) {
        const status = error instanceof ConnectorError ? error.status : 503;
        return reply.code(status).send({error:'WEBHOOK_PROCESSING_FAILED'});
      }
    });
  });
}

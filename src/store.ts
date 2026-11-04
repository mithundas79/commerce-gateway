import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { decryptSecret, encryptSecret, validateMasterKey } from './crypto.js';
import { hashOAuthValue, lifecycleTopics, webhookBinding, type LifecycleTopic, type OfflineTokens, type OAuthState, type OAuthStateStore, type OAuthTokenStore, type ShopifyAppConfig } from './oauth.js';
import { ConnectorError } from './shopify.js';

/** Bounded maintenance uses database time and never touches operation/idempotency history. */
export async function cleanupExpiredOAuth(pool: Pick<Pool,'query'>, batchSize = 1000): Promise<{states:number;browserStarts:number}> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('OAuth cleanup batch must contain 1-10000 rows');
  const result = await pool.query(`WITH expired_states AS (
      SELECT state_hash FROM oauth_states WHERE expires_at <= statement_timestamp()
      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ), deleted_states AS (
      DELETE FROM oauth_states s USING expired_states e WHERE s.state_hash=e.state_hash RETURNING 1
    ), expired_starts AS (
      SELECT ticket_hash FROM oauth_browser_starts WHERE expires_at <= statement_timestamp()
      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ), deleted_starts AS (
      DELETE FROM oauth_browser_starts s USING expired_starts e WHERE s.ticket_hash=e.ticket_hash RETURNING 1
    ) SELECT (SELECT count(*)::int FROM deleted_states) AS states,
      (SELECT count(*)::int FROM deleted_starts) AS browser_starts`, [batchSize]);
  return {states:result.rows[0].states,browserStarts:result.rows[0].browser_starts};
}

export class PostgresStore implements OAuthStateStore, OAuthTokenStore {
  private readonly context = new AsyncLocalStorage<PoolClient>();
  constructor(readonly pool: Pool, private readonly masterKey: string) { validateMasterKey(masterKey); }
  private get db(): Pool | PoolClient { return this.context.getStore() ?? this.pool; }

  async getApp(tenantId: string): Promise<ShopifyAppConfig> {
    const result = await this.db.query('SELECT * FROM shopify_apps WHERE tenant_id = $1', [tenantId]);
    const row = result.rows[0];
    if (!row) throw new Error('Shopify app is not configured');
    return { clientId: row.client_id, clientSecret: decryptSecret(row.secret_ciphertext, this.masterKey, `app:${tenantId}`), redirectUri: row.redirect_uri, scopes: row.scopes, allowedReturnUrls: row.allowed_return_urls };
  }

  async configureApp(tenantId: string, app: ShopifyAppConfig): Promise<void> {
    await this.withLock(`${tenantId}:configuration`, async () => {
      const current = await this.db.query('SELECT client_id FROM shopify_apps WHERE tenant_id = $1', [tenantId]);
      if (current.rows[0] && current.rows[0].client_id !== app.clientId) {
        const active = await this.db.query('SELECT id FROM connections WHERE tenant_id = $1 AND revoked_at IS NULL LIMIT 1', [tenantId]);
        if (active.rows.length) throw new Error('Revoke active connections before changing the Shopify app identity');
      }
      const bindings=(Object.keys(lifecycleTopics) as LifecycleTopic[]).map(topic => hashOAuthValue(webhookBinding(app,topic)));
      await this.db.query(`INSERT INTO shopify_apps (tenant_id, client_id, secret_ciphertext, redirect_uri, scopes, allowed_return_urls, webhook_bindings)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id) DO UPDATE SET client_id=EXCLUDED.client_id,
        secret_ciphertext=EXCLUDED.secret_ciphertext, redirect_uri=EXCLUDED.redirect_uri, scopes=EXCLUDED.scopes,
        allowed_return_urls=EXCLUDED.allowed_return_urls, webhook_bindings=EXCLUDED.webhook_bindings, updated_at=now()`,
      [tenantId, app.clientId, encryptSecret(app.clientSecret, this.masterKey, `app:${tenantId}`), app.redirectUri, app.scopes, app.allowedReturnUrls,bindings]);
    });
  }

  /** Prime the indexed route capabilities when generating configuration for a pre-upgrade app. */
  async prepareWebhookSubscriptions(tenantId: string): Promise<ShopifyAppConfig> {
    return this.withLock(`${tenantId}:configuration`,async () => {
      const app=await this.getApp(tenantId);
      const bindings=(Object.keys(lifecycleTopics) as LifecycleTopic[]).map(topic => hashOAuthValue(webhookBinding(app,topic)));
      await this.db.query('UPDATE shopify_apps SET webhook_bindings=$2 WHERE tenant_id=$1',[tenantId,bindings]);
      return app;
    });
  }

  async create(state: OAuthState): Promise<void> {
    await this.db.query(`INSERT INTO oauth_states (state_hash,tenant_id,shop,browser_binding_hash,return_url,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)`, [state.stateHash,state.tenantId,state.shop,state.browserBindingHash,state.returnUrl ?? null,new Date(state.expiresAt)]);
  }
  private state(row: any): OAuthState | undefined {
    return row ? { stateHash: row.state_hash, tenantId: row.tenant_id, shop: row.shop, browserBindingHash: row.browser_binding_hash, expiresAt: new Date(row.expires_at).getTime(), ...(row.return_url ? { returnUrl: row.return_url } : {}) } : undefined;
  }
  // OAuth interfaces intentionally overload get for states versus tenant/shop tokens.
  get(stateHash: string): Promise<OAuthState | undefined>;
  get(tenantId: string, shop: string): Promise<OfflineTokens | undefined>;
  async get(id: string, shop?: string): Promise<OAuthState | OfflineTokens | undefined> {
    if (shop === undefined) return this.state((await this.db.query('SELECT * FROM oauth_states WHERE state_hash=$1', [id])).rows[0]);
    return (await this.getTokenSnapshot(id,shop))?.tokens;
  }
  async getTokenSnapshot(tenantId: string, shop: string): Promise<{tokens:OfflineTokens;ciphertext:string} | undefined> {
    const result = await this.db.query('SELECT token_ciphertext FROM connections WHERE tenant_id=$1 AND shop=$2 AND revoked_at IS NULL', [tenantId,shop]);
    const ciphertext=result.rows[0]?.token_ciphertext;
    return ciphertext ? {tokens:JSON.parse(decryptSecret(ciphertext,this.masterKey,`token:${tenantId}:${shop}`)) as OfflineTokens,ciphertext} : undefined;
  }
  async consume(stateHash: string, binding: string, shop: string, now: number): Promise<OAuthState | undefined> {
    return this.state((await this.db.query(`DELETE FROM oauth_states WHERE state_hash=$1 AND browser_binding_hash=$2 AND shop=$3 AND expires_at>$4 RETURNING *`, [stateHash,binding,shop,new Date(now)])).rows[0]);
  }
  async save(tenantId: string, shop: string, tokens: OfflineTokens): Promise<void> {
    if (!this.context.getStore()) throw new Error('Token writes require the distributed lock');
    const app = await this.getApp(tenantId);
    await this.db.query('BEGIN');
    try {
      await this.db.query(`INSERT INTO shopify_shop_owners (client_id,shop,tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [app.clientId,shop,tenantId]);
      const owner = (await this.db.query('SELECT tenant_id FROM shopify_shop_owners WHERE client_id=$1 AND shop=$2', [app.clientId,shop])).rows[0];
      if (owner?.tenant_id !== tenantId) throw new Error('Shopify shop authorization belongs to another tenant');
      if (tokens.authorizationId) await this.db.query(`UPDATE operations SET
        status=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE 'uncertain' END,
        error='{"code":"SHOPIFY_AUTHORIZATION_CHANGED"}'::jsonb,fence_token=fence_token+1,
        lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND connection_id IN (SELECT id FROM connections WHERE tenant_id=$1 AND shop=$2
          AND lifecycle_hold AND authorization_generation<>$3)
        AND status IN ('queued','retry','recovering','running')`,[tenantId,shop,tokens.authorizationId]);
      await this.db.query(`INSERT INTO connections (id,tenant_id,shop,token_ciphertext,scopes,shopify_shop_id,authorization_generation) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::uuid,gen_random_uuid()))
        ON CONFLICT (tenant_id,shop) DO UPDATE SET token_ciphertext=EXCLUDED.token_ciphertext,
        scopes=EXCLUDED.scopes, revoked_at=NULL, shopify_shop_id=COALESCE(EXCLUDED.shopify_shop_id,connections.shopify_shop_id),
        authorization_generation=COALESCE($7::uuid,connections.authorization_generation),
        lifecycle_hold=CASE WHEN $7::uuid IS NOT NULL AND connections.authorization_generation<>$7::uuid THEN false ELSE connections.lifecycle_hold END, updated_at=now()`,
      [randomUUID(),tenantId,shop,encryptSecret(JSON.stringify(tokens),this.masterKey,`token:${tenantId}:${shop}`),tokens.scopes,tokens.shopId ?? null,tokens.authorizationId ?? null]);
      if (tokens.authorizationId) await this.db.query(`UPDATE shopify_lifecycle_events SET status='ignored',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND shop=$2 AND generation<>$3 AND status IN ('pending','action_required')`,[tenantId,shop,tokens.authorizationId]);
      await this.db.query('COMMIT');
    } catch (error) { await this.db.query('ROLLBACK'); throw error; }
  }
  async delete(tenantId: string, shop: string): Promise<void> {
    if (!this.context.getStore()) throw new Error('Token writes require the distributed lock');
    await this.db.query(`UPDATE connections SET revoked_at=now(), token_ciphertext='', updated_at=now() WHERE tenant_id=$1 AND shop=$2`, [tenantId,shop]);
  }

  /** Dedicated session lock remains held across refresh HTTP and its atomic token rotation. */
  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) throw new Error('Nested token locks are unsupported');
    const client = await this.pool.connect();
    const tenant = key.split(':', 1)[0]!;
    const held: string[] = [];
    let broken = false;
    try {
      // Serializing a tenant also prevents app credential edits racing token exchange.
      const deadline = Date.now() + 25_000;
      const acquire = async (lock: string) => {
        while (!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lock])).rows[0].locked) {
          if (Date.now() >= deadline) throw new Error('Authorization is busy; retry later');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        held.push(lock);
      };
      await acquire(`shopify:${tenant}`);
      const shop = key.slice(tenant.length + 1);
      if (shop !== 'configuration') {
        const app = (await client.query('SELECT client_id FROM shopify_apps WHERE tenant_id=$1', [tenant])).rows[0];
        if (!app) throw new Error('Shopify app is not configured');
        await acquire(`shopify-owner:${app.client_id}:${shop}`);
        const owner = (await client.query('SELECT tenant_id FROM shopify_shop_owners WHERE client_id=$1 AND shop=$2', [app.client_id,shop])).rows[0];
        if (owner && owner.tenant_id !== tenant) throw new ConnectorError('PERMISSION','Shop authorization belongs to another tenant',403);
      }
      return await this.context.run(client, work);
    } finally {
      for (const lock of held.reverse()) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); }
        catch { broken = true; }
      }
      client.release(broken);
    }
  }
}

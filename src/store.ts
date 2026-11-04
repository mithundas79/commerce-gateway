import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { decryptSecret, encryptSecret, validateMasterKey } from './crypto.js';
import type { OfflineTokens, OAuthState, OAuthStateStore, OAuthTokenStore, ShopifyAppConfig } from './oauth.js';
import { ConnectorError } from './shopify.js';

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
      await this.db.query(`INSERT INTO shopify_apps (tenant_id, client_id, secret_ciphertext, redirect_uri, scopes, allowed_return_urls)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id) DO UPDATE SET client_id=EXCLUDED.client_id,
        secret_ciphertext=EXCLUDED.secret_ciphertext, redirect_uri=EXCLUDED.redirect_uri, scopes=EXCLUDED.scopes,
        allowed_return_urls=EXCLUDED.allowed_return_urls, updated_at=now()`,
      [tenantId, app.clientId, encryptSecret(app.clientSecret, this.masterKey, `app:${tenantId}`), app.redirectUri, app.scopes, app.allowedReturnUrls]);
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
    const result = await this.db.query('SELECT token_ciphertext FROM connections WHERE tenant_id=$1 AND shop=$2 AND revoked_at IS NULL', [id,shop]);
    return result.rows[0] ? JSON.parse(decryptSecret(result.rows[0].token_ciphertext, this.masterKey, `token:${id}:${shop}`)) as OfflineTokens : undefined;
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
      await this.db.query(`INSERT INTO connections (id,tenant_id,shop,token_ciphertext,scopes) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id,shop) DO UPDATE SET token_ciphertext=EXCLUDED.token_ciphertext,
        scopes=EXCLUDED.scopes, revoked_at=NULL, updated_at=now()`,
      [randomUUID(),tenantId,shop,encryptSecret(JSON.stringify(tokens),this.masterKey,`token:${tenantId}:${shop}`),tokens.scopes]);
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

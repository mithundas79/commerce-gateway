import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConnectorError, retryAfterMs, validateShop, type ShopifyFetch } from './shopify.js';

export interface ShopifyAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  allowedReturnUrls: string[];
}
export interface OAuthState {
  stateHash: string;
  tenantId: string;
  shop: string;
  browserBindingHash: string;
  returnUrl?: string;
  expiresAt: number;
}
export interface OAuthStateStore {
  create(state: OAuthState): Promise<void>;
  get(stateHash: string): Promise<OAuthState | undefined>;
  /** Atomically DELETE RETURNING only when all bindings match and expiresAt > now. */
  consume(stateHash: string, browserBindingHash: string, shop: string, now: number): Promise<OAuthState | undefined>;
}
export interface OfflineTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt: number;
  scopes: string[];
}
/** Adapters must encrypt token fields at rest and enforce app/shop tenant ownership. */
export interface OAuthTokenStore {
  get(tenantId: string, shop: string): Promise<OfflineTokens | undefined>;
  save(tenantId: string, shop: string, tokens: OfflineTokens): Promise<void>;
  delete(tenantId: string, shop: string): Promise<void>;
  /** Serialize across every process using this store, including callback token acquisition. */
  withLock<T>(key: string, work: () => Promise<T>): Promise<T>;
}
export function hashOAuthValue(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Verify the unparsed webhook body before trusting shop/topic headers or parsing JSON. */
export function verifyShopifyWebhook(rawBody: Uint8Array, hmac: string, secret: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(hmac)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(hmac, 'base64');
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export function verifyOAuthHmac(query: URLSearchParams, secret: string): boolean {
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length) return false; // Avoid parsing/signing ambiguities.
  const provided = query.get('hmac');
  if (!provided || !/^[a-f0-9]{64}$/i.test(provided)) return false;
  const message = [...query.entries()].filter(([key]) => key !== 'hmac').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
  const expected = createHmac('sha256', secret).update(message).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

export function hasScope(granted: string[], scope: string): boolean {
  return granted.includes(scope) || (scope.startsWith('read_') && granted.includes(`write_${scope.slice(5)}`));
}

function secureUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectorError('VALIDATION', 'Invalid OAuth URL', 400); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash) throw new ConnectorError('VALIDATION', 'OAuth URL must use HTTPS (localhost excepted)', 400);
  return url;
}

/** Standalone OAuth. Credentials/tokens never leave the server. See README for adapter guarantees. */
export class ShopifyOAuth {
  private readonly request: ShopifyFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly options: {
    getApp: (tenantId: string) => Promise<ShopifyAppConfig>;
    states: OAuthStateStore;
    tokens: OAuthTokenStore;
    fetch?: ShopifyFetch;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  }

  private async app(tenantId: string) {
    const app = await this.options.getApp(tenantId);
    if (!app.clientId || !app.clientSecret || !Array.isArray(app.scopes) || !app.scopes.length || app.scopes.some(s => !/^[a-z][a-z0-9_]*$/.test(s))) throw new Error('Shopify app is not configured');
    secureUrl(app.redirectUri);
    return app;
  }

  async start(input: { tenantId: string; shop: string; browserBinding: string; returnUrl?: string }) {
    const shop = validateShop(input.shop);
    if (!input.tenantId || typeof input.browserBinding !== 'string' || input.browserBinding.length < 32) throw new ConnectorError('VALIDATION', 'An authenticated tenant and browser binding are required', 400);
    const app = await this.app(input.tenantId);
    if (input.returnUrl !== undefined) {
      secureUrl(input.returnUrl);
      if (!app.allowedReturnUrls.includes(input.returnUrl)) throw new ConnectorError('VALIDATION', 'Return URL is not allowlisted', 400);
    }
    const state = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + 10 * 60_000;
    await this.options.states.create({ stateHash: hashOAuthValue(state), tenantId: input.tenantId, shop, browserBindingHash: hashOAuthValue(input.browserBinding), expiresAt, ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }) });
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: app.clientId, scope: app.scopes.join(','), redirect_uri: app.redirectUri, state }).toString();
    // Absence of grant_options[]=per-user selects the offline flow.
    return { authorizationUrl: url.toString(), state, expiresAt };
  }

  async complete(input: { query: URLSearchParams; browserBinding: string }) {
    const state = input.query.get('state');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof input.browserBinding !== 'string') throw new ConnectorError('AUTHENTICATION', 'Invalid OAuth callback', 403);
    const stateHash = hashOAuthValue(state);
    const stored = await this.options.states.get(stateHash);
    const shop = validateShop(input.query.get('shop') ?? '');
    const bindingHash = hashOAuthValue(input.browserBinding);
    if (!stored || stored.expiresAt <= this.now() || stored.shop !== shop || stored.browserBindingHash !== bindingHash) throw new ConnectorError('AUTHENTICATION', 'Invalid or expired OAuth state', 403);
    const app = await this.app(stored.tenantId);
    if (!verifyOAuthHmac(input.query, app.clientSecret)) throw new ConnectorError('AUTHENTICATION', 'Invalid OAuth callback signature', 403);
    const timestamp = Number(input.query.get('timestamp'));
    if (!Number.isSafeInteger(timestamp) || Math.abs(this.now() - timestamp * 1000) > 10 * 60_000) throw new ConnectorError('AUTHENTICATION', 'Expired OAuth callback', 403);
    const code = input.query.get('code');
    if (!code || code.length > 2048) throw new ConnectorError('AUTHENTICATION', 'Missing OAuth code', 403);
    // Check the return target again if configuration changed while consent was open.
    if (stored.returnUrl && !app.allowedReturnUrls.includes(stored.returnUrl)) throw new ConnectorError('VALIDATION', 'Return URL is no longer allowlisted', 400);
    const consumed = await this.options.states.consume(stateHash, bindingHash, shop, this.now());
    if (!consumed) throw new ConnectorError('AUTHENTICATION', 'OAuth state has already been used', 403);
    await this.options.tokens.withLock(`${stored.tenantId}:${shop}`, async () => {
      // Tenant configuration may have changed while waiting for another refresh.
      const lockedApp = await this.app(stored.tenantId);
      if (!verifyOAuthHmac(input.query, lockedApp.clientSecret)) throw new ConnectorError('AUTHENTICATION', 'Shopify app credentials changed during authorization', 403);
      if (stored.returnUrl && !lockedApp.allowedReturnUrls.includes(stored.returnUrl)) throw new ConnectorError('VALIDATION','Return URL is no longer allowlisted',400);
      const tokens = await this.exchange(shop, lockedApp, { code, expiring: '1' });
      await this.options.tokens.save(stored.tenantId, shop, tokens);
    });
    return { tenantId: stored.tenantId, shop, scopes: app.scopes, ...(stored.returnUrl ? { returnUrl: stored.returnUrl } : {}) };
  }

  private async exchange(shop: string, app: ShopifyAppConfig, grant: Record<string, string>): Promise<OfflineTokens> {
    let response: Response;
    let payload: any;
    try {
      response = await this.request(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...grant }), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 429) throw new ConnectorError('RATE_LIMITED', 'Shopify token endpoint throttled', 429, true, false, retryAfterMs(response));
      if (response.status >= 500) throw new ConnectorError('TRANSIENT', 'Shopify token endpoint unavailable', 503, true);
      if (response.status === 401) throw new ConnectorError('AUTHENTICATION', 'Shop authorization must be renewed', 401);
      if (!response.ok) throw new ConnectorError('UPSTREAM_REJECTED', 'Shopify token exchange rejected');
      payload = await response.json();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('TRANSIENT', 'Shopify token exchange could not complete', 503, true);
    }
    if (typeof payload?.access_token !== 'string' || !payload.access_token || typeof payload.refresh_token !== 'string' || !payload.refresh_token || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || !Number.isFinite(payload.refresh_token_expires_in) || payload.refresh_token_expires_in <= 0 || typeof payload.scope !== 'string') throw new ConnectorError('UPSTREAM_REJECTED', 'Shopify did not return a valid expiring offline token pair');
    const scopes = payload.scope.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (app.scopes.some(scope => !hasScope(scopes, scope))) throw new ConnectorError('PERMISSION', 'Shopify did not grant the required scopes', 403);
    return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: this.now() + payload.expires_in * 1000, refreshTokenExpiresAt: this.now() + payload.refresh_token_expires_in * 1000, scopes };
  }

  async accessToken(tenantId: string, shop: string): Promise<string> {
    validateShop(shop);
    // Normal reads use one short pooled query and never wait behind token refresh HTTP.
    const available = await this.options.tokens.get(tenantId,shop);
    if (!available) throw new ConnectorError('AUTHENTICATION','Shop authorization required',401);
    if (available.expiresAt > this.now()+60_000) return available.accessToken;
    return this.options.tokens.withLock(`${tenantId}:${shop}`, async () => {
      // A different process may already have completed rotation while we waited.
      const current = await this.options.tokens.get(tenantId, shop);
      if (!current) throw new ConnectorError('AUTHENTICATION', 'Shop authorization required', 401);
      if (current.expiresAt > this.now() + 60_000) return current.accessToken;
      if (current.refreshTokenExpiresAt <= this.now()) {
        await this.options.tokens.delete(tenantId, shop);
        throw new ConnectorError('AUTHENTICATION', 'Shop authorization must be renewed', 401);
      }
      try {
        const next = await this.exchange(shop, await this.app(tenantId), { grant_type: 'refresh_token', refresh_token: current.refreshToken });
        await this.options.tokens.save(tenantId, shop, next);
        return next.accessToken;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === 'AUTHENTICATION') await this.options.tokens.delete(tenantId, shop);
        throw error;
      }
    });
  }
}

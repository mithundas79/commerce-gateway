export const SHOPIFY_API_VERSION = '2026-10';

export type ConnectorErrorCode = 'VALIDATION' | 'AUTHENTICATION' | 'PERMISSION' | 'RATE_LIMITED' | 'TRANSIENT' | 'AMBIGUOUS_WRITE' | 'API_VERSION_MISMATCH' | 'UPSTREAM_REJECTED';
export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly status = 502,
    public readonly retryable = false,
    public readonly ambiguous = false,
    public readonly retryAfterMs?: number,
  ) { super(message); this.name = 'ConnectorError'; }
}

/** Accept only canonical myshopify hosts: never URLs, ports, paths or custom hosts. */
export function validateShop(shop: string): string {
  if (typeof shop !== 'string' || shop.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)) {
    throw new ConnectorError('VALIDATION', 'A canonical myshopify.com shop domain is required', 400);
  }
  return shop;
}

export interface ShopifyProduct { id: string; title: string; updatedAt: string }
export interface ShopifyCredentials { shop: string; accessToken: string; signal?: AbortSignal }
export interface ProductIdentity extends ShopifyCredentials { productId: string }
export type ShopifyFetch = typeof globalThis.fetch;

export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(300_000, Math.max(0, ms)) : undefined;
}

function validProductId(id: string) {
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(id)) throw new ConnectorError('VALIDATION', 'A Shopify Product GID is required', 400);
}
function product(value: any): ShopifyProduct {
  if (!value || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Malformed product response');
  }
  return { id: value.id, title: value.title, updatedAt: value.updatedAt };
}

/** No automatic mutation retries: a transport failure can occur after Shopify commits. */
export class ShopifyConnector {
  private readonly request: ShopifyFetch;
  private readonly timeoutMs: number;
  constructor(options: { fetch?: ShopifyFetch; timeoutMs?: number } = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  }

  private async graphql(credentials: ShopifyCredentials, query: string, variables: object, write: boolean): Promise<any> {
    const shop = validateShop(credentials.shop);
    if (!credentials.accessToken) throw new ConnectorError('AUTHENTICATION', 'Shop authorization required', 401);
    let response: Response;
    let payload: any;
    try {
      response = await this.request(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Shopify-Access-Token': credentials.accessToken },
        body: JSON.stringify({ query, variables }), signal: credentials.signal ? AbortSignal.any([credentials.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      // Shopify silently falls forward on retired versions. Refuse such responses.
      const version = response.headers.get('x-shopify-api-version');
      if (version && version !== SHOPIFY_API_VERSION) {
        throw new ConnectorError('API_VERSION_MISMATCH', 'Shopify returned an unexpected API version', 502, false, write);
      }
      if (response.status === 401) throw new ConnectorError('AUTHENTICATION', 'Shop authorization required', 401);
      if (response.status === 403) throw new ConnectorError('PERMISSION', 'Shopify denied the requested permission', 403);
      if (response.status === 429) throw new ConnectorError('RATE_LIMITED', 'Shopify rate limit reached', 429, true, false, retryAfterMs(response));
      if (response.status === 408) throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'TRANSIENT', 'Shopify request timed out', 503, !write, write);
      if (response.status >= 500) throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'TRANSIENT', 'Shopify service failure', 503, !write, write);
      if (!response.ok) throw new ConnectorError('UPSTREAM_REJECTED', 'Shopify rejected the request');
      payload = await response.json();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'TRANSIENT', write ? 'Shopify write outcome is unknown; reconcile before retrying' : 'Shopify could not be reached', 503, !write, write);
    }
    if (!payload || typeof payload !== 'object') throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'TRANSIENT', 'Invalid Shopify response', 502, !write, write);
    if (payload.errors !== undefined && !Array.isArray(payload.errors)) throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'TRANSIENT', 'Malformed Shopify errors', 502, !write, write);
    if (payload.errors?.length) {
      const codes = payload.errors.map((e: any) => e?.extensions?.code);
      // Partial data on a mutation means that execution might have occurred.
      const partialWrite = write && payload.data != null;
      if (!partialWrite && codes.every((code: string) => code === 'THROTTLED')) throw new ConnectorError('RATE_LIMITED', 'Shopify query throttled', 429, true);
      if (!partialWrite && codes.every((code: string) => code === 'ACCESS_DENIED')) throw new ConnectorError('PERMISSION', 'Shopify denied the requested permission', 403);
      throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'UPSTREAM_REJECTED', 'Shopify GraphQL request failed', 502, false, write);
    }
    if (!payload.data) throw new ConnectorError(write ? 'AMBIGUOUS_WRITE' : 'TRANSIENT', 'Missing Shopify result', 502, !write, write);
    return payload.data;
  }

  async listProducts(input: ShopifyCredentials & { first?: number; after?: string }) {
    const first = input.first ?? 50;
    if (!Number.isInteger(first) || first < 1 || first > 100 || (input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 2048))) throw new ConnectorError('VALIDATION', 'Invalid product pagination', 400);
    const data = await this.graphql(input, `query Products($first: Int!, $after: String) { products(first: $first, after: $after, sortKey: ID) { nodes { id title updatedAt } pageInfo { hasNextPage endCursor } } }`, { first, after: input.after ?? null }, false);
    try {
      const page = data.products.pageInfo;
      if (!Array.isArray(data.products.nodes) || typeof page.hasNextPage !== 'boolean' || (page.endCursor !== null && typeof page.endCursor !== 'string')) throw new Error();
      return { products: data.products.nodes.map(product) as ShopifyProduct[], pageInfo: { hasNextPage: page.hasNextPage as boolean, endCursor: page.endCursor as string | null } };
    } catch { throw new ConnectorError('TRANSIENT', 'Malformed Shopify product list', 502, true); }
  }

  async readShopIdentity(input: ShopifyCredentials): Promise<{ id: string; shop: string }> {
    const data = await this.graphql(input, 'query GatewayShopIdentity { shop { id myshopifyDomain } }', {}, false);
    const id = /^gid:\/\/shopify\/Shop\/([1-9]\d*)$/.exec(data.shop?.id ?? '')?.[1];
    if (!id || data.shop?.myshopifyDomain !== input.shop) throw new ConnectorError('TRANSIENT', 'Invalid Shopify shop identity', 503, true);
    return { id, shop: input.shop };
  }

  async readProductTitle(input: ProductIdentity): Promise<ShopifyProduct | null> {
    validProductId(input.productId);
    const data = await this.graphql(input, `query ProductTitle($id: ID!) { product(id: $id) { id title updatedAt } }`, { id: input.productId }, false);
    if (data.product === null) return null;
    try {
      const found = product(data.product);
      if (found.id !== input.productId) throw new Error();
      return found;
    } catch { throw new ConnectorError('TRANSIENT', 'Malformed Shopify product', 502, true); }
  }

  async updateProductTitle(input: ProductIdentity & { title: string }): Promise<ShopifyProduct> {
    validProductId(input.productId);
    if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 255) throw new ConnectorError('VALIDATION', 'Title must contain 1-255 characters', 400);
    const data = await this.graphql(input, `mutation ProductTitleUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title updatedAt } userErrors { field message } } }`, { product: { id: input.productId, title: input.title } }, true);
    const result = data.productUpdate;
    if (Array.isArray(result?.userErrors) && result.userErrors.length > 0 && !result.product) throw new ConnectorError('UPSTREAM_REJECTED', 'Shopify rejected the title update', 422);
    try {
      if (!Array.isArray(result?.userErrors) || result.userErrors.length) throw new Error();
      const updated = product(result.product);
      if (updated.id !== input.productId || updated.title !== input.title) throw new Error();
      return updated;
    } catch { throw new ConnectorError('AMBIGUOUS_WRITE', 'Shopify write outcome requires reconciliation', 502, false, true); }
  }
}

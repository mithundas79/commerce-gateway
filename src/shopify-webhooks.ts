import { webhookBinding, type ShopifyAppConfig } from './oauth.js';
import { SHOPIFY_API_VERSION, validateShop, type ShopifyFetch } from './shopify.js';

type SetupCode = 'HTTPS_REQUIRED' | 'ACTIVE_CONNECTION_REQUIRED' | 'PROVIDER_REQUEST_FAILED' |
  'API_VERSION_MISMATCH' | 'INVALID_PROVIDER_RESPONSE' | 'SUBSCRIPTION_CONFLICT' | 'CREATE_REJECTED' | 'READBACK_FAILED';
/** Only fixed codes reach the CLI: provider responses can contain secret callback URLs. */
export class WebhookSetupError extends Error {
  constructor(readonly code: SetupCode) { super(code); }
}

const listQuery = `query GatewayUninstallWebhooks {
  webhookSubscriptions(first:100,topics:[APP_UNINSTALLED]) {
    nodes { id topic uri format apiVersion { handle } }
    pageInfo { hasNextPage }
  }
}`;
const createQuery = `mutation GatewayUninstallWebhook($subscription:WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic:APP_UNINSTALLED,webhookSubscription:$subscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

export async function ensureUninstallWebhook(options: {
  shop: string; accessToken: string; app: ShopifyAppConfig; origin: string; fetch?: ShopifyFetch;
}): Promise<{shop:string;topic:'APP_UNINSTALLED';subscriptionId:string;apiVersion:string;verified:true}> {
  const shop = validateShop(options.shop);
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new WebhookSetupError('HTTPS_REQUIRED');
  if (!options.accessToken) throw new WebhookSetupError('ACTIVE_CONNECTION_REQUIRED');
  const uri = `${origin.origin}/webhooks/shopify/${encodeURIComponent(options.app.clientId)}/app-uninstalled/${webhookBinding(options.app,'app-uninstalled')}`;
  const request = async (query: string, variables: object = {}) => {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
        headers:{'content-type':'application/json',accept:'application/json','X-Shopify-Access-Token':options.accessToken},
        body:JSON.stringify({query,variables}),
      });
    } catch { throw new WebhookSetupError('PROVIDER_REQUEST_FAILED'); }
    if (!response.ok) throw new WebhookSetupError('PROVIDER_REQUEST_FAILED');
    if (response.headers.get('x-shopify-api-version') !== SHOPIFY_API_VERSION) throw new WebhookSetupError('API_VERSION_MISMATCH');
    let payload;
    try { payload = await response.json() as any; } catch { throw new WebhookSetupError('INVALID_PROVIDER_RESPONSE'); }
    if (!payload?.data || payload.errors?.length) throw new WebhookSetupError('INVALID_PROVIDER_RESPONSE');
    return payload.data;
  };
  const read = async (): Promise<string | undefined> => {
    const result = (await request(listQuery)).webhookSubscriptions;
    if (!Array.isArray(result?.nodes) || typeof result.pageInfo?.hasNextPage !== 'boolean') throw new WebhookSetupError('INVALID_PROVIDER_RESPONSE');
    if (result.pageInfo.hasNextPage || result.nodes.length > 1) throw new WebhookSetupError('SUBSCRIPTION_CONFLICT');
    if (!result.nodes.length) return undefined;
    const node = result.nodes[0];
    if (!/^gid:\/\/shopify\/WebhookSubscription\/[1-9]\d*$/.test(node?.id ?? '') || node.topic !== 'APP_UNINSTALLED') throw new WebhookSetupError('INVALID_PROVIDER_RESPONSE');
    if (node.uri !== uri || node.format !== 'JSON' || node.apiVersion?.handle !== SHOPIFY_API_VERSION) throw new WebhookSetupError('SUBSCRIPTION_CONFLICT');
    return node.id;
  };
  let id = await read();
  if (!id) {
    try {
      const result = (await request(createQuery,{subscription:{uri,format:'JSON'}})).webhookSubscriptionCreate;
      if (!Array.isArray(result?.userErrors) || result.userErrors.length || !result.webhookSubscription?.id) throw new WebhookSetupError('CREATE_REJECTED');
    } catch (error) {
      // The request may have committed before a timeout. Reconcile with a read;
      // never blindly replay the mutation. A later invocation also reads first.
      id = await read();
      if (!id) throw error;
    }
    id = await read();
    if (!id) throw new WebhookSetupError('READBACK_FAILED');
  }
  return {shop,topic:'APP_UNINSTALLED',subscriptionId:id,apiVersion:SHOPIFY_API_VERSION,verified:true};
}

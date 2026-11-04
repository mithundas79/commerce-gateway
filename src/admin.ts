import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { encryptSecret, validateMasterKey } from './crypto.js';
import { PostgresStore } from './store.js';
import { configureNotificationEndpoint, disableNotificationEndpoint } from './notifications.js';
import { releaseUncertainOperation } from './worker.js';
import { webhookSubscriptions } from './lifecycle.js';

export const help = `Commerce Gateway administration
  migrate                 Apply checksummed SQL migrations (DATABASE_URL)
  bootstrap               Create tenant and scoped API key (TENANT_ID, API_KEY; optional TENANT_NAME)
  revoke-api-key          Revoke a tenant API key (TENANT_ID, API_KEY); repeat bootstrap with a new key to rotate
  configure-shopify       Store encrypted app credentials for TENANT_ID
                          SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_SCOPES (comma-separated)
                          optional SHOPIFY_RETURN_URLS (comma-separated), PUBLIC_BASE_URL, MASTER_KEY
  shopify-webhooks         Print secret subscription TOML for TENANT_ID (MASTER_KEY, PUBLIC_BASE_URL)
  shopify-lifecycle        List pending/action-required provider events for TENANT_ID
  retry-shopify-lifecycle Retry unresolved events for TENANT_ID after credential reconciliation
  configure-notification Store completion webhook (TENANT_ID, NOTIFICATION_URL, NOTIFICATION_SECRET, MASTER_KEY)
  disable-notification   Disable completion webhook for TENANT_ID
  release-uncertain      Release a product ordering hold after operator reconciliation
                          TENANT_ID, OPERATION_ID, ACKNOWLEDGE_DELAYED_WRITE_RISK=true
  --help                  Show this help
Secrets are accepted through environment variables. shopify-webhooks prints secret URLs for protected configuration only.`;

export function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
export function publicBaseUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (localhost development excepted)');
  return url.origin;
}
export function tenantId(env: NodeJS.ProcessEnv): string {
  const id = required(env, 'TENANT_ID');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new Error('TENANT_ID must be a UUID');
  return id.toLowerCase();
}

export async function migrate(pool: Pool, directory = new URL('../migrations/', import.meta.url)): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('commerce-gateway:migrations',0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter(name => /^\d+\.sql$/.test(name)).sort();
    if (!files.length) throw new Error('No SQL migrations were found');
    const applied = await client.query<{name:string;sha256:string}>('SELECT name,sha256 FROM schema_migrations');
    const checksums = new Map(applied.rows.map(row => [row.name,row.sha256]));
    if (applied.rows.some(row => !files.includes(row.name))) throw new Error('Database has migrations absent from this build; use a compatible gateway version');
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = checksums.get(name);
      if (existing !== undefined) {
        if (existing !== checksum) throw new Error(`Applied migration checksum differs: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        // SQL files can also be applied directly; the runner owns this transaction.
        const transaction = /^\s*BEGIN\s*;([\s\S]*)COMMIT\s*;\s*$/i.exec(sql);
        if (!transaction) throw new Error(`Migration requires a BEGIN/COMMIT envelope: ${name}`);
        await client.query(transaction[1]!);
        await client.query('INSERT INTO schema_migrations (name,sha256) VALUES ($1,$2)', [name,checksum]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtextextended('commerce-gateway:migrations',0))"); } catch { broken = true; }
    client.release(broken);
  }
}

export async function bootstrap(pool: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  const tenant = tenantId(env);
  const key = required(env, 'API_KEY');
  if (key.length < 32 || key.length > 512 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(key)) throw new Error('API_KEY must contain 32-512 bearer-token characters');
  const hash = createHash('sha256').update(key).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO tenants (id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tenant,env.TENANT_NAME || 'Default tenant']);
    await client.query('INSERT INTO api_keys (id,token_hash,tenant_id) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO NOTHING', [randomUUID(),hash,tenant]);
    const result = await client.query('SELECT tenant_id,revoked_at FROM api_keys WHERE token_hash=$1 FOR UPDATE', [hash]);
    if (result.rows[0]?.tenant_id !== tenant || result.rows[0]?.revoked_at) throw new Error('API_KEY already belongs to another tenant or was revoked');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function revokeApiKey(pool: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  const tenant = tenantId(env);
  const hash = createHash('sha256').update(required(env,'API_KEY')).digest('hex');
  const result = await pool.query('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND token_hash=$2 RETURNING id', [tenant,hash]);
  if (!result.rows[0]) throw new Error('API key was not found for this tenant');
}

export async function runAdmin(args: string[], env = process.env): Promise<void> {
  if (args.length === 0 || args.length === 1 && ['--help','-h','help'].includes(args[0]!)) { console.log(help); return; }
  if (args.length !== 1 || !['migrate','bootstrap','revoke-api-key','configure-shopify','shopify-webhooks','shopify-lifecycle','retry-shopify-lifecycle','configure-notification','disable-notification','release-uncertain'].includes(args[0]!)) throw new Error('Unknown command; use --help');
  const pool = new Pool({ connectionString: required(env,'DATABASE_URL'), connectionTimeoutMillis: 10_000 });
  try {
    switch (args[0]) {
      case 'shopify-webhooks': {
        const config = await new PostgresStore(pool,required(env,'MASTER_KEY')).prepareWebhookSubscriptions(tenantId(env));
        process.stdout.write(webhookSubscriptions(config,publicBaseUrl(required(env,'PUBLIC_BASE_URL'))));
        break;
      }
      case 'shopify-lifecycle': {
        const events = await pool.query(`SELECT id,topic,status,attempt_count,last_error,created_at,updated_at
          FROM shopify_lifecycle_events WHERE tenant_id=$1 AND status IN ('pending','action_required') ORDER BY created_at`,[tenantId(env)]);
        console.log(JSON.stringify(events.rows));
        break;
      }
      case 'retry-shopify-lifecycle':
        await pool.query(`UPDATE shopify_lifecycle_events SET status='pending',attempt_count=0,next_attempt_at=clock_timestamp()
          WHERE tenant_id=$1 AND status='action_required'`,[tenantId(env)]);
        break;
      case 'migrate': await migrate(pool); break;
      case 'bootstrap': await bootstrap(pool,env); break;
      case 'revoke-api-key': await revokeApiKey(pool,env); break;
      case 'configure-shopify': {
        const master = required(env,'MASTER_KEY'); validateMasterKey(master);
        const scopes = required(env,'SHOPIFY_SCOPES').split(',').map(s => s.trim());
        if (!scopes.length || scopes.some(s => !/^[a-z][a-z0-9_]*$/.test(s)) || !scopes.includes('write_products')) throw new Error('SHOPIFY_SCOPES must include write_products');
        const returns = (env.SHOPIFY_RETURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const value of returns) {
          const url = new URL(value);
          if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('SHOPIFY_RETURN_URLS must contain HTTPS URLs without credentials or fragments');
        }
        await new PostgresStore(pool,master).configureApp(tenantId(env), { clientId: required(env,'SHOPIFY_CLIENT_ID'), clientSecret: required(env,'SHOPIFY_CLIENT_SECRET'),
          redirectUri: `${publicBaseUrl(required(env,'PUBLIC_BASE_URL'))}/oauth/shopify/callback`, scopes: [...new Set(scopes)], allowedReturnUrls: returns });
        break;
      }
      case 'configure-notification': {
        const tenant = tenantId(env); const secret = required(env,'NOTIFICATION_SECRET');
        if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) throw new Error('NOTIFICATION_SECRET must contain 32-4096 bytes');
        await configureNotificationEndpoint(pool, { tenantId: tenant, url: required(env,'NOTIFICATION_URL'), secretCiphertext: encryptSecret(secret,required(env,'MASTER_KEY'),`notification:${tenant}`) });
        break;
      }
      case 'disable-notification': await disableNotificationEndpoint(pool,tenantId(env)); break;
      case 'release-uncertain': {
        const operation = required(env,'OPERATION_ID');
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(operation)) throw new Error('OPERATION_ID must be a UUID');
        if (env.ACKNOWLEDGE_DELAYED_WRITE_RISK !== 'true') throw new Error('Reconcile the delayed provider write and set ACKNOWLEDGE_DELAYED_WRITE_RISK=true');
        if (!await releaseUncertainOperation(pool,{tenantId:tenantId(env),operationId:operation.toLowerCase()})) throw new Error('An uncertain operation was not found for this tenant');
        break;
      }
    }
    console.log('Administration command completed');
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAdmin(process.argv.slice(2)).catch(() => { console.error('Administration command failed. Check configuration and database connectivity.'); process.exitCode = 1; });
}

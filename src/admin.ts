import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { encryptSecret, validateMasterKey } from './crypto.js';
import { PostgresStore } from './store.js';
import { configureNotificationEndpoint, disableNotificationEndpoint } from './notifications.js';

export const help = `Commerce Gateway administration
  migrate                 Apply checksummed SQL migrations (DATABASE_URL)
  bootstrap               Create tenant and scoped API key (TENANT_ID, API_KEY; optional TENANT_NAME)
  configure-shopify       Store encrypted app credentials for TENANT_ID
                          SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_SCOPES (comma-separated)
                          optional SHOPIFY_RETURN_URLS (comma-separated), PUBLIC_BASE_URL, MASTER_KEY
  configure-notification Store completion webhook (TENANT_ID, NOTIFICATION_URL, NOTIFICATION_SECRET, MASTER_KEY)
  disable-notification   Disable completion webhook for TENANT_ID
  --help                  Show this help
Secrets are accepted through environment variables and never printed.`;

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
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== checksum) throw new Error(`Applied migration checksum differs: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        // SQL files can also be applied directly; the runner owns this transaction.
        await client.query(sql.replace(/^\s*BEGIN\s*;/i, '').replace(/COMMIT\s*;\s*$/i, ''));
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

export async function runAdmin(args: string[], env = process.env): Promise<void> {
  if (args.length === 0 || args.length === 1 && ['--help','-h','help'].includes(args[0]!)) { console.log(help); return; }
  if (args.length !== 1 || !['migrate','bootstrap','configure-shopify','configure-notification','disable-notification'].includes(args[0]!)) throw new Error('Unknown command; use --help');
  const pool = new Pool({ connectionString: required(env,'DATABASE_URL'), connectionTimeoutMillis: 10_000 });
  try {
    switch (args[0]) {
      case 'migrate': await migrate(pool); break;
      case 'bootstrap': await bootstrap(pool,env); break;
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
        if (Buffer.byteLength(secret) < 32) throw new Error('NOTIFICATION_SECRET must contain at least 32 bytes');
        await configureNotificationEndpoint(pool, { tenantId: tenant, url: required(env,'NOTIFICATION_URL'), secretCiphertext: encryptSecret(secret,required(env,'MASTER_KEY'),`notification:${tenant}`) });
        break;
      }
      case 'disable-notification': await disableNotificationEndpoint(pool,tenantId(env)); break;
    }
    console.log('Administration command completed');
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAdmin(process.argv.slice(2)).catch(() => { console.error('Administration command failed. Check configuration and database connectivity.'); process.exitCode = 1; });
}

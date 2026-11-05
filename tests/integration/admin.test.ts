import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Pool } from 'pg';
import { parse } from 'smol-toml';
import { webhookBinding } from '../../src/oauth.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/admin.js', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL integration tests');

test('built admin commands support repeatable initialization and redirectable compliance TOML', async () => {
  const schema = `admin_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const env = { ...process.env, DATABASE_URL: isolatedUrl.toString(), TENANT_ID: randomUUID(),
    TENANT_NAME: 'CLI acceptance tenant', API_KEY: `qa-bootstrap-${randomUUID()}` };
  const run = (command: string, overrides: Record<string, string> = {}) => exec(process.execPath, [cli, command], {
    env: { ...env, ...overrides }, timeout: 15_000,
  });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await run('migrate');
    await run('migrate');
    await run('bootstrap');
    await run('bootstrap');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.tenants`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.api_keys WHERE tenant_id=$1`, [env.TENANT_ID])).rows[0].count, 1);
    const tokenHash = (await pool.query(`SELECT token_hash FROM ${schema}.api_keys WHERE tenant_id=$1`, [env.TENANT_ID])).rows[0].token_hash;
    assert.equal(tokenHash.length, 64);
    assert.notEqual(tokenHash, env.API_KEY);
    await assert.rejects(run('bootstrap', { TENANT_ID: randomUUID() }), 'An existing API key cannot move into a different tenant');
    const appEnv = {MASTER_KEY:Buffer.alloc(32,7).toString('hex'),SHOPIFY_CLIENT_ID:'cli-test-app',
      SHOPIFY_CLIENT_SECRET:'synthetic-cli-app-secret',SHOPIFY_SCOPES:'write_products',PUBLIC_BASE_URL:'https://gateway.example'};
    await run('configure-shopify',appEnv);
    const {stdout,stderr} = await run('shopify-webhooks',appEnv);
    // Parse the entire actual CLI stdout, just as an installer redirects it.
    // No line filtering or string slicing: a trailing status line must fail this test.
    const parsed = parse(stdout) as any;
    assert.equal(parsed.webhooks.api_version,'2026-10');
    assert.deepEqual(parsed.webhooks.subscriptions.map((item:any) => item.compliance_topics),
      [['customers/data_request'],['customers/redact'],['shop/redact']]);
    assert.ok(parsed.webhooks.subscriptions.every((item:any) => !('topics' in item)));
    for (const [index,topic] of ['customers-data-request','customers-redact','shop-redact'].entries()) {
      const binding=webhookBinding({clientId:appEnv.SHOPIFY_CLIENT_ID,clientSecret:appEnv.SHOPIFY_CLIENT_SECRET},topic as 'shop-redact');
      assert.equal(parsed.webhooks.subscriptions[index].uri,`https://gateway.example/webhooks/shopify/cli-test-app/${topic}/${binding}`);
    }
    assert.ok(!stdout.includes(appEnv.SHOPIFY_CLIENT_SECRET));
    assert.match(stderr,/Administration command completed/);
    assert.equal((await run('shopify-webhooks',appEnv)).stdout,stdout);
    assert.deepEqual(JSON.parse((await run('shopify-lifecycle')).stdout),[]);
    await assert.rejects(run('shopify-uninstall-webhook',{...appEnv,SHOPIFY_SHOP:'unconnected.myshopify.com'}),
      (error:any) => error.stdout === '' && error.stderr.includes('ACTIVE_CONNECTION_REQUIRED'));
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Pool } from 'pg';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/admin.js', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for real PostgreSQL integration tests');

test('built migration and bootstrap commands support repeatable production initialization', async () => {
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
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});

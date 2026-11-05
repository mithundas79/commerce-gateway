import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startEnqueueDiagnostics } from './bench-diagnostics.mjs';

/** Nearest-rank percentiles; all attempted request latencies are included. */
export function summarize(samples, errors = 0, elapsedMs = 0) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('At least one finite, nonnegative latency sample is required');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  const round = value => Number(value.toFixed(3));
  return {
    requests: sorted.length, errors,
    p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)), p99Ms: round(percentile(0.99)),
    minMs: round(sorted[0]), maxMs: round(sorted.at(-1)),
    meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    elapsedMs: round(elapsedMs),
    requestsPerSecond: elapsedMs > 0 ? round(sorted.length * 1_000 / elapsedMs) : 0,
  };
}

/** Closed-loop load: exactly concurrency clients, each awaiting its current response. */
export async function runLoad({ requests, concurrency, request }) {
  const samples = [];
  const errorCounts = {};
  let next = 0;
  let errors = 0;
  const resourceSampleIntervalMs = 10;
  const initialMemory = process.memoryUsage();
  let peakRssBytes = initialMemory.rss;
  let peakHeapUsedBytes = initialMemory.heapUsed;
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
    return memory;
  };
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const resourceTimer = setInterval(sampleMemory, resourceSampleIntervalMs);
  resourceTimer.unref();
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
      while (next < requests) {
        const index = next++;
        const began = performance.now();
        try {
          await request(index);
        } catch (error) {
          errors++;
          // Fixed error codes only: never print request credentials or provider data.
          const code = typeof error?.code === 'string' && /^[A-Z_0-9]{1,80}$/.test(error.code)
            ? error.code : 'REQUEST_FAILED';
          errorCounts[code] = (errorCounts[code] ?? 0) + 1;
        } finally {
          samples.push(performance.now() - began);
        }
      }
    }));
  } finally {
    clearInterval(resourceTimer);
  }
  const finalMemory = sampleMemory();
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const round = value => Number(value.toFixed(3));
  return {
    ...summarize(samples, errors, elapsedMs), errorCounts,
    resources: {
      cpuUserMs: round(cpu.user / 1_000),
      cpuSystemMs: round(cpu.system / 1_000),
      cpuTotalMs: round((cpu.user + cpu.system) / 1_000),
      cpuPercentOfOneCore: round((cpu.user + cpu.system) / (elapsedMs * 10)),
      rssStartBytes: initialMemory.rss, rssEndBytes: finalMemory.rss, sampledPeakRssBytes: peakRssBytes,
      heapUsedStartBytes: initialMemory.heapUsed, heapUsedEndBytes: finalMemory.heapUsed,
      sampledPeakHeapUsedBytes: peakHeapUsedBytes, sampleIntervalMs: resourceSampleIntervalMs,
    },
  };
}

function integer(env, key, fallback, min, max) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} is out of range`);
  return value;
}

export async function benchmark(env = process.env) {
  // Never silently select a deployment DATABASE_URL. This explicitly targets a disposable test DB.
  const databaseUrl = env.BENCH_DATABASE_URL ?? env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('BENCH_DATABASE_URL (disposable PostgreSQL database) is required');
  const requests = integer(env, 'BENCH_REQUESTS', 1_000, 20, 1_000_000);
  const concurrency = integer(env, 'BENCH_CONCURRENCY', 16, 1, 1_024);
  const warmup = integer(env, 'BENCH_WARMUP', 100, 1, 100_000);
  const timeoutMs = integer(env, 'BENCH_TIMEOUT_MS', 10_000, 1, 120_000);
  const p95ThresholdMs = integer(env, 'BENCH_P95_MS', 100, 1, 120_000);
  const pgPoolSize = integer(env, 'BENCH_POOL_SIZE', 16, 1, 1_024);
  const replayKeys = integer(env, 'BENCH_REPLAY_KEYS', 20, 1, 10_000);
  const diagnosticsEnabled = env.BENCH_DIAGNOSTICS === '1';
  const pg = await import('pg');
  const { Pool } = pg.default ?? pg;
  const apiModule = env.BENCH_API_MODULE
    ? pathToFileURL(resolve(env.BENCH_API_MODULE)).href : new URL('../dist/api.js', import.meta.url).href;
  const { buildApi } = await import(apiModule);
  const schema = `bench_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `commerce-benchmark-${schema}`;
  const diagnosticOptions = diagnosticsEnabled ? ' -c track_io_timing=on -c track_wal_io_timing=on' : '';
  const observer = diagnosticsEnabled ? new Pool({ connectionString: databaseUrl, max: 1,
    application_name: 'commerce-benchmark-observer', options: diagnosticOptions.trim(),
    connectionTimeoutMillis: timeoutMs, statement_timeout: 1_000 }) : undefined;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({ connectionString: databaseUrl, max: pgPoolSize,
    application_name: applicationName, options: `-c search_path=${schema}${diagnosticOptions}`, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs });
  let app;
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const migrationsDir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrationsDir)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      await pool.query(await readFile(new URL(file, migrationsDir), 'utf8'));
    }
    const tenantId = randomUUID();
    const connectionId = randomUUID();
    const key = `bench-${randomUUID()}`;
    const productId = 'gid://shopify/Product/123';
    await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Disposable benchmark']);
    await pool.query('INSERT INTO api_keys(id,tenant_id,token_hash) VALUES($1,$2,$3)',
      [randomUUID(), tenantId, createHash('sha256').update(key).digest('hex')]);
    await pool.query('INSERT INTO connections(id,tenant_id,shop,token_ciphertext,scopes) VALUES($1,$2,$3,$4,$5)',
      [connectionId, tenantId, 'benchmark.myshopify.com', 'benchmark-unused-no-provider-calls', ['read_products', 'write_products']]);
    const postgres = (await pool.query('SHOW server_version')).rows[0].server_version;
    const synchronousCommit = (await pool.query('SHOW synchronous_commit')).rows[0].synchronous_commit;
    const fsync = (await pool.query('SHOW fsync')).rows[0].fsync;
    if (synchronousCommit === 'off' || fsync !== 'on') {
      throw new Error('Benchmark requires synchronous_commit and fsync enabled for durable enqueue');
    }
    const products = Array.from({ length: 25 }, (_, index) => ({
      id: `gid://shopify/Product/${index + 1}`, title: `Benchmark product ${index + 1}`,
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    app = buildApi({ pool, logger: false, readProducts: async () => ({ products,
      pageInfo: { hasNextPage: false, endCursor: null } }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const postBody = JSON.stringify({ productId, title: 'Benchmark durable title' });
    const replayIds = new Map();
    const http = async (path, options, expectedStatus) => {
      const response = await fetch(`${origin}${path}`, { ...options,
        headers: { ...headers, ...options?.headers }, signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json();
      if (response.status !== expectedStatus) {
        throw Object.assign(new Error('Unexpected HTTP status'), { code: `HTTP_${response.status}` });
      }
      return body;
    };
    const read = async () => {
      const body = await http(`/v1/connections/${connectionId}/products?first=25`, {}, 200);
      if (body.products?.length !== 25) throw Object.assign(new Error('Invalid read response'), { code: 'READ_VALIDATION' });
    };
    const enqueue = async (idempotencyKey, expectedReplay) => {
      const body = await http(`/v1/connections/${connectionId}/product-title-updates`, {
        method: 'POST', body: postBody, headers: { 'idempotency-key': idempotencyKey },
      }, 202);
      if (typeof body.operation?.id !== 'string' || body.replayed !== expectedReplay) {
        throw Object.assign(new Error('Invalid enqueue response'), { code: 'ENQUEUE_VALIDATION' });
      }
      return body.operation.id;
    };
    // Seed the replay working set; measured replay requests must return the original durable IDs.
    for (let index = 0; index < replayKeys; index++) {
      replayIds.set(index, await enqueue(`replay:${index}`, false));
    }
    const replay = async index => {
      const slot = index % replayKeys;
      if (await enqueue(`replay:${slot}`, true) !== replayIds.get(slot)) {
        throw Object.assign(new Error('Replay returned a new operation'), { code: 'IDEMPOTENCY_VALIDATION' });
      }
    };
    const workload = async (name, request) => {
      const capture = observer && name === 'durable_unique_enqueue'
        ? await startEnqueueDiagnostics({ observer, applicationPool: pool, applicationName }) : undefined;
      let result;
      let diagnostics;
      try {
        result = await runLoad({ requests, concurrency, request });
      } finally {
        if (capture) diagnostics = await capture.finish();
      }
      return { name, ...result, ...(diagnostics ? { diagnostics } : {}),
        passed: result.errors === 0 && result.p95Ms <= p95ThresholdMs && (!diagnostics || diagnostics.passed) };
    };
    const warmupRead = await runLoad({ requests: warmup, concurrency, request: read });
    const warmupEnqueue = await runLoad({ requests: warmup, concurrency,
      request: index => enqueue(`warmup:${index}`, false) });
    const warmupReplay = await runLoad({ requests: warmup, concurrency, request: replay });
    if ([warmupRead, warmupEnqueue, warmupReplay].some(result => result.errors)) {
      throw new Error('Benchmark warmup failed; check API/database compatibility');
    }
    const results = [];
    results.push(await workload('authenticated_product_read', read));
    results.push(await workload('durable_unique_enqueue', index => enqueue(`unique:${index}`, false)));
    results.push(await workload('durable_idempotent_replay', replay));
    // Also race first submissions on one key. Exactly one insert must win.
    let winners = 0;
    const concurrentIds = new Set();
    const contested = await runLoad({ requests, concurrency, request: async () => {
      const body = await http(`/v1/connections/${connectionId}/product-title-updates`, {
        method: 'POST', body: postBody, headers: { 'idempotency-key': 'contested:first' },
      }, 202);
      if (typeof body.operation?.id !== 'string' || typeof body.replayed !== 'boolean') {
        throw Object.assign(new Error('Invalid contested enqueue response'), { code: 'ENQUEUE_VALIDATION' });
      }
      if (!body.replayed) winners++;
      concurrentIds.add(body.operation.id);
    } });
    results.push({ name: 'durable_contended_idempotency', ...contested,
      passed: contested.errors === 0 && contested.p95Ms <= p95ThresholdMs && winners === 1 && concurrentIds.size === 1,
      insertedResponses: winners, distinctOperationIds: concurrentIds.size });
    const actualRows = Number((await pool.query('SELECT count(*) AS count FROM operations WHERE tenant_id=$1', [tenantId])).rows[0].count);
    const expectedRows = replayKeys + warmup + requests + 1;
    const durableRowsPassed = actualRows === expectedRows;
    return {
      benchmark: 'commerce-gateway-local-overhead', timestamp: new Date().toISOString(),
      testedRevision: env.GITHUB_SHA ?? null, sourceRevision: env.BENCH_SOURCE_SHA ?? null,
      measurement: 'Loopback TCP HTTP response including auth, validation, PostgreSQL and JSON; excludes Shopify network/worker completion. Closed-loop clients; no open-loop saturation claim.',
      resourceMeasurement: {
        scope: 'Current Node.js process combines the gateway API and HTTP load generator. PostgreSQL runs separately and is excluded.',
        cpu: 'Per-workload process.cpuUsage deltas, including all process threads. Percent is relative to one CPU core and may exceed 100.',
        memory: 'Absolute process RSS and V8 heap used at workload boundaries and every 10 ms. Sampled peaks are lower bounds and include retained memory from prior workloads.',
        limits: 'Host capacity is reported below. No explicit process CPU or memory limit is imposed by this benchmark; runner or container limits may apply.',
      },
      runtime: { node: process.version, v8: process.versions.v8, platform: process.platform,
        architecture: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), postgres, synchronousCommit, fsync },
      config: { requestsPerWorkload: requests, concurrency,
        warmup: { authenticated_product_read: warmup, durable_unique_enqueue: warmup,
          durable_idempotent_replay: warmup, durable_contended_idempotency: 0 },
        pgPoolSize, replayKeys, timeoutMs, p95ThresholdMs, diagnosticsEnabled, loggerEnabled: false, percentileMethod: 'nearest-rank' },
      workloads: results,
      errors: results.reduce((sum, result) => sum + result.errors, 0),
      durability: { expectedOperationRows: expectedRows, actualOperationRows: actualRows, passed: durableRowsPassed },
      passed: durableRowsPassed && results.every(result => result.passed),
    };
  } finally {
    try { if (app) await app.close(); }
    finally {
      await pool.end();
      if (observer) await observer.end();
      try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    }
  }
}


/** Shared by the CLI and deterministic shell exit-propagation verification. */
export function emitBenchmarkReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await benchmark();
    emitBenchmarkReport(report);
  } catch (error) {
    // Configuration messages contain names only; DB exception messages can contain credentials.
    const message = /^(BENCH_|Benchmark requires|Benchmark warmup)/.test(error?.message ?? '')
      ? error.message : 'Benchmark failed during setup or execution; inspect the local API/database configuration';
    process.stderr.write(`${JSON.stringify({ benchmark: 'commerce-gateway-local-overhead', passed: false, error: message })}\n`);
    process.exitCode = 1;
  }
}

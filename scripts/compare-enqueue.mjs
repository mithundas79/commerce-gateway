import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';

const databaseUrl = process.env.BENCH_DATABASE_URL;
if (!databaseUrl) throw new Error('BENCH_DATABASE_URL is required');
const output = resolve('benchmark-comparison-output');
await mkdir(output, { recursive: true });
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const results = [];
const benchmarkEntry = resolve(process.env.DIAGNOSTIC_BENCH_ENTRY ?? 'scripts/bench.mjs');

async function snapshot() {
  await pool.query('SELECT pg_stat_clear_snapshot()');
  return (await pool.query(`SELECT clock_timestamp() AS at, pg_current_wal_insert_lsn()::text AS lsn,
    current_setting('track_wal_io_timing') AS wal_timing,
    (SELECT row_to_json(w) FROM pg_stat_wal w) AS wal,
    (SELECT json_agg(i ORDER BY backend_type,context) FROM pg_stat_io i WHERE object='wal') AS wal_io,
    (SELECT json_agg(s ORDER BY name) FROM pg_stat_slru s WHERE name LIKE 'MultiXact%' OR name LIKE 'multixact%') AS multixact,
    (SELECT row_to_json(d) FROM pg_stat_database d WHERE datname=current_database()) AS database`)).rows[0];
}

function counterDeltas(before, after, keys) {
  return Object.fromEntries(keys.map(key => [key,
    before?.[key] == null || after?.[key] == null ? null : Number(after[key]) - Number(before[key]),
  ]));
}

function walIoDeltas(before, after) {
  return after.map(row => ({
    backend_type: row.backend_type, context: row.context,
    ...counterDeltas(before.find(old => old.backend_type === row.backend_type && old.context === row.context), row,
      ['writes', 'write_bytes', 'write_time', 'fsyncs', 'fsync_time']),
  }));
}

function benchmark(directory, prefix, sourceSha) {
  return new Promise((resolveRun, reject) => {
    // Use one pinned telemetry entry with the selected runtime module in each fresh process.
    const child = spawn(process.execPath, [benchmarkEntry], { cwd: directory,
      env: { ...process.env, BENCH_API_MODULE: resolve(directory, 'dist/api.js'), BENCH_SOURCE_SHA: sourceSha },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (exitCode, signal) => {
      try {
        await writeFile(`${prefix}.stdout.json`, stdout);
        await writeFile(`${prefix}.stderr.txt`, stderr);
        let report = null;
        try { report = stdout ? JSON.parse(stdout) : null; }
        catch { /* Keep malformed output and continue collecting the other paired runs. */ }
        resolveRun({ exitCode, signal, report });
      } catch (error) { reject(error); }
    });
  });
}

try {
  const sourceFiles = ['scripts/bench.mjs', 'src/api.ts', 'package-lock.json'];
  const sourceHashes = [];
  const telemetryHashes = [];
  for (const path of ['scripts/bench.mjs', 'scripts/bench-diagnostics.mjs']) {
    telemetryHashes.push({ path, sha256: createHash('sha256').update(await readFile(resolve('.bench/telemetry', path))).digest('hex') });
  }
  for (const path of sourceFiles) {
    const hashes = {};
    for (const variant of ['baseline', 'candidate']) {
      hashes[variant] = createHash('sha256').update(await readFile(resolve('.bench', variant, path))).digest('hex');
    }
    sourceHashes.push({ path, ...hashes, identical: hashes.baseline === hashes.candidate });
  }
  // Pair one runs baseline/candidate, and pair two reverses the order on the same runner and service.
  for (const [index, variant] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
    const before = await snapshot();
    if (before.wal_timing !== 'on') throw new Error('Disposable PostgreSQL WAL timing must be enabled');
    const prefix = resolve(output, `${index + 1}-${variant}`);
    const sourceSha = process.env[`${variant.toUpperCase()}_SHA`];
    const run = await benchmark(resolve('.bench', variant), prefix, sourceSha);
    // All benchmark connections have closed, flushing their cumulative statistics before this snapshot.
    const after = await snapshot();
    const walBytes = Number((await pool.query('SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn) AS bytes',
      [after.lsn, before.lsn])).rows[0].bytes);
    const result = { position: index + 1, variant, sha: sourceSha, telemetrySha: process.env.TELEMETRY_SHA, ...run,
      postgres: { scope: 'Whole benchmark invocation, including schema creation, warmup and cleanup. Cluster-wide counters may include background activity.',
        before, after, walBytes,
        walDelta: counterDeltas(before.wal, after.wal, ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full']),
        walIoDelta: walIoDeltas(before.wal_io ?? [], after.wal_io ?? []),
        multixactDelta: (after.multixact ?? []).map(row => ({ name: row.name,
          ...counterDeltas(before.multixact?.find(old => old.name === row.name), row,
            ['blks_zeroed', 'blks_hit', 'blks_read', 'blks_written', 'flushes', 'truncates']),
        })),
      } };
    await writeFile(`${prefix}.evidence.json`, `${JSON.stringify(result, null, 2)}\n`);
    results.push(result);
    console.log(`${index + 1} ${variant}: exit ${run.exitCode}, unique enqueue p95 ${run.report?.workloads?.find(row => row.name === 'durable_unique_enqueue')?.p95Ms ?? 'unavailable'} ms`);
  }
  const lines = ['# Same-runner enqueue comparison', '',
    'Existing benchmark, default 100 ms p95 gate, synchronous commit and fsync retained. Order is baseline/candidate, then candidate/baseline.', '',
    '| Position | Variant | Workload | p50 ms | p95 ms | p99 ms | Errors | Passed |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |'];
  for (const result of results) {
    for (const workload of result.report?.workloads ?? []) {
      lines.push(`| ${result.position} | ${result.variant} | ${workload.name} | ${workload.p50Ms} | ${workload.p95Ms} | ${workload.p99Ms} | ${workload.errors} | ${workload.passed} |`);
    }
  }
  lines.push('', '| Position | Variant | Exit | Durable rows passed | WAL bytes | WAL writes | WAL fsyncs | WAL write ms | WAL fsync ms |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    const total = field => result.postgres.walIoDelta.reduce((sum, row) => sum + (row[field] ?? 0), 0);
    lines.push(`| ${result.position} | ${result.variant} | ${result.exitCode} | ${result.report?.durability?.passed ?? false} | ${result.postgres.walBytes} | ${total('writes')} | ${total('fsyncs')} | ${total('write_time').toFixed(3)} | ${total('fsync_time').toFixed(3)} |`);
  }
  lines.push('', 'WAL I/O covers each complete invocation, including setup, warmup and teardown. Counters are cluster-wide, and cumulative statistics can lag background activity. Raw snapshots and MultiXact deltas are included in artifacts.', '',
    '| Source | Baseline/candidate identical |', '| --- | --- |');
  for (const source of sourceHashes) lines.push(`| ${source.path} | ${source.identical} |`);
  lines.push('', '| Position | Variant | Unique enqueue WAL fsyncs | WAL fsync ms | Advisory observations | WalSync observations |',
    '| --- | --- | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    const diagnostic = result.report?.workloads.find(workload => workload.name==='durable_unique_enqueue')?.diagnostics;
    const before = diagnostic?.before.io.find(row => row.backend_type==='client backend' && row.object==='wal' && row.context==='normal');
    const after = diagnostic?.after.io.find(row => row.backend_type==='client backend' && row.object==='wal' && row.context==='normal');
    const observed = event => diagnostic?.waitObservations.filter(row => row.waitEvent===event).reduce((sum,row) => sum+row.backends,0) ?? 0;
    lines.push(`| ${result.position} | ${result.variant} | ${before && after ? after.fsyncs-before.fsyncs : 'unavailable'} | ${before && after ? (after.fsync_time-before.fsync_time).toFixed(3) : 'unavailable'} | ${observed('advisory')} | ${observed('WalSync')} |`);
  }
  lines.push('', 'Targeted figures cover only the unique enqueue workload using the same pinned telemetry on both runtimes. These counters are cluster-wide and include observer/background activity. Wait observations count sampled backends, not elapsed wait time.',
    '', `Telemetry commit ${process.env.TELEMETRY_SHA}. Baseline ${process.env.BASELINE_SHA}. Candidate ${process.env.CANDIDATE_SHA}.`);
  const summary = `${lines.join('\n')}\n`;
  await writeFile(resolve(output, 'summary.md'), summary);
  await writeFile(resolve(output, 'comparison.json'), `${JSON.stringify({ telemetrySha: process.env.TELEMETRY_SHA, benchmarkEntry, telemetryHashes, sourceHashes, results }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (results.some(result => result.exitCode !== 0 || !result.report?.passed)) process.exitCode = 1;
} finally {
  await pool.end();
}

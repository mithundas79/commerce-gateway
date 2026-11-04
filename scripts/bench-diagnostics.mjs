import { performance } from 'node:perf_hooks';

const snapshotSql = `
  SELECT jsonb_build_object(
    'capturedAt', clock_timestamp(),
    'walLsn', pg_current_wal_lsn(),
    'wal', (SELECT to_jsonb(w) FROM pg_stat_wal w),
    'io', (SELECT jsonb_agg(to_jsonb(i) ORDER BY backend_type,object,context) FROM pg_stat_io i),
    'slru', (SELECT jsonb_agg(to_jsonb(s) ORDER BY name) FROM pg_stat_slru s WHERE name IN ('MultiXactMember','MultiXactOffset','Xact')),
    'checkpointer', (SELECT to_jsonb(c) FROM pg_stat_checkpointer c),
    'database', (SELECT to_jsonb(d) FROM pg_stat_database d WHERE datname=current_database()),
    'settings', (SELECT jsonb_object_agg(name,setting) FROM pg_settings WHERE name IN (
      'fsync','synchronous_commit','wal_sync_method','track_io_timing','track_wal_io_timing',
      'checkpoint_timeout','max_wal_size','shared_buffers','commit_delay','commit_siblings'))
  ) AS snapshot`;

const waitsSql = `
  SELECT state, wait_event_type AS "waitType", wait_event AS "waitEvent",
    count(*)::int AS backends,
    round(max(extract(epoch FROM (clock_timestamp()-query_start))*1000)::numeric,3)::float8 AS "oldestQueryMs"
  FROM pg_stat_activity
  WHERE application_name=$1 AND backend_type='client backend'
  GROUP BY state,wait_event_type,wait_event ORDER BY state,wait_event_type,wait_event`;

// Force only the warmed benchmark clients' pending stats out at idle boundaries.
// Holding every client avoids repeatedly flushing the same connection.
async function flushApplicationStats(pool) {
  const clients = [];
  const count = pool.totalCount;
  try {
    for (let index=0; index<count; index++) clients.push(await pool.connect());
    await Promise.all(clients.map(client => client.query('SELECT pg_stat_force_next_flush()')));
  } finally {
    clients.forEach(client => client.release());
  }
}

/** Observer work runs on its own connection and never consumes an API pool slot. */
export async function startEnqueueDiagnostics({ observer, applicationPool, applicationName }) {
  await flushApplicationStats(applicationPool);
  const before = (await observer.query(snapshotSql)).rows[0].snapshot;
  const intervalMs = 50;
  const samples = [];
  let queryErrors = 0;
  let skippedTicks = 0;
  let inFlight;
  const started = performance.now();
  const sample = () => {
    if (inFlight) { skippedTicks++; return; }
    const began = performance.now();
    inFlight = observer.query(waitsSql, [applicationName]).then(result => {
      samples.push({ beganMs: Number((began-started).toFixed(3)),
        endedMs: Number((performance.now()-started).toFixed(3)), waits: result.rows });
    }).catch(() => { queryErrors++; }).finally(() => { inFlight=undefined; });
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    async finish() {
      const measurementEndMs = performance.now()-started;
      clearInterval(timer);
      await inFlight;
      await flushApplicationStats(applicationPool);
      const after = (await observer.query(snapshotSql)).rows[0].snapshot;
      const observations = new Map();
      for (const snapshot of samples) {
        for (const row of snapshot.waits) {
          const key = JSON.stringify([row.state,row.waitType,row.waitEvent]);
          observations.set(key,(observations.get(key) ?? 0)+row.backends);
        }
      }
      return {
        passed: queryErrors===0, intervalMs, queryErrors, skippedTicks,
        measurementEndMs: Number(measurementEndMs.toFixed(3)),
        observerQueryWallMs: Number(samples.reduce((sum,sample) => sum+sample.endedMs-sample.beganMs,0).toFixed(3)),
        scope: 'One non-overlapping pg_stat_activity aggregate every 50 ms on a separate observer connection. Only tagged benchmark API backends are sampled. No query text, credentials or merchant payloads are recorded. Observer SQL and optional I/O timing can perturb the measurement.',
        counters: 'Before/after cluster-wide cumulative snapshots include other PostgreSQL activity and observer overhead. Benchmark client statistics are forced to flush outside latency timing. Background process statistics can lag. PostgreSQL 18 WAL write/fsync timings are in pg_stat_io object=wal.',
        observationUnits: 'Backend observations summed across snapshots, not elapsed wait time. A null wait event means running or unreported, not proof of CPU usage.',
        waitObservations: [...observations].map(([key,backends]) => {
          const [state,waitType,waitEvent]=JSON.parse(key);
          return {state,waitType,waitEvent,backends};
        }),
        before, after, samples,
      };
    },
  };
}

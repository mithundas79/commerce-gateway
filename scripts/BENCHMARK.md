# Gateway overhead benchmark

Build the project, then run against a disposable PostgreSQL database:

```sh
npm ci
npm run build
BENCH_DATABASE_URL=postgres://gateway:local-password@localhost:5432/gateway_test node scripts/bench.mjs > benchmark.json
```

The command creates a random schema, applies the migrations, starts the API on loopback, seeds an authenticated tenant and connection, and drops its schema afterward. The database role needs schema creation privileges. It does not contact Shopify or run workers. PostgreSQL must have `fsync` enabled and `synchronous_commit` enabled.

Each measured workload uses concurrent HTTP clients: authenticated product reads with a fixed local provider response; unique durable enqueues; replayed idempotency keys; and concurrent first submissions sharing one key. Assertions check response shape, original replay IDs, one winning contended insert, and the final durable operation count.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_DATABASE_URL` | Required | Disposable PostgreSQL database; `TEST_DATABASE_URL` is also accepted |
| `BENCH_REQUESTS` | `1000` | Measured requests per workload |
| `BENCH_CONCURRENCY` | `16` | Concurrent clients |
| `BENCH_WARMUP` | `100` | Unmeasured warmup requests for reads, unique enqueues, and replays |
| `BENCH_POOL_SIZE` | `16` | PostgreSQL pool maximum |
| `BENCH_REPLAY_KEYS` | `20` | Previously inserted keys used by replay traffic |
| `BENCH_TIMEOUT_MS` | `10000` | Individual HTTP and database statement timeout |
| `BENCH_P95_MS` | `100` | Maximum passing p95 latency for every workload |
| `BENCH_API_MODULE` | `dist/api.js` | Optional API module path relative to the working directory |

The contended workload uses the already warmed enqueue route and starts with a fresh shared key. Request logging is disabled and this setting is recorded. The JSON report includes nearest-rank p50/p95/p99, errors, throughput, Node/V8/architecture/CPU/OS/PostgreSQL versions, configuration, and durability checks. Any request error, incorrect durable row count, idempotency failure, or p95 above the threshold produces exit code 1.

Latency includes loopback HTTP, authentication, validation, PostgreSQL, and response decoding. Shopify network time and worker completion time are excluded. This is closed-loop load with a fresh dataset, so it establishes a reproducible local overhead check rather than production capacity. Use the same runtime, machine, database topology, pool, dataset, and concurrency for comparisons. A noisy shared CI runner can fail the default target; any threshold override is recorded in the report and should be disclosed with results.

Run the statistics and bounded-concurrency tests without PostgreSQL:

```sh
node --test tests/bench.test.mjs
```

## Durable enqueue diagnostics

The unique enqueue workload deliberately sends every request to one tenant, connection and product with distinct idempotency keys. Migration 006 takes a transaction advisory lock for that product before assigning its durable queue position. These requests therefore serialize through transaction completion. Slow WAL writes or fsyncs can extend later requests' queue waits. The enqueue query also locks the shared connection with `FOR SHARE` to synchronize reauthorization. Those shared locks are compatible, while their tuple/MultiXact bookkeeping can generate I/O.

Set `BENCH_DIAGNOSTICS=1` to observe this workload. This requires permission to enable per-session `track_io_timing` and `track_wal_io_timing`. CI uses its disposable database role. A dedicated observer connection outside the API pool samples aggregated `pg_stat_activity` every 50 ms. Samples never overlap. Delayed ticks and observer query wall time are reported. Application session tags restrict activity sampling to this run. No SQL text or payloads are recorded.

Boundary snapshots capture `pg_stat_wal`, `pg_stat_io`, MultiXact/Xact SLRU counters, checkpointer statistics, database counters and durability/timing settings. The warmed API clients force their pending cumulative statistics to flush before and after the measurement, outside latency timing. PostgreSQL background statistics can lag. Snapshot counters cover the database cluster, including the observer and other activity. In PostgreSQL 18, WAL write/fsync timing is in `pg_stat_io` where `object='wal'`.

Wait observation counts sum sampled backend counts. They do not measure elapsed wait time. Missing samples do not prove that a wait never occurred, and null wait events do not prove CPU execution. Sampling and I/O timing add overhead that must be considered when comparing instrumented and uninstrumented runs.

CI preserves the JSON report and sanitized stderr as a benchmark artifact even when a latency threshold fails. The source and tested revisions are included. The 100 ms p95 gate, durable commit settings, queue ordering, authentication and idempotency checks continue to apply. A failed gate remains a qualification failure.

Compare repeated invocations of the same source revision, preserving every outcome. The earlier same-runner ABBA comparison in [run 41813136671](https://github.com/mithundas79/commerce-gateway/actions/runs/41813136671) recorded baseline p95 24.829/19.032 ms and candidate 20.655/20.404 ms. Its whole-invocation WAL counts and these targeted workload snapshots have different scopes. Diagnose sampled advisory/tuple/MultiXact waits alongside WAL fsync timing before changing admission concurrency.

The workflow selects Bash explicitly with pipefail. A deterministic shell harness passes a fixed 101 ms synthetic sample through the shared benchmark JSON/exit reporter against the 100 ms threshold. It asserts pipeline exit 1, checks the retained passed=false report and uploads the probe JSON. This verifies failure propagation independently of runner speed.

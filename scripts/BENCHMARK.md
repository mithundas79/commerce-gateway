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
| `BENCH_WARMUP` | `100` | Unmeasured warmup requests per route/workload |
| `BENCH_POOL_SIZE` | `16` | PostgreSQL pool maximum |
| `BENCH_REPLAY_KEYS` | `20` | Previously inserted keys used by replay traffic |
| `BENCH_TIMEOUT_MS` | `10000` | Individual HTTP and database statement timeout |
| `BENCH_P95_MS` | `100` | Maximum passing p95 latency for every workload |
| `BENCH_API_MODULE` | `dist/api.js` | Optional API module path relative to the working directory |

The JSON report includes nearest-rank p50/p95/p99, errors, throughput, Node/V8/architecture/CPU/OS/PostgreSQL versions, configuration, and durability checks. Any request error, incorrect durable row count, idempotency failure, or p95 above the threshold produces exit code 1.

Latency includes loopback HTTP, authentication, validation, PostgreSQL, and response decoding. Shopify network time and worker completion time are excluded. This is closed-loop load with a fresh dataset, so it establishes a reproducible local overhead check rather than production capacity. Use the same runtime, machine, database topology, pool, dataset, and concurrency for comparisons. A noisy shared CI runner can fail the default target; any threshold override is recorded in the report and should be disclosed with results.

Run the statistics and bounded-concurrency tests without PostgreSQL:

```sh
node --test tests/bench.test.mjs
```

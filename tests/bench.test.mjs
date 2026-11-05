import assert from 'node:assert/strict';
import test from 'node:test';
import { runLoad, summarize } from '../scripts/bench.mjs';

test('latency percentiles use nearest-rank without reordering input', () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
  const result = summarize(samples, 2, 1_000);
  assert.equal(result.p50Ms, 50);
  assert.equal(result.p95Ms, 95);
  assert.equal(result.p99Ms, 99);
  assert.equal(result.errors, 2);
  assert.equal(result.requestsPerSecond, 100);
  assert.equal(samples[0], 100);
});

test('single sample and invalid samples have defined behavior', () => {
  assert.equal(summarize([1.23456]).p99Ms, 1.235);
  for (const samples of [[], [NaN], [Infinity], [-1]]) assert.throws(() => summarize(samples));
});

test('load keeps concurrency bounded, attempts each index once, and reports errors', async () => {
  let active = 0;
  let maxActive = 0;
  const seen = new Set();
  const result = await runLoad({ requests: 25, concurrency: 4, request: async index => {
    active++;
    maxActive = Math.max(active, maxActive);
    seen.add(index);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (index % 5 === 0) throw Object.assign(new Error('private credentials'), { code: 'EXPECTED_ERROR' });
  } });
  assert.equal(maxActive, 4);
  assert.equal(seen.size, 25);
  assert.equal(result.requests, 25);
  assert.equal(result.errors, 5);
  assert.deepEqual(result.errorCounts, { EXPECTED_ERROR: 5 });
  assert.doesNotMatch(JSON.stringify(result), /private credentials/);
});

test('each workload reports finite process CPU and sampled memory in explicit units', async () => {
  const result = await runLoad({ requests: 4, concurrency: 2, request: async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
  } });
  const resources = result.resources;
  for (const key of ['cpuUserMs', 'cpuSystemMs', 'cpuTotalMs', 'cpuPercentOfOneCore']) {
    assert.ok(Number.isFinite(resources[key]) && resources[key] >= 0, key);
  }
  assert.equal(resources.sampleIntervalMs, 10);
  assert.ok(resources.sampledPeakRssBytes >= resources.rssStartBytes);
  assert.ok(resources.sampledPeakRssBytes >= resources.rssEndBytes);
  assert.ok(resources.sampledPeakHeapUsedBytes >= resources.heapUsedStartBytes);
  assert.ok(resources.sampledPeakHeapUsedBytes >= resources.heapUsedEndBytes);
  assert.ok(resources.rssStartBytes > 0);
  assert.ok(Math.abs(resources.cpuTotalMs - resources.cpuUserMs - resources.cpuSystemMs) <= 0.002);
});

test('a failed request still yields resource evidence for the attempted workload', async () => {
  const result = await runLoad({ requests: 1, concurrency: 1, request: async () => {
    throw new Error('request failed');
  } });
  assert.equal(result.errors, 1);
  assert.ok(result.resources.sampledPeakRssBytes > 0);
  assert.ok(result.resources.cpuTotalMs >= 0);
});

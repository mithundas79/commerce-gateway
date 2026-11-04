import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const mergedDirectory = resolve('.bench/merged');
const benchmarkEntry = resolve(process.env.DIAGNOSTIC_BENCH_ENTRY ?? '.bench/merged/scripts/bench.mjs');
const output = resolve('benchmark-suite-output');
await mkdir(output, { recursive: true });

function run(label, command, args, directory, env) {
  return new Promise((resolveRun, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (exitCode, signal) => {
      try {
        const finishedAt = new Date().toISOString();
        await writeFile(resolve(output, `${label}.stdout.txt`), stdout);
        await writeFile(resolve(output, `${label}.stderr.txt`), stderr);
        resolveRun({ label, startedAt, finishedAt, command: [command, ...args], directory, exitCode, signal, stdout });
      } catch (error) { reject(error); }
    });
  });
}

async function benchmark(label) {
  const result = await run(label, process.execPath, [benchmarkEntry], mergedDirectory,
    { ...process.env, BENCH_API_MODULE: resolve(mergedDirectory, 'dist/api.js') });
  let report = null;
  try { report = result.stdout ? JSON.parse(result.stdout) : null; }
  catch { /* Preserve malformed output and continue collecting the remaining runs. */ }
  const { stdout, ...metadata } = result;
  return { ...metadata, report };
}

const preSuite = await benchmark('1-pre-suite');
const suite = await run('2-integration-suite', process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'test:integration'], mergedDirectory,
  { ...process.env, DATABASE_URL: process.env.BENCH_DATABASE_URL });
// Keep both post-suite invocations even when the suite or a preceding benchmark fails.
const immediatePostSuite = await benchmark('3-immediate-post-suite');
const secondPostSuite = await benchmark('4-second-post-suite');
const benchmarks = [preSuite, immediatePostSuite, secondPostSuite];
const { stdout, ...suiteMetadata } = suite;
const evidence = { mergedSha: process.env.MERGED_SHA, telemetrySha: process.env.TELEMETRY_SHA,
  benchmarkEntry, integrationSuite: suiteMetadata, benchmarks };
await writeFile(resolve(output, 'sequence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const lines = ['# Benchmark before and after the integration suite', '',
  `Merged source ${process.env.MERGED_SHA ?? 'unrecorded'}. Telemetry ${process.env.TELEMETRY_SHA ?? 'canonical benchmark'}.`, '',
  `Full integration suite exit code ${suite.exitCode}. Its complete output is included in the artifact.`, '',
  '| Phase | Workload | p95 ms | Errors | Passed |', '| --- | --- | ---: | ---: | --- |'];
for (const result of benchmarks) {
  for (const workload of result.report?.workloads ?? []) {
    lines.push(`| ${result.label} | ${workload.name} | ${workload.p95Ms} | ${workload.errors} | ${workload.passed} |`);
  }
}
lines.push('', '| Phase | Exit | Durable rows passed | Started | Finished |', '| --- | ---: | --- | --- | --- |');
for (const result of benchmarks) {
  lines.push(`| ${result.label} | ${result.exitCode} | ${result.report?.durability?.passed ?? false} | ${result.startedAt} | ${result.finishedAt} |`);
}
lines.push('', 'Each benchmark uses a fresh Node process on the same runner and PostgreSQL service. Workload, thresholds and durability settings retain their defaults. The post-suite run begins as soon as suite output is saved, with no cooldown. Raw telemetry remains in each benchmark report.');
const summary = `${lines.join('\n')}\n`;
await writeFile(resolve(output, 'summary.md'), summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
if (suite.exitCode !== 0 || benchmarks.some(result => result.exitCode !== 0 || !result.report?.passed)) process.exitCode = 1;

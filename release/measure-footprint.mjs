// CI-only footprint evidence from an already-installed synthetic bundle fixture.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.CI !== 'true' || process.argv.length !== 4) {
  throw new Error('Usage in isolated CI: node release/measure-footprint.mjs bundle.tar.gz report.json');
}
const [archive, output] = process.argv.slice(2).map(value => resolve(value));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const jsonLines = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));
const compose = ['compose', '--project-name', 'commerce-gateway', '--env-file', '.env', '-f', 'compose.yaml'];
const roles = ['api', 'worker', 'db'];
const ids = roles.map(role => docker([...compose, 'ps', '--quiet', role]));
if (ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== roles.length) {
  throw new Error('Expected three distinct running qualification containers');
}
// Select fields only. Container environment, commands and health-check logs are excluded.
const inspectFormat = '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"restarts":{{json .RestartCount}},"memoryLimitBytes":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}}}';
const inspect = () => jsonLines(docker(['container', 'inspect', '--format', inspectFormat, ...ids]));
const assertHealthy = containers => {
  if (containers.length !== roles.length || containers.some(item => !item.running || item.health !== 'healthy')) {
    throw new Error('Footprint measurement requires healthy API, worker and PostgreSQL');
  }
};
const initial = inspect();
assertHealthy(initial);
const images = [...new Set(initial.map(item => item.image))].map(id => JSON.parse(docker([
  'image', 'inspect', '--format',
  '{"id":{{json .Id}},"bytes":{{json .Size}},"os":{{json .Os}},"architecture":{{json .Architecture}}}', id,
])));
const host = JSON.parse(docker(['info', '--format',
  '{"os":{{json .OSType}},"architecture":{{json .Architecture}},"logicalCpus":{{json .NCPU}},"memoryBytes":{{json .MemTotal}},"dockerVersion":{{json .ServerVersion}}}']));
const nativeArch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (process.platform !== 'linux' || images.some(image => image.os !== 'linux' || image.architecture !== nativeArch)) {
  throw new Error('Footprint evidence requires native matching Linux image architecture');
}
const osRelease = Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split('\n')
  .filter(line => /^(NAME|VERSION_ID)=/.test(line)).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, '')];
  }));
const memoryBytes = text => {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB|TiB|kB|KB|MB|GB|TB)$/.exec(text.trim());
  if (!match) throw new Error('Unrecognized Docker stats memory unit');
  const factors = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
    kB: 1000, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4 };
  return Math.round(Number(match[1]) * factors[match[2]]);
};
const settlingMs = 10_000;
const targetIntervalMs = 2_000;
const sampleCount = 10;
await delay(settlingMs);
const began = performance.now();
const snapshots = [];
for (let index = 0; index < sampleCount; index++) {
  const started = performance.now();
  const stats = jsonLines(docker(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...ids]));
  const services = roles.map((role, roleIndex) => {
    const item = stats.find(row => row.ID === ids[roleIndex]);
    if (!item || !/^[0-9]+(?:\.[0-9]+)?%$/.test(item.CPUPerc)) throw new Error('Missing or invalid Docker stats sample');
    return { role, cpuPercent: Number(item.CPUPerc.slice(0, -1)),
      memoryBytesApprox: memoryBytes(item.MemUsage.split('/')[0]), dockerMemoryUsage: item.MemUsage };
  });
  snapshots.push({ startedMs: Math.round(started - began), completedMs: Math.round(performance.now() - began), services });
  if (index + 1 < sampleCount) await delay(Math.max(0, targetIntervalMs - (performance.now() - started)));
}
const final = inspect();
assertHealthy(final);
if (final.some(item => item.restarts !== initial.find(before => before.id === item.id)?.restarts)) {
  throw new Error('A qualification container restarted during footprint sampling');
}
const round = value => Number(value.toFixed(3));
const services = roles.map((role, index) => {
  const samples = snapshots.map(snapshot => snapshot.services[index]);
  const container = initial.find(item => item.id === ids[index]);
  const image = images.find(item => item.id === container.image);
  return { role, imageBytes: image.bytes, sharedImageRoles: roles.filter((_, other) => initial.find(item => item.id === ids[other]).image === image.id),
    cpuPercentSampleMean: round(samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / samples.length),
    cpuPercentSampleMax: Math.max(...samples.map(sample => sample.cpuPercent)),
    memoryBytesApproxSampleMean: Math.round(samples.reduce((sum, sample) => sum + sample.memoryBytesApprox, 0) / samples.length),
    memoryBytesApproxSampleMax: Math.max(...samples.map(sample => sample.memoryBytesApprox)),
    configuredLimits: { memoryBytes: container.memoryLimitBytes, nanoCpus: container.nanoCpus,
      cpuQuota: container.cpuQuota, cpuPeriod: container.cpuPeriod } };
});
const report = {
  measurement: 'commerce-gateway-portable-idle-footprint', timestamp: new Date().toISOString(),
  testedCommit: process.env.GITHUB_SHA ?? null, sourceCommit: process.env.RESOURCE_SOURCE_SHA ?? null,
  environment: { os: osRelease.NAME, osVersion: osRelease.VERSION_ID, kernel: os.release(),
    platform: process.platform, architecture: nativeArch, node: process.version, docker: host },
  bundle: { compressedBytes: statSync(archive).size, compressedImagesArchiveBytes: statSync('images.tar.gz').size,
    installedImageSizes: images, sumOfDistinctLogicalImageBytes: images.reduce((sum, image) => sum + image.bytes, 0) },
  sampling: { settlingMs, targetIntervalMs, sampleCount, actualWindowMs: Math.round(performance.now() - began),
    scope: 'Idle installed bundle after synthetic authentication smoke, before backup/configuration probes. API health checks, worker queue polling and PostgreSQL background work remain enabled. No external requests or queued operations are generated during sampling.',
    cpu: 'Docker stats JSON CPU percentages relative to one core. Reported mean is the arithmetic mean of snapshot values, not a whole-window CPU integral.',
    memory: 'Docker stats Linux memory usage excludes cache. Approximate bytes are converted from rounded Docker CLI units. Sampled maxima are lower bounds.',
    images: 'Docker image inspect Size reports logical uncompressed image bytes. API and worker share one application image. Distinct logical sizes can share host layers and do not measure physical disk consumption.',
    interpretation: 'Observed idle qualification footprint only. Host capacity and existing container limits are recorded. These measurements do not establish production sizing or a minimum resource requirement.' },
  services, snapshots, passed: true,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = services.map(service => '| ' + service.role + ' | ' + service.imageBytes + ' | ' +
    service.cpuPercentSampleMean + ' / ' + service.cpuPercentSampleMax + ' | ' +
    service.memoryBytesApproxSampleMean + ' / ' + service.memoryBytesApproxSampleMax + ' |').join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '\n### Idle bundle footprint on Linux ' + nativeArch + '\n\n' +
    'OS ' + osRelease.NAME + ' ' + osRelease.VERSION_ID + '. Tested commit ' + report.testedCommit + '.\n\n' +
    'Compressed bundle bytes ' + report.bundle.compressedBytes + '. Compressed image archive bytes ' +
    report.bundle.compressedImagesArchiveBytes + '. API and worker share one application image.\n\n' +
    '| Service | Logical image bytes | CPU % mean / max | Approx memory bytes mean / max |\n' +
    '| --- | ---: | ---: | ---: |\n' + rows + '\n\n' +
    'Ten Docker stats JSON snapshots, target interval 2 seconds after 10 seconds settling. Actual window ' +
    report.sampling.actualWindowMs + ' ms. Health checks, worker polling and database background work are included. ' +
    'Memory excludes Linux cache and uses rounded Docker units. Logical image sizes can share disk layers. ' +
    'These idle observations do not establish production minimums. Full scope, configured limits and raw snapshots are in the JSON artifact.\n');
}

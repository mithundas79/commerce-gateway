import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run npm's JavaScript entry point directly so this works on Windows and Linux.
const npmPath = process.env.npm_execpath ?? (process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  : realpathSync(join(dirname(process.execPath), 'npm')));
const npm = (args, cwd = process.cwd()) => execFileSync(process.execPath, [npmPath, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const temporary = mkdtempSync(join(tmpdir(), 'commerce-package-'));
let archive;
try {
  const [packed] = JSON.parse(npm(['pack', '--json']));
  archive = resolve(packed.filename);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ['package.json', 'dist/main.js', 'dist/admin.js', 'migrations/001.sql', 'README.md', 'LICENSE']) {
    assert.ok(files.has(required), `Release archive is missing ${required}`);
  }
  for (const migration of readdirSync('migrations').filter((name) => name.endsWith('.sql'))) {
    assert.ok(files.has(`migrations/${migration}`), `Release archive is missing migration ${migration}`);
  }
  for (const name of files) {
    assert.ok(!/(^|\/)(\.env(?:\..*)?|node_modules|tests)(\/|$)/.test(name), `Release archive contains private/development file ${name}`);
  }
  npm(['init', '--yes'], temporary);
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], temporary);
  const name = JSON.parse(readFileSync('package.json', 'utf8')).name;
  const installed = join(temporary, 'node_modules', name);
  execFileSync(process.execPath, ['--check', join(installed, 'dist/main.js')], { encoding: 'utf8' });
  execFileSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])',
    pathToFileURL(join(installed, 'dist/api.js')).href], { cwd: temporary, encoding: 'utf8' });
  const help = execFileSync(process.execPath, [join(installed, 'dist/admin.js'), '--help'], {
    cwd: temporary, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' },
  });
  assert.match(help, /migrate/);
  assert.match(help, /bootstrap/);
  console.log(`Verified clean install of ${packed.name}@${packed.version} (${files.size} files)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
  if (archive) rmSync(archive, { force: true });
}

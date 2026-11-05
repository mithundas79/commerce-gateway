import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { publishRelease } from '../release/publish.mjs';

const commit = 'a'.repeat(40);
async function fixture(version, work) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'gateway-publish-'));
  try {
    await mkdir(join(root, 'release', 'notes'), { recursive: true });
    await mkdir(join(root, 'release-artifacts'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
    const tag = `v${version}`;
    await writeFile(join(root, 'release', 'notes', `${tag}.md`), 'Live Shopify acceptance passed; live privacy events were not exercised.');
    for (const arch of ['amd64', 'arm64']) {
      const name = `commerce-gateway-${tag}-linux-${arch}.tar.gz`;
      const bytes = Buffer.from(`synthetic bundle ${arch}`);
      await writeFile(join(root, 'release-artifacts', name), bytes);
      await writeFile(join(root, 'release-artifacts', `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    }
    await work({ root, env: { RELEASE_TAG: tag, GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: commit } });
  } finally {
    assert.ok(resolve(root).startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  }
}

test('alpha publication verifies both bundles and passes explicit prerelease flags and reviewed notes to gh', async () => {
  await fixture('0.1.0-alpha.1', async options => {
    const calls = [];
    const result = await publishRelease({ ...options, run(command, args) {
      calls.push({ command, args });
      if (command === 'gh') {
        const notes = readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
        assert.match(notes, /live privacy events were not exercised/);
        assert.ok(notes.includes(commit));
      }
      return command === 'git' ? commit + '\n' : 'https://github.com/example/releases/tag/v0.1.0-alpha.1\n';
    } });
    assert.equal(result.prerelease, true);
    const published = calls.find(c => c.command === 'gh');
    assert.ok(published.args.includes('--prerelease'));
    assert.ok(published.args.includes('--latest=false'));
    assert.ok(published.args.includes('--verify-tag'));
    assert.equal(published.args[published.args.indexOf('--target') + 1], commit);
    assert.equal(result.assets.length, 4);
    assert.equal(published.args.filter(a => a.endsWith('.sha256')).length, 2);
    assert.equal(published.args.filter(a => a.endsWith('.tar.gz')).length, 2);
    await assert.rejects(readFile(published.args[published.args.indexOf('--notes-file') + 1]), { code: 'ENOENT' });
  });
});

test('publication rejects corrupt or missing bundles, version mismatch, wrong ref and wrong commit before gh', async () => {
  for (const fault of ['corrupt', 'missing', 'version', 'ref', 'commit', 'notes']) {
    await fixture('0.1.0-alpha.1', async options => {
      const archive = join(options.root, 'release-artifacts', 'commerce-gateway-v0.1.0-alpha.1-linux-arm64.tar.gz');
      if (fault === 'corrupt') await writeFile(archive, 'changed');
      if (fault === 'missing') await rm(archive);
      if (fault === 'version') await writeFile(join(options.root, 'package.json'), '{"version":"0.2.0"}');
      if (fault === 'ref') options.env.GITHUB_REF = 'refs/heads/main';
      if (fault === 'notes') await writeFile(join(options.root, 'release', 'notes', 'v0.1.0-alpha.1.md'), '');
      await assert.rejects(publishRelease({ ...options, run(command) {
        assert.equal(command, 'git', `No publication permitted after ${fault}`);
        return fault === 'commit' ? 'b'.repeat(40) : commit;
      } }));
    });
  }
});

test('stable tags do not inherit alpha publication flags', async () => {
  await fixture('1.0.0', async options => {
    const result = await publishRelease({ ...options, run(command, args) {
      if (command === 'git') return commit;
      assert.ok(!args.includes('--prerelease'));
      assert.ok(args.includes('--latest'));
      return 'release URL';
    } });
    assert.equal(result.prerelease, false);
  });
});

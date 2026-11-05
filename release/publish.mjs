import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/** Validate every asset before the single publishing side effect. No implicit tag creation. */
export async function publishRelease({ root = process.cwd(), env = process.env, run = execFileSync } = {}) {
  const tag = env.RELEASE_TAG;
  const commit = env.GITHUB_SHA;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag ?? '') || env.GITHUB_REF !== `refs/tags/${tag}`) {
    throw new Error('Publication requires an explicit version tag');
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('Publication requires the exact commit');
  const exec = (command, args) => run(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  if (exec('git', ['rev-parse', 'HEAD']).trim() !== commit ||
      exec('git', ['rev-parse', `refs/tags/${tag}^{commit}`]).trim() !== commit) throw new Error('Tag and checkout must match the tested commit');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (`v${pkg.version}` !== tag) throw new Error('Tag must match the package version');
  const notes = await readFile(join(root, 'release', 'notes', `${tag}.md`), 'utf8');
  if (!notes.trim()) throw new Error('Reviewed release notes are required');
  const artifacts = join(root, 'release-artifacts');
  const assets = [];
  for (const arch of ['amd64', 'arm64']) {
    const name = `commerce-gateway-${tag}-linux-${arch}.tar.gz`;
    const archive = join(artifacts, name);
    const checksum = `${archive}.sha256`;
    const expected = (await readFile(checksum, 'utf8')).trim();
    if (expected !== `${await sha256(archive)}  ${name}`) throw new Error(`Invalid bundle checksum: ${arch}`);
    assets.push(archive, checksum);
  }
  const prerelease = tag.includes('-');
  const notesPath = join(artifacts, `.release-notes-${commit}.md`);
  await writeFile(notesPath, `${notes.trim()}\n\nRelease commit: \`${commit}\`.\n`, { flag: 'wx' });
  try {
    const args = ['release', 'create', tag, ...assets, '--verify-tag', '--target', commit,
      '--title', tag, '--notes-file', notesPath, ...(prerelease ? ['--prerelease', '--latest=false'] : ['--latest'])];
    const output = exec('gh', args);
    return { tag, commit, prerelease, assets, output: output.trim() };
  } finally { await unlink(notesPath); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await publishRelease())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

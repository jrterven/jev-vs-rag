import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, lstat, readFile, writeFile, copyFile, chmod, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeLock } from './runtime-lock.mjs';

const operationalFiles = ['Dockerfile', 'compose.yaml', 'compose.proxy-network.yaml', 'deploy.env.example', 'ops.sh', 'restore-stdin.mjs', 'README.md'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function filesIn(directory, relative = '') {
  if (!relative && (await lstat(directory)).isSymbolicLink()) throw new Error(`Symlinks are not allowed in release input: ${directory}`);
  const result = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in release input: ${name}`);
    if (entry.isDirectory()) result.push(...await filesIn(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Non-regular release input: ${name}`);
  }
  return result.sort();
}
async function copyRegular(source, destination) {
  if (!(await lstat(source)).isFile()) throw new Error(`Expected regular file: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o644);
}

export async function createRelease({ root, outputDirectory, releaseName, build = true }) {
  if (!/^annotation-[a-zA-Z0-9_-]+$/.test(releaseName)) throw new Error('Release name must start with annotation- and contain only letters, numbers, _ or -.');
  root = path.resolve(root); outputDirectory = path.resolve(outputDirectory);
  if (build) execFileSync('npm', ['run', 'build:annotate'], { cwd: root, stdio: 'inherit' });
  const source = path.join(root, 'deploy/annotation');
  const releaseDirectory = path.join(outputDirectory, releaseName);
  const archive = `${releaseDirectory}.tar.gz`;
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await mkdir(releaseDirectory, { mode: 0o700 }); // Refuse overwriting another release.
  for (const name of operationalFiles) await copyRegular(path.join(source, name), path.join(releaseDirectory, name));
  await chmod(path.join(releaseDirectory, 'ops.sh'), 0o755);
  const manifest = JSON.parse(await readFile(path.join(source, 'runtime/package.json'), 'utf8'));
  const rootLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const locked = runtimeLock(rootLock, manifest);
  await mkdir(path.join(releaseDirectory, 'runtime'), { mode: 0o700 });
  await writeFile(path.join(releaseDirectory, 'runtime/package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(releaseDirectory, 'runtime/package-lock.json'), `${JSON.stringify(locked, null, 2)}\n`);
  // Derive the exact compiled server/shared allowlist from tracked source files.
  // Stale build output, model code and other applications cannot enter a release.
  for (const section of ['server', 'shared']) {
    for (const name of await filesIn(path.join(root, 'annotation', section))) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const compiled = path.posix.join('annotation/dist/runtime', section, name.replace(/\.ts$/, '.js'));
      await copyRegular(path.join(root, compiled), path.join(releaseDirectory, compiled));
    }
  }
  const web = path.join(root, 'annotation/dist/web');
  for (const name of await filesIn(web)) {
    if (!/\.(html|js|css|svg|woff2?|ico|png|webp)$/.test(name)) throw new Error(`Unexpected web artifact: ${name}`);
    await copyRegular(path.join(web, name), path.join(releaseDirectory, 'annotation/dist/web', name));
  }
  await writeFile(path.join(releaseDirectory, '.dockerignore'), ['*', '!Dockerfile', '!runtime/', '!runtime/*.json', '!annotation/', '!annotation/dist/', '!annotation/dist/**', '!restore-stdin.mjs', ''].join('\n'));
  const entries = [];
  for (const name of await filesIn(releaseDirectory)) {
    const content = await readFile(path.join(releaseDirectory, name));
    entries.push({ path: name, bytes: content.length, sha256: sha256(content) });
  }
  const inventory = { schemaVersion: 1, releaseName, createdAt: new Date().toISOString(), nodeMajor: 24, runtimePackages: Object.keys(locked.packages).length - 1, files: entries };
  const inventoryText = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(path.join(releaseDirectory, 'release-manifest.json'), inventoryText);
  await writeFile(path.join(releaseDirectory, 'SHA256SUMS'), [...entries.map((file) => `${file.sha256}  ${file.path}`), `${sha256(inventoryText)}  release-manifest.json`, ''].join('\n'));
  const archiveHandle = await open(archive, 'wx', 0o600);
  try {
    execFileSync('tar', ['-czf', '-', '-C', outputDirectory, releaseName], { stdio: ['ignore', archiveHandle.fd, 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  } finally { await archiveHandle.close(); }
  const archiveHash = sha256(await readFile(archive));
  await writeFile(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`);
  return { releaseDirectory, archive, sha256: archiveHash, files: entries.length + 2, runtimePackages: inventory.runtimePackages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2);
  let outputDirectory = path.join(root, 'output/annotation-releases');
  let releaseName = `annotation-${new Date().toISOString().replace(/[-:.]/g, '')}`;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--out' && args[index + 1]) outputDirectory = args[++index];
    else if (args[index] === '--name' && args[index + 1]) releaseName = args[++index];
    else throw new Error('Usage: node deploy/annotation/package.mjs [--out DIRECTORY] [--name annotation-RELEASE]');
  }
  console.log(JSON.stringify(await createRelease({ root, outputDirectory, releaseName }), null, 2));
}

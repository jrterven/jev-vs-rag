import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRelease } from '../package.mjs';
import { runtimeLock } from '../runtime-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'annotation-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  await mkdir(path.join(source, 'annotation/dist/web/assets'), { recursive: true });
  await mkdir(path.join(source, 'annotation/dist/runtime/server'), { recursive: true });
  await mkdir(path.join(source, 'annotation/dist/runtime/shared'), { recursive: true });
  await mkdir(path.join(source, 'annotation/server'), { recursive: true });
  await mkdir(path.join(source, 'annotation/shared'), { recursive: true });
  await cp(path.join(root, 'deploy/annotation'), path.join(source, 'deploy/annotation'), { recursive: true });
  await cp(path.join(root, 'package-lock.json'), path.join(source, 'package-lock.json'));
  await writeFile(path.join(source, 'annotation/server/index.ts'), 'export {};');
  await writeFile(path.join(source, 'annotation/shared/types.ts'), 'export {};');
  await writeFile(path.join(source, 'annotation/dist/runtime/server/index.js'), 'export {};');
  await writeFile(path.join(source, 'annotation/dist/runtime/shared/types.js'), 'export {};');
  await writeFile(path.join(source, 'annotation/dist/runtime/server/stale.js'), 'STALE_FORBIDDEN');
  await writeFile(path.join(source, 'annotation/dist/web/index.html'), '<main>Annotation</main>');
  await writeFile(path.join(source, 'annotation/dist/web/assets/app.js'), 'console.log("annotation");');
  for (const name of ['.env', 'annotation/.env', 'annotation/data/annotation.sqlite', 'research/data/document.txt', 'models/weights.bin', 'data/secrets.txt']) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), 'SENTINEL_PRIVATE_CONTENT');
  }
  return { directory, source, outputDirectory: path.join(directory, 'out') };
}

test('release allowlist excludes secrets, data, models and stale output; hashes verify', async (t) => {
  const f = await fixture(t);
  const release = await createRelease({ root: f.source, outputDirectory: f.outputDirectory, releaseName: 'annotation-test', build: false });
  const inventory = JSON.parse(await readFile(path.join(release.releaseDirectory, 'release-manifest.json'), 'utf8'));
  const names = inventory.files.map((file) => file.path);
  assert(names.includes('annotation/dist/runtime/server/index.js'));
  assert(!names.some((name) => /(^|\/)(data|models|research|\.env)(\/|$)|stale/.test(name)));
  for (const file of inventory.files) assert(!String(await readFile(path.join(release.releaseDirectory, file.path))).includes('SENTINEL_PRIVATE_CONTENT'));
  const locked = JSON.parse(await readFile(path.join(release.releaseDirectory, 'runtime/package-lock.json'), 'utf8'));
  assert(!Object.keys(locked.packages).some((name) => /@lancedb|pdfjs-dist|mammoth|node_modules\/openai|node_modules\/react$/.test(name)));
  assert(Object.keys(locked.packages).length < 100);
  execFileSync('sh', [path.join(release.releaseDirectory, 'ops.sh'), 'verify']);
  await writeFile(path.join(release.releaseDirectory, 'annotation/dist/web/index.html'), 'tampered');
  assert.throws(() => execFileSync('sh', [path.join(release.releaseDirectory, 'ops.sh'), 'verify'], { stdio: 'pipe' }));
});

test('release rejects symlink input and unexpected frontend files', async (t) => {
  const f = await fixture(t);
  await symlink(path.join(f.source, '.env'), path.join(f.source, 'annotation/dist/web/assets/leak.js'));
  await assert.rejects(createRelease({ root: f.source, outputDirectory: f.outputDirectory, releaseName: 'annotation-symlink', build: false }), /Symlinks/);
  await rm(path.join(f.source, 'annotation/dist/web/assets/leak.js'));
  await writeFile(path.join(f.source, 'annotation/dist/web/leak.env'), 'PRIVATE');
  await assert.rejects(createRelease({ root: f.source, outputDirectory: f.outputDirectory, releaseName: 'annotation-env', build: false }), /Unexpected web artifact/);
});

test('runtime lock preserves nested resolution and checks exact direct versions', () => {
  const manifest = { name: 'fixture', version: '1', dependencies: { main: '1.0.0' } };
  const lock = { packages: { 'node_modules/main': { version: '1.0.0', dependencies: { child: '2' } }, 'node_modules/main/node_modules/child': { version: '2.0.0' }, 'node_modules/child': { version: '1.0.0' }, 'node_modules/private-model': { version: '1.0.0' } } };
  const output = runtimeLock(lock, manifest);
  assert.equal(output.packages['node_modules/main/node_modules/child'].version, '2.0.0');
  assert(!output.packages['node_modules/child']);
  assert(!output.packages['node_modules/private-model']);
  assert.throws(() => runtimeLock(lock, { ...manifest, dependencies: { main: '2.0.0' } }), /match the root lock/);
});

test('operations use only the selected project/service and never execute env contents', async (t) => {
  const f = await fixture(t);
  const release = await createRelease({ root: f.source, outputDirectory: f.outputDirectory, releaseName: 'annotation-ops', build: false });
  const bin = path.join(f.directory, 'bin'); await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), '#!/bin/sh\nprintf "docker\\n" >> "$CALL_LOG"\nprintf "%s\\n" "$@" >> "$CALL_LOG"\nif [ "$1" = version ]; then printf "29.1.0\\n"; fi\n');
  await writeFile(path.join(bin, 'curl'), '#!/bin/sh\nprintf "curl\\n" >> "$CALL_LOG"\nprintf "%s\\n" "$@" >> "$CALL_LOG"\nprintf "{\\"ok\\":true}"\n');
  await chmod(path.join(bin, 'docker'), 0o755); await chmod(path.join(bin, 'curl'), 0o755);
  const config = path.join(release.releaseDirectory, 'deploy.env');
  const text = ['ANNOTATION_PROJECT=annotation-test', 'ANNOTATION_IMAGE=annotation:test-1', 'ANNOTATION_ORIGIN=https://anota.example.org', 'ANNOTATION_BIND_PORT=13002', 'ANNOTATION_DATA_VOLUME=annotation-test-data', 'ANNOTATION_PROXY_NETWORK=', ''].join('\n');
  await writeFile(config, text);
  const calls = path.join(f.directory, 'calls');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: calls };
  const script = path.join(release.releaseDirectory, 'ops.sh');
  execFileSync('sh', ['-n', script]);
  execFileSync('sh', [script, 'up'], { env });
  const recorded = await readFile(calls, 'utf8');
  assert(recorded.includes('--project-name\nannotation-test\n'));
  assert(recorded.includes('up\n-d\n--no-deps\n--no-build\n--wait\n--wait-timeout\n120\nannotation\n'));
  assert(recorded.includes('Host: anota.example.org'));
  assert(!recorded.includes('down') && !recorded.includes('prune'));
  const sentinel = path.join(f.directory, 'should-not-exist');
  await writeFile(config, text.replace('annotation:test-1', `$(touch ${sentinel})`));
  assert.throws(() => execFileSync('sh', [script, 'config'], { env, stdio: 'pipe' }));
  await assert.rejects(readFile(sentinel), /ENOENT/);
});

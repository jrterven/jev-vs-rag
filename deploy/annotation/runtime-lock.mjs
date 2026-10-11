import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Reuse the versions and registry integrity hashes already reviewed in the main lock.
// Node resolves a nested dependency before the package hoisted at the root.
export function runtimeLock(rootLock, manifest) {
  const packages = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, engines: manifest.engines } };
  function resolve(from, name) {
    let directory = from;
    for (;;) {
      const candidate = path.posix.join(directory, 'node_modules', name);
      if (rootLock.packages[candidate]) return candidate;
      if (!directory) return null;
      directory = path.posix.dirname(directory);
      if (directory === '.') directory = '';
    }
  }
  function include(key) {
    if (packages[key]) return;
    const original = rootLock.packages[key];
    if (!original || original.link) throw new Error(`Unsupported dependency: ${key}`);
    const value = structuredClone(original);
    delete value.dev; delete value.devOptional;
    packages[key] = value;
    for (const name of Object.keys({ ...value.dependencies, ...value.optionalDependencies, ...value.peerDependencies })) {
      const dependency = resolve(key, name);
      const optional = value.optionalDependencies?.[name] || value.peerDependenciesMeta?.[name]?.optional;
      if (dependency) include(dependency);
      else if (!optional) throw new Error(`Missing locked dependency ${name} for ${key}`);
    }
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const key = resolve('', name);
    if (!key || rootLock.packages[key].version !== version) throw new Error(`Runtime dependency ${name} must match the root lock exactly`);
    include(key);
  }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(directory, '../..');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(directory, 'runtime/package.json'), 'utf8'));
  await writeFile(path.join(directory, 'runtime/package-lock.json'), `${JSON.stringify(runtimeLock(lock, manifest), null, 2)}\n`);
}

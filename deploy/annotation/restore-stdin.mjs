import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

// The operator creates a NEW volume before invoking this helper. Never open the
// live database; stream large backups to disk instead of retaining them in RAM.
const directory = process.env.ANNOTATION_DATA_DIR || '/data';
if (existsSync(path.join(directory, 'annotation.sqlite'))) throw new Error('Destination already contains a database.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const source = path.join(directory, '.restore-input.sqlite');
await pipeline(process.stdin, createWriteStream(source, { flags: 'wx', mode: 0o600 }));
const status = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['annotation/dist/runtime/server/cli.js', 'restore', source], { stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code) => resolve(code ?? 1));
});
if (status !== 0) throw new Error(`Restore failed (${status}); inspect the new volume before reusing it.`);
await unlink(source);

import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedGpuCheck, SHARED_TIMING } from './shared-gpu-policy.js';

test('shared GPU admission preserves resident processes and actual probe observations', () => {
  const probe = { available: true, gpu: [], computeProcesses: [{ pid: 983570, name: '/opt/venv/bin/python', usedMiB: '6293' }] };
  assert.equal(sharedGpuCheck(probe), probe);
  assert.equal(probe.computeProcesses[0].pid, 983570);
});

test('unavailable GPU still fails instead of bypassing hardware verification', () => {
  assert.throws(() => sharedGpuCheck({ available: false, gpu: [], computeProcesses: [] }), /unavailable/);
});

test('shared execution cannot be pooled into isolated latency even during idle snapshots', () => {
  sharedGpuCheck({ available: true, gpu: [], computeProcesses: [] });
  assert.equal(SHARED_TIMING.timingValid, false);
  assert.equal(SHARED_TIMING.timingEnvironment, 'shared-gpu');
});

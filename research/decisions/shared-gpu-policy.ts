import type { GpuProbe } from '../hardware.js';

/** Keep this execution block separate even if a co-resident job is idle. */
export const SHARED_TIMING = {
  timingValid: false,
  timingEnvironment: 'shared-gpu',
  operationalContinuationId: 'juan-authorized-shared-gpu-20261007-v1',
} as const;

export function sharedGpuCheck(gpu: GpuProbe): GpuProbe {
  if (!gpu.available) throw new Error('GPU unavailable; shared execution cannot be verified.');
  return gpu;
}

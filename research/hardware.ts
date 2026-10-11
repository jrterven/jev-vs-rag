import { execFileSync } from 'node:child_process';
export interface GpuProbe { available: boolean; gpu: Array<{ name: string; uuid: string; driver: string; memoryTotalMiB: string; memoryUsedMiB: string; utilizationPercent: string }>; computeProcesses: Array<{ pid: number; name: string; usedMiB: string }>; error?: string }
export function probeGpu(): GpuProbe {
  try {
    const run = (fields: string) => execFileSync('nvidia-smi', [fields, '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean).map(line => line.split(',').map(x => x.trim()));
    const gpu = run('--query-gpu=name,uuid,driver_version,memory.total,memory.used,utilization.gpu').map(([name, uuid, driver, memoryTotalMiB, memoryUsedMiB, utilizationPercent]) => ({ name, uuid, driver, memoryTotalMiB, memoryUsedMiB, utilizationPercent }));
    const computeProcesses = run('--query-compute-apps=pid,process_name,used_memory').map(([pid, name, usedMiB]) => ({ pid: Number(pid), name, usedMiB }));
    return { available: true, gpu, computeProcesses };
  } catch { return { available: false, gpu: [], computeProcesses: [], error: 'nvidia-smi unavailable or denied; GPU idleness unverified.' }; }
}

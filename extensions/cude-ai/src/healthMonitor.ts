import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export type MemorySample = {
  freePhysMB: number;
  totalPhysMB: number;
  freeCommitMB?: number;
  totalCommitMB?: number;
  /** Free space on the system drive (where Windows keeps its page file and temp files). */
  freeDiskMB?: number;
};

export type HealthLevel = 'ok' | 'low' | 'critical';

export function memoryLevel(s: MemorySample): HealthLevel {
  if (s.freePhysMB < 600 || (s.freeCommitMB !== undefined && s.freeCommitMB < 900) || (s.freeDiskMB !== undefined && s.freeDiskMB < 1024)) {
    return 'critical';
  }
  if (s.freePhysMB < 1200 || (s.freeCommitMB !== undefined && s.freeCommitMB < 2000) || (s.freeDiskMB !== undefined && s.freeDiskMB < 4096)) {
    return 'low';
  }
  return 'ok';
}

const POWERSHELL_TIMEOUT_MS = 8000;
const COMMIT_CACHE_TTL_MS = 120_000;

function runPowerShell(command: string, maxBuffer = 1024 * 1024): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return Promise.resolve(undefined);
  }
  const fullPs = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psBin = fs.existsSync(fullPs) ? fullPs : 'powershell.exe';
  return new Promise((resolve) => {
    execFile(
      psBin,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(undefined);
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

/** Free MB on the drive that holds the OS temp folder (the system drive on Windows); undefined when unknown. */
export function readSystemDiskFreeMB(): number | undefined {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const root = path.parse(os.tmpdir()).root || '/';
    const st = (fs as any).statfsSync?.(root);
    if (!st) return undefined;
    return Math.round((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
  } catch { return undefined; }
}

export async function readCommitWindows(): Promise<{ freeCommitMB: number; totalCommitMB: number } | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const stdout = await runPowerShell(
    '(Get-CimInstance Win32_OperatingSystem | Select-Object FreeVirtualMemory,TotalVirtualMemorySize | ConvertTo-Json -Compress)'
  );
  if (!stdout) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { FreeVirtualMemory?: unknown; TotalVirtualMemorySize?: unknown };
    const freeKB = Number(parsed?.FreeVirtualMemory);
    const totalKB = Number(parsed?.TotalVirtualMemorySize);
    if (!Number.isFinite(freeKB) || !Number.isFinite(totalKB) || totalKB <= 0 || freeKB < 0) {
      return undefined;
    }
    return {
      freeCommitMB: Math.round(freeKB / 1024),
      totalCommitMB: Math.round(totalKB / 1024),
    };
  } catch {
    return undefined;
  }
}

export async function topProcesses(limit = 8): Promise<Array<{ name: string; count: number; privateMB: number }>> {
  if (process.platform !== 'win32') {
    return [];
  }
  const maxItems = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8;
  if (maxItems === 0) {
    return [];
  }
  const stdout = await runPowerShell(
    'Get-Process | Select-Object ProcessName,PrivateMemorySize64 | ConvertTo-Json -Compress',
    4 * 1024 * 1024
  );
  if (!stdout) {
    return [];
  }
  try {
    const raw = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
    const grouped = new Map<string, { count: number; bytes: number }>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const item = row as { ProcessName?: unknown; PrivateMemorySize64?: unknown };
      const name = typeof item.ProcessName === 'string' && item.ProcessName ? item.ProcessName : 'unknown';
      const bytes = Number(item.PrivateMemorySize64);
      const validBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
      const entry = grouped.get(name);
      if (entry) {
        entry.count += 1;
        entry.bytes += validBytes;
      } else {
        grouped.set(name, { count: 1, bytes: validBytes });
      }
    }
    return Array.from(grouped.entries())
      .map(([name, info]) => ({
        name,
        count: info.count,
        privateMB: Math.round(info.bytes / (1024 * 1024)),
      }))
      .sort((a, b) => b.privateMB - a.privateMB)
      .slice(0, maxItems);
  } catch {
    return [];
  }
}

export type HealthOptions = {
  sample?: () => Promise<MemorySample>;
  intervalMs?: number;
  onChange: (level: HealthLevel, sample: MemorySample) => void;
};

function createDefaultSampler(): () => Promise<MemorySample> {
  let lastCommitAt = 0;
  let lastCommit: { freeCommitMB: number; totalCommitMB: number } | undefined;

  return async (): Promise<MemorySample> => {
    const freePhysMB = Math.round(os.freemem() / (1024 * 1024));
    const totalPhysMB = Math.round(os.totalmem() / (1024 * 1024));
    const now = Date.now();
    if (lastCommitAt === 0 || now - lastCommitAt >= COMMIT_CACHE_TTL_MS) {
      lastCommitAt = now;
      lastCommit = await readCommitWindows();
    }
    const freeDiskMB = readSystemDiskFreeMB();
    if (lastCommit) {
      return {
        freePhysMB,
        totalPhysMB,
        freeCommitMB: lastCommit.freeCommitMB,
        totalCommitMB: lastCommit.totalCommitMB,
        freeDiskMB,
      };
    }
    return { freePhysMB, totalPhysMB, freeDiskMB };
  };
}

export class HealthMonitor {
  private readonly _sample: () => Promise<MemorySample>;
  private readonly _intervalMs: number;
  private readonly _onChange: (level: HealthLevel, sample: MemorySample) => void;
  private _level: HealthLevel = 'ok';
  private _last: MemorySample | undefined;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _running = false;
  private _checking: Promise<HealthLevel> | undefined;

  constructor(o: HealthOptions) {
    this._sample = o.sample ?? createDefaultSampler();
    this._intervalMs = o.intervalMs ?? 30_000;
    this._onChange = o.onChange;
  }

  get level(): HealthLevel {
    return this._level;
  }

  get last(): MemorySample | undefined {
    return this._last;
  }

  start(): void {
    if (this._running) {
      return;
    }
    this._running = true;
    void this.pollSafe();
    this._timer = setInterval(() => {
      if (this._running) {
        void this.pollSafe();
      }
    }, this._intervalMs);
    this._timer.unref();
  }

  stop(): void {
    this._running = false;
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  private async pollSafe(): Promise<void> {
    try {
      const s = await this._sample();
      if (!this._running) {
        return;
      }
      this.applySample(s);
    } catch {
      // Ignore transient sampling errors during background polling
    }
  }

  private applySample(s: MemorySample): HealthLevel {
    this._last = s;
    const next = memoryLevel(s);
    if (next !== this._level) {
      this._level = next;
      this._onChange(next, s);
    }
    return next;
  }

  async checkNow(): Promise<HealthLevel> {
    if (this._checking) {
      return this._checking;
    }
    const run = (async () => {
      const s = await this._sample();
      return this.applySample(s);
    })();
    this._checking = run;
    try {
      return await run;
    } finally {
      if (this._checking === run) {
        this._checking = undefined;
      }
    }
  }
}

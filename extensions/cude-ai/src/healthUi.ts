// Memory guard UI: watches system memory (healthMonitor.ts) and, before anything crashes, shows a status bar warning
// and offers one-click fixes: stop Cude's own background helpers and show what else is using memory.
import * as vscode from 'vscode';
import { HealthMonitor, topProcesses, type HealthLevel, type MemorySample } from './healthMonitor';
import { stopComputer } from './appBridge';

const tr = () => vscode.workspace.getConfiguration('cude-ai').get<string>('language', 'en') === 'tr';
let monitor: HealthMonitor | undefined;
let item: vscode.StatusBarItem | undefined;
let warnedCritical = 0;

export function memoryHealth(): HealthLevel { return monitor?.level ?? 'ok'; }

const mb = (v: number) => v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`;
function diskLow(s: MemorySample) { return s.freeDiskMB !== undefined && s.freeDiskMB < 4096; }
function describe(s: MemorySample) {
  const t = tr();
  const free = s.freeCommitMB !== undefined ? Math.min(s.freePhysMB, s.freeCommitMB) : s.freePhysMB;
  const memLow = free < 2000;
  if (diskLow(s) && !memLow) return `${t ? 'Disk' : 'Disk'} ${mb(s.freeDiskMB!)}`;
  if (diskLow(s)) return `${t ? 'Bellek' : 'Memory'} ${mb(free)} · Disk ${mb(s.freeDiskMB!)}`;
  return mb(free);
}

/** Deletes only Cude's own reproducible files: screenshots, old logs and crash dumps of this app. */
async function cleanCudeCaches(): Promise<number> {
  const fs = await import('node:fs/promises'); const path = await import('node:path'); const os = await import('node:os');
  let freed = 0;
  const removeDir = async (dir: string) => { try { for (const e of await fs.readdir(dir)) { const f = path.join(dir, e); try { const st = await fs.stat(f); freed += st.size; await fs.rm(f, { recursive: true, force: true }); } catch { } } } catch { } };
  await removeDir(path.join(os.tmpdir(), 'cude-computer'));
  await removeDir(path.join(os.tmpdir(), 'cude-browser'));
  const exeDir = path.dirname(process.execPath);
  for (const dir of [path.join(exeDir, 'data', 'user-data', 'logs'), path.join(exeDir, 'data', 'user-data', 'Crashpad', 'reports')]) {
    try { const entries = await fs.readdir(dir); const cutoff = Date.now() - 3 * 86400000; for (const e of entries) { const f = path.join(dir, e); try { const st = await fs.stat(f); if (st.mtimeMs < cutoff) { freed += st.isDirectory() ? 0 : st.size; await fs.rm(f, { recursive: true, force: true }); } } catch { } } } catch { }
  }
  return Math.round(freed / (1024 * 1024));
}

async function freeMemory(stopHelpers: () => number) {
  const t = tr();
  let freed = 0;
  try { freed += stopHelpers(); } catch { }
  try { stopComputer(); freed++; } catch { }
  const level = await monitor?.checkNow().catch(() => undefined);
  void vscode.window.showInformationMessage(t
    ? `Cude arka plan yardımcılarını kapattı (${freed}). Bellek durumu: ${level === 'ok' ? 'normal' : level === 'low' ? 'az' : 'kritik'}. Gerekirse kullanmadığınız uygulamaları kapatın.`
    : `Cude stopped its background helpers (${freed}). Memory: ${level ?? 'unknown'}. Close apps you are not using if needed.`);
}

async function showUsers() {
  const t = tr();
  const rows = await topProcesses(10);
  if (!rows.length) { void vscode.window.showInformationMessage(t ? 'Süreç listesi alınamadı.' : 'Could not read the process list.'); return; }
  await vscode.window.showQuickPick(rows.map(r => ({ label: r.name, description: `${r.privateMB >= 1024 ? (r.privateMB / 1024).toFixed(1) + ' GB' : r.privateMB + ' MB'}${r.count > 1 ? ` · ${r.count} ${t ? 'süreç' : 'processes'}` : ''}` })),
    { title: t ? 'En çok bellek kullanan uygulamalar' : 'Apps using the most memory', placeHolder: t ? 'Kullanmadıklarınızı kapatmak belleği hemen boşaltır' : 'Closing the ones you do not use frees memory at once' });
}

export function activateHealth(context: vscode.ExtensionContext, stopHelpers: () => number) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  item.command = 'cude-ai.memoryHealth';
  const render = (level: HealthLevel, s: MemorySample) => {
    if (!item) return;
    const t = tr();
    if (level === 'ok') { item.hide(); return; }
    const label = describe(s); item.text = `$(${level === 'critical' ? 'error' : 'warning'}) ${/^(Disk|Bellek|Memory)/.test(label) ? label : `${t ? 'Bellek' : 'Memory'} ${label}`}`;
    item.tooltip = t ? 'Sistem belleği azaldı. Tıklayın: Cude yardımcılarını kapat / ne yer kaplıyor?' : 'System memory is low. Click: stop Cude helpers / see what uses memory';
    item.backgroundColor = new vscode.ThemeColor(level === 'critical' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
    item.show();
    if (level === 'critical' && Date.now() - warnedCritical > 10 * 60_000) {
      warnedCritical = Date.now();
      const free = t ? 'Yer aç' : 'Free memory', who = t ? 'Ne yer kaplıyor?' : 'What uses memory?';
      void vscode.window.showWarningMessage(t
        ? (diskLow(s) ? `Sistem diski neredeyse dolu (${mb(s.freeDiskMB!)} boş). Windows'un sanal belleği de bu diskte; uygulamalar çökebilir.` : `Sistem belleği kritik seviyede (${describe(s)} boş). Uygulamalar ve yapay zekâ araçları çökebilir.`)
        : (diskLow(s) ? `The system drive is almost full (${mb(s.freeDiskMB!)} free). Windows keeps virtual memory there; apps may crash.` : `System memory is critically low (${describe(s)} free). Apps and AI tools may crash.`), free, who)
        .then(pick => { if (pick === free) void freeMemory(stopHelpers).catch(() => undefined); else if (pick === who) void showUsers().catch(() => undefined); }, () => undefined);
    }
  };
  monitor = new HealthMonitor({ onChange: render });
  context.subscriptions.push(item,
    vscode.commands.registerCommand('cude-ai.memoryHealth', async () => {
      const t = tr();
      const level = await monitor?.checkNow().catch(() => 'ok' as HealthLevel);
      const free = t ? 'Cude yardımcılarını kapat (OpenCode sunucusu, yerel model, bilgisayar/tarayıcı)' : 'Stop Cude helpers (OpenCode server, local model, computer/browser)';
      const who = t ? 'En çok bellek kullanan uygulamaları göster' : 'Show the apps using the most memory';
      const clean = t ? 'Cude önbelleklerini temizle (ekran görüntüleri, eski kayıtlar)' : 'Clean Cude caches (screenshots, old logs)';
      const storage = t ? 'Windows depolama ayarlarını aç (disk temizleme)' : 'Open Windows storage settings (free disk space)';
      const pick = await vscode.window.showQuickPick([free, who, clean, storage], { title: `${t ? 'Bellek' : 'Memory'}: ${monitor?.last ? describe(monitor.last) : '?'} ${t ? 'boş' : 'free'} · ${level}` });
      if (pick === free) await freeMemory(stopHelpers); else if (pick === who) await showUsers();
      else if (pick === clean) { const n = await cleanCudeCaches(); void vscode.window.showInformationMessage(t ? `Cude önbellekleri temizlendi (${n} MB).` : `Cude caches cleaned (${n} MB).`); await monitor?.checkNow().catch(() => undefined); }
      else if (pick === storage) void vscode.env.openExternal(vscode.Uri.parse('ms-settings:storagesense')).then(undefined, () => undefined);
    }),
    { dispose: () => monitor?.stop() });
  const start = setTimeout(() => monitor?.start(), 15_000); start.unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(start) });
}

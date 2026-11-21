// Wires computer use, the isolated Cude browser and desktop app discovery into Cude AI.
// computerUse.ts / browserControl.ts hold the policy (no vscode dependency, unit tested); this file adds the
// approval dialogs, settings, the stop control and the agent tool entry points.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { ComputerUse, WindowsDriver, WindowsActivityBar, type Approval, type ApprovalRequest } from './computerUse';
import { CudeBrowser } from './browserControl';
import { mcpTargets } from './desktopBridge';

export const COMPUTER_READ_TOOLS = ['list_apps', 'list_windows', 'ui_tree', 'screen_capture', 'browser_read', 'browser_tabs', 'browser_screenshot'];
export const COMPUTER_WRITE_TOOLS = ['open_app', 'focus_window', 'click', 'type_text', 'press_keys', 'scroll', 'browser_open', 'browser_click', 'browser_type', 'browser_close'];

let computer: ComputerUse | undefined;
let browser: CudeBrowser | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

const cfg = () => vscode.workspace.getConfiguration('cude-ai');
const lang = (): 'tr' | 'en' => cfg().get<string>('language', 'en') === 'tr' ? 'tr' : 'en';

export function computerSettings() {
  return { enabled: cfg().get<boolean>('computer.enabled', false), allowedApps: cfg().get<string[]>('computer.allowedApps', []) };
}
export function browserSettings() { return { enabled: cfg().get<boolean>('browser.enabled', false) }; }

/** Modal approval: Allow once / Allow for this session (per app) / Deny. Closing the dialog is a deny. */
async function approver(request: ApprovalRequest): Promise<Approval> {
  const tr = lang() === 'tr';
  const once = tr ? 'Bir kez izin ver' : 'Allow once';
  const who = request.app.split(' — ')[0].replace(/^[a-z]+:/i, '');
  const session = tr ? `Bu oturumda izin ver (${who})` : `Allow for this session (${who})`;
  const buttons = request.sessionable ? [once, session] : [once];
  const pick = await vscode.window.showWarningMessage(request.title, { modal: true, detail: request.detail }, ...buttons);
  return pick === once ? 'once' : pick === session ? 'session' : 'deny';
}

function updateStatus(active: boolean, label?: string) {
  if (!statusItem) return;
  const tr = lang() === 'tr';
  if (active) {
    statusItem.text = `$(debug-stop) ${tr ? 'Cude ekranı kullanıyor · Durdur' : 'Cude is using the screen · Stop'}`;
    statusItem.tooltip = label || '';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.show();
  } else statusItem.hide();
}

export function getComputer(): ComputerUse {
  if (computer) return computer;
  const self = path.basename(process.execPath).replace(/\.exe$/i, '');
  let instance: ComputerUse;
  const bar = new WindowsActivityBar(() => lang() === 'tr'
    ? { label: 'Cude ekranı kullanıyor', stop: 'Durdur (Esc)', stopped: 'Durduruldu' }
    : { label: 'Cude is using the screen', stop: 'Stop (Esc)', stopped: 'Stopped' }, () => instance.stop());
  instance = new ComputerUse({
    driver: new WindowsDriver(), approver, settings: computerSettings, bar, language: lang,
    selfProcesses: [self, 'cudeide', 'cude-ide', 'code', 'codium'],
    shotDir: path.join(os.tmpdir(), 'cude-computer'),
    ui: { active: label => updateStatus(true, label), idle: () => updateStatus(false), stopped: () => updateStatus(false) },
  });
  computer = instance;
  return instance;
}

export function getBrowser(): CudeBrowser {
  if (browser) return browser;
  browser = new CudeBrowser({
    approver, settings: browserSettings, language: lang,
    shotDir: path.join(os.tmpdir(), 'cude-browser'),
    onLaunch: pid => computer?.allowBrowserPid(pid), onClose: pid => computer?.forgetBrowserPid(pid),
  });
  return browser;
}

export function stopComputer() {
  computer?.stop();
  void browser?.close({ force: true }).catch(() => undefined);
  updateStatus(false);
}

// ---------- Desktop app discovery ----------
export type DesktopApp = { name: string; path?: string; running: boolean; windowTitle?: string; mcp?: string; mcpConnected?: boolean };

function startMenuShortcuts(): Array<{ name: string; path: string }> {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const out = new Map<string, { name: string; path: string }>();
  const skip = /uninstall|kaldır|readme|help|yardım|website|documentation|release notes|license/i;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) {
        const name = e.name.replace(/\.(lnk|url|appref-ms)$/i, '');
        if (!skip.test(name) && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, path: full });
      }
    }
  };
  if (process.platform === 'win32') roots.forEach(r => walk(r, 0));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Running top-level windows. Uses the live computer-use helper only when it is already in use; otherwise a one-shot
 *  query that exits by itself, so opening the app list never leaves a background process behind. */
async function runningWindows(): Promise<Array<{ process: string; title: string }>> {
  if (process.platform !== 'win32') return [];
  if (computer && computerSettings().enabled && !computer.stopped && computer.log.length) { try { return await computer.windows(); } catch { } }
  return await new Promise(resolve => {
    let out = '';
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object @{n='process';e={$_.ProcessName}},@{n='title';e={$_.MainWindowTitle}} | ConvertTo-Json -Compress"], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { } resolve([]); }, 8000); timer.unref?.();
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => { clearTimeout(timer); try { const j = JSON.parse((out || '[]').replace(/[\u0000-\u001f]/g, ' ')); resolve((Array.isArray(j) ? j : [j]).filter(x => x?.process).map(x => ({ process: String(x.process), title: String(x.title || '') }))); } catch { resolve([]); } });
  });
}

export async function discoverApps(): Promise<DesktopApp[]> {
  const shortcuts = startMenuShortcuts();
  const windows = await runningWindows();
  const apps = new Map<string, DesktopApp>();
  for (const s of shortcuts) apps.set(s.name.toLowerCase(), { name: s.name, path: s.path, running: false });
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const NOISE = new Set(['applicationframehost', 'textinputhost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'explorer', 'systemsettings', 'lockapp', 'cudeide', 'msedgewebview2', 'powershell', 'conhost', 'windowsterminal', 'dwm']);
  for (const w of windows) {
    const proc = norm(w.process);
    if (!proc || NOISE.has(proc)) continue;
    const candidates = [...apps.values()].filter(a => a.path && (norm(a.name) === proc || norm(a.name).endsWith(proc)));
    const hit = candidates.find(a => norm(a.name) === proc) || candidates.sort((a, b) => Number(norm(b.name).endsWith(proc)) - Number(norm(a.name).endsWith(proc)) || a.name.length - b.name.length)[0];
    if (hit) { hit.running = true; hit.windowTitle ??= w.title; }
    else if (!apps.has(w.process.toLowerCase())) apps.set(w.process.toLowerCase(), { name: w.process.charAt(0).toUpperCase() + w.process.slice(1), running: true, windowTitle: w.title });
  }
  const aliases: Record<string, string[]> = { claude: ['claude', 'claudedesktop'], vscode: ['visualstudiocode', 'code'], antigravity: ['antigravity'], gemini: ['geminicli'], lmstudio: ['lmstudio'], cursor: ['cursor'], windsurf: ['windsurf'], opencode: ['opencode', 'opencodedesktop'] };
  for (const t of mcpTargets()) {
    const names = aliases[t.id] ?? [norm(t.label)];
    const key = [...apps.keys()].find(k => names.includes(norm(k)));
    const entry = key ? apps.get(key)! : (t.installed ? { name: t.label, running: false } as DesktopApp : undefined);
    if (!entry) continue;
    entry.mcp = t.id; entry.mcpConnected = t.connected; entry.name = t.label;
    if (!key) apps.set(t.label.toLowerCase(), entry);
  }
  return [...apps.values()].sort((a, b) => Number(!!b.mcp) - Number(!!a.mcp) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

async function listApps(args: any): Promise<string> {
  const filter = String(args?.filter || '').toLowerCase();
  const apps = (await discoverApps()).filter(a => !filter || a.name.toLowerCase().includes(filter));
  if (!apps.length) return lang() === 'tr' ? 'Uygulama bulunamadı.' : 'No apps found.';
  const rows = apps.slice(0, 150).map(a => `${a.name}${a.running ? ' | running' + (a.windowTitle ? ` "${a.windowTitle.slice(0, 50)}"` : '') : ''}${a.mcp ? ` | MCP:${a.mcp}${a.mcpConnected ? ' (connected to Cude)' : ' (can connect)'}` : ''}`);
  return `${rows.join('\n')}\n\nMCP apps can be connected to Cude with the "Cude: Connect Desktop Apps" command (the user chooses). Other apps: open_app, then ui_tree / click / type_text.`;
}

/** Builds a shell-free spawn spec for opening an executable or Start Menu shortcut without cmd.exe interpolation. */
export function launchAppCommand(target: string): { command: string; args: string[]; env?: NodeJS.ProcessEnv; waitExit: boolean } {
  if (/\.exe$/i.test(target)) return { command: target, args: [], waitExit: false };
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    command: ps,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:CUDE_OPEN_TARGET'],
    env: { ...process.env, CUDE_OPEN_TARGET: target },
    waitExit: true,
  };
}

async function openApp(args: any): Promise<string> {
  const tr = lang() === 'tr';
  const cu = getComputer();
  const name = String(args?.name || '').trim();
  if (!name) return tr ? 'Uygulama adı verin (list_apps).' : 'Give an app name (see list_apps).';
  const lower = name.toLowerCase().replace(/\.exe$/, '');
  const shortcuts = startMenuShortcuts();
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const BUILTIN: Array<{ names: string[]; exe: string; proc: string; label: string }> = [
    { names: ['notepad', 'not defteri'], exe: path.join(sys32, 'notepad.exe'), proc: 'notepad', label: 'Notepad' },
    { names: ['paint', 'mspaint'], exe: path.join(sys32, 'mspaint.exe'), proc: 'mspaint', label: 'Paint' },
    { names: ['calculator', 'calc', 'hesap makinesi'], exe: path.join(sys32, 'calc.exe'), proc: 'calculatorapp', label: 'Calculator' },
    { names: ['wordpad', 'write'], exe: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows NT', 'Accessories', 'wordpad.exe'), proc: 'wordpad', label: 'WordPad' },
    { names: ['snipping tool', 'ekran alıntısı aracı'], exe: path.join(sys32, 'SnippingTool.exe'), proc: 'snippingtool', label: 'Snipping Tool' },
  ];
  let target: string | undefined, label = name, procGuess = lower.replace(/\s+/g, '');
  const exact = shortcuts.find(s => s.name.toLowerCase() === lower);
  const builtin = BUILTIN.find(b => b.names.includes(lower) && fs.existsSync(b.exe));
  const partial = shortcuts.filter(s => s.name.toLowerCase().includes(lower)).sort((a, b) => a.name.length - b.name.length)[0];
  if (exact) { target = exact.path; label = exact.name; procGuess = exact.name.replace(/\s+/g, '').toLowerCase(); }
  else if (builtin) { target = builtin.exe; label = builtin.label; procGuess = builtin.proc; }
  else if (partial) { target = partial.path; label = partial.name; procGuess = partial.name.replace(/\s+/g, '').toLowerCase(); }
  else if (/^[\w.-]{1,60}$/.test(lower) && fs.existsSync(path.join(sys32, lower + '.exe'))) { target = path.join(sys32, lower + '.exe'); label = lower; procGuess = lower; }
  if (!target) return tr ? `"${name}" bulunamadı. list_apps ile kurulu uygulamaların adlarını görün.` : `"${name}" was not found. See list_apps for installed app names.`;
  const gate = await cu.gate('open', { process: procGuess, title: label }, tr ? `Cude "${label}" uygulamasını açsın mı?` : `Let Cude open "${label}"?`, target, { key: `open:${label.toLowerCase()}` });
  if (gate) return gate;
  const shortcut = { name: label };
  const launch = launchAppCommand(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { windowsHide: true, detached: true, shell: false, stdio: 'ignore', ...(launch.env ? { env: launch.env } : {}) });
    child.on('error', reject);
    if (launch.waitExit) child.on('exit', () => resolve());
    else child.on('spawn', () => resolve());
    child.unref();
  });
  await new Promise(r => setTimeout(r, 2500));
  return `${tr ? 'Açıldı' : 'Opened'}: ${shortcut!.name}. ${tr ? 'Pencereyi görmek için list_windows, öğeler için ui_tree kullanın.' : 'Use list_windows to find its window and ui_tree for its elements.'}`;
}

/** Tool descriptions appended to the agent's tool list. */
export function computerToolList(writes: boolean): string[] {
  const lines = [
    'list_apps {"filter":"optional"} — installed and running desktop apps; marks apps that can connect to Cude over MCP.',
    'list_windows {} — open windows (id, app, title, position). Computer use must be turned on by the user.',
    'ui_tree {"window":"id|title|app","max":200} — selectable elements (buttons, text boxes, links) of a window with ids e1, e2…',
    'screen_capture {"window":"optional id|title"} — screenshot of a window or the screen plus its UI elements as text.',
    'browser_read {} — text and interactive elements (refs) of the current page in the isolated Cude browser.',
    'browser_tabs {"activate":"optional tab id"} — tabs of the Cude browser.',
    'browser_screenshot {} — screenshot of the current Cude browser page.',
  ];
  if (writes) lines.push(
    'open_app {"name":"Notepad"} — open a desktop app from the Start menu (asks the user).',
    'focus_window {"window":"id|title|app"} — bring a window to the front.',
    'click {"element":"e3"} or {"x":100,"y":200,"window":"…","double":false,"button":"left"} — click an element or point (asks the user).',
    'type_text {"text":"hello","element":"optional e5","window":"optional"} — type text (never passwords or card numbers).',
    'press_keys {"keys":"ctrl+s"} — press keys or a shortcut.',
    'scroll {"amount":-3,"element":"optional","x":0,"y":0,"horizontal":false} — scroll.',
    'browser_open {"url":"https://…","new_tab":false} — open a page in the isolated Cude browser (separate profile, never the user\'s own).',
    'browser_click {"ref":"r4"} — click an element from browser_read.',
    'browser_type {"ref":"r2","text":"…","submit":false} — type into a field (never passwords or card numbers).',
    'browser_close {} — close the Cude browser.',
  );
  lines.push('Computer and browser rules: look first (ui_tree / browser_read), act one step at a time, every action is approved by the user; if a tool says it is off or stopped, tell the user instead of retrying.');
  return lines;
}

/** Returns undefined when the tool is not a computer/browser tool. */
export async function runComputerTool(tool: string, args: any, writes: boolean): Promise<string | undefined> {
  if (![...COMPUTER_READ_TOOLS, ...COMPUTER_WRITE_TOOLS].includes(tool)) return undefined;
  const tr = lang() === 'tr';
  if (COMPUTER_WRITE_TOOLS.includes(tool) && !writes) return tr ? 'Bu izin modunda bilgisayar/tarayıcı eylemleri kapalı (yalnız okuma).' : 'Computer and browser actions are off in this permission mode (read only).';
  args = args || {};
  try {
    if (tool.startsWith('browser_')) {
      if (!browserSettings().enabled) return tr ? 'Tarayıcı kontrolü kapalı. Kullanıcı "Ajanlar ve uygulamalar" bölümünden açabilir.' : 'Browser control is off. The user can turn it on in "Agents and apps".';
      const b = getBrowser();
      switch (tool) {
        case 'browser_open': return await b.open(args);
        case 'browser_read': return await b.read(args);
        case 'browser_click': return await b.click(args);
        case 'browser_type': return await b.type(args);
        case 'browser_screenshot': return await b.screenshot(args);
        case 'browser_tabs': return await b.tabs(args);
        case 'browser_close': return await b.close(args);
      }
    }
    if (tool === 'list_apps') return await listApps(args);
    if (!computerSettings().enabled) return tr ? 'Bilgisayar kullanımı kapalı. Kullanıcı "Ajanlar ve uygulamalar" bölümünden açabilir.' : 'Computer use is turned off. The user can turn it on in "Agents and apps".';
    const cu = getComputer();
    switch (tool) {
      case 'open_app': return await openApp(args);
      case 'list_windows': return await cu.listWindows();
      case 'ui_tree': return await cu.uiTree(args);
      case 'screen_capture': return await cu.screenCapture(args);
      case 'focus_window': return await cu.focusWindow(args);
      case 'click': return await cu.click(args);
      case 'type_text': return await cu.typeText(args);
      case 'press_keys': return await cu.pressKeys(args);
      case 'scroll': return await cu.scroll(args);
    }
  } catch (error: any) {
    return `${tool} failed: ${String(error?.message || error).slice(0, 400)}`;
  }
  return undefined;
}

// ---------- Commands and lifecycle ----------
export function activateAppBridge(context: vscode.ExtensionContext) {
  extensionContext = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusItem.command = 'cude-ai.stopComputer';
  context.subscriptions.push(statusItem,
    vscode.commands.registerCommand('cude-ai.stopComputer', () => { stopComputer(); void vscode.window.setStatusBarMessage(lang() === 'tr' ? 'Cude bilgisayar kullanımını durdurdu.' : 'Cude stopped using the computer.', 4000); }),
    vscode.commands.registerCommand('cude-ai.toggleComputerUse', async () => {
      const on = !computerSettings().enabled; await cfg().update('computer.enabled', on, vscode.ConfigurationTarget.Global);
      if (!on) stopComputer(); else computer?.resume();
      void vscode.window.showInformationMessage(lang() === 'tr' ? `Bilgisayar kullanımı ${on ? 'açıldı' : 'kapatıldı'}.` : `Computer use ${on ? 'on' : 'off'}.`);
    }),
    vscode.commands.registerCommand('cude-ai.toggleBrowserControl', async () => {
      const on = !browserSettings().enabled; await cfg().update('browser.enabled', on, vscode.ConfigurationTarget.Global);
      if (!on) void browser?.close({ force: true }).catch(() => undefined);
      void vscode.window.showInformationMessage(lang() === 'tr' ? `Tarayıcı kontrolü ${on ? 'açıldı' : 'kapatıldı'}.` : `Browser control ${on ? 'on' : 'off'}.`);
    }),
    vscode.commands.registerCommand('cude-ai.showDesktopApps', async () => {
      const tr = lang() === 'tr';
      const apps = await discoverApps();
      const pick = await vscode.window.showQuickPick(apps.map(a => ({
        label: a.name, description: [a.running ? (tr ? 'açık' : 'running') : '', a.mcp ? (a.mcpConnected ? (tr ? 'Cude\'a bağlı' : 'connected to Cude') : (tr ? 'MCP ile bağlanabilir' : 'can connect via MCP')) : ''].filter(Boolean).join(' · '), app: a,
      })), { title: tr ? 'Masaüstü uygulamaları' : 'Desktop apps', placeHolder: tr ? 'MCP destekleyenler bağlanır; diğerleri bilgisayar kullanımıyla kontrol edilir' : 'MCP apps connect; others are controlled with computer use' });
      if (pick?.app.mcp) await vscode.commands.executeCommand('cude-ai.connectDesktopApps', pick.app.mcp);
      else if (pick) void vscode.window.showInformationMessage(tr ? `${pick.app.name}: Cude AI'a "${pick.app.name} uygulamasını aç ve …" diyerek bilgisayar kullanımıyla kontrol ettirebilirsiniz (her eylem onay ister).` : `${pick.app.name}: ask Cude AI to "open ${pick.app.name} and …" to control it with computer use (each action asks first).`);
    }),
    { dispose: () => { try { computer?.dispose(); } catch { } try { browser?.dispose(); } catch { } } },
  );
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    // Turning the switch off stops at once; turning it back on (Settings or Agents & apps) is the user's explicit resume.
    if (e.affectsConfiguration('cude-ai.computer.enabled')) { if (!computerSettings().enabled) stopComputer(); else computer?.resume(); }
    if (e.affectsConfiguration('cude-ai.browser.enabled') && !browserSettings().enabled) void browser?.close({ force: true }).catch(() => undefined);
  }));
}

/** State for the "Agents & apps" UI. */
export async function appBridgeState() {
  const apps = await discoverApps().catch(() => [] as DesktopApp[]);
  return {
    computer: computerSettings(), browser: browserSettings(), platform: process.platform,
    apps: apps.filter(a => a.mcp || a.running).slice(0, 40),
    mcp: mcpTargets(),
  };
}
void extensionContext;

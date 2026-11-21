// Desktop app bridge: lets Claude Desktop, Cursor, Windsurf, Codex and other MCP clients use Cude's tools.
// Local only (127.0.0.1), random port and token per session; edits and commands are approved in Cude.
import * as vscode from 'vscode';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { bridgeConfigured, writeBridgeConfig, type Target } from './desktopBridgeConfig';
import { runTool, type LoopOptions } from './agentLoop';
import { t, normalizeLanguage, type MessageKey } from './i18n';

const BRIDGE_DIR = path.join(os.homedir(), '.cude-ide');
export const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json');
const ALLOWED = new Set(['workspace_info', 'list_files', 'read_file', 'glob', 'grep', 'diagnostics', 'symbols', 'definition', 'references', 'git', 'system_info', 'open_file', 'edit_file', 'multi_edit', 'write_file', 'run_command', 'android_build',
  'list_apps', 'list_windows', 'ui_tree', 'screen_capture', 'open_app', 'focus_window', 'click', 'type_text', 'press_keys', 'scroll',
  'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_tabs', 'browser_close']);

let server: http.Server | undefined;
let token = '';

function workspace() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }

async function confirm(message: string, detail: string, action: string) {
  const pick = await vscode.window.showWarningMessage(`${message} (requested by a desktop app through the Cude bridge)`, { modal: true, detail: detail.slice(0, 1500) }, action);
  return pick === action;
}

/** Resolves a file path strictly inside the workspace (blocks .., cross-drive, UNC paths and escaping symlinks). */
export async function resolveWorkspaceFile(ws: string, rawPath: string): Promise<string | undefined> {
  const input = String(rawPath || '').trim();
  if (!input || input.includes('\0') || /^(\\\\|\/\/)/.test(input)) return undefined;
  const full = path.resolve(ws, input);
  if (/^(\\\\|\/\/)/.test(full)) return undefined;
  const rel = path.relative(ws, full);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined;
  try {
    const [wsReal, fileReal] = await Promise.all([fs.realpath(ws), fs.realpath(full)]);
    if (/^(\\\\|\/\/)/.test(fileReal)) return undefined;
    const relReal = path.relative(wsReal, fileReal);
    if (!relReal || relReal === '..' || relReal.startsWith('..' + path.sep) || path.isAbsolute(relReal)) return undefined;
    return fileReal;
  } catch {
    return undefined;
  }
}

async function workspaceInfo(ws: string) {
  const editors = vscode.window.visibleTextEditors
    .map(e => path.relative(ws, e.document.uri.fsPath))
    .filter(p => p && !p.startsWith('..') && !path.isAbsolute(p))
    .map(p => p.split(path.sep).join('/'));
  const active = vscode.window.activeTextEditor;
  const selection = active && !active.selection.isEmpty ? active.document.getText(active.selection).slice(0, 4000) : '';
  let top: string[] = [];
  try { top = (await fs.readdir(ws, { withFileTypes: true })).filter(d => !d.name.startsWith('.')).slice(0, 60).map(d => d.name + (d.isDirectory() ? '/' : '')); } catch {}
  return [`Project: ${path.basename(ws)} (${ws})`, `Trusted: ${vscode.workspace.isTrusted}`, `Top level: ${top.join(', ')}`, `Open editors: ${editors.join(', ') || '(none)'}`,
    active ? `Active file: ${path.relative(ws, active.document.uri.fsPath)} line ${active.selection.active.line + 1}` : 'Active file: (none)', selection ? `Selection:\n${selection}` : ''].filter(Boolean).join('\n');
}

async function handleTool(tool: string, args: any): Promise<string> {
  const ws = workspace();
  if (!ws) return 'No folder is open in Cude IDE. Open a project first.';
  if (!vscode.workspace.isTrusted && !['workspace_info', 'list_files', 'read_file', 'glob', 'grep', 'symbols', 'system_info'].includes(tool)) return 'This folder is in Restricted Mode in Cude. Trust the folder first.';
  if (tool === 'workspace_info') return workspaceInfo(ws);
  if (tool === 'open_file') {
    const full = await resolveWorkspaceFile(ws, String(args.path || ''));
    if (!full) return 'That path is outside the project.';
    const doc = await vscode.workspace.openTextDocument(full);
    const line = Math.max(0, (Number(args.line) || 1) - 1);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: false });
    return `Opened ${args.path} at line ${line + 1}.`;
  }
  const permission = vscode.workspace.getConfiguration('cude-ai').get<string>('bridge.permission', 'ask') === 'readonly' ? 'readonly' : 'ask';
  const options: LoopOptions = {
    task: 'desktop bridge', workspace: ws, permission: permission as any,
    chat: async () => '', confirm,
    events: { activity: (label, detail) => { void vscode.window.setStatusBarMessage(`Cude bridge · ${label}${detail ? ': ' + detail.slice(0, 80) : ''}`, 6000); } },
    text: (key, values) => { try { return t(key as MessageKey, normalizeLanguage(vscode.workspace.getConfiguration('cude-ai').get('language', 'en')), values); } catch { return key; } },
  };
  return runTool(options, { tool, args });
}

export async function startBridge(context: vscode.ExtensionContext) {
  if (server) return;
  token = randomBytes(24).toString('hex');
  server = http.createServer((req, res) => {
    const reply = (status: number, body: object) => {
      if (res.writableEnded || res.destroyed) return;
      try { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); } catch {}
    };
    const host = String(req.headers.host || '');
    if (req.headers.origin) return reply(403, { error: 'origin not allowed' });
    if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return reply(403, { error: 'local only' });
    const auth = String(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token), given = Buffer.from(auth);
    if (req.socket.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return reply(403, { error: 'local only' });
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/tool') return reply(404, { error: 'not found' });
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { tool, args } = JSON.parse(body || '{}');
        if (!ALLOWED.has(String(tool))) return reply(400, { error: 'unknown tool' });
        reply(200, { text: await handleTool(String(tool), args && typeof args === 'object' ? args : {}) });
      } catch (error: any) {
        const msg = String(error?.message || error).split(token || '\0').join('[redacted]').slice(0, 400);
        reply(500, { error: msg });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => resolve()); });
  server.on('error', () => {});
  const port = (server.address() as any).port;
  await fs.mkdir(BRIDGE_DIR, { recursive: true });
  await fs.writeFile(BRIDGE_FILE, JSON.stringify({ port, token, pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
  context.subscriptions.push({ dispose: () => stopBridge() });
}

export function stopBridge() {
  try { (server as any)?.closeAllConnections?.(); } catch {}
  try { server?.close(); } catch {}
  server = undefined;
  const oldToken = token;
  token = '';
  try { const cur = JSON.parse(fsSync.readFileSync(BRIDGE_FILE, 'utf8')); if (oldToken && cur.token === oldToken) fsSync.unlinkSync(BRIDGE_FILE); } catch {}
}

function opencodeConfig(home: string) {
  const dir = path.join(home, '.config', 'opencode');
  for (const name of ['opencode.jsonc', 'opencode.json']) if (fsSync.existsSync(path.join(dir, name))) return path.join(dir, name);
  return path.join(dir, 'opencode.json');
}

export function targets(home = os.homedir(), appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), platform: NodeJS.Platform = process.platform): Target[] {
  const claude = platform === 'win32' ? path.join(appData, 'Claude', 'claude_desktop_config.json')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const editorData = platform === 'win32' ? appData : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  const zed = platform === 'win32' ? path.join(appData, 'Zed', 'settings.json') : path.join(home, '.config', 'zed', 'settings.json');
  return [
    { id: 'claude', label: 'Claude Desktop', file: claude },
    { id: 'cursor', label: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
    { id: 'windsurf', label: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { id: 'vscode', label: 'Visual Studio Code', file: path.join(appData, 'Code', 'User', 'mcp.json'), key: 'servers', detect: [path.join(appData, 'Code')] },
    { id: 'antigravity', label: 'Antigravity', file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), detect: [path.join(home, '.gemini', 'antigravity')] },
    { id: 'gemini', label: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json'), detect: [path.join(home, '.gemini', 'settings.json')] },
    { id: 'opencode', label: 'OpenCode', file: opencodeConfig(home), key: 'mcp', schema: 'opencode', detect: [path.join(home, '.config', 'opencode'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'ai.opencode.desktop')] },
    { id: 'zed', label: 'Zed', file: zed, key: 'context_servers' },
    { id: 'kiro', label: 'Kiro', file: path.join(home, '.kiro', 'settings', 'mcp.json'), detect: [path.join(home, '.kiro'), path.join(editorData, 'Kiro')] },
    { id: 'continue', label: 'Continue', file: path.join(home, '.continue', 'config.yaml'), schema: 'continue' },
    { id: 'trae', label: 'Trae', file: path.join(editorData, 'Trae', 'User', 'mcp.json'), detect: [path.join(editorData, 'Trae')] },
    { id: 'void', label: 'Void', file: path.join(home, '.void-editor', 'mcp.json'), detect: [path.join(home, '.void-editor'), path.join(editorData, 'Void')] },
    { id: 'lmstudio', label: 'LM Studio', file: path.join(home, '.lmstudio', 'mcp.json'), detect: [path.join(home, '.lmstudio')] },
  ];
}

/** Desktop apps that speak MCP and whether they look installed on this machine. */
export function mcpTargets(home?: string, appData?: string, platform?: NodeJS.Platform): Array<{ id: string; label: string; installed: boolean; connected: boolean; file: string }> {
  return targets(home, appData, platform).map(t => {
    const installed = (t.detect ?? [path.dirname(t.file)]).some(p => fsSync.existsSync(p));
    let connected = false;
    try { connected = bridgeConfigured(t, fsSync.readFileSync(t.file, 'utf8')); } catch {}
    return { id: t.id, label: t.label, installed, connected, file: t.file };
  });
}

function serverEntry(context: vscode.ExtensionContext) {
  const script = path.join(context.extensionPath, 'media', 'bridge', 'cude-mcp.js');
  // Use Cude's own runtime so the user does not need Node.js installed.
  return { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function desktopBridgeActive(){return server?.listening===true;}

export async function connectDesktopApps(context: vscode.ExtensionContext, app?:string) {
  const tr = vscode.workspace.getConfiguration('cude-ai').get<string>('language', 'en') === 'tr';
  const list = targets();
  const choices = [
    ...list.map(t => ({ label: t.label, description: (t.detect ?? [path.dirname(t.file)]).some(p => fsSync.existsSync(p)) ? (tr ? 'kurulu' : 'installed') : (tr ? 'bulunamadı' : 'not found'), id: t.id, picked: !!app })),
    { label: 'Codex', description: tr ? 'ayar satırını göster (dosyasına dokunulmaz)' : 'show the config line (its files are not touched)', id: 'codex', picked: false },
    { label: tr ? 'Diğer MCP uygulamaları' : 'Other MCP apps', description: tr ? 'JSON ayarını kopyala' : 'copy the JSON config', id: 'copy', picked: false },
  ].filter(item=>!app||item.id===app);
  const picks = await vscode.window.showQuickPick(choices, { canPickMany: true, title: tr ? 'Cude köprüsü: masaüstü uygulamalarını bağla' : 'Cude bridge: connect desktop apps', placeHolder: tr ? 'Cude araçlarını kullanacak uygulamaları seç' : 'Choose the apps that should use Cude tools' });
  if (!picks?.length) return;
  await startBridge(context);
  await vscode.workspace.getConfiguration('cude-ai').update('bridge.enabled', true, vscode.ConfigurationTarget.Global);
  const entry = serverEntry(context), done: string[] = [];
  for (const pick of picks) {
    const target = list.find(t => t.id === (pick as any).id);
    if (target) {
      await writeBridgeConfig(target, entry);
      done.push(target.label);
    }
  }
  const json = JSON.stringify({ mcpServers: { 'cude-ide': entry } }, null, 2);
  if (picks.some(p => (p as any).id === 'copy')) { await vscode.env.clipboard.writeText(json); done.push(tr ? 'JSON panoya kopyalandı' : 'JSON copied'); }
  if (picks.some(p => (p as any).id === 'codex')) {
    const toml = `[mcp_servers.cude-ide]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${JSON.stringify(entry.args[0])}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`;
    const doc = await vscode.workspace.openTextDocument({ language: 'toml', content: `# ${tr ? 'Codex ayar dosyanıza (config.toml) bu bölümü ekleyin' : 'Add this section to your Codex config.toml'}\n${toml}` });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  void vscode.window.showInformationMessage(tr
    ? `Cude köprüsü hazır: ${done.join(', ')}. Uygulamayı yeniden başlatınca "cude-ide" araçları görünür. Düzenleme ve komutlar her seferinde Cude'da onayınızı ister.`
    : `Cude bridge is ready: ${done.join(', ')}. Restart the app to see the "cude-ide" tools. Edits and commands always ask for your approval in Cude.`);
}

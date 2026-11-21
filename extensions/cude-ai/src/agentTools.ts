// Extended agent tools: fast code search, language intelligence, git, web, system, Android and 3D helpers.
// Every tool returns plain text for the model; failures become readable observations, never crashes.
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { COMPUTER_READ_TOOLS, COMPUTER_WRITE_TOOLS, computerToolList, runComputerTool } from './appBridge';

export const EXTRA_READ_TOOLS = ['glob', 'grep', 'diagnostics', 'symbols', 'definition', 'references', 'git', 'web_fetch', 'system_info', 'todo', 'android_devices', 'img2threejs_guide', ...COMPUTER_READ_TOOLS];
export const EXTRA_WRITE_TOOLS = ['multi_edit', 'move_file', 'delete_file', 'android_build', 'scaffold_threejs', ...COMPUTER_WRITE_TOOLS];

export type ToolContext = {
  workspace: string; permission: string; signal?: AbortSignal;
  inside: (relative: string) => string;
  confirm: (message: string, detail: string, action: string) => Promise<boolean>;
  write: (full: string, content: string) => Promise<void>;
  activity: (label: string, detail: string) => void;
  extensionPath?: string;
};

const L = (en: string, tr: string) => vscode.workspace.getConfiguration('cude-ai').get<string>('language', 'en') === 'tr' ? tr : en;
const LIMIT = 12000;
const clip = (text: string, limit = LIMIT) => text.length > limit ? `${text.slice(0, limit)}\n…[${text.length - limit} more characters]` : text;

export function extraToolList(writes: boolean): string[] {
  const lines = [
    'glob {"pattern":"**/*.ts"} — find files by name pattern (respects .gitignore, up to 400).',
    'grep {"pattern":"regex","glob":"*.ts (optional)","context":2,"case_sensitive":false} — fast ripgrep search with surrounding lines (up to 120 matches).',
    'diagnostics {"path":"file (optional)"} — compiler/linter errors and warnings the editor currently sees.',
    'symbols {"query":"name"} — find classes, functions and variables across the project.',
    'definition {"path":"file","line":10,"character":5} — jump to where a symbol is defined.',
    'references {"path":"file","line":10,"character":5} — every place a symbol is used.',
    'git {"args":"status | diff | log -n 10 | show HEAD | blame file | branch"} — read-only git commands.',
    'web_fetch {"url":"https://..."} — read a public web page or raw file as text (docs, issues, READMEs).',
    'system_info {} — OS, CPU, RAM, GPU and installed toolchains (node, python, git, java, Android SDK, adb, gradle).',
    'todo {"items":[{"text":"step","done":false}]} — keep a visible checklist for multi-step work.',
    'android_devices {} — connected Android devices/emulators and recent logcat errors.',
    'img2threejs_guide {} — the method for turning a reference image into procedural Three.js code.',
  ];
  if (writes) lines.push(
    'multi_edit {"path":"file","edits":[{"old_text":"exact","new_text":"replacement"}]} — several exact edits in one file, all or nothing.',
    'move_file {"from":"old/path","to":"new/path"} — rename or move a file after approval.',
    'delete_file {"path":"file"} — delete a file after approval (recoverable from the OS recycle bin is not guaranteed).',
    'android_build {"task":"assembleDebug | installDebug | test | lint | bundleRelease"} — run Gradle for the Android project after approval.',
    'scaffold_threejs {"folder":"game","title":"My scene"} — create a ready-to-run Three.js + Vite project to build a 3D scene or game in.',
  );
  lines.push(...computerToolList(writes));
  return lines;
}

export function windowsBatchInvocation(cmd:string,args:string[]) {
  if (!/\.(cmd|bat)$/i.test(cmd)) return undefined;
  if (/[\r\n"%!^&|<>]/.test(cmd) || args.some(arg=>!/^[-\w.:=]+$/.test(arg))) {
    throw new Error('Unsupported characters in Windows batch command.');
  }
  return ['/d','/v:off','/s','/c',`"${[cmd,...args].map(part=>'"'+part+'"').join(' ')}"`];
}

export function findOnPath(names:readonly string[],searchPath=process.env.PATH??'') {
  for(const entry of searchPath.split(path.delimiter)){
    const directory=entry.replace(/^"|"$/g,'');
    if(!path.isAbsolute(directory))continue;
    for(const name of names){
      const candidate=path.join(directory,name);
      try{
        if(!fsSync.statSync(candidate,{throwIfNoEntry:false})?.isFile())continue;
        if(process.platform!=='win32')fsSync.accessSync(candidate,fsSync.constants.X_OK);
        return candidate;
      }catch{/* Keep searching inaccessible PATH directories. */}
    }
  }
}

function resolveWindowsBatch(cmd:string,environment:NodeJS.ProcessEnv) {
  if(!/\.(cmd|bat)$/i.test(cmd)||path.isAbsolute(cmd))return cmd;
  const candidate=findOnPath([cmd],environment.PATH??environment.Path);
  if(candidate)return candidate;
  throw new Error(`${cmd} was not found on PATH.`);
}

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 60000, signal?: AbortSignal, environment:NodeJS.ProcessEnv={}): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    if(signal?.aborted){resolve({code:null,out:'[cancelled]'});return;}
    let out = '', done = false;
    let child: ReturnType<typeof spawn>;
    try {
      const batch = process.platform==='win32' ? windowsBatchInvocation(resolveWindowsBatch(cmd,environment),args) : undefined;
      const executable = batch ? path.join(process.env.SystemRoot || 'C:\\Windows','System32','cmd.exe') : cmd;
      child = spawn(executable,batch??args,{cwd,windowsHide:true,windowsVerbatimArguments:!!batch,env:{...process.env,...environment,FORCE_COLOR:'0',CI:'1'}});
    }
    catch (error: any) { resolve({ code: -1, out: String(error?.message || error) }); return; }
    const finish = (code: number | null, suffix = '') => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',abort); resolve({ code, out: out + suffix }); };
    const abort=()=>{try { child.kill(); } catch {} finish(null,'\n[cancelled]');};
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null, `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`); }, timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    const take = (chunk: Buffer) => { out += chunk.toString('utf8'); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    child.on('error', error => finish(-1, `[could not start ${cmd}: ${error.message}]`));
    child.on('close', code => finish(code));
  });
}

let rgCache: string | undefined | null = null;
function ripgrep(): string | undefined {
  if (rgCache !== null) return rgCache || undefined;
  const root = vscode.env.appRoot;
  const candidates = [
    path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg'),
    path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'),
    path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'),
  ];
  rgCache = candidates.find(file => { try { return fsSync.statSync(file).isFile(); } catch { return false; } }) || '';
  return rgCache || undefined;
}

const rel = (ws: string, full: string) => path.relative(ws, full).split(path.sep).join('/');
const loc = (ws: string, uri: vscode.Uri, range: vscode.Range) => `${rel(ws, uri.fsPath)}:${range.start.line + 1}:${range.start.character + 1}`;

async function lineText(uri: vscode.Uri, line: number) {
  try { const doc = await vscode.workspace.openTextDocument(uri); return doc.lineAt(line).text.trim().slice(0, 160); } catch { return ''; }
}

function position(c: ToolContext, args: any) {
  const full = c.inside(args.path);
  const line = Math.max(1, Number(args.line) || 1) - 1, character = Math.max(1, Number(args.character) || 1) - 1;
  return { uri: vscode.Uri.file(full), pos: new vscode.Position(line, character) };
}

const SKILL_GUIDE = `img2threejs method (Apache-2.0, github.com/hoainho/img2threejs), adapted for Cude:
Goal: rebuild the object in the reference image as CODE-ONLY procedural Three.js (no mesh extraction, no downloaded models).
1. Assess the image: list the main parts, their rough proportions (relative to the largest part), materials, colours, symmetry and what is hidden.
2. Write a short spec: part tree (root → parts → details), each part's primitive (Box, Cylinder, Sphere, Capsule, Lathe, Extrude, Tube) and transform.
3. Build in passes, checking against the image after each pass:
   pass 1 silhouette (big primitives only) → pass 2 secondary forms → pass 3 details (bevels, grooves, small parts) → pass 4 materials (MeshStandardMaterial / MeshPhysicalMaterial, procedural textures with CanvasTexture or shader noise).
4. Export a factory: export function createModel(options) returning a THREE.Group with named children so it can be animated (pivots at joints).
5. Keep it game-ready: merge static geometry where possible, reuse materials, keep draw calls low, add a simple LOD if the model is detailed.
6. Verify: render front/side/top views in the preview, compare with the image, fix proportions before adding detail.
Use scaffold_threejs to create the project, write the factory in src/model.ts and show it in src/main.ts.`;

/** Returns undefined when the tool is not one of the extended tools. */
export async function runExtraTool(c: ToolContext, tool: string, args: any): Promise<string | undefined> {
  const ws = c.workspace, writes = c.permission !== 'plan' && c.permission !== 'readonly';
  const computerResult = await runComputerTool(tool, args, writes);
  if (computerResult !== undefined) return computerResult;
  switch (tool) {
    case 'glob': {
      const pattern = String(args.pattern || '**/*');
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(ws, pattern), '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}', 400);
      return found.length ? found.map(uri => rel(ws, uri.fsPath)).sort().join('\n') : 'No files match.';
    }
    case 'grep': {
      const pattern = String(args.pattern || ''); if (!pattern) return 'Give a pattern.';
      const rg = ripgrep();
      if (!rg) return 'Fast search is unavailable in this build; use the search tool instead.';
      const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '240', '--max-count', '20', '-C', String(Math.min(5, Math.max(0, Number(args.context) || 0)))];
      if (!args.case_sensitive) rgArgs.push('-i');
      if (args.glob) rgArgs.push('-g', String(args.glob));
      rgArgs.push('-g', '!**/.env*', '-e', pattern, '.');
      const { out } = await run(rg, rgArgs, ws, 30000, c.signal);
      const lines = out.split(/\r?\n/).filter(Boolean);
      return lines.length ? clip(lines.slice(0, 400).join('\n')) + (lines.length > 400 ? `\n…(${lines.length - 400} more lines)` : '') : 'No matches.';
    }
    case 'diagnostics': {
      const all = args.path ? [[vscode.Uri.file(c.inside(args.path)), vscode.languages.getDiagnostics(vscode.Uri.file(c.inside(args.path)))] as const] : vscode.languages.getDiagnostics();
      const rows: string[] = [];
      for (const [uri, list] of all) {
        if (!uri.fsPath.startsWith(path.resolve(ws))) continue;
        for (const d of list) {
          if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
          rows.push(`${loc(ws, uri, d.range)} ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}${d.source ? ` [${d.source}]` : ''}: ${d.message.split('\n')[0].slice(0, 220)}`);
          if (rows.length >= 150) break;
        }
      }
      return rows.length ? rows.join('\n') : 'No errors or warnings reported by the editor. (Open the relevant files if a language server has not analysed them yet.)';
    }
    case 'symbols': {
      const query = String(args.query || ''); if (!query) return 'Give a symbol name.';
      const found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query) || [];
      const rows = found.filter(s => s.location.uri.fsPath.startsWith(path.resolve(ws))).slice(0, 80)
        .map(s => `${vscode.SymbolKind[s.kind]} ${s.containerName ? s.containerName + '.' : ''}${s.name} — ${loc(ws, s.location.uri, s.location.range)}`);
      return rows.length ? rows.join('\n') : 'No symbols found (a language server may need the file open first).';
    }
    case 'definition': case 'references': {
      const { uri, pos } = position(c, args);
      await vscode.workspace.openTextDocument(uri);
      const command = tool === 'definition' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider';
      const found = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(command, uri, pos) || [];
      const rows: string[] = [];
      for (const item of found.slice(0, 100)) {
        const target = 'targetUri' in item ? item.targetUri : item.uri, range = 'targetRange' in item ? item.targetRange : item.range;
        rows.push(`${loc(ws, target, range)}  ${await lineText(target, range.start.line)}`);
      }
      return rows.length ? rows.join('\n') : `No ${tool} found at that position.`;
    }
    case 'git': {
      const raw = String(args.args || 'status').trim();
      const parts = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(p => p.replace(/^"|"$/g, '')) || ['status'];
      const allowed = new Set(['status', 'diff', 'log', 'show', 'blame', 'branch', 'rev-parse', 'ls-files', 'shortlog', 'describe', 'tag', 'remote']);
      if (!allowed.has(parts[0]) || parts.some(p => /^--(output|exec|upload-pack|receive-pack)/.test(p) || p === '-o')) return `Only read-only git commands are allowed here: ${[...allowed].join(', ')}. Use run_command for anything that changes the repository.`;
      if (parts[0] === 'branch' && parts.slice(1).some(p => /^-[dDmMcC]/.test(p))) return 'Changing branches is not allowed in the read-only git tool.';
      const { code, out } = await run('git', ['--no-pager', '-c', 'color.ui=false', ...parts], ws, 30000, c.signal);
      return clip(out.trim() || `(no output, exit code ${code})`);
    }
    case 'web_fetch': {
      let url: URL; try { url = new URL(String(args.url || '')); } catch { return 'Give a full http(s) URL.'; }
      if (!/^https?:$/.test(url.protocol)) return 'Only http and https URLs are supported.';
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?)/.test(url.hostname)) return 'Local and private network addresses are not fetched by this tool.';
      if (c.permission === 'ask' && !await c.confirm(L('Read this web page?', 'Bu web sayfası okunsun mu?'), url.toString(), L('Read', 'Oku'))) return 'The user declined this fetch.';
      try {
        const response = await fetch(url, { redirect: 'follow', signal: c.signal ? AbortSignal.any([c.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { 'user-agent': 'CudeIDE/0.1 (+https://emrevrg.github.io/cude-ide-releases/)', accept: 'text/html,text/plain,application/json,*/*' } });
        const type = response.headers.get('content-type') || '';
        if (!/text|json|xml|javascript/.test(type)) return `The page returned ${type || 'an unknown type'}; only text content is read.`;
        let body = (await response.text()).slice(0, 600000);
        if (/html/.test(type)) body = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n');
        return clip(`HTTP ${response.status} ${url}\n\n${body.trim()}`, 14000);
      } catch (error: any) { return `Fetch failed: ${String(error?.message || error).slice(0, 200)}`; }
    }
    case 'system_info': {
      const versions: string[] = [];
      const probe = async (label: string, cmd: string, a: string[]) => { const r = await run(cmd, a, ws, 8000,c.signal); const line = r.out.split(/\r?\n/).find(Boolean); versions.push(`${label}: ${r.code === 0 && line ? line.trim().slice(0, 120) : 'not found'}`); };
      const windows=process.platform==='win32';
      const probes:Array<[string,string,string[]]>=[
        ['node','node',['--version']],['npm',windows?'npm.cmd':'npm',['--version']],
        ['python',windows?'python':'python3',['--version']],['git','git',['--version']],
        ['java','java',['-version']],['adb',adbPath(),['version']],['gradle',windows?'gradle.bat':'gradle',['--version']],
        ['dotnet','dotnet',['--version']],['go','go',['version']],['rustc','rustc',['--version']],
      ];
      for(let index=0;index<probes.length;index+=2){
        await Promise.all(probes.slice(index,index+2).map(args=>probe(...args)));
        if(c.signal?.aborted)return '[cancelled]';
      }
      let gpu = 'unknown';
      if (process.platform === 'win32') { const r = await run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "; "'], ws, 10000); if (r.code === 0 && r.out.trim()) gpu = r.out.trim(); }
      else { const r = await run('sh', ['-c', 'lspci 2>/dev/null | grep -iE "vga|3d" | head -3'], ws, 8000); if (r.out.trim()) gpu = r.out.trim(); }
      const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader'], ws, 8000);
      const sdk = androidSdkPath();
      return [
        `OS: ${os.type()} ${os.release()} (${os.arch()})`,
        `CPU: ${os.cpus()[0]?.model || 'unknown'} × ${os.cpus().length} threads`,
        `RAM: ${(os.totalmem() / 2 ** 30).toFixed(1)} GB total, ${(os.freemem() / 2 ** 30).toFixed(1)} GB free`,
        `GPU: ${gpu}`, nv.code === 0 ? `NVIDIA: ${nv.out.trim()}` : 'NVIDIA: no nvidia-smi',
        `Android SDK: ${fsSync.existsSync(sdk) ? sdk : 'not found'}`,
        `Workspace disk free: ${await freeSpace(ws)}`,
        ...versions,
      ].join('\n');
    }
    case 'todo': {
      const items = Array.isArray(args.items) ? args.items.slice(0, 30) : [];
      if (!items.length) return 'Give items: [{"text":"...","done":false}].';
      const text = items.map((item: any) => `${item?.done ? '[x]' : '[ ]'} ${String(item?.text || '').slice(0, 160)}`).join('\n');
      c.activity('Plan', text);
      return `Checklist updated:\n${text}`;
    }
    case 'android_devices': {
      const adb = adbPath();
      const devices = await run(adb, ['devices', '-l'], ws, 10000);
      if (devices.code !== 0) return 'adb was not found. Install Android SDK platform-tools or set ANDROID_HOME.';
      const log = await run(adb, ['logcat', '-d', '-t', '200', '*:E'], ws, 15000);
      return clip(`${devices.out.trim()}\n\nRecent errors (logcat *:E, last 200 lines):\n${log.out.trim() || '(none)'}`);
    }
    case 'img2threejs_guide': return SKILL_GUIDE;
    case 'multi_edit': {
      if (!writes) return 'Read-only mode: edits are not allowed.';
      const full = c.inside(args.path), name = rel(ws, full);
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (!edits.length) return 'Give edits: [{"old_text":"...","new_text":"..."}].';
      let text: string; try { text = await fs.readFile(full, 'utf8'); } catch { return `File not found: ${name}`; }
      for (const [i, e] of edits.entries()) {
        const oldText = String(e?.old_text ?? ''); const count = oldText ? text.split(oldText).length - 1 : 0;
        if (count !== 1) return `Edit ${i + 1}: old_text ${count === 0 ? 'was not found exactly' : `appears ${count} times`}. Nothing was changed.`;
        text = text.replace(oldText, () => String(e?.new_text ?? ''));
      }
      if (c.permission === 'ask' && !await c.confirm(L(`Apply ${edits.length} edits to ${name}?`, `${name} dosyasına ${edits.length} düzenleme uygulansın mı?`), text.slice(0, 1500), L('Apply', 'Uygula'))) return 'The user declined these edits.';
      await c.write(full, text); c.activity(`Edited ${name}`, `${edits.length} changes`);
      return `Applied ${edits.length} edits to ${name}. The user can undo with Ctrl+Z.`;
    }
    case 'move_file': {
      if (!writes) return 'Read-only mode: moving files is not allowed.';
      const from = c.inside(args.from), to = c.inside(args.to);
      if (!await c.confirm(L('Move this file?', 'Bu dosya taşınsın mı?'), `${rel(ws, from)} → ${rel(ws, to)}`, L('Move', 'Taşı'))) return 'The user declined the move.';
      const edit = new vscode.WorkspaceEdit(); edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to), { overwrite: false });
      if (!await vscode.workspace.applyEdit(edit)) return 'The editor refused the move (target may exist).';
      return `Moved ${rel(ws, from)} to ${rel(ws, to)}. Imports that pointed to the old path may need updating.`;
    }
    case 'delete_file': {
      if (!writes) return 'Read-only mode: deleting files is not allowed.';
      const full = c.inside(args.path);
      if (!await c.confirm(L('Delete this file?', 'Bu dosya silinsin mi?'), rel(ws, full), L('Delete', 'Sil'))) return 'The user declined the deletion.';
      const edit = new vscode.WorkspaceEdit(); edit.deleteFile(vscode.Uri.file(full), { recursive: false, ignoreIfNotExists: true });
      if (!await vscode.workspace.applyEdit(edit)) return 'The editor refused the deletion.';
      return `Deleted ${rel(ws, full)}. It can be restored with undo (Ctrl+Z) in the explorer.`;
    }
    case 'android_build': {
      if (!writes) return 'Read-only mode: builds are not run.';
      const task = String(args.task || 'assembleDebug');
      if (!/^[A-Za-z:][A-Za-z0-9:_-]{0,80}$/.test(task)) return 'Give a plain Gradle task name such as assembleDebug.';
      const project = await findAndroidRoot(ws);
      if (!project) return 'No Android project (gradlew + settings.gradle) was found in this workspace.';
      const wrapper = path.join(project, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      if (!await c.confirm(L('Run this Android build?', 'Bu Android derlemesi çalıştırılsın mı?'), `${rel(ws, wrapper) || 'gradlew'} ${task}`, L('Build', 'Derle'))) return 'The user declined the build.';
      c.activity('Android build', task);
      const r = await run(wrapper,[task,'--console=plain'],project,20 * 60000,c.signal,{
        ANDROID_HOME:androidSdkPath(), ANDROID_SDK_ROOT:androidSdkPath()
      });
      const out = r.out.split(/\r?\n/);
      const failure = out.findIndex(line => /FAILURE|What went wrong|error:/i.test(line));
      const tail = failure >= 0 ? out.slice(Math.max(0, failure - 5), failure + 60) : out.slice(-60);
      let apk = '';
      if (r.code === 0 && /assemble/i.test(task)) { const found = await vscode.workspace.findFiles(new vscode.RelativePattern(project, '**/build/outputs/apk/**/*.apk'), undefined, 5); apk = found.length ? `\nAPK: ${found.map(f => rel(ws, f.fsPath)).join(', ')}` : ''; }
      return clip(`gradlew ${task} → exit code ${r.code}${apk}\n${tail.join('\n')}`);
    }
    case 'scaffold_threejs': {
      if (!writes) return 'Read-only mode: files are not created.';
      const folder = String(args.folder || 'three-scene').replace(/[^\w.-]/g, '-').slice(0, 60) || 'three-scene';
      const title = String(args.title || 'Cude 3D scene').slice(0, 80);
      const base = c.inside(folder);
      if (fsSync.existsSync(base) && (await fs.readdir(base)).length) return `Folder ${folder} already exists and is not empty.`;
      if (!await c.confirm(L('Create a Three.js project?', 'Three.js projesi oluşturulsun mu?'), `${folder}/ (Vite + Three.js, src/model.ts, src/main.ts)`, L('Create', 'Oluştur'))) return 'The user declined.';
      const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: folder.toLowerCase(), private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { three: '^0.170.0' }, devDependencies: { vite: '^5.4.0', typescript: '^5.6.0', '@types/three': '^0.170.0' } }, null, 2),
        'index.html': `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>\n<style>html,body{margin:0;height:100%;background:#0e0d0c;overflow:hidden}canvas{display:block}</style></head>\n<body><script type="module" src="/src/main.ts"></script></body>\n</html>\n`,
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, lib: ['ES2022', 'DOM'], skipLibCheck: true } }, null, 2),
        'src/model.ts': `import * as THREE from 'three';\n\n/** Procedural model factory (img2threejs method): build from primitives, name the parts, keep pivots at joints. */\nexport function createModel(): THREE.Group {\n  const root = new THREE.Group();\n  root.name = 'model';\n  const material = new THREE.MeshStandardMaterial({ color: 0xd69b70, roughness: 0.45, metalness: 0.1 });\n  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);\n  body.name = 'body';\n  root.add(body);\n  return root;\n}\n`,
        'src/main.ts': `import * as THREE from 'three';\nimport { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';\nimport { createModel } from './model';\n\nconst renderer = new THREE.WebGLRenderer({ antialias: true });\nrenderer.setPixelRatio(Math.min(devicePixelRatio, 2));\nrenderer.setSize(innerWidth, innerHeight);\nrenderer.outputColorSpace = THREE.SRGBColorSpace;\ndocument.body.appendChild(renderer.domElement);\n\nconst scene = new THREE.Scene();\nscene.background = new THREE.Color(0x141210);\nconst camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);\ncamera.position.set(2.5, 2, 3);\nconst controls = new OrbitControls(camera, renderer.domElement);\ncontrols.enableDamping = true;\n\nscene.add(new THREE.HemisphereLight(0xffffff, 0x332211, 1.1));\nconst sun = new THREE.DirectionalLight(0xffffff, 2);\nsun.position.set(3, 5, 2);\nscene.add(sun);\nscene.add(new THREE.GridHelper(10, 20, 0x553322, 0x2a2420));\n\nconst model = createModel();\nscene.add(model);\n\naddEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });\nrenderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });\n`,
        'README.md': `# ${title}\n\nThree.js + Vite project created by Cude.\n\n\`\`\`\nnpm install\nnpm run dev\n\`\`\`\n\nBuild the model in \`src/model.ts\` using the procedural method adapted from [img2threejs](https://github.com/hoainho/img2threejs) (Apache-2.0).\n`,
      };
      for (const [name, content] of Object.entries(files)) await c.write(path.join(base, name), content);
      c.activity('Three.js project', folder);
      return `Created ${folder}/ with Vite + Three.js. Next: run "npm install" and "npm run dev" in ${folder} (use run_command), then build the model in ${folder}/src/model.ts.`;
    }
  }
  return undefined;
}

async function freeSpace(dir: string) {
  try { const s = await (fs as any).statfs(dir); return `${((s.bavail * s.bsize) / 2 ** 30).toFixed(1)} GB`; } catch { return 'unknown'; }
}

export function androidSdkPath(){
  return vscode.workspace.getConfiguration('cude-ai').inspect<string>('android.sdkPath')?.globalValue?.trim() ||
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
}
export function adbPath() {
  const local = path.join(androidSdkPath(), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  return fsSync.existsSync(local) ? local : 'adb';
}

async function findAndroidRoot(ws: string): Promise<string | undefined> {
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const hits = await vscode.workspace.findFiles(new vscode.RelativePattern(ws, `**/${wrapper}`), '**/node_modules/**', 10);
  for (const hit of hits) {
    const dir = path.dirname(hit.fsPath);
    if (['settings.gradle', 'settings.gradle.kts'].some(name => fsSync.existsSync(path.join(dir, name)))) return dir;
  }
  return undefined;
}

#!/usr/bin/env node
// Cude bridge: a stdio MCP server that lets desktop agent apps (Claude Desktop, Cursor, Windsurf, Codex, ...)
// use the tools of a running Cude IDE. It talks to Cude over 127.0.0.1 with a per-session token.
// Edits and commands are always approved by the user inside Cude.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const BRIDGE_FILE = process.env.CUDE_BRIDGE_FILE || path.join(os.homedir(), '.cude-ide', 'bridge.json');
const PROTOCOL = '2025-06-18';

const TOOLS = [
  ['workspace_info', 'Describe the project open in Cude IDE: folder, files overview, open editors and current selection.', {}],
  ['list_files', 'List project files (up to 300).', { path: { type: 'string', description: 'Folder, optional' } }],
  ['read_file', 'Read part of a project file with line numbers.', { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, ['path']],
  ['glob', 'Find files by name pattern such as **/*.ts.', { pattern: { type: 'string' } }, ['pattern']],
  ['grep', 'Fast ripgrep search with optional context lines and file glob.', { pattern: { type: 'string' }, glob: { type: 'string' }, context: { type: 'number' }, case_sensitive: { type: 'boolean' } }, ['pattern']],
  ['diagnostics', 'Compiler and linter errors/warnings that Cude currently sees.', { path: { type: 'string' } }],
  ['symbols', 'Find classes, functions and variables across the project.', { query: { type: 'string' } }, ['query']],
  ['definition', 'Where a symbol at a position is defined.', { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, ['path', 'line', 'character']],
  ['references', 'Every place a symbol at a position is used.', { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, ['path', 'line', 'character']],
  ['git', 'Read-only git: status, diff, log, show, blame, branch.', { args: { type: 'string' } }],
  ['system_info', 'OS, CPU, RAM, GPU and installed toolchains on this PC.', {}],
  ['open_file', 'Open a project file in Cude at a line so the user can see it.', { path: { type: 'string' }, line: { type: 'number' } }, ['path']],
  ['edit_file', 'Replace one exact snippet in a file. The user approves in Cude; undo with Ctrl+Z.', { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']],
  ['multi_edit', 'Several exact edits in one file, all or nothing. User approves in Cude.', { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['old_text', 'new_text'] } } }, ['path', 'edits']],
  ['write_file', 'Create or replace a file. User approves in Cude.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['run_command', 'Run a shell command in the project folder after the user approves it in Cude; returns the output.', { command: { type: 'string' }, timeout_seconds: { type: 'number' } }, ['command']],
  ['android_build', 'Run a Gradle task for the Android project (assembleDebug, installDebug, test, lint). User approves in Cude.', { task: { type: 'string' } }],
  ['list_apps', 'Installed and running desktop apps on this PC; marks apps that can connect over MCP.', { filter: { type: 'string' } }],
  ['list_windows', 'Open windows (id, app, title, position). Computer use must be on in Cude.', {}],
  ['ui_tree', 'Selectable elements (buttons, text boxes, links) of a window with ids e1, e2...', { window: { type: 'string' }, max: { type: 'number' } }],
  ['screen_capture', 'Screenshot of a window or the whole screen (image) plus its UI elements. User approves in Cude.', { window: { type: 'string' } }],
  ['open_app', 'Open a desktop app from the Start menu. User approves in Cude.', { name: { type: 'string' } }, ['name']],
  ['focus_window', 'Bring a window to the front.', { window: { type: 'string' } }, ['window']],
  ['click', 'Click a UI element (element:"e3") or screen point (x,y). User approves in Cude.', { element: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, window: { type: 'string' }, button: { type: 'string' }, double: { type: 'boolean' } }],
  ['type_text', 'Type text into a window or element. Never passwords or card numbers. User approves in Cude.', { text: { type: 'string' }, element: { type: 'string' }, window: { type: 'string' } }, ['text']],
  ['press_keys', 'Press keys or a shortcut such as ctrl+s. User approves in Cude.', { keys: { type: 'string' }, window: { type: 'string' } }, ['keys']],
  ['scroll', 'Scroll an element or point.', { amount: { type: 'number' }, element: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, horizontal: { type: 'boolean' } }],
  ['browser_open', 'Open a page in the isolated Cude browser (its own profile, never the user profile). User approves in Cude.', { url: { type: 'string' }, new_tab: { type: 'boolean' } }, ['url']],
  ['browser_read', 'Text and interactive elements (refs) of the current Cude browser page.', {}],
  ['browser_click', 'Click an element from browser_read by ref.', { ref: { type: 'string' } }, ['ref']],
  ['browser_type', 'Type into a page field by ref. Never passwords or card numbers.', { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']],
  ['browser_screenshot', 'Screenshot of the current Cude browser page (image).', {}],
  ['browser_tabs', 'Tabs of the Cude browser.', { activate: { type: 'string' } }],
  ['browser_close', 'Close the Cude browser.', {}],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}) } }));

function bridge() {
  try { const b = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')); if (b && b.port && b.token) return b; } catch {}
  return undefined;
}

function callCude(tool, args) {
  const b = bridge();
  if (!b) return Promise.resolve({ ok: false, text: 'Cude IDE is not running or its desktop bridge is off. Open Cude IDE and run "Cude: Connect Desktop Apps".' });
  const body = JSON.stringify({ tool, args: args || {} });
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: b.port, path: '/tool', method: 'POST', timeout: 15 * 60 * 1000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + b.token } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; });
      res.on('end', () => { try { const j = JSON.parse(data); resolve({ ok: res.statusCode === 200, text: String(j.text ?? j.error ?? data) }); } catch { resolve({ ok: false, text: data.slice(0, 2000) }); } });
    });
    req.on('error', e => resolve({ ok: false, text: 'Could not reach Cude IDE: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: 'Cude IDE did not answer in time.' }); });
    req.end(body);
  });
}

function send(message) { try { process.stdout.write(JSON.stringify(message) + '\n'); } catch {} }
process.stdout.on('error', () => process.exit(0));

const IMAGE_TOOLS = new Set(['screen_capture', 'browser_screenshot']);

function safeShotFile(raw) {
  const input = String(raw || '').trim();
  if (!input || /^(\\\\|\/\/)/.test(input)) return undefined;
  const candidate = path.resolve(input);
  if (/^(\\\\|\/\/)/.test(candidate)) return undefined;
  const roots = [path.join(os.tmpdir(), 'cude-computer'), path.join(os.tmpdir(), 'cude-browser')].map(p => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  });
  const norm = p => process.platform === 'win32' ? p.toLowerCase() : p;
  try {
    const real = fs.realpathSync(candidate);
    if (/^(\\\\|\/\/)/.test(real)) return undefined;
    if (!fs.statSync(real).isFile()) return undefined;
    const realNorm = norm(real);
    if (!roots.some(root => realNorm.startsWith(norm(root) + path.sep))) return undefined;
    return real;
  } catch { return undefined; }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cude-ide', version: '0.1.0' }, instructions: 'Tools of the Cude IDE window on this PC. Read and search freely; edits and commands are approved by the user inside Cude.' } });
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some(t => t.name === name)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool ' + name } });
    const r = await callCude(name, params?.arguments);
    const content = [{ type: 'text', text: r.text }];
    // Screenshots: attach the PNG so image-capable apps (Claude Desktop, Cursor...) can see it. Only for screenshot tools and Cude's own temp shot folders (symlinks/UNC blocked).
    if (IMAGE_TOOLS.has(name)) {
      for (const m of String(r.text).matchAll(/\[image: ([^\]\r\n]+\.png)\]/g)) {
        const file = safeShotFile(m[1]);
        if (!file) continue;
        try { const data = fs.readFileSync(file); if (data.length < 8 * 1024 * 1024) content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }); } catch {}
      }
    }
    return send({ jsonrpc: '2.0', id, result: { content, isError: !r.ok } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    Promise.resolve(handle(msg)).catch(e => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message || e) } }); });
  }
});
process.stdin.on('end', () => process.exit(0));

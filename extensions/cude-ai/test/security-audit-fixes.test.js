const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');

const cu = require('../out/computerUse.js');
const bc = require('../out/browserControl.js');
const { writeBridgeConfig } = require('../out/desktopBridgeConfig.js');
const { OpencodeServer } = require('../out/opencodeServer.js');

function loadWithVscodeMock(modulePath, vscodeMock, extraMocks = {}) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const origLoad = Module._load;
  try {
    Module._load = function (id, ...args) {
      if (id === 'vscode') return vscodeMock;
      if (Object.prototype.hasOwnProperty.call(extraMocks, id)) return extraMocks[id];
      return origLoad.call(this, id, ...args);
    };
    return require(resolved);
  } finally {
    Module._load = origLoad;
  }
}

// 1. Onaysiz eylem
test('1. stopped computer use stays stopped on subsequent runComputerTool calls until user resumes', async () => {
  if (process.platform !== 'win32') return;
  const vscodeMock = {
    workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'computer.enabled' ? true : d) }) },
    window: { showWarningMessage: async () => undefined },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  };
  const appBridge = loadWithVscodeMock('../out/appBridge.js', vscodeMock, { './desktopBridge': { mcpTargets: () => [] } });
  appBridge.getComputer();
  appBridge.stopComputer();
  const out = await appBridge.runComputerTool('list_windows', {}, true);
  assert.match(out, /stopped|durdurdu/i);
  appBridge.getComputer().dispose();
});

test('1. scroll re-verifies target window under point after focus and refuses if protected or changed', async () => {
  if (process.platform !== 'win32') return;
  const log = [];
  let targetCalls = 0;
  const notepad = { id: 10, process: 'notepad', title: 'Doc', pid: 101, x: 0, y: 0, width: 800, height: 600, pointX: 50, pointY: 50 };
  const keepass = { id: 20, process: 'keepass', title: 'Vault', pid: 202, x: 0, y: 0, width: 800, height: 600, pointX: 50, pointY: 50 };
  const driver = {
    async call(op) {
      log.push(op);
      if (op === 'target') return ++targetCalls === 1 ? notepad : keepass;
      if (op === 'focus') return true;
      return true;
    },
    dispose() {},
  };
  const c = new cu.ComputerUse({ driver, approver: async () => 'once', settings: () => ({ enabled: true, allowedApps: [] }), language: () => 'en' });
  const out = await c.scroll({ x: 50, y: 50, amount: -3 });
  assert.match(out, /could not be brought to the front/i);
  assert.ok(!log.includes('scroll'), 'scroll must not run when target changed after focus');
  c.dispose();
});

// 2. Parola ve kart sizintisi
test('2. pressKeys blocks text-like keys and shift+insert on password or sensitive-named fields', async () => {
  assert.equal(cu.comboTypesText(cu.parseKeys('shift+insert')[0]), true, 'shift+insert is paste');
  if (process.platform !== 'win32') return;
  const log = [];
  const win = { id: 7, process: 'notepad', title: 'Login', pid: 99, x: 0, y: 0, width: 800, height: 600 };
  let targetInfo = { ...win, password: true, elementName: 'Input' };
  const driver = {
    async call(op) {
      log.push(op);
      if (op === 'windows') return [win];
      if (op === 'target') return targetInfo;
      return true;
    },
    dispose() {},
  };
  const c = new cu.ComputerUse({ driver, approver: async () => 'session', settings: () => ({ enabled: true, allowedApps: [] }), language: () => 'en' });
  assert.match(await c.pressKeys({ keys: 'ctrl+v', window: 'notepad' }), /password/i);
  assert.match(await c.pressKeys({ keys: 'shift+insert', window: 'notepad' }), /password/i);
  targetInfo = { ...win, password: false, elementName: 'CVV' };
  assert.match(await c.pressKeys({ keys: '1,2,3', window: 'notepad' }), /password/i);
  assert.ok(!log.includes('keys'), 'keys must never be sent to password/sensitive fields');
  c.dispose();
});

test('2. formatElements redacts values of sensitive-named and card-containing fields', () => {
  const out = cu.ComputerUse.formatElements([
    { id: 'e1', type: 'Edit', name: 'CVV', x: 0, y: 0, width: 10, height: 10, value: '987' },
    { id: 'e2', type: 'Edit', name: 'Notes', automationId: 'api_key_input', x: 0, y: 0, width: 10, height: 10, value: 'sk-live-secret' },
    { id: 'e3', type: 'Edit', name: 'Comment', x: 0, y: 0, width: 10, height: 10, value: '4111 1111 1111 1111' },
    { id: 'e4', type: 'Edit', name: 'Title', x: 0, y: 0, width: 10, height: 10, value: 'Hello world' },
  ]);
  assert.ok(!out.includes('987'));
  assert.ok(!out.includes('sk-live-secret'));
  assert.ok(!out.includes('4111 1111 1111 1111'));
  assert.ok(out.includes('value="Hello world"'));
});

test('2. browser fieldRefusal blocks multi-token HTML5 autocomplete attributes', () => {
  assert.equal(bc.fieldRefusal({ type: 'text', autocomplete: 'billing cc-number' }, 'hello'), 'password');
  assert.equal(bc.fieldRefusal({ type: 'text', autocomplete: 'section-1 current-password' }, 'hello'), 'password');
  assert.equal(bc.fieldRefusal({ type: 'text', autocomplete: 'shipping one-time-code' }, '123456'), 'password');
});

// 3. Yol kacisi
test('3. desktopBridge resolveWorkspaceFile blocks traversal, cross-drive, UNC and outward symlinks/junctions', async () => {
  const root = await fsp.mkdtemp(path.join(process.cwd(), 'dist', 'ws-path-'));
  const ws = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  await fsp.mkdir(ws, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  const insideFile = path.join(ws, 'ok.txt');
  const outsideFile = path.join(outside, 'secret.txt');
  await fsp.writeFile(insideFile, 'ok');
  await fsp.writeFile(outsideFile, 'secret');
  const linkDir = path.join(ws, 'escape-dir');
  try {
    await fsp.symlink(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* ignore if unsupported */ }

  const bridge = loadWithVscodeMock('../out/desktopBridge.js', {});
  try {
    assert.equal(await bridge.resolveWorkspaceFile(ws, 'ok.txt'), await fsp.realpath(insideFile));
    assert.equal(await bridge.resolveWorkspaceFile(ws, '../outside/secret.txt'), undefined);
    assert.equal(await bridge.resolveWorkspaceFile(ws, '\\\\attacker\\share\\secret.txt'), undefined);
    assert.equal(await bridge.resolveWorkspaceFile(ws, '//attacker/share/secret.txt'), undefined);
    if (process.platform === 'win32') {
      const otherDrive = ws.toLowerCase().startsWith('c:') ? 'D:\\secret.txt' : 'C:\\Windows\\win.ini';
      assert.equal(await bridge.resolveWorkspaceFile(ws, otherDrive), undefined);
    }
    if (fs.existsSync(linkDir)) {
      assert.equal(await bridge.resolveWorkspaceFile(ws, path.join('escape-dir', 'secret.txt')), undefined);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('3. extractImagePaths and cude-mcp.js block UNC, outside paths, outward symlinks and non-screenshot tools', async () => {
  const shotDir = path.join(os.tmpdir(), 'cude-computer');
  const outsideDir = await fsp.mkdtemp(path.join(process.cwd(), 'dist', 'img-out-'));
  await fsp.mkdir(shotDir, { recursive: true });
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const goodShot = path.join(shotDir, `audit-test-${process.pid}-${Date.now()}.png`);
  const outsidePng = path.join(outsideDir, 'secret.png');
  const linkDir = path.join(shotDir, `audit-link-${process.pid}-${Date.now()}`);
  await fsp.writeFile(goodShot, pngBytes);
  await fsp.writeFile(outsidePng, pngBytes);
  let hasLink = false;
  try {
    await fsp.symlink(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    hasLink = true;
  } catch { /* ignore */ }

  try {
    const obs = [
      `[image: ${goodShot}]`,
      `[image: ${outsidePng}]`,
      `[image: \\\\attacker\\share\\evil.png]`,
      `[image: ${path.join(shotDir, '..', 'outside.png')}]`,
      ...(hasLink ? [`[image: ${path.join(linkDir, 'secret.png')}]`] : []),
    ].join('\n');
    const extracted = cu.extractImagePaths(obs);
    assert.deepEqual(extracted, [fs.realpathSync(goodShot)]);

    // Verify cude-mcp.js restricts image attachment to screenshot tools and safe paths
    const token = 'c'.repeat(48);
    let replyText = '';
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: replyText }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const bridgeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cude-mcp-sec-'));
    const bridgeFile = path.join(bridgeDir, 'bridge.json');
    await fsp.writeFile(bridgeFile, JSON.stringify({ port: server.address().port, token }));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'media', 'bridge', 'cude-mcp.js')], { env: { ...process.env, CUDE_BRIDGE_FILE: bridgeFile } });
    let buf = ''; const waiting = new Map(); let seq = 0;
    child.stdout.on('data', chunk => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(msg.id)?.(msg); }
    });
    const call = (method, params) => new Promise(resolve => { const id = ++seq; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
      replyText = `[image: ${goodShot}]`;
      const readRes = await call('tools/call', { name: 'read_file', arguments: { path: 'x.txt' } });
      assert.equal(readRes.result.content.filter(c => c.type === 'image').length, 0, 'read_file must not attach images');
      const shotRes = await call('tools/call', { name: 'screen_capture', arguments: {} });
      assert.equal(shotRes.result.content.filter(c => c.type === 'image').length, 1, 'screen_capture attaches safe temp PNG');
      replyText = `[image: ${outsidePng}]\n[image: \\\\attacker\\share\\x.png]` + (hasLink ? `\n[image: ${path.join(linkDir, 'secret.png')}]` : '');
      const badRes = await call('tools/call', { name: 'screen_capture', arguments: {} });
      assert.equal(badRes.result.content.filter(c => c.type === 'image').length, 0, 'outside/UNC/symlink images must never be attached');
    } finally {
      child.kill(); server.close();
      await fsp.rm(bridgeDir, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(goodShot, { force: true });
    if (hasLink) await fsp.rm(linkDir, { recursive: true, force: true });
    await fsp.rm(outsideDir, { recursive: true, force: true });
  }
});

// 4. Komut enjeksiyonu
test('4. launchAppCommand avoids cmd.exe and isolates shortcut metacharacters in env', () => {
  const appBridge = loadWithVscodeMock('../out/appBridge.js', { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } }, { './desktopBridge': { mcpTargets: () => [] } });
  const exeSpec = appBridge.launchAppCommand('C:\\Windows\\System32\\notepad.exe');
  assert.equal(exeSpec.command, 'C:\\Windows\\System32\\notepad.exe');
  assert.deepEqual(exeSpec.args, []);
  const evilShortcut = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\App & calc | whoami %TEMP%.lnk';
  const lnkSpec = appBridge.launchAppCommand(evilShortcut);
  assert.ok(!/cmd\.exe/i.test(lnkSpec.command), 'must never use cmd.exe');
  assert.ok(!lnkSpec.args.some(a => a.includes('calc') || a.includes('whoami')), 'shortcut path must not be interpolated into args');
  assert.equal(lnkSpec.env.CUDE_OPEN_TARGET, evilShortcut);
});

// 5. Yerel sunucular
test('5. desktopBridge rejects Origin header, non-loopback Host header and bad tokens', async () => {
  const tmpHome = await fsp.mkdtemp(path.join(process.cwd(), 'dist', 'bridge-home-'));
  const osMock = { ...os, homedir: () => tmpHome };
  const vscodeMock = {
    workspace: { workspaceFolders: [{ uri: { fsPath: tmpHome } }], isTrusted: true, getConfiguration: () => ({ get: (_k, d) => d }) },
    window: { visibleTextEditors: [], activeTextEditor: undefined },
  };
  const bridge = loadWithVscodeMock('../out/desktopBridge.js', vscodeMock, { 'node:os': osMock });
  const subs = [];
  try {
    await bridge.startBridge({ subscriptions: subs });
    const info = JSON.parse(await fsp.readFile(bridge.BRIDGE_FILE, 'utf8'));
    assert.ok(info.token.length >= 48);
    const post = (headers) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ tool: 'workspace_info', args: {} });
      const req = http.request({ host: '127.0.0.1', port: info.port, path: '/tool', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
        let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal((await post({ authorization: 'Bearer ' + info.token, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ authorization: 'Bearer ' + info.token, host: 'evil.example:9999' })).status, 403);
    assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({ authorization: 'Bearer ' + info.token })).status, 200);
    bridge.stopBridge();
    assert.equal(bridge.desktopBridgeActive(), false);
  } finally {
    bridge.stopBridge();
    await fsp.rm(tmpHome, { recursive: true, force: true });
  }
});

// 6. Kaynak sizintisi
test('6. CudeBrowser close({ force: true }) and dispose() clean up even when browser.enabled is false', async () => {
  let enabled = true;
  let closedViaCdp = false;
  let socketClosed = false;
  const fakeConn = {
    closed: false,
    async send(method) { if (method === 'Browser.close') closedViaCdp = true; return {}; },
    close() { this.closed = true; socketClosed = true; },
  };
  const profileDir = path.join(os.tmpdir(), 'cude', `browser-leak-test-${process.pid}-${Date.now()}`);
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.writeFile(path.join(profileDir, 'DevToolsActivePort'), '9222\n/devtools/browser/test');
  try {
    const b = new bc.CudeBrowser({
      approver: async () => 'once',
      settings: () => ({ enabled }),
      profileDir,
      fetchJson: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test' }),
      connect: async () => fakeConn,
    });
    enabled = false;
    assert.match(await b.close({}), /turned off/i);
    assert.equal(closedViaCdp, false);
    const msg = await b.close({ force: true });
    assert.match(msg, /closed/i);
    assert.equal(closedViaCdp, true);
    assert.equal(socketClosed, true);
    assert.equal(b.running, false);
    b.dispose();
  } finally {
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
});

// 7. Ayar dosyasi bozulmasi
test('7. writeBridgeConfig serializes concurrent writes atomically without corruption or leftover temp files', async () => {
  const dir = await fsp.mkdtemp(path.join(process.cwd(), 'dist', 'mcp-race-'));
  const file = path.join(dir, 'mcp.json');
  const target = { id: 'fixture', label: 'Fixture', file };
  await fsp.writeFile(file, '{"mcpServers":{"other":{"command":"x"}}}');
  try {
    const writes = [];
    for (let i = 0; i < 8; i++) {
      writes.push(writeBridgeConfig(target, { command: 'C:\\Cude.exe', args: [`v${i}.js`], env: { ELECTRON_RUN_AS_NODE: '1' } }));
    }
    await Promise.all(writes);
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(parsed.mcpServers.other.command, 'x');
    assert.deepEqual(parsed.mcpServers['cude-ide'].args, ['v7.js']);
    const backup = JSON.parse(await fsp.readFile(file + '.cude-backup', 'utf8'));
    assert.equal(backup.mcpServers.other.command, 'x');
    const files = await fsp.readdir(dir);
    assert.ok(!files.some(f => f.includes('.cude-tmp-')), 'no leftover temp files');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// 8. Hata yonetimi
test('8. CudeBrowser.ensureRunning handles spawn error cleanly without uncaught exception', async () => {
  const profileDir = path.join(os.tmpdir(), 'cude', `browser-err-test-${process.pid}-${Date.now()}`);
  try {
    const b = new bc.CudeBrowser({
      approver: async () => 'once',
      settings: () => ({ enabled: true }),
      profileDir,
      executable: path.join(profileDir, 'does-not-exist-browser.exe'),
    });
    const out = await b.open({ url: 'https://example.com' });
    assert.match(out, /Browser error:/i);
    b.dispose();
  } finally {
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
});

test('8. OpencodeServer.chat handles non-JSON HTTP error from /session cleanly and stops cleanly', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const oc = new OpencodeServer(
    () => ({ command: process.execPath, args: ['-e', `console.log('listening on http://127.0.0.1:${port}'); setInterval(() => {}, 10000);`] }),
    () => process.cwd()
  );
  try {
    await assert.rejects(oc.chat('openai/gpt-5', [{ role: 'user', content: 'hi' }]), /OpenCode 500/);
  } finally {
    oc.stop();
    server.close();
  }
});

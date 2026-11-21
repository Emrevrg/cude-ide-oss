const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function rpc(child) {
  let buffer = ''; const waiting = new Map();
  child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); } });
  let id = 0;
  return (method, params) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
}

test('Cude MCP bridge: initialize, list tools, call a tool through the local bridge, reject bad tokens', async () => {
  const token = 'a'.repeat(48);
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      const { tool, args } = JSON.parse(body); seen.push(tool);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: `ran ${tool} ${JSON.stringify(args)}` }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cude-bridge-'));
  const file = path.join(dir, 'bridge.json');
  fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'media', 'bridge', 'cude-mcp.js')], { env: { ...process.env, CUDE_BRIDGE_FILE: file } });
  const call = rpc(child);
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'cude-ide');
    const list = await call('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ['read_file', 'grep', 'diagnostics', 'edit_file', 'run_command', 'android_build']) assert.ok(names.includes(n), n);
    const ok = await call('tools/call', { name: 'grep', arguments: { pattern: 'TODO' } });
    assert.equal(ok.result.isError, false);
    assert.match(ok.result.content[0].text, /ran grep/);
    const unknown = await call('tools/call', { name: 'format_disk', arguments: {} });
    assert.ok(unknown.error);
    fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token: 'b'.repeat(48) }));
    const denied = await call('tools/call', { name: 'read_file', arguments: { path: 'a' } });
    assert.equal(denied.result.isError, true);
    fs.unlinkSync(file);
    const off = await call('tools/call', { name: 'read_file', arguments: { path: 'a' } });
    assert.match(off.result.content[0].text, /not running|bridge is off/);
    assert.deepEqual(seen, ['grep']);
  } finally { child.kill(); server.close(); }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');

const vscode = {
  workspace: { isTrusted: true, workspaceFolders: [] },
  window: {},
};
const extensionPath = path.join(__dirname, '..', 'out', 'extension.js');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { mcpCall } = require(extensionPath);
Module._load = originalLoad;

test('MCP calls run through the UI approval gate and return tool output', async () => {
  const testRoot = process.env.CUDE_TEST_TMP || 'E:\\rust\\tmp';
  fs.mkdirSync(testRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(testRoot, 'cude-mcp-integration-'));
  const cudeDir = path.join(workspace, '.cude');
  fs.mkdirSync(cudeDir, { recursive: true });
  const events = [];
  let confirmed = false;
  let cancelNextCall = false;
  let quickPickCount = 0;
  let displayed = '';
  let stdioTimeline = '';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    events.push(message.method);
    res.setHeader('Content-Type', 'application/json');
    if (message.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (message.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'integration-session');
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'integration', version: '1' } } }));
    }
    if (message.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }));
    if (message.method === 'tools/call') {
      assert.equal(confirmed, true, 'the tool call must follow the explicit UI confirmation');
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `MCP integration verified: ${message.params.arguments.text}` }] } }));
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fs.writeFileSync(path.join(cudeDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'local-test': { url: `http://127.0.0.1:${address.port}/mcp` } } }));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
  vscode.window.showQuickPick = async items => { quickPickCount++; return quickPickCount % 2 ? { label: 'local-test' } : { label: items[0].label }; };
  vscode.window.showInputBox = async () => '{"text":"approved local call"}';
  vscode.window.showWarningMessage = async message => {
    if (String(message).startsWith('Connect to configured MCP server?')) { events.push('connect-approval'); return 'Connect once'; }
    if (String(message).startsWith('Start configured MCP process?')) { events.push('start-approval'); if (stdioTimeline) fs.appendFileSync(stdioTimeline, 'start-approval\n'); return 'Start once'; }
    events.push('approval'); if (stdioTimeline) fs.appendFileSync(stdioTimeline, 'approval\n'); confirmed = !cancelNextCall; return confirmed ? 'Run once' : undefined;
  };
  vscode.workspace.openTextDocument = async document => document;
  vscode.window.showTextDocument = async document => { displayed = document.content; };

  try {
    await mcpCall();
    assert.match(displayed, /MCP integration verified: approved local call/);
    assert.ok(events.indexOf('connect-approval') < events.indexOf('initialize'));
    assert.ok(events.indexOf('approval') < events.indexOf('tools/call'));
    assert.equal(events.filter(event => event === 'tools/call').length, 1);

    confirmed = false;
    cancelNextCall = true;
    quickPickCount = 0;
    events.length = 0;
    displayed = '';
    await mcpCall();
    assert.equal(events.includes('tools/call'), false, 'cancelling approval must prevent execution');
    assert.equal(displayed, '');

    const stdioFile = path.join(cudeDir, 'server.cjs');
    stdioTimeline = path.join(cudeDir, 'stdio-timeline.txt');
    fs.writeFileSync(stdioFile, `const fs=require('node:fs');const log=${JSON.stringify(stdioTimeline)};let b=Buffer.alloc(0);const send=m=>{const s=JSON.stringify(m);process.stdout.write('Content-Length: '+Buffer.byteLength(s)+'\\r\\n\\r\\n'+s)};process.stdin.on('data',c=>{b=Buffer.concat([b,c]);while(true){const i=b.indexOf('\\r\\n\\r\\n');if(i<0)break;const n=Number(b.subarray(0,i).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]);if(!n||b.length<i+4+n)break;const m=JSON.parse(b.subarray(i+4,i+4+n).toString());b=b.subarray(i+4+n);if(!m.id)continue;fs.appendFileSync(log,m.method+'\\n');if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'stdio-test',version:'1'}}});else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',description:'Echo input'}]}});else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'stdio integration verified: '+m.params.arguments.text}]}});}});`);
    fs.writeFileSync(path.join(cudeDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'local-test': { command: process.execPath, args: [stdioFile], framing: 'content-length' } } }));
    confirmed = false;
    cancelNextCall = false;
    quickPickCount = 0;
    events.length = 0;
    displayed = '';
    await mcpCall();
    assert.match(displayed, /stdio integration verified: approved local call/);
    const timeline = fs.readFileSync(stdioTimeline, 'utf8').trim().split(/\r?\n/);
    const toolCallIndex = timeline.indexOf('tools/call');
    assert.ok(timeline.indexOf('start-approval') < timeline.indexOf('initialize'), 'confirm before starting the stdio process');
    assert.ok(timeline.lastIndexOf('approval') < toolCallIndex, 'confirm the tool call after reviewing its arguments');
    assert.equal(timeline.filter(event => event === 'tools/call').length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(workspace);
    const tmpRoot = path.resolve(testRoot);
    assert.ok(resolved.startsWith(tmpRoot + path.sep), 'only remove this test-owned folder under the E: temporary root');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

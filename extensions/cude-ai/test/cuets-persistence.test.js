const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runCuetsLoop } = require('../out/cuets');
const { t } = require('../out/i18n');
const label = (key, values) => t(key, 'en', values);
let cliReply;
const vscode = {
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => key === 'language' ? 'en' : fallback }) },
  window: { showTextDocument: async () => {}, showWarningMessage: async (_text, _opts, allow) => allow },
  env: { language: 'en' },
  Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }), parse: value => ({ toString: () => value }) },
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
  Range: class {}, EndOfLine: { LF: 1, CRLF: 2 },
  WorkspaceEdit: class {
    constructor() { this.ops = []; }
    createFile(uri) { this.ops.push({ kind: 'create', uri }); }
    insert(uri, _position, text) { this.ops.push({ kind: 'write', uri, text }); }
    replace(uri, _range, text) { this.ops.push({ kind: 'write', uri, text }); }
  },
};
const originalLoad = Module._load;
let extension;
try {
  Module._load = function(id, ...args) {
    if (id === 'vscode') return vscode;
    const value = originalLoad.call(this, id, ...args);
    if (id !== 'node:child_process') return value;
    return { ...value, spawn: (_command, args, options) => {
      assert.equal(options.shell, false);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      setImmediate(() => { child.stdout.end(cliReply(args.at(-1))); child.stderr.end(); child.emit('exit', 0); child.emit('close', 0); });
      return child;
    } };
  };
  extension = require('../out/extension');
} finally { Module._load = originalLoad; }

async function fixture(permission = 'auto', saveFails = false) {
  const base = path.resolve('dist');
  const directory = await fs.mkdtemp(path.join(base, 'cuets-persist-'));
  const docs = new Map(), saved = [], events = [];
  const makeDoc = (uri, text) => ({ uri, text, version: 1, eol: 1, isDirty: false,
    getText() { return this.text; }, positionAt() { return {}; },
    async save() {
      if (saveFails) return false;
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, this.text); this.isDirty = false; saved.push(uri.fsPath); return true;
    },
  });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: directory } }];
  vscode.workspace.openTextDocument = async uri => {
    if (!docs.has(uri.fsPath)) docs.set(uri.fsPath, makeDoc(uri, await fs.readFile(uri.fsPath, 'utf8')));
    return docs.get(uri.fsPath);
  };
  // Faithful buffer-only edits: only doc.save() writes proposed content to disk.
  vscode.workspace.applyEdit = async edit => {
    for (const op of edit.ops) {
      if (op.kind === 'create') docs.set(op.uri.fsPath, makeDoc(op.uri, ''));
      else { const doc = await vscode.workspace.openTextDocument(op.uri); doc.text = op.text; doc.isDirty = true; doc.version++; }
    }
    return true;
  };
  const state = { get: (key, fallback) => key === 'permission' ? permission : fallback, update: async () => {} };
  const view = new extension.CudeChatView({ workspaceState: state }, { setModelRefresh() {} }, { update: async () => {} }, {});
  view.webview = { postMessage: event => events.push(event) };
  const agent = { id: 'weather', steps: [] };
  return { directory, docs, saved, view, agent, events, async clean() {
    assert.ok(directory.startsWith(base + path.sep)); await fs.rm(directory, { recursive: true, force: true });
    vscode.workspace.workspaceFolders = [];
  } };
}
const files = [
  { title: 'HTML', kind: 'file', path: 'index.html', content: '<link rel="stylesheet" href="style.css"><script src="app.js"></script>' },
  { title: 'CSS', kind: 'file', path: 'style.css', content: 'body { color: navy; }' },
  { title: 'JS', kind: 'file', path: 'app.js', content: 'console.log("weather");' },
];
const round = { round: 1, items: [], workers: [] };

test('Cuets CLI weather panel saves existing HTML and new CSS/JS without a project test command', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'index.html'), '<p>before</p>');
    const unrelated = path.join(f.directory, 'notes.txt'); await fs.writeFile(unrelated, 'disk');
    const dirty = await vscode.workspace.openTextDocument(vscode.Uri.file(unrelated)); dirty.text = 'unsaved user text'; dirty.isDirty = true;
    let repaired = false;
    cliReply = prompt => {
      if (prompt.includes('Cuets planner')) return JSON.stringify({ subtasks: [{ title: 'Weather', instruction: 'Create index.html, style.css and app.js' }] });
      if (prompt.includes('Cuets reviewer for a long-running')) {
        for (const file of files) assert.equal(f.docs.get(path.join(f.directory, file.path)).isDirty, false);
        return JSON.stringify({ items: [{ id: '1', status: 'done' }] });
      }
      if (!repaired) { repaired = true; return 'Here is the weather panel (no machine-readable file proposals).'; }
      assert.match(prompt, /could not be applied/);
      return JSON.stringify({ summary: 'Three weather files proposed', steps: files });
    };
    const result = await runCuetsLoop({ goal: 'Build a weather panel', id: 'weather-1', mode: 'execute', label, concurrency: 1,
      chat: (messages, signal) => extension.runLocalCli({ id: 'cursor-agent', label: 'Fixture CLI', path: process.execPath }, messages.map(m => m.content).join('\n'), 'full', signal),
      context: async () => '', verificationAvailable: false, save: async () => {},
      applySteps: steps => f.view.applyCuetsRound(f.agent, 'weather-1', f.directory, steps, round, new AbortController().signal, () => undefined),
    });
    assert.equal(result.stopReason, 'completeUnverified');
    for (const file of files) assert.equal(await fs.readFile(path.join(f.directory, file.path), 'utf8'), file.content);
    assert.equal(f.saved.length, 3); assert.equal(await fs.readFile(unrelated, 'utf8'), 'disk'); assert.equal(dirty.isDirty, true);
  } finally { await f.clean(); }
});

test('Cuets reports save failure and does not count buffer-only changes as applied', async () => {
  const f = await fixture('auto', true);
  try {
    const result = await f.view.applyCuetsRound(f.agent, 'weather-1', f.directory, files, round, new AbortController().signal, () => undefined);
    assert.equal(result.applied, 0); assert.match(result.failed.join('\n'), /could not be saved/);
    assert.ok(!f.events.some(event => event.type === 'changes'));
  } finally { await f.clean(); }
});

test('Cuets OpenCode server chat applies proposals through the same disk persistence path', async () => {
  const http = require('node:http');
  const { OpencodeServer } = require('../out/opencodeServer');
  const f = await fixture('full');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/session') { res.end(JSON.stringify({ id: 'fixture' })); return; }
    if (req.url === '/session/fixture/message') {
      const message = JSON.parse(body); requests.push(message);
      assert.equal(message.agent, 'plan'); assert.deepEqual(message.tools, {});
      assert.deepEqual(message.model, { providerID: 'fixture', modelID: 'weather' });
      const text = message.system.includes('Cuets planner') ? JSON.stringify({ subtasks: [{ title: 'Weather', instruction: 'Create three weather files' }] }) : message.system.includes('ONE checklist item') ? JSON.stringify({ summary: 'Three files proposed', steps: files }) : JSON.stringify({ items: [{ id: '1', status: 'done' }] });
      res.end(JSON.stringify({ parts: [{ type: 'text', text }] })); return;
    }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = new OpencodeServer(() => { throw new Error('No real process allowed'); }, () => f.directory);
  bridge.ensure = async () => `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runCuetsLoop({ goal: 'Build weather panel', id: 'weather-1', mode: 'execute', label, concurrency: 1,
      context: async () => '', verificationAvailable: false, save: async () => {},
      chat: (messages, signal) => bridge.chat('fixture/weather', messages, signal),
      applySteps: steps => f.view.applyCuetsRound(f.agent, 'weather-1', f.directory, steps, round, new AbortController().signal, () => undefined),
    });
    assert.equal(result.stopReason, 'completeUnverified'); assert.equal(requests.length, 3);
    for (const file of files) assert.equal(await fs.readFile(path.join(f.directory, file.path), 'utf8'), file.content);
  } finally { bridge.stop(); await new Promise(resolve => server.close(resolve)); await f.clean(); }
});

test('Cuets Ask persists only after acceptance; Plan leaves files untouched', async () => {
  const f = await fixture('ask');
  try {
    const waiting = f.view.applyCuetsRound(f.agent, 'weather-1', f.directory, files, round, new AbortController().signal, () => undefined);
    while (!f.view.cuetsWait) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.saved.length, 0);
    const staged = await f.view.stageFile(files[0].path, files[0].content, f.directory);
    await f.view.applyStaged([staged.id]);
    assert.equal(await fs.readFile(path.join(f.directory, 'index.html'), 'utf8'), files[0].content);
    f.view.noteCuetsDecision(['style.css', 'app.js'], false);
    const applied = await waiting; assert.equal(applied.applied, 1); assert.equal(applied.pending, 2);
  } finally { await f.clean(); }
  const plan = await fixture('plan');
  try { assert.equal((await plan.view.applyCuetsRound(plan.agent, 'weather-1', plan.directory, files, round, new AbortController().signal, () => undefined)).applied, 0); assert.equal(plan.saved.length, 0); }
  finally { await plan.clean(); }
});

test('Cuets reviewer cannot complete rejected or unsaved proposals', async () => {
  for (const applied of [{ applied: 0, failed: ['save failed'] }, { applied: 0, failed: [], pending: 3 }]) {
    const result = await runCuetsLoop({ goal: 'Weather', id: 'weather-1', mode: 'execute', label, verificationAvailable: false,
      context: async () => '', save: async () => {}, applySteps: async () => applied,
      chat: async messages => messages[0].content.includes('planner') ? JSON.stringify({ subtasks: [{ title: 'Weather', instruction: 'Build it' }] }) : messages[0].content.includes('ONE checklist item') ? JSON.stringify({ summary: 'Proposed', steps: files }) : JSON.stringify({ items: [{ id: '1', status: 'done' }] }),
    });
    assert.equal(result.stopReason, 'noProgress'); assert.equal(result.state.checklist[0].status, 'pending');
  }
});

test('Cuets invalid CLI proposals fail after one repair and never become successful no-change work', async () => {
  let workers = 0, applies = 0;
  const result = await runCuetsLoop({ goal: 'Weather', id: 'weather-1', mode: 'execute', label, verificationAvailable: false,
    context: async () => '', save: async () => {}, applySteps: async () => { applies++; return { applied: 0, failed: [] }; },
    chat: async messages => {
      if (messages[0].content.includes('planner')) return JSON.stringify({ subtasks: [{ title: 'Weather', instruction: 'Build it' }] });
      workers++; return JSON.stringify({ summary: 'done', steps: [{ title: 'Missing file contents', kind: 'file', path: 'app.js' }] });
    },
  });
  assert.equal(result.stopReason, 'noProgress'); assert.equal(workers, 4); assert.equal(applies, 0);
  assert.notEqual(result.state.checklist[0].status, 'done');
});

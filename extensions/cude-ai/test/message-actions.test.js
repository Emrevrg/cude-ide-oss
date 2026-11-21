const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load() {
  const cfg = { get: (_k, f) => f, inspect: () => undefined, update: async () => {} };
  const stub = new Proxy(function () {}, { get: (_t, k) => k === 'then' ? undefined : stub, apply: () => stub });
  const vscode = new Proxy({ workspace: { getConfiguration: () => cfg, isTrusted: true, workspaceFolders: [] }, env: { language: 'en', clipboard: { writeText: async t => { vscode.__copied = t; } } }, window: { setStatusBarMessage: () => ({}) } }, { get: (t, k) => k in t ? t[k] : stub });
  const l = Module._load;
  try { Module._load = function (id, ...a) { return id === 'vscode' ? vscode : l.call(this, id, ...a); }; delete require.cache[require.resolve('../out/extension')]; return { ext: require('../out/extension'), vscode }; }
  finally { Module._load = l; }
}

function view(conversation) {
  const posted = [];
  return { posted, self: { conversation: conversation.map(m => ({ ...m })), conversationId: 'chat-a', request: undefined, saveConversation: async () => {}, webview: { postMessage: m => { posted.push(m); return Promise.resolve(true); } } } };
}
const convo = [
  { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'Attached context: a.ts' },
  { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' },
  { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' },
];

test('edit/retry rewinds the conversation to just before the chosen user turn (counted from the end)', async () => {
  const { ext } = load();
  const v = view(convo);
  await ext.CudeChatView.prototype.handle.call(v.self, { type: 'rewind', fromEnd: 2 });
  assert.deepEqual(v.self.conversation.map(m => m.content), ['first question', 'first answer', 'Attached context: a.ts']);
});

test('branch with the reply keeps everything up to that answer in a new chat; branch from a question refills the composer', async () => {
  const { ext } = load();
  const a = view(convo);
  await ext.CudeChatView.prototype.handle.call(a.self, { type: 'branch', fromEnd: 2, includeReply: true });
  assert.notEqual(a.self.conversationId, 'chat-a');
  assert.deepEqual(a.self.conversation.map(m => m.content).slice(-2), ['second question', 'second answer']);
  assert.ok(a.posted.some(m => m.type === 'session'));
  const b = view(convo);
  await ext.CudeChatView.prototype.handle.call(b.self, { type: 'branch', fromEnd: 1, includeReply: false, text: 'third question' });
  assert.equal(b.self.conversation.at(-1).content, 'second answer');
  assert.ok(b.posted.some(m => m.type === 'composer' && m.text === 'third question'));
});

test('copy goes through the editor clipboard', async () => {
  const { ext, vscode } = load();
  const v = view(convo);
  await ext.CudeChatView.prototype.handle.call(v.self, { type: 'copyText', text: 'hello' });
  assert.equal(vscode.__copied, 'hello');
});

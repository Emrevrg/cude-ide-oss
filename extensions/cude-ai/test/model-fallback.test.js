const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadExtension() {
  const vscode = new Proxy({ workspace: { getConfiguration: () => ({ get: (_k, f) => f, inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) }, window: {}, StatusBarAlignment: { Left: 1 }, env: { language: 'en' } }, { get: (t, k) => k in t ? t[k] : new Proxy(function () {}, { get: () => () => ({}) }) });
  const load = Module._load;
  try { Module._load = function (id, ...a) { return id === 'vscode' ? vscode : load.call(this, id, ...a); }; delete require.cache[require.resolve('../out/extension')]; return require('../out/extension'); }
  finally { Module._load = load; }
}

test('model errors that should trigger an automatic switch are recognised; ordinary errors are not', () => {
  const { modelUnavailableReason } = loadExtension();
  assert.equal(modelUnavailableReason(new Error('AI_APICallError: Free usage limit reached. Free models work in OpenCode')), 'quota');
  assert.equal(modelUnavailableReason(new Error('OpenAI 429 Too Many Requests')), 'quota');
  assert.equal(modelUnavailableReason(new Error("Gone: The model 'x' has reached its end of life")), 'retired');
  assert.equal(modelUnavailableReason(new Error('Verify with a payment method to unlock your account')), 'billing');
  assert.equal(modelUnavailableReason(new Error('401 Unauthorized: invalid api key')), 'auth');
  assert.equal(modelUnavailableReason(new Error('Network timeout while reading the project')), undefined);
  assert.equal(modelUnavailableReason(new Error('The user declined this edit.')), undefined);
});

test('OpenCode model ids split into provider and model', () => {
  const { splitOpencodeModel, opencodeError } = require('../out/opencodeServer');
  assert.deepEqual(splitOpencodeModel('nvidia/minimaxai/minimax-m3.1-flash'), { providerID: 'nvidia', modelID: 'minimaxai/minimax-m3.1-flash' });
  assert.equal(splitOpencodeModel('OpenCode CLI'), undefined);
  assert.equal(opencodeError({ error: { data: { message: 'Free usage limit reached. https://opencode.ai/go' } } }), 'Free usage limit reached.');
});

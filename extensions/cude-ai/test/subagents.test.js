const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const vscode = { workspace: { isTrusted: true, workspaceFolders: [] }, window: {} };
const extensionPath = require('node:path').join(__dirname, '..', 'out', 'extension.js');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { runSubagents } = require(extensionPath);
Module._load = originalLoad;

test('agent plans run up to three independent read-only subagents concurrently', async () => {
  let active = 0;
  let peak = 0;
  const activities = [];
  const results = await runSubagents([
    { title: 'Inspect API', task: 'Review the API context' },
    { title: 'Check risks', task: 'Review security context' },
    { title: 'Review tests', task: 'Review test coverage' },
    { title: 'Over limit', task: 'Must not start' },
    null,
  ], async ({ title }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    if (title === 'Check risks') throw new Error('review unavailable');
    return `Findings for ${title}`;
  }, (label, detail) => activities.push({ label, detail }));

  assert.equal(results.length, 3, 'cap delegated reviews to three tasks');
  assert.ok(peak > 1, 'independent reviews overlap');
  assert.deepEqual(results.map(result => result.status), ['done', 'failed', 'done']);
  assert.match(results[1].output, /review unavailable/);
  assert.equal(activities.length, 6, 'each review reports start and completion/failure');
  assert.ok(activities.some(item => item.label.includes('Subagent started')));
  assert.ok(activities.some(item => item.label.includes('Subagent failed')));
});

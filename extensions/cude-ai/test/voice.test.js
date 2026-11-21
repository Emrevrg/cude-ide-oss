const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { speakableText, voiceSupported } = require('../out/voice');

test('spoken answers skip code, links and markdown symbols', () => {
  const text = speakableText('## Plan\nRun `npm test` first.\n```js\nconsole.log(1)\n```\nSee [docs](https://example.com) and **done**.');
  assert.equal(text, 'Plan Run npm test first. See docs and done.');
  assert.ok(speakableText('x'.repeat(5000)).length <= 1800, 'long answers are capped');
});

test('voice scripts keep user text off the command line and use built-in Windows components', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice.ts'), 'utf8');
  assert.match(src, /-EncodedCommand/, 'scripts are passed encoded');
  assert.match(src, /stdin\.end\(clean, 'utf8'\)/, 'speech text goes through stdin');
  assert.match(src, /winmm\.dll/, 'recording uses the built-in MCI recorder');
  assert.match(src, /MAX_RECORDING_MS = 120_000/, 'recording has a hard time limit');
  assert.equal(typeof voiceSupported(), 'boolean');
});

test('agent MCP steps are approval-gated and limited to the inspected tool catalog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(src, /\['file','command','analysis','mcp'\]\.includes\(x\.kind\)/);
  assert.match(src, /if\(step\.kind==='mcp'\)\{requireTrustedWorkspace/);
  assert.match(src, /agent\.mcpUnknownTool/, 'tools outside the approved catalog are refused');
  assert.match(src, /tr\('agent\.mcpConfirm'/, 'every MCP call asks the user first');
  assert.match(src, /function resolveMcpSpawn/, 'Windows command shims are resolved without a shell');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Minimal vscode stand-in: WorkspaceEdit writes straight to disk so the loop's edits can be checked.
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b) { this.start = a; this.end = b; } }
class WorkspaceEdit { constructor() { this.ops = []; } createFile(uri) { this.ops.push({ type: 'create', uri }); } insert(uri, pos, text) { this.ops.push({ type: 'set', uri, text }); } replace(uri, range, text) { this.ops.push({ type: 'set', uri, text }); } }
const vscode = {
  Position, Range, WorkspaceEdit,
  Uri: { file: fsPath => ({ fsPath }) },
  workspace: {
    applyEdit: async edit => { for (const op of edit.ops) { if (op.type === 'create') { if (!fs.existsSync(op.uri.fsPath)) fs.writeFileSync(op.uri.fsPath, ''); } else fs.writeFileSync(op.uri.fsPath, op.text); } return true; },
    openTextDocument: async uri => { const text = fs.readFileSync(uri.fsPath, 'utf8'); return { getText: () => text, positionAt: n => new Position(0, n), save: async () => true }; },
  },
};
const original = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : original.call(this, request, parent, isMain); };
const { runAgentLoop, parseAction, insideWorkspace, trimHistory } = require('../out/agentLoop');
Module._load = original;

const text = (key, values) => `${key}${values ? ':' + JSON.stringify(values) : ''}`;
test('local agent uses a shorter prompt and repairs five malformed replies before a valid action',async()=>{
  const {loopSystemPrompt}=require('../out/agentLoop');
  const options={task:'inspect',workspace:process.cwd(),permission:'readonly',confirm:async()=>false,events:{activity(){}},text,maxSteps:8};
  assert.ok(loopSystemPrompt({...options,localModel:true}).length<loopSystemPrompt(options).length);
  let calls=0;
  const result=await runAgentLoop({...options,localModel:true,chat:async()=>++calls<=5?'invalid JSON':'{"final":"repaired"}'});
  assert.equal(calls,6);assert.equal(result.final,'repaired');assert.equal(result.stopped,'done');
});
function workspace() {
  const base = process.env.CUDE_TEST_TMP || 'E:\\rust\\tmp'; fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'cude-loop-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  return dir;
}
function scripted(replies) { let i = 0; const seen = []; return { seen, chat: async messages => { seen.push(messages.at(-1).content); const r = replies[i++]; if (r instanceof Error) throw r; return r; } }; }

test('continuing after a step limit keeps the original task and tool observations', async () => {
  const model = scripted([
    '{"tool":"read_file","args":{"path":"src/math.js"}}',
    '{"final":"Read the math source. The check remains."}',
    '{"final":"Check complete."}',
  ]);
  const checkpoints = [];
  const inputs = [];
  const result = await runAgentLoop({
    task: 'check the math source', workspace: workspace(), permission: 'readonly', maxSteps: 1,
    chat: async messages => { inputs.push(messages); return model.chat(messages); },
    continueAfter: async checkpoint => { checkpoints.push(checkpoint); return true; },
    confirm: async () => false, events: {activity() {}}, text,
  });
  assert.deepEqual(checkpoints, [{reason:'limit', steps:1, summary:'Read the math source. The check remains.'}]);
  assert.match(inputs[2][1].content, /check the math source/);
  assert.ok(inputs[2].some(message => message.content.startsWith('Result of read_file:')));
  assert.deepEqual(result, {final:'Check complete.', steps:2, stopped:'done'});
});

test('a provider that fails three times offers retry of the same task', async () => {
  let attempts = 0;
  const events = [];
  const result = await runAgentLoop({
    task: 'inspect the test fixture', workspace: workspace(), permission: 'readonly',
    chat: async messages => {
      assert.match(messages[1].content, /inspect the test fixture/);
      if (++attempts <= 3) throw Error('provider unavailable');
      return '{"final":"Recovered."}';
    },
    continueAfter: async checkpoint => {
      assert.equal(checkpoint.reason,'error');
      assert.equal(checkpoint.steps,0);
      return true;
    },
    confirm: async () => false, events: {activity(label) {events.push(label);}}, text,
  });
  assert.equal(attempts,4);
  assert.deepEqual(events,['loop.retry','loop.retry']);
  assert.deepEqual(result,{final:'Recovered.',steps:1,stopped:'done'});
});

test('agent loop reads, fixes a bug, runs a check and finishes with real tool results', async () => {
  const ws = workspace(); const activities = []; const confirms = [];
  const model = scripted([
    '{"thought":"look around","tool":"list_files","args":{}}',
    'Sure! ```json\n{"thought":"read it","tool":"read_file","args":{"path":"src/math.js"}}\n```',
    '{"thought":"fix sign","tool":"edit_file","args":{"path":"src/math.js","old_text":"return a - b;","new_text":"return a + b;"}}',
    '{"thought":"verify","tool":"run_command","args":{"command":"node -e \\"console.log(require(\'./src/math.js\').add(2,3))\\""}}',
    '{"final":"Fixed add() and verified it prints 5."}',
  ]);
  const result = await runAgentLoop({ task: 'fix add', workspace: ws, permission: 'auto', chat: model.chat, confirm: async (m, d) => { confirms.push(d); return true; }, events: { activity: (l, d) => activities.push(l) }, text });
  assert.equal(result.stopped, 'done'); assert.equal(result.final, 'Fixed add() and verified it prints 5.'); assert.equal(result.steps, 5);
  assert.match(fs.readFileSync(path.join(ws, 'src', 'math.js'), 'utf8'), /return a \+ b;/);
  assert.match(model.seen[1], /src\/math\.js/, 'list_files result reached the model');
  assert.ok(!model.seen[1].includes('.env'), 'secret files are not listed');
  assert.match(model.seen[2], /2: {3}return a - b;/, 'read_file result has line numbers');
  assert.match(model.seen[4], /^Result of run_command:\n5\n/m, 'command output reached the model');
  assert.equal(confirms.length, 1, 'only the command asked in auto mode');
});

test('ask mode confirms writes, read-only refuses them, and paths outside or secrets are blocked', async () => {
  const ws = workspace();
  const declined = scripted(['{"tool":"write_file","args":{"path":"x.txt","content":"hi"}}', '{"final":"ok"}']);
  await runAgentLoop({ task: 't', workspace: ws, permission: 'ask', chat: declined.chat, confirm: async () => false, events: { activity() {} }, text });
  assert.equal(fs.existsSync(path.join(ws, 'x.txt')), false); assert.match(declined.seen[1], /declined/);
  const ro = scripted(['{"tool":"run_command","args":{"command":"echo hi"}}', '{"final":"plan"}']);
  await runAgentLoop({ task: 't', workspace: ws, permission: 'readonly', chat: ro.chat, confirm: async () => true, events: { activity() {} }, text });
  assert.match(ro.seen[1], /loop\.readOnly/);
  assert.throws(() => insideWorkspace(ws, '../outside.txt'), /PATH_OUTSIDE/);
  assert.throws(() => insideWorkspace(ws, '.env'), /PATH_SECRET/);
  const escape = scripted(['{"tool":"read_file","args":{"path":"../../Windows/win.ini"}}', '{"final":"done"}']);
  await runAgentLoop({ task: 't', workspace: ws, permission: 'auto', chat: escape.chat, confirm: async () => true, events: { activity() {} }, text });
  assert.match(escape.seen[1], /outside the project/);
});

test('loop survives malformed replies, provider errors and repeated calls, and always ends with a summary', async () => {
  const ws = workspace();
  const flaky = scripted([new Error('503 busy'), 'I think we should look', '{"tool":"list_files","args":{}}', '{"tool":"list_files","args":{}}', '{"final":"done"}']);
  const r = await runAgentLoop({ task: 't', workspace: ws, permission: 'auto', chat: flaky.chat, confirm: async () => true, events: { activity() {} }, text });
  assert.equal(r.final, 'done'); assert.match(flaky.seen.join('\n'), /exactly one JSON object/); assert.match(flaky.seen.join('\n'), /already made this exact call/);
  const endless = { chat: async messages => /limit was reached/.test(messages.at(-1).content) ? '{"final":"summary"}' : `{"tool":"search","args":{"pattern":"x${Math.random()}"}}` };
  const limited = await runAgentLoop({ task: 't', workspace: ws, permission: 'auto', chat: endless.chat, confirm: async () => true, events: { activity() {} }, text, maxSteps: 3 });
  assert.equal(limited.stopped, 'limit'); assert.equal(limited.final, 'summary');
  const controller = new AbortController(); controller.abort();
  const cancelled = await runAgentLoop({ task: 't', workspace: ws, permission: 'auto', chat: async () => '{"final":"x"}', confirm: async () => true, events: { activity() {} }, text, signal: controller.signal });
  assert.equal(cancelled.stopped, 'cancelled');
});

test('unknown tools are hidden and a third identical call requires an answer', async () => {
  const calls=[];
  const invalid='{"tool":"name","args":{}}';
  const first='{"tool":"list_files","args":{"path":".","extra":1}}';
  const repeated='{"tool":"list_files","args":{"extra":1,"path":"."}}';
  const model=scripted([invalid,first,repeated,first,'{"final":"Here is what I found."}']);
  let answerPrompt;
  const chat=messages=>{
    if(messages.at(-1).content.includes('Observations:'))answerPrompt=messages[0].content;
    return model.chat(messages);
  };
  const result=await runAgentLoop({task:'Explain the file.',workspace:workspace(),permission:'auto',chat,
    confirm:async()=>true,events:{activity(label){calls.push(label);}},text,maxSteps:4});
  assert.equal(result.final,'Here is what I found.');
  assert.equal(result.steps,5);
  assert.equal(calls.length,1);
  assert.match(model.seen[1],/That tool is unavailable/);
  assert.match(model.seen[3],/already made this exact call/);
  assert.match(answerPrompt,/Tools are disabled/);
  assert.doesNotMatch(model.seen[4],/"tool":"list_files"/);
  assert.match(model.seen[4],/Observations:/);
});

test('action parser and history trimming', () => {
  assert.deepEqual(parseAction('noise {"tool":"read_file","args":{"path":"a {b}"}} tail'), { tool: 'read_file', args: { path: 'a {b}' } });
  assert.equal(parseAction('no json here'), undefined);
  const long = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }, ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(5000) }))];
  const trimmed = trimHistory(long, 30000); assert.equal(trimmed[0].content, 's'); assert.equal(trimmed[1].content, 'task'); assert.ok(trimmed.reduce((n, m) => n + m.content.length, 0) <= 30000);
});

test('screenshots from Cude tools reach the model as images, with a text fallback for models without image input', async () => {
  const os = require('node:os');
  const ws = workspace();
  const shotDir = path.join(os.tmpdir(), 'cude-computer'); fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, 'loop-test.png');
  fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7a6a3c00000000049454e44ae426082', 'hex'));
  fs.writeFileSync(path.join(ws, 'shot.txt'), `Screenshot saved\n[image: ${shot}]`);
  const base = { task: 'look', workspace: ws, permission: 'readonly', confirm: async () => false, events: { activity() {} }, text, maxSteps: 4 };
  const seen = [];
  let n = 0;
  await runAgentLoop({ ...base, chat: async messages => { seen.push(messages); return ++n === 1 ? '{"tool":"read_file","args":{"path":"shot.txt"}}' : '{"final":"ok"}'; } });
  const last = seen.at(-1).at(-1);
  assert.ok(Array.isArray(last.content) && last.content.some(p => p.type === 'image_url' && /^data:image\/png;base64,/.test(p.image_url.url)), 'image part sent');
  let m = 0, rejectedWithImage = false;
  const result = await runAgentLoop({ ...base, chat: async messages => {
    const hasImage = messages.some(x => Array.isArray(x.content));
    if (hasImage) { rejectedWithImage = true; throw new Error('model does not accept images'); }
    return ++m === 1 ? '{"tool":"read_file","args":{"path":"shot.txt"}}' : '{"final":"text only"}';
  } });
  assert.equal(rejectedWithImage, true); assert.equal(result.final, 'text only');
  const off = []; let k = 0;
  await runAgentLoop({ ...base, images: false, chat: async messages => { off.push(messages); return ++k === 1 ? '{"tool":"read_file","args":{"path":"shot.txt"}}' : '{"final":"ok"}'; } });
  assert.ok(off.flat().every(x => typeof x.content === 'string'), 'images:false never sends image parts');
});

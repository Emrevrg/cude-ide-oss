const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

let models = [], changed;
const requests = [], tokens = [];
const settings = {};
class CancellationTokenSource {
  constructor() { this.token = {isCancellationRequested:false}; tokens.push(this); }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.disposed = true; }
}
const vscode = {
  lm: {selectChatModels:async () => models, onDidChangeChatModels:fn => { changed = fn; return {dispose(){changed = undefined;}}; }},
  LanguageModelChatMessage: {User:content => ({role:'user',content}), Assistant:content => ({role:'assistant',content})},
  CancellationTokenSource,
  workspace: {isTrusted:true, workspaceFolders:[], getConfiguration:() => ({
    get:(key, fallback) => settings[key] ?? fallback,
    inspect:key => ({globalValue:settings[key]}), update:async (key, value) => {settings[key] = value;},
  })},
  window: {}, env:{language:'en'}, ConfigurationTarget:{Global:1},
};
const load = Module._load;
let EditorLanguageModels, Gateway, runAgentLoop;
try {
  Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
  ({EditorLanguageModels} = require('../out/editorLm'));
  ({Gateway} = require('../out/extension'));
  ({runAgentLoop} = require('../out/agentLoop'));
} finally { Module._load = load; }

function model(vendor, id, reply = 'hello world') {
  return {vendor, id, sendRequest:async (messages, options, token) => {
    requests.push({vendor,id,messages,options,token});
    return {text:(async function*(){ const text = typeof reply === 'function' ? reply() : reply; yield text.slice(0,5); yield text.slice(5); })()};
  }};
}
const providerId = 'editor-lm:copilot';

test('discovers every vendor, groups models, hides empty groups and refreshes on model changes', async () => {
  models = [model('copilot','gpt'),model('copilot','claude'),model('other/vendor','local')];
  let notifications = 0;
  const editor = new EditorLanguageModels(() => notifications++);
  await editor.refresh();
  assert.deepEqual(editor.profiles(), [
    {id:providerId,name:'Editör modelleri · copilot',provider:'editor-lm',baseUrl:'',models:['gpt','claude']},
    {id:'editor-lm:other%2Fvendor',name:'Editör modelleri · other/vendor',provider:'editor-lm',baseUrl:'',models:['local']},
  ]);
  models = []; changed(); await editor.refresh();
  assert.deepEqual(editor.profiles(), []);
  assert.equal(notifications, 2);
  editor.dispose();
  const lm = vscode.lm; vscode.lm = undefined;
  try { const oldHost = new EditorLanguageModels(()=>{}); await oldHost.refresh(); assert.deepEqual(oldHost.profiles(), []); oldHost.dispose(); }
  finally { vscode.lm = lm; }
});

test('streams text, preserves instruction/history roles, and disposes cancellation', async () => {
  models = [model('copilot','gpt')];
  const editor = new EditorLanguageModels(()=>{}), deltas = [];
  const result = await editor.chat(providerId,'gpt',[
    {role:'system',content:'Follow project rules'}, {role:'user',content:[{type:'text',text:'question'}]}, {role:'assistant',content:'history'},
  ],undefined,delta => deltas.push(delta));
  assert.equal(result,'hello world'); assert.deepEqual(deltas,['hello',' world']);
  assert.deepEqual(requests.at(-1).messages,[{role:'user',content:'Instructions:\nFollow project rules'},{role:'user',content:'question'},{role:'assistant',content:'history'}]);
  assert.equal(tokens.at(-1).disposed,true);
  await assert.rejects(editor.chat(providerId,'missing',[]), /Editor model unavailable/);
  await assert.rejects(editor.chat(providerId,'gpt',[{role:'user',content:[{type:'image_url',image_url:{url:'data:x'}}]}]), /text only/);
  editor.dispose();
});

test('cancels during streaming and propagates provider failures', async () => {
  const editor = new EditorLanguageModels(()=>{}), controller = new AbortController();
  models = [model('copilot','gpt')];
  await assert.rejects(editor.chat(providerId,'gpt',[],controller.signal,()=>controller.abort()), {name:'AbortError'});
  assert.equal(tokens.at(-1).token.isCancellationRequested,true); assert.equal(tokens.at(-1).disposed,true);
  const count = requests.length;
  await assert.rejects(editor.chat(providerId,'gpt',[],controller.signal), {name:'AbortError'});
  assert.equal(requests.length,count);
  models = [{vendor:'copilot',id:'gpt',sendRequest:async()=>{throw new Error('consent denied');}}];
  await assert.rejects(editor.chat(providerId,'gpt',[]), /consent denied/);
  assert.equal(tokens.at(-1).disposed,true); editor.dispose();
});

test('Gateway selection, model picker state and real agent loop use editor LM requests', async () => {
  const directory = fs.mkdtempSync(path.join(__dirname,'editor-lm-fixture-'));
  const state = {get:(_key,fallback)=>fallback,update:async()=>{}};
  const gateway = new Gateway({get:async()=>undefined}, {globalStorageUri:{fsPath:directory},globalState:state,workspaceState:state}, {current:{models:[],providers:[]}});
  const file = path.join(directory,'proof.txt'); fs.writeFileSync(file,'editor proof');
  let turn = 0;
  models = [model('copilot','gpt',()=>++turn === 1 ? '{"tool":"read_file","args":{"path":"proof.txt"}}' : '{"final":"verified editor proof"}')];
  try {
    await gateway.editorModels.refresh();
    assert.ok(gateway.chatModelState().providers.some(p=>p.id===providerId));
    await gateway.selectModel(providerId,'gpt');
    assert.equal(settings.provider,'editor-lm');
    assert.equal(gateway.chatModelState().model,'gpt');
    const result = await runAgentLoop({task:'Read proof.txt',workspace:directory,permission:'readonly',maxSteps:3,
      chat:(messages,signal)=>gateway.chat(messages,signal),confirm:async()=>false,events:{activity(){}},text:key=>key});
    assert.equal(result.final,'verified editor proof'); assert.equal(result.stopped,'done');
    assert.equal(turn,2);
    assert.ok(requests.at(-1).messages.some(m=>m.content.includes('editor proof')));
    models = []; await gateway.editorModels.refresh();
    assert.ok(!gateway.chatModelState().providers.some(p=>p.provider==='editor-lm'));
    await assert.rejects(gateway.chat([{role:'user',content:'hello'}]), /Editor model unavailable/);
  } finally { gateway.dispose(); fs.rmSync(directory,{recursive:true,force:true}); for (const key of Object.keys(settings)) delete settings[key]; }
});

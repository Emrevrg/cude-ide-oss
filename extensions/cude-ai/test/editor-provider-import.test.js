const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {parseEditorConfig,extractEditorProviders,editorConfigFiles,scanEditorProviders,importEditorProviders}=require('../out/editorProviderImport');
const {writeProviderCredentials,readProviderCredentials}=require('../out/providerCredentials');

test('editor formats preserve endpoints and models, keep keys private, and do not resolve references',()=>{
  const cases=[
    ['Zed',{language_models:{openai_compatible:{acme:{api_url:'https://acme.example/v1',api_key:'fixture-secret',available_models:[{name:'chat'}]}},ollama:{api_url:'http://localhost:11434',available_models:[{name:'qwen'}]},lmstudio:{api_url:'http://localhost:1234'}}},3],
    ['Continue',parseEditorConfig('models:\n  - name: My Model\n    provider: openai\n    model: chat\n    apiBase: https://acme.example/v1\n    apiKey: fixture-secret\n  - name: Local\n    provider: ollama\n    model: qwen\n',true),2],
    ['Continue',{models:[{title:'Legacy',provider:'openai',model:'chat',apiKey:'${{ secrets.KEY }}'}]},1],
    ['OpenCode',parseEditorConfig('{ // comment\n "provider":{"acme":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://acme.example/v1","apiKey":"fixture-secret"},"models":{"chat":{}}}},}'),1],
    ['OpenCode',{providers:{acme:{package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:'https://acme.example/v1',apiKey:'{env:KEY}'},models:{chat:{}}}}},1],
    ['VS Code',{'custom.models':[{name:'acme',baseUrl:'https://acme.example/v1',apiKey:'fixture-secret',model:'chat'}]},1],
    ['Cursor',{'custom.baseURL':'https://acme.example/v1','custom.apiKey':'fixture-secret','custom.models':['chat']},1],
    ['Windsurf',{custom:{baseUrl:'https://acme.example/v1',apiKey:'fixture-secret',model:'chat'}},1],
  ];
  for(const [source,config,count] of cases){const rows=extractEditorProviders(source,config);assert.equal(rows.length,count,source);assert.ok(!JSON.stringify(rows).includes('fixture-secret'));if(count===1)assert.deepEqual(rows[0].models,['chat']);}
  const rows=extractEditorProviders('Zed',cases[0][1]);assert.equal(rows[1].baseUrl,'http://localhost:11434/v1');assert.equal(rows[1].provider,'ollama');assert.equal(rows[2].baseUrl,'http://localhost:1234/v1');
  assert.equal(extractEditorProviders('OpenCode',cases[4][1])[0].keyReference,true);
});

test('scanner reads only fixture files, skips invalid/oversized input and probes local services in sequence',async()=>{
  const dir=await fs.mkdtemp(path.join(process.cwd(),'dist','editor-import-'));
  try{
    const appData=path.join(dir,'appdata'),workspace=path.join(dir,'project');
    const entries=editorConfigFiles(dir,appData,workspace,'win32');
    for(const source of ['Zed','Continue','OpenCode','VS Code','Cursor','Windsurf']){
      const entry=entries.find(e=>e.source===source);await fs.mkdir(path.dirname(entry.file),{recursive:true});
      await fs.writeFile(entry.file,source==='Continue'?'models:\n - name: Test\n   provider: ollama\n   model: qwen\n':source==='Zed'?'{"language_models":{"lmstudio":{}}}':source==='OpenCode'?'{"provider":{"p":{"options":{"baseURL":"https://api.example/v1"}}}}':'{"custom.baseUrl":"https://api.example/v1"}');
    }
    const invalid=entries.find(e=>e.source==='OpenCode'&&e.file.startsWith(workspace));await fs.mkdir(workspace,{recursive:true});await fs.writeFile(invalid.file,'{ invalid secret fixture-secret');
    const large=entries.find(e=>e.source==='Continue'&&e.file.endsWith('.json'));await fs.writeFile(large.file,' '.repeat(512001));
    let active=0,peak=0,calls=0;
    const options={home:dir,appData,workspace,platform:'win32',consent:true,localModels:async url=>{active++;peak=Math.max(peak,active);calls++;await new Promise(r=>setTimeout(r,5));active--;return url.includes('11434')?['qwen']:undefined;}};
    assert.deepEqual(await scanEditorProviders({...options,consent:false}),{providers:[],skipped:0});assert.equal(calls,0);
    const result=await scanEditorProviders(options);assert.equal(result.providers.length,7);assert.equal(result.skipped,2);assert.equal(peak,1);assert.equal(calls,2);
    assert.ok(!entries.some(e=>e.file.includes('.codex')));
    assert.equal(await fs.readFile(invalid.file,'utf8'),'{ invalid secret fixture-secret');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('import requires read consent, per-provider approval and separate key approval; only secrets store gets keys',async()=>{
  let scanned=0,saved=[],keyPrompts=[];
  const candidates=extractEditorProviders('Continue',{models:[
    {name:'Allowed',provider:'openai',model:'chat',apiKey:'one-secret'},
    {name:'No key',provider:'openai',model:'chat',apiKey:'two-secret'},
    {name:'Denied',provider:'openai',model:'chat',apiKey:'three-secret'},
    {name:'Reference',provider:'openai',model:'chat',apiKey:'{env:KEY}'},
  ]});
  const store=new Map(),secrets={get:async k=>store.get(k),store:async(k,v)=>store.set(k,v),delete:async k=>store.delete(k)};
  const options={allowRead:async()=>false,scan:async()=>{scanned++;return {providers:candidates,skipped:0};},select:async p=>[...p,{...p[0]}],approve:async p=>p.name!=='Denied',approveKey:async p=>{keyPrompts.push(p.name);return p.name==='Allowed';},save:async(p,key)=>{const profile={id:p.name,...p};await writeProviderCredentials(secrets,profile,{key,headers:{},proxy:''});saved.push(profile);}};
  assert.equal((await importEditorProviders(options)).count,0);assert.equal(scanned,0);
  assert.equal((await importEditorProviders({...options,allowRead:async()=>true})).count,3);
  assert.deepEqual(keyPrompts,['Allowed','No key']);assert.deepEqual(saved.map(p=>p.name),['Allowed','No key','Reference']);
  assert.ok(!JSON.stringify(saved).includes('one-secret'));assert.equal(store.size,1);
  assert.equal((await readProviderCredentials(secrets,saved[0])).key,'one-secret');
  assert.equal((await readProviderCredentials(secrets,saved[1])).key,'');
});

test('unsafe URLs, native providers, malformed JSON and YAML aliases fail safely',()=>{
  for(const url of ['https://user:secret@host/v1','https://host/v1?key=secret','https://host/v1#secret','file:///tmp/key','{env:URL}'])assert.deepEqual(extractEditorProviders('Cursor',{p:{baseUrl:url}}),[]);
  assert.deepEqual(extractEditorProviders('Continue',{models:[{provider:'anthropic',apiBase:'https://host',model:'claude'}]}),[]);
  assert.throws(()=>parseEditorConfig('{"apiKey":"fixture-secret", broken}'),error=>!error.message.includes('fixture-secret'));
  assert.throws(()=>parseEditorConfig('a: &a [1]\nb: *a',true));
  assert.throws(()=>parseEditorConfig('apiKey: fixture-secret\napiKey: duplicate',true),error=>!error.message.includes('fixture-secret'));
  const [row]=extractEditorProviders('Cursor',{p:{baseUrl:'https://host/v1',apiKey:'fixture-secret',name:'fixture-secret',models:['fixture-secret','chat']}});
  assert.equal(row.name,'[redacted]');assert.deepEqual(row.models,['chat']);
});

test('real Gateway imports profiles and SecretStorage with rollback on settings failure',async()=>{
  const Module=require('node:module');
  const original=Module._load,settings={language:'en',providers:[]},store=new Map();
  const secrets={get:async k=>store.get(k),store:async(k,v)=>store.set(k,v),delete:async k=>store.delete(k)};
  let allow=true,fail=false,scans=0,approveKey=true;
  const notices=[],prompts=[];
  const vscode={ConfigurationTarget:{Global:1},workspace:{workspaceFolders:[],getConfiguration:()=>({get:(k,d)=>settings[k]??d,inspect:k=>({globalValue:settings[k]}),update:async(k,v)=>{if(fail)throw new Error('settings write failed');settings[k]=v;}})},window:{showWarningMessage:async(message,options,action)=>{prompts.push({message,options});return message.startsWith('Copy the API key')?(approveKey?action:undefined):(allow?action:undefined);},showQuickPick:async items=>items,showInformationMessage:message=>notices.push(message)},env:{language:'en'}};
  let Gateway;
  try{
    Module._load=function(id,...args){if(id==='vscode')return vscode;if(id==='./editorProviderImport')return {...require('../out/editorProviderImport'),scanEditorProviders:async()=>{scans++;return {providers:extractEditorProviders('Continue',{models:[{name:'Gateway fixture',provider:'openai',model:'chat',apiKey:'fixture-secret'}]}),skipped:0};}};return original.call(this,id,...args);};
    ({Gateway}=require('../out/extension'));
  }finally{Module._load=original;}
  const state={get:(_k,d)=>d,update:async()=>{}};
  const gateway=new Gateway(secrets,{globalStorageUri:{fsPath:process.cwd()},globalState:state,workspaceState:state},{current:{models:[],providers:[]}});
  try{
    allow=false;await gateway.importProvidersFromEditors();assert.equal(scans,0);assert.equal(store.size,0);
    allow=true;await gateway.importProvidersFromEditors();assert.equal(settings.providers.length,1);assert.equal(store.size,1);assert.equal((await readProviderCredentials(secrets,settings.providers[0])).key,'fixture-secret');
    assert.ok(!JSON.stringify({settings,notices,prompts}).includes('fixture-secret'));
    settings.providers=[];store.clear();approveKey=false;await gateway.importProvidersFromEditors();assert.equal(settings.providers.length,1);assert.equal(store.size,0);
    settings.providers=[];fail=true;approveKey=true;await assert.rejects(gateway.importProvidersFromEditors(),/Provider import failed/);assert.equal(store.size,0);assert.equal(settings.providers.length,0);
    fail=false;await gateway.importProvidersFromEditors();assert.equal(settings.providers.length,1,'running guard resets after failure');
  }finally{gateway.dispose();}
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const security=require('../out/security.js');
const {isValidHuggingFaceRepo}=require('../out/localModels.js');

test('secret path policy blocks credentials and keeps ordinary source files',()=>{
  for(const file of ['.env','.env.local','config/prod.env','.envrc','.npmrc','.pypirc','.netrc','.git-credentials','.aws/credentials','.ssh/id_rsa','id_ed25519','keys/server.pem','tls/private.key','cert.p12','release.jks','infra/prod.tfvars','terraform.tfstate','secrets/token.txt','config/credentials','gcp-service-account.json','client_secret_123.json','C:\\Users\\me\\.ssh\\config','.docker/config.json','.kube/config'])
    assert.equal(security.isSecretPath(file),true,file);
  for(const file of ['src/index.ts','README.md','src/keyboard.ts','docs/environment.md','src/envelope.ts','package.json','src/my.keyboard.ts','tests/secretary.test.ts'])
    assert.equal(security.isSecretPath(file),false,file);
  const root=path.resolve('workspace-fixture');
  for(const file of ['.aws/credentials','config/prod.env','keys/a.jks'])assert.equal(isProtectedCompletionPath(path.join(root,file),root),true,file);
});

test('template filling never interprets $ replacement patterns from data',()=>{
  const html='<script nonce="{{NONCE}}">const p={{PROFILES}};</script>';
  const out=security.fillTemplate(html,{NONCE:'n1',PROFILES:JSON.stringify([{name:"$` $' $& $$"}])});
  assert.equal(out,'<script nonce="n1">const p=[{"name":"$` $\' $& $$"}];</script>');
  assert.equal(security.fillTemplate('{{UNKNOWN}}',{}),'{{UNKNOWN}}');
});

test('chat.html and providers.html templates are fully filled and their scripts parse',()=>{
  const vm=require('node:vm');const root=path.join(__dirname,'..');const source=fs.readFileSync(path.join(root,'src','extension.ts'),'utf8');const {I18N}=require('../out/i18n.js');
  const keysPassed=pattern=>{const call=source.match(pattern)?.[1];assert.ok(call,`fillTemplate call not found: ${pattern}`);return [...call.matchAll(/(?:^|,)\s*([A-Z0-9_]+):/g)].map(match=>match[1]);};
  const cases=[
    {file:'chat.html',keys:keysPassed(/return fillTemplate\(template,\{([\s\S]*?)\}\);/),sample:{CSP:'https://example.vscode-cdn.net',NONCE:'n0nce',PROJECT:'proj $` $\' $&',LOGO:'https://example.vscode-cdn.net/logo.png',DISABLED:'',LANG:'en',I18N:JSON.stringify(I18N).replaceAll('<','\\u003c')}},
    {file:'providers.html',keys:keysPassed(/fillTemplate\(providerHtml,\{([\s\S]*?)\}\)\s*;/),sample:{NONCE:'n0nce',PRESETS:'[]',PROFILES:JSON.stringify([{id:'p',name:"$` $' $&",provider:'openai',baseUrl:'https://x',models:["m$'"]}]),LOCAL_AGENTS:'[]',LOCAL_MODELS:'[]',FREE_PROVIDERS:'[]',RECOMMENDED_MODELS:'[]',DEVICE:'{}',CATALOG:'{}',ACTIVE:'""',LANG:'en',CLI_ENABLED:'false',ICONS:'{}',FOCUS:'""',POOL_URL:'""',I18N:JSON.stringify(I18N)}}
  ];
  for(const {file,keys,sample} of cases){
    const template=fs.readFileSync(path.join(root,'media',file),'utf8');
    const placeholders=[...new Set([...template.matchAll(/\{\{([^}]+)\}\}/g)].map(match=>match[1]))];
    for(const name of placeholders)assert.ok(keys.includes(name),`${file}: extension does not fill {{${name}}}`);
    const values=Object.fromEntries(keys.map(key=>[key,sample[key]??'']));
    const html=security.fillTemplate(template,values);
    assert.doesNotMatch(html,/\{\{[^}]*\}\}/,`${file}: unreplaced placeholder`);
    const scripts=[...html.matchAll(/<script nonce="n0nce">([\s\S]*?)<\/script>/g)].map(match=>match[1]);
    assert.ok(scripts.length>=1,`${file}: nonce script present`);
    for(const script of scripts)assert.doesNotThrow(()=>new vm.Script(script),`${file}: script must parse`);
  }
});

test('secret redaction, masked headers/proxy, origin and command checks',()=>{
  assert.equal(security.redactSecrets('Invalid key sk-test-123456 provided',['sk-test-123456']),'Invalid key [redacted] provided');
  assert.equal(security.redactSecrets('short ab',['ab']),'short ab');
  const masked=security.maskHeaders({'X-Token':'t0ps3cret','X-Team':'alpha'});
  assert.deepEqual(masked,{'X-Token':security.MASKED_SECRET,'X-Team':security.MASKED_SECRET});
  assert.deepEqual(security.restoreMaskedHeaders({...masked,'X-New':'v'},{'x-token':'t0ps3cret','X-Team':'alpha'}),{'X-Token':'t0ps3cret','X-Team':'alpha','X-New':'v'});
  assert.throws(()=>security.restoreMaskedHeaders(masked,{}),/no saved value/);
  const proxy='https://user:pa55word@proxy.example.com:8443';
  const shown=security.maskProxy(proxy);assert.ok(!shown.includes('pa55word'));
  assert.equal(security.restoreMaskedProxy(shown,proxy),proxy);
  assert.throws(()=>security.restoreMaskedProxy(shown.replace('proxy.example.com','evil.example.net'),proxy),/again/);
  assert.equal(security.sameOrigin('https://api.openai.com/v1','https://api.openai.com/v1/models'),true);
  assert.equal(security.sameOrigin('https://api.openai.com/v1','https://api.openai.com.evil.net/v1'),false);
  assert.equal(security.hasHiddenCommandCharacters('npm test'),false);
  assert.equal(security.hasHiddenCommandCharacters('npm test \u202e lmth.exe'),true);
  assert.equal(security.hasHiddenCommandCharacters('echo \u001b[8mhidden'),true);
});

test('provider settings never post stored secrets and provider requests pin redirects to the configured origin',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','extension.ts'),'utf8');
  assert.match(source,/post\(\{type:'profile',profile:publicProfile,key:'',hasKey:!!key,headers:JSON\.stringify\(maskHeaders\(parsedHeaders\)\),proxy:maskProxy\(proxy\)\}\)/);
  assert.doesNotMatch(source,/(?:post|postMessage)\(\{type:'profile',profile,key,headers,proxy\}\)/);
  assert.match(source,/redirect:'manual'/);assert.match(source,/Provider redirected to a different host/);
  assert.doesNotMatch(source,/message\.permission\|\|this\.context\.workspaceState/);
  assert.match(source,/createWebviewPanel\('cudeProvider','Cude · Provider',vscode\.ViewColumn\.Active,\{enableScripts:true,localResourceRoots:\[\]\}\)/);
  assert.doesNotMatch(source,/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Hugging Face repository references reject dot segments',()=>{
  assert.equal(isValidHuggingFaceRepo('Qwen/Qwen2.5-0.5B-Instruct-GGUF'),true);
  for(const repo of ['../x','x/..','./x','a/b/c','a','a/b?c','a/ b'])assert.equal(isValidHuggingFaceRepo(repo),false,repo);
});

// --- Integration checks against the compiled extension with a minimal vscode mock ---
class Memento{constructor(values=new Map()){this.values=values;}get(key,fallback){return this.values.has(key)?this.values.get(key):fallback;}async update(key,value){this.values.set(key,value);}}
class TestWorkspaceEdit{constructor(){this.ops=[];}replace(uri,range,text){this.ops.push({type:'replace',uri,text});}createFile(uri){this.ops.push({type:'create',uri});}insert(uri,position,text){this.ops.push({type:'insert',uri,text});}}
const vscode={
  workspace:{isTrusted:true,workspaceFolders:[],findFiles:async()=>[],getConfiguration:()=>({get:(key,fallback)=>fallback,inspect:()=>undefined}),fs:{readFile:async uri=>fs.promises.readFile(uri.fsPath),stat:async uri=>{const s=await fs.promises.stat(uri.fsPath);return{type:s.isFile()?1:2,size:s.size};}},openTextDocument:async input=>({uri:input?.uri||input,getText:()=>input?.content||''}),applyEdit:async()=>{throw new Error('applyEdit must not run');}},
  window:{},commands:{executeCommand:async()=>undefined},
  WorkspaceEdit:TestWorkspaceEdit,Position:class{constructor(l,c){this.line=l;this.character=c;}},Range:class{constructor(s,e){this.start=s;this.end=e;}},EndOfLine:{LF:1,CRLF:2},FileType:{File:1},
  Uri:{file:fsPath=>({fsPath,path:fsPath,toString:()=>fsPath}),parse:value=>({path:new URL(value).pathname,fsPath:value,toString:()=>value})}
};
const originalLoad=Module._load;Module._load=function(request,parent,isMain){return request==='vscode'?vscode:originalLoad.call(this,request,parent,isMain);};
const {CudeChatView,Gateway,appendProjectMemory,deactivate}=require('../out/extension.js');const {isProtectedCompletionPath}=require('../out/editorFeatures.js');Module._load=originalLoad;

function fixture(label){const temp=path.resolve(process.env.CUDE_TEST_TMP||'E:\\rust\\tmp');fs.mkdirSync(temp,{recursive:true});const folder=fs.mkdtempSync(path.join(temp,`cude-sec-${label}-`));return{temp,folder,clean(){const resolved=path.resolve(folder);assert.ok(resolved.startsWith(path.resolve(temp)+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}};}
function makeView(workspaceState=new Memento(),gateway={}){const messages=[];const view=new CudeChatView({workspaceState,globalState:new Memento()},{setModelRefresh(){},...gateway},{});view.webview={postMessage:message=>messages.push(message)};return{view,messages};}

test('webview-supplied permission cannot upgrade the stored Ask mode to auto-apply',async()=>{
  const fx=fixture('permission');try{
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fx.folder}}];let applied=0;vscode.workspace.applyEdit=async()=>{applied++;return true;};
    const {view,messages}=makeView();await view.handle({type:'permission',value:'ask'});
    await view.handle({type:'applyBlock',path:'src/new.ts',content:'export const x = 1;\n',permission:'full'});
    assert.equal(applied,0,'nothing is applied without the stored permission');
    assert.ok(messages.some(message=>message.type==='pendingChange'),'the change is staged for an explicit decision');
    assert.equal(fs.existsSync(path.join(fx.folder,'src','new.ts')),false);
  }finally{vscode.workspace.workspaceFolders=[];vscode.workspace.applyEdit=async()=>{throw new Error('applyEdit must not run');};fx.clean();}
});

test('AI file proposals cannot write through a junction that points outside the project',async()=>{
  const fx=fixture('junction');try{
    const workspace=path.join(fx.folder,'ws'),outside=path.join(fx.folder,'outside');fs.mkdirSync(workspace);fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(workspace,'link'),'junction');
    vscode.workspace.workspaceFolders=[{uri:{fsPath:workspace}}];
    const {view,messages}=makeView();
    await view.handle({type:'previewBlock',path:'link/evil.ts',content:'pwned\n'});
    assert.ok(messages.some(message=>message.type==='error'&&/outside the project|protected file/.test(message.text)),JSON.stringify(messages));
    assert.ok(!messages.some(message=>message.type==='pendingChange'));
  }finally{vscode.workspace.workspaceFolders=[];fx.clean();}
});

test('secret active editor contents and hidden agent commands are never used',async()=>{
  const fx=fixture('active-secret');try{
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fx.folder}}];
    const envFile=path.join(fx.folder,'.env');fs.writeFileSync(envFile,'API_TOKEN=must-not-leak\n');
    vscode.window.activeTextEditor={document:{fileName:envFile,getText:()=> 'API_TOKEN=must-not-leak\n'},selection:{isEmpty:true,start:{line:0},end:{line:0}}};
    let sent='';const {view,messages}=makeView(new Memento(),{chat:async items=>{sent=JSON.stringify(items);return 'ok';}});
    await view.handle({type:'chat',text:'What does this project do?'});
    assert.ok(sent.length>0,'the provider was called');
    assert.ok(!sent.includes('must-not-leak'),'secret editor text is not sent');
    assert.ok(messages.some(message=>message.type==='answer'&&message.text==='ok'));

    const agents=new Memento(new Map([['agents',[{id:'a1',title:'Run',status:'done',steps:[{id:'s1',title:'Run tests',kind:'command',command:'npm test \u202e lmth.exe'}]}]]]));
    let prompts=0;vscode.window.showWarningMessage=async()=>{prompts++;return 'Run command';};vscode.window.createTerminal=()=>{throw new Error('terminal must not open');};
    const second=makeView(agents);
    await second.view.handle({type:'approveStep',agentId:'a1',stepId:'s1'});
    assert.equal(prompts,0);
    assert.ok(second.messages.some(message=>message.type==='error'&&/hidden control/.test(message.text)));
  }finally{vscode.workspace.workspaceFolders=[];delete vscode.window.activeTextEditor;fx.clean();}
});

test('oversized or malformed webview messages are rejected before any handler runs',async()=>{
  const {view,messages}=makeView();
  await view.handle(null);await view.handle({type:42});
  assert.equal(messages.length,0);
  await view.handle({type:'openFile',path:'x'.repeat(5000)});
  assert.ok(messages.some(message=>message.type==='error'&&/rejected/.test(message.text)));
});

test('recognizable credential literals are masked without swallowing surrounding code',()=>{
  const token='cude_'+'a'.repeat(64);
  const key='nvapi-'+'Z'.repeat(30);
  const pem='-----BEGIN PRIVATE KEY-----\nRkFLRQ==\n-----END PRIVATE KEY-----';
  assert.equal(security.redactCredentialLiterals([token,key,pem,'password=test'].join('\n')),'[redacted]\n[redacted]\n[redacted]\npassword=test');
});

test('active context and project memory reject an outward junction',async()=>{
  const fx=fixture('context-junction');
  try{
    const workspace=path.join(fx.folder,'project'),outside=path.join(fx.folder,'outside');
    fs.mkdirSync(workspace);fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(workspace,'.cude'),'junction');
    const document=path.join(workspace,'.cude','memory.md');
    fs.writeFileSync(document,'outside-project-sentinel');
    vscode.workspace.workspaceFolders=[{uri:{fsPath:workspace}}];
    vscode.window.activeTextEditor={document:{uri:{scheme:'file'},fileName:document,getText:()=>fs.readFileSync(document,'utf8')},selection:{isEmpty:true,start:{line:0},end:{line:0}}};
    let sent='';
    const {view}=makeView(new Memento(),{chat:async items=>{sent=JSON.stringify(items);return 'ok';}});
    await view.handle({type:'chat',text:'benign fixture'});
    assert.ok(sent&&!sent.includes('outside-project-sentinel'));
    await assert.rejects(appendProjectMemory(workspace,'must not write'),/outside the project/);
    assert.equal(fs.readFileSync(document,'utf8'),'outside-project-sentinel');
  }finally{vscode.workspace.workspaceFolders=[];delete vscode.window.activeTextEditor;fx.clean();}
});

test('voice upload requires native approval, an official endpoint, and endpoint-bound credentials',async()=>{
  const fx=fixture('voice');
  const originalFetch=global.fetch;
  const originalInfo=vscode.window.showInformationMessage;
  try{
    const file=path.join(fx.folder,'audio.wav');
    fs.writeFileSync(file,Buffer.alloc(2300));
    const approved={id:'official',provider:'openai',baseUrl:'https://api.openai.com/v1',name:'Official'};
    const unofficial={id:'custom',provider:'openai',baseUrl:'https://invalid.example/v1',name:'Custom'};
    const {credentialSlot}=require('../out/providerCredentials');
    const key='fixture-only-key';
    const credentials=JSON.stringify({key,headers:{},proxy:''});
    let consent=false,prompts=0,fetches=0;
    vscode.window.showInformationMessage=async(message,options,button)=>{
      prompts++;
      assert.equal(options.modal,true);
      assert.match(options.detail,/api\.openai\.com/);
      return consent?button:undefined;
    };
    global.fetch=async(url,options)=>{
      fetches++;
      assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.authorization,'Bearer '+key);
      return Response.json({text:'voice fixture'});
    };
    const instance={profiles:()=>[unofficial,approved],secrets:{get:async slot=>slot===credentialSlot(approved)?credentials:undefined}};
    assert.equal(await Gateway.prototype.transcribe.call(instance,file,'en'),undefined);
    assert.equal(fetches,0);
    consent=true;
    assert.deepEqual(await Gateway.prototype.transcribe.call(instance,file,'en'),{text:'voice fixture',via:'Official'});
    assert.equal(prompts,2);
    assert.equal(fetches,1);
    instance.profiles=()=>[unofficial];
    assert.equal(await Gateway.prototype.transcribe.call(instance,file,'en'),undefined);
    assert.equal(prompts,2);
  }finally{global.fetch=originalFetch;vscode.window.showInformationMessage=originalInfo;fx.clean();}
});

test('agent MCP preserves the approved session only for the same environment and validates arguments',async()=>{
  const fx=fixture('mcp-session');
  const originalWarning=vscode.window.showWarningMessage;
  const originalShow=vscode.window.showTextDocument;
  try{
    const metadata=path.join(fx.folder,'.cude');
    fs.mkdirSync(metadata);
    const script=path.join(fx.folder,'stdio.cjs');
    fs.writeFileSync(script, [
      "const deferred = require('node:readline').createInterface({input:process.stdin});",
      "deferred.on('line', line => { const input = JSON.parse(line); if (!input.id) return;",
      "const result = input.method === 'initialize' ? {protocolVersion:'2025-03-26'} : input.method === 'tools/list' ? {tools:[{name:'echo'}]} : {content:[{type:'text',text:process.env.FIXTURE_ID}]};",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,result})+'\\n'); });"
    ].join('\n'));
    const config=path.join(metadata,'mcp.json');
    const writeConfig=id=>fs.writeFileSync(config,JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[script],env:{FIXTURE_ID:id}}}}));
    fs.writeFileSync(path.join(metadata,'mcp-tools.json'),JSON.stringify({tools:[{server:'fixture',name:'echo'}]}));
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fx.folder}}];
    vscode.window.showTextDocument=async()=>undefined;
    let startupApprovals=0,toolApprovals=0;
    vscode.window.showWarningMessage=async(message,options,approval)=>{
      assert.equal(options.modal,true);
      if(message==='Start configured MCP process?'){
        startupApprovals++;
        assert.match(options.detail,/stdio\.cjs/);
        assert.doesNotMatch(options.detail,/first-fixture|second-fixture/);
      }else{
        toolApprovals++;
        assert.match(options.detail,/\\u202e/);
      }
      return approval;
    };
    const step={id:'step-mcp',kind:'mcp',server:'fixture',tool:'echo',title:'Echo',arguments:{text:'fixture \u202e'}};
    const agent={id:'agent-mcp',title:'Echo',status:'done',permission:'ask',steps:[step]};
    const state=new Memento(new Map([['permission','auto'],['agents',[agent]]]));
    const {view,messages}=makeView(state);
    const call=()=>view.handle({type:'approveStep',agentId:agent.id,stepId:step.id});
    writeConfig('first-fixture');
    await call();
    await call();
    writeConfig('second-fixture');
    await call();
    assert.equal(startupApprovals,2);
    assert.equal(toolApprovals,3);
    assert.deepEqual(messages.filter(item=>item.type==='activity').map(item=>item.detail),['first-fixture','first-fixture','second-fixture']);
    step.arguments={text:'x'.repeat(4100)};
    await call();
    assert.equal(toolApprovals,3);
    assert.ok(messages.some(item=>item.type==='error'&&item.text.includes('size')));
    agent.permission='plan';step.arguments={};
    await call();
    assert.equal(toolApprovals,3);
  }finally{await deactivate();vscode.workspace.workspaceFolders=[];vscode.window.showWarningMessage=originalWarning;vscode.window.showTextDocument=originalShow;fx.clean();}
});

test('a staged edit is rejected if its directory becomes an outward junction before acceptance',async()=>{
  const fx=fixture('apply-junction');
  try{
    const workspace=path.join(fx.folder,'project'),outside=path.join(fx.folder,'outside'),relative='src/new.ts';
    fs.mkdirSync(workspace);fs.mkdirSync(outside);fs.mkdirSync(path.join(workspace,'src'));
    vscode.workspace.workspaceFolders=[{uri:{fsPath:workspace}}];
    const {view,messages}=makeView();
    await view.handle({type:'previewBlock',path:relative,content:'export {};'});
    assert.ok(messages.some(item=>item.type==='pendingChange'));
    fs.renameSync(path.join(workspace,'src'),path.join(workspace,'old-src'));
    fs.symlinkSync(outside,path.join(workspace,'src'),'junction');
    await view.handle({type:'acceptChange',path:relative});
    assert.ok(messages.some(item=>item.type==='error'&&item.text.includes('outside the project')));
    assert.equal(fs.existsSync(path.join(outside,'new.ts')),false);
  }finally{vscode.workspace.workspaceFolders=[];fx.clean();}
});

test('unrelated webview messages cannot clear the active chat cancellation controller',async()=>{
  const fx=fixture('chat-cancellation');
  try{
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fx.folder}}];
    let start;
    const started=new Promise(resolve=>{start=resolve;});
    const {view}=makeView(new Memento(),{chat:(_,signal)=>new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      start(signal);
    })});
    const pending=view.handle({type:'chat',text:'fixture'});
    const signal=await started;
    await view.handle({type:'noOperation'});
    await view.handle({type:'stop'});
    assert.equal(signal.aborted,true);
    await pending;
  }finally{vscode.workspace.workspaceFolders=[];fx.clean();}
});

test('@codebase adds semantic excerpts only when the chat explicitly requests them',async()=>{
  const fx=fixture('semantic-chat');
  try{
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fx.folder}}];
    let searches=0;
    const requests=[];
    const {view}=makeView(new Memento(),{
      semanticContext:async(workspace,question)=>{
        searches++;
        assert.equal(workspace,fx.folder);
        assert.match(question,/@codebase/i);
        return 'src/cache.ts:7\nsemantic-excerpt-fixture';
      },
      chat:async messages=>{requests.push(messages);return 'fixture answer';},
    });
    await view.handle({type:'chat',text:'How does caching work?'});
    assert.equal(searches,0);
    assert.ok(!requests[0][0].content.includes('semantic-excerpt-fixture'));
    await view.handle({type:'chat',text:'@codebase How does caching work?'});
    assert.equal(searches,1);
    assert.match(requests[1][0].content,/src\/cache\.ts:7\nsemantic-excerpt-fixture/);
    assert.doesNotMatch(requests[1].at(-1).content,/@codebase/);
  }finally{vscode.workspace.workspaceFolders=[];fx.clean();}
});

test('the normal agent loop receives semantic source excerpts in its first request',async()=>{
  const fx=fixture('semantic-agent');
  try{
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fx.folder}}];
    const {view,messages}=makeView(new Memento(),{
      isLocalActive:()=>false,
      semanticContext:async(workspace,question,signal)=>{
        assert.equal(workspace,fx.folder);
        assert.equal(question,'Explain caching');
        assert.equal(signal.aborted,false);
        return 'src/cache.ts:2\nagent-semantic-snippet';
      },
      chat:async request=>{
        assert.match(request[1].content,/Norovox semantic search:\nsrc\/cache\.ts:2\nagent-semantic-snippet/);
        return '{"final":"cache fixture verified"}';
      },
    });
    await view.handle({type:'agent',text:'Explain caching'});
    assert.ok(messages.some(message=>message.type==='answer'&&message.text==='cache fixture verified'));
  }finally{vscode.workspace.workspaceFolders=[];fx.clean();}
});

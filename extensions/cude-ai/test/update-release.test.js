const test=require('node:test'),assert=require('node:assert/strict');
const {CommandApprovals}=require('../out/commandApproval');
const {reject,blocked}=require('../../../build/update-lock');
test('workbench blocks concrete commands and Cude entry points only while locked',()=>{
 for(const id of [...blocked,'cude-ai.agent','cude-ai.configureProvider','cude-ai.acceptInlineEdit']){
  const run=locked=>{if(reject(locked,id))throw Error('update required');return 'executed';};
  assert.throws(()=>run(true),/update required/);assert.equal(run(false),'executed');
 }
 for(const id of ['cude-ai.checkSignedUpdate','cude-ai.openUpdates','workbench.action.quit','workbench.action.closeAllEditors','setContext'])assert.equal(reject(true,id),false);
});
test('inline command capability rejects forged, cross-view and reused decisions',async()=>{
 const a=new CommandApprovals(),owner={},other={};let id;
 const result=a.request(owner,value=>id=value);
 assert.match(id,/^[a-f0-9]{64}$/);assert.equal(a.answer(owner,'fake',true),false);
 assert.equal(a.answer(other,id,true),false);assert.equal(a.answer(owner,id,true),true);
 assert.equal(await result,true);assert.equal(a.answer(owner,id,true),false);
 const rejected=a.request(owner,value=>id=value);a.answer(owner,id,'true');assert.equal(await rejected,false);
});
test('inline command capability expires, aborts and cancels on view disposal',async()=>{
 const a=new CommandApprovals(),owner={},controller=new AbortController();
 const keepAlive=setTimeout(()=>{},100);
 try{assert.equal(await a.request(owner,()=>{},5),false);}finally{clearTimeout(keepAlive);}
 const abort=a.request(owner,()=>{},300000,controller.signal);controller.abort();assert.equal(await abort,false);
 const disposed=a.request(owner,()=>{});a.cancel(owner);assert.equal(await disposed,false);
});

test('provider panel opens before stalled catalog and local model probes',async()=>{
 const Module=require('node:module'),load=Module._load,path=require('node:path');let created=false,catalogCalls=0,localCalls=0,receive;
 const webview={postMessage:async()=>true,onDidReceiveMessage(fn){receive=fn;}};
 const vscode={StatusBarAlignment:{Left:1},workspace:{onDidChangeConfiguration:()=>({dispose(){}}),getConfiguration:()=>({get:(_k,f)=>f,inspect:()=>undefined})},Uri:{joinPath:(base,...parts)=>({fsPath:path.join(base.fsPath,...parts)})},ViewColumn:{Active:1},window:{createWebviewPanel(){created=true;return {webview,onDidDispose(){}};}}};
 let Gateway,CudeChatView;
 try{Module._load=function(id,...args){return id==='vscode'?vscode:load.call(this,id,...args);};delete require.cache[require.resolve('../out/extension')];({Gateway,CudeChatView}=require('../out/extension'));}finally{Module._load=load;}
 const instance={context:{extensionUri:{fsPath:path.resolve(__dirname,'..')},globalState:{get:(_k,f)=>f}},profiles:()=>[],cliEnabled:()=>false,poolUrl:()=>'',catalog:{current:undefined,snapshotOrLoad(){catalogCalls++;return new Promise(()=>{});}},localModels:{enabled:true,directoryPath:'',refresh(){localCalls++;return new Promise(()=>{});}},poolQuotaPanels:new Set()};
 Object.setPrototypeOf(instance,Gateway.prototype);
 await instance.configure();
 assert.equal(created,true);assert.equal(catalogCalls,0);assert.equal(localCalls,0);assert.match(webview.html,/providerReady/);
 const timer=global.setTimeout;global.setTimeout=()=>({unref(){}});
 try{await receive({type:'providerReady'});}finally{global.setTimeout=timer;}
 assert.equal(catalogCalls,1);assert.equal(localCalls,1);
 const {activityGate}=require('../out/updatePolicy');
 const reached=[];
 activityGate.block('Release check pending');
 try {
   await CudeChatView.prototype.handle.call({gateway:{configure:async focus=>reached.push(focus)}},{type:'openSetup',focus:'tab:free'});
   assert.deepEqual(reached,['tab:free']);
 } finally {activityGate.allow();}
 await assert.rejects(instance.formCredentials({provider:'openai',url:'https://api.openai.com/v1'}),/API key is required for OpenAI/);
 assert.equal((await instance.formCredentials({provider:'openai-compatible',url:'http://127.0.0.1:8080/v1'})).key,'');
 const catalogs=[];
 instance.advertisedEfforts=new Map();
 instance.request=async (url,{headers})=>{
   catalogs.push({url,headers});
   return Response.json({data:[{id:'fixture'}]});
 };
 await instance.discover('anthropic','https://tokenharbor.ai/v1','provider-fixture');
 await instance.discover('anthropic','https://api.anthropic.com/v1','provider-fixture');
 assert.equal(catalogs[0].headers.authorization,'Bearer provider-fixture');
 assert.equal(catalogs[1].headers['x-api-key'],'provider-fixture');
 const startup=Object.create(Gateway.prototype);
 const order=[];
 let finishCatalog;
 startup.catalog={snapshotOrLoad:()=>new Promise(resolve=>{order.push('catalog');finishCatalog=resolve;})};
 startup.notifyModels=()=>order.push('publish');
 startup.refreshLocalProfiles=async()=>{order.push('local');};
 const pending=startup.prepareStartupModels();
 assert.equal(startup.prepareStartupModels(),pending);
 assert.deepEqual(order,['catalog']);
 finishCatalog();
 await pending;
 assert.deepEqual(order,['catalog','publish','local']);
});

test('mandatory update closes terminals, locks commands and reopens disposed panel; optional release does not lock',async()=>{
 const Module=require('node:module'),load=Module._load;
 const client=require('../out/releaseClient'),trust=require('../out/releaseTrust'),integrity=require('../out/extensionIntegrity'),device=require('../out/deviceId');
 const originals=[client.fetchSignedRelease,trust.readReleaseTrust,integrity.verifyExtensionIntegrity,device.getDevice];
 const interval=global.setInterval,clear=global.clearInterval,timeout=global.setTimeout;
 let mandatory=true,version='0.1.1',terminals=0,panels=[],commands=[],callbacks=[],period,onConfig,language='en',reveals=0;const registered={},status={show(){},dispose(){}};
 const vscode={StatusBarAlignment:{Left:1},workspace:{onDidChangeConfiguration(fn){onConfig=fn;return {dispose(){}};},getConfiguration:()=>({get:(key,f)=>key==='language'?language:f})},ViewColumn:{Active:1},TabInputText:class{},window:{createStatusBarItem:()=>status,terminals:[{dispose(){terminals++;}}],tabGroups:{all:[]},onDidOpenTerminal:()=>({dispose(){}}),onDidChangeActiveTextEditor:()=>({dispose(){}}),showInformationMessage:async()=>undefined,createWebviewPanel(){const panel={webview:{postMessage(){},onDidReceiveMessage(){}},reveal(){reveals++;},onDidDispose(fn){this.disposed=fn;},dispose(){this.disposed();}};panels.push(panel);return panel;}},commands:{registerCommand:(id,fn)=>{registered[id]=fn;return {dispose(){}};},async executeCommand(...args){commands.push(args);}}};
 try{
  client.fetchSignedRelease=async()=>({manifest:{version,mandatory},checkpoint:{sequence:2}});trust.readReleaseTrust=async()=>({fingerprint:'test',feed:'https://example.test/feed'});integrity.verifyExtensionIntegrity=async()=>{};device.getDevice=async()=>({});
  global.setInterval=(_fn,ms)=>{period=ms;return {unref(){}};};global.clearInterval=()=>{};global.setTimeout=fn=>{callbacks.push(fn);return {unref(){}};};
  for(const [required,sameVersion] of [[false,true],[false,false],[true,false]]){
   mandatory=required;version=sameVersion?'0.1.0':'0.1.1';panels=[];commands=[];
   try{Module._load=function(id,...args){return id==='vscode'?vscode:load.call(this,id,...args);};delete require.cache[require.resolve('../out/forcedUpdate')];const update=require('../out/forcedUpdate');const context={extension:{packageJSON:{version:'0.1.0'}},globalState:{get:()=>undefined,update:async()=>{}},subscriptions:[],extensionMode:2,extensionPath:'unused'};update.initializeForcedUpdate(context);
    if(required){await assert.rejects(update.assertActivityAllowed(),/güncelleyin|Update/);assert.equal(terminals,1);assert.ok(commands.some(c=>c[0]==='setContext'&&c[1]==='cude.updateLock'&&c[2]===true));assert.equal(panels.length,1);panels[0].dispose();callbacks.pop()();assert.equal(panels.length,2);assert.throws(()=>update.assertCommandAllowed());}
    else{await update.assertActivityAllowed();assert.equal(commands.length,0);assert.equal(panels.length,0);assert.equal(update.hasUpdatesPanel(),false);assert.doesNotThrow(()=>update.assertCommandAllowed());}
    assert.equal(status.command,'cude-ai.openUpdates');assert.match(status.text,sameVersion?/versions/:/circle-filled/);assert.equal(typeof registered['cude-ai.openUpdates'],'function');registered['cude-ai.openUpdates']();
    if(sameVersion)assert.match(panels.at(-1).webview.html,/Cude IDE is up to date · 0\.1\.0/);
    else assert.match(panels.at(-1).webview.html,/Update now/);
    assert.match(update.updateHtml('current'),/Check now/);assert.match(update.updateHtml('current',{version:'0.1.0'}),/Check now/);
    assert.match(update.updateCheckMessage(Error('The archive URL does not match the trusted release feed.'),true),/Güncelleme kanalı/);
    assert.match(update.updateCheckMessage(Error('The release signature is invalid.'),false),/signature/);
    assert.match(update.updateCheckMessage(new TypeError('fetch failed'),false),/Check your connection/);
    const beforeLanguageChange=reveals;language='tr';
    onConfig({affectsConfiguration:key=>key==='cude-ai.language'});
    assert.equal(reveals,beforeLanguageChange);
    assert.match(panels.at(-1).webview.html,/lang="tr"/);
    language='en';
    assert.equal(period,900000);for(const disposable of context.subscriptions)disposable.dispose();
   }finally{Module._load=load;}
  }
 }finally{[client.fetchSignedRelease,trust.readReleaseTrust,integrity.verifyExtensionIntegrity,device.getDevice]=originals;global.setInterval=interval;global.clearInterval=clear;global.setTimeout=timeout;require('../out/updatePolicy').activityGate.allow();}
});

test('patched workbench bridge rejects palette/API calls and toggles the overlay context',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const patch=fs.readFileSync(path.join(__dirname,'../../../build/patch-runtime.ps1'),'utf8');
 const hook=patch.match(/\$LockTo='([^']+)'/)[1];const classes=[];
 const context={cudeRejectUpdateCommand:reject,document:{body:{classList:{toggle:(...args)=>classes.push(args)}}}};
 const service=vm.runInNewContext('({'+hook+'return "executed";}})',context);service._logService={trace(){}};
 assert.equal(await service.executeCommand('workbench.action.files.save'),'executed');
 await service.executeCommand('setContext','cude.updateLock',true);
 await assert.rejects(service.executeCommand('workbench.action.files.save'),/update required/);
 await assert.rejects(service.executeCommand('workbench.action.terminal.new'),/update required/);
 assert.deepEqual(classes[0],['cude-update-lock',true]);
 await service.executeCommand('setContext','cude.updateLock',false);
 assert.equal(await service.executeCommand('workbench.action.debug.start'),'executed');
});

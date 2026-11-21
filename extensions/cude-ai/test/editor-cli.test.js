const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {EDITOR_CLIS,editorCliArgs,parseEditorCliModels}=require('../out/editorCli');
const {permitsLocalCli}=require('../out/localCliSecurity');

const calls=[];
let reply='proposal response',exitCode=0,active=0,maxActive=0;
const config={language:'en'};
const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:process.cwd()}}],getConfiguration:()=>({get:(k,d)=>config[k]??d,inspect:k=>({globalValue:config[k]})})},window:{showWarningMessage:async(_m,_o,allow)=>allow},env:{language:'en'}};
const original=Module._load;
let extension;
try{
  Module._load=function(id,...args){
    if(id==='vscode')return vscode;
    const loaded=original.call(this,id,...args);
    if(id!=='node:child_process')return loaded;
    return {...loaded,spawn:(command,args,options)=>{
      calls.push({command,args,options});active++;maxActive=Math.max(maxActive,active);
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
      setImmediate(()=>{child.stdout.end(typeof reply==='function'?reply(args):reply);child.stderr.end();active--;child.emit('exit',exitCode);child.emit('close',exitCode);});
      return child;
    }};
  };
  extension=require('../out/extension');
}finally{Module._load=original;}

test('editor CLI invocations preserve prompts and use the correct single-turn/model switches',()=>{
  const prompt='--model fake; $(command) "quote"\nsecond line';
  const first={ 'cursor-agent':'--print','kiro-cli':'chat','amp-cli':'--model','aider-cli':'--no-auto-commits','crush-cli':'run','goose-cli':'run','kilo-cli':'run','cline-cli':'--plan','roo-cli':'--print'};
  for(const spec of EDITOR_CLIS){
    const args=editorCliArgs(spec.id,prompt,'vendor/model:latest');
    assert.equal(args[0],first[spec.id],spec.id);
    assert.equal(args.at(-1),prompt);
    assert.equal(args[args.indexOf('--model')+1],'vendor/model:latest');
    assert.ok(!editorCliArgs(spec.id,'hello').includes('--model'));
    assert.throws(()=>editorCliArgs(spec.id,'hello','bad model\n--flag'),/Invalid/);
    assert.equal(permitsLocalCli(spec.id,'readonly'),false);
    assert.equal(permitsLocalCli(spec.id,'plan'),false);
    assert.equal(permitsLocalCli(spec.id,'full'),true);
  }
  assert.ok(editorCliArgs('aider-cli','hello').includes('--no-git'));
  assert.ok(editorCliArgs('aider-cli','hello').includes('--dry-run'));
});

test('model catalogs handle Cursor rows, Kiro JSON and Kilo provider IDs without saving noise',()=>{
  assert.deepEqual(parseEditorCliModels('cursor-agent','Available models:\n\u001b[32msonnet-4\u001b[0m - Sonnet\ngpt-5  GPT 5\nsonnet-4 - default'),['sonnet-4','gpt-5']);
  assert.deepEqual(parseEditorCliModels('kiro-cli',JSON.stringify({models:[{id:'auto'},{modelId:'claude-sonnet'},'auto',{id:'bad id'},{id:'sk-secret'}]})),['auto','claude-sonnet']);
  assert.deepEqual(parseEditorCliModels('kiro-cli','Sign in to list models'),[]);
  assert.deepEqual(parseEditorCliModels('aider-cli','Models:\n - openai/gpt-5\n - anthropic/claude-sonnet\nUse --model to pick'),['openai/gpt-5','anthropic/claude-sonnet']);
  assert.deepEqual(parseEditorCliModels('kilo-cli','Available models\nopenai/gpt-5\nprovider/model:free\nhttps://login.example\nnot a/model'),['openai/gpt-5','provider/model:free']);
});

test('inventory discovers all editor executables and Kiro alias, omits desktop launchers/missing agents',()=>{
  const directory=fs.mkdtempSync(path.join(process.cwd(),'dist','editor-cli-fixture-'));
  const env={PATH:process.env.PATH,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA};
  try{
    process.env.PATH=directory;process.env.APPDATA=directory;process.env.LOCALAPPDATA=directory;
    const files=EDITOR_CLIS.map(spec=>path.join(directory,(spec.id==='kiro-cli'?'kiro':spec.bin)+(process.platform==='win32'?'.exe':'')));
    for(const file of [...files,path.join(directory,'windsurf.exe'),path.join(directory,'zed.exe')])fs.writeFileSync(file,'fixture');
    const found=extension.scanLocalClis().filter(cli=>EDITOR_CLIS.some(spec=>spec.id===cli.id));
    assert.deepEqual(found.map(cli=>cli.id),EDITOR_CLIS.map(spec=>spec.id));
    assert.equal(found.find(cli=>cli.id==='kiro-cli').path,files[1]);
    for(const file of files)fs.unlinkSync(file);
    assert.deepEqual(extension.scanLocalClis().filter(cli=>EDITOR_CLIS.some(spec=>spec.id===cli.id)),[]);
  }finally{
    for(const [key,value] of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('real CLI runner passes model, returns text and errors, and never uses a shell',async()=>{
  for(const spec of EDITOR_CLIS){
    reply='proposal response';exitCode=0;
    const deltas=[];
    const result=await extension.runLocalCli({...spec,path:process.execPath},'question','full',undefined,text=>deltas.push(text),'vendor/model');
    assert.equal(result,reply,spec.id);assert.deepEqual(deltas,[reply]);
    const call=calls.at(-1);assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
    assert.equal(call.args[call.args.indexOf('--model')+1],'vendor/model');
  }
  exitCode=7;
  await assert.rejects(extension.runLocalCli({...EDITOR_CLIS[0],path:process.execPath},'question','full'),/code 7/);
  const count=calls.length;
  await assert.rejects(extension.runLocalCli({...EDITOR_CLIS[0],path:process.execPath},'question','readonly'),/restricted|read-only|mode/i);
  const controller=new AbortController();controller.abort();
  await assert.rejects(extension.runLocalCli({...EDITOR_CLIS[0],path:process.execPath},'question','full',controller.signal),/cancel/i);
  assert.equal(calls.length,count);assert.equal(maxActive,1);
});

test('Claude print prompt is separated from the variadic --tools option',async()=>{
  reply='response';exitCode=0;
  const cli={id:'claude-code',name:'Claude Code',model:'Claude Code CLI',path:process.execPath};
  for(const model of [undefined,'haiku']){
    await extension.runLocalCli(cli,'--tools-looking prompt','full',undefined,undefined,model);
    const args=calls.at(-1).args;
    assert.equal(args.at(-2),'--');
    assert.match(args.at(-1),/--tools-looking prompt$/);
    assert.equal(args[args.indexOf('--tools')+1],'');
    if(model)assert.equal(args[args.indexOf('--model')+1],model);
  }
});

test('loadCliModels queries installed catalogs serially and preserves cached models on failure',async()=>{
  const directory=fs.mkdtempSync(path.join(process.cwd(),'dist','editor-cli-models-'));
  const env={PATH:process.env.PATH,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA};
  const saved=new Map();const context={globalState:{get:(key,d)=>saved.get(key)??d,update:async(key,value)=>saved.set(key,value)}};
  try{
    process.env.PATH=directory;process.env.APPDATA=directory;process.env.LOCALAPPDATA=directory;
    for(const bin of ['cursor-agent','kiro-cli','aider','kilo'])fs.writeFileSync(path.join(directory,bin+(process.platform==='win32'?'.exe':'')),'fixture');
    exitCode=0;reply=args=>args.includes('--list-models')?(args[0]==='chat'?'["auto","claude-sonnet"]':args.includes('--no-git')?' - openai/gpt-5':'sonnet-4 - Sonnet'):'openai/gpt-5';
    const before=calls.length;
    await Promise.all([extension.loadCliModels(context),extension.loadCliModels(context)]);
    assert.deepEqual(saved.get('cliModels.cursor-agent'),['sonnet-4']);
    assert.deepEqual(saved.get('cliModels.kiro-cli'),['auto','claude-sonnet']);
    assert.deepEqual(saved.get('cliModels.kilo-cli'),['openai/gpt-5']);
    assert.deepEqual(saved.get('cliModels.aider-cli'),['openai/gpt-5']);
    assert.equal(calls.slice(before).filter(call=>call.args.includes('--list-models')).length,3);
    exitCode=1;reply='bad';await extension.loadCliModels(context);
    assert.deepEqual(saved.get('cliModels.cursor-agent'),['sonnet-4']);
    assert.equal(maxActive,1);
  }finally{
    for(const [key,value] of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;
    fs.rmSync(directory,{recursive:true,force:true});exitCode=0;reply='proposal response';
  }
});

'use strict';
// Live, serial proof runner. No publishing, commits, user configuration writes or auth-file copies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'dist/ide-qa-20261121/kanit');
const WORKSPACE = 'E:/rust/tmp/demo/kanit';
const BRIDGE = path.join(ROOT, 'extensions/cude-ai/media/bridge/cude-mcp.js');
const TIMEOUT = 120000;
const nativeSpawn = cp.spawn;
const secretValues = Object.entries(process.env).filter(([k,v]) => /KEY|TOKEN|PASSWORD|SECRET/.test(k) && v && v.length > 7).map(([,v]) => v);
function redact(value) {
  let text = String(value);
  for (const secret of secretValues) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(?:sk|ghp|gho|github_pat)-[\w-]{8,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[\w.\/-]+/gi, '$1[REDACTED]')
    .replace(/("(?:apiKey|api_key|access_token|refresh_token|password|token)"\s*:\s*")[^"]+/gi, '$1[REDACTED]');
}
function write(file, text) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); }
function sanitize(value) {
  if(typeof value==='string')return redact(value);
  if(Array.isArray(value))return value.map(sanitize);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));
  return value;
}
function classify(text) {
  if (/quota|rate.?limit|usage limit|429|credit|billing|402/i.test(text)) return 'hesap/kota';
  if (/auth|log.?in|sign.?in|api.?key|401|403|credential|not logged|not signed/i.test(text)) return 'hesap/kota';
  if (/timeout|timed out|cancelled|abort/i.test(text)) return 'zaman aşımı';
  return 'çalıştırma/protokol';
}
function failureSummary(text) {
  const kind=classify(text);
  const line=String(text).split(/\r?\n/).find(line=>/401|403|quota|usage limit|Auth method|error|timed?\s*out|abort|cancel/i.test(line) && !line.startsWith('[STARTUP]'));
  return kind+(line?' — '+redact(line).replace(/[|\r\n]/g,' ').slice(0,180):'');
}
function resolveInvocation(cli, args) {
  if (!cli.path.toLowerCase().endsWith('.cmd')) return {command:cli.path,args};
  const shim = fs.readFileSync(cli.path,'utf8');
  const entries = [...shim.matchAll(/"([^"\r\n]+\.(?:mjs|cjs|js|exe))"/gi)].map(m=>m[1]).filter(v=>!/node\.exe$|npm-prefix\.js$/i.test(v));
  const entry = entries.at(-1);
  if (!entry) throw new Error('Unresolved CLI shim: '+cli.path);
  const file = path.resolve(path.dirname(cli.path),entry.replace(/^%~?dp0%?[\\/]*/i,''));
  return /\.exe$/i.test(file) ? {command:file,args} : {command:process.execPath,args:[file,...args]};
}
async function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') await new Promise(resolve=>{
    const killer = nativeSpawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('close',resolve); killer.once('error',resolve);
  }); else child.kill('SIGKILL');
}
async function command(cli,args,env,cwd,timeout=TIMEOUT) {
  const inv=resolveInvocation(cli,args);
  return new Promise(resolve=>{
    const child=nativeSpawn(inv.command,inv.args,{env,cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',expired=false;
    const timer=setTimeout(()=>{expired=true;void killTree(child);},timeout);
    child.stdout.on('data',d=>{stdout=(stdout+d).slice(-1000000);});
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-1000000);});
    child.once('error',e=>{stderr+=e.message;});
    child.once('close',code=>{clearTimeout(timer);resolve({args,code,expired,stdout:redact(stdout),stderr:redact(stderr)});});
  });
}
function loadCude(workspace, state) {
  const docs=new Map();
  const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:workspace}}],getConfiguration:()=>({get:(key,d)=>key==='language'?'en':d})},
    window:{showWarningMessage:async(_m,_o,allow)=>allow},env:{language:'en'},
    Uri:{file:fsPath=>({fsPath,toString:()=>fsPath})},Position:class{},Range:class{},
    WorkspaceEdit:class{constructor(){this.ops=[];} createFile(uri){this.ops.push({uri,create:true});} insert(uri,_p,text){this.ops.push({uri,text});} replace(uri,_r,text){this.ops.push({uri,text});}}};
  vscode.workspace.openTextDocument=async uri=>{
    if(!docs.has(uri.fsPath))docs.set(uri.fsPath,{uri,text:fs.readFileSync(uri.fsPath,'utf8'),getText(){return this.text;},positionAt(){return{};},async save(){
      if(path.resolve(uri.fsPath)!==state.allowedFile)throw new Error('Unexpected proof write');
      fs.writeFileSync(uri.fsPath,this.text);return true;
    }});
    return docs.get(uri.fsPath);
  };
  vscode.workspace.applyEdit=async edit=>{
    for(const op of edit.ops){
      if(path.resolve(op.uri.fsPath)!==state.allowedFile)throw new Error('Unexpected proof edit');
      if(op.create && !fs.existsSync(op.uri.fsPath))fs.writeFileSync(op.uri.fsPath,'');
      const doc=await vscode.workspace.openTextDocument(op.uri);if(op.text!==undefined)doc.text=op.text;
    }return true;
  };
  // Instrument actual children, never substitute CLI responses. Inject only temporary runtime settings.
  const instrumented={...cp,spawn:(command,args,options)=>{
    const child=nativeSpawn(command,args,{...options,env:{...options?.env,...state.env}});
    if(/^taskkill(?:\.exe)?$/i.test(command))return child;
    state.children.add(child);
    const record={command,args,stdout:'',stderr:''};state.raw.push(record);
    child.stdout?.on('data',d=>record.stdout=(record.stdout+d).slice(-1000000));
    child.stderr?.on('data',d=>record.stderr=(record.stderr+d).slice(-1000000));
    child.once('close',code=>{record.code=code;state.children.delete(child);});
    return child;
  }};
  const original=Module._load;
  try{
    Module._load=function(id,...args){if(id==='vscode')return vscode;if(id==='node:child_process')return instrumented;return original.call(this,id,...args);};
    return {...require('../extensions/cude-ai/out/extension'),...require('../extensions/cude-ai/out/agentLoop'),
      ...require('../extensions/cude-ai/out/desktopBridge'),...require('../extensions/cude-ai/out/desktopBridgeConfig'),
      ...require('../extensions/cude-ai/out/opencodeServer')};
  }finally{Module._load=original;}
}
function passedInbound(calls, output, nonce, readPath) {
  return calls.some(c=>c.tool==='workspace_info' && c.ok) &&
    calls.some(c=>c.tool==='read_file' && c.args?.path===readPath && c.ok) && output.includes(nonce);
}
async function bridgeFixture(runDir, workspace, nonce) {
  const calls=[];
  let readPath='integration-read-proof.txt',marker=nonce;
  const token=crypto.randomBytes(24).toString('hex');secretValues.push(token);
  let real;
  try { real=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.cude-ide/bridge.json'),'utf8')); } catch {}
  const request=async(tool,args)=>{
    if(!real) {
      if(tool==='workspace_info')return {ok:true,text:`Fixture project: ${workspace}`};
      const full=path.resolve(workspace,String(args?.path||''));
      if(tool!=='read_file'||full!==path.join(workspace,'integration-read-proof.txt'))return {ok:false,text:'Only proof reads permitted'};
      return {ok:true,text:fs.readFileSync(full,'utf8')};
    }
    try{
      const response=await fetch(`http://127.0.0.1:${Number(real.port)}/tool`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+real.token},body:JSON.stringify({tool,args}),signal:AbortSignal.timeout(5000)});
      const body=await response.json();return {ok:response.ok,text:String(body.text||body.error||'')};
    }catch(e){return {ok:false,text:e.message};}
  };
  // Never log a real bridge token; proxy records tool calls, without authorization headers.
  if(real){
    const probe=await request('workspace_info',{});if(!probe.ok)real=undefined;
    else {
      // A real Cude window can have a different workspace. Read existing, non-secret project
      // metadata there instead of writing a nonce outside the authorized proof directory.
      for(const candidate of ['package.json','README.md']){
        const read=await request('read_file',{path:candidate,start_line:1,end_line:12});
        const line=read.ok&&read.text.split(/\r?\n/).find(line=>/^\d+:\s*\S.{6,}/.test(line));
        if(line){readPath=candidate;marker=line;break;}
      }
    }
  }
  const server=http.createServer((req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
    let body='';req.on('data',d=>body+=d);req.on('end',async()=>{
      try{const {tool,args}=JSON.parse(body);const result=['workspace_info','read_file'].includes(tool)?await request(tool,args):{ok:false,text:'Read-only proof proxy'};
        calls.push({tool,args,ok:result.ok,text:result.text});res.writeHead(result.ok?200:400,{'content-type':'application/json'});res.end(JSON.stringify({text:result.text}));
      }catch(e){res.writeHead(500);res.end('{}');}
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const descriptor=path.join(runDir,'bridge.json');write(descriptor,JSON.stringify({port:server.address().port,token}));
  return {calls,descriptor,readPath,marker,mode:real?'gerçek Cude köprüsü (salt okunur gözlem vekili)':'geçici sahte HTTP köprüsü + gerçek cude-mcp.js',
    close:async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(descriptor,{force:true});},request};
}
async function stdioProbe(entry, env, readPath='integration-read-proof.txt') {
  const child=nativeSpawn(entry.command,entry.args,{env:{...env,...entry.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer='',stderr='';const pending=new Map();let next=0;
  child.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const j=JSON.parse(line);const wait=pending.get(j.id);if(wait){pending.delete(j.id);wait(j);}}catch{}}});
  child.stderr.on('data',d=>stderr+=d);
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout '+stderr));},10000);pending.set(id,j=>{clearTimeout(timer);j.error?reject(new Error(JSON.stringify(j.error))):resolve(j.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  try{
    const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'cude-proof',version:'1'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const info=await rpc('tools/call',{name:'workspace_info',arguments:{}});
    const read=await rpc('tools/call',{name:'read_file',arguments:{path:readPath}});
    if(info.isError||read.isError)throw new Error(JSON.stringify({info,read}));
    return {init,info,read};
  }finally{child.stdin.end();await killTree(child);}
}
async function main() {
  fs.mkdirSync(BASE,{recursive:true});fs.mkdirSync(WORKSPACE,{recursive:true});
  const runDir=fs.mkdtempSync(path.join(BASE,'integration-'));
  if(!process.argv.includes('--inventory')){
    console.log('Compiling Cude extension');
    const compiled=cp.spawnSync(process.execPath,[path.join(ROOT,'extensions/cude-ai/node_modules/typescript/bin/tsc'),'-p',path.join(ROOT,'extensions/cude-ai')],{cwd:ROOT,windowsHide:true,shell:false,encoding:'utf8'});
    write(path.join(runDir,'compile.log'),redact((compiled.stdout||'')+(compiled.stderr||'')));
    if(compiled.status!==0)throw new Error('Cude compilation failed: '+(compiled.error?.message||compiled.status));
  }
  const workspace=path.resolve(WORKSPACE);
  const state={children:new Set(),raw:[],env:{},allowedFile:''};
  const cude=loadCude(workspace,state);
  const clis=cude.scanLocalClis();
  if(process.argv.includes('--inventory')){console.log(JSON.stringify(clis,null,2));return;}
  const rows=[];
  const versions=new Map();
  let opencodeModel=process.env.CUDE_PROOF_OPENCODE_MODEL||'opencode/big-pickle';
  // CUDE_PROOF_REAL_CODEX=1 lets Codex use its normal sign-in (read only; ~/.codex is never written by this script).
  const env={...process.env,CI:'1',NO_COLOR:'1',...(process.env.CUDE_PROOF_REAL_CODEX==='1'?{}:{CODEX_HOME:path.join(runDir,'codex-home')})};
  if(env.CODEX_HOME)fs.mkdirSync(env.CODEX_HOME,{recursive:true});
  const save=(name,value)=>{const file=path.join(runDir,name+'.json');write(file,JSON.stringify(sanitize(value),null,2));return path.relative(ROOT,file).split(path.sep).join('/');};
  let fixture;
  try {
    for(const cli of clis){console.log('Version: '+cli.id);const result=await command(cli,['--version'],env,workspace,30000);versions.set(cli.id,result.stdout.trim()||result.stderr.trim());save(cli.id+'-version',result);}
    const opencode=clis.find(c=>c.id==='opencode-cli');
    if(opencode){
      const catalog=await command(opencode,['models','opencode'],env,workspace,30000);
      const names=catalog.stdout.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^opencode\/[\w./:@-]+$/.test(s));
      if(!process.env.CUDE_PROOF_OPENCODE_MODEL)opencodeModel=names.includes(opencodeModel)?opencodeModel:(names.find(s=>/-free$/.test(s))||opencodeModel);
      save('opencode-model-catalog',{...catalog,selected:opencodeModel});
    }
    // Nonce is fresh on every run; a stale disk file or a claimed success never passes.
    for(const cli of [...clis,...(clis.some(c=>c.id==='opencode-cli')?[{...clis.find(c=>c.id==='opencode-cli'),id:'opencode-server'}]:[])]){
      console.log('Cude -> '+cli.id);state.raw=[];state.env=env.CODEX_HOME?{CODEX_HOME:env.CODEX_HOME}:{};
      const nonce=crypto.randomBytes(12).toString('hex');const name=`proof-${cli.id}.txt`;state.allowedFile=path.join(workspace,name);
      const events=[],controller=new AbortController();let server;
      const timer=setTimeout(()=>{controller.abort();for(const child of state.children)void killTree(child);},TIMEOUT);
      let result,error;
      try{
        if(cli.id==='opencode-server')server=new cude.OpencodeServer(args=>resolveInvocation(cli,args),()=>workspace);
        result=await cude.runAgentLoop({task:`Use Cude write_file to write ${name} with exactly this content: CUDE_PROOF_${nonce}. Then finish. Only this file may be changed. Return tool JSON; do not use your own native tools.`,workspace,permission:'ask',maxSteps:4,maxMinutes:2,signal:controller.signal,images:false,
          chat:async(messages,signal)=>{
            const prompt=messages.map(m=>`${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
            const reply=server?await server.chat(opencodeModel,messages,signal):await cude.runLocalCli(cli,prompt,'full',signal,undefined,cli.id==='opencode-cli'?opencodeModel:undefined);
            const action=cude.parseAction(reply);
            if(action?.tool && (!['read_file','write_file'].includes(action.tool)||action.args?.path!==name))throw new Error('Proof rejected unexpected tool/path');
            return reply;
          },confirm:async()=>true,events:{activity:(label,detail)=>events.push({label,detail})},text:key=>key});
      }catch(e){error=e.message;}finally{clearTimeout(timer);server?.stop();await Promise.all([...state.children].map(killTree));}
      const expected=`CUDE_PROOF_${nonce}`;const ok=fs.existsSync(state.allowedFile)&&fs.readFileSync(state.allowedFile,'utf8')===expected;
      const log=save(cli.id+'-outbound',{path:state.allowedFile,expected,ok,result,error,events,processes:state.raw});
      const failure=[error,result?.final,...state.raw.map(r=>r.stdout+'\n'+r.stderr)].join('\n');
      rows.push({id:cli.id,label:cli.name||cli.id,version:versions.get(cli.id==='opencode-server'?'opencode-cli':cli.id),out:ok,outLog:log,outNote:ok?'Dosya diskte birebir doğrulandı':failureSummary(failure),in:false,inNote:'Henüz denenmedi'});
    }
    const nonce=crypto.randomBytes(12).toString('hex');
    write(path.join(workspace,'integration-read-proof.txt'),'CUDE_READ_'+nonce);
    fixture=await bridgeFixture(runDir,workspace,nonce);
    const bridgeEnv={CUDE_BRIDGE_FILE:fixture.descriptor};
    const entry={command:process.execPath,args:[BRIDGE],env:bridgeEnv};
    try{save('bridge-preflight',await stdioProbe(entry,env,fixture.readPath));}
    catch(e){save('bridge-preflight',{error:e.message,bridgeMode:fixture.mode});}
    for(const cli of clis){
      console.log(cli.id+' -> Cude');
      const row=rows.find(r=>r.id===cli.id);const config=path.join(runDir,cli.id+'-mcp.json');
      write(config,JSON.stringify({mcpServers:{'cude-ide':entry}},null,2));
      const prompt=`Use only the cude-ide MCP tools. Call workspace_info and read_file with path ${fixture.readPath}. Return both tool results verbatim, including the file content. Do not use shell or local file tools.`;
      let args,localEnv={...env,...bridgeEnv};
      if(cli.id==='claude-code')args=['-p','--output-format','json','--strict-mcp-config','--mcp-config',config,'--tools','','--allowedTools','mcp__cude-ide__workspace_info,mcp__cude-ide__read_file','--max-turns','4','--',prompt];
      else if(cli.id==='codex-cli')args=['exec','--json','--sandbox','read-only','--skip-git-repo-check','-c',`mcp_servers.cude-ide.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.cude-ide.args=${JSON.stringify([BRIDGE])}`,'-c',`mcp_servers.cude-ide.env=${'{ CUDE_BRIDGE_FILE = '+JSON.stringify(fixture.descriptor)+' }'}`,prompt];
      else if(cli.id==='opencode-cli'){
        localEnv.OPENCODE_CONFIG_CONTENT=JSON.stringify({mcp:{'cude-ide':{type:'local',command:[process.execPath,BRIDGE],environment:bridgeEnv,enabled:true}},permission:{'*':'deny','cude-ide_*':'allow'}});
        args=['run','--format','json','-m',opencodeModel,prompt];
      }else if(cli.id==='gemini-cli'){
        const settings=path.join(runDir,'gemini-settings.json');write(settings,JSON.stringify({mcpServers:{'cude-ide':entry}}));localEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH=settings;
        args=['-p',prompt,'--allowed-mcp-server-names','cude-ide','--allowed-tools','mcp__cude-ide__workspace_info,mcp__cude-ide__read_file'];
      }
      const start=fixture.calls.length;
      let result=args?await command(cli,args,localEnv,workspace):{stderr:'No reviewed runtime MCP flag for installed CLI',code:null};
      const calls=fixture.calls.slice(start);
      const ok=result.code===0&&passedInbound(calls,result.stdout||'',fixture.marker,fixture.readPath);
      row.in=ok;row.inNote=ok?'workspace_info + read_file çağrıları ve yeni içerik doğrulandı':failureSummary([result.stderr,result.stdout,result.expired?'timeout':''].join('\n'));
      row.inLog=save(cli.id+'-inbound',{...result,calls,ok,bridgeMode:fixture.mode});
    }
    const serverRow=rows.find(r=>r.id==='opencode-server');
    if(serverRow){
      console.log('opencode-server -> Cude');
      const cli=clis.find(c=>c.id==='opencode-cli');
      const mcp={'cude-ide':{type:'local',command:[process.execPath,BRIDGE],environment:bridgeEnv,enabled:true}};
      // The usual Cude request denies native tools. This isolated reverse-direction session enables
      // only the two read-only MCP tools through a runtime override, without editing user settings.
      state.env={...(env.CODEX_HOME?{CODEX_HOME:env.CODEX_HOME}:{}),OPENCODE_CONFIG_CONTENT:JSON.stringify({mcp,permission:{'*':'deny','cude-ide_*':'allow'}})};
      state.raw=[];const start=fixture.calls.length;
      const server=new cude.OpencodeServer(args=>resolveInvocation(cli,args),()=>workspace);
      const controller=new AbortController();
      const timer=setTimeout(()=>{controller.abort();for(const child of state.children)void killTree(child);},TIMEOUT);
      let output='',error;
      try{output=await server.chat(opencodeModel,[{role:'user',content:`Use the cude-ide MCP tools workspace_info and read_file (path ${fixture.readPath}). Return both results verbatim including the file content. No shell or native file tools.`}],controller.signal);}
      catch(e){error=e.message;}
      finally{clearTimeout(timer);server.stop();await Promise.all([...state.children].map(killTree));state.env={};}
      const calls=fixture.calls.slice(start);
      serverRow.in=passedInbound(calls,output,fixture.marker,fixture.readPath);
      serverRow.inNote=serverRow.in?'Kalıcı süreçten workspace_info + read_file doğrulandı':failureSummary([error,output,...state.raw.map(r=>r.stdout+'\n'+r.stderr)].join('\n'));
      serverRow.inLog=save('opencode-server-inbound',{output,error,calls,ok:serverRow.in,processes:state.raw,bridgeMode:fixture.mode});
    }
    // Desktop configuration contracts are tested in isolated files. This is not a live desktop session claim.
    const desktop=[];
    for(const target of cude.targets()){
      const file=path.join(runDir,'desktop-configs',target.id+'.json');const copy={...target,file};
      await cude.writeBridgeConfig(copy,entry);
      const text=fs.readFileSync(file,'utf8');const configured=cude.bridgeConfigured(copy,text);
      const json=target.schema==='continue'?require('../extensions/cude-ai/node_modules/yaml').parse(text):JSON.parse(text);
      const item=target.schema==='continue'?json.mcpServers.find(s=>s.name==='cude-ide'):json[target.key||'mcpServers']['cude-ide'];
      const decoded=target.schema==='opencode'?{command:item.command[0],args:item.command.slice(1),env:item.environment}:item;
      let probe,protocolOk=false;
      try{probe=await stdioProbe(decoded,env,fixture.readPath);protocolOk=probe.read.content.some(part=>part.type==='text'&&part.text.includes(fixture.marker));}catch(e){probe={error:e.message};}
      const installed=(target.detect||[path.dirname(target.file)]).some(p=>fs.existsSync(p));
      desktop.push({id:target.id,label:target.label,installed,configured,protocolOk,scope:'Yalnız yapılandırma biçimi + bağımsız stdio istemcisi; masaüstü uygulaması açılmadı',log:save('desktop-'+target.id,{configured,protocolOk,installed,probe,config:text})});
    }
    for(const id of ['qwen-code','cursor-agent','kiro-cli','amp-cli','aider-cli','crush-cli','goose-cli','kilo-cli','cline-cli','roo-cli'])if(!clis.some(c=>c.id===id))rows.push({id,label:id,version:'kurulu değil',out:false,in:false,outNote:'kurulu değil',inNote:'kurulu değil'});
    const data={timestamp:new Date().toISOString(),runDir,bridgeMode:fixture.mode,rows,desktop};
    save('matrix',data);
    const cell=(ok,note,log)=>`${ok?'✓':'✗'} ${note}${log?` ([ham çıktı](${log}))`:''}`;
    const md=['# Entegrasyon kanıtı — 21 Kasım 2026','',`Son koşum: ${data.timestamp}. Tekrar: \`node build/integration-proof.js\`.`,
      '', 'Cude yönü: gerçek out/agentLoop.js + runLocalCli / OpencodeServer.chat; VS Code belge ve onay arayüzü test adaptörüdür, modeller ve çocuk süreçler gerçektir. Başarı yalnız bu koşumun rastgele içeriği diskte birebir bulunduğunda yazılır.',
      '', `Ters yön köprü türü: **${fixture.mode}**. Başarı için köprüde iki gerçek araç çağrısı ve CLI yanıtında okunan içerik birlikte aranır. Sahte köprüde her koşumda yeni rastgele içerik; gerçek pencerede mevcut package.json/README.md kullanılır.`,
      '', (env.CODEX_HOME?'Codex CODEX_HOME çalışma alanında boştur; ~/.codex okunmaz, kopyalanmaz ve yazılmaz. Bu nedenle o dizindeki mevcut oturum kullanılmaz.':'Codex kendi normal oturumuyla çalıştı; ~/.codex yalnız okundu, yazılmadı.')+' Gemini MCP ayarı geçici GEMINI_CLI_SYSTEM_SETTINGS_PATH içindedir (kurulu sürümün settings.js kaynağıyla doğrulandı). Başka uygulamaların anahtar dosyaları okunmaz/kopyalanmaz; normal CLI oturumu kendi erişimini yönetir. Hesap/kota engeli başarı sayılmaz.',
      '', '| Araç | Sürüm | Cude→araç | Araç→Cude | Not |','|---|---|---|---|---|',
      ...rows.map(r=>`| ${r.label} (${r.id}) | ${String(r.version||'—').replace(/[\r\n|]/g,' ').slice(0,100)} | ${cell(r.out,r.outNote,r.outLog)} | ${cell(r.in,r.inNote,r.inLog)} | ${r.id==='opencode-server'?'Aynı kalıcı süreç ajan adımlarında yeniden kullanılır; koşum sonunda kapatılır.':''} |`),
      '', '## Masaüstü MCP biçimleri', '', 'Bu tablo canlı uygulama/model oturumunu kanıtlamaz. Cude üretim yapılandırma yazıcısı geçici dosyaya yazar; biçimden çözülen komut gerçek cude-mcp.js sürecini açıp iki okuma çağrısını yapar. Kullanıcı ayarları değiştirilmez.',
      '', '| Uygulama | Algılama | Biçim + stdio protokol kanıtı | Canlı uygulama oturumu |','|---|---|---|---|',
      ...desktop.map(d=>`| ${d.label} | ${d.installed?'konum mevcut (sürüm kanıtı değildir)':'bulunamadı'} | ${cell(d.configured&&d.protocolOk,'workspace_info + read_file',d.log)} | ✗ Bu koşumda yapılmadı |`),
      '', 'Eksik canlı sonuçlar tablodaki ✗ hücreleridir. Biçim testleri ve sahte HTTP köprüsü canlı masaüstü entegrasyonu olarak sunulmaz. Ham çıktılar anahtar redaksiyonundan geçirilir.'];
    write(path.join(ROOT,'INTEGRATION_KANIT_21KAS.md'),md.join('\n')+'\n');
    console.log('Matrix: INTEGRATION_KANIT_21KAS.md');
  }finally{await Promise.all([...state.children].map(killTree));if(fixture)await fixture.close();}
}
module.exports={classify,passedInbound,redact,sanitize,resolveInvocation};
if(require.main===module)main().catch(error=>{console.error(redact(error.stack));process.exitCode=1;});

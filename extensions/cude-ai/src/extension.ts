import {connectLocalServer,installedLocalServer,localRuntimeSettings,localRuntimeFailure} from './localConnection';
import {CommandApprovals} from './commandApproval';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SemanticProjects, hasCodebaseMention, codebaseQuery } from './semanticProject';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { runAcpPrompt } from './acp';
import { registerReleaseCommands } from './releaseCommands';
import { initializeForcedUpdate, assertActivityAllowed, assertCommandAllowed, hasUpdatesPanel, observeUpgradeResponse } from './forcedUpdate';
import { getDevice } from './deviceId';
import { deviceFetch } from './deviceTransport';
import {startHeartbeat,stopHeartbeat} from './heartbeat';
import { fetchPoolQuota, parsePoolAccount, type PoolQuotaView } from './poolQuota';
import { boundedMcpBody, configuredMcpHeaders, mcpEnvironment, processEnvironment } from './mcpSecurity';
import { localCliAuth, permitsLocalCli, type CudeLocalCli } from './localCliSecurity';
import { EDITOR_CLIS, editorCliArgs, parseEditorCliModels, validCliModel, type EditorCliId } from './editorCli';
import { credentialSlot, emptyProviderCredentials, mergeImportedProfiles, readProviderCredentials, writeProviderCredentials } from './providerCredentials';
import { PROVIDER_PRESETS } from './providerPresets';
import { fetchPoolDirectory, pickHealthyPool } from './poolDirectory';
import { connectDesktopApps, desktopBridgeActive, startBridge, targets as desktopBridgeTargets } from './desktopBridge';
import { activateAppBridge, appBridgeState } from './appBridge';
import { OpencodeServer, splitOpencodeModel } from './opencodeServer';
import { activateHealth } from './healthUi';
import { createCudeSettings } from './cudeSettings';
import { chooseAndroidSdk, openAndroidTools } from './androidUi';
import { readReleaseTrust } from './releaseTrust';
import { cancelRecording, discardRecording, dictateLocally, speak, startRecording, stopRecording, stopSpeaking } from './voice';
import { runAgentLoop, runTool, type LoopCheckpoint, type LoopOptions } from './agentLoop';
import { callProvider, WireHttpError, type WireText } from './providerWire';
import { I18N, normalizeLanguage, t, type Language, type MessageKey } from './i18n';
import { registerEditorFeatures } from './editorFeatures';
import { ModelCatalog, type ModelRecord } from './modelCatalog';
import { EditorLanguageModels } from './editorLm';
import { importEditorProviders, scanEditorProviders, localEditorModels } from './editorProviderImport';
import { FREE_PROVIDERS, isFreeCatalogModel } from './freeModels';
import { autoCuetsDecision, runCuets, runCuetsLoop, resumeTaskState, isResumable, isContinueCommand, isValidTaskId, newTaskId, parseTaskState, serializeTaskState, taskMarkdown, taskProgress, detectVerificationCommands, boundOutput, redactLikelySecrets, type CuetsSubtask, type CuetsTaskState, type CuetsStep, type CuetsVerification, type CuetsVerifyCommand, type CuetsApplyResult, type CuetsRoundInfo } from './cuets';
export { autoCuetsDecision, mapLimit, parsePlan, shouldAutoCuets } from './cuets';
import { chooseRoute, classifyTask, estimateUsage, isFallbackError, withFallback, type RouteCandidate, type RouteKind, type RoutePreference } from './router';
import { detectDevice, setLocalModelsLanguage, downloadHuggingFaceModel, inspectHuggingFaceModel, listDownloadedModelsFromRoots, recommendedLocalModels, resolveHuggingFaceFile, searchHuggingFace, type HuggingFaceModel, type LocalModelFile } from './localModels';
import { fillTemplate, hasHiddenCommandCharacters, isSecretPath, maskHeaders, maskProxy, redactCredentialLiterals, redactSecrets, restoreMaskedHeaders, restoreMaskedProxy, sameOrigin } from './security';
import * as net from 'node:net';

type AgentStep={id:string;title:string;kind:'file'|'command'|'analysis'|'mcp';path?:string;content?:string;command?:string;server?:string;tool?:string;arguments?:Record<string,unknown>};
type SubagentResult={id:string;title:string;task:string;status:'done'|'failed';output:string};
type Agent = { id: string; title: string; status: 'queued' | 'running' | 'done' | 'failed'; output?: string; workspace?:string;workspacePath?:string;worktreePath?:string;baseBranch?:string;activity?:string;startedAt?:number;finishedAt?:number;permission?:'ask'|'auto'|'plan'|'readonly'|'full';model?:string;steps?:AgentStep[];artifacts?:string[];acceptedFiles?:string[];rejectedFiles?:string[];subagents?:SubagentResult[] };
type ChatSession={id:string;title:string;workspace:string;messages:Array<{role:'user'|'assistant';content:string}>};
type HistoryPick={label:string;description:string;pickType:'chat';chat:ChatSession}|{label:string;description:string;pickType:'agent';agent:Agent};
type AgentTreeNode={kind:'project'|'session';project:string;agent?:Agent};
type ProviderProfile={id:string;name:string;provider:string;baseUrl:string;models:string[];modelEfforts?:Record<string,string[]>;organization?:string;project?:string;deployment?:string;customHeaders?:Record<string,string>;timeout?:number;proxy?:string};
type LocalModelRecord={name:string;path:string;size:number;repo?:string;license?:string;sha256?:string};
type LocalCliId=CudeLocalCli;
type LocalCli={id:LocalCliId;name:string;bin:string;path:string;model:string};
const SECRET = 'cude-ai.apiKey';
const proposalTexts=new Map<string,string>();
class ProposalContentProvider implements vscode.TextDocumentContentProvider {
  onDidChange?:vscode.Event<vscode.Uri>;
  provideTextDocumentContent(uri:vscode.Uri){return proposalTexts.get(uri.path.replace(/^\//,''))||'';}
  set(id:string,text:string){proposalTexts.set(id,text);}
}

function bundledCodexCandidates(local:string):string[]{const base=path.join(local,'OpenAI','Codex','bin'),list:Array<{file:string;time:number}>=[];const add=(file:string)=>{try{const stat=fsSync.statSync(file);if(stat.isFile())list.push({file,time:stat.mtimeMs});}catch{}};add(path.join(base,'codex.exe'));try{for(const entry of fsSync.readdirSync(base,{withFileTypes:true}))if(entry.isDirectory())add(path.join(base,entry.name,'codex.exe'));}catch{}return list.sort((a,b)=>b.time-a.time).map(item=>item.file);}
let localCliCache:{at:number;list:LocalCli[]}|undefined;
function localCliInventory(force=false):LocalCli[]{if(!force&&localCliCache&&Date.now()-localCliCache.at<120000)return localCliCache.list;const list=scanLocalClis();localCliCache={at:Date.now(),list};return list;}
export function scanLocalClis():LocalCli[]{
  const win=process.platform==='win32',tools:Array<{id:LocalCliId;name:string;bin:string;model:string;aliases?:readonly string[]}>=[
    {id:'claude-code',name:'Claude Code',bin:'claude',model:'Claude Code CLI'},
    {id:'codex-cli',name:'Codex',bin:'codex',model:'Codex CLI'},
    {id:'opencode-cli',name:'OpenCode',bin:'opencode',model:'OpenCode CLI'},{id:'gemini-cli',name:'Gemini CLI',bin:'gemini',model:'Gemini CLI'},{id:'qwen-code',name:'Qwen Code',bin:'qwen',model:'Qwen Code CLI'},...EDITOR_CLIS
  ];
  const home=os.homedir(),appData=process.env.APPDATA||path.join(home,'AppData','Roaming'),local=process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),found:LocalCli[]=[];
  for(const item of tools){const candidates:string[]=item.id==='codex-cli'&&win?bundledCodexCandidates(local):[];for(const bin of [item.bin,...(item.aliases||[])]){
    for(const dir of String(process.env.PATH||process.env.Path||'').split(path.delimiter).filter(path.isAbsolute))for(const command of win?[`${bin}.exe`,`${bin}.cmd`,bin]:[bin])candidates.push(path.join(dir,command));
    if(win){for(const extension of ['.cmd','.exe',''])candidates.push(path.join(appData,'npm',bin+extension));candidates.push(path.join(local,'Programs','OpenCode',bin+'.exe'),path.join(local,'Programs','OpenCode',bin+'.cmd'),path.join(local,'Programs','OpenCode',bin));}
    for(const extension of ['','.cmd','.exe'])candidates.push(path.join(home,'.local','bin',bin+extension));
    }
    const seen=new Set<string>();for(const candidate of candidates){const normalized=path.resolve(candidate).toLowerCase();if(seen.has(normalized))continue;seen.add(normalized);try{if(!fsSync.existsSync(candidate)||!fsSync.statSync(candidate).isFile())continue;found.push({...item,path:path.resolve(candidate)});break;}catch{}}
  }
  return found;
}

function localCliProfile(cli:LocalCli):ProviderProfile{return{id:`cude-cli-${cli.id}`,name:`${cli.name} · ${tr('local.agentSuffix')}`,provider:'local-cli',baseUrl:'',models:[cli.model,...(cli.id==='opencode-cli'?opencodeModelList:cli.id==='codex-cli'?codexModelList:cli.id==='claude-code'?CLAUDE_CODE_MODELS:editorCliModelList.get(cli.id)||[])]};}
// OpenCode exposes every model it is signed in to (`opencode models`); Cude lists the chat-capable ones so they run inside Cude.
let opencodeModelList:string[]=[];let opencodeModelsLoading:Promise<void>|undefined;
const OPENCODE_NON_CHAT=/flux|tts|speech|whisper|embed|rerank|guard|safety|detection|bevformer|cosmos|paligemma|diffusion|transfer|parakeet|canary|riva|audio2|asr|ocr|segment|\bclip\b|sdxl|stable-diffusion/i;
function loadOpencodeModels(context?:vscode.ExtensionContext){
  if(opencodeModelsLoading)return opencodeModelsLoading;
  const cached=context?.globalState.get<string[]>('opencodeModels',[])||[];if(cached.length&&!opencodeModelList.length)opencodeModelList=cached;
  const cli=localCliInventory().find(item=>item.id==='opencode-cli');if(!cli)return Promise.resolve();
  opencodeModelsLoading=new Promise<void>(resolve=>{
    let out='';let child:ReturnType<typeof spawn>;
    try{const inv=resolveLocalCliInvocation(cli,['models']);child=spawn(inv.command,inv.args,{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore'],env:{...process.env,CI:'1'}});}catch{opencodeModelsLoading=undefined;resolve();return;}
    let killed=false;const timer=setTimeout(()=>{killed=true;try{child.kill();}catch{}},150000);timer.unref?.();
    child.stdout?.on('data',(d:Buffer)=>{out+=d.toString('utf8');});
    // A killed or failed run gives a partial list; keep the previous one instead of saving it.
    const done=(code?:number|null)=>{clearTimeout(timer);if(killed||(typeof code==='number'&&code!==0)){opencodeModelsLoading=undefined;resolve();return;}const list=[...new Set(out.split(/\r?\n/).map(x=>x.trim()).filter(x=>/^[\w.-]+\/[\w./:@-]+$/.test(x)&&!OPENCODE_NON_CHAT.test(x)))];if(list.length){opencodeModelList=list.slice(0,400);void context?.globalState.update('opencodeModels',opencodeModelList);}opencodeModelsLoading=undefined;resolve();};
    child.on('error',()=>done(1));child.on('close',code=>done(code));
  });
  return opencodeModelsLoading;
}
// Codex CLI publishes its model catalog (`codex debug models`); Claude Code accepts these model names/aliases.
let codexModelList:string[]=[];let codexModelsLoading:Promise<void>|undefined;
const CLAUDE_CODE_MODELS=['opus','sonnet','haiku','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5','claude-fable-5-2'];
function loadCodexModels(context?:vscode.ExtensionContext){
  if(codexModelsLoading)return codexModelsLoading;
  const cached=context?.globalState.get<string[]>('codexModels',[])||[];if(cached.length&&!codexModelList.length)codexModelList=cached;
  const cli=localCliInventory().find(item=>item.id==='codex-cli');if(!cli)return Promise.resolve();
  codexModelsLoading=new Promise<void>(resolve=>{
    let out='';let child:ReturnType<typeof spawn>;
    try{const inv=resolveLocalCliInvocation(cli,['debug','models']);child=spawn(inv.command,inv.args,{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore'],env:{...process.env,CI:'1'}});}catch{codexModelsLoading=undefined;resolve();return;}
    let killed=false;const timer=setTimeout(()=>{killed=true;try{child.kill();}catch{}},60000);timer.unref?.();
    child.stdout?.on('data',(d:Buffer)=>{if(out.length<4_000_000)out+=d.toString('utf8');});
    const done=(code?:number|null)=>{clearTimeout(timer);codexModelsLoading=undefined;if(killed||(typeof code==='number'&&code!==0)){resolve();return;}
      try{const json=JSON.parse(out.slice(out.indexOf('{')));const list=(json.models||[]).filter((m:any)=>m&&typeof m.slug==='string'&&m.visibility!=='hide'&&m.visibility!=='hidden').sort((a:any,b:any)=>(a.priority??99)-(b.priority??99)).map((m:any)=>String(m.slug)).filter((slug:string)=>/^[\w.:-]{1,80}$/.test(slug));if(list.length){codexModelList=[...new Set<string>(list)].slice(0,60);void context?.globalState.update('codexModels',codexModelList);}}catch{}
      resolve();};
    child.on('error',()=>done(1));child.on('close',code=>done(code));
  });
  return codexModelsLoading;
}
const editorCliModelList=new Map<string,string[]>();
let cliModelsLoading:Promise<void>|undefined;
async function loadEditorCliModels(context?:vscode.ExtensionContext){
  for(const spec of EDITOR_CLIS){
    const cached=context?.globalState.get<string[]>('cliModels.'+spec.id,[])||[];
    if(!editorCliModelList.has(spec.id))editorCliModelList.set(spec.id,cached.filter(validCliModel));
    if(!('modelsArgs' in spec))continue;
    const cli=localCliInventory().find(item=>item.id===spec.id);if(!cli)continue;
    await new Promise<void>(resolve=>{
      let child:ReturnType<typeof spawn>,output='',failed=false,settled=false;
      const done=(code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);
        if(!failed&&code===0){const models=parseEditorCliModels(spec.id,output);if(models.length){editorCliModelList.set(spec.id,models);void context?.globalState.update('cliModels.'+spec.id,models);}}resolve();};
      try{const inv=resolveLocalCliInvocation(cli,[...spec.modelsArgs]);child=spawn(inv.command,inv.args,{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore'],env:{...processEnvironment(localCliAuth[cli.id]),CI:'1'}});}catch{resolve();return;}
      const timer=setTimeout(()=>{failed=true;child.kill();done(null);},30000);timer.unref?.();
      child.stdout?.on('data',(chunk:Buffer)=>{output+=chunk.toString('utf8');if(output.length>2_000_000){failed=true;child.kill();done(null);}});
      child.once('error',()=>done(1));child.once('close',done);
    });
  }
}
export function loadCliModels(context?:vscode.ExtensionContext){
  // Avoid concurrent heavyweight CLI processes on low-memory machines.
  return cliModelsLoading??=(async()=>{await loadOpencodeModels(context);await loadCodexModels(context);await loadEditorCliModels(context);})().finally(()=>{cliModelsLoading=undefined;});
}
const localCliSessionGrants=new Set<string>();
let opencodeServer:OpencodeServer|undefined;
/** Short reason when an error means "this model cannot be used right now" (worth switching models), else undefined. */
export function modelUnavailableReason(error:unknown):string|undefined{
  const text=String((error as any)?.message||error||'');
  const rules:Array<[RegExp,string,string]>=[
    [/free usage limit|usage limit reached|quota|rate.?limit|too many requests|\b429\b/i,'quota','kota doldu'],
    [/end of life|no longer available|deprecated model|\b410\b|model .{0,40}not (found|exist)|unknown model|does not exist/i,'retired','model kullanımdan kalktı'],
    [/payment|insufficient (credit|balance|fund)|billing|\b402\b|verify with a payment/i,'billing','ödeme/kredi gerekiyor'],
    [/invalid api key|unauthori[sz]ed|\b401\b|forbidden|\b403\b|authentication/i,'auth','anahtar reddedildi'],
  ];
  for(const [re,en,trText] of rules)if(re.test(text))return language()==='tr'?trText:en;
  return undefined;
}
function getOpencodeServer(cli:LocalCli){return opencodeServer??=new OpencodeServer(args=>resolveLocalCliInvocation(cli,args),()=>root()||os.homedir());}
async function approveLocalCliRun(cli:LocalCli,workspace:string,executable:string,signal?:AbortSignal){
  const allow=tr('local.runOnce'),session=language()==='tr'?'Bu oturumda izin ver':'Allow for this session',grantKey=`${cli.id}|${workspace}`;
  if(localCliSessionGrants.has(grantKey))return;
  const approval=await vscode.window.showWarningMessage(tr('local.confirmRun',{name:cli.name}),{modal:true,detail:tr('local.confirmRunDetail',{workspace,executable})},allow,session);
  if((approval!==allow&&approval!==session)||signal?.aborted)throw new Error(tr('local.err.cancelled'));
  if(approval===session)localCliSessionGrants.add(grantKey);
}

class LocalModelRuntime{
  private localStatus:vscode.StatusBarItem|undefined;
  reportSpeed(model:string,characters:number,ms:number){this.localStatus??=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,99);this.localStatus.text=(language()==='tr'?'Yerel: ':'Local: ')+statusModelName(model)+' · '+(characters?((characters/4)/Math.max(.001,ms/1000)).toFixed(1):'0')+' tok/s';this.localStatus.tooltip=language()==='tr'?'Yaklaşık üretim hızı':'Approximate generation speed';this.localStatus.show();}
  private models:LocalModelRecord[]=[];
  private servers=new Map<string,{port:number;child:ReturnType<typeof spawn>}>();
  private directory:string;
  constructor(private context:vscode.ExtensionContext){this.directory=path.join(context.globalStorageUri.fsPath,'models');}
  get directoryPath(){return globalSetting<string>(vscode.workspace.getConfiguration('cude-ai'),'localModelDirectory','')||this.directory;}
  async refresh(){this.directory=this.directoryPath;const appModelRoot=path.join(this.context.globalStorageUri.fsPath,'models'),roots=[this.directory,appModelRoot,path.join(os.homedir(),'Downloads'),...(process.platform==='win32'?['E:\\CudeModels']:[])],found=await listDownloadedModelsFromRoots(roots);this.models=[];for(const item of found){let meta:any={};try{meta=JSON.parse(await fs.readFile(`${item.path}.cude.json`,'utf8'));}catch{}this.models.push({...item,repo:meta.repo,license:meta.license,sha256:meta.sha256});}return this.models;}
  get enabled(){return globalSetting<boolean>(vscode.workspace.getConfiguration('cude-ai'),'localModels.enabled',false);}
  profileList(){if(!this.enabled)return[];return this.models.map(model=>({id:`cude-local-${createHash('sha1').update(model.path).digest('hex').slice(0,10)}`,name:model.name,provider:'local-llama',baseUrl:`http://127.0.0.1:${this.servers.get(model.path)?.port||0}/v1`,models:[model.name],deployment:model.path} as ProviderProfile));}
  async addModel(model:LocalModelRecord){await fs.writeFile(`${model.path}.cude.json`,JSON.stringify({repo:model.repo,license:model.license,sha256:model.sha256},null,2),'utf8');await this.refresh();}
  getModelById(id:string){return this.profileList().find(item=>item.id===id);}
  async ensureRunning(modelPath:string){
    let server=this.servers.get(modelPath);if(server&&server.child.exitCode===null)return`http://127.0.0.1:${server.port}/v1`;
    const executable=path.join(this.context.extensionUri.fsPath,'bin','llama','llama-server.exe');try{await fs.access(executable);}catch{throw new Error(tr('local.err.runtimeMissing'));}
    const model=await fs.stat(modelPath);if(!model.isFile()||!modelPath.toLowerCase().endsWith('.gguf'))throw new Error(tr('local.err.selectGguf'));
    const port=await new Promise<number>((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();const value=typeof address==='object'&&address?address.port:0;probe.close(error=>error?reject(error):resolve(value));});});
    const runtimeDir=path.dirname(executable);
    const hasGpuBackend=(await fs.readdir(runtimeDir)).some(name=>/^ggml-(?:cuda|vulkan|hip|sycl)(?:[-_][^.]+)?\.dll$/i.test(name));
    const device=detectDevice();
    const tuning=localRuntimeSettings(model.size,{ramBytes:device.ramBytes,vramBytes:hasGpuBackend?device.vramBytes:0});
    const args=['--model',modelPath,'--host','127.0.0.1','--port',String(port),
      '--ctx-size',String(tuning.context),'--n-gpu-layers',String(tuning.gpuLayers),
      '--alias','cude-local','--parallel','1','--no-warmup'];
    if (tuning.gpuLayers === 0 && os.freemem() < 2 * 1024 ** 3) {
      args.push('--threads','1','--threads-batch','1','--fit','off');
    }
    const child=spawn(executable,args,{cwd:runtimeDir,stdio:['ignore','ignore','pipe'],windowsHide:true,shell:false});
    let launchError='';child.on('error',error=>{launchError=error.message;this.servers.delete(modelPath);});child.once('exit',()=>{this.servers.delete(modelPath);if(!this.servers.size)this.localStatus?.hide();});
    let stderr='';child.stderr?.on('data',(chunk:Buffer)=>stderr=(stderr+chunk.toString('utf8')).slice(-5000));server={port,child};this.servers.set(modelPath,server);
    const deadline=Date.now()+90000;while(Date.now()<deadline){if(launchError)throw new Error((language()==='tr'?'Yerel model başlatılamadı: ':'Local model could not start: ')+launchError);if(child.exitCode!==null)throw new Error(localRuntimeFailure(stderr,language()==='tr'));try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){this.reportSpeed(path.basename(modelPath),0,1);return`http://127.0.0.1:${port}/v1`;}}catch{}await new Promise(resolve=>setTimeout(resolve,400));}
    child.kill();this.servers.delete(modelPath);throw new Error(localRuntimeFailure(stderr,language()==='tr'));
  }
  async dispose(){this.localStatus?.dispose();for(const server of this.servers.values())server.child.kill();this.servers.clear();}
  /** Frees memory: stops running llama-server processes (they restart on the next local request). */
  stopServers(){const n=this.servers.size;for(const server of this.servers.values()){try{server.child.kill();}catch{}}this.servers.clear();return n;}
}

function cliTextFromEvent(cli:LocalCliId,event:any):string{
  if(cli==='codex-cli'){
    if(event?.type==='item.delta'&&typeof event.delta==='string')return event.delta;
    if(event?.type==='item.completed'&&event.item?.type==='agent_message')return typeof event.item.text==='string'?event.item.text:(event.item.content||[]).map((part:any)=>part.text||'').join('');
    return'';
  }
  if(cli==='claude-code'){
    if(event?.type==='stream_event'&&event.event?.type==='content_block_delta'&&typeof event.event.delta?.text==='string')return event.event.delta.text;
    if(event?.type==='result'&&typeof event.result==='string')return event.result;
    return'';
  }
  if(event?.type==='text'&&typeof event.part?.text==='string')return event.part.text;
  if(event?.type==='step_finish'&&typeof event.text==='string')return event.text;
  return'';
}

function cliErrorFromEvent(event:any):string{if(!event||typeof event!=='object')return'';if(event.type==='error'||event.type==='turn.failed'){const e=event.error||event;const message=e?.data?.message||e?.message||(typeof e==='string'?e:'');let text=String(message||'The agent reported an error.');for(let depth=0;depth<3&&/^\s*\{/.test(text);depth++){try{const inner=JSON.parse(text);text=String(inner?.error?.message||inner?.message||inner?.data?.message||text);}catch{break;}}if(/model_not_found|not supported when using Codex/i.test(String(message)))text+=' Update the Codex CLI (npm i -g @openai/codex) or pick a supported model in your Codex config.';return text.slice(0,600);}return'';}
function resolveLocalCliInvocation(cli:LocalCli,args:string[]):{command:string;args:string[]}{
  if(process.platform!=='win32'||!cli.path.toLowerCase().endsWith('.cmd'))return{command:cli.path,args};
  if(fsSync.statSync(cli.path).size>65536)throw new Error('The command shim is too large.');
  const shim=fsSync.readFileSync(cli.path,'utf8'),entries=[...shim.matchAll(/"([^"\r\n]+\.(?:mjs|cjs|js|exe))"/gi)].map(match=>match[1].replace(/^[A-Za-z_][A-Za-z0-9_]*=/,'')).filter(value=>!/(^|[\\/])node(\.exe)?$/i.test(value)&&!/npm-prefix\.js$/i.test(value)&&!value.replace(/^%~?dp0%?/i,'').includes('%')),entry=entries.at(-1);
  if(!entry)throw new Error(`${cli.name} was found as a .cmd shim, but its CLI entry point could not be resolved safely.`);
  const script=entry.replace(/^%~?dp0%?[\\/]*/i,'');const entryPath=path.isAbsolute(script)?script:path.resolve(path.dirname(cli.path),script);if(/\.exe$/i.test(entryPath)){if(!fsSync.existsSync(entryPath))throw new Error(`${cli.name} executable was not found at ${entryPath}. Reinstall it, then try again.`);return{command:entryPath,args};}
  let node='';const nodeHere=path.join(path.dirname(cli.path),'node.exe');if(fsSync.existsSync(nodeHere))node=nodeHere;else for(const dir of String(process.env.PATH||process.env.Path||'').split(path.delimiter).filter(dir=>path.isAbsolute(dir))){const candidate=path.join(dir,'node.exe');if(fsSync.existsSync(candidate)){node=candidate;break;}}
  if(!node||!path.isAbsolute(node))throw new Error('An installed absolute Node.js executable is required for this CLI.');
  return{command:node,args:[entryPath,...args]};
}

export async function runLocalCli(cli:LocalCli,prompt:string,permission:string,signal:AbortSignal|undefined,onDelta?:(delta:string)=>void,model?:string):Promise<string>{
  const workspace=root();if(!workspace)throw new Error(tr('local.err.noProject'));requireTrustedWorkspace('running a local AI agent');
  if(!permitsLocalCli(cli.id,permission))throw new Error(tr('local.err.restrictedMode',{name:cli.name}));
  const boundedPrompt=`Cude IDE permission mode: ${permission}. Treat this request as a coding conversation. Explain your work and provide code as proposals in your final response. Do not claim that Cude applied edits.\n\n${prompt}`;
  let args:string[];
  const pickModel=(re:RegExp)=>model&&model!==cli.model&&re.test(model)?model:'';
  if(cli.id==='codex-cli'){const m=pickModel(/^[\w.:-]{1,80}$/);args=['exec','--json','--sandbox','read-only','--skip-git-repo-check',...(m?['-m',m]:[]),'-C',workspace,boundedPrompt];}
  else if(cli.id==='claude-code'){const m=pickModel(/^[\w.:-]{1,80}$/);args=['-p','--output-format','stream-json','--verbose','--permission-mode','plan','--tools','',...(m?['--model',m]:[]),'--',boundedPrompt];}
  else if(cli.id==='gemini-cli'||cli.id==='qwen-code'){const m=pickModel(/^[\w.:-]{1,80}$/);args=[...(m?['-m',m]:[]),'-p',boundedPrompt];}
  else if(EDITOR_CLIS.some(item=>item.id===cli.id))args=editorCliArgs(cli.id as EditorCliId,boundedPrompt,model&&model!==cli.model?model:undefined);
  else args=['run','--format','json','--agent','plan',...(model&&model!==cli.model&&/^[\w.-]+\/[\w./:@-]+$/.test(model)?['-m',model]:[]),boundedPrompt];
  const invocation=resolveLocalCliInvocation(cli,args);
  const allow=tr('local.runOnce'),session=language()==='tr'?'Bu oturumda izin ver':'Allow for this session',grantKey=`${cli.id}|${workspace}`;
  if(!localCliSessionGrants.has(grantKey)){
    const approval=await vscode.window.showWarningMessage(tr('local.confirmRun',{name:cli.name}),{
      modal:true,detail:tr('local.confirmRunDetail',{workspace,executable:invocation.command})
    },allow,session);
    if((approval!==allow&&approval!==session) || signal?.aborted)throw new Error(tr('local.err.cancelled'));
    if(approval===session)localCliSessionGrants.add(grantKey);
  }
  if(signal?.aborted)throw new Error(tr('local.err.cancelled'));
  const env={...processEnvironment(localCliAuth[cli.id]),CI:'1'};
  if(cli.id==='opencode-cli')Object.assign(env,{OPENCODE_CONFIG_CONTENT:JSON.stringify({permission:{'*':'deny'}})});
  const redact=(value:string)=>redactSecrets(value,Object.entries(env)
    .filter(([name])=>localCliAuth[cli.id].some(key=>key.toUpperCase()===name.toUpperCase())).map(([,value])=>value));
  return new Promise<string>((resolve,reject)=>{
    const child=spawn(invocation.command,invocation.args,{cwd:workspace,env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});
    let stdout='',stderr='',pending='',answer='',settled=false,streamed=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;if(idle)clearTimeout(idle);signal?.removeEventListener('abort',abort);clearTimeout(timer);if(error){reject(error);return;}if(!answer.trim())answer=redact(stdout.trim());if(!streamed&&answer)onDelta?.(answer);resolve(answer.trim());};
    const abort=()=>{child.kill();finish(new Error(tr('local.err.cancelled')));};
    const timer=setTimeout(()=>{child.kill();finish(new Error(tr('local.err.timeout',{name:cli.name})));},600000);let idle:NodeJS.Timeout|undefined;const idleMs=answer?180000:120000;const bump=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>{child.kill();finish(new Error(tr('local.err.idle',{name:cli.name,seconds:idleMs/1000,bin:cli.bin})));},idleMs);};bump();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    child.stdout.on('data',(chunk:Buffer)=>{bump();
      stdout+=chunk.toString('utf8');if(stdout.length>8_000_000){child.kill();finish(new Error(tr('local.err.outputLimit')));return;}
      if(EDITOR_CLIS.some(item=>item.id===cli.id))return;
      pending+=chunk.toString('utf8');let boundary:number;
      while((boundary=pending.indexOf('\n'))>=0){const line=pending.slice(0,boundary).trim();pending=pending.slice(boundary+1);if(!line)continue;try{const event=JSON.parse(line),failure=cliErrorFromEvent(event);if(failure){child.kill();finish(new Error(tr('local.err.failed',{name:cli.name,error:redact(failure)})));return;}const text=redact(cliTextFromEvent(cli.id,event));if(text){if(cli.id==='codex-cli'&&event.type==='item.completed')answer=text;else answer+=text;streamed=true;onDelta?.(text);}}catch{}}
    });
    child.stderr.on('data',(chunk:Buffer)=>{bump();stderr=(stderr+chunk.toString('utf8')).slice(-12000);{const fatal=/Free usage limit reached|end of life|is no longer available|Verify with a payment method|insufficient (credits|quota)|invalid api key|unauthorized/i.exec(stderr);if(fatal){child.kill();finish(new Error(`${cli.name}: ${(stderr.split(/\r?\n/).find(line=>fatal&&line.includes(fatal[0]))||fatal[0]).replace(/https?:\/\/\S+/g,'').slice(0,300).trim()}${language()==='tr'?' — model seçicide başka bir model seçin.':' — choose another model in the model picker.'}`));return;}}});
    child.once('error',(error:Error)=>finish(new Error(`Could not start ${cli.name}: ${error.message}`)));
    child.once('exit',(code:number|null)=>{if(pending.trim()){try{const event=JSON.parse(pending.trim()),text=redact(cliTextFromEvent(cli.id,event));if(text){answer+=text;onDelta?.(text);}}catch{}}
      if(code!==0)finish(new Error(`${cli.name} exited with code ${code??'unknown'}.${stderr.trim()?` ${redact(stderr.trim().slice(-1800))}`:''}`));else finish();
    });
  });
}
const proposalContentProvider=new ProposalContentProvider();
function proposalUri(id:string){return vscode.Uri.parse(`cude-proposal:/${id}`);}
export function applySearchReplaceBlocks(original:string,proposal:string){
  const pattern=/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;let result=original,count=0,match:RegExpExecArray|null;
  while((match=pattern.exec(proposal))){const [whole,search,replacement]=match,needle=search.replace(/\r\n/g,'\n'),haystack=result.replace(/\r\n/g,'\n'),at=haystack.indexOf(needle);if(at<0||haystack.indexOf(needle,at+needle.length)>=0)throw new Error(tr('errors.searchReplaceNoMatch'));const start=haystack.slice(0,at).length,end=start+needle.length;result=result.slice(0,start)+replacement.replace(/\r\n/g,'\n')+result.slice(end);count++;}
  if(count===0)throw new Error(tr('errors.searchReplaceInvalid'));return result;
}
const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

// Keep the editor display language identical to the Cude AI language (one setting for the whole IDE).
function argvPath(){const portable=process.env.VSCODE_PORTABLE;return portable?path.join(portable,'argv.json'):path.join(os.homedir(),'.cude-ide','argv.json');}
async function syncDisplayLocale(prompt:boolean){
  const want=language()==='tr'?'tr':'en';
  if((vscode.env.language||'en').toLowerCase().startsWith(want))return;
  const file=argvPath();let text='{\n}\n';
  try{text=await fs.readFile(file,'utf8');}catch{}
  const line=`\t"locale": "${want}"`;
  if(/"locale"\s*:\s*"[^"]*"/.test(text))text=text.replace(/"locale"\s*:\s*"[^"]*"/,`"locale": "${want}"`);
  else{const i=text.lastIndexOf('}');text=i<0?`{\n${line}\n}\n`:text.slice(0,i).replace(/\s*$/,'')+(/[{,]\s*$/.test(text.slice(0,i).replace(/\/\/[^\n]*/g,'').trimEnd())?'':',')+`\n${line}\n`+text.slice(i);}
  try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text,'utf8');}catch{return;}
  if(!prompt)return;
  const restart=want==='tr'?'Yeniden başlat':'Restart';
  const pick=await vscode.window.showInformationMessage(want==='tr'?'IDE dili Türkçe yapıldı. Uygulamak için Cude IDE yeniden başlatılmalı.':'The IDE language was set to English. Restart Cude IDE to apply it.',restart);
  if(pick===restart)await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
function language():Language{try{return normalizeLanguage(vscode.workspace.getConfiguration('cude-ai').get('language','en'));}catch{return 'en';}}
function tr(key:MessageKey,values?:Record<string,string|number>){return t(key,language(),values);}
function voiceErrorText(error:any){const code=String(error?.message||'');return code==='VOICE_UNSUPPORTED'?tr('voice.unsupported'):code==='VOICE_NO_MICROPHONE'?tr('voice.noMicrophone'):code==='VOICE_EMPTY'?tr('voice.nothingHeard'):tr('voice.failed');}
export function statusModelName(model:string){if(model==='__cude_router__')return tr('router.auto');let name=String(model).split(/[\\/]/).pop()||String(model);const gguf=name.search(/-GGUF-/i);if(gguf>0)name=name.slice(0,gguf);name=name.replace(/\.gguf$/i,'');return name.length>36?name.slice(0,35)+'…':name;}
const readableProviderError=(body:unknown)=>{const raw=String(body??'');try{const parsed=JSON.parse(raw);const msg=parsed?.error?.message??parsed?.message??(typeof parsed?.error==='string'?parsed.error:undefined)??parsed?.detail;if(typeof msg==='string'&&msg.trim())return msg.replace(/\s+/g,' ').trim();}catch{}return raw.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();};
const wireText:WireText=(name,values)=>name==='authentication'?tr('provider.authenticationFailed'):name==='streamInterrupted'?tr('provider.streamInterrupted'):name==='empty'?tr('provider.emptyResponse',values):name==='blocked'?tr('provider.blockedResponse',values):name==='streamError'?tr('provider.streamError',values):name==='rateLimited'?tr('provider.rateLimited'):tr('provider.httpError',values&&typeof values==='object'&&'detail' in values?{...values,detail:readableProviderError((values as any).detail).slice(0,200)}:values);
function localizedPresets(){return PROVIDER_PRESETS.map(preset=>{const name=`preset.name.${preset.id}`,note=`preset.note.${preset.id}`;return{...preset,name:name in I18N.en?tr(name as MessageKey):preset.name,...(preset.note&&note in I18N.en?{note:tr(note as MessageKey)}:{})};});}
function requireTrustedWorkspace(action:string){if(!vscode.workspace.isTrusted)throw new Error(`Cude blocked ${action} because this window/workspace is not trusted. Review the project, then use Workspaces: Manage Workspace Trust if you trust it.`);}
function globalSetting<T>(cfg:vscode.WorkspaceConfiguration,key:string,fallback:T):T{return cfg.inspect<T>(key)?.globalValue??cfg.inspect<T>(key)?.defaultValue??fallback;}
function connectionPresets(catalog: Awaited<ReturnType<ModelCatalog['snapshotOrLoad']>>) {
  const result = localizedPresets();
  const claimed = new Set(result.map(preset => preset.baseUrl.toLowerCase().replace(/\/$/, '')));
  for (const item of catalog.providers) {
    if (item.category === 'Local' || !item.api) continue;
    let url: URL;
    try { url = new URL(validateProviderBase(item.api)); } catch { continue; }
    if (url.protocol !== 'https:' || !/\/v1\/?$/i.test(url.pathname)) continue;
    if (/(anthropic|bedrock|vertex|azure|googleapis)\./i.test(url.hostname)) continue;
    const baseUrl = url.toString().replace(/\/$/, '');
    if (claimed.has(baseUrl.toLowerCase())) continue;
    claimed.add(baseUrl.toLowerCase());
    result.push({ id: 'catalog-'+item.id, name: item.name, provider: 'openai-compatible',
      baseUrl, auth: 'bearer', category: item.category === 'Gateway' ? 'Gateway' : 'Cloud',
      note: language()==='tr' ? 'Katalog uç noktası. Model erişimini Bağlantıyı test et ile doğrulayın.' : 'Catalog endpoint. Use Test connection to verify model access.' });
  }
  return result;
}

function validateProviderBase(value:string){let url:URL;try{url=new URL(value);}catch{throw new Error('Provider URL must be a valid HTTPS URL, or a local loopback HTTP URL.');}const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&local)))throw new Error('Provider URL must use HTTPS. HTTP is allowed only for localhost/Ollama; credentials, query strings and fragments are rejected.');return url.toString().replace(/\/$/,'');}
function validateProxy(value:string){if(!value.trim())return'';let url:URL;try{url=new URL(value);}catch{throw new Error('Proxy URL must be HTTPS, or HTTP on localhost.');}const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);if(url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&local)))throw new Error('Proxy URL must use HTTPS. HTTP is allowed only for localhost.');return url.toString().replace(/\/$/,'');}
function providerHeaders(value:unknown):Record<string,string>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Custom headers must be a JSON object.');
  const output:Record<string,string>=Object.create(null);
  const entries=Object.entries(value);
  if(entries.length>32)throw new Error('Too many custom headers.');
  for(const [name,item] of entries){
    const key=name.toLowerCase();
    if(!/^[!#$%&'*+.^_|~0-9A-Za-z-]{1,80}$/.test(name)||typeof item!=='string'||item.length>2048||
       /[^\t\x20-\x7e\x80-\xff]/.test(item)||/^(?:host|connection|content-length|transfer-encoding|upgrade|expect|te|trailer|keep-alive|proxy-.*|sec-.*|x-forwarded-.*|forwarded)$/.test(key)||Object.hasOwn(output,key))throw new Error('Invalid or reserved custom header.');
    output[key]=item;
  }
  return output;
}
function parseCustomHeaders(value:unknown):Record<string,string>{
  let parsed:unknown;
  try{parsed=JSON.parse(String(value||'{}'));}catch{throw new Error('Custom headers must be a valid JSON object.');}
  return providerHeaders(parsed);
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function lineCounts(before:string,after:string){const a=before.split(/\r?\n/),b=after.split(/\r?\n/);let start=0,endA=a.length,endB=b.length;while(start<endA&&start<endB&&a[start]===b[start])start++;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}return{added:endB-start,removed:endA-start};}
const secretPath=(relative:string)=>isSecretPath(relative);
const isMcpProjectFile=(relative:string)=>/(?:^|[\\/])\.cude[\\/]mcp(?:-tools)?\.json$/i.test(relative);
// Active/selected editor text is sent to providers; secret files (inside or outside the project) are never included.
async function isProtectedEditorDocument(document:{fileName:string;uri?:{scheme:string}}){
  const file=String(document?.fileName||''),workspace=root(),relative=workspace?path.relative(workspace,file):'';
  if(!file||document.uri&&document.uri.scheme!=='file'||secretPath(file)||isMcpProjectFile(file))return true;
  const inside=workspace&&relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
  try{
    const resolved=inside?await assertRealPathInside(workspace,file):await fs.realpath(file);
    return secretPath(resolved)||isMcpProjectFile(resolved);
  }catch{return true;}
}
// Resolves symlinks/junctions of the nearest existing ancestor and rejects paths that leave the workspace or land on a secret file.
async function assertRealPathInside(workspace:string,absolute:string){
  const realRoot=await fs.realpath(workspace).catch(()=>path.resolve(workspace));let probe=absolute,suffix='';
  for(let depth=0;depth<64;depth++){try{const real=await fs.realpath(probe),target=suffix?path.join(real,suffix):real,relative=path.relative(realRoot,target);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||secretPath(relative))throw new Error('The requested path resolves outside the project or to a protected file.');return target;}catch(error:any){if(error?.code!=='ENOENT')throw error;const parent=path.dirname(probe);if(parent===probe)break;suffix=suffix?path.join(path.basename(probe),suffix):path.basename(probe);probe=parent;}}
  throw new Error('The requested path could not be resolved inside the project.');
}
function resolveProjectFile(workspace:string,relative:string){
  const normalized=relative.replace(/\\/g,'/').replace(/^\.\//,'');
  if(!normalized||secretPath(normalized)||isMcpProjectFile(normalized)||path.isAbsolute(normalized))throw new Error('This project file cannot be attached or opened.');
  const absolute=path.resolve(workspace,normalized),inside=path.relative(workspace,absolute);
  if(!inside||inside==='..'||inside.startsWith(`..${path.sep}`)||path.isAbsolute(inside))throw new Error('The requested path is outside the project.');
  return absolute;
}

async function findProjectFiles(query:string,limit=30,workspaceOverride?:string):Promise<string[]>{
  const workspace=workspaceOverride||root();if(!workspace)return [];
  requireTrustedWorkspace('searching project file names');
  if(core){try{return (await core.call('find_files',{root:workspace,query,limit},20000)).filter((file:string)=>!secretPath(file));}catch{}}
  const pattern=query?`**/*${query.split(/[\\/]/).filter(Boolean).at(-1)||query}*`:'**/*';
  const found=await vscode.workspace.findFiles(pattern,'**/{node_modules,.git,dist,build,out,target,coverage,.next,.venv,vendor}/**,**/*.{lock,vsix,png,jpg,jpeg,gif,ico,pdf,zip,exe,dll}',limit);
  return found.map(uri=>path.relative(workspace,uri.fsPath).replace(/\\/g,'/')).filter(file=>!secretPath(file));
}

async function grepProject(pattern:string,limit=80,workspaceOverride?:string){
  const workspace=workspaceOverride||root();if(!workspace)return [];
  requireTrustedWorkspace('searching project contents');
  if(core){try{const found=await core.call('grep',{root:workspace,pattern,limit,ignore_case:true},30000) as Array<{file:string;line:number;text:string}>;const safe=[];for(const match of Array.isArray(found)?found.slice(0,limit):[]){try{const real=await assertRealPathInside(workspace,resolveProjectFile(workspace,match.file));if(!isMcpProjectFile(real))safe.push(match);}catch{}}return safe;}catch{}}
  const safe=pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),expression=new RegExp(safe,'i'),files=await vscode.workspace.findFiles('**/*','**/{node_modules,.git,dist,build,out,target,coverage,.next,.venv,vendor}/**,**/*.{lock,vsix,png,jpg,jpeg,gif,ico,pdf,zip,exe,dll,pem,key,p12,pfx}',2000),matches:Array<{file:string;line:number;text:string}>=[];
  for(const uri of files){const file=path.relative(workspace,uri.fsPath).replace(/\\/g,'/');if(secretPath(file)||isMcpProjectFile(file))continue;try{const real=await assertRealPathInside(workspace,uri.fsPath);if(isMcpProjectFile(real))continue;const stat=await vscode.workspace.fs.stat(uri);if(stat.size>1_000_000)continue;const text=Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');if(text.includes('\u0000'))continue;for(const [index,line] of text.split(/\r?\n/).entries()){if(expression.test(line)){matches.push({file,line:index+1,text:line.slice(0,240)});if(matches.length>=limit)return matches;}}}catch{}}
  return matches;
}

async function readProjectAttachments(files:string[],workspaceOverride?:string):Promise<string>{
  const workspace=workspaceOverride||root();if(!workspace||!files.length)return '';
  requireTrustedWorkspace('attaching project files to AI context');
  const parts:string[]=[];let total=0;
  for(const relative of [...new Set(files)].slice(0,6)){
    if(total>=24000)break;
    const absolute=resolveProjectFile(workspace,relative);const real=await assertRealPathInside(workspace,absolute);if(isMcpProjectFile(real))continue;const uri=vscode.Uri.file(absolute),stat=await vscode.workspace.fs.stat(uri);
    if(stat.type!==vscode.FileType.File||stat.size>30000)continue;
    const bytes=await vscode.workspace.fs.readFile(uri),text=Buffer.from(bytes).toString('utf8');
    if(text.includes('\u0000'))continue;
    const chunk=text.slice(0,Math.min(6000,24000-total));parts.push(`### ${relative}\n${chunk}`);total+=chunk.length;
  }
  return parts.length?`\n\nFiles explicitly attached by the user:\n${parts.join('\n\n')}`:'';
}

async function openProjectFile(relative:string,line=1){
  const workspace=root();if(!workspace)throw new Error('Open a project before opening a project file.');
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(resolveProjectFile(workspace,relative)));
  const editor=await vscode.window.showTextDocument(document,{preview:true,preserveFocus:false});
  const position=new vscode.Position(Math.max(0,Math.min(document.lineCount-1,line-1)),0);
  editor.selection=new vscode.Selection(position,position);editor.revealRange(new vscode.Range(position,position),vscode.TextEditorRevealType.InCenter);
}

function localizeProviderHtml(html:string,lang:Language){
  const pairs:Array<[string,MessageKey]>=[
    ['Sağlayıcı bağlantısı','provider.title'],
    ['Ön ayarlar endpoint ve kimlik doğrulama biçimini doldurur. API anahtarları işletim sisteminin SecretStorage alanında tutulur.','provider.description'],
    ['Sağlayıcı ara','provider.search'],['Bağlantı adı','provider.name'],['Model (isteğe bağlı)','provider.model'],
    ['API base URL','provider.url'],['API anahtarı','provider.key'],['Bağlantıyı test et','provider.test'],
    ['Yeni bağlantı bilgilerini girin.','provider.newHint'],['providers.json dışa aktar','provider.export'],['providers.json içe aktar','provider.import'],
    ['Yeni bağlantı','provider.new'],['Kaydet','provider.save'],['Norovox modelleri','provider.norovox'],
    ['Bağlantıyı kaydet, modeli sonra seç','provider.noModel'],['Bağlantı kontrol ediliyor…','provider.testing']
  ];
  for(const [source,key] of pairs)html=html.replaceAll(source,esc(t(key,lang)));
  html=html.replaceAll('Kayıtlı bağlantı yok',esc(t('provider.noSaved',lang)))
    .replace(/\d+ kayıtlı bağlantı/g,match=>esc(t('provider.savedCount',lang,{count:match.match(/^\d+/)?.[0]||''})))
    .replace(/\d+ hazır ön ayar/g,match=>esc(t('provider.presetCount',lang,{count:match.match(/^\d+/)?.[0]||''})));
  return html;
}

const SAVED_PROVIDER_TYPES=new Set(['openai-compatible','openai','anthropic','gemini','azure','nvidia','openrouter','ollama',...PROVIDER_PRESETS.map(preset=>preset.provider)]);
// Saved profiles may not impersonate built-in local runtimes (local CLI agents, bundled llama-server, router).
function validateProfileIdentity(id:unknown,provider:unknown){if(typeof id!=='string'||!/^[A-Za-z0-9._:-]{1,80}$/.test(id)||/^cude-(cli-|local-|router|pool$|free:)/i.test(id))throw new Error('Provider connection id is invalid or reserved.');if(typeof provider!=='string'||!SAVED_PROVIDER_TYPES.has(provider))throw new Error('Provider type is not supported.');}
export class Gateway {
  private semanticProjects?:SemanticProjects;
  private semanticService(){
    return this.semanticProjects??=new SemanticProjects(this.context,()=>globalSetting<string>(vscode.workspace.getConfiguration('cude-ai'),'localModelDirectory',''),language);
  }
  async indexSemanticProject(){
    const workspace=root();
    if(!workspace)throw new Error(tr('errors.openProjectFolder'));
    const stats=await this.semanticService().indexProject(workspace);
    if(stats)void vscode.window.showInformationMessage(language()==='tr'?
      'Norovox indeksi: '+stats.files+' dosya, '+stats.chunks+' parça. '+stats.updated+' dosya güncellendi, '+stats.skipped+' dosya atlandı.':
      'Norovox index: '+stats.files+' files, '+stats.chunks+' chunks. '+stats.updated+' updated, '+stats.skipped+' skipped.');
  }
  semanticContext(workspace:string|undefined,query:string,signal?:AbortSignal){
    if(!workspace||!vscode.workspace.isTrusted||!this.context.extensionUri)return Promise.resolve('');
    return this.semanticService().contextFor(workspace,codebaseQuery(query),signal);
  }
  private modelRefresh?:()=>void;
  private requestTimes:number[]=[];
  private proxyAgents=new Map<string,ProxyAgent>();
  private localDownload?:AbortController;
  readonly localModels:LocalModelRuntime;
  readonly editorModels = new EditorLanguageModels(()=>this.notifyModels());
  constructor(private secrets: vscode.SecretStorage, private context: vscode.ExtensionContext,private catalog:ModelCatalog) {this.localModels=new LocalModelRuntime(context);}
  private startupModels?: Promise<void>;
  prepareStartupModels(){
    this.startupModels??=(async()=>{
      try{await this.catalog.snapshotOrLoad();this.notifyModels();}
      catch(error){console.warn('[Cude AI] bundled model catalog unavailable',error);}
      try{await this.editorModels.refresh();}catch{console.warn('[Cude AI] editor models unavailable');}
      await this.refreshLocalProfiles();
    })();
    return this.startupModels;
  }
  async refreshLocalProfiles(){if(!this.localModels.enabled)return;try{await this.localModels.refresh();this.notifyModels();}catch{console.warn('[Cude AI] local models unavailable');}}
  // Redirects are followed manually and only within the configured origin, so provider credentials
  // (Authorization, x-api-key, x-goog-api-key, api-key, custom headers) never reach another host.
  private async request(url:string,init:RequestInit,proxy=''){let dispatcher:ProxyAgent|undefined;if(proxy){dispatcher=this.proxyAgents.get(proxy);if(!dispatcher){dispatcher=new ProxyAgent(proxy);this.proxyAgents.set(proxy,dispatcher);}}
    let current=url;const method=String(init.method||'GET').toUpperCase();
    for(let hop=0;hop<=3;hop++){const response=await undiciFetch(current,{...init,redirect:'manual',...(dispatcher?{dispatcher}:{})} as any);if(![301,302,303,307,308].includes(response.status))return response;const location=response.headers.get('location');try{await response.body?.cancel();}catch{}if(!location)throw new Error(`Provider returned redirect ${response.status} without a location.`);const next=new URL(location,current);if(!sameOrigin(next.toString(),current))throw new Error(`Provider redirected to a different host (${next.host}); the request was blocked to protect credentials.`);if(method!=='GET'&&method!=='HEAD'&&response.status!==307&&response.status!==308)throw new Error(`Provider redirected a ${method} request (${response.status}); update the base URL to the final endpoint.`);current=next.toString();}
    throw new Error('Provider returned too many redirects.');}
  dispose(){this.editorModels.dispose();this.semanticProjects?.dispose();this.poolQuotaRefresh?.abort();clearTimeout(this.poolRetryTimer);this.poolQuotaPanels.clear();for(const dispatcher of this.proxyAgents.values())void dispatcher.close();this.proxyAgents.clear();this.localDownload?.abort();void this.localModels.dispose();}
  setModelRefresh(refresh:()=>void){this.modelRefresh=refresh;}
  notifyModels(){this.modelRefresh?.();}
  private profiles(){
    const stored=globalSetting<ProviderProfile[]>(vscode.workspace.getConfiguration('cude-ai'),'providers',[]);
    return (Array.isArray(stored)?stored:[]).filter(item=>item&&typeof item.id==='string'&&typeof item.provider==='string'&&typeof item.baseUrl==='string').map(
      ({id,name,provider,baseUrl,models,modelEfforts,organization,project,deployment,timeout})=>
        ({id,name,provider,baseUrl,models,modelEfforts,organization,project,deployment,timeout} as ProviderProfile)
    );
  }
  private advertisedEfforts = new Map<string, Record<string,string[]>>();
  private poolModels:Array<{id:string;name:string;efforts:string[]}>=[];private poolLoaded='';
  poolUrl(){if(!CUDE_POOL_ENABLED)return '';const value=String(globalSetting<string>(vscode.workspace.getConfiguration('cude-ai'),'freePool.url','')||'')||String(this.context.globalState.get<string>('cude.pool.directory.active','')||'');if(!value)return '';try{return validateProviderBase(value);}catch{return '';}}
  private directoryTimer?:ReturnType<typeof setInterval>;
  /** Finds the current Cude Pool from the signed directory (no IDE update needed when servers move). */
  async refreshPoolDirectory(){
    if(String(globalSetting<string>(vscode.workspace.getConfiguration('cude-ai'),'freePool.url','')||''))return;
    try{
      const trust=await readReleaseTrust(this.context);if(!trust)return;
      const directory=await fetchPoolDirectory(trust.feed,[trust.poolKey||'',trust.key],AbortSignal.timeout(10000),undiciFetch as any);
      await this.context.globalState.update('cude.pool.directory.urls',directory.urls);
      const healthy=await pickHealthyPool(directory.urls,undiciFetch as any)||directory.urls[0];
      if(healthy!==this.context.globalState.get<string>('cude.pool.directory.active')){await this.context.globalState.update('cude.pool.directory.active',healthy);this.poolLoaded='';void this.refreshPoolQuota(true);this.notifyModels();}
    }catch(error){console.warn('[Cude AI] pool directory unavailable',error);}
  }
  stopPoolDirectory(){if(this.directoryTimer)clearInterval(this.directoryTimer);this.directoryTimer=undefined;}
  startPoolDirectory(){if(!CUDE_POOL_ENABLED)return;void this.refreshPoolDirectory();this.directoryTimer??=setInterval(()=>void this.refreshPoolDirectory(),20*60_000);}
  private poolRefresh?: {url:string; run:Promise<void>};
  private poolQuotaRefresh?: AbortController;
  private poolRetryAt=0;
  private poolRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly poolQuotaPanels = new Set<vscode.Webview>();
  private publishPoolQuota(quota:PoolQuotaView){
    for (const webview of this.poolQuotaPanels) void webview.postMessage({type:'poolQuota', quota});
  }
  async refreshPoolQuota(refreshModels=false){
    if (!this.poolQuotaPanels.size) return;
    this.poolQuotaRefresh?.abort();
    const controller = new AbortController();
    this.poolQuotaRefresh=controller;
    const url=this.poolUrl();
    const send=(quota:PoolQuotaView)=>{
      if (!controller.signal.aborted && this.poolUrl()===url) this.publishPoolQuota(quota);
    };
    try {
      if (!url) { send({state:'disconnected'}); return; }
      send({state:'loading'});
      if (refreshModels || this.poolLoaded!==url) await this.refreshPool();
      const headers=await this.poolHeaders(url);
      if (controller.signal.aborted || this.poolUrl()!==url) return;
      if (!headers) { send({state:'disconnected'}); return; }
      const nythosAvailable=this.poolLoaded===url&&this.poolModels.length
        ? this.poolModels.some(model=>model.id==='nythos') : null;
      const quota=await fetchPoolQuota((url,init)=>deviceFetch(this.context,undiciFetch,url,init),url,headers,controller.signal,nythosAvailable,this.poolModels.map(model=>({id:model.id,name:model.name})));
      if((quota.state==='accessDenied'||quota.state==='updateRequired')&&!controller.signal.aborted&&this.poolUrl()===url){this.poolModels=[];this.poolLoaded=url;this.notifyModels();}
      send(quota);
      if(quota.state==='ready'){try{const response=await deviceFetch(this.context,undiciFetch,url+'/v1/account',{headers,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});if(response.ok){const account=parsePoolAccount(JSON.parse(await boundedMcpBody(response,16_000)));if(account&&!controller.signal.aborted&&this.poolUrl()===url)for(const webview of this.poolQuotaPanels)void webview.postMessage({type:'poolAccount',account});}else await response.body?.cancel();}catch{}}
    } catch {
      // Never connected (no stored device token): show the connect prompt, not a server error.
      const stored=url?await Promise.resolve(this.secrets.get(this.poolSecret(url))).catch(()=>undefined):undefined;
      send({state:stored?'unavailable':'disconnected'});
    } finally {
      if(this.poolQuotaRefresh===controller)this.poolQuotaRefresh=undefined;
    }
  }
  private poolSecret(url:string){return 'cude-ai.pool.'+createHash('sha256').update(url).digest('hex');}
  private poolClientVersion(){return String(this.context.extension?.packageJSON?.version||'0.1.0');}
  private async enrollPool(url:string) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/') return undefined;
    await assertActivityAllowed();
    const identity = await getDevice(this.context);
    const appVersion = this.poolClientVersion();
    const response = await undiciFetch(new URL('/v1/devices/enroll', endpoint), {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json','X-Cude-Client-Version':appVersion},
      body:JSON.stringify({...identity,appVersion,osVersion:os.release()})
    });
    if (!response.ok) {
      await observeUpgradeResponse(response);
      await response.body?.cancel();
      if(response.status===404) return undefined;
      throw Error(tr(response.status===426?'pool.updateRequired':response.status===403?'pool.quotaDenied':'pool.quotaUnavailable'));
    }
    const result=JSON.parse(await boundedMcpBody(response,2048));
    if(typeof result.token!=='string'||!/^cude_[a-f0-9]{64}$/.test(result.token)) throw Error(tr('pool.quotaUnavailable'));
    // An operator may complete a manual connection while enrollment is in flight.
    const slot=this.poolSecret(url);
    const existing=await this.secrets.get(slot);
    if(existing) return existing;
    if(this.poolUrl()!==url) return undefined;
    await this.secrets.store(slot,result.token);
    return result.token as string;
  }
  private async poolHeaders(url:string){
    const token=await this.secrets.get(this.poolSecret(url));
    return token ? {Authorization:'Bearer '+token,'X-Cude-Client-Version':this.poolClientVersion()} : undefined;
  }
  async heartbeatConnection(){const url=this.poolUrl();if(!url)return undefined;const headers=await this.poolHeaders(url);return headers?{url,headers}:undefined;}
  private async discoverPool(url:string, token:string){
    const response=await deviceFetch(this.context,(target,init)=>undiciFetch(target,{
      ...init,signal:init?.signal??AbortSignal.timeout(10000)
    }),url+'/v1/models',{
      headers:{Authorization:'Bearer '+token,'X-Cude-Client-Version':this.poolClientVersion()},redirect:'error'
    });
    if(!response.ok){await response.body?.cancel();throw new Error(response.status===426?tr('pool.updateRequired'):response.status===401||response.status===403?tr('pool.quotaDenied'):tr('pool.serverError'));}
    const result:any=JSON.parse(await boundedMcpBody(response,256_000));
    if(!Array.isArray(result?.data)||!result.data.length)throw new Error('No Cude Pool models are available.');
    return result.data.slice(0,100).flatMap((m:any)=>typeof m?.id==='string'&&/^[a-z0-9.-]{1,100}$/.test(m.id) ? [{
      id:m.id,name:String(m.name||m.id).slice(0,100),efforts:Array.isArray(m.efforts)?m.efforts.filter((x:unknown)=>['low','medium','high'].includes(String(x))):[]
    }] : []);
  }
  async configurePool(){
    const value=await vscode.window.showInputBox({prompt:language()==='tr'?'Cude Pool sunucu adresi':'Cude Pool server URL',value:this.poolUrl(),ignoreFocusOut:true});
    if(value===undefined)return;
    const url=validateProviderBase(value);
    const token=await vscode.window.showInputBox({prompt:language()==='tr'?'Cude Pool erişim anahtarı':'Cude Pool access token',password:true,ignoreFocusOut:true,validateInput:v=>/^cude_[a-f0-9]{64}$/.test(v.trim())?undefined:'Invalid Cude Pool token.'});
    if(token===undefined)return;
    const models=await this.discoverPool(url,token.trim());
    if(!models.length)throw new Error('No valid Cude Pool models were returned.');
    await this.secrets.store(this.poolSecret(url),token.trim());
    await vscode.workspace.getConfiguration('cude-ai').update('freePool.url',url,vscode.ConfigurationTarget.Global);
    this.poolModels=models;this.poolLoaded=url;this.notifyModels();
    void this.refreshPoolQuota();
    void vscode.window.showInformationMessage('Cude Pool · '+models.length+(language()==='tr'?' model bağlandı.':' models connected.'));
  }
  async refreshPool(){
    const url=this.poolUrl();
    if(!url){this.poolModels=[];this.poolLoaded='';return;}
    if(this.poolRefresh?.url===url)return this.poolRefresh.run;
    const run=(async()=>{
      try{
        const token=await this.secrets.get(this.poolSecret(url))||await this.enrollPool(url);
        const models=token?await this.discoverPool(url,token):[];
        if(this.poolUrl()===url){this.poolModels=models;this.poolLoaded=url;this.notifyModels();}
      }catch{
        if(this.poolUrl()===url){
          // Retry later instead of keeping the pool empty for the whole session (device identity may still be warming up).
          this.poolModels=[];this.poolLoaded=url;this.poolRetryAt=Date.now()+15000;this.notifyModels();
          clearTimeout(this.poolRetryTimer);this.poolRetryTimer=setTimeout(()=>{if(this.poolUrl()===url&&!this.poolModels.length)void this.refreshPool().then(()=>this.refreshPoolQuota());},15000);
        }
      }
    })();
    this.poolRefresh={url,run};
    try{await run;}finally{if(this.poolRefresh?.run===run)this.poolRefresh=undefined;}
  }
  private poolProfile():ProviderProfile[]{const url=this.poolUrl();if(!url)return[];if(this.poolLoaded!==url)void this.refreshPool();return this.poolLoaded===url&&this.poolModels.length?[{id:'cude-pool',name:'Norovox Free',provider:'cude-pool',baseUrl:url,models:this.poolModels.map(m=>m.id),modelEfforts:Object.fromEntries(this.poolModels.map(m=>[m.id,m.efforts]))} as ProviderProfile]:[];}
  private cliEnabled(){return vscode.workspace.getConfiguration('cude-ai').get<boolean>('cliAgents.enabled',false)===true;}
  private allProfiles():ProviderProfile[]{return [...this.poolProfile(),...this.profiles(),...(this.cliEnabled()?localCliInventory().map(localCliProfile):[]),...this.localModels.profileList(),...this.editorModels.profiles()];}
  private disabledModels(providerId:string) {
    const setting = this.context.globalState.get<Record<string,string[]>>('disabledProviderModels',{});
    return new Set(Object.hasOwn(setting,providerId) ? setting[providerId] : []);
  }
  private enabledProfile(profile:ProviderProfile) {
    const disabled=this.disabledModels(profile.id);
    return {...profile,models:profile.models.filter(model=>!disabled.has(model))};
  }
  private matchesCatalogProvider(profile:ProviderProfile, record:ModelRecord) {
    if (profile.provider==='local-cli' || profile.provider==='local-llama' || profile.provider==='cude-pool') return false;
    return profile.id===record.providerId || profile.provider===record.providerId ||
      (!!record.baseUrl && (profile.baseUrl||'').replace(/\/+$/,'')===record.baseUrl.replace(/\/+$/,''));
  }
  catalogConnection(record:ModelRecord, profiles=this.allProfiles()) {
    const matching = profiles.filter(profile=>this.matchesCatalogProvider(profile,record));
    return matching.find(profile=>profile.models.includes(record.modelId)) || matching[0];
  }
  isCatalogModelDisabled(record:ModelRecord, profiles=this.allProfiles()){
    const profile = this.catalogConnection(record,profiles);
    return !!profile && this.disabledModels(profile.id).has(record.modelId);
  }
  private assertModelEnabled(providerId:string,model:string){
    if(this.disabledModels(providerId).has(model))throw new Error(tr('provider.modelDisabled'));
  }
  async manageModels(providerId?:string) {
    const profiles=this.allProfiles().filter(profile=>profile.models.length);
    const profile=providerId ? profiles.find(item=>item.id===providerId) :
      (await vscode.window.showQuickPick(profiles.map(item=>({label:item.name,profile:item})),{placeHolder:tr('provider.manageModels')}))?.profile;
    if(!profile){if(providerId||!profiles.length)void vscode.window.showInformationMessage(tr('provider.saveForModels'));return;}
    const disabled=this.disabledModels(profile.id);
    const selected=await vscode.window.showQuickPick(profile.models.map(model=>({label:model,picked:!disabled.has(model)})),{
      canPickMany:true,title:profile.name+' · '+tr('provider.manageModels'),placeHolder:tr('provider.modelToggleHint')
    });
    if(!selected)return;
    const enabled=new Set(selected.map(item=>item.label));
    for(const model of profile.models){if(enabled.has(model))disabled.delete(model);else disabled.add(model);}
    const previous=this.context.globalState.get<Record<string,string[]>>('disabledProviderModels',{});
    await this.context.globalState.update('disabledProviderModels',{...previous,[profile.id]:[...disabled]});
    const cfg=vscode.workspace.getConfiguration('cude-ai');
    const current=globalSetting<string>(cfg,'model','');
    if(globalSetting<string>(cfg,'activeProviderId','')===profile.id&&disabled.has(current)){
      await cfg.update('model',profile.models.find(model=>!disabled.has(model))||'',vscode.ConfigurationTarget.Global);
    }
    this.notifyModels();
  }
  /** Speech-to-text through a connected OpenAI or Groq profile (Whisper). Returns undefined when none is connected. */
  async transcribe(file:string,lang:string,signal?:AbortSignal):Promise<{text:string;via:string}|undefined>{
    for(const profile of this.profiles()){
      let base:string;
      try{base=validateProviderBase(profile.baseUrl||(profile.provider==='openai'?'https://api.openai.com/v1':''));}catch{continue;}
      const endpoint=new URL(base);
      const groq=endpoint.origin==='https://api.groq.com'&&endpoint.pathname==='/openai/v1';
      if(!groq&&(endpoint.origin!=='https://api.openai.com'||endpoint.pathname!=='/v1'))continue;
      const {key}=await readProviderCredentials(this.secrets,{...profile,baseUrl:base});if(!key)continue;
      const upload=lang==='tr'?'Sesi yükle':'Upload recording';
      const detail=lang==='tr'?'Kayıt '+endpoint.origin+' adresine gönderilecek. İptal ederseniz Windows kaydı cihazda işleyecek.':'The recording will be sent to '+endpoint.origin+'. Cancel to transcribe on this device with Windows.';
      if(signal?.aborted||await vscode.window.showInformationMessage(lang==='tr'?'Bulut ile yazıya dökülsün mü?':'Transcribe using the cloud?',{modal:true,detail},upload)!==upload||signal?.aborted)return undefined;
      try{
        const stat=await fs.stat(file);
        if(stat.size>8_000_000)return undefined;
        const form=new FormData();
        form.append('file',new Blob([await fs.readFile(file)],{type:'audio/wav'}),'voice.wav');
        form.append('model',groq?'whisper-large-v3-turbo':'whisper-1');
        if(lang==='tr')form.append('language','tr');
        const response=await globalThis.fetch(base+'/audio/transcriptions',{method:'POST',headers:{authorization:'Bearer '+key},body:form,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),redirect:'error'});
        const data=JSON.parse(await boundedMcpBody(response,131072));
        return response.ok&&typeof data?.text==='string'?{text:data.text.trim().slice(0,20000),via:profile.name}:undefined;
      }catch{return undefined;}
    }
    return undefined;
  }
  async chatModels(){await this.editorModels.refresh();return Promise.all([...this.profiles(),...this.editorModels.profiles()].map(async p=>({id:p.id,name:p.name,provider:p.provider,models:this.enabledProfile(p).models})));}
chatModelState(){const c=vscode.workspace.getConfiguration('cude-ai'),catalog=this.catalog.current?.models||[],freeModels=catalog.filter(isFreeCatalogModel);const candidates=this.allProfiles(),providers=candidates.map(profile=>this.enabledProfile(profile)),active=globalSetting<string>(c,'activeProviderId',''),model=globalSetting<string>(c,'model','');return{providers,active,model:model!=='__cude_router__'&&(this.disabledModels(active).has(model)||(active==='cude-pool'&&!providers.some(item=>item.id===active))||(active.startsWith('editor-lm:')&&!providers.some(item=>item.id===active&&item.models.includes(model))))?'':model,catalogCount:catalog.length,catalogProviders:this.catalog.current?.providers.length||0,freeCatalogCount:freeModels.length,freeModels:freeModels.filter(record=>!this.isCatalogModelDisabled(record,candidates)).slice(0,160).map(item=>({providerId:item.providerId,connectionId:this.catalogConnection(item,candidates)?.id,provider:item.provider,model:item.modelId,name:item.name,trainingPolicy:'unknown'}))};}
  async catalogSnapshot(){return this.catalog.snapshotOrLoad();}
  async refreshCatalog(){const next=await this.catalog.refresh();this.notifyModels();return next;}
  private async discover(provider:string,baseUrl:string,key:string,extraHeaders:Record<string,string>={},proxy=''){
    const base=validateProviderBase(baseUrl),headers:Record<string,string>={};let url=base+'/models';
    if(provider==='ollama'){url=base.replace(/\/v1$/,'')+'/api/tags';}
    // Token Harbor uses its universal Bearer key for model discovery in both presets.
    const nativeAnthropicCatalog=provider==='anthropic'&&base!=='https://tokenharbor.ai/v1';
    if(nativeAnthropicCatalog){headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
    if(provider==='gemini'&&key)headers['x-goog-api-key']=key;
    if(provider==='azure'&&key)headers['api-key']=key;
    if(key&&!nativeAnthropicCatalog&&!['gemini','azure'].includes(provider))headers.authorization=`Bearer ${key}`;
    Object.assign(headers,providerHeaders(extraHeaders));
    const response=await this.request(url,{headers,signal:AbortSignal.timeout(15000)},proxy);
    if(response.status===401||response.status===403||response.status===429){await response.body?.cancel().catch(()=>{});throw new Error(tr(response.status===429?'provider.rateLimited':'provider.authenticationFailed'));}
    if(!response.ok){const raw=await boundedMcpBody(response,64000).catch(()=>'');let detail=raw;try{const parsed=JSON.parse(raw);const msg=parsed?.error?.message??parsed?.message??parsed?.error;if(typeof msg==='string')detail=msg;}catch{}throw new Error(tr('provider.modelListFailed',{status:response.status,detail:redactSecrets(detail.replace(/\s+/g,' ').trim(),[key,...Object.values(extraHeaders)]).slice(0,160)}));}
    const data:any=JSON.parse(await boundedMcpBody(response,8_000_000));
    const modelEfforts: Record<string,string[]> = Object.create(null);
    if(Array.isArray(data.data))for(const row of data.data){
      const efforts = row?.reasoning_efforts ?? row?.efforts;
      if(typeof row?.id==='string' && Array.isArray(efforts)){
        const allowed = [...new Set(efforts.filter((value:unknown): value is string => ['low','medium','high'].includes(String(value))))];
        if(allowed.length)modelEfforts[row.id]=allowed;
      }
    }
    this.advertisedEfforts.set(base,modelEfforts);
    const raw=provider==='ollama'?data.models?.map((x:any)=>x.name):data.data?.map((x:any)=>x.id)||data.models?.map((x:any)=>x.name||x.id);
    return [...new Set((raw||[]).filter((x:any)=>typeof x==='string'&&x.trim()).map((x:string)=>provider==='gemini'?x.replace(/^models\//,''):x))] as string[];
  }
  async importNvidiaCredential() {
    const [file] = await vscode.window.showOpenDialog({
      title: language()==='tr' ? 'NVIDIA anahtar dosyasını seç' : 'Select NVIDIA key file',
      canSelectMany: false, filters: { Text: ['txt'] }
    }) || [];
    if (!file) return;
    const stat = await vscode.workspace.fs.stat(file);
    if (stat.size > 65_536) throw new Error('Select a small text file containing one NVIDIA key.');
    const input = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    const keys = [...new Set(input.match(/nvapi-[A-Za-z0-9_-]{30,}/g) || [])];
    if (keys.length !== 1) throw new Error('The selected file must contain exactly one NVIDIA key.');
    const baseUrl = 'https://integrate.api.nvidia.com/v1';
    const models = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: language()==='tr' ? 'NVIDIA modelleri alınıyor' : 'Discovering NVIDIA models'
    }, () => this.discover('nvidia', baseUrl, keys[0]));
    if (!models.length) throw new Error('NVIDIA returned no models for this account.');
    const config = vscode.workspace.getConfiguration('cude-ai');
    const profiles = this.profiles();
    const previous = profiles.find(item => item.id === 'nvidia-nim-personal');
    const profile: ProviderProfile = { id: 'nvidia-nim-personal', name: 'NVIDIA NIM', provider: 'nvidia', baseUrl, models, modelEfforts:this.advertisedEfforts.get(baseUrl) };
    const old=await readProviderCredentials(this.secrets,profile);
    await writeProviderCredentials(this.secrets,profile,{...old,key:keys[0]});
    try {
      await config.update('providers', [...profiles.filter(item => item !== previous), profile], vscode.ConfigurationTarget.Global);
    } catch (error) {
      await writeProviderCredentials(this.secrets,profile,old);
      throw error;
    }
    await this.selectModel(profile.id, models.find(model=>model==='nvidia/nemotron-3.5-bolt-e4b')||models[0]);
    this.notifyModels();
    void vscode.window.showInformationMessage('NVIDIA NIM · ' + models.length + (language()==='tr' ? ' model bulundu.' : ' models discovered.'));
  }
  private editorImportRunning=false;
  async importProvidersFromEditors(){
    if(this.editorImportRunning)return;
    this.editorImportRunning=true;
    const tr=language()==='tr',yes=tr?'Onayla':'Allow';
    try{
      const result=await importEditorProviders({
        allowRead:async()=>await vscode.window.showWarningMessage(tr?'Editör ayar dosyaları okunsun mu?':'Read editor configuration files?',{modal:true,detail:tr?'Zed, Continue, OpenCode, VS Code, Cursor ve Windsurf ayarlarında düz metin API anahtarları bulunabilir. Okuma izni veriyorsunuz; her sağlayıcının içe aktarılması ve anahtarının Cude gizli deposuna taşınması ayrıca onaylanır. Yerel Ollama ve LM Studio uçları da kontrol edilir.':'Zed, Continue, OpenCode, VS Code, Cursor and Windsurf settings may contain plaintext API keys. This permits reading them. Each provider import and key transfer to Cude secure storage requires separate approval. Local Ollama and LM Studio endpoints are also checked.'},yes)===yes,
        scan:()=>scanEditorProviders({home:os.homedir(),appData:process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),workspace:root(),consent:true,localModels:localEditorModels}),
        select:async providers=>{
          if(!providers.length){void vscode.window.showInformationMessage(tr?'İçe aktarılabilecek sağlayıcı bulunamadı.':'No importable providers found.');return [];}
          const picks=await vscode.window.showQuickPick(providers.map(p=>({label:p.name,description:`${p.source} · ${p.baseUrl}`,detail:tr?`Anahtar: ${p.keyReference?'başvuru (çözülmez)':p.hasKey?'var':'yok'} · ${p.models.length} model`:`Key: ${p.keyReference?'reference (not resolved)':p.hasKey?'present':'absent'} · ${p.models.length} models`,candidate:p})),{canPickMany:true,title:tr?'Editörlerden sağlayıcı içe aktar':'Import Providers From Editors',matchOnDescription:true});
          return picks?.map(p=>p.candidate)||[];
        },
        approve:async p=>await vscode.window.showWarningMessage(tr?`${p.name} Cude profiline eklensin mi?`:`Add ${p.name} to Cude profiles?`,{modal:true,detail:`${p.source}\n${p.baseUrl}`},yes)===yes,
        approveKey:async p=>await vscode.window.showWarningMessage(tr?`${p.name} API anahtarı taşınsın mı?`:`Copy the API key for ${p.name}?`,{modal:true,detail:tr?'Yalnız bu sağlayıcının düz metin anahtarı Cude SecretStorage alanına yazılır. Onaylamazsanız profil anahtarsız eklenir.':'Only this provider’s plaintext key will be copied to Cude SecretStorage. Declining imports the profile without a key.'},yes)===yes,
        save:async(p,key)=>{
          const profile:ProviderProfile={id:'provider-'+randomBytes(12).toString('hex'),name:p.name,provider:p.provider,baseUrl:validateProviderBase(p.baseUrl),models:p.models};
          if(this.profiles().some(old=>old.name===profile.name&&old.provider===profile.provider&&old.baseUrl===profile.baseUrl))return;
          try{
            if(key)await writeProviderCredentials(this.secrets,profile,{key,headers:{},proxy:''});
            await vscode.workspace.getConfiguration('cude-ai').update('providers',[...this.profiles(),profile],vscode.ConfigurationTarget.Global);
          }catch{await this.secrets.delete(credentialSlot(profile));throw new Error(tr?'Sağlayıcı içe aktarılamadı.':'Provider import failed.');}
        }
      });
      this.notifyModels();
      void vscode.window.showInformationMessage(tr?`${result.count} sağlayıcı işlendi; ${result.skipped} ayar dosyası atlandı.`:`Processed ${result.count} providers; skipped ${result.skipped} configuration files.`);
    }finally{this.editorImportRunning=false;}
  }
  private async probe(provider:string,baseUrl:string,key:string,model:string,extraHeaders:Record<string,string>={},proxy=''){const base=validateProviderBase(baseUrl),hidden=[key,...Object.values(extraHeaders)].filter(Boolean);try{await callProvider({provider,base,model,messages:[{role:'user',content:'Reply OK.'}],key,headers:extraHeaders,stream:false,maxTokens:16,signal:AbortSignal.timeout(20000),fetch:(url,init)=>this.request(url,init as any,proxy) as any,text:(name,values)=>name==='empty'?'__cude_empty__':wireText(name,values),redact:value=>redactSecrets(value,hidden)});}catch(error:any){if(error?.message==='__cude_empty__')return true;if(error instanceof WireHttpError){if([401,403,429].includes(error.status))throw error;throw new Error(tr('provider.probeFailed',{status:error.status,detail:readableProviderError(error.body).slice(0,140)}));}throw error;}return true;}
  private async formCredentials(message:any){
    const id=typeof message?.id==='string'?message.id:'';
    const profile=this.profiles().find(item=>item.id===id);
    const endpoint=validateProviderBase(String(message?.url||''));
    const destination={id,provider:String(message?.provider||''),baseUrl:endpoint};
    const unchanged=!!profile&&credentialSlot(profile)===credentialSlot(destination);
    const previous=await readProviderCredentials(this.secrets,profile);
    const stored=unchanged?previous:emptyProviderCredentials();
    const typedKey=typeof message?.key==='string'?message.key.trim():'';
    const headers=restoreMaskedHeaders(parseCustomHeaders(message?.customHeaders),stored.headers);
    const proxy=validateProxy(restoreMaskedProxy(String(message?.proxy||''),stored.proxy));
    const host=new URL(endpoint).hostname.toLowerCase();
    const keyPreset=PROVIDER_PRESETS.find(item=>item.category!=='Local'&&item.auth!=='none'&&
      (new URL(item.baseUrl).hostname.toLowerCase()===host||
        (item.provider==='azure'&&destination.provider==='azure'&&host.endsWith('.openai.azure.com'))));
    const hasAuthHeader=Object.keys(headers).some(name=>['authorization','x-api-key','api-key','x-goog-api-key'].includes(name.toLowerCase()));
    if(keyPreset&&!typedKey&&!stored.key&&!hasAuthHeader){
      throw new Error(host==='api.openai.com'?tr('provider.openAiKeyMissing'):tr('provider.keyRequired',{name:keyPreset.name}));
    }
    return {key:typedKey||stored.key,headers,proxy,droppedStoredKey:!typedKey&&!unchanged&&!!previous.key};
  }
  private providerMedia?: Promise<{html:string; selectStyle:string}>;
  private async loadProviderIcons(media:string):Promise<Record<string,string>>{
    const raw=await fs.readFile(path.join(media,'provider-icons.json'),'utf8');
    const parsed:unknown=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object')return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry):entry is [string,string]=>
      /^[a-z0-9-]{1,40}$/.test(entry[0])&&typeof entry[1]==='string'&&
      entry[1].startsWith('<svg')&&!/<script|\son[a-z]+=|javascript:/i.test(entry[1])));
  }
  refreshProviderLanguage() {
    for (const view of this.poolQuotaPanels) void view.postMessage({type:'language',language:language()}).then(undefined,()=>{});
  }
  warmProviderMedia() {
    if (!this.providerMedia) {
      const media = vscode.Uri.joinPath(this.context.extensionUri, 'media').fsPath;
      this.providerMedia = Promise.all([
        fs.readFile(path.join(media, 'providers.html'), 'utf8'),
        fs.readFile(path.join(media, 'webview-select.css'), 'utf8')
      ]).then(([html, selectStyle]) => ({html, selectStyle})).catch(error => {
        this.providerMedia = undefined;
        throw error;
      });
    }
    return this.providerMedia;
  }
  async configure(focus:string=''){
    const cfg=vscode.workspace.getConfiguration('cude-ai'), nonce=randomBytes(18).toString('base64url');
    const profiles=this.profiles(), active=globalSetting<string>(cfg,'activeProviderId',''), selected=profiles.find(p=>p.id===active)||profiles[0], provider=selected?.provider||globalSetting<string>(cfg,'provider','openai-compatible'), base=selected?.baseUrl||globalSetting<string>(cfg,'baseUrl','http://localhost:11434/v1');
    const {html:providerHtml,selectStyle}=await this.warmProviderMedia();
    const catalog=this.catalog.current||{schemaVersion:1,sources:{},models:[],providers:[],updatedAt:''};
    const safeJson=(value:unknown)=>JSON.stringify(value).replaceAll('<','\\u003c');
    const localAgents=[['codex-cli','Codex CLI'],['claude-code','Claude Code'],['opencode-cli','OpenCode CLI'],['gemini-cli','Gemini CLI'],['qwen-code','Qwen Code'],...EDITOR_CLIS.map(cli=>[cli.id,cli.name])].map(([id,name])=>({id,name,installed:false,path:''})),localModels:LocalModelRecord[]=[];
    const localEnabled=this.localModels.enabled;
    setLocalModelsLanguage(language());
    let device={ramBytes:0,vramBytes:0,cpuCores:0,gpu:'',usableBytes:0};
    const today=new Date().toISOString().slice(0,10),usage=this.context.globalState.get<any>('routerUsage',{day:today,requests:0}),requestUsage=usage.day===today?Number(usage.requests)||0:0,requestLimit=globalSetting(cfg,'router.maxDailyRequests',200);
    const panel=vscode.window.createWebviewPanel('cudeProvider','Cude · Provider',vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[]});
    const quotaView=panel.webview;
    let disposed=false,providerLoading=false;
    this.poolQuotaPanels.add(quotaView);
    const post=(message:object)=>{
      if(disposed)return;
      void Promise.resolve(quotaView.postMessage(message)).catch(()=>{});
    };
    panel.onDidDispose(()=>{
      disposed=true;
      this.poolQuotaPanels.delete(quotaView);
      if(!this.poolQuotaPanels.size)this.poolQuotaRefresh?.abort();
    });
    quotaView.html=fillTemplate(providerHtml,{WEBVIEW_SELECT:selectStyle,LOCAL_HIDDEN:this.localModels.enabled?'':'hidden',CLI_ENABLED:this.cliEnabled()?'true':'false',ICONS:'{}',POOL_URL:safeJson(this.poolUrl()),NONCE:nonce,PRESETS:safeJson(connectionPresets(catalog)),PROFILES:safeJson(profiles),LOCAL_AGENTS:safeJson(localAgents),LOCAL_MODELS:safeJson(localModels),FREE_PROVIDERS:safeJson(FREE_PROVIDERS),RECOMMENDED_MODELS:safeJson(recommendedLocalModels(device)),DEVICE:safeJson({ram:device.ramBytes,vram:device.vramBytes,cores:device.cpuCores,gpu:device.gpu,usable:device.usableBytes,directory:this.localModels.directoryPath}),CATALOG:safeJson({models:catalog.models.length,providers:catalog.providers.length,freeModels:catalog.models.filter(isFreeCatalogModel).length,freeOnly:globalSetting(cfg,'router.freeOnly',false),requestUsage,requestLimit,updatedAt:catalog.updatedAt}),ACTIVE:safeJson(active),FOCUS:safeJson(focus),LANG:language(),I18N:safeJson(I18N)});
    quotaView.onDidReceiveMessage(async message=>{try{
       if(disposed||!isBoundedPanelMessage(message))return;
       if(message.type==='importEditors'){await this.importProvidersFromEditors();post({type:'profiles',profiles:this.profiles()});return;}
       if(message.type==='providerReady'){
         if(providerLoading)return;providerLoading=true;
         const media=vscode.Uri.joinPath(this.context.extensionUri,'media').fsPath;
         void this.loadProviderIcons(media).then(icons=>post({type:'providerIcons',icons})).catch(()=>{});
         void this.catalog.snapshotOrLoad().then(value=>post({type:'providerCatalog',presets:connectionPresets(value),catalog:{models:value.models.length,providers:value.providers.length,freeModels:value.models.filter(isFreeCatalogModel).length,updatedAt:value.updatedAt}})).catch(()=>{});
         if(localEnabled)void this.localModels.refresh().then(models=>post({type:'localModelList',models})).catch(()=>{});
         post({type:'bridgeStatus',active:desktopBridgeActive()});
         void appBridgeState().then(state=>post({type:'appBridge',state})).catch(()=>{});
         setTimeout(()=>{if(disposed)return;device=detectDevice();post({type:'providerDevice',device:{ram:device.ramBytes,vram:device.vramBytes,cores:device.cpuCores,gpu:device.gpu,usable:device.usableBytes,directory:this.localModels.directoryPath},recommended:recommendedLocalModels(device)});const installed=localCliInventory();post({type:'providerAgents',agents:localAgents.map(agent=>{const found=installed.find(item=>item.id===agent.id);return {...agent,installed:!!found,path:found?.path||''};})});providerLoading=false;},0);
         return;
       }
       await assertActivityAllowed();
       if(message.type==='connectDesktopApp'){
         if(!desktopBridgeTargets().some(target=>target.id===message.app))return;
         await vscode.commands.executeCommand('cude-ai.connectDesktopApps',message.app);
         post({type:'bridgeStatus',active:desktopBridgeActive()});void appBridgeState().then(state=>post({type:'appBridge',state})).catch(()=>{});return;
       }
       if(message.type==='setComputerUse'||message.type==='setBrowserControl'||message.type==='setAllowedApps'||message.type==='stopComputer'||message.type==='showDesktopApps'){
         const conf=vscode.workspace.getConfiguration('cude-ai');
         if(message.type==='setComputerUse'){await conf.update('computer.enabled',message.enabled===true,vscode.ConfigurationTarget.Global);if(message.enabled!==true)await vscode.commands.executeCommand('cude-ai.stopComputer');}
         if(message.type==='setBrowserControl')await conf.update('browser.enabled',message.enabled===true,vscode.ConfigurationTarget.Global);
         if(message.type==='setAllowedApps')await conf.update('computer.allowedApps',String(message.apps||'').split(/[,\n]/).map(x=>x.trim().replace(/\.exe$/i,'')).filter(x=>/^[\w .-]{1,60}$/.test(x)).slice(0,50),vscode.ConfigurationTarget.Global);
         if(message.type==='stopComputer')await vscode.commands.executeCommand('cude-ai.stopComputer');
         if(message.type==='showDesktopApps')await vscode.commands.executeCommand('cude-ai.showDesktopApps');
         void appBridgeState().then(state=>post({type:'appBridge',state})).catch(()=>{});return;
       }
       if(message.type==='refreshPoolQuota'){await this.refreshPoolQuota(true);return;}
       if(message.type==='manageProviderModels'){await this.manageModels(typeof message.id==='string'&&message.id?message.id:undefined);return;}
       if(message.type==='connectPool'){
         if(!this.poolUrl()){await vscode.commands.executeCommand('workbench.action.openSettings','@id:cude-ai.freePool.url');return;}
         if(new URL(this.poolUrl()).protocol!=='https:'){post({message:language()==='tr'?'Cude Havuzu adresi HTTPS olmalı. Bu adresle cihaz kaydı yapılamaz; operatör anahtarı için Gelişmiş bağlantıyı kullanın.':'The Cude Pool address must use HTTPS. Device sign-up is not possible on this address; use Advanced connection for an operator key.',error:true});await this.refreshPoolQuota(true);return;}
         await this.refreshPoolQuota(true);return;
       }
       if(message.type==='configurePoolOperator'){await this.configurePool();return;}
       if(message.type==='chooseTheme'){await new Promise(resolve=>setTimeout(resolve,120));await vscode.commands.executeCommand('workbench.action.selectTheme');return;}
       if(message.type==='openAcp'){await vscode.commands.executeCommand('cude-ai.acpPrompt');return;}
       if(message.type==='searchLocalModels'){const requestId=String(message.requestId||'');try{const results=await searchHuggingFace(String(message.query||''),device);post({type:'localSearchResults',requestId,models:results,device:{ram:device.ramBytes,vram:device.vramBytes,cores:device.cpuCores,gpu:device.gpu,usable:device.usableBytes}});}catch(error:any){post({type:'localSearchError',requestId,message:error?.message||String(error)});}return;}
       if(message.type==='inspectLocalModel'){const repo=String(message.repo||'');try{const model=await inspectHuggingFaceModel(repo,device);post({type:'localModelDetails',model});}catch(error:any){post({type:'localModelDetailsError',repo,message:error?.message||String(error)});}return;}
       if(message.type==='openFreeKey'){const item=FREE_PROVIDERS.find(provider=>provider.id===message.providerId);if(item)await vscode.env.openExternal(vscode.Uri.parse(item.keyUrl));return;}
       if(message.type==='setLanguage'){const choice=message.language==='tr'?'tr':'en';await cfg.update('language',choice,vscode.ConfigurationTarget.Global);return;}
       if(message.type==='selectFreeProvider'){const item=FREE_PROVIDERS.find(provider=>provider.id===message.providerId),preset=localizedPresets().find(value=>value.id===item?.profileId);if(preset){post({type:'selectPreset',preset});}return;}
       if(message.type==='setFreeOnly'){await cfg.update('router.freeOnly',!!message.value,vscode.ConfigurationTarget.Global);this.notifyModels();post({type:'freeOnly',value:!!message.value});return;}
       if(message.type==='setRequestLimit'){const value=Math.max(1,Math.min(10000,Math.floor(Number(message.value)||200)));await cfg.update('router.maxDailyRequests',value,vscode.ConfigurationTarget.Global);post({type:'requestLimit',value});return;}
       if(message.type==='chooseModelFolder'){const current=this.localModels.directoryPath;const picked=await vscode.window.showOpenDialog({title:tr('local.folderTitle'),canSelectFiles:false,canSelectFolders:true,canSelectMany:false,openLabel:tr('local.chooseFolder'),defaultUri:vscode.Uri.file(current)});if(!picked?.[0])return;await cfg.update('localModelDirectory',picked[0].fsPath,vscode.ConfigurationTarget.Global);await fs.mkdir(picked[0].fsPath,{recursive:true});const models=await this.localModels.refresh();this.notifyModels();post({type:'localFolder',path:picked[0].fsPath});post({type:'localModelList',models});return;}
       if(message.type==='downloadLocalModel'){const file=await resolveHuggingFaceFile(String(message.repo||''),String(message.file||'')),directory=this.localModels.directoryPath;if(file.size>device.usableBytes)throw new Error(tr('local.modelTooLarge',{size:(file.size/1024**3).toFixed(1)}));await fs.mkdir(directory,{recursive:true});const disk=await fs.statfs(directory),free=Number(disk.bavail)*Number(disk.bsize),drive=path.parse(directory).root;if(file.size&&free<file.size+1024**3)throw new Error(tr('local.noSpace',{drive}));if(drive.toLowerCase()==='c:\\'&&free<10*1024**3)post({type:'localWarning',message:tr('local.cDriveWarning')});const controller=new AbortController(),downloadId=`${file.repo}/${file.name}`;this.localDownload?.abort();this.localDownload=controller;const destination=await downloadHuggingFaceModel(file,directory,(received,total)=>post({type:'localDownloadProgress',id:downloadId,received,total}),controller.signal);await this.localModels.addModel({name:path.basename(destination),path:destination,size:(await fs.stat(destination)).size,repo:file.repo,license:file.license,sha256:file.sha256});this.notifyModels();post({type:'localDownloaded',model:{name:path.basename(destination),path:destination,size:file.size,repo:file.repo,license:file.license},directory});return;}
       if(message.type==='pauseLocalDownload'){this.localDownload?.abort();this.localDownload=undefined;post({type:'localDownloadPaused',message:tr('local.downloadPaused')});return;}
       if(message.type==='useLocalModel'){const profile=this.localModels.profileList().find(item=>item.deployment===message.path);if(!profile)throw new Error(tr('local.modelMissing'));await this.selectModel(profile.id,profile.models[0]);post({type:'localModelStarted',model:profile.models[0]});return;}
       if(message.type==='deleteProfile'){const profile=this.profiles().find(item=>item.id===message.id);if(!profile)throw new Error(tr('provider.profileNotFound'));const yes=tr('provider.deleteConfirmYes');const choice=await vscode.window.showWarningMessage(tr('provider.deleteConfirm',{name:profile.name}),{modal:true},yes);if(choice!==yes)return;await writeProviderCredentials(this.secrets,profile,{key:'',headers:{},proxy:''});await cfg.update('providers',this.profiles().filter(item=>item.id!==profile.id),vscode.ConfigurationTarget.Global);if(globalSetting<string>(cfg,'activeProviderId','')===profile.id){const fallback=this.allProfiles().find(item=>item.id!==profile.id&&item.models?.length);if(fallback)await this.selectModel(fallback.id,fallback.models[0]);else await cfg.update('activeProviderId','',vscode.ConfigurationTarget.Global);}this.notifyModels();panel.dispose();void this.configure();return;}
       if(message.type==='startLocalServer'){
         const id=String(message.id),executable=await installedLocalServer(id);if(!executable)throw Error('Local server installation not found / Yerel sunucu kurulumu bulunamadı');
         const trUI=language()==='tr',yes=trUI?'Başlat':'Start';
         if(await vscode.window.showInformationMessage((trUI?'Yerel sunucu başlatılsın mı? ':'Start local server? ')+executable,{modal:true},yes)!==yes)return;
         await new Promise<void>((resolve,reject)=>{const child=spawn(executable,id==='ollama'?['serve']:[],{windowsHide:true,shell:false,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
         post({message:trUI?'Sunucu başlatıldı. Modelleri yükledikten sonra Yeniden Tara ile bağlanın.':'Server started. Load a model, then scan again to connect.'});return;
       }
       if(message.type==='connectLocalServer'){
         const preset=PROVIDER_PRESETS.find(p=>p.category==='Local'&&p.id===message.id);if(!preset)throw Error('Unknown local server');
         const connected=await connectLocalServer(()=>this.discover(preset.provider,preset.baseUrl,'') ,async models=>{
           const all=this.profiles(),existing=all.find(p=>p.provider===preset.provider&&p.baseUrl===preset.baseUrl),profile:ProviderProfile={id:existing?.id||'provider-'+randomBytes(12).toString('hex'),name:preset.name,provider:preset.provider,baseUrl:preset.baseUrl,models};
           await cfg.update('providers',[...all.filter(p=>p.id!==profile.id),profile],vscode.ConfigurationTarget.Global);return profile;
         },(profile,model)=>this.selectModel(profile.id,model));this.notifyModels();post({type:'localModelStarted',model:connected.models[0]});return;
       }
       if(message.type==='detectLocalServers'){const local=PROVIDER_PRESETS.filter(preset=>preset.category==='Local'&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(preset.baseUrl+'/'));const seen=new Map<string,Promise<number>>();const probe=(base:string)=>{if(!seen.has(base))seen.set(base,(async()=>{try{const response=await undiciFetch(base.replace(/\/$/,'')+'/models',{signal:AbortSignal.timeout(1500),redirect:'error'});if(!response.ok){await response.body?.cancel();return response.status===401||response.status===403?0:-1;}const body:any=JSON.parse(await boundedMcpBody(response,512_000)||'{}');return Array.isArray(body?.data)?body.data.length:Array.isArray(body?.models)?body.models.length:0;}catch{return -1;}})());return seen.get(base)!;};const results=await Promise.all(local.map(async preset=>({id:preset.id,base:preset.baseUrl,count:await probe(preset.baseUrl)})));const byBase=new Map<string,{id:string;count:number}>();for(const item of results){if(item.count<0)continue;const current=byBase.get(item.base);const preferred=item.base.includes(':8080')?'llama-cpp':item.base.includes(':8000')?'vllm':'';if(!current||item.id===preferred)byBase.set(item.base,{id:item.id,count:item.count});}const installed=await Promise.all(['ollama','lm-studio'].map(async id=>({id,installed:!!await installedLocalServer(id)})));post({type:'localServers',servers:[...byBase.values()],installed});return;}
       if(message.type==='redeemCard'){const url=this.poolUrl(),headers=url?await this.poolHeaders(url):undefined;if(!url||!headers)throw new Error(tr('card.connectFirst'));const code=String(message.code||'').slice(0,80);const response=await deviceFetch(this.context,undiciFetch,url+'/v1/card/redeem',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({code}),redirect:'error',signal:AbortSignal.timeout(15000)});const result:any=JSON.parse(await boundedMcpBody(response,16_000)||'{}');if(!response.ok){post({type:'cardResult',ok:false,message:response.status===429?tr('card.tooMany'):result?.error?.code==='already_used'?tr('card.used'):tr('card.invalid')});return;}const account=parsePoolAccount(result);if(account)post({type:'poolAccount',account});post({type:'cardResult',ok:true,message:tr('card.ok')});void this.refreshPoolQuota();return;}
       if(message.type==='setCliEnabled'){const value=message.value===true;await cfg.update('cliAgents.enabled',value,vscode.ConfigurationTarget.Global);if(value)void loadCliModels(this.context).then(()=>this.notifyModels());if(!value&&globalSetting<string>(cfg,'activeProviderId','').startsWith('cude-cli-')){const fallback=this.allProfiles().find(item=>item.provider!=='local-cli'&&item.models?.length);if(fallback)await this.selectModel(fallback.id,fallback.models[0]);else await cfg.update('activeProviderId','',vscode.ConfigurationTarget.Global);}this.notifyModels();post({type:'cliEnabled',value});return;}
       if(message.type==='pickCliModel'){
         if(!this.cliEnabled())throw new Error(tr('cli.disabledError'));
         const cli=localCliInventory().find(item=>item.id===message.id);if(!cli)throw new Error(tr('local.cliMissing',{name:String(message.id)}));
         const t=language()==='tr';
         await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:t?`${cli.name} modelleri okunuyor…`:`Reading ${cli.name} models…`},()=>loadCliModels(this.context));
         const models=localCliProfile(cli).models||[];
         // Group by upstream provider (opencode/…, nvidia/…, openrouter/…) so same-named models are never confused.
         const groups=new Map<string,string[]>();for(const m of models){const g=m.includes('/')?m.split('/')[0]:(m===cli.model?(t?'Varsayılan':'Default'):cli.name);groups.set(g,[...(groups.get(g)||[]),m]);}
         const items:Array<vscode.QuickPickItem&{model?:string}>=[];
         const customModel=t?'Model kimliği gir…':'Enter model ID…';items.push({label:customModel,model:'__custom__'});
         for(const [group,list] of groups){items.push({label:`${group} (${list.length})`,kind:vscode.QuickPickItemKind.Separator});for(const m of list)items.push({label:m.includes('/')?m.slice(m.indexOf('/')+1):m,description:m.includes('/')?group:(m===cli.model?(t?'programın kendi varsayılanı':'the program default'):''),model:m});}
         const pick=await vscode.window.showQuickPick(items,{title:t?`${cli.name}: ${models.length} model · ${groups.size} sağlayıcı`:`${cli.name}: ${models.length} models · ${groups.size} providers`,placeHolder:t?'Model ara (ad ya da sağlayıcı)':'Search models (name or provider)',matchOnDescription:true});
         if(!pick?.model)return;
         let selected=pick.model;
         if(selected==='__custom__'){
           const value=await vscode.window.showInputBox({title:cli.name,prompt:t?'Aracın desteklediği model kimliği':'A model ID supported by this tool',validateInput:value=>validCliModel(value)?undefined:(t?'Geçersiz model kimliği':'Invalid model ID')});
           if(!value)return;selected=value;
           if(EDITOR_CLIS.some(item=>item.id===cli.id)){const models=[...new Set([...(editorCliModelList.get(cli.id)||[]),selected])];editorCliModelList.set(cli.id,models);await this.context.globalState.update('cliModels.'+cli.id,models);}
         }
         await this.selectModel(`cude-cli-${cli.id}`,selected);this.notifyModels();
         void vscode.window.setStatusBarMessage(t?`Cude AI modeli: ${selected}`:`Cude AI model: ${selected}`,4000);return;
       }
       if(message.type==='useLocalAgent'){if(!this.cliEnabled())throw new Error(tr('cli.disabledError'));const cli=localCliInventory().find(item=>item.id===message.id);if(!cli)throw new Error(tr('local.cliMissing',{name:String(message.name||message.id)}));await this.selectModel(`cude-cli-${cli.id}`,cli.model);post({type:'message',message:tr('local.cliReady',{name:cli.name})});this.notifyModels();return;}
       if(message.type==='loadProfile'){
         const profile=this.profiles().find(item=>item.id===message.id);
         if(!profile)throw new Error(tr('provider.profileNotFound'));
         const {key,headers:parsedHeaders,proxy}=await readProviderCredentials(this.secrets,profile);
         const {customHeaders:_customHeaders,proxy:_proxy,...publicProfile}=profile;
         post({type:'profile',profile:publicProfile,key:'',hasKey:!!key,headers:JSON.stringify(maskHeaders(parsedHeaders)),proxy:maskProxy(proxy)});
         const legacy=await this.secrets.get(SECRET+'.'+profile.id) || await this.secrets.get('cude-ai.headers.'+profile.id) || await this.secrets.get('cude-ai.proxy.'+profile.id);
         if(legacy&&!key&&!proxy&&!Object.keys(parsedHeaders).length) void vscode.window.showWarningMessage(tr('provider.reenterCredentials'));
         return;
       }
       if(message.type==='refreshCatalog'){try{const updated=await this.refreshCatalog();post({catalog:{models:updated.models.length,providers:updated.providers.length,updatedAt:updated.updatedAt},message:tr('provider.catalogSuccess',{models:updated.models.length.toLocaleString(),providers:updated.providers.length.toLocaleString()})});}catch(error:any){post({catalog:{models:this.catalog.current?.models.length||0,providers:this.catalog.current?.providers.length||0},message:tr('provider.catalogFailure',{error:error?.message||String(error)}),error:true});}return;}
       if(message.type==='discover'||message.type==='test'){const started=performance.now(),credentials=await this.formCredentials(message),extraHeaders=credentials.headers,proxy=credentials.proxy;message.key=credentials.key;let models:string[]=[];try{models=await this.discover(message.provider,message.url,message.key,extraHeaders,proxy);const elapsed=Math.round(performance.now()-started);post({type:'models',success:true,models,message:models.length?tr('provider.successLatency',{ms:elapsed,count:models.length}):tr('provider.successNoList',{ms:elapsed})});}catch(error:any){const fallbackModel=String(message.model||message.deployment||message.models?.[0]||'');if(message.type!=='test'||!fallbackModel)throw error;await this.probe(message.provider,message.url,message.key,fallbackModel,extraHeaders,proxy);const elapsed=Math.round(performance.now()-started);post({type:'models',success:true,models:message.models||[],message:tr('provider.successProbe',{ms:elapsed})});}return;}
       if(message.type==='export'){const uri=await vscode.window.showSaveDialog({saveLabel:tr('provider.export'),filters:{JSON:['json']},defaultUri:vscode.Uri.file(path.join(os.homedir(),'providers.json'))});if(!uri)return;const sanitized=this.profiles().map(({id,name,provider,baseUrl,models,organization,project,deployment,timeout})=>({id,name,provider,baseUrl,models,organization,project,deployment,timeout}));await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify({version:1,providers:sanitized},null,2),'utf8'));post({message:tr('provider.exported')});return;}
       if(message.type==='import'){
         const picked=await vscode.window.showOpenDialog({title:tr('provider.import'),canSelectFiles:true,canSelectMany:false,filters:{JSON:['json']}});
         if(!picked?.[0])return;
         const stat=await vscode.workspace.fs.stat(picked[0]);
         if(stat.size>512_000)throw new Error(tr('provider.importInvalid'));
         const bytes=await vscode.workspace.fs.readFile(picked[0]);
         if(bytes.byteLength>512_000)throw new Error(tr('provider.importInvalid'));
         const parsed=JSON.parse(Buffer.from(bytes).toString('utf8'));
         const imported=Array.isArray(parsed)?parsed:parsed?.providers;
         if(!Array.isArray(imported)||imported.length>100)throw new Error(tr('provider.importInvalid'));
         const candidates:ProviderProfile[]=[];
         for(const item of imported){
           if(!item||typeof item.name!=='string'||typeof item.provider!=='string'||typeof item.baseUrl!=='string')continue;
           try{
             const id=typeof item.id==='string'?item.id:'provider-'+randomBytes(12).toString('hex');
             validateProfileIdentity(id,item.provider);
             const text=(value:unknown)=>typeof value==='string'?value.slice(0,160):undefined;
             candidates.push({id,name:item.name.slice(0,48),provider:item.provider,baseUrl:validateProviderBase(item.baseUrl),
               models:Array.isArray(item.models)?item.models.filter((model:unknown)=>typeof model==='string').slice(0,300):[],
               organization:text(item.organization),project:text(item.project),deployment:text(item.deployment),timeout:Math.max(10,Math.min(600,Number(item.timeout)||120))});
           }catch{continue;}
         }
         const {profiles,count}=mergeImportedProfiles(this.profiles(),candidates,()=> 'provider-'+randomBytes(12).toString('hex'));
         if(count)await cfg.update('providers',profiles,vscode.ConfigurationTarget.Global);
         post({message:tr('provider.imported',{count})});
         this.notifyModels();
         return;
       }
      if(message.type==='save'){
        const safe=validateProviderBase(message.url),id=this.profiles().some(item=>item.id===message.id)?message.id:`provider-${randomBytes(12).toString('hex')}`,name=String(message.name||message.provider).trim().slice(0,48),all=this.profiles();
         validateProfileIdentity(id,message.provider);const credentials=await this.formCredentials(message),customHeaders=credentials.headers,proxy=credentials.proxy;let models=Array.isArray(message.models)?message.models.filter((m:any)=>typeof m==='string').slice(0,300):[];let discoveryNote='';if(!models.length){try{models=await this.discover(message.provider,safe,credentials.key,customHeaders,proxy);}catch(error:any){const text=error?.message||String(error);if(text===tr('provider.authenticationFailed'))throw new Error(text);discoveryNote=' '+tr('provider.discoveryFailed',{error:text});}}
          const profile:ProviderProfile={id,name,provider:message.provider,baseUrl:safe,models,modelEfforts:this.advertisedEfforts.get(safe)||all.find(item=>item.id===id&&item.baseUrl===safe)?.modelEfforts,organization:String(message.organization||'').slice(0,160),project:String(message.project||'').slice(0,160),deployment:String(message.deployment||'').slice(0,160),timeout:Math.max(10,Math.min(600,Number(message.timeout)||120))};
        const index=all.findIndex(p=>p.id===id),previous=all[index];if(index>=0)all[index]=profile;else all.push(profile);
         await cfg.update('providers',all,vscode.ConfigurationTarget.Global);await cfg.update('activeProviderId',id,vscode.ConfigurationTarget.Global);await cfg.update('provider',profile.provider,vscode.ConfigurationTarget.Global);await cfg.update('baseUrl',safe,vscode.ConfigurationTarget.Global);await cfg.update('model',([models.includes(message.model)?message.model:'',profile.deployment,...models].find(model=>typeof model==='string'&&model&&!this.disabledModels(id).has(model))||''),vscode.ConfigurationTarget.Global);
         await writeProviderCredentials(this.secrets,profile,{key:credentials.key,headers:customHeaders,proxy});
         if(previous&&credentialSlot(previous)!==credentialSlot(profile))await this.secrets.delete(credentialSlot(previous));
         if(credentials.droppedStoredKey)discoveryNote+=' '+tr('provider.keyDropped');
         post({type:'models',success:true,models:profile.models,message:`${tr('provider.connectionSaved')} ${profile.models.length?(profile.models.length===1?tr('provider.discoveredOne'):tr('provider.discoveredMany',{count:profile.models.length})):tr('provider.chooseBeforeChat')}${discoveryNote}`});this.modelRefresh?.();
      }
     }catch(e:any){post({message:e?.message||String(e),error:true});}});
  }
  async selectModel(providerId:string,model:string){const cfg=vscode.workspace.getConfiguration('cude-ai');if(providerId==='cude-router'||model==='__cude_router__'){await cfg.update('model','__cude_router__',vscode.ConfigurationTarget.Global);return;}const profile=this.allProfiles().find(p=>p.id===providerId);if(!profile)throw new Error(tr('provider.profileNotFound'));this.assertModelEnabled(providerId,model);let base=profile.baseUrl;if(profile.provider==='local-llama')base=await this.localModels.ensureRunning(profile.deployment||'');await cfg.update('activeProviderId',providerId,vscode.ConfigurationTarget.Global);await cfg.update('provider',profile.provider,vscode.ConfigurationTarget.Global);if(base)await cfg.update('baseUrl',base,vscode.ConfigurationTarget.Global);await cfg.update('model',model,vscode.ConfigurationTarget.Global);}
  private async routeCandidates(){const snapshot=await this.catalog.snapshotOrLoad(),latencies=this.context.globalState.get<Record<string,number>>('routerLatency',{}),rows:RouteCandidate[]=[];for(const profile of [...this.profiles(),...this.localModels.profileList()])for(const model of this.enabledProfile(profile).models){const base=(value?:string)=>String(value||'').replace(/\/+$/,'').toLowerCase(),strict=(item:ModelRecord)=>item.modelId===model&&(item.providerId===profile.id||(!!item.baseUrl&&base(item.baseUrl)===base(profile.baseUrl))),strictMetadata=snapshot.models.find(strict),metadata=strictMetadata||snapshot.models.find(item=>item.modelId===model&&profile.name.trim().length>=3&&item.provider.toLowerCase().includes(profile.name.trim().toLowerCase())),openRouter=profile.provider==='openrouter'||/^https:\/\/openrouter\.ai\//i.test(profile.baseUrl||'');
        // "Free only" must fail closed: a model counts as free only on the bundled runtime, an exact catalog match for this endpoint, or an OpenRouter :free id.
        rows.push({providerId:profile.id,provider:profile.name,model,metadata,free:profile.provider==='local-llama'||!!strictMetadata&&isFreeCatalogModel(strictMetadata)||(openRouter&&/:free$/i.test(model)),latencyMs:latencies[`${profile.id}/${model}`]});}return rows;}
  private async chooseRouted(messages:Array<{role:string;content:any}>,signal?:AbortSignal,onDelta?:(delta:string)=>void,onRoute?:(value:{model:string;reason:string})=>void){
    const cfg=vscode.workspace.getConfiguration('cude-ai'),preference=globalSetting<RoutePreference>(cfg,'router.preference','quality'),allowed=globalSetting<string[]>(cfg,'router.allowedProviderIds',[]),freeOnly=globalSetting<boolean>(cfg,'router.freeOnly',false),prompt=messages.map(item=>typeof item.content==='string'?item.content:JSON.stringify(item.content)).join('\n'),kind=classifyTask(prompt),contextNeed=Math.ceil(prompt.length/4),candidates=(await this.routeCandidates()).filter(candidate=>!freeOnly||candidate.free===true);
    const ranked:Array<RouteCandidate>=[],remaining=[...candidates];while(remaining.length){const best=chooseRoute(remaining,preference,kind,allowed,contextNeed);if(!best)break;ranked.push(best);remaining.splice(remaining.indexOf(best),1);}
    if(!ranked.length)throw new Error(tr('router.noCandidates'));
    const now=Date.now(),day=new Date().toISOString().slice(0,10),saved=this.context.globalState.get<any>('routerUsage',{day,requests:0,tokens:0,cost:0});const usage=saved.day===day?saved:{day,requests:0,tokens:0,cost:0};
    const maxRequests=globalSetting<number>(cfg,'router.requestsPerMinute',30),maxDailyRequests=globalSetting<number>(cfg,'router.maxDailyRequests',200),maxTokens=globalSetting<number>(cfg,'router.maxDailyTokens',500000),maxCost=globalSetting<number>(cfg,'router.maxDailyCostUsd',20);
     const promptTokens=Math.ceil(prompt.length/4);this.requestTimes=this.requestTimes.filter(time=>now-time<60000);if(this.requestTimes.length>=maxRequests)throw new Error(tr('router.minuteLimit'));if(usage.requests>=maxDailyRequests)throw new Error(tr('router.dailyRequestLimit'));if(usage.tokens+promptTokens>maxTokens)throw new Error(tr('router.dailyTokenLimit'));const budgetCandidates=ranked.filter(candidate=>usage.cost+estimateUsage(prompt,'',candidate).estimatedCost<=maxCost);if(!budgetCandidates.length)throw new Error(tr('router.dailyCostLimit'));
     let streamed=false;const routed=await withFallback(budgetCandidates,async candidate=>{if(signal?.aborted)throw new Error(tr('router.cancelled'));this.requestTimes=this.requestTimes.filter(time=>Date.now()-time<60000);if(this.requestTimes.length>=maxRequests)throw new Error(tr('router.minuteLimit'));streamed=false;this.requestTimes.push(Date.now());const started=Date.now();const answer=await this.chat(messages,signal,onDelta?(delta=>{streamed=true;onDelta(delta);}):undefined,{providerId:candidate.providerId,model:candidate.model,routed:true});const elapsed=Date.now()-started,latencies=this.context.globalState.get<Record<string,number>>('routerLatency',{});latencies[`${candidate.providerId}/${candidate.model}`]=elapsed;await this.context.globalState.update('routerLatency',latencies);return{answer,cost:estimateUsage(prompt,answer,candidate),elapsed};},error=>!streamed&&isFallbackError(error));const {candidate,value}=routed;await this.context.globalState.update('routerUsage',{day,requests:usage.requests+1,tokens:usage.tokens+value.cost.totalTokens,cost:usage.cost+value.cost.estimatedCost});const why=kind==='completion'?tr('router.why.completion'):kind==='vision'?tr('router.why.vision'):kind==='long-context'?tr('router.why.longContext'):kind==='agent'?tr('router.why.agent'):kind==='review'?tr('router.why.review'):preference==='cost'?tr('router.why.cost'):preference==='speed'?tr('router.why.speed',{ms:value.elapsed}):tr('router.why.quality');onRoute?.({model:candidate.model,reason:why});return value.answer;
  }
  isLocalActive(){const cfg=vscode.workspace.getConfiguration('cude-ai'),profile=this.allProfiles().find(p=>p.id===globalSetting<string>(cfg,'activeProviderId',''));return profile?.provider==='local-llama'||profile?.provider==='ollama'||/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(profile?.baseUrl||'');}
  /** Chat with automatic recovery: when the chosen model is out of quota, retired, unpaid or rejects the key,
   *  Cude retries with the next connected model (max 3) and tells the user instead of leaving them stuck. */
  async chat(messages: Array<{role:string;content:any}>, signal?: AbortSignal, onDelta?:(delta:string)=>void, selected?:{providerId?:string;model?:string;routed?:boolean},onRoute?:(value:{model:string;reason:string})=>void): Promise<string> {
    try{return await this.chatOnce(messages,signal,onDelta,selected,onRoute);}
    catch(error:any){
      const reason=signal?.aborted?undefined:modelUnavailableReason(error);
      if(!reason)throw error;
      const c=vscode.workspace.getConfiguration('cude-ai');
      if(!c.get<boolean>('autoFallback',true))throw error;
      const current={providerId:selected?.providerId||globalSetting<string>(c,'activeProviderId',''),model:selected?.model||globalSetting<string>(c,'model','')};
      if(current.model==='__cude_router__')throw error;
      // After a quota error, free-tier models are the most likely to be out of quota too: try paid/other models first, skip free ones.
      for(const candidate of this.fallbackCandidates(current).filter(item=>!(/quota|kota/.test(reason)&&/(^|[/:-])free$|-free|:free/i.test(item.model))).slice(0,3)){
        if(signal?.aborted)throw error;
        try{
          const reply=await this.chatOnce(messages,signal,onDelta,{providerId:candidate.providerId,model:candidate.model,routed:true},onRoute);
          if(!selected){try{await this.selectModel(candidate.providerId,candidate.model);}catch{}this.notifyModels();}
          void vscode.window.showWarningMessage(language()==='tr'?`${current.model||'Model'} kullanılamadı (${reason}). Cude otomatik olarak ${candidate.model} modeline geçti.`:`${current.model||'The model'} is unavailable (${reason}). Cude switched to ${candidate.model} automatically.`);
          return reply;
        }catch(next:any){if(signal?.aborted)throw next;}
      }
      throw new Error(`${String(error?.message||error)}${language()==='tr'?' — bağlı başka çalışan model bulunamadı; Sağlayıcılar sayfasından yeni bir bağlantı ekleyin.':' — no other working model is connected; add a connection on the Providers page.'}`);
    }
  }
  /** Other connected models to try, best first: different connections first, then the same connection with a different upstream provider. */
  private fallbackCandidates(current:{providerId:string;model:string}){
    const list:Array<{providerId:string;model:string}>=[];
    const upstream=(m:string)=>m.includes('/')?m.split('/')[0]:'';
    const profiles=this.allProfiles().map(profile=>this.enabledProfile(profile)).filter(profile=>profile.id!=='cude-pool'&&profile.provider!=='local-llama');
    for(const profile of profiles){if(profile.id===current.providerId)continue;const model=(profile.models||[]).find(m=>m&&m!=='__cude_router__');if(model)list.push({providerId:profile.id,model});}
    const same=profiles.find(profile=>profile.id===current.providerId);
    if(same)for(const model of same.models||[]){if(model!==current.model&&upstream(model)&&upstream(model)!==upstream(current.model)&&!list.some(item=>item.providerId===same.id&&upstream(item.model)===upstream(model)))list.push({providerId:same.id,model});}
    return list.filter(item=>!(item.providerId.startsWith('cude-cli-')&&!this.cliEnabled()));
  }
  private async chatOnce(messages: Array<{role:string;content:any}>, signal?: AbortSignal, onDelta?:(delta:string)=>void, selected?:{providerId?:string;model?:string;routed?:boolean},onRoute?:(value:{model:string;reason:string})=>void): Promise<string> {
    await assertActivityAllowed();
    signal?.throwIfAborted();
    const c=vscode.workspace.getConfiguration('cude-ai');
    requireTrustedWorkspace('sending project context to an AI provider');
    const requested=selected?.model||globalSetting<string>(c,'model','');if(!selected?.routed&&requested==='__cude_router__')return this.chooseRouted(messages,signal,onDelta,onRoute);
    const rules=await readProjectRules();
    const systemIndex=messages.findIndex(item=>item.role==='system');
    const withRules=rules&&systemIndex>=0?messages.map((message,index)=>index===systemIndex?{...message,content:`${message.content||''}\n\nProject rules from .cude/rules.md:\n${rules}`} : message):messages;
    const effectiveMessages=withRules.map(message=>({...message,content:typeof message.content==='string'?redactCredentialLiterals(message.content):Array.isArray(message.content)?message.content.map(part=>typeof part?.text==='string'?{...part,text:redactCredentialLiterals(part.text)}:part):message.content}));
    const profiles=this.allProfiles(),activeId=selected?.providerId||globalSetting<string>(c,'activeProviderId',''),profile=profiles.find(p=>p.id===activeId);
    if(activeId.startsWith('cude-cli-')&&!this.cliEnabled())throw new Error(tr('cli.disabledError'));
    const provider=profile?.provider||globalSetting<string>(c,'provider','openai-compatible');
    this.assertModelEnabled(activeId,selected?.model||globalSetting<string>(c,'model',profile?.models?.[0]||''));
    if(provider==='editor-lm'||activeId.startsWith('editor-lm:'))return this.editorModels.chat(activeId,selected?.model||globalSetting<string>(c,'model',profile?.models?.[0]||''),effectiveMessages,signal,onDelta);
    if(provider==='local-cli'){
      const cli=localCliInventory().find(item=>`cude-cli-${item.id}`===profile?.id);if(!cli)throw new Error(tr('provider.cliMissing'));
      const content=effectiveMessages.map(item=>`${item.role.toUpperCase()}\n${typeof item.content==='string'?item.content:(item.content||[]).map((part:any)=>part.text||'[image omitted for local CLI]').join('\n')}`).join('\n\n');
      const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');
      const cliModel=selected?.model||globalSetting<string>(c,'model','');
      if(cli.id==='opencode-cli'&&splitOpencodeModel(cliModel)&&permitsLocalCli(cli.id,permission)){
        const workspace=root();if(!workspace)throw new Error(tr('local.err.noProject'));requireTrustedWorkspace('running a local AI agent');
        await approveLocalCliRun(cli,workspace,cli.path,signal);
        localCliSessionGrants.add(`${cli.id}|${workspace}`);
        try{
          const wire=effectiveMessages.map(item=>({role:item.role,content:typeof item.content==='string'?item.content:(item.content||[]).map((part:any)=>part.text||'[image omitted]').join('\n')}));
          const reply=await getOpencodeServer(cli).chat(cliModel,wire,signal);onDelta?.(reply);return reply;
        }catch(error:any){
          if(signal?.aborted)throw error;
          const message=String(error?.message||error);
          // Server could not start at all: fall back to one-shot CLI runs; model/quota errors are surfaced as they are.
          if(/did not start|server exited|ECONNREFUSED|fetch failed/i.test(message))return runLocalCli(cli,content,permission,signal,onDelta,cliModel);
          throw new Error(`OpenCode · ${cliModel}: ${message}`);
        }
      }
      return runLocalCli(cli,content,permission,signal,onDelta,cliModel);
    }
    if((provider==='cude-pool'||activeId==='cude-pool')&&!profile)throw new Error(tr('pool.quotaDenied'));
    if(provider==='cude-pool'&&profile){const model=selected?.model||globalSetting<string>(c,'model',profile.models[0]||'');const info=this.poolModels.find(m=>m.id===model);const effortRaw=String(this.context.globalState.get<string>('effort','')||'').toLowerCase();const effort=/düşük|low/.test(effortRaw)?'low':/yüksek|high/.test(effortRaw)?'high':/orta|medium/.test(effortRaw)?'medium':'';const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),300000);
      const requestSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      try{return await callProvider({provider:'openai-compatible',base:`${profile.baseUrl}/v1`,model,messages:effectiveMessages,headers:await this.poolHeaders(profile.baseUrl),stream:!!onDelta,temperature:0.3,signal:requestSignal,onDelta,extraBody:info?.efforts.includes(effort)?{reasoning_effort:effort}:{},fetch:(url,init)=>deviceFetch(this.context,undiciFetch,url,init) as any,text:wireText});}
      catch(error:any){if(error?.name==='AbortError')throw new Error(tr('provider.timedOut'));if(error instanceof WireHttpError){let creditError=false;try{creditError=JSON.parse(error.body).error?.code==='credit_exhausted';}catch{}if(creditError)throw new Error(language()==='tr'?'Premium kredi yetersiz. Ücretsiz modelleri kullanabilirsiniz.':'Premium credit is insufficient. Free models remain available.');if([401,403,426].includes(error.status)&&this.poolUrl()===profile.baseUrl){this.poolModels=[];this.poolLoaded=profile.baseUrl;this.notifyModels();throw new Error(tr(error.status===426?'pool.updateRequired':'pool.quotaDenied'));}let code='';try{code=JSON.parse(error.body).error?.code||'';}catch{}throw new Error(tr(code==='daily_quota'?'pool.dailyQuota':code==='nythos_quota'?'pool.nythosQuota':code==='busy'?'pool.busy':'pool.serverError'));}throw new Error(tr('pool.serverError'));}finally{clearTimeout(timer);void this.refreshPoolQuota();}}
    if(provider==='local-llama'&&profile){const base=await this.localModels.ensureRunning(profile.deployment||'');await c.update('baseUrl',base,vscode.ConfigurationTarget.Global);}
    const base=validateProviderBase(profile?.provider==='local-llama'?globalSetting<string>(c,'baseUrl',''):profile?.baseUrl||globalSetting<string>(c,'baseUrl','')||(()=>{throw new Error(tr('chat.addProviderFirst').replace(/…$/,'.'));})());
    const model=selected?.model||globalSetting<string>(c,'model',profile?.models?.[0]||'');if(!model)throw new Error(tr('provider.noModelSelected'));
     const {key,headers:extra,proxy}=await readProviderCredentials(this.secrets,profile?{...profile,baseUrl:base}:undefined);
     const legacyId=profile?.id||provider;
     if(!key&&!proxy&&!Object.keys(extra).length&&(await this.secrets.get(SECRET+'.'+legacyId)||await this.secrets.get('cude-ai.headers.'+legacyId)||await this.secrets.get('cude-ai.proxy.'+legacyId)))throw new Error(tr('provider.reenterCredentials'));
     const controller=new AbortController(); const loopback=/^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(base),configured=Math.max(10,profile?.timeout||globalSetting<number>(c,'requestTimeout',120)),timer=setTimeout(()=>controller.abort(),(loopback?Math.max(configured,900):configured)*1000);
    const requestSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try {
       const hidden=[key,...Object.values(extra)].filter(Boolean) as string[];
       const setting=this.context.globalState.get<string>('effort','');
       const effort=({düşük:'low',orta:'medium',yüksek:'high',low:'low',medium:'medium',high:'high'} as Record<string,string>)[setting]||'';
       const extraBody=profile?.modelEfforts?.[model]?.includes(effort)?{reasoning_effort:effort}:undefined;
       const generationStart=performance.now();let generated=0,lastSpeed=0;
       const delta=onDelta&&loopback?(text:string)=>{generated+=text.length;const now=performance.now();if(now-lastSpeed>500){this.localModels.reportSpeed(model,generated,now-generationStart);lastSpeed=now;}onDelta(text);}:onDelta;
       const answer=await callProvider({provider,base,model,messages:effectiveMessages,key:key||'',headers:providerHeaders(extra),organization:profile?.organization,project:profile?.project,stream:!!onDelta,temperature:0.2,signal:requestSignal,onDelta:delta,extraBody,fetch:(url,init)=>this.request(url,init as any,proxy) as any,text:wireText,redact:value=>redactSecrets(value,hidden)});
       if(loopback)this.localModels.reportSpeed(model,answer.length,performance.now()-generationStart);return answer;
     } catch(e:any) { if(e.name==='AbortError')throw new Error(tr('provider.timedOut')); throw e; } finally { clearTimeout(timer); }
  }
}

async function ensureCudeDir() { const r=root(); if(!r)throw new Error(tr('errors.openProjectFolder')); requireTrustedWorkspace('writing project memory/specs'); const d=path.join(r,'.cude'); await assertRealPathInside(r,d); await fs.mkdir(d,{recursive:true}); return d; }
async function memoryText(workspaceOverride?:string) { const r=workspaceOverride||root(); if(!r)return ''; try{const file=path.join(r,'.cude','memory.md');await assertRealPathInside(r,file);if((await fs.stat(file)).size>250000)return '';return await fs.readFile(file,'utf8');}catch{return '';} }
async function readProjectRules(){const workspace=root();if(!workspace||!vscode.workspace.isTrusted)return '';try{const file=path.join(workspace,'.cude','rules.md'),real=await fs.realpath(file),relative=path.relative(workspace,real);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`))return '';if(secretPath(relative)||isMcpProjectFile(real))return '';const stat=await fs.stat(real);if(!stat.isFile()||stat.size>12000)return '';return(await fs.readFile(real,'utf8')).slice(0,12000);}catch{return '';}}
export async function appendProjectMemory(workspace:string,summary:string,now=new Date()){requireTrustedWorkspace('writing project memory');if(!summary.trim())throw new Error(tr('memory.summaryRequired'));const directory=path.join(workspace,'.cude');const file=path.join(directory,'memory.md');await assertRealPathInside(workspace,file);await fs.mkdir(directory,{recursive:true});await fs.appendFile(file,`\n## Session ${now.toISOString().slice(0,10)}\n\n${summary.trim()}\n`,'utf8');return file;}
export async function persistChatSession(state:Pick<vscode.Memento,'get'|'update'>,id:string,workspace:string,messages:Array<{role:'user'|'assistant';content:string}>){if(!messages.length)return;const saved=state.get<ChatSession[]>('chatSessions',[]).filter(item=>item.id!==id);const title=messages.find(message=>message.role==='user')?.content.slice(0,54)||tr('chat.new');const item:ChatSession={id,title,workspace,messages:messages.slice(-40)};await state.update('chatSessions',[item,...saved].slice(0,50));return item;}

export async function runSubagents(delegations:unknown[],execute:(task:{title:string;task:string})=>Promise<string>,onActivity?:(label:string,detail:string)=>void):Promise<SubagentResult[]>{
  const tasks=delegations.filter((item:any)=>item&&typeof item.title==='string'&&typeof item.task==='string').slice(0,3).map((item:any,index:number)=>({id:`subagent-${Date.now().toString(36)}-${index}`,title:item.title.trim().slice(0,80),task:item.task.trim().slice(0,1200)})).filter(item=>item.title&&item.task);
  return Promise.all(tasks.map(async task=>{
    onActivity?.(tr('agent.subagentStarted',{title:task.title}),task.task);
    try{const output=await execute({title:task.title,task:task.task});onActivity?.(tr('agent.subagentDone',{title:task.title}),output.slice(0,600));return{...task,status:'done' as const,output:output.slice(0,4000)};}
    catch(error:any){const output=error?.message||String(error);onActivity?.(tr('agent.subagentFailed',{title:task.title}),output);return{...task,status:'failed' as const,output:output.slice(0,1000)};}
  }));
}

// Project search context for one Cuets worker: same find_files + grep + attachment reading as the agent mode (Agents.start).
async function gatherSearchContext(query:string,workspace:string|undefined,gateway:Gateway,signal?:AbortSignal){
  if(!workspace||!vscode.workspace.isTrusted)return '';
  const files=await findProjectFiles(query,12,workspace);const terms=query.toLowerCase().match(/[a-z0-9_]{4,}/g)||[];const stop=new Set(['what','with','from','that','this','when','where','your','project','please','change','update','fix','make','create','agent','task','kodu','dosya','proje','bunu','şunu','için','gibi','olarak','yap']);const term=terms.find(word=>!stop.has(word));
  const matches=term?await grepProject(term,30,workspace):[];const related=[...new Set([...matches.map(match=>match.file),...files])].slice(0,6);let context=await readProjectAttachments(related,workspace);
  const semantic=await gateway.semanticContext?.(workspace,query,signal);if(semantic)context='Norovox semantic search:\n'+semantic+'\n\n'+context;
  if(matches.length)context+=`\n\nSearch matches:\n${matches.slice(0,20).map(match=>`${match.file}:${match.line}: ${match.text}`).join('\n')}`;return context;
}

// Long-running Cuets: task records live in <workspace>/.cude/tasks/<id>.json (+ .md). Paths are validated against the real workspace root.
async function cuetsTaskDir(workspace:string,create:boolean){
  requireTrustedWorkspace('reading or saving Cuets task state');
  const dir=path.join(workspace,'.cude','tasks');await assertRealPathInside(workspace,path.join(dir,'probe.json'));
  if(create){await fs.mkdir(dir,{recursive:true});await assertRealPathInside(workspace,path.join(dir,'probe.json'));}
  return dir;
}
async function saveCuetsTask(workspace:string,state:CuetsTaskState){
  if(!isValidTaskId(state.id))throw new Error('Invalid Cuets task id.');
  const dir=await cuetsTaskDir(workspace,true),file=path.join(dir,`${state.id}.json`),markdown=path.join(dir,`${state.id}.md`);
  await assertRealPathInside(workspace,file);await assertRealPathInside(workspace,markdown);
  const temp=`${file}.${randomBytes(4).toString('hex')}.tmp`;await fs.writeFile(temp,serializeTaskState(state),'utf8');
  try{await fs.rename(temp,file);}catch(error){await fs.rm(temp,{force:true}).catch(()=>undefined);throw error;}
  await fs.writeFile(markdown,taskMarkdown(state,tr),'utf8');
}
async function readCuetsTask(workspace:string,id:string){
  if(!isValidTaskId(id))return undefined;const dir=await cuetsTaskDir(workspace,false),file=path.join(dir,`${id}.json`);
  try{await assertRealPathInside(workspace,file);const stat=await fs.stat(file);if(stat.size>2_000_000)return undefined;return parseTaskState(await fs.readFile(file,'utf8'));}catch{return undefined;}
}
async function listCuetsTasks(workspace:string){
  let names:string[]=[];try{names=await fs.readdir(await cuetsTaskDir(workspace,false));}catch{return [];}
  const tasks:CuetsTaskState[]=[];for(const name of names.filter(name=>/^[a-z0-9][a-z0-9-]{3,63}\.json$/.test(name)).slice(0,200)){const state=await readCuetsTask(workspace,name.slice(0,-5));if(state)tasks.push(state);}
  return tasks.sort((a,b)=>b.updatedAt-a.updatedAt);
}
/** Cheap root-level probe for test/build commands (package.json scripts, Cargo, pytest, Go). */
async function detectWorkspaceVerification(workspace:string):Promise<CuetsVerifyCommand[]>{
  let entries:string[]=[];try{entries=await fs.readdir(workspace);}catch{return [];}
  const contents:Record<string,string>={};const lower=new Map(entries.map(name=>[name.toLowerCase(),name]));
  for(const name of ['package.json','pyproject.toml','setup.cfg','tox.ini']){const actual=lower.get(name);if(!actual)continue;try{const file=path.join(workspace,actual);const stat=await fs.stat(file);if(stat.isFile()&&stat.size<=300_000)contents[name]=await fs.readFile(file,'utf8');}catch{}}
  return detectVerificationCommands(entries,contents);
}
/** Runs one approved check command with captured, bounded output (head + tail), a timeout and cancellation. */
function runBoundedCommand(command:string,cwd:string,signal?:AbortSignal,timeoutMs=10*60_000):Promise<{exitCode:number|null;output:string;timedOut:boolean}>{
  return new Promise(resolve=>{
    let head='',tail='',dropped=0,timedOut=false,settled=false;const HEAD=3000,TAIL=12000;
    const push=(chunk:Buffer)=>{let text=chunk.toString('utf8');if(head.length<HEAD){const take=text.slice(0,HEAD-head.length);head+=take;text=text.slice(take.length);}if(text){const joined=tail+text;dropped+=Math.max(0,joined.length-TAIL);tail=joined.slice(-TAIL);}};
    let child:import('child_process').ChildProcess;
    try{child=spawn(command,{cwd,shell:true,windowsHide:true,env:{...process.env,CI:'1',FORCE_COLOR:'0',NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});}catch(error:any){resolve({exitCode:null,output:String(error?.message||error),timedOut:false});return;}
    const kill=()=>{try{if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}catch{}};
    const finish=(exitCode:number|null,extra='')=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);resolve({exitCode,timedOut,output:`${head}${dropped?`\n…[${dropped} characters omitted]…\n`:''}${tail}${extra?`\n${extra}`:''}`});};
    const onAbort=()=>{kill();finish(null,'[cancelled]');};
    const timer=setTimeout(()=>{timedOut=true;kill();finish(null,`[timed out after ${Math.round(timeoutMs/1000)} s]`);},timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted){onAbort();return;}
    child.stdout?.on('data',push);child.stderr?.on('data',push);
    child.once('error',(error:Error)=>finish(null,error.message));child.once('close',(code:number|null)=>finish(code));
  });
}

class Agents implements vscode.TreeDataProvider<AgentTreeNode> {
  private emitter=new vscode.EventEmitter<AgentTreeNode|undefined>(); readonly onDidChangeTreeData=this.emitter.event;
  constructor(private context:vscode.ExtensionContext,private gateway:Gateway){}
  list(){return this.context.workspaceState.get<Agent[]>('agents',[]);}
  getTreeItem(node:AgentTreeNode){if(node.kind==='project'){const item=new vscode.TreeItem(node.project,vscode.TreeItemCollapsibleState.Expanded);item.contextValue='cude-agent-project';return item;}const a=node.agent!;const item=new vscode.TreeItem(`${a.status==='done'?'✓':a.status==='failed'?'!':a.status==='running'?'●':'○'} ${a.title}`,vscode.TreeItemCollapsibleState.None);item.description=a.status;item.tooltip=a.output?.slice(0,2000);item.command={command:'cude-ai.openAgentSession',title:'Open agent session',arguments:[a]};return item;}
  getChildren(node?:AgentTreeNode){const agents=this.list();if(!node){const projects=[...new Set(agents.map(a=>a.workspace||tr('agent.noProject')))];return projects.map(project=>({kind:'project' as const,project}));}if(node.kind==='project')return agents.filter(a=>(a.workspace||tr('agent.noProject'))===node.project).map(agent=>({kind:'session' as const,project:node.project,agent}));return [];}
  refresh(){this.emitter.fire(undefined);}
  private save(list:Agent[]){return this.context.workspaceState.update('agents',list).then(()=>this.emitter.fire(undefined));}
  async update(agent:Agent){const list=this.list(),index=list.findIndex(item=>item.id===agent.id);if(index<0)throw new Error(tr('agent.sessionNotFound'));list[index]=agent;await this.save(list);}
  private async publish(agent:Agent){const list=this.list(),index=list.findIndex(item=>item.id===agent.id);if(index>=0)list[index]=agent;else list.unshift(agent);await this.save(list);}
  /** Registers a running agent session without a model call (used by Cuets, which drives its own pipeline). */
  async begin(title:string,permission:Agent['permission']='ask'){const workspace=root(),stamp=Date.now(),agent:Agent={id:`${stamp.toString(36)}-${randomBytes(3).toString('hex')}`,title,status:'running',workspace:workspace?path.basename(workspace):tr('agent.noProject'),workspacePath:workspace,permission,startedAt:stamp,steps:[],artifacts:[],acceptedFiles:[],rejectedFiles:[],subagents:[]};await this.publish(agent);return agent;}
  async start(title:string,onActivity?:(label:string,detail:string)=>void,options:{workspace?:string;worktreePath?:string;baseBranch?:string;permission?:Agent['permission'];providerId?:string;model?:string}={}){await assertActivityAllowed();const workspace=options.workspace||root(),stamp=Date.now(),agent:Agent={id:`${stamp.toString(36)}-${randomBytes(3).toString('hex')}`,title,status:'queued',workspace:workspace?path.basename(workspace):tr('agent.noProject'),workspacePath:workspace,worktreePath:options.worktreePath,baseBranch:options.baseBranch,permission:options.permission||'ask',model:options.model,startedAt:stamp,steps:[],artifacts:[],acceptedFiles:[],rejectedFiles:[]};await this.publish(agent);
    const activity=(label:string,detail:string)=>{agent.activity=label;onActivity?.(label,detail);void this.publish(agent);};
    agent.status='running';await this.publish(agent);
    try{let searchContext='';if(workspace&&vscode.workspace.isTrusted){activity(tr('agent.searchingFileNames'),'cude-core.find_files');const files=await findProjectFiles(title,12,workspace);const terms=title.toLowerCase().match(/[a-z0-9_]{4,}/g)||[];const stop=new Set(['what','with','from','that','this','when','where','your','project','please','change','update','fix','make','create','kodu','dosya','proje','bunu','şunu','için','gibi','olarak','yap']);const term=terms.find(word=>!stop.has(word));let matches:Array<{file:string;line:number;text:string}>=[];if(term){activity(tr('agent.searchingCode'),`cude-core.grep · ${term}`);matches=await grepProject(term,30,workspace);}const related=[...new Set([...matches.map(match=>match.file),...files])].slice(0,6);searchContext=await readProjectAttachments(related,workspace);activity(tr('agent.searchDone'),tr('agent.searchSummary',{files:files.length,matches:matches.length}));if(matches.length)searchContext+=`\n\nSearch matches:\n${matches.slice(0,20).map(match=>`${match.file}:${match.line}: ${match.text}`).join('\n')}`;}
      const semantic=await this.gateway.semanticContext?.(workspace,title);
      if(semantic)searchContext='Norovox semantic search:\n'+semantic+'\n\n'+searchContext;
      const project=(await projectContext(workspace)).slice(0,30000),memory=(await memoryText(workspace)).slice(0,5000),mcpTools=workspace?await agentMcpTools(workspace):[],mcpPrompt=mcpTools.length?` MCP tools are available (browser control, computer use, search or others the user configured). To use one, add a step {"title":"...","kind":"mcp","server":"server name","tool":"tool name","arguments":{...}} using only these tools; each call runs only after the user approves it, so describe it as a proposal. Available: ${mcpTools.map(t=>`${t.server}.${t.name}${t.description?` - ${t.description.slice(0,140)}`:''}${t.inputSchema?` args ${JSON.stringify(t.inputSchema).slice(0,300)}`:''}`).join('; ').slice(0,9000)}`:'';
      const answer=await this.gateway.chat([{role:'system',content:'You are Cude, a careful coding agent. Inspect only supplied context. Return only valid JSON: {"summary":"...","steps":[{"title":"...","kind":"analysis"},{"title":"...","kind":"file","path":"workspace/relative/path","content":"complete proposed file content"},{"title":"...","kind":"command","command":"exact command"}],"subagents":[{"title":"short independent review","task":"a bounded analysis-only subtask"}]}. Propose up to three independent analysis-only subagent tasks only when parallel review improves this task; otherwise return an empty subagents array. Subagents inspect supplied context and return findings only; they must not propose edits, run commands, or claim side effects. Use file steps only when you can provide complete, safe contents. Commands and file writes are proposals only and must never be described as already executed. Prefer small steps. Do not assist with cheats, malware, credential theft, evasion, or unauthorized access; redirect to legal, defensive or permitted alternatives. Preserve reference licenses and attribution.'+mcpPrompt},{role:'user',content:`Task: ${title}\nWorkspace: ${workspace||'none'}\nProject memory:\n${memory}\n\nProject search tools (find_files + grep):\n${searchContext}\n\nProject context:\n${project}`}],undefined,undefined,{providerId:options.providerId,model:options.model});agent.status='done';agent.output=answer;try{const parsed=JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g,''));const summary=typeof parsed.summary==='string'?parsed.summary:answer;agent.steps=Array.isArray(parsed.steps)?parsed.steps.map((x:any)=>x&&typeof x.server==='string'&&typeof x.tool==='string'&&x.kind!=='file'&&x.kind!=='command'&&mcpTools.some(t=>t.server===x.server&&t.name===x.tool)?{...x,kind:'mcp'}:x).filter((x:any)=>x&&typeof x.title==='string'&&['file','command','analysis','mcp'].includes(x.kind)).map((x:any,i:number)=>({id:`${agent.id}-${i}`,title:x.title,kind:x.kind,path:x.path,content:x.content,command:x.command,server:typeof x.server==='string'?x.server.slice(0,120):undefined,tool:typeof x.tool==='string'?x.tool.slice(0,120):undefined,arguments:x.arguments&&typeof x.arguments==='object'&&!Array.isArray(x.arguments)&&JSON.stringify(x.arguments).length<=32768?x.arguments:{}})):[];agent.subagents=await runSubagents(Array.isArray(parsed.subagents)?parsed.subagents:[],async task=>this.gateway.chat([{role:'system',content:'You are a read-only Cude subagent. Analyze only the supplied project information and requested independent subtask. Return concise findings and evidence. Do not propose edits or commands; do not claim actions. Do not assist with cheats, malware, credential theft, evasion, or unauthorized access.'},{role:'user',content:`Parent task: ${title}\nYour independent review: ${task.title}\n${task.task}\n\nProject search/context:\n${searchContext}\n\nRepository context:\n${project}`}],undefined,undefined,{providerId:options.providerId,model:options.model}),activity);agent.output=agent.subagents.length?`${summary}\n\nParallel reviews:\n${agent.subagents.map(item=>`- ${item.title} (${item.status}): ${item.output}`).join('\n')}`:summary;}catch{agent.steps=[];agent.subagents=[];}}
    catch(e:any){agent.status='failed';agent.output=e.message;}agent.finishedAt=Date.now();agent.activity=agent.status==='failed'?tr('agent.activityFailed'):tr('agent.activityReviewReady');await this.publish(agent); return agent;
  }
}

async function webviewHtml(webview:vscode.Webview,extensionUri:vscode.Uri){
  const nonce=randomBytes(18).toString('base64url'), workspace=root(), trusted=vscode.workspace.isTrusted;
  const project=workspace?path.basename(workspace):tr('chat.openProject');
  const template=await fs.readFile(vscode.Uri.joinPath(extensionUri,'media','chat.html').fsPath,'utf8');
  const logo=webview.asWebviewUri(vscode.Uri.joinPath(extensionUri,'media','cude_logo.png'));
  return fillTemplate(template,{CSP:webview.cspSource,NONCE:nonce,PROJECT:esc(project),LOGO:esc(logo.toString()),DISABLED:trusted?'':'disabled',LANG:language(),I18N:JSON.stringify(I18N).replaceAll('<','\\u003c')});
}

async function changeCudeLanguage(){
  const choice=await vscode.window.showQuickPick([
    {label:t('language.english',language()),value:'en' as const},
    {label:t('language.turkish',language()),value:'tr' as const}
  ],{title:t('language.title',language()),placeHolder:t('language.title',language())});
  if(!choice)return;
  await vscode.workspace.getConfiguration('cude-ai').update('language',choice.value,vscode.ConfigurationTarget.Global);
  const current=choice.value;
  if(current==='tr'){
    const turkishPack=vscode.extensions.all.some(extension=>extension.id.toLowerCase()==='ms-ceintl.vscode-language-pack-tr');
    if(!turkishPack){vscode.window.showInformationMessage(t('language.noPack','tr'));return;}
    const action=await vscode.window.showInformationMessage(t('language.workbenchPrompt','tr'),t('language.workbenchAction','tr'),t('language.cudeOnly','tr'));
    if(action===t('language.workbenchAction','tr'))await vscode.commands.executeCommand('workbench.action.configureLocale');
    return;
  }
  vscode.window.showInformationMessage(t('language.changed','en'));
}

function openAbout(context:vscode.ExtensionContext){
  const logo=vscode.Uri.joinPath(context.extensionUri,'media','cude_logo.png');
  const panel=vscode.window.createWebviewPanel('cudeAbout','About Cude IDE',vscode.ViewColumn.One,{enableScripts:false,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});
  const img=panel.webview.asWebviewUri(logo);
  panel.webview.html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline';"><meta name="viewport" content="width=device-width"><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background,#111211);color:var(--vscode-foreground,#e9e9e4);font:14px/1.6 Inter,"Segoe UI",system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;text-align:center}.card{max-width:560px;padding:36px 42px;border:1px solid var(--vscode-panel-border,#30312d);border-radius:6px;background:var(--vscode-editorWidget-background,#191a18)}img{width:144px;height:144px;object-fit:contain}h1{font-size:26px;letter-spacing:-.4px;font-weight:560;margin:15px 0 4px}.version{color:#d69b70;font-size:11px;letter-spacing:.4px}.muted{color:var(--vscode-descriptionForeground,#b0b0a7);line-height:1.7;margin-top:20px}.legal{color:var(--vscode-descriptionForeground,#85857d);opacity:.85;font-size:11px;margin-top:24px}body.vscode-light .version{color:#9a5a2e}</style></head><body><main class="card"><img src="${img}" alt="Cude IDE geometric logo"><h1>Cude IDE</h1><p class="version">Version 0.1.0 · Cude Studio</p><p class="muted">A development environment by Cude Studio with an integrated AI workspace.</p><p class="legal">Third-party licenses and notices are included with the application.</p></main></body></html>`;
  return panel;
}
async function cloneAndOwn(){
  const raw=await vscode.window.showInputBox({title:'Clone & make it yours',prompt:'Enter a public GitHub repository URL. Cude will clone source only; it will not install dependencies or run project scripts.',placeHolder:'https://github.com/owner/repository',ignoreFocusOut:true});
  if(!raw)return;
  let url:URL;try{url=new URL(raw.trim());}catch{throw new Error('Enter a valid GitHub HTTPS URL.');}
  if(url.protocol!=='https:'||url.hostname.toLowerCase()!=='github.com'||url.username||url.password||url.search||url.hash)throw new Error('For this guided flow, use a plain https://github.com/owner/repository URL.');
  const segments=url.pathname.split('/').filter(Boolean);if(segments.length!==2||segments.some(x=>!/^[-A-Za-z0-9_.]+$/.test(x)))throw new Error('Use a repository URL in the form github.com/owner/repository.');
  const repo=segments[1].replace(/\.git$/i,'');if(!repo)throw new Error('Repository name is missing.');
  const parent=await vscode.window.showOpenDialog({title:'Choose where to save the cloned project',canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Choose destination'});if(!parent?.[0])return;
  const destination=path.join(parent[0].fsPath,repo);
  try{await fs.access(destination);throw new Error(`The destination already exists: ${destination}`);}catch(error:any){if(error?.code!=='ENOENT')throw error;}
  const choice=await vscode.window.showWarningMessage(`Clone ${url.href} into ${destination}?\n\nCude will not run install scripts, submodules or project commands. Review the repository license and trust prompt before using its code.`,{modal:true},'Clone repository','Cancel');if(choice!=='Clone repository')return;
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Cloning ${repo}`,cancellable:false},async()=>new Promise<void>((resolve,reject)=>{
    const child=spawn('git',['-c','core.hooksPath=NUL','clone','--depth','1','--no-recurse-submodules','--',url.href,destination],{cwd:parent[0].fsPath,windowsHide:true,shell:false,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
    let stderr='';child.stderr?.on('data',(data:Buffer)=>stderr+=data.toString());child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`git clone failed (${code}). ${stderr.trim().slice(-1000)||'Check that Git is installed and the repository is public.'}`)));
  }));
  const originDir=path.join(destination,'.cude');await fs.mkdir(originDir,{recursive:true});
  const license=await fs.readdir(destination).then(names=>names.find(name=>/^licen[cs]e(?:\.|$)/i.test(name))).catch(()=>undefined);
  const attribution=`# Source repository\n\n- Original: ${url.href}\n- Cloned: ${new Date().toISOString()}\n- License file: ${license||'Not detected; check repository terms before reuse'}\n\nCude cloned this project as a starting point. Preserve upstream notices and license terms. Review the code and workspace trust prompt before running any project command. Cude does not install dependencies or execute repository scripts during cloning.\n`;
  await fs.writeFile(path.join(originDir,'origin.md'),attribution,'utf8');
  const open=await vscode.window.showInformationMessage(`Repository cloned to ${destination}. Review its license and then open it in Cude IDE.`, 'Open project','Keep here');
  if(open==='Open project')await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(destination),false);
}
// cude-core: Rust çekirdeği (bin/cude-core.exe), stdio JSON-RPC. Yoksa veya hata verirse TypeScript yoluna düşülür.
export class CudeCore{
  private proc?:import('child_process').ChildProcessWithoutNullStreams;private seq=0;private buf='';
  private wait=new Map<number,{ok:(v:any)=>void;fail:(e:Error)=>void}>();
  constructor(private exe:string){}
  private start(){
    if(this.proc&&!this.proc.killed)return true;
    try{require('fs').accessSync(this.exe);}catch{return false;}
    const p=spawn(this.exe,[],{windowsHide:true,stdio:'pipe'}) as any;this.proc=p;
    p.stdout.setEncoding('utf8');p.stdout.on('data',(d:string)=>{this.buf+=d;let i;while((i=this.buf.indexOf('\n'))>=0){const line=this.buf.slice(0,i);this.buf=this.buf.slice(i+1);try{const m=JSON.parse(line);const w=this.wait.get(m.id);if(w){this.wait.delete(m.id);m.error?w.fail(new Error(m.error)):w.ok(m.result);}}catch{}}});
    p.on('exit',()=>{this.proc=undefined;for(const w of this.wait.values())w.fail(new Error('cude-core exited'));this.wait.clear();});
    return true;
  }
  call(method:string,params:any,timeoutMs=15000):Promise<any>{
    if(!this.start())return Promise.reject(new Error('cude-core not available'));
    const id=++this.seq;
    return new Promise((ok,fail)=>{const t=setTimeout(()=>{this.wait.delete(id);fail(new Error('cude-core timeout'));},timeoutMs);
      this.wait.set(id,{ok:v=>{clearTimeout(t);ok(v);},fail:e=>{clearTimeout(t);fail(e);}});
      this.proc!.stdin.write(JSON.stringify({id,method,params})+'\n');});
  }
  dispose(){this.proc?.kill();}
}
let core:CudeCore|undefined;
async function projectOrigin(workspace:string){
  try{
    const file=path.join(workspace,'.cude','origin.md');
    await assertRealPathInside(workspace,file);
    if((await fs.stat(file)).size>32_000)return '';
    return (await fs.readFile(file,'utf8')).slice(0,3000);
  }catch{return '';}
}
async function projectContext(workspaceOverride?:string){
  const workspace=workspaceOverride||root();if(!workspace)return 'No workspace is open.';
  requireTrustedWorkspace('reading project files for AI context');
  if(core){try{
    const r=await core.call('context',{root:workspace,max_files:24,max_chars:36000});
    const origin=await projectOrigin(workspace);
    const parts:string[]=[];
    for(const item of Array.isArray(r?.files)?r.files.slice(0,24):[]){
      if(typeof item?.file!=='string'||typeof item.text!=='string')continue;
      try{
        const target=await assertRealPathInside(workspace,resolveProjectFile(workspace,item.file));
        if(!isMcpProjectFile(target))parts.push('### '+item.file+'\n'+item.text.slice(0,7000));
      }catch{}
    }
    return `Project root: ${workspace}\n${origin?`Repository origin and license notes:\n${origin.slice(0,3000)}\n`:''}\nSelected project files (bounded context; ask before assuming omitted files):\n${parts.join('\n\n')}`;
  }catch{/* TypeScript yoluna düş */}}
  const excluded='**/{node_modules,.git,dist,build,out,coverage,.next,.venv,vendor}/**,**/*.{lock,vsix,png,jpg,jpeg,gif,ico,pdf,zip,exe,dll}';
  const found=await vscode.workspace.findFiles('**/*',excluded,160);
  const files=found.map(uri=>({uri,rel:path.relative(workspace,uri.fsPath).replace(/\\/g,'/')}))
    .filter(x=>!secretPath(x.rel)&&!isMcpProjectFile(x.rel))
    .sort((a,b)=>{
      const rank=(s:string)=>/^(readme|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|\.cude\/origin\.md)/i.test(s)?0:/^(src|app|lib|packages|\.cude)\//i.test(s)?1:2;
      return rank(a.rel)-rank(b.rel)||a.rel.localeCompare(b.rel);
    });
  let total=0;const parts:string[]=[];
  for(const file of files){if(parts.length>=24||total>=36000)break;try{const target=await assertRealPathInside(workspace,file.uri.fsPath);if(isMcpProjectFile(target)||(await fs.stat(target)).size>30000)continue;const bytes=await vscode.workspace.fs.readFile(file.uri);if(bytes.length>30000)continue;const text=Buffer.from(bytes).toString('utf8');if(text.includes('\u0000'))continue;const chunk=text.slice(0,Math.min(7000,36000-total));parts.push(`### ${file.rel}\n${chunk}`);total+=chunk.length;}catch{}}
  const origin=await projectOrigin(workspace);
  return `Project root: ${workspace}\n${origin?`Repository origin and license notes:\n${origin.slice(0,3000)}\n`:''}\nSelected project files (bounded context; ask before assuming omitted files):\n${parts.join('\n\n')}`;
}
export class CudeChatView implements vscode.WebviewViewProvider {
  postTrust(trusted:boolean){this.webview?.postMessage({type:'trust',trusted});}
  refreshPermission(value:'ask'|'auto'|'plan'|'readonly'){this.webview?.postMessage({type:'permission',value});}
  private webview?:vscode.Webview;
  private panel?:vscode.WebviewPanel;
  private sidebar?:vscode.WebviewView;
  private webviewReady=false;
  private voiceTranscript?:AbortController;
  private readyWaiters:Array<()=>void>=[];
  private conversation:Array<{role:'user'|'assistant';content:string}>=[];
  private conversationId=`chat-${Date.now().toString(36)}`;
  private request?:AbortController;
  private modelSelection?: Promise<void>;
  private agentCheckpoint?: { id:string; finish:(resume:boolean)=>void };
  private latestChange?:{workspace:string;realPath:string;uri:vscode.Uri;before:string;after:string;proposal:vscode.Uri;files:Array<{path:string;added:number;removed:number}>};
  private staged=new Map<string,{id:string;path:string;workspace:string;realPath:string;uri:vscode.Uri;proposal:vscode.Uri;before:string;after:string;version:number;diskStamp:string;isNew:boolean}>();
  private pendingChanges=new Map<string,string>();
  private stagedAgentFiles=new Map<string,{agentId:string;path:string}>();
  private lastApplied:Array<{workspace:string;realPath:string;uri:vscode.Uri;path:string;before:string;after:string;proposal:vscode.Uri}>=[];
  private cuetsWait?:{taskId:string;agentId:string;paths:Set<string>;settled:Set<string>;applied:number;resolve:(value:'continue'|'stop')=>void};
  private cuetsResumeTarget?:string;
  private cuetsRunningId?:string;
  private cuetsVerifyApprovals=new Map<string,Set<string>>();
  constructor(private context:vscode.ExtensionContext,private gateway:Gateway,private agents:Agents,private statusBar:vscode.StatusBarItem) {
  this.gateway.setModelRefresh(()=>{if(this.modelSelection)return;const state=this.gateway.chatModelState(),model=state.model==='__cude_router__'?tr('router.auto'):state.model||state.providers.find(profile=>profile.id===state.active)?.models?.[0]||'';this.statusBar.text=`${tr('app.ai')} · ${model?statusModelName(model):tr('status.modelNotSelected')}`;this.statusBar.tooltip=model?t('status.activeModel',language(),{model}):tr('status.chooseModel');this.webview?.postMessage({type:'providerModels',...state});});
    const publish=()=>{const editor=vscode.window.activeTextEditor;if(!editor){this.webview?.postMessage({type:'activeContext',context:null});return;}const selection=editor.selection,label=path.basename(editor.document.fileName)+(selection.isEmpty?'':`:${selection.start.line+1}-${selection.end.line+1}`);this.webview?.postMessage({type:'activeContext',context:{label,file:editor.document.fileName,start:selection.start.line+1,end:selection.end.line+1}});};
    const listeners:vscode.Disposable[]=[];if(typeof vscode.window.onDidChangeActiveTextEditor==='function')listeners.push(vscode.window.onDidChangeActiveTextEditor(publish));if(typeof vscode.window.onDidChangeTextEditorSelection==='function')listeners.push(vscode.window.onDidChangeTextEditorSelection(publish));context.subscriptions?.push(...listeners);
  }
  resolveWebviewView(view:vscode.WebviewView){this.sidebar=view;this.webviewReady=false;void this.attach(view.webview).catch(error=>{console.error('[Cude AI] chat webview failed to initialize',error);});view.onDidDispose(()=>{if(this.sidebar===view){this.sidebar=undefined;this.detach(view.webview);}});}
  hasSidebar(){return !!this.sidebar;}
  isReady(){return !!this.sidebar&&this.webviewReady;}
  refreshLanguage(){this.webview?.postMessage({type:'language',language:language(),dictionary:I18N});this.gateway.notifyModels();}
  private async waitUntilReady(timeout=10000){if(this.webviewReady)return true;return new Promise<boolean>(resolve=>{let done=false;const finish=(ready:boolean)=>{if(done)return;done=true;clearTimeout(timer);resolve(ready);};const timer=setTimeout(()=>finish(false),timeout);this.readyWaiters.push(()=>finish(true));});}
  async focus(mode?:'chat'|'agent'|'spec'){
    try{await vscode.commands.executeCommand('cude-ai.chatView.focus');}catch{await vscode.commands.executeCommand('workbench.view.extension.cude-ai-chat');}
    if(mode&&await this.waitUntilReady())this.webview?.postMessage({type:'mode',mode});
  }
  openPanel(column:vscode.ViewColumn=vscode.ViewColumn.One){
    if(this.panel){this.panel.reveal(column);return;}
    const panel=vscode.window.createWebviewPanel('cudeAiChat','Cude AI',column,{enableScripts:true,retainContextWhenHidden:false,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]});
    this.panel=panel;void this.attach(panel.webview);panel.onDidDispose(()=>{this.panel=undefined;this.detach(panel.webview);});
  }
  private detach(webview:vscode.Webview){
    this.approvals.cancel(webview);
    if(this.webview!==webview)return;
    this.agentCheckpoint?.finish(false);
    this.webview=undefined;this.webviewReady=false;this.voiceTranscript?.abort();cancelRecording();stopSpeaking();
  }
  private async attach(webview:vscode.Webview){
    if(this.webview&&this.webview!==webview){this.approvals.cancel(this.webview);this.agentCheckpoint?.finish(false);}
    this.webview=webview;this.webviewReady=false;webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};
    webview.onDidReceiveMessage(message=>{if(this.webview===webview)void this.handle(message);});
    const html=await webviewHtml(webview,this.context.extensionUri);
    if(this.webview===webview)webview.html=html;
  }
  private reply(text:string,type='answer'){this.webview?.postMessage({type,text});}
  async imageToThree(){
    const workspace=root();
    if(!workspace)throw Error(tr('errors.openProjectFolder'));
    requireTrustedWorkspace('building a 3D model');
    if(this.request)throw Error(tr('cuets.alreadyRunning'));
    if(!this.gateway.chatModelState().model)throw Error(tr('chat.chooseModelFirst'));
    await assertActivityAllowed();
    const turkish=language()==='tr';
    const chosen=await vscode.window.showOpenDialog({canSelectMany:false,canSelectFolders:false,
      title:turkish?'3D model için görsel seç':'Choose an image for the 3D model',filters:{Images:['png','jpeg','jpg','webp']}});
    if(!chosen?.[0])return;
    const file=chosen[0].fsPath;
    const info=await fs.stat(file);
    if(!info.isFile()||info.size>3*1024*1024)throw Error(turkish?'En fazla 3 MiB büyüklüğünde bir görsel seçin.':'Choose an image up to 3 MiB.');
    const bytes=await fs.readFile(file);
    const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':
      bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpeg':
      bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':'';
    if(!mime||bytes.length>3*1024*1024)throw Error(turkish?'PNG, JPEG veya WebP seçin.':'Choose a PNG, JPEG or WebP image.');
    const allow=turkish?'Görseli kullan':'Use image';
    if(await vscode.window.showInformationMessage(turkish?'Seçilen modele bu görsel gönderilsin mi?':'Send this image to the selected model?',{modal:true,detail:path.basename(file)},allow)!==allow)return;
    if(this.request)throw Error(tr('cuets.alreadyRunning'));
    const controller=new AbortController();
    this.request=controller;
    this.webview?.postMessage({type:'imageAgentStarted'});
    try{
      const image={type:'image_url',image_url:{url:`data:image/${mime};base64,${bytes.toString('base64')}`}};
      const options:LoopOptions={
        task:'Use the attached image as the reference for a generic procedural Three.js model in three-scene/src/model.ts. Apply img2threejs_guide; assess visible parts, record assumptions about hidden sides, write the specification before geometry, build in passes and report any visual verification you could not perform. Preserve the createModel() export.',
        workspace,permission:'ask',signal:controller.signal,
        chat:(messages,signal)=>this.gateway.chat(messages.map((message,index)=>index===1?{...message,content:[{type:'text',text:message.content},image]}:message),signal),
        confirm:(message,detail,action)=>this.confirmCommand(message,detail,controller.signal,action),
        events:{activity:(label,detail)=>this.webview?.postMessage({type:'activity',label,detail}),status:text=>this.webview?.postMessage({type:'status',text})},
        continueAfter:checkpoint=>this.askAgentContinuation(checkpoint,controller.signal),
        text:(key,values)=>tr(key as MessageKey,values),
      };
      const scaffold=await runTool(options,{tool:'scaffold_threejs',args:{folder:'three-scene',title:'Three.js'}});
      if(!scaffold.startsWith('Created three-scene/')){this.reply(scaffold);return;}
      this.reply((await runAgentLoop(options)).final);
    }catch(error){
      this.reply(error instanceof Error?error.message:String(error),'error');
    }finally{if(this.request===controller)this.request=undefined;}
  }
  private async askAgentContinuation(checkpoint:LoopCheckpoint, signal:AbortSignal) {
    const view=this.webview;
    if(!view || signal.aborted)return false;
    const id=randomBytes(16).toString('hex');
    return new Promise<boolean>(resolve=>{
      const stop=()=>finish(false);
      const finish=(resume:boolean)=>{
        if(this.agentCheckpoint?.id!==id)return;
        this.agentCheckpoint=undefined;
        signal.removeEventListener('abort',stop);
        void view.postMessage({type:'agentCheckpointClosed',id}).then(undefined,()=>{});
        resolve(resume);
      };
      this.agentCheckpoint={id,finish};
      signal.addEventListener('abort',stop,{once:true});
      void view.postMessage({type:'agentCheckpoint',id,...checkpoint}).then(sent=>{if(!sent)stop();},stop);
    });
  }
  /** Cuets entry: long-running loop with a saved checklist in a trusted project; single pass otherwise. "continue" resumes the latest unfinished task. */
  private async runCuetsTask(text:string){
    const task=text.trim();if(!task)throw new Error(tr('agent.describeTask'));
    if(this.request)throw new Error(tr('cuets.alreadyRunning'));
    const controller=new AbortController();
    this.request=controller;
    try{
      const workspace=root();
      if(!workspace||!vscode.workspace.isTrusted){if(isContinueCommand(task)){this.reply(tr('cuets.noTaskToContinue'));return;}await this.runCuetsSinglePass(task);return;}
      if(isContinueCommand(task)){
        const target=this.cuetsResumeTarget;this.cuetsResumeTarget=undefined;
        const saved=target?await readCuetsTask(workspace,target):(await listCuetsTasks(workspace)).find(isResumable);
        if(!isResumable(saved)){this.reply(tr('cuets.noTaskToContinue'));return;}
        await this.runCuetsLoopTask(workspace,saved.goal,saved);return;
      }
      await this.runCuetsLoopTask(workspace,task);
    }finally{if(this.request===controller)this.request=undefined;}

  }
  private currentPermission(){return this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');}
  private postCuetsProgress(state:CuetsTaskState,waiting=false){
    const {done,total}=taskProgress(state),verification=state.lastVerification;
    this.webview?.postMessage({type:'cuetsProgress',taskId:state.id,title:state.title,round:state.round,maxRounds:state.maxRounds,status:state.status,stopReason:state.stopReason||'',waiting,done,total,
      items:state.checklist.map(item=>({id:item.id,title:item.title,status:item.status,note:item.note||''})),
      verification:verification?{command:verification.command,ok:verification.ok,skipped:!!verification.skipped}:null});
  }
  private async postCuetsResumable(){
    const workspace=root();if(!workspace||!vscode.workspace.isTrusted||this.cuetsRunningId){this.webview?.postMessage({type:'cuetsResumable',task:null});return;}
    const tasks=(await listCuetsTasks(workspace)).filter(isResumable),task=tasks[0];
    if(!task){this.webview?.postMessage({type:'cuetsResumable',task:null});return;}
    const {done,total}=taskProgress(task);
    this.webview?.postMessage({type:'cuetsResumable',more:tasks.length-1,task:{id:task.id,title:task.title,done,total,round:task.round,updatedAt:task.updatedAt,progress:tr('cuets.progress',{done,total})}});
  }
  /** Called by applyStaged / reject paths so a Cuets round waiting in Ask mode can continue on its own once every file is decided. */
  private noteCuetsDecision(paths:string[],applied:boolean){
    const wait=this.cuetsWait;if(!wait)return;
    for(const raw of paths){const file=raw.replace(/\\/g,'/').replace(/^\.\//,'');if(!wait.paths.has(file)||wait.settled.has(file))continue;wait.settled.add(file);if(applied)wait.applied++;}
    if(wait.paths.size&&[...wait.paths].every(file=>wait.settled.has(file)))wait.resolve('continue');
  }
  /** One round's apply phase: auto/full apply through stageFile/applyStaged; ask posts the normal proposal card and waits for the user's decisions. */
  private async applyCuetsRound(agent:Agent,taskId:string,workspace:string,steps:CuetsStep[],round:CuetsRoundInfo,signal:AbortSignal,latest:()=>CuetsTaskState|undefined):Promise<CuetsApplyResult>{
    agent.steps=steps.map((step,index)=>({id:`${agent.id}-r${round.round}-${index}`,...step}));agent.activity=tr('cuets.roundStart',{round:round.round,max:latest()?.maxRounds||round.round});await this.agents.update(agent).catch(()=>undefined);
    const fileSteps=agent.steps.filter(step=>step.kind==='file'&&step.path&&typeof step.content==='string'),commandSteps=agent.steps.filter(step=>step.kind==='command');
    if(!fileSteps.length&&!commandSteps.length)return{applied:0,failed:[]};
    const permission=this.currentPermission();
    if(permission==='plan'||permission==='readonly'){this.webview?.postMessage({type:'plan',agentId:agent.id,title:tr('cuets.roundProposals',{round:round.round}),summary:'',steps:agent.steps,artifacts:[]});return{applied:0,failed:[],pending:fileSteps.length};}
    if(permission==='auto'||permission==='full'){
      requireTrustedWorkspace('applying Cuets changes');
      const staged:Array<Awaited<ReturnType<CudeChatView['stageFile']>>>=[],failed:string[]=[];
      for(const step of fileSteps){try{staged.push(await this.stageFile(step.path!,step.content!,workspace));}catch(error:any){failed.push(`${step.path}: ${error?.message||error}`);}}
      let applied=0;
      if(staged.length){try{await this.applyStaged(staged.map(item=>item.id),true);applied=staged.length;agent.artifacts=[...new Set([...(agent.artifacts||[]),...staged.map(item=>item.path)])];await this.agents.update(agent).catch(()=>undefined);this.webview?.postMessage({type:'activity',label:tr('cuets.appliedRound',{count:applied}),detail:staged.map(item=>item.path).join('\n')});}
        catch(error:any){failed.push(error?.message||String(error));for(const item of staged){this.staged.delete(item.id);proposalTexts.delete(item.id);}}}
      // Model-proposed commands are never auto-run; they stay on a card for the user (the detected project checks run separately).
      if(commandSteps.length)this.webview?.postMessage({type:'plan',agentId:agent.id,title:tr('cuets.roundCommands'),summary:'',steps:commandSteps,artifacts:[]});
      return{applied,failed};
    }
    // Ask: reuse the normal proposal card (approveStep / approveAll / pending accept-reject) and wait for the decisions.
    this.webview?.postMessage({type:'plan',agentId:agent.id,title:tr('cuets.roundProposals',{round:round.round}),summary:'',steps:agent.steps,artifacts:[]});
    const state=latest();if(state){state.status='waiting';this.postCuetsProgress(state,true);}
    const decision=await new Promise<'continue'|'stop'>(resolve=>{
      const onAbort=()=>done('stop');
      const done=(value:'continue'|'stop')=>{signal.removeEventListener('abort',onAbort);resolve(value);};
      this.cuetsWait={taskId,agentId:agent.id,paths:new Set(fileSteps.map(step=>step.path!.replace(/\\/g,'/').replace(/^\.\//,''))),settled:new Set(),applied:0,resolve:done};
      signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
    });
    const wait=this.cuetsWait;this.cuetsWait=undefined;
    if(state){state.status='running';this.postCuetsProgress(state,false);}
    const applied=wait?.applied||0;
    return{applied,failed:[],pending:Math.max(0,fileSteps.length-applied),stop:decision==='stop'};
  }
  /** Runs the detected project checks through the approval rules: never silently in Ask (modal every time), once per task+command in Auto, directly in Full. */
  private async runCuetsVerification(workspace:string,taskId:string,commands:CuetsVerifyCommand[],signal:AbortSignal):Promise<CuetsVerification|undefined>{
    if(!commands.length)return undefined;
    for(const doc of vscode.workspace.textDocuments){if(!doc.isDirty||doc.uri.scheme!=='file')continue;const rel=path.relative(workspace,doc.uri.fsPath);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))await doc.save();}
    const joined=commands.map(item=>item.command).join(' && '),skipped=():CuetsVerification=>({command:joined,ok:false,exitCode:null,output:'',durationMs:0,at:Date.now(),skipped:true});
    const permission=this.currentPermission();if(permission==='plan'||permission==='readonly')return skipped();
    requireTrustedWorkspace('running Cuets verification commands');
    const started=Date.now();let output='';
    for(const item of commands){
      if(hasHiddenCommandCharacters(item.command)||item.command.length>4000)return skipped();
      if(permission!=='full'){
        const key=`${item.command}\n${item.fingerprint}`,approved=this.cuetsVerifyApprovals.get(taskId)||new Set<string>();
        if(permission==='ask'||!approved.has(key)){
          const choice=await vscode.window.showWarningMessage(tr('cuets.verifyConfirm',{command:item.command}),{modal:true},tr('agent.runCommand'),tr('cuets.verifySkip'));
          if(choice!==tr('agent.runCommand'))return skipped();
          if(permission==='auto'){approved.add(key);this.cuetsVerifyApprovals.set(taskId,approved);}
        }
      }
      if(signal.aborted)return skipped();
      this.webview?.postMessage({type:'activity',label:tr('cuets.verifying'),detail:item.command});
      const result=await runBoundedCommand(item.command,workspace,signal);
      output+=`$ ${item.command}\n${result.output}\n`;
      if(result.exitCode!==0)return{command:item.command,ok:false,exitCode:result.exitCode,output:boundOutput(redactLikelySecrets(output)),durationMs:Date.now()-started,at:Date.now()};
    }
    return{command:joined,ok:true,exitCode:0,output:boundOutput(redactLikelySecrets(output)),durationMs:Date.now()-started,at:Date.now()};
  }
  /** Long-running Cuets: saved checklist, round loop (work -> apply per permission -> verify -> review), resumable from .cude/tasks. */
  private async runCuetsLoopTask(workspace:string,goal:string,saved?:CuetsTaskState){
    requireTrustedWorkspace('running a long Cuets task');
    const cfg=vscode.workspace.getConfiguration('cude-ai'),maxRounds=Math.min(50,Math.max(1,Math.floor(Number(cfg.get<number>('cuets.maxRounds',8))||8))),budgetMs=Math.min(480,Math.max(1,Number(cfg.get<number>('cuets.budgetMinutes',30))||30))*60_000;
    const permission=this.currentPermission(),controller=this.request!;
    const resumed=saved?resumeTaskState(saved,{maxRounds,budgetMs,now:Date.now()}):undefined,id=resumed?.id||newTaskId(Date.now(),randomBytes(4).toString('hex'));
    if(this.cuetsRunningId)throw new Error(tr('cuets.alreadyRunning'));
    this.cuetsRunningId=id;
    const agent=await this.agents.begin(resumed?.title||goal,permission);
    const activity=(label:string,detail:string)=>{agent.activity=label;this.webview?.postMessage({type:'activity',label,detail});};
    this.conversation.push({role:'user',content:resumed?tr('cuets.continueUser',{title:resumed.title}):goal});await this.saveConversation();
    let latest:CuetsTaskState|undefined=resumed,baseRound=-1,base='';
    const shared=async()=>{const round=latest?.round??0;if(round!==baseRound){baseRound=round;base=`Project memory:\n${(await memoryText(workspace)).slice(0,5000)}\n\nRepository context:\n${(await projectContext(workspace)).slice(0,18000)}`;}return base;};
    const commands=permission==='plan'||permission==='readonly'?[]:await detectWorkspaceVerification(workspace);
    let result:Awaited<ReturnType<typeof runCuetsLoop>>;
    try{
      result=await runCuetsLoop({goal,state:resumed,id,maxRounds,budgetMs,mode:permission==='plan'||permission==='readonly'?'plan':'execute',signal:controller.signal,label:tr,onActivity:activity,
        chat:(messages,signal,onDelta)=>this.gateway.chat(messages,signal,onDelta),
        context:async item=>{const common=await shared();if(!item)return common;const search=await gatherSearchContext(`${item.title} ${item.instruction}`,workspace,this.gateway,controller.signal);return `${common}\n\nProject search tools (find_files + grep) for this item:\n${search||'no matches'}`;},
        save:state=>{latest=state;return saveCuetsTask(workspace,state);},
        onProgress:state=>{latest=state;this.postCuetsProgress(state,false);},
        verificationAvailable:commands.length>0,
        verify:commands.length?()=>this.runCuetsVerification(workspace,id,commands,controller.signal):undefined,
        applySteps:(steps,round)=>this.applyCuetsRound(agent,id,workspace,steps,round,controller.signal,()=>latest)});
      agent.status=result.stopReason==='failed'?'failed':'done';agent.output=result.summary;
      if(result.stopReason==='planOnly'&&result.lastSteps.length){agent.steps=result.lastSteps.map((step,index)=>({id:`${agent.id}-p${index}`,...step}));}
    }catch(error:any){agent.status='failed';agent.output=error?.name==='AbortError'?tr('chat.stopped'):error?.message||String(error);throw error;}
    finally{this.cuetsRunningId=undefined;this.cuetsWait=undefined;this.cuetsVerifyApprovals.delete(id);agent.finishedAt=Date.now();agent.activity=agent.status==='done'?tr('status.done'):tr('status.failed');await this.agents.update(agent).catch(()=>undefined);}
    this.conversation.push({role:'assistant',content:result.summary});if(this.conversation.length>24)this.conversation.splice(0,this.conversation.length-24);await this.saveConversation();
    this.reply(result.summary);
    if(result.stopReason==='planOnly'&&agent.steps?.length)this.webview?.postMessage({type:'plan',agentId:agent.id,title:tr('cuets.proposals'),summary:'',steps:agent.steps,artifacts:[]});
  }
  /** Single-pass Cuets (no trusted project folder): planner -> workers (max 2 in parallel) -> reviewer; edits stay proposals. */
  private async runCuetsSinglePass(task:string){
    const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');
    const controller=this.request!;
    const agent=await this.agents.begin(task,permission),workspace=agent.workspacePath;
    const activity=(label:string,detail:string)=>{agent.activity=label;this.webview?.postMessage({type:'activity',label,detail});};
    this.conversation.push({role:'user',content:task});await this.saveConversation();
    let base:string|undefined;const shared=async()=>base??=workspace&&vscode.workspace.isTrusted?`Project memory:\n${(await memoryText(workspace)).slice(0,5000)}\n\nRepository context:\n${(await projectContext(workspace)).slice(0,18000)}`:'Repository context: no trusted project folder is open.';
    let result:Awaited<ReturnType<typeof runCuets>>;
    try{
      result=await runCuets({task,signal:controller.signal,label:tr,onActivity:activity,onDelta:delta=>this.webview?.postMessage({type:'delta',text:delta}),
        chat:(messages,signal,onDelta)=>this.gateway.chat(messages,signal,onDelta),
        context:async(subtask?:CuetsSubtask)=>{const common=await shared();if(!subtask)return common;const search=await gatherSearchContext(`${subtask.title} ${subtask.instruction}`,workspace,this.gateway,controller.signal);return `${common}\n\nProject search tools (find_files + grep) for this subtask:\n${search||'no matches'}`;}});
      agent.status='done';agent.output=result.answer;agent.steps=result.steps.map((step,index)=>({id:`${agent.id}-${index}`,...step}));
      agent.subagents=result.workers.map(worker=>({id:`${agent.id}-w${worker.index}`,title:worker.title,task:worker.instruction,status:worker.status,output:(worker.summary||worker.output).slice(0,4000)}));
    }catch(error:any){agent.status='failed';agent.output=error?.name==='AbortError'?tr('chat.stopped'):error?.message||String(error);throw error;}
    finally{agent.finishedAt=Date.now();agent.activity=agent.status==='done'?tr('status.done'):tr('status.failed');await this.agents.update(agent).catch(()=>undefined);}
    this.conversation.push({role:'assistant',content:result.answer});await this.saveConversation();
    if(this.conversation.length>24)this.conversation.splice(0,this.conversation.length-24);
    this.reply(result.answer);
    if(agent.steps?.length)this.webview?.postMessage({type:'plan',agentId:agent.id,title:tr('cuets.proposals'),summary:'',steps:agent.steps,artifacts:[]});
  }
  private async saveConversation(){await persistChatSession(this.context.globalState,this.conversationId,root()?path.basename(root()!):tr('agent.noProject'),this.conversation);}
  private async stageFile(relative:string,content:string,workspaceOverride?:string){
    const workspace=workspaceOverride||root();if(!workspace)throw new Error(tr('review.openProjectToAccept'));requireTrustedWorkspace('staging an AI file proposal');
    const normalized=relative.replace(/\\/g,'/').replace(/^\.\//,'');if(!normalized||normalized.includes('\0')||secretPath(normalized))throw new Error(tr('review.unsafePath'));
    const absolute=resolveProjectFile(workspace,normalized),realPath=await assertRealPathInside(workspace,absolute);if(isMcpProjectFile(realPath))throw new Error(tr('review.unsafePath'));if(content.length>1_000_000)throw new Error(tr('review.proposalTooLarge'));
    const uri=vscode.Uri.file(absolute);let doc:vscode.TextDocument|undefined,isNew=false,diskStamp='missing';
    try{const stat=await fs.stat(absolute);if(stat.size>1_000_000)throw new Error(tr('review.fileTooLarge'));diskStamp=createHash('sha256').update(await fs.readFile(absolute)).digest('hex');doc=await vscode.workspace.openTextDocument(uri);}catch(error:any){if(error?.code==='ENOENT'){isNew=true;}else throw error;}
    const before=doc?.getText()||'',after=content.includes('<<<<<<< SEARCH')?applySearchReplaceBlocks(before,content):content;if(content.includes('<<<<<<< SEARCH')&&isNew)throw new Error(tr('review.searchReplaceNewFile'));const id=randomBytes(10).toString('hex'),proposal=proposalUri(id);proposalTexts.set(id,after);
    this.staged.set(id,{id,path:normalized,workspace,realPath,uri,proposal,before,after,version:doc?.version||0,diskStamp,isNew});
    return this.staged.get(id)!;
  }
  private async assertProposalTarget(item:{workspace:string;uri:vscode.Uri;realPath:string;path?:string}){
    const resolved=await assertRealPathInside(item.workspace,item.uri.fsPath);
    if(resolved!==item.realPath||isMcpProjectFile(resolved))throw new Error(tr('review.diskChanged',{path:item.path||item.uri.fsPath}));
  }
  private async applyStaged(ids:string[],persistCuets=false){
    await assertActivityAllowed();
    if(!ids.length)throw new Error(tr('review.nothingToApply'));const items=ids.map(id=>this.staged.get(id)).filter((item):item is NonNullable<typeof item>=>!!item);if(items.length!==ids.length)throw new Error(tr('review.proposalExpired'));
    for(const item of items){await this.assertProposalTarget(item);const doc=item.isNew?undefined:await vscode.workspace.openTextDocument(item.uri);if(doc&&doc.version!==item.version)throw new Error(tr('review.editorChanged',{path:item.path}));let current='missing';try{current=createHash('sha256').update(await fs.readFile(item.uri.fsPath)).digest('hex');}catch(error:any){if(error?.code!=='ENOENT')throw error;}if(current!==item.diskStamp)throw new Error(tr('review.diskChanged',{path:item.path}));}
    const edit=new vscode.WorkspaceEdit();
    for(const item of items){if(item.isNew){edit.createFile(item.uri,{overwrite:false,ignoreIfExists:false});edit.insert(item.uri,new vscode.Position(0,0),item.after);}else{const doc=await vscode.workspace.openTextDocument(item.uri),replacement=item.after.replace(/\r\n/g,'\n').replace(/\n/g,doc.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');edit.replace(item.uri,new vscode.Range(new vscode.Position(0,0),doc.positionAt(doc.getText().length)),replacement);}}
    for(const item of items)await this.assertProposalTarget(item);
    const applied=await vscode.workspace.applyEdit(edit);if(!applied)throw new Error(tr('review.applyFailed'));
    const first=items[0],count=items.reduce((n,item)=>n+lineCounts(item.before,item.after).added,0),removed=items.reduce((n,item)=>n+lineCounts(item.before,item.after).removed,0);
    this.lastApplied=items.map(item=>({workspace:item.workspace,realPath:item.realPath,uri:item.uri,path:item.path,before:item.before,after:item.after,proposal:item.proposal}));
    if(items.length===1)this.latestChange={workspace:first.workspace,realPath:first.realPath,uri:first.uri,before:first.before,after:first.after,proposal:first.proposal,files:[{path:first.path,...lineCounts(first.before,first.after)}]};else this.latestChange=undefined;
    // Cuets must persist its own accepted proposals even in projects without a test command.
    // Ordinary chat proposals retain their existing editor-buffer behavior.
    if(persistCuets||items.some(item=>this.cuetsWait?.paths.has(item.path))){
      for(const item of items){await this.assertProposalTarget(item);const doc=await vscode.workspace.openTextDocument(item.uri);if(!await doc.save())throw new Error(tr('cuets.saveFailed',{path:item.path}));}
    }
    for(const item of items){this.staged.delete(item.id);proposalTexts.delete(item.id);}this.noteCuetsDecision(items.map(item=>item.path),true);this.webview?.postMessage({type:'changes',files:items.map(item=>({path:item.path,...lineCounts(item.before,item.after)})),added:count,removed});const doc=await vscode.workspace.openTextDocument(first.uri);await vscode.window.showTextDocument(doc,{preview:false,preserveFocus:false});
  }
  private publishPending(items:Array<{id:string;path:string;before:string;after:string}>){
    for(const item of items)this.pendingChanges.set(item.path,item.id);
    const files=[...this.pendingChanges.entries()].map(([file,id])=>{const item=this.staged.get(id);return item?{path:file,...lineCounts(item.before,item.after)}:undefined;}).filter((file):file is {path:string;added:number;removed:number}=>!!file);
    this.webview?.postMessage({type:'pendingChange',files});
  }
  private async acceptPending(pathValue?:string){
    const requested=String(pathValue||'').trim().replace(/\\/g,'/'),entries=requested?[[requested,this.pendingChanges.get(requested)] as const]:[...this.pendingChanges.entries()];
    if(!entries.length||entries.some(([,id])=>!id))throw new Error(requested?tr('review.noPendingForFile'):tr('review.noPending'));
    const ids=entries.map(([,id])=>id as string),metadata=ids.map(id=>this.stagedAgentFiles.get(id)).filter((item):item is {agentId:string;path:string}=>!!item);
    const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');if(permission==='readonly'||permission==='plan')throw new Error(tr('review.permissionDenied'));
    requireTrustedWorkspace('accepting staged AI changes');await this.applyStaged(ids);
    for(const [file] of entries)this.pendingChanges.delete(file);
    if(metadata.length){const agents=this.context.workspaceState.get<Agent[]>('agents',[]);for(const agentId of new Set(metadata.map(item=>item.agentId))){const agent=agents.find(item=>item.id===agentId);if(agent)agent.artifacts=[...new Set([...(agent.artifacts||[]),...metadata.filter(item=>item.agentId===agentId).map(item=>item.path)])];}await this.context.workspaceState.update('agents',agents);}
    for(const id of ids)this.stagedAgentFiles.delete(id);
    this.publishPending([]);
  }
  private rejectPending(pathValue?:string){
    const requested=String(pathValue||'').trim().replace(/\\/g,'/'),entries=requested?[[requested,this.pendingChanges.get(requested)] as const]:[...this.pendingChanges.entries()];
    if(!entries.length||entries.some(([,id])=>!id))throw new Error(requested?tr('review.noPendingForFile'):tr('review.noPending'));
    for(const [file,id] of entries){this.pendingChanges.delete(file);if(id){this.staged.delete(id);proposalTexts.delete(id);this.stagedAgentFiles.delete(id);}}this.noteCuetsDecision(entries.map(([file])=>file),false);
    this.webview?.postMessage({type:'status',text:entries.length===1?tr('review.rejectedOne'):tr('review.rejectedMany',{count:entries.length})});this.publishPending([]);
  }
  async previewAgentFile(agentId:string,relative:string){requireTrustedWorkspace('previewing an agent change');const agent=this.agents.list().find(item=>item.id===agentId),step=agent?.steps?.find(item=>item.kind==='file'&&item.path===relative&&typeof item.content==='string');if(!agent||!step)throw new Error(tr('agent.fileProposalNotFound'));const item=await this.stageFile(step.path!,step.content!,agent.workspacePath);const original=item.isNew?await vscode.workspace.openTextDocument({language:path.extname(item.path).slice(1),content:''}).then(doc=>doc.uri):item.uri;await vscode.commands.executeCommand('vscode.diff',original,item.proposal,`Cude · ${item.path}`);}
  async reviewAgent(agentId:string,pathValue:string|undefined,accept:boolean){requireTrustedWorkspace('reviewing agent changes');const agent=this.agents.list().find(item=>item.id===agentId);if(!agent)throw new Error(tr('agent.sessionNotFound'));const files=(agent.steps||[]).filter(step=>step.kind==='file'&&step.path&&typeof step.content==='string'&&(!pathValue||step.path===pathValue));if(!files.length)throw new Error(tr('agent.noFileToReview'));if(accept){if(agent.permission==='readonly'||agent.permission==='plan')throw new Error(tr('agent.permissionNoAccept'));const pending=files.filter(step=>!(agent.acceptedFiles||[]).includes(step.path!));if(!pending.length)throw new Error(tr('agent.alreadyAccepted'));const staged=[];for(const step of pending)staged.push(await this.stageFile(step.path!,step.content!,agent.workspacePath));await this.applyStaged(staged.map(item=>item.id));agent.acceptedFiles=[...new Set([...(agent.acceptedFiles||[]),...pending.map(step=>step.path!)])];agent.rejectedFiles=(agent.rejectedFiles||[]).filter(file=>!pending.some(step=>step.path===file));}else{agent.rejectedFiles=[...new Set([...(agent.rejectedFiles||[]),...files.map(step=>step.path!)])];agent.acceptedFiles=(agent.acceptedFiles||[]).filter(file=>!files.some(step=>step.path===file));}await this.agents.update(agent);}
  openAgentSession(agent:Agent){this.conversationId=`agent-${agent.id}`;this.conversation=[{role:'user',content:agent.title},{role:'assistant',content:agent.output||tr('agent.noOutput')}];void this.focus('agent');setTimeout(()=>{this.webview?.postMessage({type:'session',title:agent.title,messages:this.conversation});this.webview?.postMessage({type:'plan',agentId:agent.id,title:agent.title,summary:agent.output,steps:agent.steps||[],artifacts:agent.artifacts||[]});},250);}
  async chooseSkill(){requireTrustedWorkspace('reading project skills');const workspace=root();if(!workspace)throw new Error(tr('errors.openProjectFolder'));const folder=path.join(workspace,'.cude','skills');await assertRealPathInside(workspace,folder);await fs.mkdir(folder,{recursive:true});const names=(await fs.readdir(folder)).filter(name=>/\.md$/i.test(name));if(!names.length){const choice=await vscode.window.showInformationMessage(tr('skills.none'),tr('skills.openFolder'));if(choice)await vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(folder));return;}const selected=await vscode.window.showQuickPick(names,{placeHolder:tr('skills.choose')});if(!selected)return;const file=path.join(folder,selected);await assertRealPathInside(workspace,file);if((await fs.stat(file)).size>250000)throw new Error('Project skill is too large.');const content=await fs.readFile(file,'utf8');this.conversation.push({role:'user',content:`Project skill (${selected}):\n${content.slice(0,12000)}`});this.webview?.postMessage({type:'activity',label:tr('skills.added'),detail:selected});this.webview?.postMessage({type:'context',name:tr('skills.context',{name:selected})});await this.saveConversation();await this.focus('chat');}
  private approvals=new CommandApprovals();
  private async confirmCommand(text:string,detail:string,signal?:AbortSignal,action?:string){
    const view=this.webview;if(!view)return false;
    return this.approvals.request(view,id=>{void view.postMessage({type:'commandApproval',id,text,command:detail,action});},300000,signal);
  }
  private async handle(message:any) {
    let ownedRequest:AbortController|undefined;
    try {
      // Webview input is untrusted: enforce shape and size before any handler runs.
      if(!message||typeof message!=='object'||typeof message.type!=='string'||message.type.length>40)return;
      for(const [field,max] of [['text',400_000],['content',1_000_000],['path',4096],['query',4096],['agentId',200],['stepId',200]] as const){const value=message[field];if(value!==undefined&&value!==null&&(typeof value!=='string'||value.length>max))throw new Error(`Webview message rejected: invalid ${field}.`);}
      if(message.attachments!==undefined&&(!Array.isArray(message.attachments)||message.attachments.length>50))throw new Error('Webview message rejected: invalid attachments.');
      if(message.type==='trustFolder'){await vscode.commands.executeCommand('workbench.trust.manage');return;}if(message.type==='webviewError'){const line=`[${new Date().toISOString()}] chat webview: ${String(message.message||'').slice(0,500)} @${Number(message.line)||0}:${Number(message.column)||0}\n${String(message.stack||'').slice(0,1500)}\n`;console.error('[Cude AI]',line);try{await fs.appendFile(path.join(this.context.globalStorageUri.fsPath,'webview-errors.log'),line);}catch{try{await fs.mkdir(this.context.globalStorageUri.fsPath,{recursive:true});await fs.appendFile(path.join(this.context.globalStorageUri.fsPath,'webview-errors.log'),line);}catch{}}return;}if(message.type==='ready'){startupMark(this.context,'chat webview ready');const firstReady=!this.webviewReady;this.webviewReady=true;for(const ready of this.readyWaiters.splice(0))ready();if(firstReady)setImmediate(()=>void this.gateway.prepareStartupModels());const workspace=root(),editor=vscode.window.activeTextEditor;this.webview?.postMessage({type:'language',language:language(),dictionary:I18N});this.webview?.postMessage({type:'context',project:true,open:!!workspace,name:workspace?path.basename(workspace):tr('chat.openProject')});this.webview?.postMessage({type:'permission',value:this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto')});this.webview?.postMessage({type:'providerModels',...this.gateway.chatModelState()});if(editor){const s=editor.selection;this.webview?.postMessage({type:'activeContext',context:{label:path.basename(editor.document.fileName)+(s.isEmpty?'':`:${s.start.line+1}-${s.end.line+1}`),file:editor.document.fileName,start:s.start.line+1,end:s.end.line+1}});}return;}
      if(message.type==='settingsMenu'){assertCommandAllowed();await vscode.commands.executeCommand('cude-ai.settings');return;}
      if(['provider','openSetup'].includes(message.type)){
        assertCommandAllowed();
        const focus=message.type==='openSetup'?String(message.focus||''):'';
        await this.gateway.configure(/^tab:(providers|local|free)$/.test(focus)?focus:'');
        return;
      }
      await assertActivityAllowed();
      if(message.type==='commandApproval'){if(this.webview)this.approvals.answer(this.webview,message.id,message.allowed);return;}
      if(message.type==='compact'){if(this.conversation.length<2){this.webview?.postMessage({type:'status',text:tr('chat.compactEmpty')});return;}this.webview?.postMessage({type:'status',text:tr('chat.compacting')});const summary=await this.gateway.chat([{role:'system',content:'Summarize this coding conversation for continuation. Preserve decisions, constraints, active task, file paths, and unresolved questions. Be concise.'},...this.conversation]);this.conversation=[{role:'user',content:tr('chat.compactSummaryOf')},{role:'assistant',content:summary}];await this.saveConversation();this.webview?.postMessage({type:'clear'});this.webview?.postMessage({type:'session',title:tr('chat.compactTitle'),messages:this.conversation});return;}
      if(message.type==='previewBlock'||message.type==='applyBlock'||message.type==='newFile'){const relative=String(message.path||'').trim();if(!relative)throw new Error(tr('review.noPathInBlock'));const item=await this.stageFile(relative,String(message.content||''));if(message.type==='newFile'&&!item.isNew){this.staged.delete(item.id);proposalTexts.delete(item.id);throw new Error(tr('review.fileExists',{path:relative}));}const original=item.isNew?await vscode.workspace.openTextDocument({language:path.extname(item.path).slice(1),content:''}).then(doc=>doc.uri):item.uri;await vscode.commands.executeCommand('vscode.diff',original,item.proposal,`Cude · ${item.path}`);if(message.type==='previewBlock'){this.publishPending([item]);return;}const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');if(permission==='readonly'||permission==='plan'){this.staged.delete(item.id);proposalTexts.delete(item.id);throw new Error(tr('review.permissionDenied'));}if((permission==='auto'||permission==='full')){await this.applyStaged([item.id]);return;}this.publishPending([item]);return;}
      if(message.type==='acceptChange'){await this.acceptPending(message.path);return;}
      if(message.type==='rejectChange'){this.rejectPending(message.path);return;}
      if(message.type==='rejectStep'){this.webview?.postMessage({type:'status',text:tr('review.stepRejected',{step:String(message.stepId||'')})});const wait=this.cuetsWait,stepId=String(message.stepId||'');if(wait&&stepId.startsWith(`${wait.agentId}-`)){const step=this.agents.list().find(item=>item.id===wait.agentId)?.steps?.find(item=>item.id===stepId);if(step?.kind==='file'&&step.path)this.noteCuetsDecision([step.path],false);}return;}
      if(message.type==='cuetsRoundContinue'){this.cuetsWait?.resolve('continue');return;}
      if(message.type==='agentCheckpointDecision'){
        const checkpoint=this.agentCheckpoint;
        if(checkpoint && message.id===checkpoint.id && typeof message.resume==='boolean'){
          if(!message.resume)this.request?.abort();
          checkpoint.finish(message.resume);
        }
        return;
      }
      if(message.type==='cuetsOpened'){await this.postCuetsResumable();return;}
      if(message.type==='cuetsSelectTask'){const id=String(message.taskId||'');this.cuetsResumeTarget=isValidTaskId(id)?id:undefined;return;}
      if(message.type==='cuetsDiscard'){const id=String(message.taskId||''),workspace=root();if(!workspace||!isValidTaskId(id))return;const state=await readCuetsTask(workspace,id);if(state&&this.cuetsRunningId!==id){state.status='discarded';state.updatedAt=Date.now();await saveCuetsTask(workspace,state);this.webview?.postMessage({type:'status',text:tr('cuets.discarded')});}await this.postCuetsResumable();return;}
      if(message.type==='approveAll'){
        requireTrustedWorkspace('applying an agent file batch');const agent=this.context.workspaceState.get<Agent[]>('agents',[]).find(item=>item.id===message.agentId);if(!agent)throw new Error(tr('agent.sessionNotFound'));const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');if(permission==='readonly'||permission==='plan')throw new Error(tr('review.permissionNoFileChange'));const fileSteps=(agent.steps||[]).filter(step=>step.kind==='file'&&step.path&&typeof step.content==='string');if(!fileSteps.length)throw new Error(tr('review.noApplicable'));const items=[];for(const step of fileSteps)items.push(await this.stageFile(step.path!,step.content!));for(const item of items){const original=item.isNew?await vscode.workspace.openTextDocument({language:path.extname(item.path).slice(1),content:''}).then(doc=>doc.uri):item.uri;await vscode.commands.executeCommand('vscode.diff',original,item.proposal,`Cude · ${item.path}`);}if(permission==='ask'){for(const item of items)this.stagedAgentFiles.set(item.id,{agentId:agent.id,path:item.path});this.publishPending(items);return;}await this.applyStaged(items.map(item=>item.id));agent.artifacts=[...new Set([...(agent.artifacts||[]),...items.map(item=>item.path)])];await this.context.workspaceState.update('agents',this.context.workspaceState.get('agents',[]));return;
      }
      if(message.type==='approveStep'){
        requireTrustedWorkspace('approving an agent plan step');const workspace=root();if(!workspace)throw new Error(tr('errors.openProjectFolder'));
        const agents=this.context.workspaceState.get<Agent[]>('agents',[]),agent=agents.find(a=>a.id===message.agentId),step=agent?.steps?.find(s=>s.id===message.stepId);if(!agent||!step)throw new Error(tr('agent.stepMissing'));
        if(step.kind==='analysis'){this.webview?.postMessage({type:'activity',label:tr('agent.planStepApproved'),detail:step.title});return;}
        const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');if(permission==='readonly')throw new Error(tr('errors.readonlyNoChange'));if(permission==='plan')throw new Error(tr('errors.planNoChange'));
        if(step.kind==='mcp'){requireTrustedWorkspace('calling an MCP tool');if(agent.permission==='readonly'||agent.permission==='plan')throw new Error(tr('agent.permissionNoAccept'));const serverName=String(step.server||''),toolName=String(step.tool||''),args=step.arguments||{};const cfg=await readMcpConfig();const server=Object.hasOwn(cfg?.mcpServers??{},serverName)?cfg!.mcpServers[serverName]:undefined;if(!server)throw new Error(tr('agent.mcpUnknownServer',{server:serverName}));const known=(await agentMcpTools(workspace||root()||'')).some(t=>t.server===serverName&&t.name===toolName);if(!known)throw new Error(tr('agent.mcpUnknownTool',{tool:`${serverName}.${toolName}`}));const ok=await vscode.window.showWarningMessage(tr('agent.mcpConfirm',{tool:`${serverName}.${toolName}`}),{modal:true,detail:reviewMcpArguments(args)},tr('agent.mcpRun'));if(ok!==tr('agent.mcpRun'))return;if(server.url&&!await approveMcpConnection(serverName,server))return;const call=async(request:(method:string,params:any)=>Promise<any>)=>{
          const live=await request('tools/list',{});
          if(!Array.isArray(live?.tools)||!live.tools.some((tool:any)=>tool?.name===toolName))throw new Error(tr('agent.mcpUnknownTool',{tool:toolName}));
          return request('tools/call',{name:toolName,arguments:args});
        };const result:any=server.url?await withHttpMcp(server,call):await withPersistentStdioMcp(serverName,server,call);const text=(Array.isArray(result?.content)?result.content:[]).map((item:any)=>item?.type==='text'?String(item.text||''):item?.type==='image'?'[image]':JSON.stringify(item)).join('\n').slice(0,20000)||JSON.stringify(result,null,2).slice(0,20000);this.webview?.postMessage({type:'activity',label:tr('agent.mcpRan',{tool:`${serverName}.${toolName}`}),detail:text.slice(0,600)});const doc=await vscode.workspace.openTextDocument({language:'markdown',content:`# MCP · ${serverName}.${toolName}\n\n${text}`});await vscode.window.showTextDocument(doc,{preview:true,preserveFocus:true});return;}
        if(step.kind==='command'){const cmd=(step.command||'').trim();if(!cmd)throw new Error(tr('agent.commandEmpty'));if(hasHiddenCommandCharacters(cmd)||cmd.length>4000)throw new Error(tr('agent.commandUnsafe'));const choice=await vscode.window.showWarningMessage(tr('agent.commandConfirm',{command:cmd}),{modal:true},tr('agent.runCommand'),tr('common.cancel'));if(choice!==tr('agent.runCommand'))return;const terminal=vscode.window.createTerminal({name:tr('agent.commandTerminal'),cwd:workspace});terminal.show();terminal.sendText(cmd,true);this.webview?.postMessage({type:'activity',label:tr('agent.commandRan'),detail:cmd});return;}
        if(!step.path||typeof step.content!=='string')throw new Error(tr('agent.fileStepInvalid'));
        const destination=path.resolve(workspace,step.path);const relative=path.relative(workspace,destination);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error(tr('agent.outsideProject'));
        const item=await this.stageFile(relative,step.content),original=item.isNew?await vscode.workspace.openTextDocument({language:path.extname(destination).slice(1),content:''}).then(d=>d.uri):item.uri;await vscode.commands.executeCommand('vscode.diff',original,item.proposal,`Cude · ${relative}`);
        if(permission==='ask'){this.stagedAgentFiles.set(item.id,{agentId:agent.id,path:item.path});this.publishPending([item]);return;}
        await this.applyStaged([item.id]);agent.artifacts=[...new Set([...(agent.artifacts||[]),item.path])];await this.context.workspaceState.update('agents',agents);this.webview?.postMessage({type:'activity',label:tr('review.appliedActivity'),detail:item.path});return;
      }
      if(message.type==='undo'||message.type==='diff'||message.type==='more'){
        if(this.lastApplied.length){if(message.type==='diff'){const item=this.lastApplied[0];await vscode.commands.executeCommand('vscode.diff',item.uri,item.proposal,tr('history.viewChanges'));return;}if(message.type==='more'){const file=await vscode.window.showQuickPick(this.lastApplied.map(item=>({label:item.path,item})),{placeHolder:tr('history.editedFiles')});if(file)await vscode.commands.executeCommand('vscode.diff',file.item.uri,file.item.proposal,`Cude · ${file.label}`);return;}for(const item of this.lastApplied)await this.assertProposalTarget(item);const docs=await Promise.all(this.lastApplied.map(async item=>({item,doc:await vscode.workspace.openTextDocument(item.uri)}))),changed=docs.filter(({item,doc})=>doc.getText().replace(/^\uFEFF/,'').replace(/\r\n/g,'\n')!==item.after.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'));if(changed.length){const ok=await vscode.window.showWarningMessage(tr('history.undoConfirmMany',{files:changed.map(({item})=>item.path).join(', ')}),{modal:true},tr('history.undoAll'));if(ok!==tr('history.undoAll'))return;}const edit=new vscode.WorkspaceEdit();for(const item of this.lastApplied)await this.assertProposalTarget(item);for(const {item,doc} of docs)edit.replace(item.uri,new vscode.Range(new vscode.Position(0,0),doc.positionAt(doc.getText().length)),item.before);if(!await vscode.workspace.applyEdit(edit))throw new Error(tr('history.undoFailed'));this.lastApplied=[];this.latestChange=undefined;this.webview?.postMessage({type:'status',text:tr('history.undoGroupDone')});return;}
        const change=this.latestChange;if(!change)throw new Error(tr('history.nothingToUndo'));
        if(message.type==='diff'){await vscode.commands.executeCommand('vscode.diff',change.uri,change.proposal,tr('history.viewChanges'));return;}
        if(message.type==='more'){const file=await vscode.window.showQuickPick(change.files.map(f=>({label:f.path,description:`+${f.added} −${f.removed}`})),{placeHolder:tr('history.editedFiles')});if(file)await vscode.commands.executeCommand('vscode.diff',change.uri,change.proposal,`Cude · ${file.label}`);return;}
        await this.assertProposalTarget(change);const doc=await vscode.workspace.openTextDocument(change.uri),current=doc.getText();if(current!==change.after){const ok=await vscode.window.showWarningMessage(tr('history.undoConfirmOne'),{modal:true},tr('chat.undo'));if(ok!==tr('chat.undo'))return;}
        const edit=new vscode.WorkspaceEdit();edit.replace(change.uri,new vscode.Range(new vscode.Position(0,0),doc.positionAt(current.length)),change.before);await vscode.workspace.applyEdit(edit);this.latestChange=undefined;vscode.window.showInformationMessage(tr('history.undone'));return;
      }
      if(message.type==='stop'){this.request?.abort();return;}
      if(message.type==='copyText'){await vscode.env.clipboard.writeText(String(message.text||'').slice(0,200000));void vscode.window.setStatusBarMessage(language()==='tr'?'Panoya kopyalandı':'Copied to clipboard',2500);return;}
      if(message.type==='rewind'||message.type==='branch'){
        // Message actions address user turns counted from the END, so they stay correct after history trimming.
        const real=this.conversation.map((m,i)=>({m,i})).filter(({m})=>m.role==='user'&&typeof m.content==='string'&&!/^(Attached context:|Project skill \()/.test(m.content)).map(({i})=>i);
        const back=Math.max(1,Math.floor(Number(message.fromEnd)||1)),at=real.length-back;
        const userIndex=at>=0?real[at]:0;
        if(message.type==='rewind'){this.request?.abort();this.request=undefined;this.conversation=this.conversation.slice(0,userIndex);await this.saveConversation();return;}
        this.request?.abort();this.request=undefined;await this.saveConversation();
        const cut=message.includeReply?(at+1<real.length?real[at+1]:this.conversation.length):userIndex;
        const kept=this.conversation.slice(0,cut),first=kept.find(m=>m.role==='user')?.content||'';
        this.conversation=kept;this.conversationId=`chat-${Date.now().toString(36)}`;
        const title=(language()==='tr'?'Dal: ':'Branch: ')+String(typeof first==='string'?first:'').replace(/\s+/g,' ').slice(0,48);
        await this.saveConversation();
        this.webview?.postMessage({type:'clear',surface:'ai'});this.webview?.postMessage({type:'session',title,messages:this.conversation});
        if(!message.includeReply&&typeof message.text==='string')this.webview?.postMessage({type:'composer',text:message.text});
        return;
      }
      if(message.type==='newChat'){
        this.request?.abort();
        const surface=message.surface==='cuets'?'cuets':'ai';
        if(surface==='ai'){
          await this.saveConversation();
          this.conversation=[];
          this.conversationId=`chat-${Date.now().toString(36)}`;
        }
        this.webview?.postMessage({type:'clear',surface});return;
      }
      if(message.type==='history'){const chats=this.context.globalState.get<ChatSession[]>('chatSessions',[]),agents=this.context.workspaceState.get<Agent[]>('agents',[]),options:HistoryPick[]=[...chats.map(chat=>({label:chat.title,description:tr('history.chatItem',{workspace:chat.workspace}),pickType:'chat' as const,chat})),...agents.map(agent=>({label:agent.title,description:tr('history.agentItem',{status:agent.status}),pickType:'agent' as const,agent}))];const pick=await vscode.window.showQuickPick<HistoryPick>(options,{placeHolder:tr('history.placeholder')});if(!pick)return;if(pick.pickType==='agent'){this.openAgentSession(pick.agent);return;}this.conversationId=pick.chat.id;this.conversation=pick.chat.messages;this.webview?.postMessage({type:'clear',surface:'ai'});this.webview?.postMessage({type:'session',title:pick.chat.title,messages:this.conversation});return;}
      if(message.type==='findFiles'){const query=String(message.query||''),files=await findProjectFiles(query,24),symbols=query.trim().length>=3?await grepProject(query.trim(),12):[],suggestions=[...files,...symbols.map(match=>({file:match.file,line:match.line,text:match.text}))].filter((item,index,array)=>array.findIndex(other=>(typeof other==='string'?other:other.file)=== (typeof item==='string'?item:item.file))===index);this.webview?.postMessage({type:'fileResults',files:suggestions,query});return;}
      if(message.type==='openFile'){await openProjectFile(String(message.path||''),Number(message.line)||1);return;}
      if(message.type==='search'){
        const query=await vscode.window.showInputBox({title:tr('chat.search'),prompt:tr('search.prompt'),placeHolder:tr('search.placeholder')});if(!query?.trim())return;
        const matches=await grepProject(query.trim(),100);if(!matches.length){vscode.window.showInformationMessage(tr('search.noMatches',{query}));return;}
        const choice=await vscode.window.showQuickPick(matches.map(match=>({label:`${match.file}:${match.line}`,description:match.text,match})),{title:tr('search.results'),matchOnDescription:true});if(choice)await openProjectFile(choice.match.file,choice.match.line);return;
      }
      if(message.type==='attach'){if(message.action==='android'){await openAndroidTools();return;}if(message.action==='imageToThree'){await this.imageToThree();return;}if(message.action==='clone'){await cloneAndOwn();return;}if(message.action!=='file')return;const files=await vscode.window.showOpenDialog({title:tr('context.attachTitle'),canSelectFiles:true,canSelectFolders:false,canSelectMany:true});if(!files?.length)return;let added='';const blocked:string[]=[];for(const uri of files.slice(0,5)){const real=await fs.realpath(uri.fsPath).catch(()=>uri.fsPath);if(secretPath(uri.fsPath)||secretPath(real)||isMcpProjectFile(uri.fsPath)||isMcpProjectFile(real)){blocked.push(path.basename(uri.fsPath));continue;}const stat=await vscode.workspace.fs.stat(uri);if(stat.size>40000)continue;const data=Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');if(data.includes('\u0000'))continue;added+=`\n\n### ${uri.fsPath}\n${data.slice(0,10000)}`;}if(added){this.conversation.push({role:'user',content:`Attached context:${added}`});this.webview?.postMessage({type:'context',name:files.length===1?tr('context.filesAddedOne'):tr('context.filesAddedMany',{count:files.length})});}if(blocked.length)this.webview?.postMessage({type:'status',text:tr('context.secretBlocked',{files:blocked.join(', ')})});return;}
      if(message.type==='providerModel'){
        if(String(message.providerId).startsWith('cude-free:')){
          const free=FREE_PROVIDERS.find(item=>item.id===String(message.providerId).slice(10));
          const name=String(message.providerName||String(message.providerId).slice(10)).replace(/[^\w .-]/g,'').slice(0,60);
          await this.gateway.configure(free?.profileId?'preset:'+free.profileId:'search:'+name);
          return;
        }
        const selection = (this.modelSelection?.catch(() => {}) ?? Promise.resolve()).then(async () => {
          await this.gateway.selectModel(message.providerId, message.model);
          await this.context.globalState.update('effort', typeof message.effort === 'string' ? message.effort : '');
        });
        this.modelSelection = selection;
        try {
          await selection;
        } finally {
          if (this.modelSelection === selection) {
            this.modelSelection = undefined;
            this.gateway.notifyModels();
          }
        }
        return;
      }
      if(message.type==='voiceStart'){
        const view=this.webview;
        try{
          const turkish=language()==='tr',record=turkish?'Kaydı başlat':'Start recording';
          const confirmed=await vscode.window.showInformationMessage(turkish?'Mikrofon kullanılsın mı?':'Allow microphone recording?',{modal:true},record);
          if(confirmed!==record||!view||this.webview!==view){view?.postMessage({type:'voiceState',state:'idle'});return;}
          stopSpeaking();
          await startRecording(()=>view.postMessage({type:'voiceState',state:'idle'}));
          view.postMessage({type:'voiceState',state:'recording'});
        }catch(error:any){view?.postMessage({type:'voiceState',state:'idle',error:voiceErrorText(error)});}
        return;
      }
      if(message.type==='voiceStop'){
        if(this.voiceTranscript)return;
        const controller=new AbortController(),view=this.webview;
        this.voiceTranscript=controller;
        let file='';
        try{
          file=await stopRecording();
          if(controller.signal.aborted)return;
          view?.postMessage({type:'voiceState',state:'transcribing'});
          const lang=language();
          let result=await this.gateway.transcribe(file,lang,controller.signal);
          if(controller.signal.aborted)return;
          if(!result){
            result={text:await dictateLocally(file,controller.signal),via:'Windows'};
            if(lang==='tr')view?.postMessage({type:'status',text:tr('voice.localEnglish')});
          }
          if(controller.signal.aborted)return;
          view?.postMessage({type:'voiceText',text:result.text});
          view?.postMessage({type:'voiceState',state:'idle',error:result.text?undefined:tr('voice.nothingHeard')});
        }catch(error:any){
          if(!controller.signal.aborted)view?.postMessage({type:'voiceState',state:'idle',error:voiceErrorText(error)});
        }finally{
          if(file)await discardRecording(file);
          if(this.voiceTranscript===controller)this.voiceTranscript=undefined;
        }
        return;
      }
      if(message.type==='voiceCancel'){this.voiceTranscript?.abort();cancelRecording();this.webview?.postMessage({type:'voiceState',state:'idle'});return;}
      if(message.type==='speak'){void speak(String(message.text||'').slice(0,20000),language()).catch(()=>undefined);return;}
      if(message.type==='stopSpeaking'){stopSpeaking();return;}
      if(message.type==='effort'){const effort=String(message.value??'').trim();await this.context.globalState.update('effort',effort);return;}
      if(message.type==='permission'){let value=['ask','auto','plan','readonly','full'].includes(message.value)?message.value:'ask';if(value==='full'){const ok=await vscode.window.showWarningMessage(tr('permission.fullConfirm'),{modal:true},tr('permission.fullConfirmAction'));if(ok!==tr('permission.fullConfirmAction'))value=this.context.workspaceState.get<string>('permission','auto');}await this.context.workspaceState.update('permission',value);this.webview?.postMessage({type:'permission',value});return;}
      if(message.type==='memoryNote'){const workspace=root();if(!workspace)throw new Error(tr('memory.openProject'));const file=await appendProjectMemory(workspace,String(message.text||''));this.webview?.postMessage({type:'status',text:tr('memory.noteSaved')});return;}
      if(message.type==='openProject'){const folders=await vscode.window.showOpenDialog({title:tr('chat.openProject'),canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:tr('chat.openProject')});if(folders?.[0])await vscode.commands.executeCommand('vscode.openFolder',folders[0],false);return;}
      if(message.type==='clone'){await cloneAndOwn();return;}
      if(message.type==='localTools'){await detectLocalTools();return;}
      if(message.type==='memory'){const workspace=root();if(!workspace)throw new Error(tr('errors.openProjectFolder'));const content=await memoryText();const doc=await vscode.workspace.openTextDocument({language:'markdown',content:content||'# Cude project memory\n\nUse Cude AI: Save Session Summary to create shared project context.\n'});await vscode.window.showTextDocument(doc);return;}
      if(message.type==='rules'){const workspace=root();if(!workspace)throw new Error(tr('errors.openProjectFolder'));requireTrustedWorkspace('editing project rules');const directory=path.join(workspace,'.cude'),file=path.join(directory,'rules.md');await fs.mkdir(directory,{recursive:true});try{await fs.access(file);}catch{await fs.writeFile(file,'# Project rules\n\nDescribe project conventions, constraints and preferred implementation patterns. These rules are included in Cude AI requests for this workspace.\n','utf8');}await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));return;}
      if(message.type==='spec'){if(!message.text?.trim())throw new Error(tr('spec.describe'));const file=await makeSpec(this.gateway,message.text.trim());this.reply(tr('spec.created',{file}));return;}
      if (['chat', 'agent', 'spec', 'edit'].includes(message.type)) await this.modelSelection;
      if((message.type==='agent'||message.type==='chat')&&message.cuets){await this.runCuetsTask(String(message.text||''));return;}
      if(message.type==='agent'&&!message.explicitAgent&&root()){
        const cfg=vscode.workspace.getConfiguration('cude-ai');
        const selected=globalSetting<string>(cfg,'model','');
        const smallLocal=this.gateway.isLocalActive()&&/(?:^|[-_/])(?:0(?:\.\d+)?|1(?:\.\d+)?)b(?:$|[-_.])/i.test(selected);
        const attached=message.includeActive===true||Boolean(message.attachments?.length);
        const prompt=String(message.text||'').split('\n',1)[0].trim();
        const explanation=attached&&/^(?:explain\b|summarize\b|what (?:does|is)\b|açıkla\b|özetle\b|.+ ne (?:yapar|işe yarar)\b)/i.test(prompt)&&
          !/\b(?:and|then|ve|sonra)\s+(?:fix|edit|change|implement|run|write|düzelt|değiştir|yaz|çalıştır)\b/i.test(prompt);
        if(explanation||(smallLocal&&message.permission==='auto')){
          message={...message,type:'chat',autoCuets:false};
        }
      }
      if((message.type==='agent'||message.type==='chat')&&message.autoCuets){const decision=autoCuetsDecision(String(message.text||''));if(decision.multiStep){this.webview?.postMessage({type:'surface',value:'cuets',reason:decision.reason?tr(decision.reason):''});await this.runCuetsTask(String(message.text||''));return;}}
      if(message.type==='agent'&&globalSetting<boolean>(vscode.workspace.getConfiguration('cude-ai'),'agent.loop',true)){if(!message.text?.trim())throw new Error(tr('agent.describeTask'));if(this.request)throw new Error(tr('cuets.alreadyRunning'));const workspace=root();if(!workspace)throw new Error(tr('errors.openProjectFolder'));requireTrustedWorkspace('running the Cude agent');const controller=new AbortController();this.request=controller;const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');const lt=(key:string,values?:Record<string,string|number>)=>tr(key as MessageKey,values);try{const memory=(await memoryText(workspace)).slice(0,4000);
          const semantic=await this.gateway.semanticContext?.(workspace,message.text,controller.signal);
          const context=[semantic?'Norovox semantic search:\n'+semantic:'',memory?'Project memory:\n'+memory:''].filter(Boolean).join('\n\n');
          const result=await runAgentLoop({localModel:this.gateway.isLocalActive(),images:!this.gateway.isLocalActive(),task:codebaseQuery(message.text),workspace,permission,context,chat:(messages,signal)=>this.gateway.chat(messages as any,signal),mcpTools:await agentMcpTools(workspace),callMcp:loopMcpCall,confirm:async(text,detail,action)=>this.confirmCommand(text,detail,controller.signal,action),continueAfter:checkpoint=>this.askAgentContinuation(checkpoint,controller.signal),events:{activity:(label,detail)=>this.webview?.postMessage({type:'activity',label,detail}),status:text=>this.webview?.postMessage({type:'status',text})},text:lt,signal:controller.signal,maxSteps:Math.max(5,Math.min(80,globalSetting<number>(vscode.workspace.getConfiguration('cude-ai'),'agent.maxSteps',30))),maxMinutes:Math.max(2,Math.min(120,globalSetting<number>(vscode.workspace.getConfiguration('cude-ai'),'agent.maxMinutes',20)))});this.reply(result.final);}finally{if(this.request===controller)this.request=undefined;}return;}
      if(message.type==='agent'){if(!message.text?.trim())throw new Error(tr('agent.describeTask'));const activity=(label:string,detail:string)=>this.webview?.postMessage({type:'activity',label,detail});const agent=await this.agents.start(message.text.trim(),activity);this.reply(agent.output||tr('agent.planReady'));this.webview?.postMessage({type:'plan',agentId:agent.id,title:agent.title,summary:agent.output,steps:agent.steps||[],artifacts:agent.artifacts||[]});return;}
      if(message.type==='chat'){
        if(this.request)throw new Error(tr('cuets.alreadyRunning'));
        ownedRequest=new AbortController();
        this.request=ownedRequest;
        const activeCandidate=message.includeActive===false?undefined:vscode.window.activeTextEditor,editor=activeCandidate&&!await isProtectedEditorDocument(activeCandidate.document)?activeCandidate:undefined,current=editor?`${path.basename(editor.document.fileName)}${editor.selection.isEmpty?'':`:${editor.selection.start.line+1}-${editor.selection.end.line+1}`}\n${editor.selection.isEmpty?editor.document.getText().slice(0,12000):editor.document.getText(editor.selection).slice(0,12000)}`:'';
        const memory=(await memoryText()).slice(0,5000),project=await projectContext(),attachments=await readProjectAttachments(Array.isArray(message.attachments)?message.attachments.filter((item:any)=>typeof item==='string'):[]);
        const mentionsCodebase=hasCodebaseMention(message.text||'');
        const semantic=mentionsCodebase?await this.gateway.semanticContext?.(root(),message.text,ownedRequest.signal):'';
        if(mentionsCodebase&&!semantic)this.webview?.postMessage({type:'activity',label:language()==='tr'?'Anlamsal indeks kullanılamıyor':'Semantic index unavailable',detail:'Cude: Index Project (Semantic)'});
        this.webview?.postMessage({type:'activity',label:tr('chat.filesRead'),detail:tr('chat.contextPrepared',{project:root()||tr('chat.noOpenProject')})});
        this.conversation.push({role:'user',content:codebaseQuery(message.text||'')||'Explain the current project.'});
        await this.saveConversation();
        if(this.conversation.length>24)this.conversation.splice(0,this.conversation.length-24);
        ownedRequest.signal.throwIfAborted();
        const requestHistory:any[]=[...this.conversation],images=Array.isArray(message.images)?message.images.slice(0,5):[];let imageBytes=0;const imageParts=images.flatMap((image:any)=>{if(typeof image?.dataUrl!=='string')return[];const match=image.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);if(!match)return[];imageBytes+=Buffer.byteLength(match[2],'base64');if(imageBytes>12*1024*1024)return[];return[{type:'image_url',image_url:{url:image.dataUrl}}];});if(imageParts.length&&requestHistory.at(-1)?.role==='user'){const last=requestHistory.at(-1);requestHistory[requestHistory.length-1]={role:'user',content:[{type:'text',text:last.content},...imageParts]};}
         const answer=await this.gateway.chat([{role:'system',content:`You are Cude AI, a precise coding assistant. Use project context and memory when relevant. Explain uncertainty clearly. Do not claim to have changed files or run commands. Do not assist with cheats, malware, credential theft, evasion, or unauthorized access; redirect to legal, defensive or permitted alternatives. When adapting a reference repository, preserve its license and attribution; propose original implementation and never imply upstream code is newly authored.\n\nProject memory:\n${memory}\n\nRepository context:\n${project}\n\n${attachments}\n\nNorovox semantic search:\n${semantic||''}\n\nActive file context:\n${current}`},...requestHistory],ownedRequest.signal,delta=>this.webview?.postMessage({type:'delta',text:delta}),undefined,route=>this.webview?.postMessage({type:'route',...route}));
        this.conversation.push({role:'assistant',content:answer});
        await this.saveConversation();
        if(this.conversation.length>24)this.conversation.splice(0,this.conversation.length-24);
        this.reply(answer);return;
      }
      if(message.type==='edit'){
        const permission=this.context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');if(permission==='readonly')throw new Error(tr('errors.readonlyNoEdit'));if(permission==='plan')throw new Error(tr('errors.planNoEdit'));
        const editor=vscode.window.activeTextEditor;if(!editor)throw new Error(tr('editor.openFileSelect'));if(await isProtectedEditorDocument(editor.document))throw new Error(tr('editor.protectedFile'));if(editor.selection.isEmpty)throw new Error(tr('editor.selectCode'));
        const original=editor.document.getText(),selection=editor.selection,start=editor.document.offsetAt(selection.start),end=editor.document.offsetAt(selection.end);
        let replacement=await this.gateway.chat([{role:'system',content:'Edit only the selected code. Return the complete replacement text and nothing else. Do not use markdown fences.'},{role:'user',content:`Request: ${message.text}\nSelected code:\n${editor.document.getText(selection)}`}]);replacement=replacement.replace(/^```[^\n]*\n|\n```$/g,'');
        const workspace=root();if(!workspace)throw new Error(tr('review.openProjectForEditor'));const relative=path.relative(workspace,editor.document.uri.fsPath).replace(/\\/g,'/');const after=original.slice(0,start)+replacement+original.slice(end),staged=await this.stageFile(relative,after);await vscode.commands.executeCommand('vscode.diff',editor.document.uri,staged.proposal,tr('editor.reviewDiffTitle'));
        const choice=(permission==='auto'||permission==='full')?tr('chat.apply'):await vscode.window.showInformationMessage(tr('review.applyPrompt'),tr('chat.apply'),tr('review.keepReviewing'));
        if(choice===tr('chat.apply')){await this.applyStaged([staged.id]);this.reply(tr('review.appliedToEditor'));}else this.reply(tr('review.diffReady'));
      }
    }catch(error:any){if(error?.name==='AbortError'){this.webview?.postMessage({type:'answer',text:tr('chat.stopped')});}else this.reply(`${error?.message||String(error)}`,'error');}finally{if(ownedRequest&&this.request===ownedRequest)this.request=undefined;}
  }
}
function isBoundedPanelMessage(value:unknown):value is Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const message=value as Record<string,unknown>;
  if(typeof message.type!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(message.type))return false;
  try{return Buffer.byteLength(JSON.stringify(message))<=262144;}catch{return false;}
}
class CudeAgentsPanel {
  private panel?:vscode.WebviewPanel;
  constructor(private context:vscode.ExtensionContext,private agents:Agents,private chat:CudeChatView,private gateway:Gateway){this.agents.onDidChangeTreeData(()=>this.publish());}
  private publish(){this.panel?.webview.postMessage({type:'agents',agents:this.agents.list()});}
  refreshLanguage(){this.panel?.webview.postMessage({type:'language',language:language(),dictionary:I18N});}
  async show(){if(this.panel){this.panel.reveal(vscode.ViewColumn.One);this.publish();return;}const nonce=randomBytes(18).toString('base64url'),panel=vscode.window.createWebviewPanel('cudeAgents','Cude · Agents',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]});this.panel=panel;const media=vscode.Uri.joinPath(this.context.extensionUri,'media').fsPath;const [file,selectStyle]=await Promise.all([fs.readFile(path.join(media,'agents.html'),'utf8'),fs.readFile(path.join(media,'webview-select.css'),'utf8')]);panel.webview.html=file.replace('{{WEBVIEW_SELECT}}',()=>selectStyle).replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-'+nonce+'\'">').replace('__NONCE__',nonce).replaceAll('{{LANG}}',language()).replaceAll('{{I18N}}',JSON.stringify(I18N));panel.onDidDispose(()=>{if(this.panel===panel)this.panel=undefined;});panel.webview.onDidReceiveMessage(async(message:any)=>{try{
    if(this.panel!==panel||!isBoundedPanelMessage(message))return;
    if(message.type==='ready'){this.publish();panel.webview.postMessage({type:'models',...this.gateway.chatModelState()});return;}
    if(message.type==='layout'){if(message.value==='editor'){panel.dispose();await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');}else this.show();return;}
    if(message.type==='refresh'){this.publish();return;}
    if(message.type==='newAgent'){panel.webview.postMessage({type:'status',message:tr('agent.useNewForm')});return;}
    if(message.type==='worktree'){await createAgentWorktree();return;}
    if(message.type==='startAgent'){const task=typeof message.task==='string'?message.task.trim():'';if(!task||task.length>20000)throw new Error(tr('agent.taskEmpty'));requireTrustedWorkspace('starting an agent');let workspace=root(),worktreePath:string|undefined,baseBranch:string|undefined;if(message.location==='worktree'){const created=await createAgentWorktreePath();if(!created)return;workspace=created.path;worktreePath=created.path;baseBranch=created.baseBranch;}const permission=['ask','auto','plan','readonly'].includes(message.permission)?message.permission:'ask';const opts={workspace,worktreePath,baseBranch,permission,providerId:typeof message.providerId==='string'?message.providerId:undefined,model:typeof message.model==='string'?message.model:undefined};void this.agents.start(task,undefined,opts).then(async agent=>{if((agent.permission==='auto'||agent.permission==='full')&&agent.status==='done'&&agent.steps?.some(step=>step.kind==='file'))await this.chat.reviewAgent(agent.id,undefined,true);this.publish();}).catch(error=>panel.webview.postMessage({type:'status',message:error?.message||String(error)}));this.publish();panel.webview.postMessage({type:'status',message:tr('agent.queued')});return;}
    if(message.type==='reviewFile'){await this.chat.reviewAgent(String(message.agentId||''),typeof message.path==='string'?message.path:undefined,message.accept===true);this.publish();return;}
    if(message.type==='previewFile'){await this.chat.previewAgentFile(String(message.agentId||''),String(message.path||''));return;}
    if(message.type==='mergeWorktree'){await mergeAgentWorktree(this.agents.list().find(agent=>agent.id===message.agentId));return;}
  }catch(error:any){panel.webview.postMessage({type:'status',message:error?.message||String(error)});}});this.publish();}
  toggle(){if(this.panel){this.close();return;}void this.show();}
  close(){this.panel?.dispose();}
}


async function openWelcome(context:vscode.ExtensionContext,gateway:Gateway){
  const panel=vscode.window.createWebviewPanel('cudeWelcome','Cude IDE',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});
  panel.iconPath=vscode.Uri.joinPath(context.extensionUri,'media','cude_logo.png');
  const media=path.join(context.extensionPath,'media');
  const [template,mark]=await Promise.all([fs.readFile(path.join(media,'welcome.html'),'utf8'),fs.readFile(path.join(media,'cude-mark.svg'),'utf8')]);
  const nonce=randomBytes(16).toString('base64url');
  panel.webview.html=fillTemplate(template,{LANG:language(),CSP:panel.webview.cspSource,NONCE:nonce,MARK:mark.replace(/^[\s\S]*?<svg/,'<svg'),SHOW_AGAIN:context.globalState.get<boolean>('cude.welcome.startup',false)?'true':'false'});
  panel.webview.onDidReceiveMessage(async message=>{
    if(message?.type==='again'){await context.globalState.update('cude.welcome.startup',message.value===true);return;}
    if(message?.type!=='run')return;
    const cmd=String(message.cmd||'');
    if(cmd==='free')await gateway.configure('tab:free');
    else if(cmd==='providers')await gateway.configure('tab:providers');
    else if(cmd==='local')await gateway.configure('tab:local');
    else if(cmd==='open')await vscode.commands.executeCommand('workbench.action.files.openFolder');
    else if(cmd==='chat')await vscode.commands.executeCommand('cude-ai.chatView.focus');
    else if(cmd==='language')await vscode.commands.executeCommand('cude-ai.changeLanguage');
  });
}
/** Cude does not host models: the pool, free pool models, Nythos and supporter cards are switched off. */
export const CUDE_POOL_ENABLED=false;
export const activationStartedAt=Date.now();
export function startupMark(context:vscode.ExtensionContext,label:string){const line=`[${new Date().toISOString()}] ${label} +${Date.now()-activationStartedAt}ms (process uptime ${Math.round(process.uptime()*1000)}ms)
`;void fs.mkdir(context.globalStorageUri.fsPath,{recursive:true}).then(()=>fs.appendFile(path.join(context.globalStorageUri.fsPath,'startup.log'),line)).catch(()=>{});}
export function activate(context:vscode.ExtensionContext) {
  startupMark(context,'activate');
  initializeForcedUpdate(context);
  registerReleaseCommands(context);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('cude-proposal',proposalContentProvider));
  core=new CudeCore(path.join(context.extensionPath,'bin','cude-core.exe'));context.subscriptions.push({dispose:()=>core?.dispose()});
  const catalog=new ModelCatalog(context),gateway=new Gateway(context.secrets,context,catalog),agents=new Agents(context,gateway);context.subscriptions.push({dispose:()=>gateway.dispose()}); context.subscriptions.push(vscode.window.registerTreeDataProvider('cude-ai.agents',agents));registerEditorFeatures(context,gateway);
  startHeartbeat(context,undiciFetch,()=>gateway.heartbeatConnection());
  gateway.startPoolDirectory();context.subscriptions.push({dispose:()=>gateway.stopPoolDirectory()});
  void gateway.warmProviderMedia().catch(error=>console.warn('[Cude AI] provider panel media unavailable',error));
  const sb=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,1000);const updateSb=()=>{const cfg=vscode.workspace.getConfiguration('cude-ai'),m=globalSetting<string>(cfg,'model',''),prof=globalSetting<ProviderProfile[]>(cfg,'providers',[]).find(x=>x.id===globalSetting<string>(cfg,'activeProviderId',''));sb.text=`${tr('app.ai')} · ${m?statusModelName(m):tr('status.modelNotSelected')}`;sb.tooltip=m?`${tr('status.activeModel',{model:m})}${prof?` (${prof.name})`:''} · Ctrl+L`:tr('status.chooseModel');};updateSb();sb.command='cude-ai.chat';sb.show();context.subscriptions.push(sb);
  const chatView=new CudeChatView(context,gateway,agents,sb),agentsPanel=new CudeAgentsPanel(context,agents,chatView,gateway);
  const command=(id:string,fn:(...args:any[])=>any)=>context.subscriptions.push(vscode.commands.registerCommand(`cude-ai.${id}`,async(...args:any[])=>{assertCommandAllowed();return fn(...args);}));
  command('updateRequired',()=>{});
  command('configureProvider',()=>gateway.configure());
  command('importProvidersFromEditors',()=>gateway.importProvidersFromEditors());
  command('supporterCard',()=>gateway.configure('tab:providers'));
  command('indexProjectSemantic',async()=>{
    try{await gateway.indexSemanticProject();}
    catch(error:any){void vscode.window.showErrorMessage(String(error?.message||error));}
  });
  command('modelCatalog',()=>browseModelCatalog(gateway));
  command('updateModelCatalog',async()=>{const next=await gateway.refreshCatalog();vscode.window.showInformationMessage(tr('catalog.updatedMessage',{models:next.models.length.toLocaleString(),providers:next.providers.length.toLocaleString()}));});
  command('routerSettings',()=>vscode.commands.executeCommand('workbench.action.openSettings','@ext:cude.cude-ai router'));
  command('changeLanguage',()=>changeCudeLanguage());
  command('detectLocalTools',()=>detectLocalTools());
  command('cloneAndOwn',()=>cloneAndOwn());
  command('about',()=>openAbout(context));
  command('welcome',()=>vscode.commands.executeCommand('setContext','cude.onboarding','wizard'));
  command('introducing',()=>vscode.commands.executeCommand('setContext','cude.onboarding','intro'));
  command('welcomePage',()=>openWelcome(context,gateway));
  command('onboardingTheme',async(value:string)=>{await vscode.workspace.getConfiguration('workbench').update('colorTheme',value==='light'?'Light 2026':'Cude Dark',vscode.ConfigurationTarget.Global);});
  command('onboardingLanguage',async(value:string)=>{await vscode.workspace.getConfiguration('cude-ai').update('language',value==='tr'?'tr':'en',vscode.ConfigurationTarget.Global);});
  command('onboardingLocal',()=>gateway.configure('tab:local'));
  command('onboardingAgents',()=>gateway.configure('tab:cli'));
  command('connectDesktopApps',(app?:string)=>connectDesktopApps(context,app));
  command('settings',createCudeSettings(context,value=>chatView.refreshPermission(value)));
  command('android',openAndroidTools);
  command('androidSdk',chooseAndroidSdk);
  command('imageToThree',()=>chatView.imageToThree());
  activateAppBridge(context);
  activateHealth(context,()=>{let freed=0;try{freed+=(gateway as any).localModels?.stopServers?.()||0;}catch{}if(opencodeServer?.running&&!opencodeServer.busy){opencodeServer.stop();freed++;}return freed;});
  {const t=setTimeout(()=>{if(vscode.workspace.getConfiguration('cude-ai').get<boolean>('cliAgents.enabled',false))void loadCliModels(context).then(()=>gateway.notifyModels());},8000);context.subscriptions.push({dispose:()=>clearTimeout(t)});}
  if(vscode.workspace.getConfiguration('cude-ai').get<boolean>('bridge.enabled',false))void startBridge(context).catch(error=>console.warn('[Cude AI] desktop bridge unavailable',error));
  startupMark(context,'providers registered');
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('cude-ai.chatView',chatView,{webviewOptions:{retainContextWhenHidden:true}}));context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(()=>chatView.postTrust(true)));
  command('configurePool',async()=>{await gateway.configure('tab:providers');});
  command('importNvidiaCredential',async()=>{try{await gateway.importNvidiaCredential();}catch(error:any){void vscode.window.showErrorMessage(String(error?.message||error));}});
  command('acpPrompt', async () => {
    const cli = localCliInventory(true).find(item => item.id === 'opencode-cli');
    if (!cli) return void vscode.window.showErrorMessage('OpenCode ACP requires an installed OpenCode CLI.');
    const prompt = await vscode.window.showInputBox({ prompt: 'Send a standalone prompt to OpenCode ACP', ignoreFocusOut: true });
    if (!prompt?.trim()) return;
    const accepted = await vscode.window.showWarningMessage('Send this prompt to the provider configured in OpenCode?', {
      modal: true, detail: 'Cude sends the prompt without attaching the current workspace. Tool permissions are denied for this session.'
    }, 'Send prompt');
    if (accepted !== 'Send prompt') return;
    const dir = path.join(context.globalStorageUri.fsPath, 'acp-isolated');
    await fs.mkdir(dir, { recursive: true });
    const invocation = resolveLocalCliInvocation(cli, ['acp']);
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','LANG','XDG_CONFIG_HOME','XDG_DATA_HOME']) if (process.env[name]) env[name] = process.env[name];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { '*': 'deny' } });
    try {
      const content = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenCode ACP', cancellable: true }, async (_progress, token) => {
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort());
        try { return await runAcpPrompt({ ...invocation, cwd: dir, env }, prompt, AbortSignal.any([controller.signal, AbortSignal.timeout(90000)])); }
        finally { cancel.dispose(); }
      });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content }));
    } catch (error:any) { void vscode.window.showErrorMessage(String(error?.message || error)); }
  });
  command('chat',()=>chatView.focus('chat'));
  command('chatInEditor',()=>chatView.openPanel(vscode.window.activeTextEditor?vscode.ViewColumn.Beside:vscode.ViewColumn.One));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('cude-ai'))updateSb();}));
  command('spec',async()=>{const goal=await vscode.window.showInputBox({prompt:tr('spec.goalPrompt'),placeHolder:tr('spec.goalPlaceholder')});if(goal)await makeSpec(gateway,goal);});
  command('runSpecTask',async()=>{const r=root();if(!r)throw new Error(tr('errors.openProjectFolder'));const dir=path.join(r,'.cude','specs');let files:string[]=[];try{files=await fs.readdir(dir);}catch{};const file=await vscode.window.showQuickPick(files,{placeHolder:tr('spec.chooseFile')});if(!file)return;const body=await fs.readFile(path.join(dir,file),'utf8');const lines=body.split(/\r?\n/);const tasks=lines.filter(l=>/^\s*[-*]\s+\[ \]/.test(l));const task=await vscode.window.showQuickPick(tasks,{placeHolder:tr('spec.chooseTask')});if(!task)return;const answer=await gateway.chat([{role:'system',content:'Implement the selected task in this project. First respond with a concrete patch proposal as unified diff. Do not claim changes were applied.'},{role:'user',content:`Spec:\n${body.slice(0,10000)}\nTask: ${task}`}]);const doc=await vscode.workspace.openTextDocument({language:'diff',content:answer});await vscode.window.showTextDocument(doc);vscode.window.showInformationMessage(tr('spec.reviewProposal'));});
  command('agent',()=>chatView.focus('agent'));
  command('agentManager',()=>agentsPanel.show());
  command('toggleAgentsLayout',()=>agentsPanel.toggle());
  command('openAgentSession',(agent:Agent)=>chatView.openAgentSession(agent));
  command('newAgentWorktree',()=>createAgentWorktree());
  command('skills',()=>chatView.chooseSkill());
  command('clearAgents',async()=>{await context.workspaceState.update('agents',[]);agents.refresh();});
  command('agentResult',(a:Agent)=>chatView.openAgentSession(a));
  command('runApprovedCommand',async()=>{requireTrustedWorkspace('running a terminal command');if(context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto')==='readonly'||context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto')==='plan')throw new Error(tr('errors.readonlyPlanNoCommand'));const cmd=await vscode.window.showInputBox({prompt:tr('command.enterPrompt'),placeHolder:'npm test'});if(!cmd)return;const ok=await vscode.window.showWarningMessage(tr('command.confirm',{command:cmd}),{modal:true},tr('command.run'),tr('common.cancel'));if(ok!==tr('command.run'))return;const terminal=vscode.window.createTerminal({name:tr('command.terminalName'),cwd:root()});terminal.show();terminal.sendText(cmd,true);});
  command('memory',async()=>{const r=root();if(!r)throw new Error(tr('errors.openProjectFolder'));const file=path.join(await ensureCudeDir(),'memory.md');try{await fs.access(file);}catch{await fs.writeFile(file,'# Cude project memory\n\n## Project overview\n\n## Decisions\n\n## Current status\n\n## Next steps\n','utf8');}await vscode.window.showTextDocument(vscode.Uri.file(file));});
  command('saveMemory',async()=>{const r=root();if(!r)throw new Error(tr('errors.openProjectFolder'));const summary=await vscode.window.showInputBox({prompt:tr('memory.summaryPrompt')});if(!summary)return;await appendProjectMemory(r,summary);vscode.window.showInformationMessage(tr('memory.summarySaved'));});
  command('mcp',inspectMcp);
  command('mcpAddTools',addMcpAgentTools);
  command('mcpCall',mcpCall);
  const startupTimer=setTimeout(()=>{
    if(!chatView.hasSidebar()&&!hasUpdatesPanel())void vscode.commands.executeCommand('workbench.view.extension.cude-ai-chat').then(undefined,()=>{});
  },600);
  context.subscriptions.push({dispose:()=>clearTimeout(startupTimer)});
 { const inspected=vscode.workspace.getConfiguration('cude-ai').inspect<string>('language'); if(inspected?.globalValue===undefined&&inspected?.workspaceValue===undefined){ const envTr=(vscode.env.language||'').toLowerCase().startsWith('tr'); if(envTr) void vscode.workspace.getConfiguration('cude-ai').update('language','tr',vscode.ConfigurationTarget.Global).then(undefined,()=>{}); } else setTimeout(()=>void syncDisplayLocale(true),4000); }
 context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('cude-ai.language')){void syncDisplayLocale(true);chatView.refreshLanguage();agentsPanel.refreshLanguage();gateway.refreshProviderLanguage();}if(e.affectsConfiguration('cude-ai.freePool.url'))void gateway.refreshPoolQuota(true);if(e.affectsConfiguration('cude-ai.localModels.enabled'))void gateway.refreshLocalProfiles();if(e.affectsConfiguration('cude-ai'))gateway.notifyModels();}));
  const ollamaTimer=setTimeout(()=>void detectOllama(context),4000);
  context.subscriptions.push({dispose:()=>clearTimeout(ollamaTimer)});
}

async function detectOllama(context:vscode.ExtensionContext){
  try{const cfg=vscode.workspace.getConfiguration('cude-ai');if(globalSetting<string>(cfg,'provider','openai-compatible')!=='openai-compatible')return;const response=await fetch('http://localhost:11434/api/tags',{signal:AbortSignal.timeout(1200)});if(!response.ok)return;const data:any=await response.json();const models=(data.models||[]).map((m:any)=>m.name).filter((m:any)=>typeof m==='string');if(!models.length)return;const profiles=globalSetting<ProviderProfile[]>(cfg,'providers',[]),id='ollama-local',profile:ProviderProfile={id,name:tr('provider.ollamaLocal'),provider:'ollama',baseUrl:'http://localhost:11434/v1',models};const index=profiles.findIndex(p=>p.id===id);if(index>=0)profiles[index]=profile;else profiles.push(profile);await cfg.update('providers',profiles,vscode.ConfigurationTarget.Global);await cfg.update('activeProviderId',id,vscode.ConfigurationTarget.Global);await cfg.update('provider','ollama',vscode.ConfigurationTarget.Global);await cfg.update('baseUrl',profile.baseUrl,vscode.ConfigurationTarget.Global);await cfg.update('model',models[0],vscode.ConfigurationTarget.Global);}
  catch{}
}

async function createAgentWorktreePath(){
  requireTrustedWorkspace('creating an isolated agent worktree');const workspace=root();if(!workspace)throw new Error(tr('worktree.openGitProject'));
  const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:workspace,encoding:'utf8',windowsHide:true}).trim(),baseBranch=execFileSync('git',['branch','--show-current'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim()||'HEAD';
  const parent=await vscode.window.showOpenDialog({title:tr('worktree.chooseParent'),canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:tr('worktree.selectFolder')});if(!parent?.[0])return;
  const stamp=new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14),name=`${path.basename(repo)}-cude-agent-${stamp}`,destination=path.join(parent[0].fsPath,name),branch=`cude/agent-${stamp}`;
  try{await fs.access(destination);throw new Error(tr('worktree.exists',{path:destination}));}catch(error:any){if(error?.code!=='ENOENT')throw error;}
  const ok=await vscode.window.showWarningMessage(tr('worktree.confirmCreate',{branch,path:destination}),{modal:true},tr('worktree.create'),tr('common.cancel'));if(ok!==tr('worktree.create'))return;
  execFileSync('git',['worktree','add','-b',branch,'--',destination,baseBranch],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:30000});return{path:destination,repo,branch,baseBranch};
}
export async function createAgentWorktree(){const created=await createAgentWorktreePath();if(!created)return;const open=await vscode.window.showInformationMessage(tr('worktree.ready',{branch:created.branch}),tr('worktree.openNewWindow'),tr('common.later'));if(open===tr('worktree.openNewWindow'))await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(created.path),true);}
async function mergeAgentWorktree(agent:Agent|undefined){
  requireTrustedWorkspace('merging an agent worktree');if(!agent?.worktreePath||!agent.baseBranch)throw new Error(tr('worktree.notLinked'));if(agent.status!=='done')throw new Error(tr('worktree.agentRunning'));const accepted=agent.acceptedFiles||[];if(!accepted.length)throw new Error(tr('worktree.acceptFirst'));const repo=root();if(!repo)throw new Error(tr('worktree.noBaseProject'));const repoRoot=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim(),current=execFileSync('git',['branch','--show-current'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim();if(current!==agent.baseBranch)throw new Error(tr('worktree.wrongBranch',{base:agent.baseBranch,current:current||tr('worktree.detachedHead')}));const dirty=execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim();if(dirty)throw new Error(tr('worktree.dirty'));const ok=await vscode.window.showWarningMessage(tr('worktree.confirmMerge',{base:agent.baseBranch,files:accepted.join(', ')}),{modal:true},tr('worktree.merge'),tr('common.cancel'));if(ok!==tr('worktree.merge'))return;const branch=execFileSync('git',['branch','--show-current'],{cwd:agent.worktreePath,encoding:'utf8',windowsHide:true}).trim();if(!branch.startsWith('cude/agent-'))throw new Error(tr('worktree.badBranch'));execFileSync('git',['add','--',...accepted],{cwd:agent.worktreePath,encoding:'utf8',windowsHide:true,timeout:30000});const staged=execFileSync('git',['diff','--cached','--name-only'],{cwd:agent.worktreePath,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean);if(staged.some(file=>!accepted.includes(file)))throw new Error(tr('worktree.unacceptedStaged'));execFileSync('git',['-c','user.name=Cude Agent','-c','user.email=cude-agent@local.invalid','commit','-m',`Cude agent: ${agent.title.slice(0,60)}`],{cwd:agent.worktreePath,encoding:'utf8',windowsHide:true,timeout:30000});try{execFileSync('git',['merge','--no-ff','--no-edit',branch],{cwd:repoRoot,encoding:'utf8',windowsHide:true,timeout:60000});}catch(error:any){try{execFileSync('git',['merge','--abort'],{cwd:repoRoot,encoding:'utf8',windowsHide:true,timeout:10000});}catch{}throw new Error(tr('worktree.mergeFailed',{error:String(error?.message||error)}));}vscode.window.showInformationMessage(tr('worktree.merged',{base:agent.baseBranch}));
}

type LocalTool={label:string;kind:'cli'|'desktop';command?:string;path?:string;description:string};
async function detectLocalTools(){
  const tools:LocalTool[]=localCliInventory().map(cli=>({label:`${cli.name} CLI`,kind:'cli',command:cli.bin,path:cli.path,description:cli.path}));const win=process.platform==='win32';
  const home=os.homedir();const local=process.env.LOCALAPPDATA||path.join(home,'AppData','Local');
  const desktopCandidates:Record<string,string[]>={
    'Codex Desktop':win?[path.join(local,'Programs','Codex','Codex.exe'),path.join(local,'Programs','OpenAI Codex','Codex.exe')]:process.platform==='darwin'?['/Applications/Codex.app',path.join(home,'Applications','Codex.app')]:[path.join(home,'.local','share','applications','codex.desktop')],
    'Claude Desktop':win?[path.join(local,'Programs','Claude','Claude.exe'),path.join(local,'AnthropicClaude','Claude.exe')]:process.platform==='darwin'?['/Applications/Claude.app',path.join(home,'Applications','Claude.app')]:[path.join(home,'.local','share','applications','claude-desktop.desktop')]
  };
  for(const [label,candidates] of Object.entries(desktopCandidates)){for(const candidate of candidates){try{await fs.access(candidate);tools.push({label,kind:'desktop',path:candidate,description:candidate});break;}catch{}}}
  const picks=tools.map(t=>({label:`${t.label}  ·  ${t.kind==='cli'?'CLI':'desktop app'}`,description:t.description,tool:t}));
  if(!picks.length)return;
  const selected=await vscode.window.showQuickPick(picks,{placeHolder:'Detected local AI tools — choose one to open'});if(!selected)return;
  const tool=selected.tool;
  if(tool.kind==='cli'){requireTrustedWorkspace('launching a local AI command-line tool');const terminal=vscode.window.createTerminal({name:`Cude · ${tool.label}`,cwd:root()});terminal.show();terminal.sendText(tool.command||'',true);return;}
  if(!tool.path)return;
  if(process.platform==='darwin'&&tool.path.endsWith('.app')){const child=spawn('open',['-a',tool.path],{detached:true,stdio:'ignore'});child.unref();return;}
  if(process.platform==='linux'&&tool.path.endsWith('.desktop')){const child=spawn('gtk-launch',[path.basename(tool.path,'.desktop')],{detached:true,stdio:'ignore'});child.unref();return;}
  const child=spawn(tool.path,[],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
}

async function browseModelCatalog(gateway:Gateway){
  const snapshot=await gateway.catalogSnapshot(),quickPick=vscode.window.createQuickPick<{label:string;description:string;detail?:string;record:ModelRecord}>();quickPick.title=`Model catalog · ${snapshot.models.length.toLocaleString()} models · ${snapshot.providers.length.toLocaleString()} providers`;quickPick.placeholder='Search model or provider';quickPick.matchOnDescription=true;quickPick.matchOnDetail=true;
  const profiles=gateway.chatModelState().providers;const update=(query:string)=>{const normalized=query.trim().toLowerCase(),matches=snapshot.models.filter(item=>!gateway.isCatalogModelDisabled(item,profiles)&&(!normalized||`${item.name} ${item.modelId} ${item.provider}`.toLowerCase().includes(normalized))).slice(0,100);quickPick.items=matches.map(record=>({label:record.name,description:`${record.provider} · ${record.contextLength?record.contextLength.toLocaleString()+' ctx':'context n/a'}${record.promptCost?` · $${record.promptCost}/M`:''}`,detail:[record.reasoning?'Reasoning':'',record.toolCall?'Tools':'',record.vision?'Vision':'',record.category].filter(Boolean).join(' · '),record}));};update('');quickPick.onDidChangeValue(update);quickPick.onDidAccept(async()=>{const item=quickPick.selectedItems[0];if(!item)return;const record=item.record,profile=profiles.find(value=>value.id===record.providerId||value.provider===record.providerId||value.baseUrl===record.baseUrl);if(!profile){quickPick.hide();const action=await vscode.window.showInformationMessage(`${record.provider} is in the catalog. Connect it before selecting ${record.modelId}.`,'Open provider settings');if(action)await gateway.configure();return;}await gateway.selectModel(profile.id,record.modelId);quickPick.hide();});quickPick.onDidHide(()=>quickPick.dispose());quickPick.show();
}

export async function makeSpec(gateway:Gateway,goal:string){const d=path.join(await ensureCudeDir(),'specs');await assertRealPathInside(root()!,d);await fs.mkdir(d,{recursive:true});const name=goal.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50)||'project-spec';const context=await projectContext();const spec=await gateway.chat([{role:'system',content:'You are Cude AI. Create a concise Markdown software spec with exactly these sections: # Requirements, # Design, # Tasks. Requirements are testable. Design describes original architecture and key choices. Tasks are actionable unchecked markdown checkboxes. Mention assumptions and preserve any reference project license/attribution. Refuse cheats, malware, credential theft, evasion and unauthorized access; offer safe alternatives.'},{role:'user',content:`Project goal: ${goal}\n\nProject context:\n${context.slice(0,30000)}`}]);const file=path.join(d,`${new Date().toISOString().slice(0,10)}-${name}.md`);await assertRealPathInside(root()!,file);await fs.writeFile(file,spec,'utf8');const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(file));await vscode.window.showTextDocument(doc);return file;}

async function addMcpAgentTools(){requireTrustedWorkspace('adding MCP tools');const r=root();if(!r)throw new Error(tr('errors.openProjectFolder'));const dir=await ensureCudeDir(),file=path.join(dir,'mcp.json');await assertRealPathInside(r,file);const cfg=await readMcpConfig(false)??{mcpServers:{}};
  const items:Array<vscode.QuickPickItem&{id:string}>=[{id:'browser',label:tr('mcp.preset.browser'),description:'npx @playwright/mcp · Microsoft Edge',picked:true},{id:'claude',label:tr('mcp.preset.claude'),description:'~/.claude.json'}];
  const picked=await vscode.window.showQuickPick(items,{canPickMany:true,title:tr('mcp.preset.title')});if(!picked?.length)return;let added=0;
  for(const item of picked){if(item.id==='browser'&&!Object.hasOwn(cfg.mcpServers,'browser')){cfg.mcpServers.browser={command:'npx',args:['-y','@playwright/mcp@0.0.86','--browser','msedge','--isolated','--output-dir',path.join(dir,'playwright')]};added++;}
    if(item.id==='claude'){try{const source=path.join(os.homedir(),'.claude.json');if((await fs.stat(source)).size>2_000_000)throw new Error('Claude configuration is too large.');const raw=JSON.parse(await fs.readFile(source,'utf8'));for(const [name,server] of Object.entries<any>(raw?.mcpServers||{})){if(!/^[A-Za-z0-9_.-]{1,64}$/.test(name)||cfg.mcpServers[name])continue;if(typeof server?.command==='string'){
          // Import only commands that have no free-form arguments or literal credentials.
          const args=server.args??[];
          if(!Array.isArray(args))continue;
          const packageOnly=/^npx(?:\.cmd|\.exe)?$/i.test(server.command)&&args.length===2&&args[0]==='-y'&&typeof args[1]==='string'&&/^@[a-z0-9-]+\/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+$/i.test(args[1]);
          if(!packageOnly&&(args.length||!/^[a-z][a-z0-9-]{0,63}(?:\.exe)?$/i.test(server.command)))continue;
          try{cfg.mcpServers[name]=validateMcpCommand({command:server.command,args});}catch{continue;}
        }else if(typeof server?.url==='string'){
          try{
            const url=new URL(validateProviderBase(server.url));
            if(url.protocol!=='https:'||url.search||url.hash||url.pathname.replace(/\/+$/,'')!=='/mcp')continue;
            cfg.mcpServers[name]={url:url.href};
          }catch{continue;}
        }else continue;added++;}}catch{vscode.window.showWarningMessage(tr('mcp.preset.claudeMissing'));}}}
  if(added){await assertRealPathInside(r,file);await writeMcpProjectFile(file,JSON.stringify(cfg,null,2));}vscode.window.showInformationMessage(tr('mcp.preset.added',{count:added}));}
async function writeMcpProjectFile(file:string,contents:string){
  const temporary=file+'.'+randomBytes(12).toString('hex')+'.tmp';
  try{await fs.writeFile(temporary,contents,{encoding:'utf8',flag:'wx',mode:0o600});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true}).catch(()=>undefined);}
}
async function loopMcpCall(serverName:string,toolName:string,args:Record<string,unknown>):Promise<string>{const cfg=await readMcpConfig();const server=Object.hasOwn(cfg?.mcpServers??{},serverName)?cfg!.mcpServers[serverName]:undefined;if(!server)return `MCP server ${serverName} is not configured.`;const ok=await vscode.window.showWarningMessage(tr('agent.mcpConfirm',{tool:`${serverName}.${toolName}`}),{modal:true,detail:reviewMcpArguments(args)},tr('agent.mcpRun'));if(ok!==tr('agent.mcpRun'))return 'The user declined this MCP call.';if(server.url&&!await approveMcpConnection(serverName,server))return 'The user declined to connect to the MCP server.';const call=async(request:(method:string,params:any)=>Promise<any>)=>{const live=await request('tools/list',{});if(!Array.isArray(live?.tools)||!live.tools.some((tool:any)=>tool?.name===toolName))throw new Error(`Unknown MCP tool ${toolName}`);return request('tools/call',{name:toolName,arguments:args});};const result:any=server.url?await withHttpMcp(server,call):await withPersistentStdioMcp(serverName,server,call);return (Array.isArray(result?.content)?result.content:[]).map((item:any)=>item?.type==='text'?String(item.text||''):item?.type==='image'?'[image]':JSON.stringify(item)).join('\n')||JSON.stringify(result);}
async function agentMcpTools(workspace:string):Promise<Array<{server:string;name:string;description:string;inputSchema?:any}>>{try{if(!workspace)return[];const file=path.join(workspace,'.cude','mcp-tools.json');await assertRealPathInside(workspace,file);if((await fs.stat(file)).size>2_000_000)return[];const text=(await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'');const data=JSON.parse(text);return(Array.isArray(data?.tools)?data.tools:[]).filter((t:any)=>t&&typeof t.server==='string'&&typeof t.name==='string').slice(0,60);}catch{return[];}}
async function readMcpConfig(create=true){const r=root();if(!r)throw new Error(tr('errors.openProjectFolder'));const file=path.join(r,'.cude','mcp.json');try{await assertRealPathInside(r,file);const stat=await fs.stat(file);if(stat.size>131072)throw new Error('MCP configuration is too large.');const text=(await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'');if(Buffer.byteLength(text)>131072)throw new Error('MCP configuration is too large.');let parsed:any;try{parsed=JSON.parse(text);}catch{throw new Error('Invalid JSON in .cude/mcp.json.');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!parsed.mcpServers||typeof parsed.mcpServers!=='object'||Array.isArray(parsed.mcpServers))throw new Error('.cude/mcp.json must contain an object named mcpServers.');return parsed;}catch(error:any){if(error?.code!=='ENOENT')throw error;if(!create)return null;const d=await ensureCudeDir();await fs.mkdir(d,{recursive:true});await fs.writeFile(file,JSON.stringify({mcpServers:{}},null,2),{flag:'wx',mode:0o600});await vscode.window.showTextDocument(vscode.Uri.file(file));vscode.window.showInformationMessage('Created .cude/mcp.json. Add servers with {"command":"...","args":[]} (stdio) or {"url":"https://...","headers":{}} (HTTP).');return null;}}
async function inspectMcp(){requireTrustedWorkspace('connecting to configured MCP servers');const cfg=await readMcpConfig();if(!cfg)return;const servers=Object.entries<any>(cfg.mcpServers||{}).slice(0,32);if(!servers.length){vscode.window.showInformationMessage('No MCP servers configured in .cude/mcp.json.');return;}const list:string[]=[],catalog:any[]=[];
  for(const [name,raw] of servers){
    try{
      const invocation=raw?.url===undefined?mcpInvocation(raw):undefined;
      if(!await approveMcpConnection(name,raw,invocation)){list.push(name+': cancelled');continue;}
      const listTools=(request:(method:string,params:any)=>Promise<any>)=>request('tools/list',{});
      const result=raw.url?await withHttpMcp(raw,listTools):await withStdioMcp(raw,listTools,invocation);
      const tools=Array.isArray(result?.tools)?result.tools.slice(0,100):[];
      for(const tool of tools){const schema=tool?.inputSchema&&JSON.stringify(tool.inputSchema).length<4000?tool.inputSchema:undefined;catalog.push({server:name,name:String(tool?.name||'').slice(0,120),description:String(tool?.description||'').slice(0,300),inputSchema:schema});}
      list.push(name+': '+(tools.map((tool:any)=>String(tool?.name||'').slice(0,120)).join(', ')||'connected; no tools'));
    }catch(error:any){list.push(name+': ERROR '+String(error?.message||error));}
  }
  try{const dir=await ensureCudeDir();const output=path.join(dir,'mcp-tools.json');await assertRealPathInside(root()!,output);await writeMcpProjectFile(output,JSON.stringify({updatedAt:new Date().toISOString(),tools:catalog},null,2));}catch{}
  const doc=await vscode.workspace.openTextDocument({language:'markdown',content:`# MCP servers\n\n${list.map(s=>`- ${s}`).join('\n')}\n\nConfigured servers are inspected without running any returned tools.`});await vscode.window.showTextDocument(doc);}
export async function mcpCall(){requireTrustedWorkspace('calling an MCP tool');const cfg=await readMcpConfig();if(!cfg)return;const servers=Object.entries(cfg.mcpServers||{}) as Array<[string,any]>;if(!servers.length)throw new Error('No MCP servers configured.');const serverPick=await vscode.window.showQuickPick<{label:string;description:string}>(servers.map(([name])=>({label:name,description:'MCP server'})),{placeHolder:'Select a configured MCP server'});if(!serverPick)return;const server=servers.find(([name])=>name===serverPick.label)![1];const invocation=server?.url===undefined?mcpInvocation(server):undefined;if(!await approveMcpConnection(serverPick.label,server,invocation))return;const run=async(request:(method:string,params:any)=>Promise<any>)=>{const tools=(await request('tools/list',{}))?.tools||[];if(!tools.length)throw new Error('The selected MCP server exposes no tools.');const tool=await vscode.window.showQuickPick<{label:string;description:string}>(tools.map((item:any)=>({label:item.name,description:item.description||''})),{placeHolder:'Select an MCP tool'});if(!tool)return null;const raw=await vscode.window.showInputBox({prompt:`Arguments for ${tool.label} as a JSON object`,value:'{}',validateInput:value=>{try{if(Buffer.byteLength(value)>32768)return 'MCP arguments are too large.';const args=JSON.parse(value);return args&&typeof args==='object'&&!Array.isArray(args)?undefined:'Enter a JSON object.';}catch{return 'Enter valid JSON.';}}});if(raw===undefined)return null;if(Buffer.byteLength(raw)>32768)throw Error('MCP arguments are too large.');const args=JSON.parse(raw),confirmed=await vscode.window.showWarningMessage(`Run MCP tool ${serverPick.label}.${tool.label}? Review its arguments and side effects first.`,{modal:true,detail:reviewMcpArguments(args)},'Run once');if(confirmed!=='Run once')return null;const result=await request('tools/call',{name:tool.label,arguments:args});return{tool:tool.label,result};};const called=server.url?await withHttpMcp(server,run):await withStdioMcp(server,run,invocation);if(!called)return;const content=(called.result?.content||[]).map((item:any)=>item.text||JSON.stringify(item)).join('\n')||JSON.stringify(called.result,null,2);const doc=await vscode.workspace.openTextDocument({language:'markdown',content:`# MCP · ${serverPick.label}.${called.tool}\n\n${content}`});await vscode.window.showTextDocument(doc);}
function resolveMcpSpawn(command:string,args:string[]):{command:string;args:string[]}{
  if(process.platform!=='win32')return{command,args};
  const explicit=path.isAbsolute(command)||/[\\/]/.test(command);
  const dirs=String(process.env.PATH||process.env.Path||'').split(path.delimiter).filter(dir=>path.isAbsolute(dir));
  const names=path.extname(command)?[command]:[command+'.exe',command+'.cmd'];
  const candidates=explicit?names.map(name=>path.resolve(root()||process.cwd(),name)):dirs.flatMap(dir=>names.map(name=>path.join(dir,name)));
  for(const full of candidates){
    if(!/\.(exe|cmd)$/i.test(full))continue;
    try{if(!fsSync.statSync(full).isFile())continue;}catch{continue;}
    if(full.toLowerCase().endsWith('.cmd'))return resolveLocalCliInvocation({id:'opencode-cli',name:command,bin:command,model:'',path:full} as LocalCli,args);
    return{command:full,args};
  }
  throw new Error('MCP executable was not found in an absolute PATH directory or at the configured location.');
}
function validateMcpCommand(server:any){
  if(typeof server?.command!=='string'||!server.command.trim()||server.command.length>4096||
    /[\r\n\t]/.test(server.command)||hasHiddenCommandCharacters(server.command))throw new Error('Invalid MCP command.');
  const args=server.args??[];
  if(!Array.isArray(args)||args.length>100||args.some((value:unknown)=>typeof value!=='string'||value.length>8192||
    /[\r\n\t]/.test(value)||hasHiddenCommandCharacters(value)))throw new Error('Invalid MCP command arguments.');
  return {command:server.command,args:args as string[]};
}

function mcpInvocation(server:any){
  const {command,args}=validateMcpCommand(server);
  return resolveMcpSpawn(command,args);
}

async function approveMcpConnection(name:string,server:any,invocation?:{command:string;args:string[]}):Promise<boolean>{
  if(!server||typeof server!=='object')throw new Error('Invalid MCP server entry.');
  if(server.url!==undefined){
    const url=validateProviderBase(server.url), headers=configuredMcpHeaders(server.headers);
    const detail='Server: '+JSON.stringify(name)+'\nDestination: '+url+'\nConfigured headers: '+(Object.keys(headers).join(', ')||'none');
    return await vscode.window.showWarningMessage('Connect to configured MCP server?',{modal:true,detail},'Connect once')==='Connect once';
  }
  const {command,args}=invocation??mcpInvocation(server);
  mcpEnvironment(server.env);
  const names=Object.keys(server.env??{});
  const argv=JSON.stringify([command,...args]);
  if(argv.length>4000)throw new Error('MCP invocation exceeds the size that can be reviewed.');
  const detail='Executable and arguments: '+argv+'\nWorking folder: '+root()+
    '\nConfigured environment names: '+(names.join(', ')||'none')+'\nThis local process runs with your account permissions.';
  return await vscode.window.showWarningMessage('Start configured MCP process?',{modal:true,detail},'Start once')==='Start once';
}

export function reviewMcpArguments(value:unknown):string{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MCP arguments must be a JSON object.');
  const review=JSON.stringify(value,null,2).replace(/[\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  if(review.length>4000)throw new Error('MCP arguments exceed the size that can be reviewed.');
  return review;
}

function parseMcpResponse(text:string,id:number){
  const data=text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(line=>line&&line!=='[DONE]');
  for(const value of data.length?data:[text]){
    let message:any;try{message=JSON.parse(value);}catch{continue;}
    if(message?.jsonrpc==='2.0'&&message.id===id)return message;
  }
  throw new Error('Invalid MCP response.');
}

export async function withHttpMcp<T>(server:any,run:(request:(method:string,params:any)=>Promise<any>)=>Promise<T>):Promise<T>{
  const url=validateProviderBase(server.url),custom=configuredMcpHeaders(server.headers);
  const protocolVersion='2025-03-26';
  let session='',id=0;
  const post=async(message:object)=>{
    const headers:Record<string,string>={...custom,'content-type':'application/json','accept':'application/json, text/event-stream','mcp-protocol-version':protocolVersion};
    if(session)headers['mcp-session-id']=session;
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(message),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok){
      await response.body?.cancel().catch(()=>{});
      throw new Error('MCP HTTP '+response.status);
    }
    const received=response.headers.get('mcp-session-id');
    if(received!==null){
      if(received.length>256||!/^[!-~]+$/.test(received)){await response.body?.cancel().catch(()=>{});throw Error('Invalid MCP session id.');}
      session=received;
    }
    return response;
  };
  const request=async(method:string,params:any)=>{
    const requestId=++id;
    const response=await post({jsonrpc:'2.0',id:requestId,method,params});
    const result=parseMcpResponse(await boundedMcpBody(response),requestId);
    if(result.error)throw new Error('MCP server rejected the request.');
    return result.result;
  };
  const initialized=await request('initialize',{protocolVersion,capabilities:{},clientInfo:{name:'Cude IDE',version:'0.1.0'}});
  if(initialized?.protocolVersion!==protocolVersion)throw new Error('MCP protocol version is unsupported.');
  const ready=await post({jsonrpc:'2.0',method:'notifications/initialized'});
  await ready.body?.cancel();
  return run(request);
}
type McpSession={request:(method:string,params:any)=>Promise<any>;close:()=>Promise<void>;closed:()=>boolean};
/** Starts a stdio MCP server, completes the initialize handshake and returns a request function with per-request time limits. */
async function openStdioMcpSession(server:any,invocation=mcpInvocation(server)):Promise<McpSession>{
  const validated=validateMcpCommand(server),{command,args}=invocation;
  const legacy=server.framing==='content-length';
  const env=mcpEnvironment(server.env);
  const slow=/(^|[\\/])(npx|uvx|pnpm|bunx)(\.cmd|\.exe)?$/i.test(validated.command);
  const child=spawn(command,args,{cwd:root(),env,stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true});
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let buffer:Buffer=Buffer.alloc(0),lastId=0,closed=false;
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  const fail=(error:Error,terminate=true)=>{
    if(closed)return;
    closed=true;
    for(const item of pending.values())item.reject(error);
    pending.clear();
    if(terminate)child.kill();
  };
  const send=(value:object)=>{
    const json=JSON.stringify(value);
    child.stdin.write(legacy?'Content-Length: '+Buffer.byteLength(json)+'\r\n\r\n'+json:json+'\n');
  };
  const request=(method:string,params:any,timeoutMs=slow?120000:60000)=>new Promise<any>((resolve,reject)=>{
    if(closed)return reject(new Error('MCP process closed.'));
    const id=++lastId;
    if(pending.size>=16)return reject(new Error('MCP process is busy.'));
    const timer=setTimeout(()=>fail(new Error('MCP request timed out.')),timeoutMs);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    send({jsonrpc:'2.0',id,method,params});
  });
  child.on('error',()=>fail(new Error('Could not start MCP process.')));
  child.on('exit',()=>fail(new Error('MCP process exited before replying.')));
  child.stdin.on('error',()=>fail(new Error('MCP connection closed.')));
  child.stdout.on('data',(chunk:Buffer)=>{
    if(closed)return;
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>2_000_000){fail(new Error('MCP message exceeded its limit.'));return;}
    while(buffer.length){
      const boundary=buffer.indexOf(legacy?'\r\n\r\n':'\n');
      if(boundary<0)return;
      let payload:Buffer;
      if(legacy){
        const len=Number(buffer.subarray(0,boundary).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
        if(!Number.isSafeInteger(len)||len<1||len>2_000_000){fail(new Error('Invalid MCP frame.'));return;}
        const start=boundary+4;
        if(buffer.length<start+len)return;
        payload=buffer.subarray(start,start+len);
        buffer=buffer.subarray(start+len);
      }else{
        payload=buffer.subarray(0,boundary);
        buffer=buffer.subarray(boundary+1);
      }
      if(!payload.toString().trim())continue;
      let message:any;
      try{message=JSON.parse(payload.toString());}catch{fail(new Error('Invalid MCP JSON message.'));return;}
      if(!message||message.jsonrpc!=='2.0'||message.id===undefined)continue;
      if(typeof message.method==='string'){
        send(message.method==='ping'?{jsonrpc:'2.0',id:message.id,result:{}}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client method unavailable'}});
        continue;
      }
      const item=pending.get(message.id);
      if(!item)continue;
      pending.delete(message.id);
      if(message.error)item.reject(new Error('MCP server rejected the request.'));
      else item.resolve(message.result);
    }
  });
  const close=async()=>{
    fail(new Error('MCP session closed.'),false);
    child.stdin.end();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 1500); })]); }
    finally { if(closeTimer)clearTimeout(closeTimer); if(child.exitCode===null&&child.signalCode===null)child.kill(); }
  };
  try{
    const initialized=await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Cude IDE',version:'0.1.0'}},slow?120000:20000);
    if(initialized?.protocolVersion!=='2025-03-26')throw new Error('MCP protocol version is unsupported.');
    send({jsonrpc:'2.0',method:'notifications/initialized'});
  }catch(error){await close();throw error;}
  return{request:(method,params)=>request(method,params),close,closed:()=>closed};
}
async function withStdioMcp<T>(server:any,run:(request:(method:string,params:any)=>Promise<any>)=>Promise<T>,invocation?:{command:string;args:string[]}):Promise<T>{
  const session=await openStdioMcpSession(server,invocation);
  try{return await run(session.request);}finally{await session.close();}
}
// Agent MCP steps reuse one live session per server for 10 idle minutes, so a browser keeps its page between steps.
type PersistentMcp = { opening:Promise<McpSession>; timer?:ReturnType<typeof setTimeout>; active:number };
const persistentMcp=new Map<string,PersistentMcp>();
const MCP_IDLE_MS=10*60*1000;
async function withPersistentStdioMcp<T>(name:string,server:any,run:(request:(method:string,params:any)=>Promise<any>)=>Promise<T>):Promise<T>{
  const invocation=mcpInvocation(server);
  const key=createHash('sha256').update(JSON.stringify([root(),name,invocation,server.framing,mcpEnvironment(server.env)])).digest('hex');
  let entry=persistentMcp.get(key);
  if(entry&&(await entry.opening).closed()){
    if(entry.timer)clearTimeout(entry.timer);
    if(persistentMcp.get(key)===entry)persistentMcp.delete(key);
    entry=persistentMcp.get(key);
  }
  if(!entry){
    if(persistentMcp.size>=8)throw new Error('Too many open MCP sessions.');
    const opening=(async()=>{
      if(!await approveMcpConnection(name,server,invocation))throw new Error('MCP connection was cancelled.');
      return openStdioMcpSession(server,invocation);
    })();
    entry={opening,active:0};
    persistentMcp.set(key,entry);
  }
  const current=entry;
  current.active++;
  if(current.timer)clearTimeout(current.timer);
  try{
    const session=await current.opening;
    return await run(session.request);
  }catch(error){
    if(await current.opening.then(session=>session.closed(),()=>true)){
      if(persistentMcp.get(key)===current)persistentMcp.delete(key);
    }
    throw error;
  }finally{
    current.active--;
    if(current.active===0&&persistentMcp.get(key)===current){
      current.timer=setTimeout(()=>{
        persistentMcp.delete(key);
        void current.opening.then(session=>session.close(),()=>undefined);
      },MCP_IDLE_MS);
      current.timer.unref();
    }
  }
}
async function closePersistentMcp(){
  const entries=[...persistentMcp.values()];
  persistentMcp.clear();
  await Promise.allSettled(entries.map(entry=>{
    if(entry.timer)clearTimeout(entry.timer);
    return entry.opening.then(session=>session.close());
  }));
}

export async function deactivate(){try{opencodeServer?.stop();}catch{}
  await stopHeartbeat();
  cancelRecording();
  stopSpeaking();
  await closePersistentMcp();
}

import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { t, type Language, type MessageKey } from './i18n';

let localModelsLanguage:Language='en';
/** Sets the UI language used for user-visible errors thrown by this module. */
export function setLocalModelsLanguage(language:Language){localModelsLanguage=language;}
const lt=(key:MessageKey,values?:Record<string,string|number>)=>t(key,localModelsLanguage,values);

export type LocalModelFile={name:string;size:number;sha256?:string;url:string;license:string;downloads:number;repo:string;fits:boolean;recommended:boolean};
export type HuggingFaceModel={id:string;license:string;downloads:number;likes:number;updated:string;files:LocalModelFile[];description:string;detailsPending?:boolean};
export type DeviceProfile={ramBytes:number;vramBytes:number;cpuCores:number;usableBytes:number;gpu:string};

let deviceCache:{at:number;value:DeviceProfile}|undefined;
export function detectDevice():DeviceProfile{if(deviceCache&&Date.now()-deviceCache.at<600000)return deviceCache.value;const value=detectDeviceNow();deviceCache={at:Date.now(),value};return value;}
function detectDeviceNow():DeviceProfile{
  let vramBytes=0,gpu='CPU';try{const text=execFileSync('nvidia-smi',['--query-gpu=name,memory.total','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true,timeout:2500}).trim().split(/\r?\n/)[0];const match=text.match(/^(.+?),\s*(\d+)/);if(match){gpu=match[1].trim();vramBytes=Number(match[2])*1024*1024;}}catch{}
  const ramBytes=os.totalmem(),usableBytes=Math.max(0,ramBytes+vramBytes-2*1024**3);return{ramBytes,vramBytes,cpuCores:os.cpus().length,usableBytes,gpu};
}

export async function searchHuggingFace(query:string,device=detectDevice()):Promise<HuggingFaceModel[]>{
  const url=new URL('https://huggingface.co/api/models');url.searchParams.set('search',query.trim().slice(0,120));url.searchParams.set('filter','gguf');url.searchParams.set('sort','downloads');url.searchParams.set('direction','-1');url.searchParams.set('limit','12');
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});if(!response.ok)throw new Error(lt('local.err.searchFailed',{status:response.status}));const rows=await response.json() as any[];
  return rows.map((row:any)=>({id:String(row.id||row.modelId||''),license:String((row.tags||[]).find((tag:string)=>tag.startsWith('license:'))?.slice(8)||'Unspecified'),downloads:Number(row.downloads||0),likes:Number(row.likes||0),updated:String(row.lastModified||row.createdAt||''),files:[],detailsPending:true,description:String(row.pipeline_tag||'GGUF model')})).filter((row:HuggingFaceModel)=>!!row.id);
}

// owner/name with no "." or ".." segments, so the reference cannot climb out of /api/models/.
export function isValidHuggingFaceRepo(repo:string){return /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/.test(repo)&&repo.split('/').every(part=>part!=='.'&&part!=='..');}
const MAX_UNKNOWN_MODEL_BYTES=64*1024**3;
export async function inspectHuggingFaceModel(repo:string,device=detectDevice()):Promise<HuggingFaceModel>{
  if(!isValidHuggingFaceRepo(repo))throw new Error(lt('local.err.badRepo'));
  const response=await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`,{signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});if(!response.ok)throw new Error(lt('local.err.filesFailed',{status:response.status}));const row:any=await response.json(),license=String(row.cardData?.license||(row.tags||[]).find((tag:string)=>tag.startsWith('license:'))?.slice(8)||'Unspecified');
  const files=(row.siblings||[]).filter((item:any)=>typeof item.rfilename==='string'&&item.rfilename.toLowerCase().endsWith('.gguf')).map((item:any)=>{const size=Number(item.lfs?.size||item.size||0),fits=size>0&&size<=device.usableBytes,recommended=fits&&size<=Math.max(0,device.usableBytes*.72);return{name:item.rfilename,size,sha256:item.lfs?.sha256,url:`https://huggingface.co/${row.id}/resolve/main/${item.rfilename.split('/').map(encodeURIComponent).join('/')}?download=true`,license,downloads:Number(row.downloads||0),repo:String(row.id),fits,recommended};}).sort((a:LocalModelFile,b:LocalModelFile)=>Number(b.recommended)-Number(a.recommended)||a.size-b.size);
  if(!files.length)throw new Error(lt('local.err.noGguf'));return{id:String(row.id),license,downloads:Number(row.downloads||0),likes:Number(row.likes||0),updated:String(row.lastModified||''),files,detailsPending:false,description:String(row.cardData?.pipeline_tag||row.cardData?.library_name||'GGUF model')};
}

export function recommendedLocalModels(device=detectDevice()):HuggingFaceModel[]{
  const presets:Array<{id:string;license:string;downloads:number;description:string;file:string;size:number;sha256:string;minimumMemory:number}>=[
    {id:'emrevrg/Norovox-N1-0.5B-GGUF',license:'apache-2.0',downloads:0,description:'Norovox N1 0.5B · Q4_K_M · 469 MiB',file:'Norovox-N1-0.5B-Q4_K_M.gguf',size:491400032,sha256:'74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',minimumMemory:1*1024**3},
    {id:'emrevrg/Norovox-N1-1.5B-GGUF',license:'apache-2.0',downloads:0,description:'Norovox N1 1.5B · Q4_K_M · 1.04 GiB',file:'Norovox-N1-1.5B-Q4_K_M.gguf',size:1117320736,sha256:'6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',minimumMemory:2*1024**3},
    {id:'emrevrg/Norovox-N1-7B-GGUF',license:'apache-2.0',downloads:0,description:'Norovox N1 7B · Q4_K_M · 4.36 GiB',file:'Norovox-N1-7B-Q4_K_M.gguf',size:4683074240,sha256:'65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',minimumMemory:7*1024**3},
    {id:'Qwen/Qwen2.5-0.5B-Instruct-GGUF',license:'apache-2.0',downloads:0,description:'Compact general assistant · Q4_0 · 409 MiB',file:'qwen2.5-0.5b-instruct-q4_0.gguf',size:428730208,sha256:'7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed',minimumMemory:768*1024**2},
    {id:'bartowski/SmolLM2-360M-Instruct-GGUF',license:'apache-2.0',downloads:0,description:'Smallest footprint · Q4_0 · 219 MiB',file:'SmolLM2-360M-Instruct-Q4_0.gguf',size:229733280,sha256:'c3608933eb6e5763b87f769bda40c204dc158333668c7af214644fe39da58627',minimumMemory:512*1024**2},
    {id:'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',license:'apache-2.0',downloads:0,description:'Code-focused assistant · Q4_0 · 1017 MiB',file:'qwen2.5-coder-1.5b-instruct-q4_0.gguf',size:1066227264,sha256:'aa8353e0d0fca3a0041828701e90db7635197400f040676d11d7798665fa316e',minimumMemory:2*1024**3}
  ];
  const ranked=presets.filter(model=>model.minimumMemory<=device.usableBytes).sort((a,b)=>Number(b.id.includes('Norovox-N1'))-Number(a.id.includes('Norovox-N1'))||b.size-a.size).map(model=>{const fits=model.size<=device.usableBytes;const file:LocalModelFile={name:model.file,size:model.size,sha256:model.sha256,url:`https://huggingface.co/${model.id}/resolve/main/${encodeURIComponent(model.file)}?download=true`,license:model.license,downloads:model.downloads,repo:model.id,fits,recommended:fits};return{id:model.id,license:model.license,downloads:model.downloads,likes:0,updated:'',files:[file],detailsPending:false,description:model.description};});
  const newer=[{id:'Qwen/Qwen3-4B-GGUF',minimum:6*1024**3},{id:'Qwen/Qwen3-8B-GGUF',minimum:10*1024**3}].filter(m=>m.minimum<=device.usableBytes).sort((a,b)=>b.minimum-a.minimum).map(m=>({id:m.id,license:'apache-2.0',downloads:0,likes:0,updated:'',files:[],detailsPending:true,description:'Qwen3 · Q4_K_M · '+(device.vramBytes>=m.minimum?'GPU':'RAM') }));
  return [...ranked.filter(m=>m.id.includes('Norovox-N1')),...newer,...ranked.filter(m=>!m.id.includes('Norovox-N1'))];
}

export async function resolveHuggingFaceFile(repo:string,name:string):Promise<LocalModelFile>{
  if(!isValidHuggingFaceRepo(repo)||name.includes('..')||path.isAbsolute(name)||name.split(/[\\/]/).some(part=>!part||part==='..'))throw new Error(lt('local.err.badFile'));
  const response=await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`,{signal:AbortSignal.timeout(20000),headers:{accept:'application/json'}});if(!response.ok)throw new Error(lt('local.err.metadataFailed',{status:response.status}));const data:any=await response.json(),file=(data.siblings||[]).find((entry:any)=>entry.rfilename===name);if(!file||!name.toLowerCase().endsWith('.gguf'))throw new Error(lt('local.err.fileMissing'));
  return{name:file.rfilename,size:Number(file.lfs?.size||file.size||0),sha256:file.lfs?.sha256,url:`https://huggingface.co/${repo}/resolve/main/${file.rfilename.split('/').map(encodeURIComponent).join('/')}?download=true`,license:String(data.cardData?.license||'Unspecified'),downloads:Number(data.downloads||0),repo,fits:true,recommended:true};
}

export async function listDownloadedModels(directory:string){const rows=[] as Array<{name:string;path:string;size:number}>;const visit=async(folder:string,depth:number)=>{let files;try{files=await fs.readdir(folder,{withFileTypes:true});}catch{return;}for(const file of files){if(file.name.startsWith('.')||file.name.endsWith('.part'))continue;const full=path.join(folder,file.name);if(file.isFile()&&file.name.toLowerCase().endsWith('.gguf')){try{const stat=await fs.stat(full);rows.push({name:file.name,path:full,size:stat.size});}catch{}}else if(file.isDirectory()&&depth<3)await visit(full,depth+1);}};await visit(directory,0);return rows.sort((a,b)=>a.name.localeCompare(b.name));}

export async function listDownloadedModelsFromRoots(directories:string[]){const unique=new Map<string,{name:string;path:string;size:number}>();for(const directory of new Set(directories.filter(Boolean))){for(const file of await listDownloadedModels(directory))unique.set(path.resolve(file.path).toLowerCase(),file);}return[...unique.values()].sort((a,b)=>a.name.localeCompare(b.name));}

export async function downloadHuggingFaceModel(model:LocalModelFile,directory:string,onProgress:(received:number,total:number)=>void,signal:AbortSignal):Promise<string>{
  if(!model.sha256||!/^[a-f0-9]{64}$/i.test(model.sha256))throw new Error('SHA-256 required / SHA-256 gerekli');
  if(!/^https:\/\/huggingface\.co\//i.test(model.url)||!model.repo||!isValidHuggingFaceRepo(model.repo)||path.isAbsolute(model.name)||model.name.split(/[\\/]/).some(part=>part==='..'))throw new Error(lt('local.err.unsafeRef'));
  await fs.mkdir(directory,{recursive:true});const modelStem=model.repo.split('/').pop()||'model',repoHash=createHash('sha1').update(model.repo).digest('hex').slice(0,6),name=`${modelStem.slice(0,48)}-${repoHash}-${path.basename(model.name)}`,destination=path.join(directory,name),partial=`${destination}.part`;try{const existing=await fs.stat(destination);if(existing.isFile()&&(!model.size||existing.size===model.size)){const hash=createHash('sha256');for await(const chunk of createReadStream(destination))hash.update(chunk);if(hash.digest('hex').toLowerCase()===model.sha256.toLowerCase())return destination;}}catch{}let received=0;try{received=(await fs.stat(partial)).size;}catch{}
  const headers:Record<string,string>={};if(received)headers.range=`bytes=${received}-`;const response=await fetch(model.url,{headers,signal,redirect:'follow'});if(!(response.ok||response.status===206))throw new Error(lt('local.err.downloadFailed',{status:response.status}));if(response.url&&!/^https:\/\//i.test(response.url)){try{await response.body?.cancel();}catch{}throw new Error(lt('local.err.insecureRedirect'));}if(received&&response.status!==206){received=0;await fs.writeFile(partial,new Uint8Array());}
  const total=Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]||response.headers.get('content-length')||model.size||0)+(response.status===206?received:0),handle=await fs.open(partial,received?'a':'w');
  try{if(!response.body)throw new Error(lt('local.err.noStream'));const reader=response.body.getReader();while(true){if(signal.aborted)throw new DOMException('Download paused.','AbortError');const {done,value}=await reader.read();if(done)break;await handle.write(value);received+=value.byteLength;if(received>(model.size||MAX_UNKNOWN_MODEL_BYTES))throw new Error(lt('local.err.tooMuchData'));onProgress(received,total);}}finally{await handle.close();}
  const finalSize=(await fs.stat(partial)).size;if(model.size&&finalSize!==model.size)throw new Error(lt('local.err.sizeMismatch',{received:finalSize,expected:model.size}));
  if(model.sha256){const hash=createHash('sha256');for await(const chunk of createReadStream(partial))hash.update(chunk);if(hash.digest('hex').toLowerCase()!==model.sha256.toLowerCase())throw new Error(lt('local.err.shaMismatch'));}
  await fs.rename(partial,destination);return destination;
}


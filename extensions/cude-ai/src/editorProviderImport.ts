import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseJson, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { redactCredentialLiterals } from './security';
import { fetch } from 'undici';

export type EditorProvider = { source:string; name:string; provider:string; baseUrl:string; models:string[]; hasKey:boolean; keyReference:boolean };
// Credentials never appear on the public candidate, in JSON, or in a webview message.
const credentials = new WeakMap<EditorProvider,string>();
const object = (v:any):Record<string,any> => v && typeof v==='object' && !Array.isArray(v) ? v : {};
const reference = (v:string) => /\$\{|\{env:|\{file:|^env:|^process\.env\./i.test(v);
export async function localEditorModels(base:string):Promise<string[]|undefined> {
  if(!['http://127.0.0.1:11434/v1','http://127.0.0.1:1234/v1'].includes(base))return;
  const ollama=base.includes(':11434/');
  const response=await fetch(ollama?base.replace('/v1','/api/tags'):base+'/models',{signal:AbortSignal.timeout(1800),redirect:'error'});
  if(!response.ok||!response.body){await response.body?.cancel();return;}
  const reader=response.body.getReader();let text='';const decoder=new TextDecoder();let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>512_000)return;text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
  finally{await reader.cancel();}
  const data=JSON.parse(text),rows=ollama?data.models:data.data;
  if(!Array.isArray(rows))return;
  return rows.map((m:any)=>ollama?m.name:m.id).filter((m:any)=>typeof m==='string'&&m.length<200).slice(0,300);
}
function endpoint(value:unknown):string|undefined {
  if(typeof value!=='string'||reference(value)||value.length>2048)return;
  try { const url=new URL(value); if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return; return url.toString().replace(/\/+$/,''); } catch { return; }
}
export function parseEditorConfig(text:string,yaml=false):any {
  if(Buffer.byteLength(text)>512_000)throw new Error('Editor configuration exceeds size limit.');
  if(yaml){const doc=parseDocument(text,{uniqueKeys:true});if(doc.errors.length)throw new Error('Invalid editor YAML.');return doc.toJS({maxAliasCount:0});}
  const errors:ParseError[]=[];const value=parseJson(text,errors,{allowTrailingComma:true});
  if(errors.length)throw new Error('Invalid editor JSON.');return value;
}
export function editorConfigFiles(home:string,appData:string,workspace?:string,platform=process.platform):Array<{source:string;file:string}> {
  const result=[
    {source:'Zed',file:path.join(home,'.config','zed','settings.json')},
    {source:'Zed',file:path.join(appData,'Zed','settings.json')},
    ...['yaml','json'].map(ext=>({source:'Continue',file:path.join(home,'.continue','config.'+ext)})),
    ...['jsonc','json'].map(ext=>({source:'OpenCode',file:path.join(home,'.config','opencode','opencode.'+ext)})),
  ];
  if(workspace)for(const ext of ['jsonc','json'])result.push({source:'OpenCode',file:path.join(workspace,'opencode.'+ext)});
  for(const [source,dir] of [['VS Code','Code'],['Cursor','Cursor'],['Windsurf','Windsurf']]) {
    const root=platform==='win32'?appData:platform==='darwin'?path.join(home,'Library','Application Support'):path.join(home,'.config');
    result.push({source,file:path.join(root,dir,'User','settings.json')});
  }
  return result;
}
export function extractEditorProviders(source:string,config:any):EditorProvider[] {
  const found:EditorProvider[]=[];
  const add=(name:string,c:any,defaults?:{url?:string;provider?:string})=>{
    c=object(c);const rawKey=c.apiKey??c.api_key??'';
    const key=typeof rawKey==='string'?rawKey:'';
    const clean=(v:unknown)=>redactCredentialLiterals(String(v??'').split(key||'\u0000').join(key?'[redacted]':'\u0000')).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160);
    let baseUrl=endpoint(c.apiBase??c.baseURL??c.baseUrl??c.api_url??c.url??defaults?.url);if(!baseUrl)return;
    if(key&&!reference(key)&&baseUrl.includes(key))return;
    if(defaults?.provider==='ollama')baseUrl=baseUrl.replace(/\/v1$/,'')+'/v1';
    if(defaults?.provider==='lmstudio'&&!/\/v1$/.test(baseUrl))baseUrl+='/v1';
    const models:any=c.available_models??c.models??(c.model?[c.model]:[]);
    const rows=Array.isArray(models)?models:Object.keys(object(models));
    const candidate:EditorProvider={source,name:clean(c.title??c.name??name),provider:defaults?.provider==='ollama'?'ollama':'openai-compatible',baseUrl,models:[...new Set<string>(rows.map((m:any)=>clean(typeof m==='string'?m:m.id??m.name??m.model)).filter((m:string)=>m&&m!=='AUTODETECT'&&!m.includes('[redacted]')&&!reference(m)))].slice(0,300),hasKey:!!key,keyReference:reference(key)};
    credentials.set(candidate,key&&!candidate.keyReference?key:'');found.push(candidate);
  };
  if(source==='Zed') {
    const lm=object(config?.language_models);
    for(const [name,c] of Object.entries(object(lm.openai_compatible)))add(name,c);
    for(const [id,url] of [['ollama','http://localhost:11434'],['lmstudio','http://localhost:1234/v1']])if(lm[id])add(id,lm[id],{url,provider:id});
  } else if(source==='Continue') {
    for(const m of Array.isArray(config?.models)?config.models:[]) {
      if(!['openai','openai-compatible','ollama','lmstudio'].includes(m?.provider))continue;
      add(m.name??m.title??m.provider,m,{provider:m.provider,url:m.provider==='ollama'?'http://localhost:11434':m.provider==='lmstudio'?'http://localhost:1234/v1':m.provider==='openai'?'https://api.openai.com/v1':undefined});
    }
  } else if(source==='OpenCode') {
    for(const [id,raw] of Object.entries(object(config?.provider??config?.providers))) {
      const c=object(raw),pkg=String(c.npm??c.package??'');
      if(pkg&&!/openai|ollama|lmstudio/i.test(pkg))continue;
      add(id,{...c,...object(c.options??c.settings)});
    }
  } else {
    // Settings extensions have different namespaces. Recognize endpoint-bearing
    // objects and flat <namespace>.baseUrl/apiKey pairs without interpreting code.
    const walk=(v:any,name:string,depth:number)=>{
      if(depth>8)return;
      if(Array.isArray(v)){for(const row of v.slice(0,300))walk(row,name,depth+1);return;}
      const c=object(v);
      if((!c.provider||['openai','openai-compatible','ollama','lmstudio'].includes(c.provider))&&(c.apiBase||c.baseURL||c.baseUrl||c.api_url))add(name,c,{provider:c.provider});
      for(const [k,value] of Object.entries(c)) {
        if(/\.(apiBase|baseURL|baseUrl|api_url)$/.test(k)) {
          const prefix=k.slice(0,k.lastIndexOf('.'));add(prefix,{baseUrl:value,apiKey:c[prefix+'.apiKey']??c[prefix+'.api_key'],models:c[prefix+'.models'],model:c[prefix+'.model']});
        } else if(value&&typeof value==='object')walk(value,k,depth+1);
      }
    };walk(config,source,0);
  }
  return found.slice(0,300);
}

export async function scanEditorProviders(options:{home:string;appData:string;workspace?:string;platform?:NodeJS.Platform;consent:boolean;localModels?:(url:string)=>Promise<string[]|undefined>}):Promise<{providers:EditorProvider[];skipped:number}> {
  if(!options.consent)return {providers:[],skipped:0};
  const providers:EditorProvider[]=[];let skipped=0;
  for(const entry of editorConfigFiles(options.home,options.appData,options.workspace,options.platform)) {
    try {
      const stat=await fs.lstat(entry.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512_000){skipped++;continue;}
      providers.push(...extractEditorProviders(entry.source,parseEditorConfig(await fs.readFile(entry.file,'utf8'),entry.file.endsWith('.yaml'))));
    } catch(error:any){if(error?.code!=='ENOENT')skipped++;}
  }
  if(options.localModels)for(const [name,url,provider] of [['Ollama','http://127.0.0.1:11434/v1','ollama'],['LM Studio','http://127.0.0.1:1234/v1','openai-compatible']]) {
    try{const models=await options.localModels(url);if(models){const candidate:EditorProvider={source:'Local',name,baseUrl:url,provider,models:models.slice(0,300),hasKey:false,keyReference:false};providers.push(candidate);}}catch{/* Local service unavailable. */}
  }
  const seen=new Set<string>();return {providers:providers.filter(p=>{const id=JSON.stringify([p.source,p.name,p.baseUrl,p.models]);if(seen.has(id))return false;seen.add(id);return true;}),skipped};
}

export async function importEditorProviders(options:{scan:()=>Promise<{providers:EditorProvider[];skipped:number}>;allowRead:()=>Promise<boolean>;select:(providers:EditorProvider[])=>Promise<EditorProvider[]>;approve:(p:EditorProvider)=>Promise<boolean>;approveKey:(p:EditorProvider)=>Promise<boolean>;save:(p:EditorProvider,key:string)=>Promise<void>}):Promise<{count:number;skipped:number}> {
  if(!await options.allowRead())return {count:0,skipped:0};
  const {providers,skipped}=await options.scan();let count=0;
  for(const candidate of await options.select(providers)) {
    if(!providers.includes(candidate)||!await options.approve(candidate))continue;
    const key=credentials.get(candidate)||'';
    await options.save(candidate,key&&await options.approveKey(candidate)?key:'');count++;
  }
  return {count,skipped};
}

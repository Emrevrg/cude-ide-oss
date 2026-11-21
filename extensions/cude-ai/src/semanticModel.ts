import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedMcpBody, processEnvironment } from './mcpSecurity';

export const EMBEDDING_DIMENSION = 768;
export const EMBEDDING_MAX_TOKENS = 256;
export const NOROVOX_REPO = 'emrevrg/Norovox-Embed-Zero';
export type SemanticArtifact = {
  file: string; size: number; sha256: string; meanCosine: number; revision: string;
};
// Q8_0 is the default. Both artifacts passed the bundled-runtime parity test.
export const NOROVOX_ARTIFACTS: ReadonlyArray<SemanticArtifact> = [
  {file:'Norovox-Embed-Zero-Q8_0.gguf',size:210271072,
    sha256:'9183276e264931b5596b74afea1799064526157183c7476f5bfe3b8d57a05370',meanCosine:0.9998997188079977,revision:'5f60ee96d0b302bb904f92bab808354d33b6dc4a'},
  {file:'Norovox-Embed-Zero-F16.gguf',size:390443872,
    sha256:'b040b40e3092475be0d370983f56a66cfed26193ffc8efdf8540dd0f5f84b4ff',meanCosine:0.9999999317097004,revision:'5f60ee96d0b302bb904f92bab808354d33b6dc4a'},
];

export type SemanticEncoder = {
  tokenize(text:string, signal?:AbortSignal):Promise<number[]>;
  embed(ids:number[], signal?:AbortSignal):Promise<Float32Array>;
};

function modelUrl(artifact:SemanticArtifact) {
  if(!/^Norovox-Embed-Zero-(Q8_0|F16)\.gguf$/.test(artifact.file)||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)||!(/^[a-f0-9]{40}$/).test(artifact.revision)||
    !Number.isSafeInteger(artifact.size)||artifact.size<=0||
    !Number.isFinite(artifact.meanCosine)||artifact.meanCosine<0.999||artifact.meanCosine>1) {
    throw new Error('Norovox embedding model has not passed release verification.');
  }
  return new URL('https://huggingface.co/'+NOROVOX_REPO+'/resolve/'+artifact.revision+'/'+artifact.file);
}

function isHuggingFace(url:URL) {
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
    (url.hostname==='huggingface.co'||url.hostname.endsWith('.huggingface.co')||url.hostname.endsWith('.hf.co'));
}

async function fileMatches(file:string,artifact:SemanticArtifact,signal?:AbortSignal) {
  try{
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==artifact.size)return false;
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);
    return hash.digest('hex')===artifact.sha256;
  }catch(error){
    if(signal?.aborted)throw error;
    return false;
  }
}

export async function prepareSemanticModel(
  artifact:SemanticArtifact, directory:string,
  confirm:(artifact:SemanticArtifact)=>Promise<boolean>,
  progress:(bytes:number)=>void, signal?:AbortSignal,
  request:typeof fetch=fetch,
) {
  let url=modelUrl(artifact);
  const file=path.join(directory,artifact.file);
  if(await fileMatches(file,artifact,signal))return file;
  if(!await confirm(artifact))return undefined;
  signal?.throwIfAborted();
  await fs.mkdir(directory,{recursive:true});
  const disk=await fs.statfs(directory);
  if(BigInt(disk.bavail)*BigInt(disk.bsize)<BigInt(artifact.size)+64n*1024n*1024n) {
    throw new Error('There is not enough free space in the local model directory.');
  }
  const timeout=AbortSignal.timeout(15*60_000);
  const transferSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  let response:Response|undefined;
  for(let hop=0;hop<6;hop++){
    response=await request(url,{redirect:'manual',signal:transferSignal});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');
    await response.body?.cancel().catch(()=>undefined);
    response=undefined;
    if(!location)throw new Error('The model download returned an invalid redirect.');
    url=new URL(location,url);
    if(!isHuggingFace(url))throw new Error('The model download left the Hugging Face CDN.');
  }
  if(!response?.ok||!response.body) {
    await response?.body?.cancel().catch(()=>undefined);
    throw new Error(response?.status===404?
      'The verified Norovox GGUF has not been published on Hugging Face yet.':
      'Hugging Face could not deliver the Norovox embedding model.');
  }
  const temporary=file+'.'+randomBytes(12).toString('hex')+'.partial';
  const hash=createHash('sha256');
  let bytes=0;
  const verifySize=new Transform({
    transform(chunk:Buffer,_,callback) {
      bytes+=chunk.length;
      if(bytes>artifact.size){callback(new Error('The model download exceeded its expected size.'));return;}
      hash.update(chunk);
      progress(bytes);
      callback(null,chunk);
    },
  });
  try{
    await pipeline(Readable.fromWeb(response.body as any),verifySize,createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal:transferSignal});
    if(bytes!==artifact.size||hash.digest('hex')!==artifact.sha256)throw new Error('The Norovox GGUF failed SHA-256 verification.');
    await fs.rename(temporary,file);
    return file;
  }finally{await fs.rm(temporary,{force:true}).catch(()=>undefined);}
}

export function semanticServerArgs(model:string,port:number,apiKey:string) {
  return [
    '--model',model,'--host','127.0.0.1','--port',String(port),'--api-key',apiKey,
    // This llama-server build reads non-causal attention from Qwen2 GGUF metadata.
    '--embedding','--pooling','mean','--embd-normalize','2','--alias','norovox-embed-zero',
    '--ctx-size','1024','--batch-size','1024','--ubatch-size','1024','--parallel','1',
    '--n-gpu-layers','0','--threads','3','--no-webui',
  ];
}

async function loopbackPort(){
  return new Promise<number>((resolve,reject)=>{
    const socket=net.createServer();
    socket.once('error',reject);
    socket.listen(0,'127.0.0.1',()=>{
      const address=socket.address() as net.AddressInfo;
      socket.close(error=>error?reject(error):resolve(address.port));
    });
  });
}

export class SemanticModelRuntime implements SemanticEncoder {
  private server?:{child:ChildProcess;origin:string;key:string;model:string;exited:boolean};
  private opening?:Promise<void>;
  private shutdown=new AbortController();

  constructor(private executable:string){}

  async start(model:string,signal?:AbortSignal){
    if(this.server&&!this.server.exited&&this.server.model===model&&!this.opening)return;
    if(this.opening)return this.opening;
    this.dispose();
    this.shutdown=new AbortController();
    const combined=signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal;
    this.opening=this.launch(model,combined).finally(()=>{this.opening=undefined;});
    return this.opening;
  }

  private async launch(model:string,signal:AbortSignal){
    if(process.platform!=='win32')throw new Error('The bundled Norovox embedding runtime is available on Windows.');
    await fs.access(this.executable);
    const port=await loopbackPort(),key=randomBytes(24).toString('hex');
    signal.throwIfAborted();
    const child=spawn(this.executable,semanticServerArgs(model,port,key),{
      cwd:path.dirname(this.executable),env:processEnvironment(),windowsHide:true,shell:false,stdio:'ignore',
    });
    const server={child,origin:'http://127.0.0.1:'+port,model,key,exited:false};
    this.server=server;
    child.once('error',()=>{server.exited=true;});
    child.once('exit',()=>{server.exited=true;});
    const deadline=Date.now()+90_000;
    try{
      while(Date.now()<deadline&&!server.exited){
        signal.throwIfAborted();
        try{
          const response=await fetch(server.origin+'/health',{signal:AbortSignal.any([AbortSignal.timeout(1000),signal]),redirect:'error'});
          const ready=response.ok;
          await response.body?.cancel().catch(()=>undefined);
          if(ready)return;
        }catch{signal.throwIfAborted();}
        await delay(250,undefined,{signal});
      }
      throw new Error('The bundled llama-server could not start the verified embedding model.');
    }catch(error){
      child.kill();
      if(this.server===server)this.server=undefined;
      throw error;
    }
  }

  private async post(route:string,body:object,signal?:AbortSignal){
    const server=this.server;
    if(!server||server.exited)throw new Error('The Norovox embedding runtime is offline.');
    const timeout=AbortSignal.timeout(40_000);
    const signals=[timeout,this.shutdown.signal,...(signal?[signal]:[])];
    const response=await fetch(server.origin+route,{
      method:'POST',headers:{authorization:'Bearer '+server.key,'content-type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.any(signals),redirect:'error',
    });
    if(!response.ok){
      await response.body?.cancel().catch(()=>undefined);
      throw new Error('The embedding runtime rejected the request.');
    }
    return JSON.parse(await boundedMcpBody(response,512_000));
  }

  async tokenize(text:string,signal?:AbortSignal):Promise<number[]>{
    const data=await this.post('/tokenize',{content:text.normalize('NFC'),add_special:false,parse_special:true},signal);
    if(!Array.isArray(data?.tokens)||data.tokens.some((id:unknown)=>typeof id!=='number'||!Number.isInteger(id)||id<0||id>=151936)) {
      throw new Error('The embedding tokenizer returned invalid token IDs.');
    }
    return data.tokens;
  }

  async embed(ids:number[],signal?:AbortSignal):Promise<Float32Array>{
    if(!ids.length||ids.length>EMBEDDING_MAX_TOKENS)throw new Error('Embedding input exceeds the verified token range.');
    const data=await this.post('/v1/embeddings',{input:ids,model:'norovox-embed-zero',encoding_format:'float'},signal);
    const vector=data?.data?.[0]?.embedding;
    if(!Array.isArray(vector)||vector.length!==EMBEDDING_DIMENSION||vector.some((value:unknown)=>typeof value!=='number'||!Number.isFinite(value))) {
      throw new Error('The embedding runtime returned an invalid vector.');
    }
    return Float32Array.from(vector);
  }

  dispose(){
    this.shutdown.abort();
    this.server?.child.kill();
    this.server=undefined;
  }
}

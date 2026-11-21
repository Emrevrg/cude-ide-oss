import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EMBEDDING_DIMENSION, EMBEDDING_MAX_TOKENS, type SemanticEncoder } from './semanticModel';
import { isSecretPath, redactCredentialLiterals } from './security';

const MAX_FILE_BYTES=64*1024;
const MAX_FILES=600;
const MAX_CHUNKS=2400;
const MAX_INDEX_BYTES=16*1024*1024;
const PASSAGE='passage: ';
const QUERY='query: ';
const excluded=new Set(['.cude','.git','node_modules','vendor','dist','out','build','coverage','target','__pycache__']);
const textFile=/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|cs|fs|scala|c|h|cc|hh|cpp|hpp|rb|php|lua|sh|ps1|psm1|bat|cmd|sql|html?|svelte|vue|css|scss|less|md|rst|txt|jsonc?|toml|ya?ml|xml|ini|cfg|graphql|proto|gradle|tf|zig|exs?|dart|r|jl)$/i;
const extensionless=/^(?:Dockerfile|Containerfile|Makefile|CMakeLists\.txt)$/i;

export function isIndexablePath(file:string) {
  const parts=file.split('/');
  return !!file&&!file.includes('\\')&&!file.includes(':')&&!/[\u0000-\u001f]/.test(file)&&
    parts.every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.')&&!excluded.has(part.toLowerCase()))&&
    !isSecretPath(file)&&!/(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock|composer\.lock)(?:\.|$)/i.test(file)&&
    (textFile.test(file)||extensionless.test(parts.at(-1)||''));
}

type Chunk={start:number;end:number;tokens:number[]};

export async function semanticChunks(text:string,encoder:Pick<SemanticEncoder,'tokenize'>,signal?:AbortSignal):Promise<Chunk[]>{
  const characters=Array.from(text);
  const output:Chunk[]=[];
  let offset=0;
  for(let position=0;position<characters.length;){
    signal?.throwIfAborted();
    const maximum=Math.min(2048,characters.length-position);
    const tokenize=(length:number)=>encoder.tokenize(PASSAGE+characters.slice(position,position+length).join(''),signal);
    let count=maximum;
    let tokens=await tokenize(count);
    if(tokens.length>EMBEDDING_MAX_TOKENS){
      let low=1,high=maximum-1;
      count=0;
      while(low<=high){
        const middle=Math.floor((low+high)/2);
        const trial=await tokenize(middle);
        if(trial.length<=EMBEDDING_MAX_TOKENS){count=middle;tokens=trial;low=middle+1;}
        else high=middle-1;
      }
      if(!count)throw new Error('The embedding tokenizer could not fit a code character.');
    }
    const segment=characters.slice(position,position+count).join('');
    if(segment.trim()&&tokens.length)output.push({start:offset,end:offset+segment.length,tokens});
    offset+=segment.length;
    position+=count;
  }
  return output;
}

type Row={start:number;end:number;embedding:string};
type Entry={file:string;digest:string;rows:Row[]};
type Index={version:1;model:string;entries:Entry[]};
export type SemanticHit={file:string;line:number;text:string;score:number};
export type IndexStats={files:number;chunks:number;updated:number;skipped:number};

function encodeVector(vector:Float32Array) {
  if(vector.length!==EMBEDDING_DIMENSION)throw new Error('Invalid embedding dimension.');
  const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
  if(!Number.isFinite(norm)||norm===0)throw new Error('Invalid embedding norm.');
  const packed=Buffer.allocUnsafe(EMBEDDING_DIMENSION*4);
  vector.forEach((value,i)=>packed.writeFloatLE(value/norm,i*4));
  return packed.toString('base64');
}

function scoreVector(packed:string,query:Float32Array) {
  if(packed.length!==EMBEDDING_DIMENSION*16/3)return Number.NEGATIVE_INFINITY;
  const bytes=Buffer.from(packed,'base64');
  if(bytes.length!==EMBEDDING_DIMENSION*4)return Number.NEGATIVE_INFINITY;
  let score=0,norm=0,queryNorm=0;
  for(let i=0;i<query.length;i++){
    const value=bytes.readFloatLE(i*4);
    score+=query[i]*value;
    norm+=value*value;
    queryNorm+=query[i]*query[i];
  }
  const cosine=score/Math.sqrt(norm*queryNorm);
  return Number.isFinite(cosine)?cosine:Number.NEGATIVE_INFINITY;
}

async function projectDirectory(workspace:string,create:boolean) {
  const root=await fs.realpath(workspace);
  let directory=root;
  for(const name of ['.cude','index']){
    directory=path.join(directory,name);
    const current=await fs.lstat(directory).catch((error:NodeJS.ErrnoException)=>{
      if(error.code!=='ENOENT')throw error;
      return undefined;
    });
    if(!current){
      if(!create)return undefined;
      await fs.mkdir(directory,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
    }
    const actual=await fs.lstat(directory);
    if(!actual.isDirectory()||actual.isSymbolicLink()||await fs.realpath(directory)!==directory) {
      throw new Error('The semantic index directory must be inside the workspace and cannot be a link.');
    }
  }
  return {root,directory};
}

async function sourceFile(root:string,relative:string){
  if(!isIndexablePath(relative))return undefined;
  const expected=path.join(root,...relative.split('/'));
  try{
    const resolved=await fs.realpath(expected);
    if(resolved!==expected||isSecretPath(path.relative(root,resolved)))return undefined;
    const handle=await fs.open(resolved,'r');
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>MAX_FILE_BYTES||stat.nlink!==1)return undefined;
      const bytes=Buffer.allocUnsafe(MAX_FILE_BYTES+1);
      let bytesRead=0;
      while(bytesRead<bytes.length){
        const read=await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);
        if(!read.bytesRead)break;
        bytesRead+=read.bytesRead;
      }
      const content=bytes.subarray(0,bytesRead);
      if(bytesRead>MAX_FILE_BYTES||content.includes(0))return undefined;
      const text=new TextDecoder('utf-8',{fatal:true}).decode(content);
      return {digest:createHash('sha256').update(content).digest('hex'),text:redactCredentialLiterals(text)};
    }finally{await handle.close();}
  }catch(error){
    if(error instanceof TypeError||['ENOENT','EACCES','EPERM','EISDIR'].includes((error as NodeJS.ErrnoException).code||''))return undefined;
    throw error;
  }
}

async function readIndex(directory:string,model:string):Promise<Index>{
  const empty:Index={version:1,model,entries:[]};
  const file=path.join(directory,'norovox.json');
  try{
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_INDEX_BYTES)return empty;
    const index=JSON.parse(await fs.readFile(file,'utf8'));
    if(index?.version!==1||index.model!==model||!Array.isArray(index.entries)||index.entries.length>MAX_FILES)return empty;
    let remaining=MAX_CHUNKS;
    for(const entry of index.entries){
      if(!entry||typeof entry.file!=='string'||!isIndexablePath(entry.file)||!(/^[a-f0-9]{64}$/).test(String(entry.digest))||
        !Array.isArray(entry.rows)||entry.rows.length>remaining)return empty;
      remaining-=entry.rows.length;
      for(const row of entry.rows){
        if(!row||!Number.isInteger(row.start)||row.start<0||!Number.isInteger(row.end)||row.end<=row.start||row.end>MAX_FILE_BYTES||
          typeof row.embedding!=='string'||row.embedding.length!==EMBEDDING_DIMENSION*16/3)return empty;
      }
    }
    return index;
  }catch{return empty;}
}

async function writeIndex(directory:string,index:Index){
  await fs.writeFile(path.join(directory,'.gitignore'),'*\n',{flag:'wx',mode:0o600}).catch((error:NodeJS.ErrnoException)=>{
    if(error.code!=='EEXIST')throw error;
  });
  const temporary=path.join(directory,'norovox.'+randomBytes(10).toString('hex')+'.tmp');
  try {
    await fs.writeFile(temporary,JSON.stringify(index),{flag:'wx',mode:0o600});
    await fs.rename(temporary,path.join(directory,'norovox.json'));
  }finally{await fs.rm(temporary,{force:true}).catch(()=>undefined);}
}

export class ProjectSemanticIndex {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private workspace:string,private model:string,private encoder:SemanticEncoder){}

  refresh(files:string[],progress?:(stats:IndexStats)=>void,signal?:AbortSignal):Promise<IndexStats>{
    const job=this.queue.then(()=>this.refreshIndex(files,progress,signal));
    this.queue=job.catch(()=>undefined);
    return job;
  }

  private async refreshIndex(files:string[],progress?:(stats:IndexStats)=>void,signal?:AbortSignal){
    signal?.throwIfAborted();
    const {root,directory}=(await projectDirectory(this.workspace,true))!;
    const old=await readIndex(directory,this.model);
    const previous=new Map(old.entries.map(entry=>[entry.file,entry]));
    const entries:Entry[]=[];
    const candidates=[...new Set(files.filter(isIndexablePath))].sort();
    const stats:IndexStats={files:0,chunks:0,updated:0,skipped:Math.max(0,candidates.length-MAX_FILES)};
    const selected=candidates.slice(0,MAX_FILES);
    for(const [position,file] of selected.entries()){
      signal?.throwIfAborted();
      const source=await sourceFile(root,file);
      if(!source){stats.skipped++;continue;}
      let entry=previous.get(file);
      if(!entry||entry.digest!==source.digest){
        const rows:Row[]=[];
        for(const chunk of await semanticChunks(source.text,this.encoder,signal)){
          if(stats.chunks+rows.length===MAX_CHUNKS){stats.skipped++;break;}
          const embedding=encodeVector(await this.encoder.embed(chunk.tokens,signal));
          rows.push({start:chunk.start,end:chunk.end,embedding});
        }
        entry={file,digest:source.digest,rows};
        stats.updated++;
      }
      if(stats.chunks+entry.rows.length>MAX_CHUNKS){stats.skipped++;continue;}
      entries.push(entry);
      stats.files++;
      stats.chunks+=entry.rows.length;
      progress?.({...stats});
      if(stats.chunks===MAX_CHUNKS){stats.skipped+=selected.length-position-1;break;}
    }
    signal?.throwIfAborted();
    if(stats.updated||entries.length!==old.entries.length||!await this.exists()){
      const checked=await projectDirectory(this.workspace,false);
      if(checked?.directory!==directory)throw new Error('The semantic index directory moved during indexing.');
      await writeIndex(directory,{version:1,model:this.model,entries});
    }
    return stats;
  }

  async exists() {
    const project=await projectDirectory(this.workspace,false);
    if(!project)return false;
    const file=await fs.lstat(path.join(project.directory,'norovox.json')).catch(()=>undefined);
    return !!file?.isFile()&&!file.isSymbolicLink();
  }

  async search(query:string,limit=6,signal?:AbortSignal):Promise<SemanticHit[]>{
    await this.queue;
    const project=await projectDirectory(this.workspace,false);
    if(!project||!query.trim())return [];
    const {root,directory}=project;
    const index=await readIndex(directory,this.model);
    if(!index.entries.some(entry=>entry.rows.length))return [];
    const tokens=(await this.encoder.tokenize(QUERY+query.trim().slice(0,4000),signal)).slice(0,EMBEDDING_MAX_TOKENS);
    const vector=await this.encoder.embed(tokens,signal);
    const ranks=index.entries.flatMap(entry=>entry.rows.map(row=>({entry,row,score:scoreVector(row.embedding,vector)})))
      .filter(hit=>Number.isFinite(hit.score)).sort((a,b)=>b.score-a.score);
    const hits:SemanticHit[]=[];
    const sources=new Map<string,Awaited<ReturnType<typeof sourceFile>>>();
    for(const hit of ranks){
      signal?.throwIfAborted();
      if(hits.length>=Math.min(Math.max(1,limit),12))break;
      const file=hit.entry.file;
      if(!sources.has(file))sources.set(file,await sourceFile(root,file));
      const source=sources.get(file);
      if(!source||source.digest!==hit.entry.digest||hit.row.end>source.text.length)continue;
      hits.push({file,line:source.text.slice(0,hit.row.start).split('\n').length,
        text:source.text.slice(hit.row.start,hit.row.end),score:hit.score});
    }
    return hits;
  }
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isIndexablePath, ProjectSemanticIndex, type IndexStats } from './semanticIndex';
import { NOROVOX_ARTIFACTS, NOROVOX_REPO, prepareSemanticModel, SemanticModelRuntime } from './semanticModel';

const exclude='**/{.cude,.git,node_modules,vendor,dist,out,build,coverage,target,__pycache__}/**';
const MAX_DISCOVERY=3200;

export function hasCodebaseMention(text:string){
  return /(?:^|\s)@codebase(?=$|\s|[.,:;!?])/i.test(text);
}

export function codebaseQuery(text:string){
  return text.replace(/(^|\s)@codebase(?=$|\s|[.,:;!?])/gi,'$1').trim();
}

export class SemanticProjects implements vscode.Disposable {
  private runtime:SemanticModelRuntime;
  private indexes=new Map<string,ProjectSemanticIndex>();
  private setup?:Promise<string|undefined>;
  private modelPath?:string;
  private stopped=new AbortController();
  private watchers:vscode.Disposable[]=[];
  private scheduled=new Map<string,ReturnType<typeof setTimeout>>();

  constructor(private context:vscode.ExtensionContext,private localDirectory:()=>string,private language:()=>string){
    this.runtime=new SemanticModelRuntime(path.join(context.extensionUri.fsPath,'bin','llama','llama-server.exe'));
  }

  private text(en:string,tr:string){return this.language()==='tr'?tr:en;}

  private get artifact(){
    const available=NOROVOX_ARTIFACTS[0];
    if(!available)throw new Error(this.text(
      'No Norovox GGUF has passed release verification.',
      'Yayın doğrulamasından geçmiş Norovox GGUF bulunamadı.'));
    return available;
  }

  private async modelDirectory(){
    const configured=this.localDirectory();
    if(configured)return path.join(configured,'.cude-semantic');
    if(process.platform==='win32'&&await fs.stat('E:\\CudeModels').then(item=>item.isDirectory(),()=>false)){
      return 'E:\\CudeModels\\.cude-semantic';
    }
    return path.join(this.context.globalStorageUri.fsPath,'semantic-models');
  }

  private async ensureRuntime(allowDownload:boolean,progress:(bytes:number,total:number)=>void,signal:AbortSignal){
    const artifact=this.artifact;
    if(!this.modelPath){
      if(!this.setup){
        this.setup=this.modelDirectory().then(directory=>prepareSemanticModel(artifact,directory,async item=>{
          if(!allowDownload)return false;
          const allow=this.text('Download model','Modeli indir');
          const detail=this.text(
            'Download '+item.file+' ('+Math.ceil(item.size/1024**2)+' MiB) from '+NOROVOX_REPO+'? Code indexing runs on this device.',
            item.file+' ('+Math.ceil(item.size/1024**2)+' MiB) '+NOROVOX_REPO+' deposundan indirilsin mi? Kod bu cihazda indekslenir.');
          return await vscode.window.showInformationMessage(detail,{modal:true},allow)===allow;
        },bytes=>progress(bytes,artifact.size),signal)).finally(()=>{this.setup=undefined;});
      }
      this.modelPath=await this.setup;
    }
    if(!this.modelPath)return false;
    await this.runtime.start(this.modelPath,signal);
    return true;
  }

  private getIndex(workspace:string){
    let index=this.indexes.get(workspace);
    if(!index){
      index=new ProjectSemanticIndex(workspace,this.artifact.sha256,this.runtime);
      this.indexes.set(workspace,index);
    }
    return index;
  }

  private async files(workspace:string,signal:AbortSignal){
    signal.throwIfAborted();
    const uris=await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(workspace),'**/*'),exclude,MAX_DISCOVERY);
    signal.throwIfAborted();
    return uris.filter(uri=>uri.scheme==='file').map(uri=>path.relative(workspace,uri.fsPath).replace(/\\/g,'/')).filter(isIndexablePath);
  }

  private watch(){
    if(this.watchers.length)return;
    const watcher=vscode.workspace.createFileSystemWatcher('**/*');
    const changed=(uri:vscode.Uri)=>{
      if(!vscode.workspace.isTrusted||uri.scheme!=='file')return;
      const workspace=vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      if(!workspace||!this.indexes.has(workspace)||!isIndexablePath(path.relative(workspace,uri.fsPath).replace(/\\/g,'/')))return;
      clearTimeout(this.scheduled.get(workspace));
      const timer=setTimeout(()=>{
        this.scheduled.delete(workspace);
        void this.refreshExisting(workspace,this.stopped.signal).catch(()=>undefined);
      },1250);
      this.scheduled.set(workspace,timer);
    };
    this.watchers.push(watcher,watcher.onDidChange(changed),watcher.onDidCreate(changed),watcher.onDidDelete(changed));
  }

  private async refreshExisting(workspace:string,signal:AbortSignal){
    if(!vscode.workspace.isTrusted||!NOROVOX_ARTIFACTS.length)return undefined;
    const index=this.getIndex(workspace);
    if(!await index.exists()||!await this.ensureRuntime(false,()=>undefined,signal))return undefined;
    await index.refresh(await this.files(workspace,signal),undefined,signal);
    return index;
  }

  async indexProject(workspace:string){
    if(!vscode.workspace.isTrusted)throw new Error(this.text('Trust this workspace before indexing.','İndekslemeden önce bu çalışma alanına güvenin.'));
    return vscode.window.withProgress({
      location:vscode.ProgressLocation.Notification,
      title:this.text('Indexing project with Norovox','Proje Norovox ile indeksleniyor'),
      cancellable:true,
    },async(progress,cancel)=>{
      const controller=new AbortController();
      const subscription=cancel.onCancellationRequested(()=>controller.abort());
      const signal=AbortSignal.any([controller.signal,this.stopped.signal]);
      if(cancel.isCancellationRequested)controller.abort();
      try{
        let percent=-1;
        if(!await this.ensureRuntime(true,(bytes,total)=>{
          const current=Math.floor(bytes*100/total);
          if(current===percent)return;
          percent=current;
          progress.report({message:this.text('Downloading model · ','Model indiriliyor · ')+current+'%'});
        },signal))return undefined;
        progress.report({message:this.text('Reading project files','Proje dosyaları okunuyor')});
        const index=this.getIndex(workspace);
        const stats=await index.refresh(await this.files(workspace,signal),(state:IndexStats)=>{
          progress.report({message:this.text('Indexed files · ','İndekslenen dosyalar · ')+state.files});
        },signal);
        this.watch();
        return stats;
      }catch(error){
        if(!signal.aborted)throw error;
        return undefined;
      }finally{subscription.dispose();}
    });
  }

  async contextFor(workspace:string|undefined,query:string,signal?:AbortSignal){
    if(!workspace||!query.trim())return '';
    const active=signal?AbortSignal.any([signal,this.stopped.signal]):this.stopped.signal;
    try{
      const index=await this.refreshExisting(workspace,active);
      if(!index)return '';
      const hits=await index.search(query,6,active);
      this.watch();
      return hits.map(hit=>hit.file+':'+hit.line+'\n'+hit.text).join('\n\n').slice(0,10000);
    }catch{return '';}
  }

  dispose(){
    this.stopped.abort();
    for(const timer of this.scheduled.values())clearTimeout(timer);
    for(const watcher of this.watchers)watcher.dispose();
    this.runtime.dispose();
  }
}

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isSecretPath } from './security';
import { t, normalizeLanguage, type MessageKey } from './i18n';

const execFileAsync=promisify(execFile);
const hiddenSegment=(value:string)=>value.split(/[\\/]+/).some(part=>part.startsWith('.')&&part!=='.'&&part!=='..');
export function isProtectedCompletionPath(filePath:string,workspace:string){
  const relative=path.relative(workspace,filePath).replace(/\\/g,'/');
  return !relative||relative==='..'||relative.startsWith('../')||path.isAbsolute(relative)||hiddenSegment(relative)||isSecretPath(relative);
}
export function extractCompletion(text:string){return text.replace(/^```[^\n]*\n/,'').replace(/\n```$/,'').replace(/^\n/,'').replace(/\n$/,'');}
export function changedDiffLines(diff:string){
  const files=new Map<string,Set<number>>();let file='',line=0;
  for(const row of diff.split(/\r?\n/)){
    if(row.startsWith('+++ b/')){file=row.slice(6);if(!files.has(file))files.set(file,new Set());continue;}
    const hunk=row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk){line=Number(hunk[1]);continue;}
    if(!file||!line)continue;
    if(row.startsWith('+')&&!row.startsWith('+++')){files.get(file)!.add(line);line++;continue;}
    if(row.startsWith('-')&&!row.startsWith('---'))continue;
    if(row.startsWith(' '))line++;
  }
  return files;
}

type ChatGateway={chat(messages:Array<{role:string;content:any}>,signal?:AbortSignal,onDelta?:(delta:string)=>void,selected?:{providerId?:string;model?:string}):Promise<string>};
type PendingEdit={editor:vscode.TextEditor;range:vscode.Range;before:string;instruction:string;version:number;replacement:string};

export function registerEditorFeatures(context:vscode.ExtensionContext,gateway:ChatGateway){
  const cfg=()=>vscode.workspace.getConfiguration('cude-ai');
  const tr=(key:MessageKey,values?:Record<string,string|number>)=>t(key,normalizeLanguage(cfg().get('language','en')),values);
  const cache=new Map<string,{at:number;text:string}>();
  const reviewThreads=new Set<vscode.CommentThread>();
  let pending:PendingEdit|undefined;
  const removed=vscode.window.createTextEditorDecorationType({isWholeLine:true,backgroundColor:new vscode.ThemeColor('diffEditor.removedTextBackground'),border: '1px solid transparent'});
  const inserted=vscode.window.createTextEditorDecorationType({after:{margin:'0 0 0 18px',color:new vscode.ThemeColor('diffEditor.insertedTextForeground'),backgroundColor:new vscode.ThemeColor('diffEditor.insertedTextBackground'),fontStyle:'italic'}});
  const completionStatus=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,80);
  const updateStatus=()=>{const enabled=cfg().get<boolean>('inlineCompletion.enabled',true);completionStatus.text=tr('editor.tabStatus',{state:enabled?tr('editor.on'):tr('editor.off')});completionStatus.tooltip=tr('editor.tabTooltip');completionStatus.command='cude-ai.toggleInlineCompletion';completionStatus.show();};
  updateStatus();
  context.subscriptions.push(completionStatus,removed,inserted,vscode.languages.registerInlineCompletionItemProvider({scheme:'file'}, {
    async provideInlineCompletionItems(document,position,_context,token){
      if(!cfg().get<boolean>('inlineCompletion.enabled',true)||!vscode.workspace.isTrusted||token.isCancellationRequested)return;
      const workspace=vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath||vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if(!workspace||isProtectedCompletionPath(document.uri.fsPath,workspace)||document.languageId==='plaintext'||document.getText().length>1_000_000)return;
      const realCurrent=await fs.realpath(document.uri.fsPath).catch(()=>undefined);if(!realCurrent)return;const realRelative=path.relative(workspace,realCurrent);if(!realRelative||realRelative==='..'||realRelative.startsWith(`..${path.sep}`)||isProtectedCompletionPath(realCurrent,workspace))return;
      const prefix=document.getText(new vscode.Range(new vscode.Position(0,0),position));
      const suffix=document.getText(new vscode.Range(position,new vscode.Position(document.lineCount-1,document.lineAt(document.lineCount-1).text.length)));
      if(!prefix.trim()||prefix.length>500_000||suffix.length>250_000)return;
      const settings=cfg(),providerId=settings.get<string>('inlineCompletion.providerId','')||undefined;
      const profile=(settings.get<Array<{id:string;models:string[]}>>('providers',[])||[]).find(item=>item.id===providerId);
      const model=settings.get<string>('inlineCompletion.model','')||profile?.models?.[0]||settings.get<string>('model','');
      if(!model)return;
      const key=createHash('sha1').update(`${document.uri.toString()}\0${document.version}\0${position.line}:${position.character}\0${prefix.slice(-240)}\0${suffix.slice(0,120)}`).digest('hex');
      const documentVersion=document.version;
      const cached=cache.get(key);if(cached&&Date.now()-cached.at<45000)return [new vscode.InlineCompletionItem(cached.text,new vscode.Range(position,position))];
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,250);const subscription=token.onCancellationRequested(()=>{clearTimeout(timer);subscription.dispose();resolve();});setTimeout(()=>subscription.dispose(),260);});
      if(token.isCancellationRequested)return;
      const abort=new AbortController(),cancel=token.onCancellationRequested(()=>abort.abort());
      try{
        const rules=await readProjectRules(workspace);
        const openSnippets:string[]=[];for(const doc of vscode.workspace.textDocuments){if(openSnippets.length>=4)break;if(doc.uri.scheme!=='file'||doc.uri.fsPath===document.uri.fsPath||isProtectedCompletionPath(doc.uri.fsPath,workspace)||doc.getText().length>1_000_000)continue;const real=await fs.realpath(doc.uri.fsPath).catch(()=>undefined);if(!real)continue;const relative=path.relative(workspace,real);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||isProtectedCompletionPath(real,workspace))continue;openSnippets.push(`### ${relative.replace(/\\/g,'/')}\n${doc.getText().slice(0,1800)}`);}const openFiles=openSnippets.join('\n\n');
        const messages=[
          {role:'system',content:`You are a low-latency code completion engine. Complete only the code at the cursor. Return only the insertion text, without markdown or explanations. Respect the suffix and preserve syntax. Prefer a short, directly useful completion. Use the FIM markers exactly as context, not as output.\n\nProject rules:\n${rules||'(none)'}`},
          {role:'user',content:`File: ${path.relative(workspace,document.uri.fsPath).replace(/\\/g,'/')}\nLanguage: ${document.languageId}\nOther open-file context:\n${openFiles||'(none)'}\n\n<|fim_prefix|>${prefix.slice(-4000)}<|fim_suffix|>${suffix.slice(0,1800)}<|fim_middle|>`}
        ];
        const response=extractCompletion(await gateway.chat(messages,abort.signal,undefined,{providerId,model}));
        if(token.isCancellationRequested||document.version!==documentVersion||!response)return;
        const suggestion=response.split('\n').slice(0,18).join('\n');if(!suggestion.trim()||suggestion.length>1600)return;
        cache.set(key,{at:Date.now(),text:suggestion});while(cache.size>96)cache.delete(cache.keys().next().value!);
        return [new vscode.InlineCompletionItem(suggestion,new vscode.Range(position,position))];
      }catch{return;}finally{cancel.dispose();}
    }
  }));

  const clearPreview=()=>{if(pending){pending.editor.setDecorations(removed,[]);pending.editor.setDecorations(inserted,[]);}pending=undefined;void vscode.commands.executeCommand('setContext','cude.inlineEditActive',false);};
  const drawDiff=(editor:vscode.TextEditor,range:vscode.Range,replacement:string)=>{
    const lines=range.isEmpty?[]:[new vscode.Range(range.start.line,0,Math.max(range.start.line,range.end.line-Number(range.end.character===0)),0)];editor.setDecorations(removed,lines);
    const anchor=new vscode.Range(Math.max(range.start.line,range.end.line-1),0,Math.max(range.start.line,range.end.line-1),0),insertion=`\n  + ${replacement.split(/\r?\n/).join('\n  + ')}`;editor.setDecorations(inserted,[{range:anchor,renderOptions:{after:{contentText:insertion}}}]);
  };
  const preview=(edit:PendingEdit)=>{
    clearPreview();pending=edit;
    drawDiff(edit.editor,edit.range,edit.replacement);
    void vscode.commands.executeCommand('setContext','cude.inlineEditActive',true);
    const acceptLabel=tr('chat.accept'),rejectLabel=tr('chat.reject'),retryLabel=tr('editor.retry');
    void vscode.window.showInformationMessage(tr('editor.editReady'),acceptLabel,rejectLabel,retryLabel).then(action=>{
      if(action===acceptLabel)void acceptEdit();else if(action===retryLabel)void startInlineEdit(edit.instruction);else if(action===rejectLabel)clearPreview();
    });
  };
  const startInlineEdit=async(previous?:string)=>{
    const editor=vscode.window.activeTextEditor;if(!editor){void vscode.window.showWarningMessage(tr('editor.openFile'));return;}
    if(!vscode.workspace.isTrusted){void vscode.window.showWarningMessage(tr('editor.trustWorkspace'));return;}
    const permission=context.workspaceState.get<'ask'|'auto'|'plan'|'readonly'|'full'>('permission','auto');
    if(permission==='readonly'||permission==='plan'){void vscode.window.showWarningMessage(tr('editor.permissionNoEdit'));return;}
    const workspace=vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath||path.dirname(editor.document.uri.fsPath),real=await fs.realpath(editor.document.uri.fsPath).catch(()=>undefined);if(editor.document.uri.scheme!=='file'||!real||isProtectedCompletionPath(editor.document.uri.fsPath,workspace)||isProtectedCompletionPath(real,workspace)){void vscode.window.showWarningMessage(tr('editor.protectedFile'));return;}const realRelative=path.relative(workspace,real);if(!realRelative||realRelative==='..'||realRelative.startsWith(`..${path.sep}`)){void vscode.window.showWarningMessage(tr('editor.outsideWorkspace'));return;}
    const selection=editor.selection,range=selection.isEmpty?new vscode.Range(new vscode.Position(selection.active.line,0),new vscode.Position(selection.active.line,editor.document.lineAt(selection.active.line).text.length)):new vscode.Range(selection.start,selection.end);
    const instruction=await vscode.window.showInputBox({title:tr('editor.inputTitle'),prompt:tr('editor.inputPrompt'),value:previous||'',ignoreFocusOut:true});if(!instruction?.trim())return;
    const before=editor.document.getText(range),version=editor.document.version;let replacement='';
    try{const rules=await readProjectRules(workspace);const response=await gateway.chat([{role:'system',content:'Edit only the provided code. Return only the complete replacement, without markdown fences, commentary or diff markers. Preserve indentation and surrounding context.'},{role:'user',content:`Project rules:\n${rules||'(none)'}\n\nFile: ${path.basename(editor.document.uri.fsPath)}\nLanguage: ${editor.document.languageId}\nInstruction: ${instruction}\nCode to replace:\n${before}`}],undefined,delta=>{replacement+=delta;if(editor.document.version===version)drawDiff(editor,range,extractCompletion(replacement));},{providerId:cfg().get('inlineCompletion.providerId','')||undefined,model:cfg().get('inlineCompletion.model','')||undefined});replacement=extractCompletion(response||replacement);}
    catch(error:any){void vscode.window.showErrorMessage(error?.message||tr('editor.prepareFailed'));return;}
    if(editor.document.version!==version){void vscode.window.showWarningMessage(tr('editor.docChanged'));return;}
    if(!replacement.trim()){void vscode.window.showWarningMessage(tr('editor.emptyEdit'));return;}
    preview({editor,range,before,instruction,version,replacement});
  };
  const acceptEdit=async()=>{
    const edit=pending;if(!edit)return;
    if(edit.editor.document.version!==edit.version||edit.editor.document.getText(edit.range)!==edit.before){clearPreview();void vscode.window.showWarningMessage(tr('editor.selectionChanged'));return;}
    const workspaceEdit=new vscode.WorkspaceEdit();workspaceEdit.replace(edit.editor.document.uri,edit.range,edit.replacement);
    clearPreview();if(!await vscode.workspace.applyEdit(workspaceEdit)){void vscode.window.showErrorMessage(tr('editor.applyFailed'));return;}
    edit.editor.selection=new vscode.Selection(edit.range.start,edit.range.start.translate(edit.replacement.split(/\r?\n/).length-1,edit.replacement.split(/\r?\n/).at(-1)?.length||0));edit.editor.revealRange(edit.editor.selection,vscode.TextEditorRevealType.InCenter);
  };
  const rejectEdit=()=>clearPreview();
  context.subscriptions.push(vscode.commands.registerCommand('cude-ai.toggleInlineCompletion',async()=>{const current=cfg().get<boolean>('inlineCompletion.enabled',true);await cfg().update('inlineCompletion.enabled',!current,vscode.ConfigurationTarget.Global);updateStatus();}));
  context.subscriptions.push(vscode.commands.registerCommand('cude-ai.editSelection',()=>startInlineEdit()));
  context.subscriptions.push(vscode.commands.registerCommand('cude-ai.acceptInlineEdit',acceptEdit),vscode.commands.registerCommand('cude-ai.rejectInlineEdit',rejectEdit),vscode.commands.registerCommand('cude-ai.retryInlineEdit',()=>startInlineEdit(pending?.instruction)));
  const reviewController=vscode.comments?.createCommentController('cude-ai-review','Cude AI Review');
  if(reviewController)context.subscriptions.push(reviewController);
  context.subscriptions.push(vscode.commands.registerCommand('cude-ai.reviewChanges',async()=>{
    const workspace=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;if(!workspace)throw new Error(tr('review.openProjectFirst'));if(!vscode.workspace.isTrusted)throw new Error(tr('review.trustWorkspace'));
    const {stdout:pathOutput}=await execFileAsync('git',['diff','--name-only','--no-ext-diff','HEAD'],{cwd:workspace,windowsHide:true,maxBuffer:1_000_000,timeout:10000});
    const changedFiles=pathOutput.split(/\r?\n/).filter(file=>file&&!isProtectedCompletionPath(path.resolve(workspace,file),workspace));if(!changedFiles.length){void vscode.window.showInformationMessage(tr('review.noReviewable'));return;}
    const {stdout}=await execFileAsync('git',['diff','--no-ext-diff','--unified=3','HEAD','--',...changedFiles],{cwd:workspace,windowsHide:true,maxBuffer:3_000_000,timeout:15000});
    const diff=stdout.slice(0,40000);if(!diff.trim()){void vscode.window.showInformationMessage(tr('review.noTracked'));return;}
    const changedLines=changedDiffLines(diff);
    const reviewed=await gateway.chat([{role:'system',content:'Review this git diff for concrete correctness, security, reliability, and maintainability defects only. Return JSON only: {"comments":[{"file":"relative/path","line":1,"severity":"error|warning|note","title":"short","body":"specific actionable explanation"}]}. Do not invent findings. Line must refer to a changed line in the diff. Return an empty comments array when no actionable issue exists.'},{role:'user',content:diff}],undefined,undefined,{providerId:cfg().get('inlineCompletion.providerId','')||undefined,model:cfg().get('inlineCompletion.model','')||undefined});
    let parsed:any;try{parsed=JSON.parse(reviewed.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{throw new Error(tr('review.invalidJson'));}
    const comments=Array.isArray(parsed.comments)?parsed.comments.slice(0,40):[];if(!comments.length){void vscode.window.showInformationMessage(tr('review.noIssues'));return;}
    if(!reviewController){void vscode.window.showErrorMessage(tr('review.commentsUnavailable'));return;}
    let added=0;for(const item of comments){if(typeof item.file!=='string'||!Number.isInteger(item.line)||item.line<1||!changedLines.get(item.file)?.has(item.line))continue;try{const uri=vscode.Uri.file(path.resolve(workspace,item.file));const relative=path.relative(workspace,uri.fsPath);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||isProtectedCompletionPath(uri.fsPath,workspace))continue;const real=await fs.realpath(uri.fsPath),realRelative=path.relative(workspace,real);if(!realRelative||realRelative==='..'||realRelative.startsWith(`..${path.sep}`))continue;const doc=await vscode.workspace.openTextDocument(uri);if(item.line>doc.lineCount)continue;const line=item.line-1,range=new vscode.Range(line,0,line,doc.lineAt(line).text.length);const severity=['error','warning','note'].includes(item.severity)?item.severity:'note';const comment:vscode.Comment={author:{name:`Cude AI · ${severity}`},body:`**${String(item.title||'Review').slice(0,100)}**\n\n${String(item.body||'').slice(0,1500)}`,mode:vscode.CommentMode.Preview};reviewThreads.add(reviewController.createCommentThread(uri,range,[comment]));added++;}catch{continue;}}
    void vscode.window.showInformationMessage(added?(added===1?tr('review.commentsAddedOne'):tr('review.commentsAddedMany',{count:added})):tr('review.noIssuesChanged'));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cude-ai.clearReviewComments',()=>{for(const thread of reviewThreads)thread.dispose();reviewThreads.clear();}));
}

async function readProjectRules(workspace:string){try{const file=path.join(workspace,'.cude','rules.md'),real=await fs.realpath(file),relative=path.relative(workspace,real);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`))return '';if(isSecretPath(relative)||/(?:^|[\\/])\.cude[\\/]mcp(?:-tools)?\.json$/i.test(relative))return '';const stat=await fs.stat(real);if(!stat.isFile()||stat.size>12000)return '';return(await fs.readFile(real,'utf8')).slice(0,12000);}catch{return '';}}

import * as vscode from 'vscode';
import {parseReleaseTrust} from './releaseClient';
import {checkForcedUpdate} from './forcedUpdate';
export function registerReleaseCommands(context:vscode.ExtensionContext){
 context.subscriptions.push(vscode.commands.registerCommand('cude-ai.checkSignedUpdate',()=>checkForcedUpdate()));
 context.subscriptions.push(vscode.commands.registerCommand('cude-ai.configureReleaseTrust',async()=>{
  if(context.extensionMode===1){void vscode.window.showInformationMessage('Yayın anahtarı kurulum paketinde sabitlenmiştir. Değiştirmek için güvenilir kurulum kullanın.');return;}
  try{
   const [uri]=await vscode.window.showOpenDialog({canSelectMany:false,filters:{JSON:['json']},title:'Geliştirme yayın güveni'})||[];
   if(!uri)return;
   if(uri.scheme!=='file'||(await vscode.workspace.fs.stat(uri)).size>8192)throw Error('Geçersiz güven yapılandırması.');
   const trust=parseReleaseTrust(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')));
   if(await vscode.window.showWarningMessage('Bu yayın anahtarına güvenilsin mi?',{modal:true,detail:trust.feed+'\nSHA-256: '+trust.fingerprint},'Güven')==='Güven'){
    await context.globalState.update('cude.release.trust.v1',trust);await checkForcedUpdate();
   }
  }catch(e){void vscode.window.showErrorMessage(e instanceof Error?e.message:'Geçersiz yayın anahtarı.');}
 }));
}

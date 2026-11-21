import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { adbPath, androidSdkPath, findOnPath, run, runExtraTool } from './agentTools';

const T=(en:string,tr:string)=>vscode.workspace.getConfiguration('cude-ai').get<string>('language','en')==='tr'?tr:en;

export async function chooseAndroidSdk(){
  const current=androidSdkPath(), choice=await vscode.window.showOpenDialog({
    canSelectFolders:true,canSelectFiles:false,canSelectMany:false,title:T('Choose Android SDK','Android SDK seç'),
    defaultUri:existsSync(current)?vscode.Uri.file(current):undefined,
  });
  if(choice?.[0])await vscode.workspace.getConfiguration('cude-ai').update('android.sdkPath',choice[0].fsPath,vscode.ConfigurationTarget.Global);
}

export async function openAndroidTools(){
  const workspace=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,cwd=workspace||os.homedir();
  const artemisPath=findOnPath(process.platform==='win32'?['artemis.exe','artemis.cmd','artemis.bat']:['artemis']);
  const items=[
    {label:T('Build debug APK','Debug APK derle'),id:'assembleDebug'},
    {label:T('Install debug APK on device','Debug APK’yı cihaza yükle'),id:'installDebug'},
    {label:T('Start emulator','Emülatörü başlat'),id:'emulator'},
    {label:T('Read Logcat','Logcat’i aç'),id:'logcat'},
    {label:T('Choose Android SDK','Android SDK seç'),id:'sdk'},
  ];
  if(artemisPath)items.push({label:T('Artemis version','Artemis sürümü'),id:'artemis'});
  const action=await vscode.window.showQuickPick(items,{title:T('Android tools','Android araçları')});
  if(!action)return;
  if(action.id==='sdk')return chooseAndroidSdk();
  if(action.id==='assembleDebug'||action.id==='installDebug'){
    if(!workspace||!vscode.workspace.isTrusted){void vscode.window.showWarningMessage(T('Open a trusted Android project first.','Önce güvenilen bir Android projesi açın.'));return;}
    const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:action.label,cancellable:true},async(_,token)=>{
      const controller=new AbortController();const cancel=token.onCancellationRequested(()=>controller.abort());
      try{return await runExtraTool({
        workspace,permission:'ask',signal:controller.signal,inside:relative=>path.resolve(workspace,relative),
        confirm:async(message,detail,button)=>await vscode.window.showWarningMessage(message,{modal:true,detail},button)===button,
        activity:()=>{},write:async()=>{throw Error('Android tools do not write files directly.');},
      },'android_build',{task:action.id});}finally{cancel.dispose();}
    });
    await showResult(result);
    return;
  }
  if(action.id==='emulator'){
    const exe=path.join(androidSdkPath(),'emulator',process.platform==='win32'?'emulator.exe':'emulator');
    const result=await run(exe,['-list-avds'],cwd,8000);
    const names=result.out.split(/\r?\n/).map(name=>name.trim()).filter(name=>/^[\w.-]+$/.test(name));
    if(result.code!==0||!names.length){void vscode.window.showWarningMessage(T('No Android virtual device found in this SDK.','Bu SDK’da Android sanal cihazı bulunamadı.'));return;}
    const name=await vscode.window.showQuickPick(names,{title:action.label});
    if(!name)return;
    const child=spawn(exe,['-avd',name],{cwd,windowsHide:true,stdio:'ignore',detached:true});
    child.on('error',error=>void vscode.window.showErrorMessage(error.message));child.unref();
    return;
  }
  const result=action.id==='artemis'&&artemisPath?await run(artemisPath,['--version'],cwd,8000):await run(adbPath(),['logcat','-d','-t','200'],cwd,10000);
  await showResult(result.out);
}

async function showResult(content:string|undefined){
  const text=String(content||'').trim();
  if(/^No Android project/.test(text)){void vscode.window.showWarningMessage(T('No Android project was found in this folder (needs gradlew and settings.gradle). Open an Android project first.','Bu klasörde Android projesi bulunamadı (gradlew ve settings.gradle gerekir). Önce bir Android projesi açın.'));return;}
  if(/^(adb|Android SDK|Gradle)[^\n]{0,80}(not found|bulunamadı)/i.test(text)||(/ENOENT/.test(text)&&text.length<300)){void vscode.window.showWarningMessage(T('Android SDK tools were not found. Choose the SDK folder in Cude Settings → Android.','Android SDK araçları bulunamadı. Cude Ayarları → Android bölümünden SDK klasörünü seçin.'));return;}
  if(/^(Declined|The user declined|Kullanıcı)/.test(text)){return;}
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'log',content:content||T('No output.','Çıktı yok.')}),{preview:true});
}

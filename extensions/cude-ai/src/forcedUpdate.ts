import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fetchSignedRelease,compareVersions,type ReleaseManifest,type ReleaseCheckpoint} from './releaseClient';
import {readReleaseTrust} from './releaseTrust';
import {verifyExtensionIntegrity} from './extensionIntegrity';
import {activityGate,requiresUpdate,verifiedInstall} from './updatePolicy';
import {launchUpdate} from './updateInstaller';
const EN_TEXT:Record<string,string>={'Şimdi güncelle':'Update now','Sonra':'Later','Güncellemeler':'Updates','Cude IDE güncel':'Cude IDE is up to date',' güncellemesi hazır.':' update is ready.','Bu sürümün kullanımı kapatıldı. Devam etmek için güncelleyin.':'This version is disabled. Update to continue.','Cude IDE güncellemesi zorunlu.':'A Cude IDE update is required.','Cude IDE güncellemesi':'Cude IDE update','Cude IDE’yi yeniden kurun.':'Please reinstall Cude IDE.','Cude IDE’yi yeniden kurun: paket yayın anahtarı eksik.':'Please reinstall Cude IDE: the release key is missing from this package.','Cude cihaz ve bütünlük kontrolü sürüyor.':'Checking this device and the app files…','Devam etmek için Cude IDE’yi güncelleyin.':'Update Cude IDE to continue.','Devam etmek için güncelleme gerekiyor. Cude IDE geçici olarak kilitli.':'An update is needed to continue. Cude IDE is locked until then.','Devam etmek için güncelleyin.':'Update to continue.','Güncelleme denetlenemedi.':'Could not check for updates.','Güncelleme doğrulanamadı; kurulum başlatılmadı.':'The update could not be verified, so it was not installed.','Güvenilir yayın anahtarı eksik. Cude IDE’yi yeniden kurun.':'The trusted release key is missing. Please reinstall Cude IDE.','Güvenilir yayın anahtarı eksik.':'The trusted release key is missing.','Yayın kanalı daha yeni bir sürüm sunmuyor.':'No newer version is available yet.','Yayın kanalı gerekli sürümü henüz sunmuyor.':'The required version is not available yet.','Yeni Cude IDE sürümü indirilmeye hazır.':'A new Cude IDE version is ready to download.','İndiriliyor ve SHA-256 doğrulanıyor…':'Downloading and verifying (SHA-256)…'};
function T(text:string){return vscode.workspace.getConfiguration('cude-ai').get<string>('language','en')==='tr'?text:(EN_TEXT[text]??text);}
function isTurkish(){return vscode.workspace.getConfiguration('cude-ai').get<string>('language','en')==='tr';}

export function updateCheckMessage(error: unknown, turkish: boolean): string {
 const name = error instanceof Error ? error.name : '';
 const message = error instanceof Error ? error.message : '';
 if (message === 'The release signature is invalid.' || message === 'Invalid signed release manifest.') {
  return turkish ? 'Güncellemenin imzası doğrulanamadı.' : 'The update signature could not be verified.';
 }
 if (name === 'SyntaxError' || message === 'The archive URL does not match the trusted release feed.' || message === 'Older or conflicting release manifest.' || message === 'The release manifest is outside its validity period.') {
  return turkish ? 'Güncelleme kanalı geçersiz bir yayın sundu.' : 'The update channel returned an invalid release.';
 }
 if (name === 'TimeoutError' || name === 'AbortError' || message === 'fetch failed' || message === 'Could not read the release manifest.' || message === 'The release archive could not be downloaded.') {
  return turkish ? 'Güncelleme kanalına ulaşılamadı. Bağlantınızı denetleyip tekrar deneyin.' : 'Could not reach the update channel. Check your connection and try again.';
 }
 return turkish ? 'Güncelleme denetlenemedi.' : 'Could not check for updates.';
}

export {activityGate} from './updatePolicy';
let ready:Promise<void>=Promise.resolve(),active:vscode.ExtensionContext|undefined,panel:vscode.WebviewPanel|undefined;
let updateStatus:vscode.StatusBarItem|undefined;
function refreshUpdateButton(){if(!updateStatus)return;updateStatus.text=(heartbeatUpdateState()==='current'?'$(versions) ':'$(circle-filled) ')+T('Güncellemeler');updateStatus.tooltip=T('Cude IDE güncellemesi');}
function updateMessage(){
 const current=String(active?.extension.packageJSON.version||'0.0.0');
 if(startupFailure==='missing-key')return T('Cude IDE’yi yeniden kurun: paket yayın anahtarı eksik.');
 if(startupFailure==='integrity')return isTurkish()
  ? 'Cude IDE paket bütünlüğü doğrulanamadı. Cude IDE’yi yeniden kurun.'
  : 'The Cude IDE package could not be verified. Reinstall Cude IDE.';
 if(checkError) return checkError==='missing-key'?T('Güvenilir yayın anahtarı eksik.'):updateCheckMessage(checkError,isTurkish());
 if(locked) return T('Devam etmek için güncelleyin.');
 if(!next) return isTurkish()?'Güncelleme kanalı denetleniyor…':'Checking the update channel…';
 return heartbeatUpdateState()==='current' ? T('Cude IDE güncel')+' · '+current : T('Yeni Cude IDE sürümü indirilmeye hazır.');
}
export function openUpdates(){show(updateMessage());}
let sideView:vscode.WebviewView|undefined;
function renderSide(){if(!sideView)return;sideView.webview.html=updateHtml(updateMessage(),next);const state=heartbeatUpdateState();sideView.badge=state==='current'?undefined:{value:1,tooltip:T('Yeni Cude IDE sürümü var')};}
export function hasUpdatesPanel(){return !!panel;}
let locked=false,enforcing=false,shuttingDown=false;
let checkError:unknown;
let startupFailure:'missing-key'|'integrity'|undefined;
let next:ReleaseManifest|undefined,checking:Promise<void>|undefined,installing=false,lastChecked=0,lastCheckOk=false;
export function heartbeatUpdateState():'current'|'available'|'required'{const current=String(active?.extension.packageJSON.version||'0.0.0');return active?.globalState.get<string>('cude.update.required')||next&&requiresUpdate(current,next)?'required':next&&compareVersions(next.version,current)>0?'available':'current';}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function updateHtml(message:string,manifest?:ReleaseManifest){
 const nonce=randomBytes(16).toString('hex'),tr=vscode.workspace.getConfiguration('cude-ai').get<string>('language','en')==='tr';
 const available=!!manifest&&compareVersions(manifest.version,String(active?.extension.packageJSON.version||'0.0.0'))>0;
 const checkedText=lastChecked?(tr?'Denetlendi · ':'Checked · ')+new Date(lastChecked).toLocaleTimeString(tr?'tr-TR':'en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+(lastCheckOk?(available?(tr?' · yeni sürüm hazır':' · new version ready'):(tr?' · en güncel sürüm':' · latest version')):(tr?' · bağlantı kurulamadı':' · could not reach the channel')):'';
 const label=available?(tr?'Şimdi güncelle':'Update now'):(tr?'Şimdi denetle':'Check now'),kicker=tr?'Güncelleme':'Update';
 return `<!doctype html><html lang="${tr?'tr':'en'}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,rgba(214,155,112,.16),transparent 60%),#0e0e0d;color:#f2efe8;font:15px/1.6 var(--vscode-font-family,"Segoe UI",system-ui,sans-serif)}
main{box-sizing:border-box;width:min(560px,calc(100% - 32px));padding:clamp(16px,7vw,40px);min-width:0;overflow-wrap:anywhere;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:linear-gradient(180deg,#1b1b18,#161614);box-shadow:0 30px 80px rgba(0,0,0,.45)}
.mark{width:52px;height:52px;color:#d69b70;filter:drop-shadow(0 6px 18px rgba(214,155,112,.35))}.mark svg{width:100%;height:100%;fill:currentColor}
.kicker{margin-top:22px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8d8b83}h1{margin:4px 0 10px;font-size:26px;font-weight:650;letter-spacing:-.01em}
p{margin:0;color:#c9c5bb}pre{margin:16px 0 0;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.04);color:#c9c5bb;font:13px/1.55 var(--vscode-editor-font-family,Consolas,monospace);white-space:pre-wrap;max-height:180px;overflow:auto}pre:empty{display:none}
button{margin-top:24px;width:100%;padding:12px 18px;border:0;border-radius:10px;background:#d69b70;color:#1a120c;font:600 15px var(--vscode-font-family,"Segoe UI",sans-serif);cursor:pointer;transition:filter .15s}button:hover{filter:brightness(1.07)}button:disabled{opacity:.45;cursor:default}
.bar{margin-top:16px;height:6px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden}.bar i{display:block;height:100%;width:0;background:#d69b70;transition:width .2s}#status{margin-top:12px;min-height:22px;font-size:13px;color:#e3b48f}
:root{color-scheme:light dark}
body.vscode-light,body.vscode-high-contrast-light{background:radial-gradient(1200px 600px at 50% -10%,rgba(197,130,80,.14),transparent 60%),var(--vscode-editor-background,#fbfbf9);color:#23231f}
body.vscode-light main,body.vscode-high-contrast-light main{border-color:rgba(0,0,0,.09);background:linear-gradient(180deg,#ffffff,#f6f4ef);box-shadow:0 24px 60px rgba(60,40,20,.12)}
body.vscode-light .mark{color:#b8713f}body.vscode-light .kicker{color:#6f6d65}body.vscode-light p,body.vscode-light pre{color:#3d3b35}body.vscode-light pre{background:rgba(0,0,0,.04)}
body.vscode-light button{background:#c58250}body.vscode-light .bar{background:rgba(0,0,0,.08)}body.vscode-light .bar i{background:#c58250}body.vscode-light #status{color:#8a4a1f}
button{transition:transform .18s cubic-bezier(.2,.8,.2,1),filter .15s,box-shadow .2s}button:not(:disabled):hover{transform:translateY(-1px);box-shadow:0 8px 22px -10px rgba(214,155,112,.7)}button:not(:disabled):active{transform:translateY(1px) scale(.985)}
button.busy{position:relative;color:transparent!important}button.busy::after{content:'';position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid rgba(26,18,12,.35);border-top-color:#1a120c;animation:cudeSpin .7s linear infinite}
.mark{animation:cudeFloat 4s ease-in-out infinite}#status.fresh{animation:cudeFade .5s ease-out}
@keyframes cudeSpin{to{transform:rotate(360deg)}}@keyframes cudeFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}@keyframes cudeFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* Cude theme palette: keep host blue out of webview controls. */
body {
  --cude-accent:#d69b70; --cude-on-accent:#090604; --cude-link:#d69b70;
  --cude-bg:#141513; --cude-surface:#1e201c; --cude-raised:#282b25;
  --cude-text:#f1f0e9; --cude-muted:#b6b7ae; --cude-border:#777b70;
  --cude-positive:#a8d5aa; --cude-negative:#ffb4ab; --cude-warning:#e8c982;
  color-scheme:dark;
}
body.vscode-light, body.vscode-high-contrast-light {
  --cude-accent:#b8632f; --cude-on-accent:#090604; --cude-link:#91471f;
  --cude-bg:#fbfaf7; --cude-surface:#ffffff; --cude-raised:#efede7;
  --cude-text:#252720; --cude-muted:#55594f; --cude-border:#7b8073;
  --cude-positive:#286335; --cude-negative:#a32a28; --cude-warning:#715309;
  color-scheme:light;
}
body.vscode-high-contrast {
  --cude-bg:#000000; --cude-surface:#000000; --cude-raised:#171717;
  --cude-text:#ffffff; --cude-muted:#e0e0e0; --cude-border:#ffffff;
  color-scheme:dark;
}
body.vscode-high-contrast-light { --cude-border:#252720; }
body {
  --accent:var(--cude-accent); --copper:var(--cude-accent); --copper2:var(--cude-accent);
  --bg:var(--cude-bg); --surface:var(--cude-surface); --raised:var(--cude-raised);
  --text:var(--cude-text); --ink:var(--cude-text); --muted:var(--cude-muted); --quiet:var(--cude-muted);
  --line:var(--cude-border); --edge:var(--cude-border);
  --positive:var(--cude-positive); --negative:var(--cude-negative);
  --vscode-foreground:var(--cude-text); --vscode-sideBar-foreground:var(--cude-text);
  --vscode-descriptionForeground:var(--cude-muted); --vscode-disabledForeground:var(--cude-muted);
  --vscode-editor-background:var(--cude-bg); --vscode-sideBar-background:var(--cude-bg);
  --vscode-input-background:var(--cude-surface); --vscode-input-foreground:var(--cude-text);
  --vscode-editorWidget-background:var(--cude-raised); --vscode-quickInput-background:var(--cude-raised);
  --vscode-panel-border:var(--cude-border); --vscode-input-border:var(--cude-border);
  --vscode-button-background:var(--cude-accent); --vscode-button-foreground:var(--cude-on-accent);
  --vscode-button-hoverBackground:var(--cude-accent);
  --vscode-button-secondaryBackground:var(--cude-raised); --vscode-button-secondaryForeground:var(--cude-text);
  --vscode-button-secondaryHoverBackground:var(--cude-surface);
  --vscode-textLink-foreground:var(--cude-link); --vscode-textLink-activeForeground:var(--cude-link);
  --vscode-list-hoverBackground:var(--cude-raised);
  --vscode-list-activeSelectionBackground:var(--cude-accent); --vscode-list-activeSelectionForeground:var(--cude-on-accent);
  --vscode-list-inactiveSelectionBackground:var(--cude-raised); --vscode-list-inactiveSelectionForeground:var(--cude-text);
  --vscode-editor-selectionBackground:var(--cude-accent);
  --vscode-testing-iconPassed:var(--cude-positive); --vscode-errorForeground:var(--cude-negative);
  --vscode-editorWarning-foreground:var(--cude-warning);
  background:var(--cude-bg); color:var(--cude-text);
}
::selection { background:var(--cude-accent); color:var(--cude-on-accent); }
a, .file-link { color:var(--cude-link); text-decoration-color:var(--cude-accent); }
input, select, textarea, progress { accent-color:var(--cude-accent); }
:focus-visible { outline:2px solid var(--cude-accent)!important; outline-offset:2px; }
input::placeholder, textarea::placeholder { color:var(--cude-muted); opacity:1; }
button:disabled, button.action:disabled { opacity:1; filter:none; color:var(--cude-muted); background:var(--cude-raised); border-color:var(--cude-border); }
body.vscode-high-contrast :is(button,input,select,textarea), body.vscode-high-contrast-light :is(button,input,select,textarea) { border:1px solid var(--cude-border); forced-color-adjust:none; }

body main { background:var(--cude-surface); border-color:var(--cude-border); }
body .mark, body #status { color:var(--cude-link); }
body .kicker, body p, body pre { color:var(--cude-muted); }
body pre, body .bar { background:var(--cude-raised); }
body button, body.vscode-light button, body .bar i, body.vscode-light .bar i { background:var(--cude-accent); color:var(--cude-on-accent); }
body.vscode-light main, body.vscode-high-contrast-light main { background:var(--cude-surface); border-color:var(--cude-border); }
body.vscode-light .mark, body.vscode-light #status { color:var(--cude-link); }
body.vscode-light .kicker, body.vscode-light p, body.vscode-light pre { color:var(--cude-muted); }

/* Shared Cude component geometry and interaction. */
body {
  --cude-control-height:32px; --cude-control-radius:6px;
  --cude-card-radius:8px; --cude-card-min-height:96px;
  --cude-badge-height:22px; --cude-motion:120ms ease;
}
body :is(button, select, input:not([type=checkbox]):not([type=radio]), textarea) {
  box-sizing:border-box; border-radius:var(--cude-control-radius);
  font-size:13px; line-height:18px;
  transition:background-color var(--cude-motion),border-color var(--cude-motion),color var(--cude-motion),transform var(--cude-motion);
}
body :is(button, select, input:not([type=checkbox]):not([type=radio])) {
  height:var(--cude-control-height); min-height:var(--cude-control-height); padding-block:6px;
}
body button:not(:disabled):hover { filter:none; transform:none; box-shadow:none; border-color:var(--cude-accent); }
body button:not(:disabled):active { transform:translateY(1px); }
body :is(button,input,select,textarea,summary):focus-visible {
  outline:2px solid var(--cude-accent)!important; outline-offset:2px;
}
body textarea:not([hidden]) { min-height:72px; }
body button.entry { height:auto; min-height:56px; }
body :is(.icon,.send) { width:32px; flex-basis:32px; padding:0; }
body .file-link { display:inline; height:auto; min-height:0; padding:0; border-radius:0; font:inherit; }
body :is(.card,.setup-card,.plan,.changes,.command-approval,.model-card,.free-card,.cli-card,.support-card,.team-area,.step,.hero,.cu-box,.pool-model) {
  box-sizing:border-box; min-height:var(--cude-card-min-height); border-radius:var(--cude-card-radius);
  border:1px solid var(--cude-border); padding:12px; background:var(--cude-surface);
  transition:background-color var(--cude-motion),border-color var(--cude-motion);
}
body :is(.step,.card,.model-card,.free-card,.cli-card):hover { transform:none; box-shadow:none; border-color:var(--cude-accent); }
body :is(.badge,.tag,.kicker,.code-lang,.card-head .count,.tab .count) {
  box-sizing:border-box; display:inline-flex; align-items:center; min-height:var(--cude-badge-height);
  padding:1px 6px; border-radius:var(--cude-control-radius); font-size:11px; line-height:18px;
}
body input[type=checkbox]:not(.switch):not(.switch input), body input[type=radio] {
  box-sizing:border-box; width:16px; height:16px; min-height:16px; padding:0;
  flex:0 0 16px; border-radius:3px; cursor:pointer; appearance:none;
  border:1px solid var(--cude-border); background:var(--cude-surface);
}
body input[type=checkbox]:not(.switch):not(.switch input):checked {
  background-color:var(--cude-accent); border-color:var(--cude-accent);
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m3 8 3 3 7-7' fill='none' stroke='%23090604' stroke-width='2'/%3E%3C/svg%3E");
}
body input[type=radio] { border-radius:50%; }
body input[type=radio]:checked { background:var(--cude-accent); box-shadow:inset 0 0 0 3px var(--cude-surface); }
body :is(button.primary,button.approve,button.setup-primary) { color:var(--cude-on-accent); background:var(--cude-accent); }
body :is(button.secondary,button.action:not(.primary),button.reject) { color:var(--cude-text); background:var(--cude-raised); border:1px solid var(--cude-border); }
body input.switch, body .switch input {
  appearance:none; box-sizing:border-box; width:38px!important; height:22px; min-height:22px;
  flex:0 0 38px; padding:0!important; border:1px solid var(--cude-border)!important; border-radius:11px!important;
  background:var(--cude-raised)!important; position:relative; cursor:pointer;
  transition:background-color var(--cude-motion),border-color var(--cude-motion);
}
body input.switch::before, body .switch input::before {
  content:''; position:absolute; width:14px; height:14px; top:3px; left:3px;
  border-radius:50%; background:var(--cude-text); transition:left var(--cude-motion);
}
body input.switch:checked, body .switch input:checked { background:var(--cude-accent)!important; border-color:var(--cude-accent)!important; }
body input.switch:checked::before, body .switch input:checked::before { left:19px; background:var(--cude-on-accent); }
@media (prefers-reduced-motion:reduce) {
  body *, body *::before, body *::after { transition:none!important; animation:none!important; }
}

body main { min-height:var(--cude-card-min-height); border-radius:var(--cude-card-radius); }
</style><main><div class="mark"><svg viewBox="0 0 557 557" aria-hidden="true"><path fill-rule="evenodd" d="M495,373 L488,366 L480,362 L465,361 L459,363 L294,463 L289,470 L290,524 L294,527 L301,527 L485,417 L495,407 L500,395 L500,385Z M219,195 L209,200 L201,212 L201,226 L205,234 L212,241 L275,285 L273,289 L208,330 L203,336 L200,343 L200,356 L203,363 L211,371 L226,375 L238,371 L342,307 L348,301 L352,293 L353,282 L350,273 L343,265 L236,196Z M288,29 L270,29 L255,35 L75,146 L64,156 L55,176 L55,389 L61,405 L74,419 L253,527 L262,526 L266,520 L266,472 L264,467 L259,462 L119,379 L114,372 L113,200 L117,192 L266,100 L278,95 L287,97 L460,204 L475,205 L486,201 L493,195 L500,180 L498,163 L491,152 L485,147 L303,35Z"/></svg></div><div class="kicker">${kicker}</div><h1>Cude IDE ${manifest?escape(manifest.version):''}</h1><p>${escape(message)}</p><pre>${escape(manifest?.notes||'')}</pre><button id="update" >${label}</button><div class="bar"><i id="progress"></i></div><p id="status" role="status"></p></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();const st=document.getElementById('status');if(st&&!st.textContent&&${JSON.stringify(checkedText)}){st.textContent=${JSON.stringify(checkedText)};st.classList.add('fresh');}document.getElementById('update').onclick=()=>{const b=document.getElementById('update');b.disabled=true;b.classList.add('busy');if(st)st.textContent='${tr?'Denetleniyor…':'Checking…'}';vscode.postMessage({type:'${available?'install':'check'}'});};window.addEventListener('message',e=>{if(e.data.type==='progress'){document.getElementById('progress').style.width=Math.max(0,Math.min(100,Number(e.data.value)||0))+'%';}if(e.data.type==='status'){document.getElementById('status').textContent=e.data.message;document.getElementById('update').disabled=false;document.getElementById('update').classList.remove('busy');}});</script></html>`;
}

async function enforceLock(){
 if(locked||!active)return;locked=true;enforcing=true;
 await vscode.commands.executeCommand('setContext','cude.updateLock',true);
 for(const terminal of vscode.window.terminals)terminal.dispose();
 for(const group of vscode.window.tabGroups.all)for(const tab of group.tabs){if(tab.input instanceof vscode.TabInputText){try{await vscode.window.showTextDocument(tab.input.uri);await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');}catch{}}}
 const cleanTabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs.filter(tab=>!tab.isDirty));
 if(cleanTabs.length)await vscode.window.tabGroups.close(cleanTabs,true);
 enforcing=false;show(T('Devam etmek için güncelleyin.'));
}
function show(message:string){
 if(!active)return;
 if(!panel){
  panel=vscode.window.createWebviewPanel('cude.update',T('Cude IDE güncellemesi'),vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
  panel.onDidDispose(()=>{panel=undefined;if(locked&&!shuttingDown)setTimeout(()=>show(T('Devam etmek için güncelleyin.')),0);});
  panel.webview.onDidReceiveMessage(async m=>{if(m?.type==='check')await checkForcedUpdate();if(m?.type==='install'){if(next)await install();else await checkForcedUpdate();}});
 }
 panel.webview.html=updateHtml(message,next);panel.reveal();
}
async function install(){
 if(!active||!next||installing)return;installing=true;
 try{
  // Refresh the signature and expiry immediately before downloading.
  const trust=await readReleaseTrust(active);if(!trust)throw Error(T('Güvenilir yayın anahtarı eksik.'));
  const slot='cude.release.sequence.'+trust.fingerprint+'.'+trust.feed;
  const release=await fetchSignedRelease(trust,active.globalState.get<ReleaseCheckpoint>(slot),AbortSignal.timeout(15000));
  await active.globalState.update(slot,release.checkpoint);
  if(compareVersions(release.manifest.version,String(active.extension.packageJSON.version))<=0)throw Error(T('Yayın kanalı daha yeni bir sürüm sunmuyor.'));
  const minimum=active.globalState.get<string>('cude.update.required');
  if(minimum&&compareVersions(release.manifest.version,minimum)<0)throw Error(T('Yayın kanalı gerekli sürümü henüz sunmuyor.'));
  const folder=path.join(active.globalStorageUri.fsPath,'updates',randomBytes(12).toString('hex'));await fs.mkdir(folder,{recursive:true});
  const target=path.join(folder,'Cude-IDE-'+release.manifest.version+'-win32-x64.zip');
  panel?.webview.postMessage({type:'status',message:T('İndiriliyor ve SHA-256 doğrulanıyor…')});
  await verifiedInstall(release.manifest,target,AbortSignal.timeout(15*60000),async file=>{
   await launchUpdate(file,folder);await vscode.commands.executeCommand('workbench.action.quit');
  },fetch,(received,total)=>{void panel?.webview.postMessage({type:'progress',value:100*received/total});});
 }catch(e){
  const turkish=isTurkish(),message=e instanceof Error?e.message:'';
  const policy=['Güvenilir yayın anahtarı eksik.','Yayın kanalı daha yeni bir sürüm sunmuyor.','Yayın kanalı gerekli sürümü henüz sunmuyor.']
    .find(text=>text===message||EN_TEXT[text]===message);
  const reason=updateCheckMessage(e,turkish);
  void panel?.webview.postMessage({type:'status',message:policy?T(policy):reason===T('Güncelleme denetlenemedi.')
    ?T('Güncelleme doğrulanamadı; kurulum başlatılmadı.'):reason});
 }
 finally{installing=false;}
}
export function assertCommandAllowed(){if(locked)activityGate.assertAllowed();}
export async function assertActivityAllowed(){await ready;activityGate.assertAllowed();}
export async function observeUpgradeResponse(response:any){
 if(response.status!==426||!active)return;
 let minimum='';try{const b=await response.clone().json();minimum=b.minimumVersion||b.minimum||'';}catch{}
 activityGate.block(T('Devam etmek için Cude IDE’yi güncelleyin.'));
 await enforceLock();
 if(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(minimum))await active.globalState.update('cude.update.required',minimum);
 show(T('Bu sürümün kullanımı kapatıldı. Devam etmek için güncelleyin.'));
 void checkForcedUpdate();
}
export function checkForcedUpdate():Promise<void>{
 if(checking)return checking;
 checking=(async()=>{
  if(!active)return;
  const context=active,trust=await readReleaseTrust(context);
  if(!trust){checkError='missing-key';if(activityGate.blocked)show(T('Güvenilir yayın anahtarı eksik. Cude IDE’yi yeniden kurun.'));return;}
  const slot='cude.release.sequence.'+trust.fingerprint+'.'+trust.feed;
  const result=await fetchSignedRelease(trust,context.globalState.get<ReleaseCheckpoint>(slot),AbortSignal.timeout(15000),undefined,String(context.extension.packageJSON.version));
  await context.globalState.update(slot,result.checkpoint);next=result.manifest;checkError=undefined;
  const current=String(context.extension.packageJSON.version),cached=context.globalState.get<string>('cude.update.required');
  if(requiresUpdate(current,next)||(cached&&compareVersions(current,cached)<0)){
   const candidate=requiresUpdate(current,next)?(next.mandatory?next.version:next.minimumVersion!):cached!;
   const minimum=cached&&compareVersions(cached,candidate)>0?cached:candidate;
   await context.globalState.update('cude.update.required',minimum);
   activityGate.block(T('Devam etmek için Cude IDE’yi güncelleyin.'));await enforceLock();show(T('Devam etmek için güncelleme gerekiyor. Cude IDE geçici olarak kilitli.'));
  }else if(compareVersions(next.version,current)>0){
   void vscode.window.showInformationMessage('Cude IDE '+next.version+T(' güncellemesi hazır.'),T('Şimdi güncelle'),T('Sonra')).then(action=>{
    if(action===T('Şimdi güncelle'))show(T('Yeni Cude IDE sürümü indirilmeye hazır.'));
   });
  }
 })().catch(e=>{
  checkError=e instanceof Error ? e : new Error();
  if(activityGate.blocked)show(updateMessage());
  else console.warn('[Cude] Update check unavailable.');
 }).finally(()=>{
  checking=undefined;lastChecked=Date.now();lastCheckOk=!checkError;refreshUpdateButton();renderSide();
  if(panel&&!installing)panel.webview.html=updateHtml(updateMessage(),next);
 });
 return checking;
}
export function initializeForcedUpdate(context:vscode.ExtensionContext){
 active=context;
 startupFailure=undefined;
 updateStatus=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,100);updateStatus.command='cude-ai.openUpdates';const tint=()=>{if(!updateStatus)return;const kinds=(vscode as any).ColorThemeKind,kind=(vscode.window as any).activeColorTheme?.kind;updateStatus.color=kinds&&(kind===kinds.Light||kind===kinds.HighContrastLight)?'#8a4a1f':'#d69b70';};tint();const themeEvent=(vscode.window as any).onDidChangeActiveColorTheme;if(typeof themeEvent==='function')context.subscriptions.push(themeEvent(tint));refreshUpdateButton();updateStatus.show();
 if(typeof (vscode.window as any).registerWebviewViewProvider==='function')context.subscriptions.push(vscode.window.registerWebviewViewProvider('cude-ai.updatesView',{resolveWebviewView(view){sideView=view;view.webview.options={enableScripts:true};view.webview.onDidReceiveMessage(async m=>{if(m?.type==='check')await checkForcedUpdate();if(m?.type==='install'){if(next)await install();else await checkForcedUpdate();}renderSide();});view.onDidDispose(()=>{if(sideView===view)sideView=undefined;});view.onDidChangeVisibility(()=>{if(view.visible)renderSide();});renderSide();}}));
 context.subscriptions.push(updateStatus,vscode.commands.registerCommand('cude-ai.openUpdates',openUpdates),vscode.workspace.onDidChangeConfiguration(e=>{
  if(!e.affectsConfiguration('cude-ai.language'))return;
  refreshUpdateButton();
  if(panel&&!installing){panel.title=T('Cude IDE güncellemesi');panel.webview.html=updateHtml(updateMessage(),next);}
 }));
 activityGate.block(T('Cude cihaz ve bütünlük kontrolü sürüyor.'));
 ready=(async()=>{
  try{
   const current=String(context.extension.packageJSON.version),trust=await readReleaseTrust(context);
   if(context.extensionMode===1&&!trust){startupFailure='missing-key';throw Error(updateMessage());}
   if(trust)await verifyExtensionIntegrity(context.extensionPath,trust.key,current);
   // Pool enrollment loads device identity on demand.
   activityGate.allow();
   const minimum=context.globalState.get<string>('cude.update.required');
   if(minimum&&compareVersions(current,minimum)<0){activityGate.block(T('Cude IDE güncellemesi zorunlu.'));await enforceLock();show(T('Devam etmek için güncelleyin.'));}
   else if(minimum)await context.globalState.update('cude.update.required',undefined);
   await checkForcedUpdate();
  }catch{
   startupFailure??='integrity';
   const message=updateMessage();
   activityGate.block(message);
   show(message);
  }
 })();
 const timer=setInterval(()=>{void checkForcedUpdate();},15*60000);timer.unref();
 context.subscriptions.push(vscode.window.onDidOpenTerminal(terminal=>{if(locked)terminal.dispose();}),vscode.window.onDidChangeActiveTextEditor(editor=>{if(locked&&!enforcing&&editor){void vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');show(T('Devam etmek için güncelleyin.'));}}),{dispose:()=>{shuttingDown=true;clearInterval(timer);panel?.dispose();active=undefined;}});
}

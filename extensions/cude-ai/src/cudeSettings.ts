import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

type Item={id:string; title:string; value?:string|number|boolean; options?:string[]; labels?:Record<string,string>; input?:'number'|'select'|'toggle'; detail?:string};
type Section={title:string; items:Item[]};
const actions:Record<string,readonly [string,...string[]]> = {
  theme:['workbench.action.selectTheme'], providers:['cude-ai.configureProvider'], local:['cude-ai.onboardingLocal'],
  apps:['cude-ai.onboardingAgents'], bridge:['cude-ai.connectDesktopApps'], android:['cude-ai.android'], sdk:['cude-ai.androidSdk'],
  updates:['cude-ai.openUpdates'], raw:['workbench.action.openSettingsJson'], desktopApps:['cude-ai.showDesktopApps'],
};

export function createCudeSettings(context:vscode.ExtensionContext,onPermission:(value:'ask'|'auto'|'plan'|'readonly')=>void){
  let panel:vscode.WebviewPanel|undefined;
  const config=vscode.workspace.getConfiguration;
  const language=()=>config('cude-ai').get<string>('language','en');
  const T=(en:string,tr:string)=>language()==='tr'?tr:en;
  const sections=():Section[]=>[
    {title:T('General','Genel'),items:[
      {id:'language',title:T('Language','Dil'),input:'select',options:['en','tr'],value:language()},
      {id:'theme',title:T('Color theme','Renk teması'),value:config('workbench').get<string>('colorTheme')},
      {id:'fontSize',title:T('Editor font size','Editör yazı boyutu'),input:'number',value:config('editor').get<number>('fontSize',14)},
      {id:'autoSave',title:T('Auto save','Otomatik kaydet'),input:'select',options:['off','afterDelay','onFocusChange','onWindowChange'],labels:{off:T('Off','Kapalı'),afterDelay:T('After a delay','Kısa gecikmeyle'),onFocusChange:T('When focus changes','Odak değişince'),onWindowChange:T('When the window changes','Pencere değişince')},value:config('files').get<string>('autoSave','off')},
    ]},
    {title:T('Models and providers','Modeller ve sağlayıcılar'),items:[{id:'providers',title:T('Manage connections','Bağlantıları yönet')}]},
    {title:T('Local models','Yerel modeller'),items:[{id:'local',title:T('Manage local models','Yerel modelleri yönet')}]},
    {title:T('Agent permissions','Ajan izinleri'),items:[{id:'permission',title:T('Permission for this workspace','Bu çalışma alanındaki izin'),input:'select',options:['ask','auto','plan','readonly'],labels:{ask:T('Ask before edits and commands','Düzenleme ve komutlarda sor'),auto:T('Automatic','Otomatik'),plan:T('Plan only','Yalnız plan'),readonly:T('Read only','Salt okunur')},value:context.workspaceState.get('permission','auto')}]},
    {title:T('Computer and browser control','Bilgisayar ve tarayıcı kontrolü'),items:[
      {id:'computerUse',title:T('Computer use (see windows, click, type; every action asks first)','Bilgisayar kullanımı (pencereleri gör, tıkla, yaz; her eylem önce sorar)'),input:'toggle',value:config('cude-ai').get<boolean>('computer.enabled',false)},
      {id:'browserControl',title:T('Browser control (separate Cude profile)','Tarayıcı kontrolü (ayrı Cude profili)'),input:'toggle',value:config('cude-ai').get<boolean>('browser.enabled',false)},
      {id:'desktopApps',title:T('Desktop apps on this computer','Bu bilgisayardaki masaüstü uygulamaları')},
    ]},
    {title:T('Agents and apps','Ajanlar ve uygulamalar'),items:[{id:'apps',title:T('Agent apps','Ajan uygulamaları')},{id:'bridge',title:T('Connect desktop apps','Masaüstü uygulamalarını bağla')}]},
    {title:'Android',items:[{id:'sdk',title:T('Choose Android SDK','Android SDK seç'),value:config('cude-ai').get<string>('android.sdkPath')},{id:'android',title:T('Build and device tools','Derleme ve cihaz araçları')}]},
    {title:T('Updates','Güncellemeler'),items:[{id:'updates',title:T('Check for updates','Güncellemeleri denetle')}]},
    {title:T('Privacy','Gizlilik'),items:[{id:'privacy',title:T('Provider credentials','Sağlayıcı anahtarları'),detail:T('Provider keys are stored in the IDE secret store. A provider receives the prompt and context you send to it.','Sağlayıcı anahtarları IDE’nin gizli deposunda saklanır. Sağlayıcıya gönderdiğiniz istem ve bağlam iletilir.')}]},
    {title:T('Advanced','Gelişmiş'),items:[{id:'raw',title:T('Edit settings JSON','Ham ayarları düzenle')}]},
  ];
  const publish=()=>void panel?.webview.postMessage({sections:sections(),title:T('Cude Settings','Cude Ayarları'),apply:T('Open','Aç')});
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(publish),vscode.window.onDidChangeActiveColorTheme(publish));
  return ()=>{
    if(panel){panel.reveal();return;}
    const nonce=randomBytes(18).toString('hex');
    const view=vscode.window.createWebviewPanel('cudeSettings',T('Cude Settings','Cude Ayarları'),vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[]});
    panel=view;
    view.onDidDispose(()=>{if(panel===view)panel=undefined;});
    view.webview.onDidReceiveMessage(async message=>{
      if(panel!==view)return;
      try {
        if(message?.type==='ready'){publish();return;}
        if(message?.type==='open'&&Object.hasOwn(actions,message.id)){const [id,...args]=actions[message.id];await vscode.commands.executeCommand(id,...args);publish();return;}
        if(message?.type!=='change')return;
        const value=message.value,target=vscode.ConfigurationTarget.Global;
        if(message.id==='language'&&['tr','en'].includes(value))await vscode.commands.executeCommand('cude-ai.onboardingLanguage',value);
        if(message.id==='autoSave'&&['off','afterDelay','onFocusChange','onWindowChange'].includes(value))await config('files').update('autoSave',value,target);
        if(message.id==='fontSize'&&Number.isInteger(value)&&value>=8&&value<=80)await config('editor').update('fontSize',value,target);
        if(message.id==='permission'&&['ask','auto','plan','readonly'].includes(value)){await context.workspaceState.update('permission',value);onPermission(value);}
        if(message.id==='computerUse'&&typeof value==='boolean'){await config('cude-ai').update('computer.enabled',value,target);if(!value)await vscode.commands.executeCommand('cude-ai.stopComputer');}
        if(message.id==='browserControl'&&typeof value==='boolean')await config('cude-ai').update('browser.enabled',value,target);
        publish();
      }catch(error){void vscode.window.showErrorMessage(String(error instanceof Error?error.message:error));publish();}
    });
    view.webview.html=`<!doctype html><html lang="${language()==='tr'?'tr':'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'nonce-${nonce}';script-src 'nonce-${nonce}'"><style nonce="${nonce}">
      *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:14px/1.5 var(--vscode-font-family,system-ui)} main{max-width:900px;margin:auto;padding:clamp(16px,5vw,48px)} h1{margin:0 0 22px;font-size:28px}h2{margin:0 0 8px;font-size:15px}section{padding:16px 0;border-top:1px solid var(--vscode-panel-border)}.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:5px 0}.detail{color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.controls{display:flex;align-items:center;gap:8px;min-width:0}button,input,select{font:inherit;padding:5px 9px;border-radius:6px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));color:var(--vscode-input-foreground);background:var(--vscode-input-background)}button{cursor:pointer;color:#fff;background:var(--cude-accent);border-color:transparent;min-width:64px;font-weight:600;transition:filter .15s,transform .15s}button:hover{filter:brightness(1.08)}button:active{transform:translateY(1px)}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--cude-accent);outline-offset:2px}input[type=number]{width:78px}:root{--cude-accent:#c8743f}body.vscode-light{--cude-accent:#b8632f}select{max-width:260px}.switch{appearance:none;width:38px!important;height:22px;padding:0!important;border-radius:11px!important;border:0!important;background:color-mix(in srgb,var(--vscode-foreground) 25%,transparent)!important;position:relative;cursor:pointer;flex:0 0 38px}.switch:before{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s}.switch:checked{background:var(--cude-accent)!important}.switch:checked:before{left:19px}
    
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

button { background:var(--cude-accent); color:var(--cude-on-accent); }
.switch:before { background:var(--cude-text); }
.switch:checked:before { background:var(--cude-on-accent); }

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

/* Long labels, workspace paths and selected values stay inside the panel. */
body main, body .row > *, body .controls > * { min-width:0; max-width:100%; }
body :is(label,.detail,h1,h2) { overflow-wrap:anywhere; }
body .controls { max-width:100%; flex-wrap:wrap; }
body .controls .detail { flex:1 1 160px; }
body select { min-width:0; max-width:100%; }
body .controls button { flex-shrink:0; }
</style><main><h1 id="title"></h1><div id="content"></div></main><script nonce="${nonce}">
      const api=acquireVsCodeApi(),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
      addEventListener('message',({data})=>{const area=document.getElementById('content');document.getElementById('title').textContent=data.title;area.replaceChildren();
        for(const group of data.sections){const section=el('section');section.append(el('h2',group.title));
          for(const item of group.items){const row=el('div');row.className='row';const label=el('label',item.title);label.htmlFor=item.id;row.append(label);
            if(item.detail){const detail=el('div',item.detail);detail.className='detail';row.append(detail);}
            else if(item.input==='toggle'){const input=el('input');input.type='checkbox';input.className='switch';input.id=item.id;input.setAttribute('role','switch');input.checked=!!item.value;input.onchange=()=>api.postMessage({type:'change',id:item.id,value:input.checked});row.append(input);}
            else if(item.input){const input=el(item.input==='select'?'select':'input');input.id=item.id;
              if(item.options){const values=[...new Set([item.value,...item.options])];for(const value of values){const option=el('option',item.labels?.[value]??(value==='tr'?'Türkçe':value==='en'?'English':value));option.value=value;input.append(option);}}
              else{input.type='number';input.min='8';input.max='80';}
              input.value=item.value;input.onchange=()=>api.postMessage({type:'change',id:item.id,value:item.input==='number'?input.valueAsNumber:input.value});row.append(input);}
            else{const button=el('button',data.apply);button.id=item.id;button.setAttribute('aria-label',item.title);button.onclick=()=>api.postMessage({type:'open',id:item.id});const controls=el('div');controls.className='controls';if(item.value){const value=el('span',item.value);value.className='detail';controls.append(value);}controls.append(button);row.append(controls);}
            section.append(row);
          }area.append(section);
        }
      });api.postMessage({type:'ready'});
    </script></html>`;
  };
}

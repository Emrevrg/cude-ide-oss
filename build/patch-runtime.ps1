param([string]$App)
$ErrorActionPreference='Stop'
$Bundle=Join-Path $App 'out\vs\workbench\workbench.desktop.main.js'
$ProductPath=Join-Path $App 'product.json'
$Text=Get-Content -LiteralPath $Bundle -Raw -Encoding UTF8
# Bridge lives in the command service: catches palette, keybinding and API calls.
$LockFrom='async executeCommand(e,...t){this._logService.trace("CommandService#executeCommand",e);'
$LockToOld='async executeCommand(e,...t){if(e==="setContext"&&t[0]==="cude.updateLock"){globalThis.cudeUpdateLocked=t[1]===true;document.body.classList.toggle("cude-update-lock",globalThis.cudeUpdateLocked)}if(globalThis.cudeRejectUpdateCommand?.(globalThis.cudeUpdateLocked,e))throw new Error("Cude IDE update required");this._logService.trace("CommandService#executeCommand",e);'
$LockTo='async executeCommand(e,...t){globalThis.cudeCommandService??=this;if(e==="setContext"&&t[0]==="cude.onboarding"){globalThis.cudeShowOnboarding?.(t[1]);return}if(e==="setContext"&&t[0]==="cude.updateLock"){globalThis.cudeUpdateLocked=t[1]===true;document.body.classList.toggle("cude-update-lock",globalThis.cudeUpdateLocked)}if(globalThis.cudeRejectUpdateCommand?.(globalThis.cudeUpdateLocked,e))throw new Error("Cude IDE update required");this._logService.trace("CommandService#executeCommand",e);'
if($Text.Contains($LockToOld)){$Text=$Text.Replace($LockToOld,$LockTo)}
if($Text.Contains($LockFrom)){$Text=$Text.Replace($LockFrom,$LockTo)}
$CudeSettingsRoute=$LockTo.Replace('this._logService.trace(', 'if(e==="workbench.action.openSettings"&&!t.length)e="cude-ai.settings";this._logService.trace(')
if($Text.Contains($LockTo)){$Text=$Text.Replace($LockTo,$CudeSettingsRoute)}
if(!$Text.Contains($CudeSettingsRoute)){throw 'Update command-service bridge anchor missing.'}
$Text=[regex]::Replace($Text,'(?s)/\*CUDE-LOCK-BEGIN\*/.*?/\*CUDE-LOCK-END\*/','')
$Text += "`n/*CUDE-LOCK-BEGIN*/`n"+[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'update-lock.js'))+"`n/*CUDE-LOCK-END*/`n"
$Text=[regex]::Replace($Text,'(?s)/\*CUDE-ONBOARD-BEGIN\*/.*?/\*CUDE-ONBOARD-END\*/','')
$Text += "`n/*CUDE-ONBOARD-BEGIN*/`n"+[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'cude-onboarding.js'))+"`n/*CUDE-ONBOARD-END*/`n"
# Avoid serializing both complete extension inventories on the renderer thread.
$Text=$Text.Replace('this.logService.info("Invalidating Cache",n,r)','this.logService.info("Invalidating extension scan cache")')

# Cude AI is a primary settings category. Keep the old settings keys available
# to the configuration service while removing stock Chat and Copilot from this editor.
$SettingsRoot='var WMt={id:"root",label:"root",children:['
$SettingsRootCude=$SettingsRoot+'{id:"cude-ai",label:"Cude AI",settings:["cude-ai.*"]},'
if(!$Text.Contains($SettingsRootCude)){
  if(!$Text.Contains($SettingsRoot)){throw 'Expected Settings category tree was not found.'}
  $Text=$Text.Replace($SettingsRoot,$SettingsRootCude)
}
$OldChatSettings=',\{id:"chat",label:d\(22430,null\),children:\[.*?\]\}(?=,\{id:"features")'
$Text=[regex]::Replace($Text,$OldChatSettings,'')
if($Text.Contains('{id:"chat",label:d(22430,null),children:[')){throw 'Stock Chat settings category was not removed.'}
$SettingsGroups='let n=this.defaultSettingsEditorModel.settingsGroups.slice(1),r=[],a=[];for(let b of n)b.extensionInfo?a.push(b):r.push(b);'
$SettingsGroupsCude='let n=this.defaultSettingsEditorModel.settingsGroups.slice(1).filter(b=>!/^github\.copilot(?:-chat)?$/i.test(b.extensionInfo?.id??"")).map(b=>b.extensionInfo?b:{...b,sections:b.sections.map(S=>({...S,settings:S.settings.filter(Y=>! /^(?:chat|inlineChat)\.|^accessibility\.signals\.chat/i.test(Y.key))}))}),r=[],a=[];for(let b of n)b.extensionInfo&&b.extensionInfo.id.toLowerCase()!=="cude.cude-ai"?a.push(b):r.push(b);'
if($Text.Contains($SettingsGroups)){$Text=$Text.Replace($SettingsGroups,$SettingsGroupsCude)}
if(!$Text.Contains($SettingsGroupsCude)){throw 'Expected Settings groups were not routed to the Cude AI category.'}

$From='H(10484,"Open Chat")';$To='H(10484,"Open Cude AI")'
if($Text.Contains($From)){$Text=$Text.Replace($From,$To);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($To)){throw 'Expected built-in Open Chat action label was not found.'}
# Supporter card entry in the bottom-left Manage (gear) menu, above Settings.
$CardFrom='this._register(De.appendMenuItem(F.GlobalActivity,{command:{id:mb,title:d(19166,null)},group:"2_configuration",order:3}))'
$CardTo=$CardFrom+',this._register(De.appendMenuItem(F.GlobalActivity,{command:{id:"cude-ai.supporterCard",title:"Supporter Card (Beta)"},group:"2_configuration",order:1}))'
$Text=$Text.Replace('{id:"cude-ai.supporterCard",title:"Supporter Card"}','{id:"cude-ai.supporterCard",title:"Supporter Card (Beta)"}')
# Supporter card is retired (Cude does not host models): remove the menu entry from previously patched bundles.
if($Text.Contains($CardTo)){$Text=$Text.Replace($CardTo,$CardFrom);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
$WatermarkFrom='g0r={text:d(8369,null),id:"workbench.action.chat.open",when:{native:bSn,web:bSn}}'
$WatermarkTo='g0r={text:"Open Cude AI",id:"cude-ai.chat"}'
if($Text.Contains($WatermarkFrom)){$Text=$Text.Replace($WatermarkFrom,$WatermarkTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($WatermarkTo)){throw 'Expected the empty editor Cude AI shortcut was not patched.'}
$FilterFrom='.filter(i=>!!Ke.getCommand(i.id)).filter(i=>!!this.keybindingService.lookupKeybinding(i.id))}};V0=I('
$FilterTo='.filter(i=>i.id==="cude-ai.chat"||!!Ke.getCommand(i.id)).filter(i=>i.id==="cude-ai.chat"||!!this.keybindingService.lookupKeybinding(i.id))}};V0=I('
if($Text.Contains($FilterFrom)){$Text=$Text.Replace($FilterFrom,$FilterTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
$AuxiliaryHide='De.appendMenuItem(F.AuxiliaryBarTitle,{command:{id:EK.ID,title:d(7928,null),icon:Jco},group:"navigation",order:2,when:D.equals("config.workbench.activityBar.location","default")});'
if($Text.Contains($AuxiliaryHide)){$Text=$Text.Replace($AuxiliaryHide,'');[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
$AuxiliaryMaximize=',menu:{id:F.AuxiliaryBarTitle,group:"navigation",order:1}'
if($Text.Contains($AuxiliaryMaximize)){$Text=$Text.Replace($AuxiliaryMaximize,'');[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
$AuxiliaryWidthFrom='AUXILIARYBAR_SIZE:new dut("auxiliaryBar.size",0,1,300)'
$AuxiliaryWidthTo='AUXILIARYBAR_SIZE:new dut("auxiliaryBar.size",0,1,420)'
if($Text.Contains($AuxiliaryWidthFrom)){$Text=$Text.Replace($AuxiliaryWidthFrom,$AuxiliaryWidthTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($AuxiliaryWidthTo)){throw 'Expected the 420px auxiliary-bar default was not patched.'}
$AuxiliaryDefaultFrom='ln.AUXILIARYBAR_SIZE.defaultValue=i?Math.max(300,r.width/2):Math.min(300,r.width/4)'
$AuxiliaryDefaultPrevious='ln.AUXILIARYBAR_SIZE.defaultValue=i?Math.max(420,r.width/2):Math.min(420,r.width/3)'
$AuxiliaryDefaultPrevious2='ln.AUXILIARYBAR_SIZE.defaultValue=i?Math.max(420,r.width/2):Math.min(420,r.width/2)'
$AuxiliaryDefaultTo='ln.AUXILIARYBAR_SIZE.defaultValue=420'
if($Text.Contains($AuxiliaryDefaultFrom)){$Text=$Text.Replace($AuxiliaryDefaultFrom,$AuxiliaryDefaultTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
elseif($Text.Contains($AuxiliaryDefaultPrevious)){$Text=$Text.Replace($AuxiliaryDefaultPrevious,$AuxiliaryDefaultTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
elseif($Text.Contains($AuxiliaryDefaultPrevious2)){$Text=$Text.Replace($AuxiliaryDefaultPrevious2,$AuxiliaryDefaultTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($AuxiliaryDefaultTo)){throw 'Expected auxiliary-bar startup sizing to target 420px was not patched.'}
$AuxiliaryPreferredFrom='this.layoutService.mainContainerDimension.height*.4}get preferredWidth(){let e=this.getActivePaneComposite();if(!e)return;let t=e.getOptimalWidth();if(typeof t=="number")return Math.max(t,300)}'
$AuxiliaryPreferredTo='this.layoutService.mainContainerDimension.height*.4}get preferredWidth(){let e=this.getActivePaneComposite();if(!e)return;let t=e.getOptimalWidth();if(typeof t=="number")return Math.max(t,420)}'
if($Text.Contains($AuxiliaryPreferredFrom)){$Text=$Text.Replace($AuxiliaryPreferredFrom,$AuxiliaryPreferredTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($AuxiliaryPreferredTo)){throw 'Expected secondary sidebar preferred width to be at least 420px.'}
$LayoutControlFrom='get layoutControlEnabled(){return this.configurationService.getValue("workbench.layoutControl.enabled")!==!1}'
$LayoutControlTo='get layoutControlEnabled(){return false}'
if($Text.Contains($LayoutControlFrom)){$Text=$Text.Replace($LayoutControlFrom,$LayoutControlTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($LayoutControlTo)){throw 'Expected inherited title-bar layout controls to be hidden.'}
$AuxiliarySmallWindowFrom='setInitializationValue(ln.AUXILIARYBAR_SIZE,Math.min(300,e.mainContainerDimension.width/4))'
$AuxiliarySmallWindowTo='setInitializationValue(ln.AUXILIARYBAR_SIZE,Math.min(420,e.mainContainerDimension.width/3))'
if($Text.Contains($AuxiliarySmallWindowFrom)){$Text=$Text.Replace($AuxiliarySmallWindowFrom,$AuxiliarySmallWindowTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
if(!$Text.Contains($AuxiliarySmallWindowTo)){throw 'Expected small-window auxiliary-bar sizing to target 420px was not patched.'}
$AuxFrom='default:"visibleInWorkspace",description:d(8825,null)'
$AuxTo='default:"visible",description:d(8825,null)'
if($Text.Contains($AuxFrom)){$Text=$Text.Replace($AuxFrom,$AuxTo);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
$CacheNotice='if(!t){let g=this._extensionsScannerService.onDidChangeCache(()=>{g.dispose(),this._notificationService.prompt(Ft.Error,d(27314,null),[{label:d(27317,null),run:()=>this._hostService.reload()}])});Ui(5e3).then(()=>g.dispose())}'
$CacheBaseline='if(!t){Ui(5e3)}'
if($Text.Contains($CacheNotice)){$Text=$Text.Replace($CacheNotice,$CacheBaseline);[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))}
# Cude core defaults: startup and accessibility must not depend on the AI extension.
$CoreDefaults=@(
  @('r.COLOR_THEME_DARK="Dark 2026",r.COLOR_THEME_LIGHT="Light 2026"', 'r.COLOR_THEME_DARK="Cude Dark",r.COLOR_THEME_LIGHT="Light 2026"'),
  @('r.FILE_ICON_THEME="vs-seti",r.PRODUCT_ICON_THEME="Default"', 'r.FILE_ICON_THEME="cude-icons",r.PRODUCT_ICON_THEME="Default"'),
  @('default:"welcomePage",description:d(26212,null),experiment:{mode:"auto"},agentsWindow:{default:"none",readOnly:!0}', 'default:"none",description:d(26212,null),agentsWindow:{default:"none",readOnly:!0}'),
  @('"window.restoreWindows":{type:"string",enum:["preserve","all","folders","one","none"],enumDescriptions:[d(26700,null),d(26696,null),d(26697,null),d(26699,null),d(26698,null)],default:"all",scope:1', '"window.restoreWindows":{type:"string",enum:["preserve","all","folders","one","none"],enumDescriptions:[d(26700,null),d(26696,null),d(26697,null),d(26699,null),d(26698,null)],default:"one",scope:1'),
  @('"workbench.layoutControl.enabled":{type:"boolean",default:!0,', '"workbench.layoutControl.enabled":{type:"boolean",default:!1,'),
  @('super(2,"accessibilitySupport",0,{type:"string",enum:["auto","on","off"],enumDescriptions:[d(336,null),d(338,null),d(337,null)],default:"auto",', 'super(2,"accessibilitySupport",0,{type:"string",enum:["auto","on","off"],enumDescriptions:[d(336,null),d(338,null),d(337,null)],default:"off",'),
  @('async run(){if(await this.lifecycleService.when(3)', 'async run(){if(this.productService.applicationName==="cude-ide")return;if(await this.lifecycleService.when(3)')
)
foreach($Pair in $CoreDefaults){
  $From=$Pair[0];$To=$Pair[1]
  if($Text.Contains($From)){$Text=$Text.Replace($From,$To)}
  if(!$Text.Contains($To)){throw "Cude core runtime default patch failed: $From"}
}
[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))
$Product=Get-Content -LiteralPath $ProductPath -Raw|ConvertFrom-Json
# Keep the optional product contract defined for workbench code paths, but never
# advertise GitHub/Copilot as Cude's default agent or trigger GitHub sign-in.
# Tam sözleşme şart: alanları budamak workbench'i çökertir (provider.enterprise.id -> siyah ekran). GitHub/Copilot kimlikleri Cude'ye çevrildi, ağ URL'leri boş.
$DefaultChatAgent=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'default-chat-agent.json') -Raw|ConvertFrom-Json
$Product|Add-Member -Force NoteProperty defaultChatAgent $DefaultChatAgent
$GitHubManifest=Join-Path (Split-Path $ProductPath) 'extensions\github\package.json'
if(Test-Path $GitHubManifest){
  $GitHub=Get-Content -LiteralPath $GitHubManifest -Raw|ConvertFrom-Json
  $GitHub.activationEvents=@()
  $GitHub.contributes.configuration.properties.'github.gitAuthentication'.default=$false
  $GitHub|ConvertTo-Json -Depth 100|Set-Content -LiteralPath $GitHubManifest -Encoding utf8
}
$GitHubAuthManifest=Join-Path (Split-Path $ProductPath) 'extensions\github-authentication\package.json'
if(Test-Path $GitHubAuthManifest){
  $GitHubAuth=Get-Content -LiteralPath $GitHubAuthManifest -Raw|ConvertFrom-Json
  # Cude's provider gateway handles AI connections. Avoid implicitly starting
  # the inherited GitHub OAuth provider during startup.
  $GitHubAuth.activationEvents=@()
  if($GitHubAuth.contributes.authentication){$GitHubAuth.contributes.authentication=@()}
  $GitHubAuth|ConvertTo-Json -Depth 100|Set-Content -LiteralPath $GitHubAuthManifest -Encoding utf8
}
# Cude does not provide GitHub cloud dictation. Do not prompt for or wait on an
# inherited GitHub session when the built-in voice service refreshes auth state.
$GitHubTokenFrom='async _getGitHubToken(){try{let e=await this._authenticationService.getSessions("github");return e[0]?e[0].accessToken:(await this._authenticationService.createSession("github",[])).accessToken}catch(e){this._logService.warn("[chat-stt] could not resolve a GitHub session for cloud dictation",e);return}}'
$GitHubTokenTo='async _getGitHubToken(){return}'
if($Text.Contains($GitHubTokenFrom)){$Text=$Text.Replace($GitHubTokenFrom,$GitHubTokenTo)}
if(!$Text.Contains($GitHubTokenTo)){throw 'Cude runtime still contains an implicit GitHub dictation session prompt.'}
$GitHubRefreshFrom='async _refreshGitHubSession(){let e=++this._githubSessionGeneration;try{let t=await this._authenticationService.getSessions("github",[],{silent:!0});if(e!==this._githubSessionGeneration||this._store.isDisposed)return;let i=t.length>0;this._hasGitHubSession!==i&&(this._hasGitHubSession=i,this._updateConfiguredContextKey())}catch(t){this._logService.warn("[chat-stt] could not refresh GitHub session state for cloud dictation",t)}}'
$GitHubRefreshTo='async _refreshGitHubSession(){}'
if($Text.Contains($GitHubRefreshFrom)){$Text=$Text.Replace($GitHubRefreshFrom,$GitHubRefreshTo)}
if(!$Text.Contains($GitHubRefreshTo)){throw 'Cude runtime still probes GitHub session state for built-in dictation.'}
[IO.File]::WriteAllText($Bundle,$Text,(New-Object Text.UTF8Encoding $false))
# Remove product-side API proposal grants for inherited GitHub/Copilot add-ons;
# their complete packages remain available to users who explicitly install them.
foreach($Id in @('GitHub.vscode-pull-request-github','GitHub.copilot','GitHub.copilot-nightly','GitHub.copilot-chat')){$Product.extensionEnabledApiProposals.PSObject.Properties.Remove($Id)}
# Cude workbench yerleşim katmanı (Claude): main.css sonuna işaretli blok olarak eklenir, checksum güncellenir.
$WbCss=Join-Path (Split-Path $Bundle) 'workbench.desktop.main.css'
$Layer=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'cude-workbench.css'))
$CssText=[IO.File]::ReadAllText($WbCss)
$CssText=[regex]::Replace($CssText,'(?s)/\*CUDE-WB-BEGIN\*/.*?/\*CUDE-WB-END\*/','')
[IO.File]::WriteAllText($WbCss,$CssText.TrimEnd()+"`n/*CUDE-WB-BEGIN*/`n"+$Layer+"`n/*CUDE-WB-END*/`n",(New-Object Text.UTF8Encoding $false))
$CssHex=(Get-FileHash -LiteralPath $WbCss -Algorithm SHA256).Hash
$CssBytes=for($i=0;$i -lt $CssHex.Length;$i+=2){[Convert]::ToByte($CssHex.Substring($i,2),16)}
if($Product.checksums.PSObject.Properties['vs/workbench/workbench.desktop.main.css']){$Product.checksums.'vs/workbench/workbench.desktop.main.css'=[Convert]::ToBase64String([byte[]]$CssBytes).TrimEnd('=')}
$Hex=(Get-FileHash -LiteralPath $Bundle -Algorithm SHA256).Hash
$Bytes=for($i=0;$i -lt $Hex.Length;$i+=2){[Convert]::ToByte($Hex.Substring($i,2),16)}
$Product.checksums.'vs/workbench/workbench.desktop.main.js'=[Convert]::ToBase64String([byte[]]$Bytes).TrimEnd('=')
[IO.File]::WriteAllText($ProductPath, ($Product | ConvertTo-Json -Depth 100) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

# Built-in extension display names: no upstream product names in Cude UI.
& node (Join-Path $PSScriptRoot "brand-nls.js") $App
if($LASTEXITCODE -ne 0){throw "brand-nls failed"}

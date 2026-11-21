$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:TEMP='E:\rust\tmp';$env:TMP='E:\rust\tmp';$env:npm_config_cache='E:\rust\tmp\npm-cache';$env:PLAYWRIGHT_BROWSERS_PATH='E:\rust\tmp\ms-playwright'
New-Item -ItemType Directory -Force $env:TEMP,$env:npm_config_cache,(Join-Path $root 'dist') | Out-Null
$extension=Join-Path $root 'extensions\cude-ai'
& (Join-Path $PSScriptRoot 'remove_logo_background.ps1') -Root $root
Copy-Item (Join-Path $root 'assets\cude_logo_transparent.png') (Join-Path $extension 'media\cude_logo.png') -Force
Push-Location $extension
try { npm ci --no-audit --no-fund --cache $env:npm_config_cache;if($LASTEXITCODE -ne 0){throw 'npm ci failed.'};npm run compile;if($LASTEXITCODE -ne 0){throw 'TypeScript compile failed.'};npm test;if($LASTEXITCODE -ne 0){throw 'Cude AI unit tests failed.'};npm run package;if($LASTEXITCODE -ne 0){throw 'Cude AI VSIX packaging failed.'} } finally { Pop-Location }
$downloads=Join-Path $root 'downloads';New-Item -ItemType Directory -Force $downloads | Out-Null
$zip=Join-Path $downloads 'vscodium.zip';$archiveUrl='https://github.com/VSCodium/vscodium/releases/download/1.143.17232/VSCodium-win32-x64-1.143.17232.zip';$archiveSha='A1090868AF8AC0AC04C22D79FDD02246FA115A78DAF38A741D8DB06DF1753C1D'
if(!(Test-Path $zip)){Invoke-WebRequest $archiveUrl -OutFile $zip};$actual=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash;if($actual -ne $archiveSha){throw "VSCodium archive SHA256 mismatch: $actual"}
$rcedit=Join-Path $downloads 'rcedit-x64.exe';if(!(Test-Path $rcedit)){Invoke-WebRequest 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' -OutFile $rcedit}
$rceditSha='3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A';if((Get-FileHash -LiteralPath $rcedit -Algorithm SHA256).Hash -ne $rceditSha){throw 'rcedit SHA256 mismatch.'}
$work=Join-Path $root 'dist\Cude-IDE'
if(Test-Path $work){
  $full=(Resolve-Path $work).Path
  $distRoot=(Resolve-Path (Join-Path $root 'dist')).Path.TrimEnd('\')+'\'
  if(!$full.StartsWith($distRoot,[StringComparison]::OrdinalIgnoreCase)){throw "Refusing to replace path outside dist: $full"}
  foreach($item in Get-ChildItem -LiteralPath $full -Force){
    if($item.Name -eq 'data' -and $item.PSIsContainer){
      foreach($dataItem in Get-ChildItem -LiteralPath $item.FullName -Force){
        if($dataItem.Name -ne 'user-data'){Remove-Item -LiteralPath $dataItem.FullName -Recurse -Force}
      }
    }else{Remove-Item -LiteralPath $item.FullName -Recurse -Force}
  }
}else{New-Item -ItemType Directory -Force $work | Out-Null}
tar -xf $zip -C $work
$app=Join-Path $work 'resources\app';$productPath=Join-Path $app 'product.json';$product=Get-Content -Raw $productPath|ConvertFrom-Json
$product.nameShort='Cude IDE';$product.nameLong='Cude IDE';$product.PSObject.Properties.Remove('version');$product | Add-Member -Force NoteProperty cudeVersion '0.1.0';$product.darwinBundleIdentifier='com.cudeide';$product.linuxIconName='cude-ide';$product.applicationName='cude-ide';$product.dataFolderName='.cude-ide';$product.win32AppUserModelId='CudeStudio.CudeIDE';$product.win32MutexName='cude-ide';$product.win32DirName='Cude IDE';$product.win32NameVersion='Cude IDE';$product.win32ShellNameShort='Cude IDE';$product.win32RegValueName='CudeIDE';$product.win32AppId='{{72AC56B0-6B0D-4A36-B3A3-E6D99F5A03B0}';$product.win32x64AppId='{{3A381C8A-F9A7-4D58-99A0-5F596D273133}';$product.win32UserAppId='{{BEE2F773-A58B-4DC6-A3EC-EC8CB590FDF6}';$product.win32x64UserAppId='{{53A1CB63-208A-4B6E-9F20-07E16BFF0651}';$product.urlProtocol='cude-ide';$product.serverApplicationName='cude-ide-server';$product.serverDataFolderName='.cude-ide-server';$product.tunnelApplicationName='cude-ide-tunnel';$product.win32TunnelMutex='cude-ide-tunnel';$product.win32TunnelServiceMutex='cude-ide-tunnelservice';$product.licenseName='MIT';$product.licenseUrl='https://github.com/VSCodium/vscodium/blob/master/LICENSE';$product.extensionsGallery=@{serviceUrl='https://open-vsx.org/vscode/gallery';itemUrl='https://open-vsx.org/vscode/item';resourceUrlTemplate='https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}'}
$product.updateUrl='';$product.downloadUrl='';$product.serverDownloadUrlTemplate='';$product.releaseNotesUrl='';$product.reportIssueUrl='';$product.requestFeatureUrl='';$product.documentationUrl='';$product.introductoryVideosUrl='';$product.tipsAndTricksUrl='';$product.builtInExtensionsEnabledWithAutoUpdates=@()
$product|ConvertTo-Json -Depth 100|Set-Content -Encoding utf8 $productPath
& (Join-Path $PSScriptRoot 'patch-runtime.ps1') -App $app
$ext=Join-Path $app 'extensions\cude-ai';New-Item -ItemType Directory -Force $ext | Out-Null
Copy-Item (Join-Path $root 'extensions\cude-ai\package.json') $ext;Copy-Item (Join-Path $root 'extensions\cude-ai\LICENSE') $ext;Copy-Item (Join-Path $root 'extensions\cude-ai\out') $ext -Recurse;Copy-Item (Join-Path $root 'extensions\cude-ai\media') $ext -Recurse;Copy-Item (Join-Path $root 'extensions\cude-ai\themes') $ext -Recurse
& (Join-Path $PSScriptRoot 'set-pool-default.ps1') -Manifest (Join-Path $ext 'package.json')
& (Join-Path $PSScriptRoot 'remove_logo_background.ps1') -Root $root
Copy-Item (Join-Path $root 'assets\cude_logo_transparent.png') (Join-Path $ext 'media\cude_logo.png') -Force
Copy-Item (Join-Path $root 'assets\cude_logo_transparent.png') (Join-Path $work 'cude_logo.png') -Force
& (Join-Path $PSScriptRoot 'make_icon.ps1') -Png (Join-Path $root 'assets\cude_icon.png') -Ico (Join-Path $work 'cude.ico') -IconDir (Join-Path $root 'assets\icons')
$win32=Join-Path $app 'resources\win32'
Copy-Item (Join-Path $work 'cude.ico') (Join-Path $win32 'code.ico') -Force
Copy-Item (Join-Path $root 'assets\icons\cude-70.png') (Join-Path $win32 'code_70x70.png') -Force
Copy-Item (Join-Path $root 'assets\icons\cude-150.png') (Join-Path $win32 'code_150x150.png') -Force
$mark=Join-Path $root 'assets\cude-mark.svg'
Copy-Item $mark (Join-Path $app 'out\media\vscode-icon.svg') -Force
Copy-Item $mark (Join-Path $app 'out\media\code-icon.svg') -Force
Copy-Item $mark (Join-Path $app 'out\vs\workbench\browser\media\code-icon.svg') -Force
foreach($lv in 'dark','hcDark','light','hcLight'){Copy-Item (Join-Path (Split-Path $PSScriptRoot) "assets\letterpress-$lv.svg") (Join-Path $app "out\media\letterpress-$lv.svg") -Force}
$manifest=Join-Path $work 'VSCodium.VisualElementsManifest.xml';if(Test-Path $manifest){$manifestText=Get-Content -Raw $manifest;$manifestText=$manifestText.Replace('resources\app\resources\win32\code_150x150.png','cude-150.png').Replace('resources\app\resources\win32\code_70x70.png','cude-70.png').Replace('VSCodium','Cude IDE');Set-Content -LiteralPath (Join-Path $work 'CudeIDE.VisualElementsManifest.xml') -Value $manifestText -Encoding utf8;Remove-Item -LiteralPath $manifest -Force}
Copy-Item (Join-Path $root 'assets\icons\cude-150.png') $work -Force;Copy-Item (Join-Path $root 'assets\icons\cude-70.png') $work -Force
$appExe=Join-Path $work 'VSCodium.exe'
if(Test-Path $rcedit){& $rcedit $appExe --set-icon (Join-Path $work 'cude.ico') --set-version-string CompanyName 'Cude Team' --set-version-string ProductName 'Cude IDE' --set-version-string ProductVersion '0.1.0' --set-version-string FileVersion '0.1.0' --set-version-string FileDescription 'Cude IDE' --set-version-string OriginalFilename 'CudeIDE.exe' --set-version-string InternalName 'CudeIDE';if($LASTEXITCODE -ne 0){throw 'Could not embed Cude icon into executable.'}}
$exe=Join-Path $work 'CudeIDE.exe';Move-Item -LiteralPath $appExe -Destination $exe
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cude-launcher.cmd') -Destination (Join-Path $work 'Cude IDE.cmd') -Force
Copy-Item (Join-Path $app 'LICENSE.txt') (Join-Path $work 'OPEN-SOURCE-LICENSES.txt') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'data\User') | Out-Null
@{'workbench.colorTheme'='Cude Dark';'workbench.iconTheme'='cude-icons';'workbench.startupEditor'='none';'window.restoreWindows'='one';'window.titleBarStyle'='custom';'window.menuBarVisibility'='hidden';'window.title'='Cude IDE';'workbench.sideBar.location'='left';'workbench.secondarySideBar.defaultVisibility'='visible';'workbench.editor.empty.hint'='text';'workbench.layoutControl.enabled'=$false;'editor.accessibilitySupport'='off';'workbench.welcomePage.walkthroughs.openOnInstall'=$false;'security.workspace.trust.enabled'=$true;'security.workspace.trust.startupPrompt'='once';'security.workspace.trust.emptyWindow'=$false;'security.workspace.trust.untrustedFiles'='prompt';'update.mode'='none';'update.enableWindowsBackgroundUpdates'=$false;'update.showReleaseNotes'=$false;'extensions.autoUpdate'=$false;'extensions.autoCheckUpdates'=$false} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $work 'data\User\settings.json')
& (Join-Path $PSScriptRoot 'create-portable-zip.ps1') -Root $root
Write-Host 'Cude IDE branded portable tree prepared.'





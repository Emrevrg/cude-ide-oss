param([string]$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
$ErrorActionPreference='Stop'
$Root=(Resolve-Path $Root).Path
$env:TEMP='E:\rust\tmp';$env:TMP='E:\rust\tmp';$env:npm_config_cache='E:\rust\tmp\npm-cache'
New-Item -ItemType Directory -Force $env:TEMP,$env:npm_config_cache | Out-Null
$Work=Join-Path $Root 'dist\Cude-IDE'
$App=Join-Path $Work 'resources\app'
$OldLicense=Join-Path $Work 'VSCodium-LICENSE.txt'
if(Test-Path $OldLicense){Move-Item -LiteralPath $OldLicense -Destination (Join-Path $Work 'OPEN-SOURCE-LICENSES.txt') -Force}
$ProductPath=Join-Path $App 'product.json'
$Product=Get-Content -Raw $ProductPath | ConvertFrom-Json
$Product.nameShort='Cude IDE';$Product.nameLong='Cude IDE';$Product.PSObject.Properties.Remove('version');$Product | Add-Member -Force NoteProperty cudeVersion '0.1.0';$Product.darwinBundleIdentifier='com.cudeide';$Product.linuxIconName='cude-ide';$Product.applicationName='cude-ide';$Product.dataFolderName='.cude-ide'
$Product.win32AppUserModelId='CudeStudio.CudeIDE';$Product.win32MutexName='cude-ide';$Product.win32DirName='Cude IDE';$Product.win32NameVersion='Cude IDE';$Product.win32ShellNameShort='Cude IDE';$Product.win32RegValueName='CudeIDE';$Product.win32AppId='{{72AC56B0-6B0D-4A36-B3A3-E6D99F5A03B0}';$Product.win32x64AppId='{{3A381C8A-F9A7-4D58-99A0-5F596D273133}';$Product.win32UserAppId='{{BEE2F773-A58B-4DC6-A3EC-EC8CB590FDF6}';$Product.win32x64UserAppId='{{53A1CB63-208A-4B6E-9F20-07E16BFF0651}';$Product.urlProtocol='cude-ide'
$Product.serverApplicationName='cude-ide-server';$Product.serverDataFolderName='.cude-ide-server';$Product.tunnelApplicationName='cude-ide-tunnel';$Product.win32TunnelMutex='cude-ide-tunnel';$Product.win32TunnelServiceMutex='cude-ide-tunnelservice'
$Product.licenseName='MIT';$Product.licenseUrl='https://github.com/VSCodium/vscodium/blob/master/LICENSE'
# Cude releases are user-approved and manually distributed. Disable every inherited update feed.
foreach($Key in @('updateUrl','downloadUrl','serverDownloadUrlTemplate','releaseNotesUrl','reportIssueUrl','requestFeatureUrl','documentationUrl','introductoryVideosUrl','tipsAndTricksUrl')){if($Product.PSObject.Properties[$Key]){$Product.$Key=''}}
$Product.builtInExtensionsEnabledWithAutoUpdates=@()
$Product.extensionsGallery=@{serviceUrl='https://open-vsx.org/vscode/gallery';itemUrl='https://open-vsx.org/vscode/item';resourceUrlTemplate='https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}'}
$Product | ConvertTo-Json -Depth 100 | Set-Content -Encoding utf8 $ProductPath
& (Join-Path $PSScriptRoot 'patch-runtime.ps1') -App $App
& (Join-Path $PSScriptRoot 'remove_logo_background.ps1') -Root $Root
$Extension=Join-Path $App 'extensions\cude-ai'
Copy-Item (Join-Path $Root 'extensions\cude-ai\package.json') $Extension -Force
& (Join-Path $PSScriptRoot 'set-pool-default.ps1') -Manifest (Join-Path $Extension 'package.json')
Copy-Item (Join-Path $Root 'extensions\cude-ai\LICENSE') $Extension -Force
Copy-Item (Join-Path $Root 'extensions\cude-ai\out') $Extension -Recurse -Force
Copy-Item (Join-Path $Root 'extensions\cude-ai\media') $Extension -Recurse -Force
Copy-Item (Join-Path $Root 'extensions\cude-ai\themes') $Extension -Recurse -Force
Copy-Item (Join-Path $Root 'extensions\cude-ai\data') $Extension -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $Extension 'node_modules') | Out-Null
Copy-Item (Join-Path $Root 'extensions\cude-ai\node_modules\undici') (Join-Path $Extension 'node_modules') -Recurse -Force
foreach($Dependency in @('yaml','jsonc-parser')){
 Copy-Item (Join-Path $Root "extensions\cude-ai\node_modules\$Dependency") (Join-Path $Extension 'node_modules') -Recurse -Force
}
Copy-Item (Join-Path $Root 'assets\cude_logo_transparent.png') (Join-Path $Extension 'media\cude_logo.png') -Force
Copy-Item (Join-Path $Root 'assets\cude_logo_transparent.png') (Join-Path $Work 'cude_logo.png') -Force
& (Join-Path $PSScriptRoot 'make_icon.ps1') -Png (Join-Path $Root 'assets\cude_icon.png') -Ico (Join-Path $Work 'cude.ico') -IconDir (Join-Path $Root 'assets\icons')
$Win32=Join-Path $App 'resources\win32'
Copy-Item (Join-Path $Work 'cude.ico') (Join-Path $Win32 'code.ico') -Force
Copy-Item (Join-Path $Root 'assets\icons\cude-70.png') (Join-Path $Win32 'code_70x70.png') -Force
Copy-Item (Join-Path $Root 'assets\icons\cude-150.png') (Join-Path $Win32 'code_150x150.png') -Force
$Mark=Join-Path $Root 'assets\cude-mark.svg'
Copy-Item $Mark (Join-Path $App 'out\media\vscode-icon.svg') -Force
Copy-Item $Mark (Join-Path $App 'out\media\code-icon.svg') -Force
Copy-Item $Mark (Join-Path $App 'out\vs\workbench\browser\media\code-icon.svg') -Force
foreach($lv in 'dark','hcDark','light','hcLight'){Copy-Item (Join-Path (Split-Path $PSScriptRoot) "assets\letterpress-$lv.svg") (Join-Path $App "out\media\letterpress-$lv.svg") -Force}
$Rcedit=Join-Path $Root 'downloads\rcedit-x64.exe'
$Exe=Join-Path $Work 'CudeIDE.exe';$StagedExe=Join-Path $env:TEMP 'CudeIDE-rebrand.exe'
Copy-Item -LiteralPath $Exe -Destination $StagedExe -Force
& $Rcedit $StagedExe --set-icon (Join-Path $Work 'cude.ico') --set-version-string CompanyName 'Cude Team' --set-version-string ProductName 'Cude IDE' --set-version-string ProductVersion '0.1.0' --set-version-string FileVersion '0.1.0' --set-version-string FileDescription 'Cude IDE' --set-version-string OriginalFilename 'CudeIDE.exe' --set-version-string InternalName 'CudeIDE'
if($LASTEXITCODE -ne 0){throw 'Could not embed transparent Cude icon into the staged application executable.'}
Move-Item -LiteralPath $StagedExe -Destination $Exe -Force
$Manifest=Join-Path $Work 'VSCodium.VisualElementsManifest.xml'
if(Test-Path $Manifest){
  $Text=(Get-Content -Raw $Manifest).Replace('resources\app\resources\win32\code_150x150.png','cude-150.png').Replace('resources\app\resources\win32\code_70x70.png','cude-70.png').Replace('VSCodium','Cude IDE')
  Set-Content (Join-Path $Work 'CudeIDE.VisualElementsManifest.xml') -Value $Text -Encoding utf8
  Remove-Item -LiteralPath $Manifest -Force
}
Copy-Item (Join-Path $Root 'assets\icons\cude-150.png') $Work -Force
Copy-Item (Join-Path $Root 'assets\icons\cude-70.png') $Work -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cude-launcher.cmd') -Destination (Join-Path $Work 'Cude IDE.cmd') -Force
# User data belongs to the local Cude profile, not the shipped product. Startup,
# accessibility, restore-window and layout defaults are patched into the core.
$PortableData=Join-Path $Work 'data'
New-Item -ItemType Directory -Force $PortableData | Out-Null
$PortableMarker=Join-Path $PortableData 'PORTABLE.txt'
# Keep portable mode enabled without removing any existing user data or logs.
if(!(Test-Path $PortableMarker)){Set-Content -LiteralPath $PortableMarker -Value 'Cude IDE portable mode: settings and extensions are stored in this folder.' -Encoding utf8}
& (Join-Path $PSScriptRoot 'create-portable-zip.ps1') -Root $Root
Write-Host "Finalized $Work"




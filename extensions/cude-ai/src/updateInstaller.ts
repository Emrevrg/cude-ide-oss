import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {spawn} from 'node:child_process';
// This runner is covered by the signed out/*.js integrity inventory.
export const UPDATE_RUNNER = String.raw`param([string]$Archive,[int]$ParentPid)
$ErrorActionPreference='Stop'
$InstallRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Cude IDE'))
$App=Join-Path $InstallRoot 'Cude-IDE'
$Stage=Join-Path $InstallRoot ('.update-'+[Guid]::NewGuid().ToString('N'))
$Previous=Join-Path $InstallRoot ('.previous-'+[Guid]::NewGuid().ToString('N'))
foreach($Target in @($App,$Stage,$Previous)){
 if(![IO.Path]::GetFullPath($Target).StartsWith($InstallRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe update path'}
 if((Test-Path -LiteralPath $Target) -and ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked installation path'}
}
$HadPrevious=$false
$Swapped=$false
try {
 if(Test-Path -LiteralPath $InstallRoot){if((Get-Item -LiteralPath $InstallRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked install root'}}
 New-Item -ItemType Directory -Path $Stage -Force | Out-Null
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $Zip=[IO.Compression.ZipFile]::OpenRead($Archive)
 try {
  foreach($Entry in $Zip.Entries){
   $Resolved=[IO.Path]::GetFullPath((Join-Path $Stage $Entry.FullName))
   if(!$Resolved.StartsWith($Stage+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid archive path'}
   if(($Entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000){throw 'Archive link rejected'}
  }
 }finally{$Zip.Dispose()}
 [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$Stage)
 $New=Join-Path $Stage 'Cude-IDE'
 if(!(Test-Path -LiteralPath (Join-Path $New 'CudeIDE.exe'))){throw 'Missing IDE executable'}
 # Do not replace files until the IDE has closed.
 $Running=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
 if($Running){if(!$Running.WaitForExit(120000)){throw 'Close Cude IDE before updating'}}
 if(Test-Path -LiteralPath $App){Move-Item -LiteralPath $App -Destination $Previous;$HadPrevious=$true}
 Move-Item -LiteralPath $New -Destination $App
 $Swapped=$true
 if($HadPrevious -and (Test-Path -LiteralPath (Join-Path $Previous 'data'))){
  $NewData=Join-Path $App 'data'
  if(Test-Path -LiteralPath $NewData){
   # Archive data is retained separately; existing user data always wins.
   Move-Item -LiteralPath $NewData -Destination (Join-Path $Stage 'archive-data')
  }
  Move-Item -LiteralPath (Join-Path $Previous 'data') -Destination $NewData
 }
 Start-Process -FilePath (Join-Path $App 'CudeIDE.exe')
 # Previous binaries and downloaded archive are deliberately retained for operator recovery.
}catch{
 if($HadPrevious){
  if($Swapped -and !(Test-Path -LiteralPath (Join-Path $Previous 'data')) -and (Test-Path -LiteralPath (Join-Path $App 'data'))){Move-Item -LiteralPath (Join-Path $App 'data') -Destination (Join-Path $Previous 'data')}
  if($Swapped -and (Test-Path -LiteralPath $App)){Move-Item -LiteralPath $App -Destination (Join-Path $Stage 'failed-app')}
  if(!(Test-Path -LiteralPath $App)){Move-Item -LiteralPath $Previous -Destination $App}
 }
 $_.Exception.Message | Out-File -LiteralPath ($Archive+'.error.txt') -Encoding utf8
 exit 1
}
`;
export async function launchUpdate(archive:string,folder:string){
 if(process.platform!=='win32')throw Error('Windows kurulumu gerekir.');
 const runner=path.join(folder,'install-update.ps1');
 await fs.writeFile(runner,UPDATE_RUNNER,{flag:'wx',mode:0o600});
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',runner,'-Archive',archive,'-ParentPid',String(process.pid)],{windowsHide:true,detached:true,stdio:'ignore'});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
 });
}

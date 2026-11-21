# Builds the versioned installer from the portable ZIP with the built-in Windows IExpress tool.
param([string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path, [string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'
$zip = Join-Path $Root "dist\Cude-IDE-$Version-win32-x64.zip"
$out = Join-Path $Root "dist\CudeIDE-Setup-$Version-x64.exe"
if (-not (Test-Path $zip)) { throw "Portable ZIP missing: $zip (run build\paketle.ps1 first)" }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('cude-setup-' + [Guid]::NewGuid().ToString('N'))
$TempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(!([IO.Path]::GetFullPath($stage)).StartsWith($TempRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid installer staging directory.'}
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  Copy-Item $zip (Join-Path $stage 'Cude-IDE.zip')
  Copy-Item (Join-Path $PSScriptRoot 'installer\cude-install.cmd') $stage
  Copy-Item (Join-Path $PSScriptRoot 'installer\uninstall.cmd') $stage
  if (Test-Path $out) { Remove-Item $out -Force }
  $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
Compress=0
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$out
FriendlyName=Cude IDE $Version Setup
AppLaunched=cmd.exe /d /c .\cude-install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="Cude-IDE.zip"
FILE1="cude-install.cmd"
FILE2="uninstall.cmd"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
  $sedPath = Join-Path $stage 'cude.sed'
  Set-Content -Path $sedPath -Value $sed -Encoding ascii
  $p = Start-Process -FilePath "$env:SystemRoot\System32\iexpress.exe" -ArgumentList '/N', '/Q', $sedPath -Wait -PassThru -WindowStyle Hidden
  if ($p.ExitCode -ne 0 -or -not (Test-Path $out)) { throw "IExpress did not produce the installer (exit $($p.ExitCode))." }
  $hash = (Get-FileHash $out -Algorithm SHA256).Hash
  "installer=$out size={0:N0}MB sha256=$hash" -f ((Get-Item $out).Length / 1MB)
} finally { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }

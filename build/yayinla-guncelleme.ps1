param(
 [Parameter(Mandatory=$true)][ValidatePattern('^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$')][string]$Version,
 [switch]$Mandatory,[string]$NotesFile='',[switch]$DryRun,[switch]$Publish,[switch]$ReuseRuntime,
 [string]$Root='',
 [string]$OutputRoot='',
 [string]$ReleaseRepository='E:\Projeler\cude-ide-releases',
 [string]$PrivateKey='E:\Projeler\CudeIDE-anahtarlar\release-ed25519.pem'
)
$ErrorActionPreference='Stop'
# DryRun never obtains credentials, modifies the release repository or calls GitHub.
if($DryRun -and $Publish){throw 'DryRun and Publish cannot be used together.'}
$DryRun=[System.Management.Automation.SwitchParameter]::new(!$Publish)
if(!$Root){$Root=Split-Path $PSScriptRoot -Parent}
$Root=[IO.Path]::GetFullPath($Root)
$Package=Join-Path $Root 'extensions\cude-ai\package.json'
$OriginalPackage=[IO.File]::ReadAllBytes($Package)
$OldTemp=$env:TEMP;$OldTmp=$env:TMP
$Feed='https://emrevrg.github.io/cude-ide-releases/update/manifest.json'
$Url=[Uri]::new([Uri]$Feed,"Cude-IDE-$Version-win32-x64.zip").AbsoluteUri
if(!$OutputRoot){$OutputRoot=if($DryRun){Join-Path $Root ('dist\dry-run-'+$Version)}else{$Root}}
$OutputRoot=[IO.Path]::GetFullPath($OutputRoot)
if($DryRun -and $OutputRoot -eq $Root){throw 'DryRun requires a separate output root.'}
if($ReuseRuntime -and !$DryRun){throw 'ReuseRuntime is restricted to DryRun.'}
$Dist=Join-Path $OutputRoot 'dist'
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$env:TEMP=Join-Path $Dist 'temp';$env:TMP=$env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
function Check-Native([string]$Message){if($LASTEXITCODE -ne 0){throw $Message}}
try {
 if(!(Test-Path -LiteralPath $PrivateKey)){throw 'Release signing key is unavailable outside the repository.'}
 $KeyPath=[IO.Path]::GetFullPath($PrivateKey)
 if($KeyPath.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Private key must remain outside the repository.'}
 $Metadata=[Text.Encoding]::UTF8.GetString($OriginalPackage)|ConvertFrom-Json
 if([version]$Version -le [version]$Metadata.version){throw 'Release version must be newer than the source package.'}
 $Metadata.version=$Version
 if($Publish){[IO.File]::WriteAllText($Package,($Metadata|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))}
 Push-Location (Split-Path $Package)
 try{& npm.cmd run compile;Check-Native 'Extension compile failed'; & npm.cmd test;Check-Native 'Extension tests failed'}finally{Pop-Location}
 Push-Location (Join-Path $Root 'gateway')
 try{& node --test;Check-Native 'Gateway tests failed'}finally{Pop-Location}
 $Runtime=Join-Path $Dist 'Cude-IDE'
 if($DryRun){
  if((Test-Path $Runtime) -and !$ReuseRuntime){throw 'DryRun output already exists; choose a fresh OutputRoot or explicitly ReuseRuntime.'}
  if(!$ReuseRuntime){
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  foreach($Item in Get-ChildItem -LiteralPath (Join-Path $Root 'dist\Cude-IDE') -Force){
   if($Item.Name -eq 'data' -or $Item.Extension -in @('.log','.dmp')){continue}
   if(($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Runtime source must not contain links.'}
   Copy-Item -LiteralPath $Item.FullName -Destination $Runtime -Recurse
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'data') | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root 'dist\Cude-IDE\data\PORTABLE.txt') -Destination (Join-Path $Runtime 'data\PORTABLE.txt')
  }
 }
 $Target=Join-Path $Runtime 'resources\app\extensions\cude-ai'
 New-Item -ItemType Directory -Force -Path $Target | Out-Null
 foreach($Name in @('package.json','LICENSE','out','media','themes','bin','data','node_modules')){
  $Source=Join-Path (Split-Path $Package) $Name
  if(Test-Path $Source){Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force}
 }
 if($DryRun){[IO.File]::WriteAllText((Join-Path $Target 'package.json'),($Metadata|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))}
 & (Join-Path $PSScriptRoot 'set-pool-default.ps1') -Manifest (Join-Path $Target 'package.json')
 # Product/engine version follows the single version-setting entry point.
 $App=Join-Path $Runtime 'resources\app'
 $AppPackage=Join-Path $App 'package.json'
 $AppMeta=Get-Content $AppPackage -Raw|ConvertFrom-Json;$AppMeta.version=$Version
 [IO.File]::WriteAllText($AppPackage,($AppMeta|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))
 & (Join-Path $PSScriptRoot 'patch-runtime.ps1') -App $App
 & (Join-Path $PSScriptRoot 'paketle.ps1') -Root $OutputRoot
 $Archive=Join-Path $Dist "Cude-IDE-$Version-win32-x64.zip"
 $SequenceFile=Join-Path $Root 'dist\update-sequence.txt'
 $Sequence=1
 if(Test-Path $SequenceFile){$Sequence=[int](Get-Content $SequenceFile -Raw)}
 if(Test-Path (Join-Path $Root 'dist\update-manifest.json')){$Sequence=[Math]::Max($Sequence,[int]((Get-Content (Join-Path $Root 'dist\update-manifest.json') -Raw|ConvertFrom-Json).manifest.sequence))}
 if(!$DryRun -and (Test-Path (Join-Path $ReleaseRepository 'update\manifest.json'))){$Sequence=[Math]::Max($Sequence,[int]((Get-Content (Join-Path $ReleaseRepository 'update\manifest.json') -Raw|ConvertFrom-Json).manifest.sequence))}
 $Sequence++
 $Manifest=Join-Path $Dist 'update-manifest.json'
 if(Test-Path $Manifest){throw 'Manifest output exists; refusing to overwrite a signed release.'}
 & (Join-Path $PSScriptRoot 'publish-update.ps1') -Archive $Archive -Url $Url -Feed $Feed -Version $Version -MinimumVersion $(if($Mandatory){$Version}else{'0.1.0'}) -Sequence $Sequence -PrivateKey $PrivateKey -Output $Manifest -NotesFile $NotesFile -Mandatory:$Mandatory
 # Mirror the sealed extension into the installer source, not just the ZIP.
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $Zip=[IO.Compression.ZipFile]::OpenRead($Archive)
 try{foreach($Name in @('integrity.json','release-trust.json')){$Entry=$Zip.GetEntry('Cude-IDE/resources/app/extensions/cude-ai/'+$Name);[IO.Compression.ZipFileExtensions]::ExtractToFile($Entry,(Join-Path $Target $Name),$true)}}finally{$Zip.Dispose()}
 & (Join-Path $PSScriptRoot 'make-installer.ps1') -Root $OutputRoot -Version $Version
 $Installer=Join-Path $Dist "CudeIDE-Setup-$Version-x64.exe"
 $Sha=(Get-FileHash $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
 $Download="https://github.com/Emrevrg/cude-ide-releases/releases/download/v$Version/CudeIDE-Setup-$Version-x64.exe"
 # Prepare reviewable website edits locally even in DryRun; never touch website/.
 $Index=Join-Path $ReleaseRepository 'index.html'
 if(Test-Path $Index){
  $Html=[IO.File]::ReadAllText($Index)
  $Html=[regex]::Replace($Html,'https://github.com/Emrevrg/cude-ide-releases/releases/download/[^"\s<>]+/CudeIDE-Setup-[^"\s<>]+\.exe',$Download)
  $Html=[regex]::Replace($Html,'CudeIDE-Setup-[a-zA-Z0-9.\-]+\.exe',"CudeIDE-Setup-$Version-x64.exe")
  $Html=[regex]::Replace($Html,'SHA-256\s*[:：]?\s*[a-fA-F0-9]{64}',"SHA-256 $Sha")
  $Html=[regex]::Replace($Html,'Version 0\.1\.[a-zA-Z0-9.\-]+',"Version $Version")
  $Html=[regex]::Replace($Html,'(?<![0-9.])0\.1\.[0-9]+(?![0-9.])',$Version)
  [IO.File]::WriteAllText((Join-Path $Dist 'release-index.html'),$Html,[Text.UTF8Encoding]::new($false))
 }
 $ReleaseIndex=Join-Path $Dist 'release-index.html'
 if(!(Test-Path -LiteralPath $ReleaseIndex)){throw 'Release website index is missing.'}
 $PagesDir=Join-Path $Dist 'pages-artifact'
 $PagesTar=Join-Path $Dist 'pages-artifact.tar.gz'
 $Trust=Join-Path $Target 'release-trust.json'
 & node (Join-Path $PSScriptRoot 'stage-pages-update.js') $Archive $Manifest $Trust $ReleaseRepository $ReleaseIndex $PagesDir | Tee-Object -FilePath (Join-Path $Dist 'pages-artifact-report.json')
 Check-Native 'Pages artifact validation failed'
 & tar.exe -czf $PagesTar -C $PagesDir .;Check-Native 'Pages artifact could not be packaged'
 $Entries=@(& tar.exe -tzf $PagesTar);Check-Native 'Pages artifact could not be read'
 if($Entries -notcontains './update/manifest.json' -or $Entries -notcontains "./update/Cude-IDE-$Version-win32-x64.zip"){
  throw 'Pages artifact does not contain both signed update files.'
 }
 $Setup=Join-Path $Dist 'pages-setup'
 New-Item -ItemType Directory -Force -Path (Join-Path $Setup '.github\workflows'),(Join-Path $Setup 'release-tools') | Out-Null
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'publish-pages.yml') -Destination (Join-Path $Setup '.github\workflows\publish-pages.yml')
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stage-pages-update.js'),$Trust -Destination (Join-Path $Setup 'release-tools')
 if($Publish){
  # Credentials stay in memory; never invoke git with token-bearing arguments.
  $Credential="protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  Check-Native 'GitHub credential lookup failed'
  $Token=($Credential|Where-Object {$_ -like 'password=*'}|Select-Object -First 1).Substring(9)
  $Credential=$null
  if(!$Token){throw 'GitHub credential is missing'}
  try{
   $Headers=@{Authorization="Bearer $Token";Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'}
   $Api='https://api.github.com/repos/Emrevrg/cude-ide-releases/releases'
   $Body=@{tag_name="v$Version";name="Cude IDE $Version";draft=$true;prerelease=$false;body=$(if($NotesFile){[IO.File]::ReadAllText($NotesFile)}else{'Cude IDE '+$Version})}|ConvertTo-Json
   $Release=Invoke-RestMethod -Method Post -Uri $Api -Headers $Headers -Body $Body -ContentType 'application/json'
   foreach($File in @($Installer,$Archive,$Manifest)){$null=Invoke-RestMethod -Method Post -Uri ("https://uploads.github.com/repos/Emrevrg/cude-ide-releases/releases/"+$Release.id+'/assets?name='+[Uri]::EscapeDataString([IO.Path]::GetFileName($File))) -Headers $Headers -InFile $File -ContentType 'application/octet-stream'}
   $null=Invoke-RestMethod -Method Patch -Uri ($Api+'/'+$Release.id) -Headers $Headers -Body '{"draft":false,"make_latest":"true"}' -ContentType 'application/json'
   Copy-Item -LiteralPath $Manifest -Destination (Join-Path $ReleaseRepository 'update\manifest.json')
   Copy-Item -LiteralPath $ReleaseIndex -Destination $Index
   Copy-Item -LiteralPath (Join-Path $Setup '.github'),(Join-Path $Setup 'release-tools') -Destination $ReleaseRepository -Recurse -Force
   $ReleaseFiles=@('update/manifest.json','index.html','.github/workflows/publish-pages.yml','release-tools/stage-pages-update.js','release-tools/release-trust.json')
   Push-Location $ReleaseRepository
   try{
    $Branch=(& git symbolic-ref --short HEAD).Trim();Check-Native 'Release branch is unavailable'
    & git add -- @ReleaseFiles;Check-Native 'Release staging failed'
    & git commit --only -m "Release $Version" -- @ReleaseFiles;Check-Native 'Release commit failed'
    & git push;Check-Native 'Release push failed'
   }finally{Pop-Location}
   $Dispatch=@{ref=$Branch;inputs=@{version=$Version}}|ConvertTo-Json -Depth 3 -Compress
   $Workflow='https://api.github.com/repos/Emrevrg/cude-ide-releases/actions/workflows/publish-pages.yml/dispatches'
   $null=Invoke-RestMethod -Method Post -Uri $Workflow -Headers $Headers -Body $Dispatch -ContentType 'application/json'
  }finally{$Token=$null;$Headers=$null}
  & curl.exe --fail --location --max-time 120 --retry 6 --retry-delay 5 --range 0-0 --output NUL $Download;Check-Native 'Live installer check failed'
  $LiveManifest=Join-Path $Dist 'live-manifest.json'
  $ExpectedHash=(Get-FileHash $Manifest -Algorithm SHA256).Hash
  $LiveMatches=$false
  for($Attempt=0;$Attempt -lt 12;$Attempt++){
   & curl.exe --silent --show-error --fail --location --max-redirs 0 --max-time 30 --output $LiveManifest $Feed
   if($LASTEXITCODE -eq 0 -and (Get-FileHash $LiveManifest -Algorithm SHA256).Hash -eq $ExpectedHash){$LiveMatches=$true;break}
   Start-Sleep -Seconds 10
  }
  if(!$LiveMatches){throw 'Live manifest has not deployed or differs from the signed release.'}
  $ZipStatus=& curl.exe --silent --show-error --head --max-time 30 --output NUL --write-out '%{http_code}' $Url
  if($LASTEXITCODE -ne 0 -or $ZipStatus -ne '200'){throw 'Pages update archive did not return HTTP 200 directly.'}
 }
 [IO.File]::WriteAllText((Join-Path $Dist 'update-sequence.txt'),[string]$Sequence)
 @{dryRun=$DryRun.IsPresent;version=$Version;sequence=$Sequence;installer=$Installer;sha256=$Sha;download=$Download;manifest=$Feed;pagesArchive=$PagesTar;pagesArchiveBytes=(Get-Item -LiteralPath $PagesTar).Length;archiveUrl=$Url}|ConvertTo-Json|Set-Content (Join-Path $Dist 'release-summary.json') -Encoding UTF8
 Write-Host "Release ready: $Version; sequence=$Sequence; DryRun=$($DryRun.IsPresent)"
 Write-Host "Download: $Download"
 Write-Host "Manifest: $Feed"
}finally{
 $env:TEMP=$OldTemp;$env:TMP=$OldTmp
}


param(
  [Parameter(Mandatory)][string]$Archive,
  [string]$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Cache='E:\CudeBuildCache'
)
$ErrorActionPreference='Stop'
$Expected='5AF2194E6B86FCAD6D9F66D0A9C2158FECCEAF1BD9518F43E68BD629DD3F6B9D'
if((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Expected){throw 'Electron 43.8.12 archive checksum mismatch.'}
$Current=(Resolve-Path (Join-Path $Root 'dist\Cude-IDE')).Path
$Stage=Join-Path $Cache ('cude-electron-43.8.12-'+[Guid]::NewGuid().ToString('N'))
$Work=Join-Path $Stage 'Cude-IDE'
$Electron=Join-Path $Stage 'electron'
New-Item -ItemType Directory -Path $Work,$Electron -Force | Out-Null
& tar.exe -xf $Archive -C $Electron
if($LASTEXITCODE -ne 0){throw 'Electron extraction failed.'}
& robocopy.exe $Current $Work /E /XD (Join-Path $Current 'data') /XF debug.log /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if($LASTEXITCODE -ge 8){throw 'Could not stage Cude workbench.'}
foreach($file in Get-ChildItem -LiteralPath $Electron -File){
  if($file.Name -in @('electron.exe','version','LICENSE','LICENSES.chromium.html')){continue}
  Copy-Item -LiteralPath $file.FullName -Destination $Work -Force
}
Get-ChildItem -LiteralPath (Join-Path $Electron 'locales') -File | Copy-Item -Destination (Join-Path $Work 'locales') -Force
Copy-Item -LiteralPath (Join-Path $Electron 'LICENSE') -Destination (Join-Path $Work 'LICENSE.electron.txt') -Force
Copy-Item -LiteralPath (Join-Path $Electron 'LICENSES.chromium.html') -Destination $Work -Force
$Target=Join-Path $Work 'CudeIDE.exe'
Copy-Item -LiteralPath (Join-Path $Electron 'electron.exe') -Destination $Target -Force
$env:CUDE_PREVIOUS_EXE=Join-Path $Current 'CudeIDE.exe'
$env:CUDE_STAGED_EXE=$Target
@"
const fs=require('node:fs');
const wire=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
function config(file){
  const data=fs.readFileSync(file);
  const marker=data.indexOf(wire);
  if(marker<0||data.indexOf(wire,marker+wire.length)>=0)throw Error('Electron fuse wire missing or ambiguous.');
  const pos=marker+wire.length;
  if(data[pos]!==1||data[pos+1]!==9)throw Error('Electron fuse layout changed.');
  return {data,pos:pos+2};
}
const old=config(process.env.CUDE_PREVIOUS_EXE), next=config(process.env.CUDE_STAGED_EXE);
old.data.copy(next.data,next.pos,old.pos,old.pos+9);
fs.writeFileSync(process.env.CUDE_STAGED_EXE,next.data);
"@ | node -
if($LASTEXITCODE -ne 0){throw 'Electron fuse migration failed.'}
$ResourceEditor=Join-Path $Root 'downloads\rcedit-x64.exe'
if((Get-FileHash -LiteralPath $ResourceEditor).Hash -ne '3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A'){throw 'rcedit checksum mismatch.'}
& $ResourceEditor $Target --set-icon (Join-Path $Work 'cude.ico') --set-version-string CompanyName 'Cude Team' --set-version-string ProductName 'Cude IDE' --set-version-string ProductVersion '0.1.0' --set-version-string FileVersion '0.1.0' --set-version-string FileDescription 'Cude IDE' --set-version-string OriginalFilename 'CudeIDE.exe' --set-version-string InternalName 'CudeIDE'
if($LASTEXITCODE -ne 0){throw 'Could not brand the new Electron runtime.'}
New-Item -ItemType Directory -Path (Join-Path $Work 'data') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Current 'data\PORTABLE.txt') -Destination (Join-Path $Work 'data')
Write-Output $Work

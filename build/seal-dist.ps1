# Signs the extension inside a portable folder (dist\Cude-IDE) so production integrity checks pass.
# Usage: powershell -File build\seal-dist.ps1 [-Root dist\Cude-IDE] [-PrivateKey E:\Projeler\CudeIDE-anahtarlar\release-ed25519.pem]
param([string]$Root = (Join-Path $PSScriptRoot '..\dist\Cude-IDE'), [string]$PrivateKey = 'E:\Projeler\CudeIDE-anahtarlar\release-ed25519.pem', [string]$Feed = 'https://emrevrg.github.io/cude-ide-releases/update/manifest.json')
$ErrorActionPreference = 'Stop'
$Ext = Join-Path $Root 'resources\app\extensions\cude-ai'
$Package = Get-Content (Join-Path $Ext 'package.json') -Raw | ConvertFrom-Json
$Files = [ordered]@{}
foreach ($File in Get-ChildItem (Join-Path $Ext 'out') -File -Filter *.js | Where-Object { $_.Name -cmatch '^[a-zA-Z0-9_-]+\.js$' } | Sort-Object Name) {
  $Files['out/' + $File.Name] = (Get-FileHash $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$Scratch = Join-Path ([IO.Path]::GetTempPath()) ('cude-seal-' + [Guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $Scratch | Out-Null
try {
  $Inventory = Join-Path $Scratch 'inventory.json'
  [IO.File]::WriteAllText($Inventory, (@{ version = $Package.version; files = $Files } | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
  & node (Join-Path $PSScriptRoot 'publish-update.js') seal $Inventory $PrivateKey (Join-Path $Ext 'integrity.json'); if ($LASTEXITCODE) { throw 'seal failed' }
  Remove-Item (Join-Path $Ext 'release-trust.json') -ErrorAction SilentlyContinue
  & node (Join-Path $PSScriptRoot 'publish-update.js') trust $PrivateKey $Feed (Join-Path $Ext 'release-trust.json'); if ($LASTEXITCODE) { throw 'trust failed' }
  "sealed $($Files.Count) files, version $($Package.version)"
} finally { Remove-Item $Scratch -Recurse -Force -ErrorAction SilentlyContinue }

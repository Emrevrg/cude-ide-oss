param(
  [string]$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
$Work=(Resolve-Path -LiteralPath (Join-Path $Root 'dist\Cude-IDE')).Path
$Version=(Get-Content -LiteralPath (Join-Path $Work 'resources/app/extensions/cude-ai/package.json') -Raw | ConvertFrom-Json).version
$Zip=Join-Path $Root "dist\Cude-IDE-$Version-win32-x64.zip"
$Candidate=Join-Path (Split-Path -Parent $Zip) ('.cude-pack-'+[Guid]::NewGuid().ToString('N')+'.tmp')
$Reparse=[IO.FileAttributes]::ReparsePoint
$SecretPath='(?i)(^|/)(\.env(?:[./]|$)|[^/]+\.env$|\.envrc$|\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd|pgpass|dockercfg)$|\.(?:ssh|aws|gnupg|kube|docker|azure|gcloud|git|cude|codex|claude)(?:/|$)|(?:secrets?|credentials?)(?:[./]|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|sss\.txt$)|\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|tfvars|tfstate|sqlite3?|db|token)(?:[.-]|$)|(?:service[-_]?account|client[-_]?secret)[^/]*\.json$'
$SecretText=[regex]::new('(?-i)(?<![\w-])(?:nvapi-[A-Za-z0-9_-]{24,}|cude_[0-9a-f]{64}|gh[pousr]_[A-Za-z0-9]{28,}|sk-(?:proj-|ant-api[0-9]+-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|hf_[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{18,})|-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----(?:\\r)?\\n[A-Za-z0-9+/]{32,}', [Text.RegularExpressions.RegexOptions]::Compiled,[TimeSpan]::FromSeconds(5))
$TextNames='(?i)\.(?:[cm]?js|jsx|tsx?|html?|css|json[cl]?|xml|svg|txt|md|ini|ya?ml|toml|conf|cfg|ps1|cmd|bat|sh|properties|env|map|csv|log)$|(?:^|/)(?:LICENSE|NOTICE|README)(?:[./]|$)'
$Required=@('CudeIDE.exe','data/PORTABLE.txt','resources/app/extensions/cude-ai/out/extension.js')

function Assert-RegularReleaseItem([IO.FileSystemInfo]$Item) {
  if(($Item.Attributes -band $Reparse) -ne 0){throw 'Release input contains a link or junction.'}
}

function Get-ReleaseFiles([IO.DirectoryInfo]$Directory) {
  foreach($Item in Get-ChildItem -LiteralPath $Directory.FullName -Force){
    $Relative=$Item.FullName.Substring($Work.Length+1).Replace('\','/')
    if($Relative -eq 'data'){continue}
    if($Relative -match '^resources/app/extensions/cude-ai/(out/out|media/media)(?:/|$)'){continue}
    if($Relative -match '(?i)(?:^|/)(?:gateway|user-data|userData|workspaceStorage|globalStorage|logs)(?:/|$)' -or
       $Relative -match '(?i)\.(?:log|map|dmp)$'){continue}
    if(!$Item.PSIsContainer -and $Item.Name -eq '.npmrc'){continue}
    Assert-RegularReleaseItem $Item
    if($Relative -match $SecretPath){throw 'Release input contains a sensitive file name.'}
    if($Item.PSIsContainer){Get-ReleaseFiles $Item}
    else{[pscustomobject]@{File=$Item;Relative=$Relative}}
  }
}

function Assert-NoReleaseSecret($Stream,[string]$Relative) {
  $Reader=[IO.StreamReader]::new($Stream,[Text.Encoding]::UTF8,$true,16384,$true)
  try{
    $AfterPemHeader=$false
    while($null -ne ($Line=$Reader.ReadLine())){
      if($SecretText.IsMatch($Line) -or ($AfterPemHeader -and $Line -match '^\s*[A-Za-z0-9+/]{32,}={0,2}\s*$')){
        throw ('Release input contains a possible credential in '+$SecretText.Replace($Relative,'[redacted]')+'.')
      }
      $AfterPemHeader=$Line -match '^\s*-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----\s*$'
    }
  }finally{$Reader.Dispose()}
}

$ReleaseDir=Get-Item -LiteralPath $Work
Assert-RegularReleaseItem $ReleaseDir
$MarkerDirectory=Get-Item -LiteralPath (Join-Path $Work 'data')
Assert-RegularReleaseItem $MarkerDirectory
$Marker=Get-Item -LiteralPath (Join-Path $MarkerDirectory.FullName 'PORTABLE.txt')
Assert-RegularReleaseItem $Marker
if($Marker.PSIsContainer -or $Marker.Length -gt 512){throw 'Invalid portable marker.'}
$Files=@(Get-ReleaseFiles $ReleaseDir)+@([pscustomobject]@{File=$Marker;Relative='data/PORTABLE.txt'})
foreach($Entry in $Required){if($Entry -cnotin $Files.Relative){throw "Missing release file: $Entry"}}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive=$null
try {
  if(!$ValidateOnly){$Archive=[IO.Compression.ZipFile]::Open($Candidate,[IO.Compression.ZipArchiveMode]::Create)}
  foreach($Record in $Files){
    $File=$Record.File
    Assert-RegularReleaseItem (Get-Item -LiteralPath $File.FullName -Force)
    $Input=[IO.File]::Open($File.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
      if($Record.Relative -match $TextNames){Assert-NoReleaseSecret $Input $Record.Relative; $Input.Position=0}
      if($Archive){
        $Entry=$Archive.CreateEntry("Cude-IDE/$($Record.Relative)",[IO.Compression.CompressionLevel]::Fastest)
        $Output=$Entry.Open()
        try{$Input.CopyTo($Output)}finally{$Output.Dispose()}
      }
    }finally{$Input.Dispose()}
  }
  if($Archive){$Archive.Dispose();$Archive=$null}
  if($ValidateOnly){Write-Host "Release inputs validated ($($Files.Count) files).";return}
  $Check=[IO.Compression.ZipFile]::OpenRead($Candidate)
  try{
    foreach($Entry in $Required){if(!$Check.GetEntry("Cude-IDE/$Entry")){throw "Missing release file: $Entry"}}
  }finally{$Check.Dispose()}
  Move-Item -LiteralPath $Candidate -Destination $Zip -Force
  Write-Host "Portable ZIP created at $Zip"
}finally{
  if($Archive){$Archive.Dispose()}
  if([IO.File]::Exists($Candidate)){[IO.File]::Delete($Candidate)}
}

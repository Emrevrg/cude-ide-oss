param(
 [Parameter(Mandatory=$true)][string]$Archive,
 [Parameter(Mandatory=$true)][string]$Url,
 [Parameter(Mandatory=$true)][string]$Feed,
 [Parameter(Mandatory=$true)][string]$Version,
 [Parameter(Mandatory=$true)][string]$MinimumVersion,
 [Parameter(Mandatory=$true)][int]$Sequence,
 [Parameter(Mandatory=$true)][string]$PrivateKey,
 [Parameter(Mandatory=$true)][string]$Output,
 [string]$NotesFile='',
 [switch]$Mandatory
)
$ErrorActionPreference='Stop'
# Private key is an operator-supplied path; it is never copied into the package.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Scratch=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Output))) ('.publish-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Scratch | Out-Null
$Inventory=Join-Path $Scratch 'inventory.json'
$Integrity=Join-Path $Scratch 'integrity.json'
$Trust=Join-Path $Scratch 'release-trust.json'
$Prefix='Cude-IDE/resources/app/extensions/cude-ai/'
$Zip=[IO.Compression.ZipFile]::Open([IO.Path]::GetFullPath($Archive),[IO.Compression.ZipArchiveMode]::Update)
try{
 $Files=[ordered]@{}
 foreach($Entry in @($Zip.Entries | Sort-Object FullName)){
  $Normalized=$Entry.FullName.Replace('\','/')
  if($Normalized -cmatch ('^'+[regex]::Escape($Prefix)+'out/[a-zA-Z0-9_-]+\.js$')){
   $Stream=$Entry.Open();$Sha=[Security.Cryptography.SHA256]::Create()
   try{$Files[$Normalized.Substring($Prefix.Length)]=([BitConverter]::ToString($Sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()}finally{$Stream.Dispose();$Sha.Dispose()}
  }
 }
 if(!$Files.Contains('out/extension.js')){throw 'Archive does not contain Cude extension'}
 $PackageEntry=@($Zip.Entries | Where-Object {$_.FullName.Replace('\','/') -ceq ($Prefix+'package.json')}) | Select-Object -First 1
 if(!$PackageEntry){throw 'Missing extension package.json'}
 $Reader=[IO.StreamReader]::new($PackageEntry.Open())
 try{$Package=$Reader.ReadToEnd() | ConvertFrom-Json}finally{$Reader.Dispose()}
 if($Package.version -cne $Version){throw 'Archive extension version differs from release version'}
 [IO.File]::WriteAllText($Inventory,(@{version=$Version;files=$Files} | ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
 & node (Join-Path $PSScriptRoot 'publish-update.js') seal $Inventory $PrivateKey $Integrity
 if($LASTEXITCODE){throw 'Integrity signing failed'}
 & node (Join-Path $PSScriptRoot 'publish-update.js') trust $PrivateKey $Feed $Trust
 if($LASTEXITCODE){throw 'Trust configuration failed'}
 foreach($Record in @(@('integrity.json',$Integrity),@('release-trust.json',$Trust))){
  foreach($Existing in @($Zip.Entries | Where-Object {$_.FullName.Replace('\','/') -ceq ($Prefix+$Record[0])})){$Existing.Delete()}
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip,$Record[1],$Prefix+$Record[0]) | Out-Null
 }
 $PrivacyName='Cude-IDE/docs/PRIVACY.md'
 foreach($Existing in @($Zip.Entries | Where-Object {$_.FullName.Replace('\','/') -ceq $PrivacyName})){$Existing.Delete()}
 [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip,(Join-Path $PSScriptRoot '../docs/PRIVACY.md'),$PrivacyName) | Out-Null
}finally{$Zip.Dispose()}
& node (Join-Path $PSScriptRoot 'publish-update.js') publish $Archive $Url $Version $MinimumVersion $Sequence $PrivateKey $Output ($Mandatory.IsPresent.ToString().ToLowerInvariant()) $NotesFile
if($LASTEXITCODE){throw 'Release signing failed'}
Write-Host "Signed release written: $Output"
Write-Host "Publish the modified archive and manifest together. Scratch inventory: $Scratch"

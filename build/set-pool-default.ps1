param([Parameter(Mandatory=$true)][string]$Manifest)

$ErrorActionPreference='Stop'
$Value=[string]$env:CUDE_PUBLIC_POOL_URL
if(!$Value.Trim()){return}
$Origin=$null
if(![Uri]::TryCreate($Value.Trim(),[UriKind]::Absolute,[ref]$Origin) -or
   $Origin.Scheme -ne 'https' -or !$Origin.Host -or $Origin.UserInfo -or
   $Origin.AbsolutePath -ne '/' -or $Origin.Query -or $Origin.Fragment){
  throw 'CUDE_PUBLIC_POOL_URL must be a plain HTTPS origin.'
}
$Metadata=[IO.File]::ReadAllText($Manifest)|ConvertFrom-Json
$Setting=$Metadata.contributes.configuration.properties.'cude-ai.freePool.url'
if(!$Setting){throw 'Cude Pool setting missing from the extension manifest.'}
$Setting.default=$Origin.GetLeftPart([UriPartial]::Authority)
[IO.File]::WriteAllText($Manifest,($Metadata|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))

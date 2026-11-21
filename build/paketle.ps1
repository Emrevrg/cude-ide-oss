param(
  [string]$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'create-portable-zip.ps1') -Root $Root -ValidateOnly:$ValidateOnly

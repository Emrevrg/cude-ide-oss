# Usage: powershell -File build\orchestra.ps1 status | send <codex|neon> "message"
param([string]$Cmd='status',[string]$Agent,[string]$Message)
$o=Join-Path $PSScriptRoot '..\.orchestra'
if($Cmd -eq 'send'){ Add-Content -Path (Join-Path $o "$Agent-inbox.md") -Encoding utf8 -Value "`n## $(Get-Date -Format 'dd MMM HH:mm') - Claude`n$Message"; "sent to $Agent"; return }
foreach($a in 'codex','neon'){ "===== $a status"; Get-Content (Join-Path $o "$a-status.md") -Encoding utf8 -Tail 15 }
"===== IDE_HATALAR (son 20)"; Get-Content (Join-Path $PSScriptRoot '..\IDE_HATALAR.md') -Encoding utf8 -Tail 20 -ErrorAction SilentlyContinue
"===== changed files"; git -C (Join-Path $PSScriptRoot '..') status --short | Select-Object -First 25

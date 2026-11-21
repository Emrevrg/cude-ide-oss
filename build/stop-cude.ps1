$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Exe=(Resolve-Path (Join-Path $Root 'dist\Cude-IDE\CudeIDE.exe')).Path
$Targets=Get-Process CudeIDE -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.Equals($Exe,[StringComparison]::OrdinalIgnoreCase)}
foreach($Target in $Targets){Stop-Process -Id $Target.Id -Force -ErrorAction SilentlyContinue}
Write-Host "Stopped $($Targets.Count) Cude IDE test process(es)."

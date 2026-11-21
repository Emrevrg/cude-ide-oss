$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:TEMP='E:\rust\tmp';$env:TMP='E:\rust\tmp'
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$Work=(Resolve-Path (Join-Path $Root 'dist\Cude-IDE')).Path
$UnexpectedExe=Join-Path $Work 'VSCodium.exe'
if(Test-Path $UnexpectedExe){
  $Resolved=(Resolve-Path $UnexpectedExe).Path
  if(!$Resolved.StartsWith($Work,[StringComparison]::OrdinalIgnoreCase)){throw "Unexpected executable path: $Resolved"}
  Remove-Item -LiteralPath $Resolved -Force
}
$Exe=(Resolve-Path (Join-Path $Work 'CudeIDE.exe')).Path
Get-Process CudeIDE -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.Equals($Exe,[StringComparison]::OrdinalIgnoreCase)} | Stop-Process -Force
Start-Process -FilePath $Exe -ArgumentList @('--new-window') -WorkingDirectory $Work
Start-Sleep -Seconds 12
Get-Process CudeIDE -ErrorAction SilentlyContinue | Select-Object Id,MainWindowHandle,MainWindowTitle,Responding,CPU,WorkingSet64,Path
Get-ChildItem (Join-Path $Work 'data') -Recurse -File -ErrorAction SilentlyContinue | Select-Object FullName,Length | Select-Object -First 30

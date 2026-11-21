# cude-core derleme (Windows GNU araç zinciri; eski C:\MinGW 32-bit dlltool'u PATH'ten çıkarılır).
$env:CARGO_HOME='E:\rust\cargo'; $env:RUSTUP_HOME='E:\rust\rustup'; $env:CARGO_TARGET_DIR='E:\rust\tmp\cude-core-target'; $env:TEMP='E:\rust\tmp'
$sc='E:\rust\rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained'
$env:Path="E:\rust\cargo\bin;E:\mingw64\bin;$sc;" + (($env:Path -split ';' | Where-Object { $_ -notmatch 'MinGW' }) -join ';')
Set-Location $PSScriptRoot
cargo build --release
Copy-Item "$env:CARGO_TARGET_DIR\release\cude-core.exe" "$PSScriptRoot\..\extensions\cude-ai\bin\cude-core.exe" -Force -ErrorAction SilentlyContinue

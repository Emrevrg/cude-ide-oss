# Captures only the Cude IDE window (no taskbar, no desktop, no overlays) to a PNG.
# Usage: powershell -File build\capture-window.ps1 -OutFile marketing\shots\agent.png [-ProcessPath E:\...\CudeIDE.exe]
param([string]$OutFile, [string]$ProcessPath = 'E:\Projeler\CudeIDE\dist\Cude-IDE\CudeIDE.exe')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class CudeCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
}
'@
$proc = Get-Process CudeIDE | Where-Object { $_.Path -eq $ProcessPath -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'Cude IDE window not found.' }
$h = $proc.MainWindowHandle
$r = New-Object CudeCap+RECT
# Extended frame bounds exclude the invisible resize border.
if ([CudeCap]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [void][CudeCap]::GetWindowRect($h, [ref]$r) }
$full = New-Object CudeCap+RECT; [void][CudeCap]::GetWindowRect($h, [ref]$full)
$w = $full.Right - $full.Left; $hh = $full.Bottom - $full.Top
$bmp = New-Object Drawing.Bitmap $w, $hh
$g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
[void][CudeCap]::PrintWindow($h, $dc, 2)   # PW_RENDERFULLCONTENT renders Chromium content
$g.ReleaseHdc($dc); $g.Dispose()
$crop = New-Object Drawing.Rectangle ($r.Left - $full.Left), ($r.Top - $full.Top), ($r.Right - $r.Left), ($r.Bottom - $r.Top)
$out = $bmp.Clone($crop, $bmp.PixelFormat)
New-Item -ItemType Directory -Force (Split-Path $OutFile) | Out-Null
$out.Save($OutFile, [Drawing.Imaging.ImageFormat]::Png)
"$OutFile $($crop.Width)x$($crop.Height)"

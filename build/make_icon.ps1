param([Parameter(Mandatory=$true)][string]$Png,[Parameter(Mandatory=$true)][string]$Ico,[Parameter(Mandatory=$true)][string]$IconDir)
Add-Type -AssemblyName System.Drawing
$sizes=@(16,24,32,48,64,70,128,150,256)
$IconDir=[IO.Path]::GetFullPath($IconDir);New-Item -ItemType Directory -Force $IconDir | Out-Null
$source=[Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Png))
$frames=@()
foreach($size in $sizes){
  $bmp=[Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g=[Drawing.Graphics]::FromImage($bmp);$g.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$g.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::HighQuality;$g.DrawImage($source,0,0,$size,$size);$bmp.Save((Join-Path $IconDir "cude-$size.png"),[Drawing.Imaging.ImageFormat]::Png)
  $ms=[IO.MemoryStream]::new();$bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png);$frames+=,@{Size=$size;Bytes=$ms.ToArray()};$g.Dispose();$bmp.Dispose();$ms.Dispose()
}
$source.Dispose();$fs=[IO.File]::Create([IO.Path]::GetFullPath($Ico));$bw=[IO.BinaryWriter]::new($fs);$bw.Write([UInt16]0);$bw.Write([UInt16]1);$bw.Write([UInt16]$frames.Count);$offset=6+16*$frames.Count
foreach($frame in $frames){$s=$frame.Size;$b=$frame.Bytes;$bw.Write([Byte]$(if($s -eq 256){0}else{$s}));$bw.Write([Byte]$(if($s -eq 256){0}else{$s}));$bw.Write([Byte]0);$bw.Write([Byte]0);$bw.Write([UInt16]1);$bw.Write([UInt16]32);$bw.Write([UInt32]$b.Length);$bw.Write([UInt32]$offset);$offset+=$b.Length}
foreach($frame in $frames){$bw.Write($frame.Bytes)};$bw.Dispose();$fs.Dispose()

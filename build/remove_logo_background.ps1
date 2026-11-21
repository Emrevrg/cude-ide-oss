param([string]$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$SourcePath=Join-Path $Root 'assets\cude_logo.png'
$Image=[Drawing.Bitmap]::new($SourcePath)
$Output=[Drawing.Bitmap]::new($Image.Width,$Image.Height,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
$MinX=$Image.Width;$MinY=$Image.Height;$MaxX=0;$MaxY=0
for($y=0;$y -lt $Image.Height;$y++){
  for($x=0;$x -lt $Image.Width;$x++){
    $c=$Image.GetPixel($x,$y);$a=[int][Math]::Max($c.R,[Math]::Max($c.G,$c.B))
    if($a -lt 3){$a=0};$Output.SetPixel($x,$y,[Drawing.Color]::FromArgb($a,255,255,255))
    if($a -gt 16){if($x -lt $MinX){$MinX=$x};if($x -gt $MaxX){$MaxX=$x};if($y -lt $MinY){$MinY=$y};if($y -gt $MaxY){$MaxY=$y}}
  }
}
$LogoPath=Join-Path $Root 'assets\cude_logo_transparent.png'
$Output.Save($LogoPath,[Drawing.Imaging.ImageFormat]::Png)
$W=$MaxX-$MinX+1;$H=$MaxY-$MinY+1;$Pad=[int][Math]::Ceiling([Math]::Max($W,$H)*0.08);$Side=[Math]::Max($W,$H)+2*$Pad
$Icon=[Drawing.Bitmap]::new($Side,$Side,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
$Graphics=[Drawing.Graphics]::FromImage($Icon);$Graphics.Clear([Drawing.Color]::Transparent);$Graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$Graphics.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$DestX=[int](($Side-$W)/2);$DestY=[int](($Side-$H)/2);$Graphics.DrawImage($Output,[Drawing.Rectangle]::new($DestX,$DestY,$W,$H),[Drawing.Rectangle]::new($MinX,$MinY,$W,$H),[Drawing.GraphicsUnit]::Pixel)
$Icon.Save((Join-Path $Root 'assets\cude_icon.png'),[Drawing.Imaging.ImageFormat]::Png)
$Graphics.Dispose();$Icon.Dispose();$Output.Dispose();$Image.Dispose()
Write-Host "Created transparent Cude logo and cropped application icon ($Side x $Side)."

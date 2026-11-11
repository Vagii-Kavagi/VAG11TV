# Draws the VAG11 TV launcher artwork (design E, "skip mark") at every size the base APK carries:
#   icon   (res/mipmap-*/ic_app):       80, 120, 160, 240, 320 px square
#   banner (res/drawable*/app_banner):  160x90, 240x135, 320x180, 480x270, 640x360
# Near-black background, a red disc with a white skip-ahead mark, and VAGII in white on the banner.
#   powershell -ExecutionPolicy Bypass -File cobalt\art\make_art.ps1
Add-Type -AssemblyName System.Drawing
$out = $PSScriptRoot
$bg = [System.Drawing.ColorTranslator]::FromHtml("#0F0F0F")
$red = [System.Drawing.ColorTranslator]::FromHtml("#FF0033")
$white = [System.Drawing.Color]::White

# The first installed of these: Roboto is YouTube's typeface; the others are close enough.
$family = "Arial"
foreach ($f in @("Roboto", "Segoe UI", "Arial")) {
    if ((New-Object System.Drawing.Text.InstalledFontCollection).Families.Name -contains $f) { $family = $f; break }
}

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($bg)
    return @($bmp, $g)
}

# The red disc with two white triangles pointing right (skip ahead), centred on (cx, cy).
function Draw-Mark($g, [single]$cx, [single]$cy, [single]$r) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $red), $cx - $r, $cy - $r, 2 * $r, 2 * $r)
    $t = $r * 0.45; $w = $r * 0.45; $x0 = $cx - $w; $brush = New-Object System.Drawing.SolidBrush $white
    foreach ($dx in @(0, $w)) {
        $pts = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ($x0 + $dx), ($cy - $t)),
            (New-Object System.Drawing.PointF ($x0 + $dx + $w), $cy),
            (New-Object System.Drawing.PointF ($x0 + $dx), ($cy + $t)))
        $g.FillPolygon($brush, $pts)
    }
}

foreach ($s in @(80, 120, 160, 240, 320)) {
    $c = New-Canvas $s $s; $bmp = $c[0]; $g = $c[1]
    Draw-Mark $g ($s / 2) ($s / 2) ($s * 0.36)
    $bmp.Save((Join-Path $out "ic_app_$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

foreach ($w in @(160, 240, 320, 480, 640)) {
    $h = [int]($w * 9 / 16)
    $c = New-Canvas $w $h; $bmp = $c[0]; $g = $c[1]
    $r = $h * 0.24
    $font = New-Object System.Drawing.Font $family, ([single]($h * 0.30)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $text = $g.MeasureString("VAGII", $font, 10000, $fmt)
    $gap = $h * 0.12
    $total = 2 * $r + $gap + $text.Width
    $x = ($w - $total) / 2
    Draw-Mark $g ($x + $r) ($h / 2) $r
    $g.DrawString("VAGII", $font, (New-Object System.Drawing.SolidBrush $white), ($x + 2 * $r + $gap), (($h - $text.Height) / 2), $fmt)
    $bmp.Save((Join-Path $out "app_banner_$w.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
Write-Host "font: $family"
Get-ChildItem $out -Filter *.png | ForEach-Object { "{0} {1}" -f $_.Name, $_.Length }

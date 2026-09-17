# Генератор бренд-ассетов установщика ChiselCode.
# Запуск: powershell -ExecutionPolicy Bypass -File installer/assets/generate-assets.ps1
# На выходе (рядом со скриптом): header.bmp 150x57, welcome.bmp 164x314 (24-bit,
# точные размеры для MUI2), icon.ico (PNG-сжатый: 16/32/48/256).
# Стиль: тёмный фон как в TUI + циановый ромб ◈.
Add-Type -AssemblyName System.Drawing

$Bg = [System.Drawing.Color]::FromArgb(13, 17, 23)
$Cyan = [System.Drawing.Color]::FromArgb(34, 211, 238)
$White = [System.Drawing.Color]::FromArgb(241, 245, 249)
$Gray = [System.Drawing.Color]::FromArgb(148, 163, 184)

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear($Bg)
  return @{ Bmp = $bmp; G = $g }
}

function Add-Diamond($g, $cx, $cy, $r, $penWidth) {
  $pen = New-Object System.Drawing.Pen($Cyan, $penWidth)
  $pts = [System.Drawing.Point[]]@(
    (New-Object System.Drawing.Point([int]$cx, [int]($cy - $r))),
    (New-Object System.Drawing.Point([int]($cx + $r), [int]$cy)),
    (New-Object System.Drawing.Point([int]$cx, [int]($cy + $r))),
    (New-Object System.Drawing.Point([int]($cx - $r), [int]$cy))
  )
  $g.DrawPolygon($pen, $pts)
  $pen.Dispose()
  # Точка-«искра» в центре.
  $dot = $r * 0.28
  $brush = New-Object System.Drawing.SolidBrush($Cyan)
  $g.FillEllipse($brush, $cx - $dot / 2, $cy - $dot / 2, $dot, $dot)
  $brush.Dispose()
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- header.bmp: ромб слева, справа место под текст MUI ---
$c = New-Canvas 150 57
Add-Diamond $c.G 28 28 15 3
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(30, 41, 59), 1)
$c.G.DrawLine($pen, 52, 10, 52, 47)
$pen.Dispose()
$c.G.Dispose()
$c.Bmp.Save((Join-Path $dir "header.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$c.Bmp.Dispose()
"header.bmp ok"

# --- welcome.bmp: крупный ромб + название ---
$c = New-Canvas 164 314
Add-Diamond $c.G 82 110 52 7
$font = New-Object System.Drawing.Font("Segoe UI Semibold", 21)
$brush = New-Object System.Drawing.SolidBrush($White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$c.G.DrawString("ChiselCode", $font, $brush, 82, 185, $sf)
$font2 = New-Object System.Drawing.Font("Segoe UI", 10)
$brush2 = New-Object System.Drawing.SolidBrush($Gray)
$c.G.DrawString("Secure coding agent", $font2, $brush2, 82, 222, $sf)
$font.Dispose(); $font2.Dispose(); $brush.Dispose(); $brush2.Dispose(); $sf.Dispose()
$c.G.Dispose()
$c.Bmp.Save((Join-Path $dir "welcome.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$c.Bmp.Dispose()
"welcome.bmp ok"

# --- icon.ico: классический BMP-пейлоад (максимальная совместимость:
# читает любой NSIS и любая Windows, в отличие от PNG-сжатых иконок).
# Формат на картинку: BITMAPINFOHEADER(40) + XOR(w*h*4, BGRA снизу вверх)
# + AND-маска (1 бит/пиксель, строки до 32 бит).
function New-IconBmp($size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $cx = $size / 2; $cy = $size / 2; $r = $size * 0.36
  $pen = New-Object System.Drawing.Pen($Cyan, [Math]::Max(2, $size * 0.07))
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF($cx, ($cy - $r))),
    (New-Object System.Drawing.PointF(($cx + $r), $cy)),
    (New-Object System.Drawing.PointF($cx, ($cy + $r))),
    (New-Object System.Drawing.PointF(($cx - $r), $cy))
  )
  $g.DrawPolygon($pen, $pts)
  $pen.Dispose()
  $dot = $size * 0.1
  $brush = New-Object System.Drawing.SolidBrush($Cyan)
  $g.FillEllipse($brush, $cx - $dot / 2, $cy - $dot / 2, $dot, $dot)
  $brush.Dispose()
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  # BITMAPINFOHEADER: height = size*2 (XOR + AND), 32 bpp, BI_RGB.
  $bw.Write([uint32]40)
  $bw.Write([int32]$size)
  $bw.Write([int32]($size * 2))
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)
  $bw.Write([uint32]0)
  $bw.Write([int32]0)
  $bw.Write([int32]0)
  $bw.Write([uint32]0)
  $bw.Write([uint32]0)
  # XOR: строки снизу вверх, BGRA.
  for ($y = $size - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $size; $x++) {
      $p = $bmp.GetPixel($x, $y)
      $bw.Write([byte]$p.B)
      $bw.Write([byte]$p.G)
      $bw.Write([byte]$p.R)
      $bw.Write([byte]$p.A)
    }
  }
  # AND-маска: прозрачные пиксели — 1, строки снизу вверх до 32 бит.
  $rowBytes = [Math]::Ceiling($size / 32) * 4
  for ($y = $size - 1; $y -ge 0; $y--) {
    $bits = New-Object byte[] $rowBytes
    for ($x = 0; $x -lt $size; $x++) {
      if ($bmp.GetPixel($x, $y).A -lt 128) {
        $bits[$x -shr 3] = $bits[$x -shr 3] -bor (0x80 -shr ($x -band 7))
      }
    }
    $bw.Write($bits, 0, $bits.Length)
  }
  $bw.Flush()
  $bmp.Dispose()
  return $ms.ToArray()
}

$sizes = @(16, 32, 48, 256)
$blobs = @()
foreach ($s in $sizes) { $blobs += , (New-IconBmp $s) }
$fs = [System.IO.File]::Create((Join-Path $dir "icon.ico"))
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([byte](($s -band 0xFF)))
  $bw.Write([byte](($s -band 0xFF)))
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$blobs[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $blobs[$i].Length
}
foreach ($b in $blobs) {
  $bytes = [byte[]]$b
  $bw.Write($bytes, 0, $bytes.Length)
}
$bw.Close(); $fs.Close()
"icon.ico ok"

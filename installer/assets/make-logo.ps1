# Логотип ChiselCode из исходной картинки.
# Запуск: powershell -ExecutionPolicy Bypass -File installer/assets/make-logo.ps1 -Source <путь к картинке>
# На выходе (installer/assets): logo.png (прозрачный фон) и icon.ico
# (16/32/48/256, классический BMP-пейлоад — читает любой NSIS и Windows).
# Белый фон выедается flood-fill с краёв + feather против белого ореола.
param([string]$Source = "")

Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Join-Path $dir "logo-source.png"
}
if (-not (Test-Path -LiteralPath $Source)) {
  throw "Исходник не найден: $Source. Положи картинку логотипа и укажи -Source."
}

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
public static class LogoTool {
  // White background to transparency: edge flood-fill over near-white
  // neutral pixels + edge feather with unblend from white (no halo).
  public static Bitmap Transparentize(Bitmap src) {
    int w = src.Width, h = src.Height;
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      g.DrawImage(src, 0, 0, w, h);
    }
    BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h),
      ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int stride = data.Stride;
    byte[] px = new byte[stride * h];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, px.Length);

    Func<int, int, int> idx = (x, y) => y * stride + x * 4;
    Func<int, bool> isWhite = (i) => {
      int b = px[i], g = px[i + 1], r = px[i + 2];
      int mn = Math.Min(Math.Min(r, g), b);
      int mx = Math.Max(Math.Max(r, g), b);
      return mn >= 240 && (mx - mn) <= 12;
    };

    // Edge-connected flood-fill: background only, interior untouched.
    bool[] seen = new bool[w * h];
    var stack = new System.Collections.Generic.Stack<int>();
    for (int x = 0; x < w; x++) { stack.Push(x); stack.Push((h - 1) * w + x); }
    for (int y = 0; y < h; y++) { stack.Push(y * w); stack.Push(y * w + (w - 1)); }
    while (stack.Count > 0) {
      int p = stack.Pop();
      int x = p % w, y = p / w;
      if (x < 0 || y < 0 || x >= w || y >= h || seen[p]) continue;
      seen[p] = true;
      int i = idx(x, y);
      if (!isWhite(i)) continue;
      px[i + 3] = 0; // transparent
      if (x > 0) stack.Push(p - 1);
      if (x < w - 1) stack.Push(p + 1);
      if (y > 0) stack.Push(p - w);
      if (y < h - 1) stack.Push(p + w);
    }

    // Feather the edge: opaque neighbours of transparent pixels with
    // a whitish tint get partial alpha with unblend from white.
    byte[] alpha = new byte[w * h];
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        alpha[y * w + x] = px[idx(x, y) + 3];
    int[] dx = { -1, 1, 0, 0 };
    int[] dy = { 0, 0, -1, 1 };
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int p = y * w + x, i = idx(x, y);
        if (px[i + 3] == 0) continue;
        bool edge = false;
        for (int k = 0; k < 4; k++) {
          int nx = x + dx[k], ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || alpha[ny * w + nx] == 0) { edge = true; break; }
        }
        if (!edge) continue;
        int b = px[i], g = px[i + 1], r = px[i + 2];
        int mn = Math.Min(Math.Min(r, g), b);
        if (mn < 200) continue;
        double a = 255.0 * (248 - mn) / 48.0;
        if (a < 0) a = 0; if (a > 255) a = 255;
        if (a >= 254) continue;
        double af = a / 255.0, ab = 1 - af;
        px[i] = (byte)Math.Max(0, Math.Min(255, (b - 255 * ab) / Math.Max(af, 0.01)));
        px[i + 1] = (byte)Math.Max(0, Math.Min(255, (g - 255 * ab) / Math.Max(af, 0.01)));
        px[i + 2] = (byte)Math.Max(0, Math.Min(255, (r - 255 * ab) / Math.Max(af, 0.01)));
        px[i + 3] = (byte)a;
      }
    }

    System.Runtime.InteropServices.Marshal.Copy(px, 0, data.Scan0, px.Length);
    bmp.UnlockBits(data);
    return bmp;
  }

  public static Bitmap Resize(Bitmap src, int size) {
    Bitmap dst = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(dst)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.DrawImage(src, 0, 0, size, size);
    }
    return dst;
  }

  // Обрезка прозрачных полей: в исходной фотке вокруг скруглённого квадрата
  // ~12% пустых полей с каждой стороны — без trim марка в ярлыках выглядит
  // мелкой рядом с иконками во весь кадр. Оставляем небольшой запас.
  public static Bitmap TrimTransparent(Bitmap src, double marginFraction) {
    int w = src.Width, h = src.Height;
    BitmapData data = src.LockBits(new Rectangle(0, 0, w, h),
      ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int stride = data.Stride;
    byte[] px = new byte[stride * h];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, px.Length);
    src.UnlockBits(data);
    Func<int, int, int> idx = (x, y) => y * stride + x * 4;
    int minX = w, minY = h, maxX = -1, maxY = -1;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        if (px[idx(x, y) + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return new Bitmap(src);
    int margin = (int)((maxX - minX + 1) * marginFraction);
    int x0 = System.Math.Max(minX - margin, 0);
    int y0 = System.Math.Max(minY - margin, 0);
    int x1 = System.Math.Min(maxX + margin, w - 1);
    int y1 = System.Math.Min(maxY + margin, h - 1);
    Bitmap dst = new Bitmap(x1 - x0 + 1, y1 - y0 + 1, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(dst)) {
      g.DrawImage(src, new Rectangle(0, 0, dst.Width, dst.Height),
        new Rectangle(x0, y0, dst.Width, dst.Height), GraphicsUnit.Pixel);
    }
    return dst;
  }

  // Unsharp mask (box 3x3) поверх даунскейза: возвращает чёткость мелким
  // иконкам. Только RGB, альфу не трогаем.
  public static void Sharpen(Bitmap bmp, double amount) {
    int w = bmp.Width, h = bmp.Height;
    BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h),
      ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int stride = data.Stride;
    byte[] px = new byte[stride * h];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, px.Length);
    byte[] orig = (byte[])px.Clone();
    Func<int, int, int> idx = (x, y) => y * stride + x * 4;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int sr = 0, sg = 0, sb = 0;
        for (int ky = -1; ky <= 1; ky++) {
          int ny = y + ky < 0 ? 0 : (y + ky >= h ? h - 1 : y + ky);
          for (int kx = -1; kx <= 1; kx++) {
            int nx = x + kx < 0 ? 0 : (x + kx >= w ? w - 1 : x + kx);
            int ni = idx(nx, ny);
            sb += orig[ni]; sg += orig[ni + 1]; sr += orig[ni + 2];
          }
        }
        int i = idx(x, y);
        px[i] = Clamp(orig[i] + amount * (orig[i] - sb / 9.0));
        px[i + 1] = Clamp(orig[i + 1] + amount * (orig[i + 1] - sg / 9.0));
        px[i + 2] = Clamp(orig[i + 2] + amount * (orig[i + 2] - sr / 9.0));
      }
    }
    System.Runtime.InteropServices.Marshal.Copy(px, 0, data.Scan0, px.Length);
    bmp.UnlockBits(data);
  }

  private static byte Clamp(double v) {
    if (v < 0) return 0;
    if (v > 255) return 255;
    return (byte)v;
  }
}
"@ -ReferencedAssemblies @("System.Drawing")

$src = [System.Drawing.Bitmap]::FromFile($Source)
try {
  # Квадрат по центру: иконка квадратная, исходник почти всегда тоже.
  $side = [Math]::Min($src.Width, $src.Height)
  $ox = [int](($src.Width - $side) / 2)
  $oy = [int](($src.Height - $side) / 2)
  $square = $src.Clone(
    [System.Drawing.Rectangle]::new($ox, $oy, $side, $side),
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $logo = [LogoTool]::Transparentize($square)
  $square.Dispose()
  $trimmed = [LogoTool]::TrimTransparent($logo, 0.025)
  $logo.Dispose()
  # ICO требует квадрат: добиваем прозрачными полями, арт не тянем.
  $side = [Math]::Max($trimmed.Width, $trimmed.Height)
  $canvas = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($canvas)
  $gg.DrawImage($trimmed, [int](($side - $trimmed.Width) / 2), [int](($side - $trimmed.Height) / 2), $trimmed.Width, $trimmed.Height)
  $gg.Dispose()
  $trimmed.Dispose()
  $logo = $canvas

  $logoPath = Join-Path $dir "logo.png"
  $logo.Save($logoPath, [System.Drawing.Imaging.ImageFormat]::Png)
  "logo.png ok ($($logo.Width)x$($logo.Height))"

  # --- icon.ico: классический BMP-пейлоад (как в generate-assets.ps1) ---
  # Все размеры — из фотки логотипа (даунскейз); никакой рисованной
  # графики. Маленьким (16/32/48) — лёгкий unsharp после ресайза,
  # чтобы долото и скобки не мылились: это та же фотка, только чётче.
  function New-IconBlob($bmp, $s) {
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint32]40)
    $bw.Write([int32]$s)
    $bw.Write([int32]($s * 2))
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]0)
    $bw.Write([uint32]0)
    $bw.Write([int32]0)
    $bw.Write([int32]0)
    $bw.Write([uint32]0)
    $bw.Write([uint32]0)
    for ($y = $s - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $s; $x++) {
        $p = $bmp.GetPixel($x, $y)
        $bw.Write([byte]$p.B)
        $bw.Write([byte]$p.G)
        $bw.Write([byte]$p.R)
        $bw.Write([byte]$p.A)
      }
    }
    $rowBytes = [Math]::Ceiling($s / 32) * 4
    for ($y = $s - 1; $y -ge 0; $y--) {
      $bits = New-Object byte[] $rowBytes
      for ($x = 0; $x -lt $s; $x++) {
        if ($bmp.GetPixel($x, $y).A -lt 128) {
          $bits[$x -shr 3] = $bits[$x -shr 3] -bor (0x80 -shr ($x -band 7))
        }
      }
      $bw.Write($bits, 0, $bits.Length)
    }
    $bw.Flush()
    $blob = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()
    return , $blob
  }
  $sizes = @(16, 32, 48, 256)
  $blobs = @()
  foreach ($s in $sizes) {
    $bmp = [LogoTool]::Resize($logo, $s)
    if ($s -le 48) { [LogoTool]::Sharpen($bmp, 0.5) }
    $blobs += , (New-IconBlob $bmp $s)
    $bmp.Dispose()
  }
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
  "icon.ico ok (16/32/48/256)"
  $logo.Dispose()
} finally {
  $src.Dispose()
}

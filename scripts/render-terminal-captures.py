"""Export actual OpenTUI captureSpans JSON to PNG without changing its content."""
import json
import os
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

windows_fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
def font(linux_path, windows_name, size, fallback=None):
    path = Path(linux_path)
    if not path.exists():
        path = windows_fonts / windows_name
    return ImageFont.truetype(str(path), size) if path.exists() else fallback

regular = font("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "consola.ttf", 14)
bold = font("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "consolab.ttf", 14, regular)
# DejaVu Sans Mono has no Braille glyphs; use the same cell width from Sans.
braille = font("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "seguisym.ttf", 13, regular)
cjk = font("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "msyh.ttc", 14, regular)
cell_width, cell_height = 9, 19
for source in Path(sys.argv[1]).glob("*.json"):
    data = json.loads(source.read_text(encoding="utf-8"))
    if not all(key in data for key in ("cols", "rows", "lines")):
        continue
    canvas = Image.new("RGB", (data["cols"] * cell_width, data["rows"] * cell_height))
    draw = ImageDraw.Draw(canvas)
    for y, line in enumerate(data["lines"]):
        x = 0
        for span in line["spans"]:
            width = span["width"]
            draw.rectangle((x * cell_width, y * cell_height, (x + width) * cell_width - 1, (y + 1) * cell_height - 1), fill=tuple(span["bg"][:3]))
            column = x
            for character in span["text"]:
                if unicodedata.combining(character):
                    continue
                cells = 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1
                font = braille if 0x2800 <= ord(character) <= 0x28FF else cjk if cells == 2 else bold if span.get("attributes", 0) & 1 else regular
                draw.text((column * cell_width, y * cell_height + 1), character, font=font, fill=tuple(span["fg"][:3]))
                column += cells
            x += width
    canvas.save(source.with_suffix(".png"))

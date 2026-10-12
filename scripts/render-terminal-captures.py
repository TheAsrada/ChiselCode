"""Export actual OpenTUI captureSpans JSON to PNG without changing its content."""
import json
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

regular = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 14)
bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 14)
cjk = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 14)
cell_width, cell_height = 9, 19
for source in Path(sys.argv[1]).glob("*.json"):
    data = json.loads(source.read_text())
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
                draw.text((column * cell_width, y * cell_height + 1), character, font=cjk if cells == 2 else bold if span.get("attributes", 0) & 1 else regular, fill=tuple(span["fg"][:3]))
                column += cells
            x += width
    canvas.save(source.with_suffix(".png"))

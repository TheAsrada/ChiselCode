"""Extract the actual, fixed-width request row from captureSpans evidence."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
parser.add_argument("prefix")
args = parser.parse_args()
args.destination.mkdir(parents=True, exist_ok=True)
count = 0
for source in sorted(args.source.glob(f"{args.prefix}*.json")):
    data = json.loads(source.read_text())
    region = data.get("requestStatus")
    if not region:
        continue
    left, top, width, height = (region[key] for key in ("x", "y", "width", "height"))
    if not (0 <= left < data["cols"] and 0 <= top < data["rows"] and left + width <= data["cols"] and top + height <= data["rows"]):
        raise ValueError(f"Status is outside the captured viewport: {source}")
    lines = []
    for row in data["lines"][top:top + height]:
        spans, column = [], 0
        for span in row["spans"]:
            end = column + span["width"]
            start, stop = max(column, left), min(end, left + width)
            if stop > start:
                # Status uses fixed, single-cell symbols, Cyrillic and digits.
                # Refuse arbitrary wide/combining content rather than misrepresent it.
                if len(span["text"]) != span["width"]:
                    raise ValueError(f"Region contains non-single-cell text: {source}")
                spans.append({**span, "text": span["text"][start - column:stop - column], "width": stop - start})
            column = end
        if sum(span["width"] for span in spans) != width:
            raise ValueError(f"Incomplete native row: {source}")
        lines.append({"spans": spans})
    cropped = {**data, "cols": width, "rows": height, "lines": lines, "sourceRegion": {"file": source.name, **region}, "requestStatus": {"x": 0, "y": 0, "width": width, "height": height}}
    (args.destination / source.name).write_text(json.dumps(cropped, ensure_ascii=False))
    count += 1
print(f"Extracted {count} native status rows")

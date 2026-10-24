"""Export an animation from real captureSpans frames, preserving their timing."""
import argparse
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("prefix")
parser.add_argument("output", type=Path)
args = parser.parse_args()
sources = sorted(args.directory.glob(f"{args.prefix}*.json"))
if len(sources) < 2:
    parser.error("At least two native frames are required")
times = [json.loads(path.read_text())["capturedAtMs"] for path in sources]
gaps = [max(30, min(1000, round(b - a))) for a, b in zip(times, times[1:])]
durations = gaps + [round(statistics.median(gaps))]
with tempfile.TemporaryDirectory(prefix="chisel-terminal-animation-") as temporary:
    directory = Path(temporary)
    for source in sources:
        shutil.copy2(source, directory / source.name)
    subprocess.run([sys.executable, str(Path(__file__).with_name("render-terminal-captures.py")), str(directory)], check=True)
    frames = []
    for source in sources:
        with Image.open(directory / source.with_suffix(".png").name) as frame:
            frames.append(frame.copy())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(args.output, save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=2)
print(f"Exported {len(frames)} native frames to {args.output}")

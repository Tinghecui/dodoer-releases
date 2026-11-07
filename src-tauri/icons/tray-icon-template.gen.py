"""Generate src-tauri/icons/tray-icon-template.png.

This is a macOS menu-bar template image: the system reads only the alpha
channel and tints the opaque pixels to match light/dark/highlighted menu
bar appearance. dodoer (jenny fork): the art is the Dodo mark in
tray-icon-template.svg. Re-run after editing it:

    python3 src-tauri/icons/tray-icon-template.gen.py

Requires Pillow (pip install Pillow) and the project's Tauri CLI, which
rasterizes the SVG.
"""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image

# The menu bar's 22pt row at 2x, the canvas the old template used too.
W, H = 52, 44
PAD = 1

ICONS_DIR = Path(__file__).resolve().parent
REPO_ROOT = ICONS_DIR.parents[1]
SOURCE_SVG = ICONS_DIR / "tray-icon-template.svg"
OUTPUT = ICONS_DIR / "tray-icon-template.png"


def main():
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        subprocess.run(
            ["pnpm", "tauri", "icon", str(SOURCE_SVG), "-o", str(out)],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
        )
        art = Image.open(out / "icon.png").convert("RGBA")
    alpha = art.split()[3]
    alpha = alpha.crop(alpha.getbbox())
    scale = min((W - 2 * PAD) / alpha.width, (H - 2 * PAD) / alpha.height)
    size = (round(alpha.width * scale), round(alpha.height * scale))
    alpha = alpha.resize(size, Image.LANCZOS)
    mask = Image.new("L", (W, H), 0)
    mask.paste(alpha, ((W - size[0]) // 2, (H - size[1]) // 2))
    image = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    image.putalpha(mask)
    image.save(OUTPUT)
    print(f"wrote {OUTPUT} ({W}x{H})")


if __name__ == "__main__":
    main()

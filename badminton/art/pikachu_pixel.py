"""Pixel-art Pikachu (personal fan art).

Run: python3 art/pikachu_pixel.py
  -> art/pikachu_pixel.png (preview) and pikachu_grid.json (the sprite the game loads)
"""
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

PALETTE = {
    ".": None,
    "K": (34, 28, 26),     # outline
    "Y": (250, 214, 54),   # body yellow
    "O": (226, 168, 22),   # shade
    "R": (232, 64, 56),    # cheeks
    "W": (255, 255, 255),  # eye highlight
    "B": (150, 92, 40),    # tail base brown
    "t": (250, 214, 54),   # tail yellow (same color, separate letter so games can recolor the tail)
    "k": (34, 28, 26),     # tail outline
}

# Left half (13 cols); mirrored to make a symmetric 26-col body.
LEFT = [
    "K............",
    "KK...........",
    "KKK..........",
    ".KKK.........",
    ".KKKK........",
    "..KKYK.......",
    "..KYYYK......",
    "...KYYYK.....",
    "...KYYYYK....",
    "....KYYYYKKKK",
    "....KYYYYYYYY",
    "...KYYYYYYYYY",
    "...KYYYYYYYYY",
    "..KYYYKKYYYYY",
    "..KYYYWKYYYYY",
    "..KYYYKKYYYYK",
    "..KRRRYYYYYYY",
    "..KRRRYYYYKYK",
    "..KRRRYYYYYKY",
    "...KYYYYYYYYY",
    "....KYYYYYYYY",
    ".....KYYYYYYY",
    "....KYYYYYYYY",
    "....KYKKYYYYY",
    "....KYYKYYYYY",
    "....KYYYYYYYY",
    "....KOYYYYYYY",
    "....KOOYYYYYY",
    "...KYYKOOOOOO",
    "...KKKKKKKKKK",
]

W, H = 35, len(LEFT) + 2
PAD_X, PAD_Y = 1, 1

grid = [[None] * W for _ in range(H)]
for y, row in enumerate(LEFT):
    full = row + row[::-1]
    for x, ch in enumerate(full):
        grid[y + PAD_Y][x + PAD_X] = ch if ch != "." else None

# Lightning-bolt tail, hand-drawn, placed behind the body.
TAIL = [
    "......KKKKK",
    ".....KYYYYK",
    "....KYYYYK.",
    "...KYYYYK..",
    "..KYYYYYYK.",
    "..KKKKYYK..",
    ".....KYK...",
    "....KYYK...",
    "...KYYK....",
    "..KYYK.....",
    ".KBBK......",
    "KBBK.......",
]
TAIL_OX, TAIL_OY = 22 + PAD_X, 11 + PAD_Y
for ly, row in enumerate(TAIL):
    for lx, ch in enumerate(row):
        gx, gy = lx + TAIL_OX, ly + TAIL_OY
        if ch != "." and grid[gy][gx] is None:
            grid[gy][gx] = {"Y": "t", "K": "k"}.get(ch, ch)

# Render PNG (RGBA) at SCALE x.
SCALE = 16
rows = []
for y in range(H):
    line = bytearray()
    for x in range(W):
        c = PALETTE[grid[y][x]] if grid[y][x] else None
        px = bytes((*c, 255)) if c else b"\x00\x00\x00\x00"
        line += px * SCALE
    for _ in range(SCALE):
        rows.append(b"\x00" + bytes(line))

raw = b"".join(rows)


def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", W * SCALE, H * SCALE, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw, 9))
png += chunk(b"IEND", b"")

with open(HERE / "pikachu_pixel.png", "wb") as f:
    f.write(png)
print(f"saved art/pikachu_pixel.png ({W*SCALE}x{H*SCALE})")

# Export the grid: the game (game.js) builds its sprite from this file.
import json

with open(HERE.parent / "pikachu_grid.json", "w") as f:
    json.dump({
        "rows": ["".join(ch or "." for ch in row) for row in grid],
        "palette": {k: "#%02x%02x%02x" % v for k, v in PALETTE.items() if v},
        "center_x": 13 + PAD_X,
    }, f, indent=1)
print("saved pikachu_grid.json")

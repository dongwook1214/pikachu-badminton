"""The CPU opponent: an original storm-cloud sprite with a lightning-bolt tail.

Run from the badminton folder: python3 art/cpu_pixel.py
  -> art/cpu_pixel.png (preview) and cpu_grid.json (the sprite the game loads)

Letters: C/M/D cloud light/mid/dark, K outline, W/E eye white/pupil, P blush, F feet,
t/k the bolt tail and its outline (same letters as the player sprite's tail, so Iron Tail can recolor it).
"""
import json
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
W, H = 36, 30

PALETTE = {
    "K": (38, 40, 63),
    "C": (213, 220, 239),
    "M": (154, 165, 200),
    "D": (108, 118, 156),
    "W": (255, 255, 255),
    "E": (26, 27, 46),
    "P": (127, 184, 255),
    "F": (59, 63, 99),
    "t": (255, 214, 64),
    "k": (60, 42, 20),
}

grid = [[None] * W for _ in range(H)]

# body: a heap of cloud puffs
PUFFS = [(11, 14, 6.5), (18, 11, 7.5), (24, 15, 5.5), (9, 19, 6), (17, 19, 7.5), (24, 20, 5)]
body = set()
for y in range(H):
    for x in range(W):
        if any((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r for cx, cy, r in PUFFS):
            body.add((x, y))
bottom = max(y for _, y in body)
for x, y in body:
    # light from above: bright top, a mid band, a dark rim along the underside
    below = (x, y + 1) not in body
    grid[y][x] = "D" if below or y >= bottom - 1 else "M" if y >= 20 else "C"
# a few bright highlights on the top puffs
for x, y in [(15, 6), (16, 5), (17, 5), (9, 10), (10, 9)]:
    if (x, y) in body:
        grid[y][x] = "W"

# face
for ex in (12, 20):
    for dy in range(4):
        for dx in range(3):
            grid[13 + dy][ex + dx] = "W"
    grid[15][ex + 1] = grid[16][ex + 1] = "E"
    grid[15][ex + 2 if ex == 12 else ex] = "E"
for x, y in [(15, 18), (16, 19), (17, 19), (18, 18)]:  # a small round smile
    grid[y][x] = "K"
for x, y in [(9, 17), (10, 17), (23, 17), (24, 17)]:
    grid[y][x] = "P"

# feet
for fx in (11, 20):
    for dx in range(3):
        grid[bottom + 1][fx + dx] = "F"
    grid[bottom + 1][fx - 1] = "K"
    grid[bottom + 1][fx + 3] = "K"

# outline round the cloud
for x, y in list(body):
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < W and 0 <= ny < H and grid[ny][nx] is None:
            grid[ny][nx] = "K"

# lightning-bolt tail off the right side, drawn behind the body
TAIL = [
    "....kkkkk",
    "...kttttk",
    "..ktttk..",
    ".kttttkk.",
    "kkkkttk..",
    "...kttk..",
    "..kttk...",
    "..ktk....",
    ".kk......",
]
for ty, row in enumerate(TAIL):
    for tx, ch in enumerate(row):
        x, y = 27 + tx, 9 + ty
        if ch != "." and 0 <= x < W and 0 <= y < H and grid[y][x] is None:
            grid[y][x] = ch

rows = ["".join(ch or "." for ch in r) for r in grid]
# trim empty rows/columns at the edges, and record where the feet are centred
xs = [x for r in rows for x, ch in enumerate(r) if ch != "."]
ys = [y for y, r in enumerate(rows) if r.strip(".")]
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
rows = [r[x0 : x1 + 1] for r in rows[y0 : y1 + 1]]

with open(HERE.parent / "cpu_grid.json", "w") as f:
    json.dump({"rows": rows, "palette": {k: "#%02x%02x%02x" % v for k, v in PALETTE.items()}, "center_x": 17 - x0}, f, indent=1)
print(f"saved cpu_grid.json ({len(rows[0])}x{len(rows)})")

# preview at 16x
S = 16
raw = b""
for r in rows:
    line = bytearray(b"\x00")
    for ch in r:
        line += (bytes((*PALETTE[ch], 255)) if ch != "." else b"\x00\x00\x00\x00") * S
    raw += bytes(line) * S


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


w, h = len(rows[0]) * S, len(rows) * S
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
(HERE / "cpu_pixel.png").write_bytes(png)
print("saved art/cpu_pixel.png")

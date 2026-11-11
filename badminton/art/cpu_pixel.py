"""The CPU opponent: an original storm-cloud sprite with a lightning-bolt tail.

Run from the badminton folder: python3 art/cpu_pixel.py
  -> art/cpu_pixel.png (preview) and cpu_grid.json (the sprite the game loads)

Letters: C/M/D cloud light/mid/dark, K outline, W/E eye white/pupil, P blush, F feet,
t/k the bolt tail and its outline (same letters as the player sprite's tail, so Iron Tail can recolor it).
"""
import json
import math
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
OX = 8  # room on the left for a squashed (wider) cloud; the standing one is drawn on a 36x30 grid from x = OX
W, H = 36 + 2 * OX, 30
CX, FB = 17.0, 27.0  # the cloud's centre line and the floor line under its body: squashing keeps both in place

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

# body: a heap of cloud puffs
PUFFS = [(11, 14, 6.5), (18, 11, 7.5), (24, 15, 5.5), (9, 19, 6), (17, 19, 7.5), (24, 20, 5)]

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


def draw(sx=1.0, sy=1.0, eyes="open", feet=True):
    """The cloud, squashed sx wide and sy tall about its centre line and the floor (1, 1: standing).
    eyes: "open", "shut" (a line) or "squeezed" (> <). Returns the trimmed rows and the centre column."""
    # where pixel (x, y) of the standing cloud lands
    X = lambda x: math.floor(CX + (x + 0.5 - CX) * sx) + OX
    Y = lambda y: math.floor(FB - (FB - y - 0.5) * sy)
    grid = [[None] * W for _ in range(H)]

    # the puffs squash into ellipses: test each pixel's centre, mapped back onto the standing cloud
    body = set()
    for y in range(H):
        for x in range(W):
            u, v = CX + (x - OX + 0.5 - CX) / sx, FB - (FB - y - 0.5) / sy
            if any((u - cx) ** 2 + (v - cy) ** 2 <= r * r for cx, cy, r in PUFFS):
                body.add((x, y))
    bottom = max(y for _, y in body)
    for x, y in body:
        # light from above: bright top, a mid band, a dark rim along the underside
        below = (x, y + 1) not in body
        grid[y][x] = "D" if below or y >= bottom - 1 else "M" if y >= FB - (FB - 20) * sy else "C"
    # a few bright highlights on the top puffs
    for x, y in [(15, 6), (16, 5), (17, 5), (9, 10), (10, 9)]:
        if (X(x), Y(y)) in body:
            grid[Y(y)][X(x)] = "W"

    # face
    for ex in (12, 20):
        if eyes == "open":
            for dy in range(4):
                for dx in range(3):
                    grid[13 + dy][ex + OX + dx] = "W"
            grid[15][ex + OX + 1] = grid[16][ex + OX + 1] = "E"
            grid[15][ex + OX + (2 if ex == 12 else 0)] = "E"
            continue
        c, r, s = X(ex + 1), Y(15), 1 if ex == 12 else -1  # s: which way the > or < points (to the middle)
        if eyes == "shut":
            for dx in (-1, 0, 1):
                grid[r][c + dx] = "K"
        else:
            for dx, dy in ((-s, -1), (0, -1), (s, 0), (-s, 1), (0, 1)):
                grid[r + dy][c + dx] = "K"
    sdy = Y(18) - 18
    for x, y in [(15, 18), (16, 19), (17, 19), (18, 18)]:  # a small round smile
        grid[y + sdy][x + OX] = "K"
    for x0 in (X(9), X(24) - 1):  # blush
        grid[Y(17)][x0] = grid[Y(17)][x0 + 1] = "P"

    # feet, spread out with the body
    if feet:
        for fx in (11, 20):
            c = X(fx + 1)
            for dx in (-1, 0, 1):
                grid[bottom + 1][c + dx] = "F"
            grid[bottom + 1][c - 2] = grid[bottom + 1][c + 2] = "K"

    # outline round the cloud
    for x, y in list(body):
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and grid[ny][nx] is None:
                grid[ny][nx] = "K"

    # the tail keeps its whole shape (so it still reads as the bolt) and moves with the body's right side
    tx0, ty0 = X(27), 9 + Y(17) - 17
    for ty, row in enumerate(TAIL):
        for tx, ch in enumerate(row):
            x, y = tx0 + tx, ty0 + ty
            if ch != "." and 0 <= x < W and 0 <= y < H and grid[y][x] is None:
                grid[y][x] = ch

    rows = ["".join(ch or "." for ch in r) for r in grid]
    # trim empty rows/columns at the edges, and record where the centre column ends up
    xs = [x for r in rows for x, ch in enumerate(r) if ch != "."]
    ys = [y for y, r in enumerate(rows) if r.strip(".")]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    return [r[x0 : x1 + 1] for r in rows[y0 : y1 + 1]], 17 + OX - x0


rows, center_x = draw()
# Squashed flat (Down held on the ground): halfway, then flat. The eyes shut, then squeeze to > <; the feet
# disappear under the flat one, and the bolt tail stays whole.
SQUASH = [draw(1.12, 0.8, "shut"), draw(1.25, 0.62, "squeezed", feet=False)]

with open(HERE.parent / "cpu_grid.json", "w") as f:
    json.dump({
        "rows": rows,
        "palette": {k: "#%02x%02x%02x" % v for k, v in PALETTE.items()},
        "center_x": center_x,
        "squash": [{"rows": r, "center_x": c} for r, c in SQUASH],
    }, f, indent=1)
print(f"saved cpu_grid.json ({len(rows[0])}x{len(rows)}, {len(SQUASH)} squash frames)")

# preview at 16x: standing, then the squash frames, feet on one line
S = 16
frames = [rows] + [r for r, _ in SQUASH]
h = max(len(r) for r in frames)
sheet = ["".join(fr[y - (h - len(fr))] if y >= h - len(fr) else "." * len(fr[0]) for fr in frames) for y in range(h)]
raw = b""
for r in sheet:
    line = bytearray(b"\x00")
    for ch in r:
        line += (bytes((*PALETTE[ch], 255)) if ch != "." else b"\x00\x00\x00\x00") * S
    raw += bytes(line) * S


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


w, h = len(sheet[0]) * S, len(sheet) * S
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
(HERE / "cpu_pixel.png").write_bytes(png)
print("saved art/cpu_pixel.png")

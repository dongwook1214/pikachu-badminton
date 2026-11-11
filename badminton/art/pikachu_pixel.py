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

PAD_X, PAD_Y = 1, 1


def build(left, tail, tail_at, w=None):
    """Mirror a left half into a symmetric body, tuck the tail in behind it; returns (grid, center_x)."""
    tail_ox, tail_oy = tail_at
    w = w or max(2 * len(left[0]), tail_ox + len(tail[0])) + 2 * PAD_X
    g = [[None] * w for _ in range(len(left) + 2 * PAD_Y)]
    for y, row in enumerate(left):
        for x, ch in enumerate(row + row[::-1]):
            g[y + PAD_Y][x + PAD_X] = ch if ch != "." else None
    for ly, row in enumerate(tail):
        for lx, ch in enumerate(row):
            gx, gy = lx + tail_ox + PAD_X, ly + tail_oy + PAD_Y
            if ch != "." and g[gy][gx] is None:
                g[gy][gx] = {"Y": "t", "K": "k"}.get(ch, ch)
    return g, len(left[0]) + PAD_X


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
grid, CENTER_X = build(LEFT, TAIL, (22, 11), w=35)

# Squashed flat (Down held on the ground): a halfway frame, then the full squash. The body bulges sideways and
# the eyes squeeze shut (the full squash is a footless blob), but the ears still point up and out and the full
# frame keeps the whole bolt tail standing behind it, so it stays recognisably Pikachu.
SQUASH_HALF = [
    "K................",
    "KKK..............",
    ".KKKK............",
    "..KKKKK..........",
    "...KKYYKK........",
    "....KYYYYKKKKKKKK",
    ".....KYYYYYYYYYYY",
    "....KYYYYYYYYYYYY",
    "...KYYYYYYYYYYYYY",
    "...KYYYYKKKYYYYYY",
    "..KYYYYYYYYYYYYYK",
    "..KYYYYYYYYYYYYYY",
    "..KRRRRYYYYYYYKYK",
    "..KRRRRYYYYYYYYKY",
    "...KYYYYYYYYYYYYY",
    "....KYYYYYYYYYYYY",
    "...KYYYYYYYYYYYYY",
    "...KYKKYYYYYYYYYY",
    "...KYYKYYYYYYYYYY",
    "...KOYYYYYYYYYYYY",
    "..KYOOYYYYYYYYYYY",
    "..KYYKOOOOOOOOOOO",
    "..KKKKKKKKKKKKKKK",
]
TAIL_HALF = [
    "........KKKKK",
    "......KKYYYYK",
    "....KKYYYYKK.",
    "...KYYYYYYK..",
    "...KKKKYYK...",
    ".....KYYK....",
    "...KYYK......",
    ".KBBK........",
    "KBBK.........",
]
SQUASH_FULL = [
    "KK.................",
    "KKKKK..............",
    ".KKKYYKK...........",
    "...KYYYYYKK........",
    ".....KKYYYYKKKKKKKK",
    "......KYYYYYYYYYYYY",
    ".....KYYYYYYYYYYYYY",
    "....KYYYYYYYYYYYYYY",
    "...KYYYYYYKKYYYYYYY",
    "...KYYYYYYYYKYYYYYY",
    "...KYYYYYYKKYYYYYYK",
    "..KYYYYYYYYYYYYYYYY",
    "..KRRRRYYYYYYYYYKYK",
    "..KRRRRYYYYYYYYYYKY",
    "...KYYYYYYYYYYYYYYY",
    "..KYYKKYYYYYYYYYYYY",
    "..KOYYKYYYYYYYYYYYY",
    "..KOOYYYYYYYYYYYYYY",
    "...KOOOOOOOOOOOOOOO",
    "....KKKKKKKKKKKKKKK",
]
SQUASH_FRAMES = [
    build(SQUASH_HALF, TAIL_HALF, (25, 10)),
    build(SQUASH_FULL, TAIL, (33, 5)),
]

# Render PNG (RGBA) at SCALE x: the standing sprite, then the squash frames, feet on one line.
SCALE = 16
frames = [grid] + [g for g, _ in SQUASH_FRAMES]
H = max(len(g) for g in frames)
W = sum(len(g[0]) for g in frames)
sheet = [[None] * W for _ in range(H)]
x0 = 0
for g in frames:
    for y, row in enumerate(g):
        for x, ch in enumerate(row):
            sheet[H - len(g) + y][x0 + x] = ch
    x0 += len(g[0])
rows = []
for y in range(H):
    line = bytearray()
    for x in range(W):
        c = PALETTE[sheet[y][x]] if sheet[y][x] else None
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


def text(g):
    return ["".join(ch or "." for ch in row) for row in g]


with open(HERE.parent / "pikachu_grid.json", "w") as f:
    json.dump({
        "rows": text(grid),
        "palette": {k: "#%02x%02x%02x" % v for k, v in PALETTE.items() if v},
        "center_x": CENTER_X,
        "squash": [{"rows": text(g), "center_x": cx} for g, cx in SQUASH_FRAMES],
    }, f, indent=1)
print("saved pikachu_grid.json")

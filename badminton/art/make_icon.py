"""App icon for the home screen: a pixel shuttlecock crossed by a lightning bolt (original art).

Run from the badminton folder: python3 art/make_icon.py
  -> icon-192.png, icon-512.png, icon-180.png (apple-touch-icon)
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent
N = 32  # the icon is drawn on a 32x32 pixel grid, then scaled up

BG = (27, 24, 64)
BG2 = (36, 31, 84)
BOLT = (255, 210, 60)
BOLT_HI = (255, 240, 150)
INK = (12, 10, 24)
FEATHER = (240, 242, 250)
FEATHER_SH = (168, 176, 200)
CORK = (226, 196, 140)
CORK_SH = (180, 140, 90)


def inside(px, py, poly):
    hit = False
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > py) != (y2 > py) and px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


grid = [[BG2 if (x + y) % 2 == 0 and (x // 4 + y // 4) % 2 == 0 else BG for x in range(N)] for y in range(N)]

# shuttlecock: cork at the lower left, feather skirt opening up and to the right
skirt = [(9, 21), (6, 16), (17, 5), (25, 13), (14, 24)]
for y in range(N):
    for x in range(N):
        if inside(x + 0.5, y + 0.5, skirt):
            grid[y][x] = FEATHER_SH if (x + y) % 5 == 0 or x + y > 34 else FEATHER
for cx, cy in [(8, 23), (9, 23), (8, 24), (7, 22), (9, 22), (8, 22), (7, 23), (10, 22), (9, 24)]:
    grid[cy][cx] = CORK
for cx, cy in [(7, 24), (8, 25), (10, 23)]:
    grid[cy][cx] = CORK_SH

# lightning bolt across the middle
bolt = [(20, 2), (27, 2), (21, 12), (26, 12), (11, 30), (15, 17), (9, 17)]
cells = set()
for y in range(N):
    for x in range(N):
        if inside(x + 0.5, y + 0.5, bolt):
            cells.add((x, y))
for x, y in cells:
    grid[y][x] = BOLT_HI if (x - 1, y) not in cells or (x, y - 1) not in cells else BOLT
for x, y in cells:  # dark outline so the bolt reads over the white feathers
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < N and 0 <= ny < N and (nx, ny) not in cells:
            grid[ny][nx] = INK


def png(size, path):
    k = size / N
    rows = []
    for py in range(size):
        line = bytearray(b"\x00")
        src = grid[min(N - 1, int(py / k))]
        for px in range(size):
            line += bytes(src[min(N - 1, int(px / k))])
        rows.append(bytes(line))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)
    print(f"saved {path.name} ({size}x{size})")


for size in (192, 512, 180):
    png(size, OUT / f"icon-{size}.png")

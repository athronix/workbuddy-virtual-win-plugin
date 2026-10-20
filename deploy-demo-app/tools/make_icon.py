#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate demo app icon (512x512 PNG) without PIL.
Design: blue rounded square + white download arrow + tray.
Output: AppScope/resources/base/media/app_icon.png and
        product/phone/src/main/resources/base/media/app_icon.png
"""
import zlib, struct, os

W = H = 512
BG = (10, 89, 247)      # #0A59F7
BG_DARK = (7, 66, 190)  # darker bottom band
FG = (255, 255, 255)

px = [[BG for _ in range(W)] for _ in range(H)]

def in_circle(cx, cy, r, x, y):
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r

def rect(x0, y0, x1, y1, color):
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(W - 1, x1); y1 = min(H - 1, y1)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            px[y][x] = color

# bottom darker band (subtle two-tone)
rect(0, 340, W - 1, H - 1, BG_DARK)

# white arrow shaft: from y=120 to y=330, centered x=256, width 34
rect(256 - 17, 120, 256 + 17, 320, FG)

# arrow head: triangle pointing down, apex y=400
for y in range(120, 401):
    t = (y - 120) / 280.0
    half = int(17 + 105 * t)
    rect(256 - half, y, 256 + half, y, FG)

# tray: rounded-bottom bar from y=418 to y=448, x from 156 to 356
rect(156, 418, 356, 448, FG)
# tray "cutout": remove middle to make it a tray (open top box look)
rect(176, 418, 336, 448 - 8 if 448 - 8 > 418 else 418, FG)
# simpler: punch hole in tray center (repaint with white minus inner area)
rect(176, 418, 336, 440, (0, 0, 0, 0))  # placeholder, replaced below

# Rebuild tray cleanly: white outer U shape (left wall, right wall, bottom)
rect(156, 418, 356, 448, (10, 89, 247))          # clear
for y in range(418, 449):                          # walls
    rect(156, y, 196, y, FG)
    rect(316, y, 356, y, FG)
rect(156, 434, 356, 448, FG)                       # bottom
rect(196, 418, 316, 433, (10, 89, 247))            # inner empty

# rounded corners mask (radius 96)
r = 96
for y in range(H):
    for x in range(W):
        if not ((x < r and y < r and not in_circle(r, r, r, x, y)) or
                (x >= W - r and y < r and not in_circle(W - r - 1, r, r, x, y)) or
                (x < r and y >= H - r and not in_circle(r, H - r - 1, r, x, y)) or
                (x >= W - r and y >= H - r and not in_circle(W - r - 1, H - r - 1, r, x, y))):
            pass
# transparent corners
transparent = (0, 0, 0, 0)

def alpha_at(x, y):
    # corner rounding -> alpha 0 outside radius
    for (cx, cy) in [(r, r), (W - r - 1, r), (r, H - r - 1), (W - r - 1, H - r - 1)]:
        if (x < r or x >= W - r) and (y < r or y >= H - r):
            if (cx, cy) == (r, r) and x < r and y < r:
                return 0 if not in_circle(r, r, r, x, y) else 255
            if (cx, cy) == (W - r - 1, r) and x >= W - r and y < r:
                return 0 if not in_circle(W - r - 1, r, r, x, y) else 255
            if (cx, cy) == (r, H - r - 1) and x < r and y >= H - r:
                return 0 if not in_circle(r, H - r - 1, r, x, y) else 255
            if (cx, cy) == (W - r - 1, H - r - 1) and x >= W - r and y >= H - r:
                return 0 if not in_circle(W - r - 1, H - r - 1, r, x, y) else 255
    return 255

raw = bytearray()
for y in range(H):
    raw.append(0)  # filter none
    for x in range(W):
        if px[y][x] == (0, 0, 0, 0):
            raw += bytes((10, 89, 247))
            raw.append(alpha_at(x, y))
        else:
            r_, g_, b_ = px[y][x]
            raw += bytes((r_, g_, b_, alpha_at(x, y)))

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
png += chunk(b"IEND", b"")

out_dirs = [
    "/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app/AppScope/resources/base/media",
    "/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app/product/phone/src/main/resources/base/media",
]
for d in out_dirs:
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "app_icon.png"), "wb") as f:
        f.write(png)
    print("written:", os.path.join(d, "app_icon.png"), len(png), "bytes")

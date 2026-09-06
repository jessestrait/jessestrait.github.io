#!/usr/bin/env python3
"""Draw the ATX Layers app icon: three stacked map plates with a live incident
on the top one. Rendered at 4x and downsampled, because PIL's polygon fill has
no antialiasing of its own.

    python3 tools/make_atx_icons.py
"""
from PIL import Image, ImageDraw

S = 1024          # nominal icon size
SS = 4            # supersample factor
N = S * SS

BG_TOP    = (16, 26, 43)     # #101a2b
BG_BOTTOM = (8, 12, 20)      # #080c14  — matches --bg
PLATES    = [(28, 74, 134), (47, 111, 196), (77, 144, 232)]   # bottom -> top
LIVE      = (255, 77, 77)    # #ff4d4d  — the traffic-incident red

def rhombus(cx, cy, w, h):
    return [(cx - w, cy), (cx, cy - h), (cx + w, cy), (cx, cy + h)]

def render():
    img = Image.new('RGB', (N, N), BG_BOTTOM)
    d = ImageDraw.Draw(img, 'RGBA')

    # Vertical gradient ground. One rectangle per row is fine at this size.
    for y in range(N):
        t = y / (N - 1)
        d.line([(0, y), (N, y)], fill=tuple(
            round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))

    cx = N // 2
    half_w, half_h = 330 * SS, 182 * SS
    # Bottom plate first so each one overlaps the one below it.
    for color, cy in zip(PLATES, (665 * SS, 530 * SS, 395 * SS)):
        d.polygon(rhombus(cx, cy, half_w, half_h), fill=color)

    # The live point sitting on the top plate. One faint ring reads as a pulse
    # at 512px and disappears cleanly at 48px; a wider glow just goes muddy.
    top_cy = 395 * SS
    r = 88 * SS
    d.ellipse([cx - r, top_cy - r, cx + r, top_cy + r], fill=LIVE + (46,))
    r = 56 * SS
    d.ellipse([cx - r, top_cy - r, cx + r, top_cy + r], fill=LIVE)

    return img.resize((S, S), Image.LANCZOS)

if __name__ == '__main__':
    master = render()
    for size, name in ((512, 'atx/icons/icon-512.png'),
                       (192, 'atx/icons/icon-192.png'),
                       (180, 'atx/icons/apple-touch-icon.png'),
                       (32,  'atx/icons/favicon-32.png')):
        master.resize((size, size), Image.LANCZOS).save(name, optimize=True)
        print('wrote', name)

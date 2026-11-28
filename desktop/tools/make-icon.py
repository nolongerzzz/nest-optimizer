#!/usr/bin/env python3
"""tools/make-icon.py - draw the desktop app's icon (the plate, as the app shows it) and its sizes.
Run: python3 tools/make-icon.py   (needs Pillow). Writes assets/icon.png and assets/icons/icon-<n>.png."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024 * 4  # drawn large, scaled down for smooth edges

def lerp(a, b, t): return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
m = int(S * 0.085)
d.rounded_rectangle([m, m, S - m, S - m], radius=int(S * 0.2), fill=(10, 24, 48, 255))
# the plate: a square seen from above and to the side, like the app's own view
c = S / 2
back, right, front, left = (c - S * 0.02, S * 0.30), (S * 0.80, S * 0.47), (c + S * 0.06, S * 0.76), (S * 0.19, S * 0.52)
d.polygon([back, right, front, left], fill=(38, 40, 46, 255))
n = 6
for i in range(1, n):
    t = i / n
    w = int(S * (0.0042 if i == n // 2 else 0.0026))
    col = (120, 126, 138, 255) if i == n // 2 else (78, 83, 94, 255)
    d.line([lerp(back, left, t), lerp(right, front, t)], fill=col, width=w)
    d.line([lerp(back, right, t), lerp(left, front, t)], fill=col, width=w)
edge = int(S * 0.0075)
pts = [back, right, front, left, back]
d.line(pts, fill=(60, 176, 255, 255), width=edge, joint='curve')
# the amber corner ticks
amber, tw = (245, 180, 60, 255), int(S * 0.0065)
for corner, a, b in ((back, right, left), (right, back, front), (front, right, left), (left, back, front)):
    d.line([lerp(corner, a, 0.11), lerp(corner, b, 0.11)], fill=amber, width=tw)

big = im.resize((1024, 1024), Image.LANCZOS)
os.makedirs(os.path.join(HERE, 'assets', 'icons'), exist_ok=True)
big.save(os.path.join(HERE, 'assets', 'icon.png'))
for s in (48, 128, 256, 512):
    big.resize((s, s), Image.LANCZOS).save(os.path.join(HERE, 'assets', 'icons', 'icon-%d.png' % s))
print('wrote assets/icon.png and 4 sizes')

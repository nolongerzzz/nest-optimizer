#!/usr/bin/env python3
"""Writes fixtures/relief/line-drawing-scan.jpg:
a line drawing that has been through a flatbed scanner, SIMULATED.

    python3 tools/nso_relief_scan_fixture.py           regenerate it

There was no real scan in the repo and none could be fetched, so this one is
made, and says so. What makes a scan a scan for the relief generator is
everything that is not the ink: paper that is not white (a warm grey near 236),
uneven lamp light across the bed (+/-9 luminance levels, corner to corner),
sensor noise (sigma 3.5), the pen's own pressure making strokes 3 to 6 px wide
and not quite black, a soft optical blur, and JPEG at quality 85. Each of those
is a reason auto-contrast and the box filter exist; a clean synthetic drawing
would exercise none of them.

The drawing is a cottage, a tree, a sun and a wavy ground line - closed shapes,
open strokes, crossings and long thin lines, at 1200 x 900 px (a 4 x 3 inch
pencil sketch at 300 dpi). Ink covers about 2.4% of the page, so the 1st
percentile lands in the ink, as it does for a real sketch.

Deterministic: fixed seed, so a rerun writes the same pixels. Needs Pillow,
for this generator only - nothing in npm test runs it.
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'fixtures', 'relief')
W, H = 1200, 900
rng = random.Random(20261012)


def pen(draw, pts, base_w):
    """A stroke whose width and darkness wander, as a pen's do."""
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        w = max(3, int(round(base_w + rng.uniform(-1.2, 1.2))))
        ink = int(rng.uniform(18, 46))
        draw.line([(x0, y0), (x1, y1)], fill=ink, width=w)
        draw.ellipse([x0 - w / 2, y0 - w / 2, x0 + w / 2, y0 + w / 2], fill=ink)


def wobble(pts, amp=1.4, step=6):
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n):
            t = i / n
            out.append((x0 + (x1 - x0) * t + rng.uniform(-amp, amp),
                        y0 + (y1 - y0) * t + rng.uniform(-amp, amp)))
    out.append(pts[-1])
    return out


def circle(cx, cy, r, n=90):
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n))
            for k in range(n + 1)]


def main():
    ink = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(ink)

    # ground
    ground = [(40 + x, 720 + 14 * math.sin(x / 70.0)) for x in range(0, 1121, 8)]
    pen(d, wobble(ground, 0.8), 5)
    # cottage: walls, roof, door, window with its cross
    pen(d, wobble([(260, 716), (260, 470), (560, 470), (560, 716)]), 5)
    pen(d, wobble([(230, 480), (410, 330), (590, 480)]), 5)
    pen(d, wobble([(380, 716), (380, 590), (450, 590), (450, 716)]), 4)
    pen(d, wobble([(300, 520), (350, 520), (350, 570), (300, 570), (300, 520)]), 4)
    pen(d, wobble([(325, 520), (325, 570)]), 3)
    pen(d, wobble([(300, 545), (350, 545)]), 3)
    pen(d, wobble([(470, 380), (470, 320), (510, 320), (510, 413)]), 4)    # chimney
    # tree: trunk and a scalloped crown
    pen(d, wobble([(820, 716), (826, 520)]), 6)
    pen(d, wobble([(860, 716), (852, 520)]), 6)
    crown = []
    for k in range(0, 361, 4):
        a = math.radians(k)
        r = 120 + 16 * math.sin(7 * a)
        crown.append((840 + r * math.cos(a), 430 + 0.85 * r * math.sin(a)))
    pen(d, wobble(crown, 1.0), 5)
    # sun and rays
    pen(d, wobble(circle(1030, 150, 55), 0.8), 4)
    for k in range(10):
        a = 2 * math.pi * k / 10 + 0.2
        pen(d, wobble([(1030 + 75 * math.cos(a), 150 + 75 * math.sin(a)),
                       (1030 + 115 * math.cos(a), 150 + 115 * math.sin(a))]), 4)

    ink = ink.filter(ImageFilter.GaussianBlur(0.9))

    # the scanner: paper tone, lamp falloff, noise
    page = Image.new('L', (W, H))
    px = page.load()
    src = ink.load()
    for y in range(H):
        for x in range(W):
            paper = 236 + 9 * ((x / W) - 0.5) * 2 * 0.7 + 9 * ((y / H) - 0.5) * 2 * 0.3
            v = paper * (src[x, y] / 255.0) + rng.gauss(0, 3.5)
            px[x, y] = max(0, min(255, int(round(v))))

    os.makedirs(OUT, exist_ok=True)
    page.save(os.path.join(OUT, 'line-drawing-scan.jpg'), quality=85)
    dark = sum(1 for v in page.tobytes() if v < 128)
    print('wrote line-drawing-scan.jpg, %d x %d, %.2f%% of pixels darker than 128'
          % (W, H, 100.0 * dark / (W * H)))


if __name__ == '__main__':
    main()

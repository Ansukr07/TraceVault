"""Trace the reference stipple flower into a density map.

usage: python scripts/make-flower-map.py <reference.png> apps/web/public/flower-density.png

Output is an 8-bit grayscale PNG: 0 = outside the flower (traced boundary of the
petals, leaves and stem), 1..255 = ink density (255 = darkest).
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

src, dst = sys.argv[1], sys.argv[2]
g = 1.0 - np.asarray(Image.open(src).convert('L'), dtype=np.float32) / 255.0  # ink = 1

# 1. boundary: merge the dots into solid shapes, fill, then shave the halo back
dots = ndi.gaussian_filter(g, 2.0) > 0.035
solid = ndi.binary_dilation(dots, iterations=5)
solid = ndi.binary_fill_holes(solid)
solid = ndi.binary_erosion(solid, iterations=4)
# drop specks that aren't part of the flower
lab, n = ndi.label(solid)
sizes = ndi.sum(solid, lab, range(1, n + 1))
keep = np.zeros_like(solid)
for i, s in enumerate(sizes, 1):
    if s > 400:
        keep |= lab == i
solid = keep

# 2. tone: soft ink coverage, stretched so the dark heart hits ~1
tone = ndi.gaussian_filter(g, 5.0)
hi = np.percentile(tone[solid], 99.5)
tone = np.clip(tone / hi, 0, 1) ** 0.85

# 3. keep a sparse floor inside the boundary so petal tips stay present
dens = np.where(solid, np.clip(0.1 + 0.9 * tone, 0, 1), 0.0)

# inked rim: darker along the boundary; the thin stem is all rim, so it stays solid
rim = solid & ~ndi.binary_erosion(solid, iterations=5)
rim = ndi.gaussian_filter(rim.astype(np.float32), 1.5)
thin = solid & ~ndi.binary_opening(solid, iterations=7)   # stem + sharp tips
thin = ndi.gaussian_filter(thin.astype(np.float32), 1.0)
dens = np.where(solid, np.maximum.reduce([dens, 0.38 * np.clip(rim * 1.6, 0, 1), 0.85 * np.clip(thin * 1.5, 0, 1)]), 0.0)

# feather the very edge by 1px to avoid a jagged mask when resampled
edge = ndi.gaussian_filter(solid.astype(np.float32), 0.8)
dens = dens * np.clip(edge * 1.6, 0, 1)

out = (dens * 255).round().astype(np.uint8)
out[solid & (out < 12)] = 12

# 4. second bloom on the same stem: reuse the traced head, smaller, on a branch
import math
from PIL import ImageDraw

H, W = out.shape
head = out.copy()
head[405:, :] = 0
head[388:, 212:] = 0          # cut the head off the stem (keep a short neck)
NECK = (222.0, 386.0)         # where the head meets the stem in the reference
STEM = (234.0, 505.0)         # point on the stem where the branch leaves
TARGET = (292.0, 526.0)       # where the second head's neck lands
SCALE, ANGLE = 0.56, math.radians(58)   # smaller, tilted to the right

c, s = math.cos(ANGLE) / SCALE, math.sin(ANGLE) / SCALE
a, b, d, e = c, s, -s, c
cx = NECK[0] - (a * TARGET[0] + b * TARGET[1])
cy = NECK[1] - (d * TARGET[0] + e * TARGET[1])
head2 = Image.fromarray(head, 'L').transform((W, H), Image.AFFINE, (a, b, cx, d, e, cy), resample=Image.BICUBIC)

branch = Image.new('L', (W, H), 0)
bd = ImageDraw.Draw(branch)
ctrl = (STEM[0] + 8, TARGET[1] + 8)
pts = []
for i in range(41):
    t = i / 40
    pts.append(((1 - t) ** 2 * STEM[0] + 2 * (1 - t) * t * ctrl[0] + t * t * TARGET[0],
                (1 - t) ** 2 * STEM[1] + 2 * (1 - t) * t * ctrl[1] + t * t * TARGET[1]))
bd.line(pts, fill=215, width=6, joint='curve')

out = np.maximum.reduce([out, np.asarray(head2), np.asarray(branch)])
Image.fromarray(out, 'L').save(dst, optimize=True)
print('saved', dst, out.shape, 'coverage %.1f%%' % (100 * (out > 0).mean()))

"""Turn Higgsfield-generated sprite sheets into app-ready animation strips.

For each sheet: download, slice the grid (default 4x2, per-line override as a
third `colsxrows` column in sprite-urls.txt), key out the background per cell,
crop all frames to their union bbox (preserving inter-frame registration), and
compose a horizontal 8-frame WebP strip with alpha (grids with more cells are
capped to the first 8 frames). Keying is multi-pass so it handles both flat
backgrounds and "card" sheets where each cell is a framed panel: pass 1 floods
the border-connected background; if that removed less than half the cell (it
only ate a gutter/frame), later passes sample a ring 4px past the keyed region
— beyond the frame/card anti-aliasing — and flood the card colour inward. A
final connected-component sweep keeps only alpha connected to the cell centre,
dropping leftover anti-aliased frame rings. Writes www/img/ex-<key>.webp +
www/img/ex-meta.json. Run by .github/workflows/sprites.yml on a runner with
open internet.
"""
import json
import os
import urllib.request

import numpy as np
from PIL import Image

TARGET_H = 200
OUT = 'www/img'
THRESH = 30


def flood(simil, seed):
    conn = seed & simil
    for _ in range(4000):
        grown = conn.copy()
        grown[1:, :] |= conn[:-1, :]; grown[:-1, :] |= conn[1:, :]
        grown[:, 1:] |= conn[:, :-1]; grown[:, :-1] |= conn[:, 1:]
        grown &= simil
        if (grown == conn).all():
            break
        conn = grown
    return conn


def dilate(m, n=1):
    for _ in range(n):
        grown = m.copy()
        grown[1:, :] |= m[:-1, :]; grown[:-1, :] |= m[1:, :]
        grown[:, 1:] |= m[:, :-1]; grown[:, :-1] |= m[:, 1:]
        m = grown
    return m


def key_cell(a):
    h, w = a.shape[:2]
    corners = np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3),
                              a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    simil = (np.abs(a - bg).max(axis=2) < THRESH)
    border = np.zeros((h, w), bool)
    border[0, :] = border[-1, :] = True
    border[:, 0] = border[:, -1] = True
    keyed = flood(simil, border)
    ran2 = False
    if keyed.mean() < 0.5:
        for _ in range(3):
            d = dilate(keyed, 4)
            ring = dilate(d, 1) & ~d
            if ring.sum() < 50:
                break
            bg2 = np.median(a[ring], axis=0)
            uniform = (np.abs(a[ring] - bg2).max(axis=1) < THRESH).mean()
            if uniform < 0.5:
                break
            simil2 = (np.abs(a - bg2).max(axis=2) < THRESH) & ~keyed
            add = flood(simil2, ring & simil2)
            if not add.any():
                break
            keyed |= add
            ran2 = True
            if keyed.mean() >= 0.5:
                break
    if ran2:
        opaque = ~keyed
        centre = np.zeros((h, w), bool)
        centre[h // 5:4 * h // 5, w // 5:4 * w // 5] = True
        keyed = ~flood(opaque, opaque & centre)
    return keyed


def process(key, path, cols=4, rows=2):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    cw, ch = W // cols, H // rows
    a = np.asarray(im).astype(np.int16)
    frames = []
    for r in range(rows):
        for c in range(cols):
            cell = a[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw]
            alpha = np.where(key_cell(cell), 0, 255).astype(np.uint8)
            frames.append(np.dstack([cell.astype(np.uint8), alpha]))
    frames = frames[:8]
    boxes = []
    for f in frames:
        ys, xs = np.where(f[:, :, 3] > 0)
        boxes.append((ys.min(), xs.min(), ys.max() + 1, xs.max() + 1) if len(ys) else (0, 0, ch, cw))
    pad = 6
    y0 = max(0, min(b[0] for b in boxes) - pad); x0 = max(0, min(b[1] for b in boxes) - pad)
    y1 = min(ch, max(b[2] for b in boxes) + pad); x1 = min(cw, max(b[3] for b in boxes) + pad)
    fh, fw = y1 - y0, x1 - x0
    tw = round(fw * TARGET_H / fh)
    strip = Image.new('RGBA', (tw * len(frames), TARGET_H), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        cell = Image.fromarray(f[y0:y1, x0:x1]).resize((tw, TARGET_H), Image.LANCZOS)
        strip.paste(cell, (i * tw, 0))
    out = os.path.join(OUT, f'ex-{key}.webp')
    strip.save(out, 'WEBP', quality=86, method=6)
    return {'fw': tw, 'fh': TARGET_H}


def main():
    meta = {}
    with open('scripts/sprite-urls.txt') as fh:
        for line in fh:
            if not line.strip():
                continue
            parts = line.split()
            key, url = parts[0], parts[1]
            cols, rows = (int(x) for x in (parts[2] if len(parts) > 2 else '4x2').split('x'))
            path = f'/tmp/sheet_{key}.png'
            urllib.request.urlretrieve(url, path)
            meta[key] = process(key, path, cols, rows)
            print(key, meta[key], os.path.getsize(os.path.join(OUT, f'ex-{key}.webp')), 'bytes')
    with open(os.path.join(OUT, 'ex-meta.json'), 'w') as fh:
        json.dump(meta, fh)


if __name__ == '__main__':
    main()

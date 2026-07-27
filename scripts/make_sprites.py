"""Turn Higgsfield-generated 4x2 sprite sheets into app-ready animation strips.

For each sheet: download, key out the flat dark background (border-connected
flood so dark clothing survives), slice the 8 frames, crop to the union bbox
(preserving inter-frame registration), and compose a horizontal 8-frame WebP
strip with alpha. Writes www/img/ex-<key>.webp + www/img/ex-meta.json.
Run by .github/workflows/sprites.yml on a runner with open internet.
"""
import json
import os
import urllib.request

import numpy as np
from PIL import Image

TARGET_H = 200
OUT = 'www/img'


def process(key, path):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    cw, ch = W // 4, H // 2
    a = np.asarray(im).astype(np.int16)
    corners = np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3),
                              a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    simil = (np.abs(a - bg).max(axis=2) < 30)
    conn = np.zeros_like(simil)
    conn[0, :] = simil[0, :]; conn[-1, :] = simil[-1, :]
    conn[:, 0] |= simil[:, 0]; conn[:, -1] |= simil[:, -1]
    for _ in range(1200):
        grown = conn.copy()
        grown[1:, :] |= conn[:-1, :]; grown[:-1, :] |= conn[1:, :]
        grown[:, 1:] |= conn[:, :-1]; grown[:, :-1] |= conn[:, 1:]
        grown &= simil
        if (grown == conn).all():
            break
        conn = grown
    alpha = np.where(conn, 0, 255).astype(np.uint8)
    rgba = np.dstack([a.astype(np.uint8), alpha])
    frames = [rgba[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] for r in range(2) for c in range(4)]
    boxes = []
    for f in frames:
        ys, xs = np.where(f[:, :, 3] > 0)
        boxes.append((ys.min(), xs.min(), ys.max() + 1, xs.max() + 1) if len(ys) else (0, 0, ch, cw))
    pad = 6
    y0 = max(0, min(b[0] for b in boxes) - pad); x0 = max(0, min(b[1] for b in boxes) - pad)
    y1 = min(ch, max(b[2] for b in boxes) + pad); x1 = min(cw, max(b[3] for b in boxes) + pad)
    fh, fw = y1 - y0, x1 - x0
    tw = round(fw * TARGET_H / fh)
    strip = Image.new('RGBA', (tw * 8, TARGET_H), (0, 0, 0, 0))
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
            key, url = line.split()
            path = f'/tmp/sheet_{key}.png'
            urllib.request.urlretrieve(url, path)
            meta[key] = process(key, path)
            print(key, meta[key], os.path.getsize(os.path.join(OUT, f'ex-{key}.webp')), 'bytes')
    with open(os.path.join(OUT, 'ex-meta.json'), 'w') as fh:
        json.dump(meta, fh)


if __name__ == '__main__':
    main()

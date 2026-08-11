#!/usr/bin/env python3
"""Rebuild the app icons from assets/vic-icon-src.png.

Vic is dark (black vest, dark trousers, dark hair) and the old icon sat him on a
near-black #0A0D08 background, so the launcher icon disappeared against a dark
wallpaper. Everything here puts him on white instead — the highest-contrast
backdrop for a dark figure — and sizes him to each format's safe zone:

  assets/icon-background.png    adaptive background layer (flat white)
  assets/icon-foreground.png    adaptive foreground layer (Vic, 66% safe zone)
  assets/icon-only.png          legacy/round launcher icon (white + Vic)
  www/icon-192.png              PWA icon, purpose "any"
  www/icon-512.png              PWA icon, purpose "any"
  www/icon-maskable-512.png     PWA icon, purpose "maskable" (80% safe zone)

Run: python3 scripts/make_icons.py   (needs Pillow)
"""
from PIL import Image

# Pristine transparent cutout, kept separate so this script is re-runnable —
# it overwrites icon-foreground.png, which used to be the source.
SRC = 'assets/vic-icon-src.png'
WHITE = (255, 255, 255)


def vic():
    """Vic cut out of the foreground layer, cropped to his silhouette."""
    im = Image.open(SRC).convert('RGBA')
    return im.crop(im.getchannel('A').getbbox())


def compose(figure, size, height_frac, bg=None):
    """Centre `figure` on a `size` canvas at `height_frac` of the canvas height."""
    h = round(size * height_frac)
    w = round(figure.width * h / figure.height)
    # NEAREST keeps the pixel-art edges crisp; anything smoother turns the
    # black outline into grey mush at small launcher sizes.
    fig = figure.resize((w, h), Image.NEAREST)
    canvas = Image.new('RGBA', (size, size), (*bg, 255) if bg else (0, 0, 0, 0))
    canvas.alpha_composite(fig, ((size - w) // 2, (size - h) // 2))
    return canvas


def save(img, path, flatten=False):
    if flatten:
        bg = Image.new('RGB', img.size, WHITE)
        bg.paste(img, mask=img.getchannel('A'))
        img = bg
    img.save(path)
    print(f'{path}  {img.size[0]}x{img.size[1]}  {img.mode}')


v = vic()
print(f'source figure: {v.width}x{v.height}')

# Adaptive icon: the layer is 108dp and the launcher only ever shows the central
# 72dp (66.6%), masked to a circle or squircle. So Vic at 0.54 of the canvas
# fills ~81% of the visible circle — big, with just enough margin that his wide
# stance clears the mask at the ankles. (android.yml strips the 16.7% inset that
# @capacitor/assets wraps these layers in; with the inset still applied the PNG
# would map onto the visible window instead and Vic would come out tiny.)
save(Image.new('RGB', (1024, 1024), WHITE), 'assets/icon-background.png')
save(compose(v, 1024, 0.54), 'assets/icon-foreground.png')

# Legacy / round launcher icon: masked, but never zoomed like the adaptive pair.
save(compose(v, 1024, 0.70, bg=WHITE), 'assets/icon-only.png', flatten=True)

# PWA "any" icons are drawn as-is, so Vic can fill them. The maskable variant is
# a separate file rather than a dual-purpose one — declaring "any maskable"
# forced the padded version everywhere, which just looked small.
save(compose(v, 192, 0.82, bg=WHITE), 'www/icon-192.png', flatten=True)
save(compose(v, 512, 0.82, bg=WHITE), 'www/icon-512.png', flatten=True)
save(compose(v, 512, 0.60, bg=WHITE), 'www/icon-maskable-512.png', flatten=True)

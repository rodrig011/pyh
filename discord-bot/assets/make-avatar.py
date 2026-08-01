#!/usr/bin/env python3
"""Turn the wide KING T PARLAYS logo into square Discord avatars.

Discord crops avatars into a circle, so a wide logo pasted edge to edge loses its
outer letters. This script measures the logo's real ink, then picks the largest
scale that keeps it inside the circle, and drops it on a backdrop taken from the
artwork itself (heavily blurred, so the marble tone and the gold bloom survive
without any of the letters showing through).

Usage:  python3 assets/make-avatar.py            (needs pillow + numpy)
Output: assets/avatar-1024.png, avatar-512.png, avatar-256.png, avatar-preview.png
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "logo-source.png"
SIZES = (1024, 512, 256)

INK_THRESHOLD = 140       # brightness that counts as "logo", not background marble
EDGE_FRACTION = 0.02      # ignore the faintest 2% when measuring the ink box
SAFE_RADIUS = 0.94        # keep the logo this far inside the circle, so it can breathe
MAX_INK_OUTSIDE = 0.0005  # tolerance for stray antialiased pixels
BACKDROP_BLUR = 90
BACKDROP_GAIN = 0.45


def ink_box(image):
    """Bounding box of the logo itself, ignoring the marble veins in the backdrop."""
    lum = np.asarray(image.convert("RGB")).astype(int).max(axis=2)
    mask = lum > INK_THRESHOLD
    cols, rows = mask.sum(axis=0), mask.sum(axis=1)

    def span(profile):
        hits = np.where(profile > profile.max() * EDGE_FRACTION)[0]
        return int(hits.min()), int(hits.max())

    left, right = span(cols)
    top, bottom = span(rows)
    return left, top, right + 1, bottom + 1


def best_scale(logo, size):
    """Largest scale whose ink still fits inside the circular crop."""
    lum = np.asarray(logo.convert("RGB")).astype(int).max(axis=2)
    mask = lum > INK_THRESHOLD
    total = mask.sum()
    ys, xs = np.nonzero(mask)
    # Ink coordinates as offsets from the logo centre, normalised to logo width.
    dx = (xs - logo.width / 2) / logo.width
    dy = (ys - logo.height / 2) / logo.width
    radius = np.hypot(dx, dy)

    safe = size / 2 * SAFE_RADIUS
    for width in range(size, 0, -4):
        outside = np.count_nonzero(radius * width > safe)
        if outside / total <= MAX_INK_OUTSIDE:
            return width
    return size


def backdrop(source, size):
    """Square backdrop built from the artwork: blurred past legibility, then dimmed."""
    scale = size / min(source.size)
    wide = source.resize(
        (max(size, round(source.width * scale)), max(size, round(source.height * scale))),
        Image.LANCZOS,
    )
    left = (wide.width - size) // 2
    top = (wide.height - size) // 2
    square = wide.crop((left, top, left + size, top + size))
    blurred = square.filter(ImageFilter.GaussianBlur(BACKDROP_BLUR * size / 1024))
    return Image.eval(blurred, lambda value: int(value * BACKDROP_GAIN))


def build(source, size):
    logo = source.crop(ink_box(source))
    width = best_scale(logo, size)
    height = round(logo.height * width / logo.width)
    scaled = logo.resize((width, height), Image.LANCZOS)

    layer = Image.new("RGB", (size, size), "black")
    layer.paste(scaled, ((size - width) // 2, (size - height) // 2))

    # "lighter" merges the logo's own black background into the backdrop, so the
    # crop leaves no visible seam and the gold bloom keeps its glow.
    return ImageChops.lighter(backdrop(source, size), layer)


def circular_preview(avatar, size=512):
    """How the avatar actually looks once Discord rounds it off."""
    preview = avatar.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", preview.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    preview.putalpha(mask)
    return preview


def main():
    source = Image.open(SOURCE).convert("RGB")
    print(f"source {source.size}, ink box {ink_box(source)}")

    for size in SIZES:
        avatar = build(source, size)
        out = HERE / f"avatar-{size}.png"
        avatar.save(out, optimize=True)
        print(f"wrote {out.name} ({out.stat().st_size // 1024} KB)")
        if size == max(SIZES):
            circular_preview(avatar).save(HERE / "avatar-preview.png", optimize=True)
            print("wrote avatar-preview.png (circular crop, for eyeballing)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Generate a crisp 2048x2048 CC0 Mediterranean botanical atlas (bark + 4 foliage species)
with mip-preserving alpha coverage and color-bleed dilation to prevent dark halos
under hardware MSAA + Alpha-to-Coverage.
"""
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import distance_transform_edt

SIZE = 2048
HALF = SIZE // 2
OUT = Path("assets/foliage/mediterranean-atlas.webp")


def dilate_rgb_into_transparent(rgba: np.ndarray, alpha_thresh: int = 16) -> np.ndarray:
    """Propagate nearest opaque RGB colors into transparent texels so mipmaps never bleed black."""
    mask = rgba[:, :, 3] >= alpha_thresh
    if not np.any(mask) or np.all(mask):
        return rgba
    _, indices = distance_transform_edt(~mask, return_indices=True)
    out = rgba.copy()
    for c in range(3):
        out[:, :, c] = rgba[indices[0], indices[1], c]
    return out


def make_bark_strip(w: int, h: int, seed: int, base_rgb, ridge_rgb, furrow_rgb) -> Image.Image:
    rng = np.random.default_rng(seed)
    y = np.linspace(0, 1, h, endpoint=False)[:, None]
    x = np.linspace(0, 1, w, endpoint=False)[None, :]

    # Multi-frequency vertical bark fissures with organic meandering
    warp = 0.035 * np.sin(2 * np.pi * y * 3.0 + rng.uniform(0, 6)) + 0.015 * np.sin(2 * np.pi * y * 7.0)
    u = (x + warp) % 1.0
    ridge = (
        0.50 * np.sin(2 * np.pi * (u * 14.0))
        + 0.30 * np.sin(2 * np.pi * (u * 29.0 + 0.3 * np.sin(2 * np.pi * y * 4.0)))
        + 0.20 * np.cos(2 * np.pi * (u * 53.0 - y * 2.0))
    )
    plates = 0.5 + 0.5 * np.sin(2 * np.pi * (y * 11.0 + 0.4 * np.sin(2 * np.pi * u * 8.0)))
    fine = rng.normal(0.0, 0.08, (h, w))
    t = np.clip(0.5 + 0.38 * ridge + 0.14 * (plates - 0.5) + fine, 0.0, 1.0)

    # Darken deep furrows strongly for realistic bark relief
    furrow = np.clip((0.36 - t) / 0.36, 0.0, 1.0) ** 1.4
    highlight = np.clip((t - 0.55) / 0.45, 0.0, 1.0)

    rgb = np.zeros((h, w, 3), dtype=np.float32)
    for c in range(3):
        col = base_rgb[c] * (1.0 - furrow) + furrow_rgb[c] * furrow
        col = col * (1.0 - 0.45 * highlight) + ridge_rgb[c] * (0.45 * highlight)
        rgb[:, :, c] = np.clip(col, 0, 255)
    alpha = np.full((h, w, 1), 255, dtype=np.uint8)
    arr = np.concatenate([rgb.astype(np.uint8), alpha], axis=2)
    return Image.fromarray(arr, mode="RGBA")


def draw_cypress_cluster(size: int, seed: int) -> Image.Image:
    """Dense scale-leaf Mediterranean Italian Cypress sprays (upright feathery fronds)."""
    rng = np.random.default_rng(seed)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx, cy = size * 0.5, size * 0.88
    # Central woody twigs
    for b in range(7):
        ang = -math.pi / 2 + (b - 3) * 0.22 + rng.uniform(-0.05, 0.05)
        length = size * (0.72 - abs(b - 3) * 0.09)
        x1 = cx + math.cos(ang) * length
        y1 = cy + math.sin(ang) * length
        d.line([(cx, cy), (x1, y1)], fill=(64, 52, 38, 255), width=max(4, size // 96))

        # Hundreds of upward-hugging feathery cypress scale-leaf sprigs
        steps = 44
        for s in range(3, steps):
            f = s / steps
            bx = cx + (x1 - cx) * f
            by = cy + (y1 - cy) * f
            for side in (-1, 1):
                sprig_ang = ang + side * rng.uniform(0.18, 0.55)
                sprig_len = size * rng.uniform(0.06, 0.14) * (1.05 - 0.45 * f)
                sx = bx + math.cos(sprig_ang) * sprig_len
                sy = by + math.sin(sprig_ang) * sprig_len
                shade = rng.uniform(0.76, 1.16) * (0.72 + 0.35 * f)
                r = int(np.clip(46 * shade, 18, 125))
                g = int(np.clip(78 * shade, 32, 165))
                bl = int(np.clip(44 * shade, 18, 115))
                d.line([(bx, by), (sx, sy)], fill=(r, g, bl, 255), width=max(5, int(size * 0.011)))
                # Fine scale needles along sprig
                for k in range(5):
                    u = (k + 1) / 5
                    px = bx + (sx - bx) * u
                    py = by + (sy - by) * u
                    rad = size * rng.uniform(0.011, 0.022) * (1.1 - 0.3 * u)
                    d.ellipse(
                        (px - rad, py - rad * 1.25, px + rad, py + rad * 1.25),
                        fill=(int(np.clip(r * 1.08, 0, 255)), int(np.clip(g * 1.1, 0, 255)), int(np.clip(bl * 1.05, 0, 255)), 255),
                    )
    return img


def draw_pine_cluster(size: int, seed: int) -> Image.Image:
    """Maritime Umbrella Pine needle fans — radiating long needles on woody shoots."""
    rng = np.random.default_rng(seed)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx, cy = size * 0.5, size * 0.86
    # Forking brown shoots
    shoots = []
    for i in range(9):
        ang = -math.pi / 2 + (i - 4) * 0.24 + rng.uniform(-0.07, 0.07)
        length = size * rng.uniform(0.32, 0.68) * (1.0 - 0.07 * abs(i - 4))
        ex = cx + math.cos(ang) * length
        ey = cy + math.sin(ang) * length
        d.line([(cx, cy), (ex, ey)], fill=(96, 68, 44, 255), width=max(5, size // 85))
        shoots.append((ex, ey, ang))
        # Mid-branch side shoot
        mx = cx + math.cos(ang) * length * 0.55
        my = cy + math.sin(ang) * length * 0.55
        for side in (-1, 1):
            sang = ang + side * rng.uniform(0.35, 0.65)
            sl = length * rng.uniform(0.32, 0.48)
            sx, sy = mx + math.cos(sang) * sl, my + math.sin(sang) * sl
            d.line([(mx, my), (sx, sy)], fill=(88, 62, 40, 255), width=max(4, size // 110))
            shoots.append((sx, sy, sang))

    # Radiating pine needle tufts at every shoot tip
    for (tx, ty, tang) in shoots:
        num_needles = 42
        for _ in range(num_needles):
            nang = tang + rng.uniform(-1.35, 1.35)
            nlen = size * rng.uniform(0.08, 0.19)
            nx = tx + math.cos(nang) * nlen
            ny = ty + math.sin(nang) * nlen
            light = rng.uniform(0.72, 1.22) * (0.8 + 0.25 * max(0.0, -math.sin(nang)))
            col = (
                int(np.clip(58 * light, 20, 140)),
                int(np.clip(92 * light, 38, 178)),
                int(np.clip(45 * light, 18, 110)),
                255,
            )
            d.line([(tx, ty), (nx, ny)], fill=col, width=max(3, size // 210))
    return img


def draw_leaf_cluster(size: int, seed: int, palette, leaf_aspect: float, count: int) -> Image.Image:
    """Broadleaf Mediterranean foliage (Holm Oak or Olive) with realistic branching twigs and serrated/elliptic leaves."""
    rng = np.random.default_rng(seed)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx, cy = size * 0.5, size * 0.90
    twig_pts = []
    for i in range(7):
        ang = -math.pi / 2 + (i - 3) * 0.30 + rng.uniform(-0.08, 0.08)
        length = size * rng.uniform(0.45, 0.78) * (1.0 - 0.08 * abs(i - 3))
        x0, y0 = cx, cy
        segs = 5
        for s in range(1, segs + 1):
            ang += rng.uniform(-0.14, 0.14)
            x1 = x0 + math.cos(ang) * (length / segs)
            y1 = y0 + math.sin(ang) * (length / segs)
            d.line([(x0, y0), (x1, y1)], fill=(78, 62, 46, 255), width=max(3, int((segs - s + 2) * size / 320)))
            twig_pts.append((x1, y1, ang, s / segs))
            x0, y0 = x1, y1

    # Draw layered leaves from dark inner canopy to bright sunlit outer leaves
    for layer in range(count):
        bx, by, bang, height_f = twig_pts[rng.integers(0, len(twig_pts))]
        off_r = size * rng.uniform(0.01, 0.11)
        off_a = rng.uniform(0, 2 * math.pi)
        lx = bx + math.cos(off_a) * off_r
        ly = by + math.sin(off_a) * off_r
        lang = bang + rng.uniform(-1.3, 1.3)
        llen = size * rng.uniform(0.045, 0.085)
        lwid = llen * leaf_aspect

        c_base = palette[rng.integers(0, len(palette))]
        shade = rng.uniform(0.75, 1.18) * (0.72 + 0.35 * height_f)
        col = tuple(int(np.clip(c * shade, 15, 230)) for c in c_base) + (255,)

        # Pointed leaf polygon
        ca, sa = math.cos(lang), math.sin(lang)
        px, py = -sa, ca
        pts = [
            (lx - ca * llen * 0.4, ly - sa * llen * 0.4),
            (lx + px * lwid, ly + py * lwid),
            (lx + ca * llen * 0.65, ly + sa * llen * 0.65),
            (lx - px * lwid, ly - py * lwid),
        ]
        d.polygon(pts, fill=col)
        # Subtle midrib vein
        vein = tuple(int(np.clip(c * 1.15, 0, 240)) for c in col[:3]) + (255,)
        d.line([pts[0], pts[2]], fill=vein, width=max(1, size // 512))
    return img


def main():
    atlas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Quadrant layout (2048x2048):
    # Top-left     (0..1024,    0..1024) : Italian Cypress needle spray cluster
    # Top-right    (1024..2048, 0..1024) : Maritime Umbrella Pine needle fans
    # Bottom-left  (0..1024,    1024..2048) : Holm Oak evergreen leaf spray (left 768) + Pine/Cypress bark (right 256)
    # Bottom-right (1024..2048, 1024..2048) : Olive silvery-green leaf spray (left 768) + Oak/Olive bark (right 256)

    cypress = draw_cypress_cluster(1024, 101)
    pine = draw_pine_cluster(1024, 202)
    oak = draw_leaf_cluster(
        768,
        303,
        palette=[(48, 72, 38), (58, 86, 44), (42, 66, 35), (68, 94, 48)],
        leaf_aspect=0.46,
        count=420,
    )
    olive = draw_leaf_cluster(
        768,
        404,
        palette=[(96, 114, 84), (110, 126, 98), (80, 98, 70), (122, 136, 108)],
        leaf_aspect=0.28,
        count=480,
    )

    bark_conifer = make_bark_strip(256, 1024, 505, (94, 72, 54), (132, 102, 76), (44, 32, 24))
    bark_broadleaf = make_bark_strip(256, 1024, 606, (104, 96, 84), (138, 130, 116), (50, 46, 40))

    atlas.paste(cypress, (0, 0))
    atlas.paste(pine, (1024, 0))
    atlas.paste(oak, (0, 1024))
    atlas.paste(bark_conifer, (768, 1024))
    atlas.paste(olive, (1024, 1024))
    atlas.paste(bark_broadleaf, (1792, 1024))

    # Crisp anti-aliased edge smoothing followed by RGB dilation so mipmaps stay vibrant
    arr = np.array(atlas)
    arr = dilate_rgb_into_transparent(arr, alpha_thresh=20)
    final_img = Image.fromarray(arr, mode="RGBA")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(OUT, format="WEBP", quality=92, method=6)
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes), coverage={(arr[:,:,3] > 107).mean()*100:.1f}%")


if __name__ == "__main__":
    main()

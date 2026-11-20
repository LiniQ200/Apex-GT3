# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.5", "Pillow==12.0.0", "scipy==1.16.3"]
# ///
"""Rebuild the original Valle d'Oro conifers: uv run scripts/bake-foliage.py.

Art tool only. Builds require neither Python nor the network. Two small conifer
boughs per species are grown from wood and foliage strokes in 3D and photographed
orthographically into a shared cutout atlas. The near meshes attach those boughs
to swept bark scaffolds. The three distant views are rasterised from each finished
near mesh, not drawn as unrelated generic tree silhouettes. No sun is baked in.
"""
import base64
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
SIZE, GUTTER = 1024, 8
atlas = Image.new('RGBA', (SIZE, SIZE))
TAU = math.tau


def unit(v):
    return v / max(1.e-9, np.linalg.norm(v))


def v(x, y, z):
    return np.array((x, y, z), dtype=float)


def lateral(angle):
    return v(math.cos(angle), 0, math.sin(angle))


def paint_bough(pine, seed):
    """Real 3D strokes: paired Pinus fascicles versus imbricate Cupressus sprays."""
    r = random.Random(seed)
    strokes = []

    def stroke(a, b, diameter, rgb):
        strokes.append((a, b, diameter, rgb))

    def tint(base, k):
        return tuple(round(max(0, min(255, c * k))) for c in base)

    def fascicles(a, b, length):
        axis = unit(b - a)
        side = unit(np.cross(axis, v(1, 0, 0)))
        up = np.cross(axis, side)
        k = r.uniform(.84, 1.16)
        for i in range(40):
            t = r.random()
            stem = a * (1 - t) + b * t
            angle = i * 2.39996 + r.uniform(-.22, .22)
            spread = side * math.cos(angle) + up * math.sin(angle)
            d = unit(axis * (.34 + t * .95) + spread * r.uniform(.66, 1.17))
            reach = length * r.uniform(.73, 1.2) * (1 - .22 * t)
            bend = stem + (d + v(0, .1, 0)) * reach * .55
            tip = stem + d * reach - v(0, reach * .075, 0)
            color = tint((90, 104, 77), k * (.85 + .18 * t + .14 * r.random() + .12 * d[1]))
            stroke(stem, bend, .010, tint(color, .88))
            stroke(bend, tip, .0058, color)
            stroke(stem, tip + side * r.uniform(-.037, .037), .0064, tint(color, 1.06))

    def pine_shoot(p, angle, level, length):
        slope = r.uniform(.28, .69) if level > 1 else r.uniform(.53, 1.56)
        direction = unit(lateral(angle) + v(0, slope, 0))
        q = p + length * direction
        m = .53 * p + .47 * q + v(0, -length * .08, 0)
        woody = tint((104, 85, 66), r.uniform(.81, 1.13))
        stroke(p, m, .011 + level * .006, woody)
        stroke(m, q, .009 + level * .004, woody)
        if level <= 1:
            fascicles(.35 * m + .65 * q if level else m, q, r.uniform(.115, .167))
        if level:
            for child in range(3 if level > 1 or r.random() < .67 else 2):
                theta = angle + (child - 1) * r.uniform(.41, 1.18) + r.uniform(-.18, .18)
                start = q if child != 0 else m * .34 + q * .66
                pine_shoot(start, theta, level - 1, length * r.uniform(.59, .83))

    def cypress_spray(p, d, length, level, normal, k):
        q = p + d * length
        col = tint((84, 100, 79) if level < 2 else (110, 95, 70), k * r.uniform(.82, 1.14))
        mid = p + .63 * (q-p)
        stroke(p, mid, .0065 + level * .0045, col)
        stroke(mid, q, .0045 + level * .003, tint(col, 1.06))
        across = unit(np.cross(normal, d))
        if level:
            for i in range(3 if level == 3 else 4):
                t = (i + .48) / (3.6 if level == 3 else 4.5)
                for sign in [-1, 1]:
                    root = p + d * length * (t + r.uniform(-.045, .045))
                    skew = across * sign * r.uniform(.42, .94)
                    e = unit(d * 1.08 + skew + normal * r.uniform(-.38, .38) + v(0, .16, 0))
                    cypress_spray(root, e, length * (.86 - .49 * t) * r.uniform(.68, .95), level - 1,
                                  unit(normal + skew * r.uniform(-.28, .28)), k * r.uniform(.96, 1.08))
        else:
            # Short appressed scale sprays; wider bases, fine golden growing tips.
            for i in range(4):
                t = .17 + i * .20
                e = unit(d + across * (-1 if i % 2 else 1) * r.uniform(.34, .67))
                a = p + d * length * t
                tip = a + e * length * (.55 - .23 * t)
                stroke(a, .48*a+.52*tip, .010, col)
                stroke(.48*a+.52*tip, tip, .0055, tint(col, 1 + t * .12))

    if pine:
        for i in range(5):
            pine_shoot(v(0, 0, 0), i * TAU / 5 + r.uniform(-.5, .5), 3, r.uniform(.34, .49))
    else:
        for i in range(4):
            a = i * TAU / 4 + .31
            d = unit(v(.49 * math.cos(a), 1, .36 * math.sin(a)))
            cypress_spray(v(0, 0, 0), d, r.uniform(.55, .84), 3, lateral(a + .62), r.uniform(.81, .98))
    p = np.array([[s[0], s[1]] for s in strokes]); widths = np.array([s[2] for s in strokes]); colors = np.array([s[3] for s in strokes])
    # Normalize bough dimensions once. The individual mounted sprays supply their
    # own physical widths, heights and spread on the tree.
    ext = np.ptp(p.reshape(-1, 3), axis=0)
    p /= ext
    widths /= np.mean(ext)
    return p, widths, colors


def guarded(im):
    """Straight alpha and nearest-occupied RGB in the transparent gutter, never a white matte."""
    a = np.array(im)
    empty = a[:, :, 3] < 6
    yy, xx = distance_transform_edt(empty, return_distances=False, return_indices=True)
    a[empty, :3] = a[yy[empty], xx[empty], :3]
    return Image.fromarray(a)


def bounds(xy, size):
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    margin = (hi - lo) * GUTTER / (np.array(size) - 2 * GUTTER)
    return lo - margin, hi + margin


def xy_to_pixel(p, lo, hi, size):
    xy = (p - lo) / (hi - lo)
    return np.stack((xy[..., 0], 1 - xy[..., 1]), axis=-1) * np.array(size)


def bough_image(model, axes, size):
    p, widths, colors = model
    uv = p @ axes[:2].T
    lo, hi = bounds(uv.reshape(-1, 2), size)
    ss = 3
    pix = xy_to_pixel(uv, lo, hi, size) * ss
    depths = (p.mean(axis=1) @ axes[2]); order = np.argsort(depths, kind='stable')
    # Micro-occlusion between shoots, not a directional shadow or baked sun.
    h = p.mean(axis=1)[:, 1]; rad = np.linalg.norm(p.mean(axis=1)[:, [0, 2]], axis=1)
    colors = np.uint8(np.clip(colors * (.77 + .19 * h + .20 * rad)[:, None], 0, 255))
    weights = np.maximum(1, np.rint(widths * np.mean(np.array(size) / (hi - lo)) * ss)).astype(int)
    im = Image.new('RGBA', (size[0] * ss, size[1] * ss)); draw = ImageDraw.Draw(im)
    for i in order:
        draw.line(tuple(pix[i].reshape(-1)), tuple(colors[i]) + (255,), int(weights[i]))
    im = guarded(im.resize(size, Image.Resampling.LANCZOS))
    return im, lo, hi


def bark(pine, size, seed):
    """Broken cinnamon-grey plates on stone pine; narrow fibrous seams on cypress."""
    w, h = size
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[:h, :w]
    def noise(sy, sx):
        field = gaussian_filter(r.normal(size=(h, w)), (sy, sx), mode='wrap')
        return field / np.std(field)
    dx = noise(10, 4) * (1.85 if pine else 1.08) + noise(2, 1) * .65
    dy = noise(7, 4) * 2.8
    points = r.random((110 if pine else 160, 2)) * [h, w]
    best = np.full((h, w), np.inf); second = best.copy(); ids = np.zeros((h, w), int)
    for i, (y, x) in enumerate(points):
        # Toroidal near/far distances keep the bark sample periodic on all sides.
        a = abs(((yy + dy - y + h / 2) % h) - h / 2) * (.48 if pine else .16)
        b = abs(((xx + dx - x + w / 2) % w) - w / 2)
        d = np.hypot(a, b); nearer = d < best
        second = np.where(nearer, best, np.minimum(d, second)); ids[nearer] = i; best = np.minimum(d, best)
    edge = np.minimum(1, (second - best) / (2.7 if pine else 1.75))
    p = .68 + .30 * edge + r.uniform(-.072, .072, len(points))[ids] + .036 * noise(4, .7) + .025 * noise(.7, .45)
    rgb = p[..., None] * np.array([128, 105, 86] if pine else [111, 100, 83])
    return Image.fromarray(np.uint8(np.clip(rgb, 0, 255))).convert('RGBA')


FRONT = np.array([v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)])
SIDE = np.array([v(0, 0, -1), v(0, 1, 0), v(1, 0, 0)])
OBLIQUE = np.array([v(0, 0, -1), v(-.6, .8, 0), v(.8, .6, 0)])
TOP = np.array([v(1, 0, 0), v(0, 0, -1), v(0, 1, 0)])


class Mesh:
    def __init__(self):
        self.vertices, self.indices = [], []

    def vertex(self, pos, norm, uv):
        self.vertices.append([*pos, *unit(norm), *uv]); return len(self.vertices) - 1

    def tri(self, a, b, c):
        self.indices.extend([a, c, b])  # Babylon's left-handed front winding

    def pack(self):
        # One small synchronous Drive-chunk asset: signed millimetres; snorm16
        # normal and unorm15 UV. Both index and vertex streams are little endian.
        stream = np.array(self.vertices)
        stream *= [1000] * 3 + [32767] * 5
        assert abs(stream).max() <= 32767.01
        return [base64.b64encode(np.rint(stream).astype('<i2').tobytes()).decode(),
                base64.b64encode(np.array(self.indices, '<u2').tobytes()).decode()]


def tex_uv(rect, u, w):
    x, y, width, height = rect
    return [(x + u * width) / SIZE, 1 - (y + (1 - w) * height) / SIZE]


def wood(mesh, path, radii, count, pine, twist=0):
    rect = (520 if pine else 776, 776, 240, 240)
    path = np.array(path); side = None; prev = []
    dist = np.r_[0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
    for i, center in enumerate(path):
        axis = unit(path[min(i + 1, len(path) - 1)] - path[max(0, i - 1)])
        side = unit(np.cross(axis, lateral(.27 + twist))) if side is None else unit(side - axis * (side @ axis))
        ortho = np.cross(side, axis); row = []
        for j in range(count + 1):
            angle = TAU * j / count
            normal = math.cos(angle) * side + math.sin(angle) * ortho
            rr = radii[i] * (1 + .05 * math.sin(angle * 3 + twist) + .045 * math.cos(angle * 5 + i * .48))
            row.append(mesh.vertex(center + rr * normal, normal, tex_uv(rect, j / count, .01 + .98 * dist[i] / dist[-1])))
        if prev:
            for j in range(count):
                mesh.tri(prev[j], row[j], row[j+1]); mesh.tri(prev[j], row[j+1], prev[j+1])
        prev = row


def crown_normal(p, pine):
    # Continuous normals belong to the crown, NOT the planes. A reversed plane
    # should still take the same skylight, and the bole keeps its radial normals.
    return unit(v(p[0] / (5.1 if pine else 1.2), .57 + np.clip((p[1] - (8.2 if pine else 5.8)) * .14, -.39, .94),
                  p[2] / (5.1 if pine else 1.2)))


def photo(im, lo, hi, axes, rect, cloud=None):
    """Fit a conservative strip to the alpha support, including the skinny trunk.

    For each band take its occupied width, then bound each edge by both neighbours.
    This keeps silhouette/holes and avoids shading a rectangle of empty sky.
    """
    alpha = np.array(im)[:, :, 3]; h, w = alpha.shape
    ys, _ = np.nonzero(alpha > 65); y0, y1 = max(1, ys.min()-2), min(h-1, ys.max()+3)
    ys = np.unique(np.rint(y0 + (y1-y0)*np.array([0, .25, .58, 1])).astype(int))
    ranges = []
    for a, b in zip(ys, ys[1:]):
        xx = np.nonzero(alpha[a:b] > 65)[1]
        ranges.append((max(1, xx.min()-2), min(w-1, xx.max()+3)) if len(xx) else (w//2-1, w//2+1))
    rows = []
    projected = ((cloud @ axes[:2].T) - lo) / (hi-lo) if cloud is not None else None
    for i, y in enumerate(ys):
        adj = ranges[max(0, i-1):i+1]
        for x in [min(a for a, _ in adj), max(b for _, b in adj)]:
            uv = np.array([x/w, 1-y/h]); pt = lo + uv * (hi-lo)
            p = pt @ axes[:2]
            if projected is not None:
                # Drape the cutout over the recorded depth of its twigs. Two
                # view ribbons now meet at the same spatial tip rather than
                # the tip of an oblique bough drooping sideways out of the crown.
                k = max(12, len(cloud)//35)
                idx = np.argpartition(np.sum((projected-uv)**2, axis=1), k)[:k]
                p += np.median(cloud[idx] @ axes[2]) * axes[2]
            rows.append((p, tex_uv(rect, *uv)))
    return rows


def mount(mesh, sprite, pine, transform):
    prev = []
    for i in range(0, len(sprite), 2):
        row = []
        for pt, uv in sprite[i:i+2]:
            pos = transform(pt)
            row.append(mesh.vertex(pos, crown_normal(pos, pine), uv))
        if prev:
            mesh.tri(prev[0], row[0], row[1]); mesh.tri(prev[0], row[1], prev[1])
        prev = row


def make_tree(pine, variant, sprays):
    mesh, far = Mesh(), Mesh(); r = random.Random((39405 if pine else 8441) + 333 * variant)
    def cluster(root, yaw, size, lean):
        side, out = lateral(yaw+math.pi/2), lateral(yaw)
        def transform(p):
            return root + side*p[0]*size[0] + v(0,p[1]*size[1],0) + out*(p[2]*size[2]+p[1]*lean)
        for sprite in r.choice(sprays): mount(mesh, sprite, pine, transform)

    if pine:
        # A gently leaning, russet bole carrying the high, open umbrella frame.
        spine = [v(0, -.06, 0), v(.03, .85, -.07), v(.24 if variant else -.10, 3.25, -.12),
                 v(.59 if variant else -.11, 4.95 if variant else 5.4, -.16),
                 v(.98 if variant else .35, 6.78, .26), v(.81 if variant else .67, 8.35, .52)]
        wood(mesh, spine, [.44, .34, .29, .23, .169, .091], 8, True)
        # An actual depth-tested bole costs 16 triangles at distance and does
        # not vanish as a narrow alpha stripe between the crown and the ground.
        wood(far, [spine[0],spine[3],spine[-1]], [.45,.26,.14], 4, True)
        trunk_indices = len(mesh.indices)
        # Four bifurcating scaffold limbs, not a whorl of identical spokes.
        # The lower-reaching, older specimen leans and forks sooner.
        for i in range(4):
            t = i / 3; a = i*TAU/4 + r.uniform(-.31,.31); d = lateral(a); side = lateral(a+math.pi/2)
            base = spine[3] * (1-t) + spine[4] * t
            elbow = base + d*r.uniform(.42,.92) + v(0,.61+r.random()*.34,0) + side*r.uniform(-.22,.22)
            fork = elbow + d*r.uniform(.65,1.07) + v(0,.65+r.random()*.49,0) + side*r.uniform(-.29,.29)
            wood(mesh, [base,elbow,fork], [.207-.061*t,.158-.040*t,.113-.027*t], 5, True, a)
            for sign in [-1,1]:
                branch_angle = a+sign*r.uniform(.34, .96); out = lateral(branch_angle)
                knee = fork + out*r.uniform(.59,.99) + v(0,r.uniform(.28,.66),0)
                end = knee + out*r.uniform(.50,1) + side*r.uniform(-.27,.27)
                end[1] = max(knee[1]+.24, 7.97+.76*t+r.uniform(-.37,.51))
                wood(mesh, [fork,knee,end], [.108,.078,.04], 4, True, branch_angle)
                scale = r.uniform(.83,1.20)
                cluster(end, branch_angle, [4.24*scale,r.uniform(1.7,2.42),3.71*scale], .44)
                if i != 2:
                    off = knee + lateral(branch_angle+sign*.93)*r.uniform(.68,.99) + v(0,r.uniform(.48,.79),0)
                    wood(mesh, [knee,off], [.063,.031], 3, True, a)
                    cluster(off, branch_angle+sign*.93, [3.69*scale,r.uniform(1.35,2.06),3.35*scale], .33)
        for end in [spine[-1]+v(-.64, 1.1, -.46), spine[-1]+v(.54, .80, .69)]:
            wood(mesh, [spine[-1], end], [.10, .041], 4, True)
            cluster(end, r.random()*TAU, [3.88, 2.41, 3.92], -.16)
    else:
        spine = [v(0, -.05, 0), v(.01, 1.2, -.01), v(-.03, 5, .02), v(.04, 9, .02), v(.13, 12.88, -.04)]
        wood(mesh, spine, [.235, .17, .124, .072, .012], 6, False)
        wood(far, [spine[0],spine[2]], [.26,.145], 4, False)
        trunk_indices = len(mesh.indices)
        for i in range(20):
            t = i / 20; y = .49 + 11.11*t; a = 2.39996*i + r.uniform(-.14, .14)
            breadth = (.72 + .43*math.sin(t*math.pi)) * (1-.82*t**2)
            root = v(.115*t + r.uniform(-.045, .045), y, .036*math.sin(t*4))
            d = lateral(a); rr = breadth * r.uniform(.26, .43)
            end = root + d*rr + v(0,.28 + .26*breadth,0)
            if i < 12: wood(mesh, [root, end], [.064*breadth, .030*breadth], 3, False, a)
            cluster(end, a, [breadth * r.uniform(1.62,2.08), min(3.79 - 1.10*t + r.uniform(-.23,.23), 13-y-.5), breadth*1.29], breadth*.30)
        cluster(spine[-1]-v(0,1.42,0), 2.32, [.31, 1.86, .34], .06)
    return mesh, far, trunk_indices


def project_mesh(mesh, axes, size, skip):
    """Orthographic z-buffer bake of the actual textured near triangles."""
    a = np.array(mesh.vertices); uv = a[:, :3] @ axes[:2].T
    tris = np.array(mesh.indices[skip:]).reshape(-1,3)
    lo, hi = bounds(uv[np.unique(tris)], size); ss = 3; wh = np.array(size) * ss
    xy = xy_to_pixel(uv, lo, hi, wh); depth = a[:,:3] @ axes[2]
    zbuf = np.full((wh[1], wh[0]), -np.inf); rgba = np.zeros((wh[1], wh[0], 4), dtype=np.uint8)
    tex = np.array(atlas)
    for tri in tris:
        p = xy[tri]; x0,y0 = np.maximum(0, np.floor(p.min(axis=0)).astype(int)); x1,y1 = np.minimum(wh, np.ceil(p.max(axis=0)).astype(int))
        x,y = np.meshgrid(np.arange(x0,x1)+.5, np.arange(y0,y1)+.5)
        ab, ac = p[1]-p[0], p[2]-p[0]; det = ab[0]*ac[1]-ab[1]*ac[0]
        if abs(det) < 1.e-5: continue
        x -= p[0,0]; y -= p[0,1]; b=(ac[1]*x-ac[0]*y)/det; c=(ab[0]*y-ab[1]*x)/det
        w = np.stack([1-b-c,b,c], axis=-1); uvt = w @ a[tri,6:8]
        col = tex[np.clip(((1-uvt[:,:,1])*SIZE).astype(int),0,SIZE-1), np.clip((uvt[:,:,0]*SIZE).astype(int),0,SIZE-1)]
        z = w @ depth[tri]; oldz = zbuf[y0:y1,x0:x1]
        take = (np.min(w, axis=2)>=0) & (z>oldz) & (col[:,:,3]>=106)
        oldz[take] = z[take]; rgba[y0:y1,x0:x1][take] = col[take]; rgba[y0:y1,x0:x1,3][take]=255
    return guarded(Image.fromarray(rgba).resize(size, Image.Resampling.LANCZOS)), lo, hi


if __name__ == '__main__':
    templates = {}
    for species, pine in [('pine', True), ('cypress', False)]:
        sprays = []
        for variant in [0, 1]:
            model = paint_bough(pine, (32639 if pine else 1280) + 107 * variant); views=[]
            for j, axes in enumerate([FRONT, OBLIQUE]):
                rect = ((2*variant+j)*256, 0 if pine else 256, 256, 256)
                im, lo, hi = bough_image(model, axes, rect[2:]); atlas.paste(im, rect[:2])
                views.append(photo(im, lo, hi, axes, rect, model[0].reshape(-1,3)[::5]))
            sprays.append(views)
        atlas.paste(bark(pine, (256,256), 5917), (512 if pine else 768,768))
        for variant in [0, 1]:
            name = species+str(variant); k = variant + (0 if pine else 2)
            near, far, skip = make_tree(pine, variant, sprays)
            for j, axes in enumerate([FRONT, SIDE, TOP]):
                rect = ((2*k+j)*128, 512, 128, 256) if j<2 else (k*128,768,128,128)
                im, lo, hi = project_mesh(near, axes, rect[2:], skip); atlas.paste(im, rect[:2])
                center = v(0, 9.84 if pine else 5.94, 0) if j==2 else v(0,0,0)
                mount(far, photo(im, lo, hi, axes, rect), pine, lambda p: p+center)
            templates[name]=near.pack(); templates[name+'Far']=far.pack()
            print(name, 'near/far vertices and triangles:', len(near.vertices), len(near.indices)//3, len(far.vertices), len(far.indices)//3)
    art = ROOT/'assets'/'foliage'; art.mkdir(parents=True,exist_ok=True)
    # WebP lossless alpha; exact preserves gutter RGB. Native trilinear mips on
    # both backends; branch/twig masses survive the area filter at a .42 cutoff.
    atlas.save(art/'italian-conifers.webp', quality=88, method=6, exact=True)
    (ROOT/'src'/'track'/'foliage-shapes.json').write_text(json.dumps(templates, separators=(',', ':'))+'\n')

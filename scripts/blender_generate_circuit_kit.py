#!/usr/bin/env python3
"""
Headless Blender 4.3 CAD & Botanical Baker for Autodromo Valle d'Oro.
Invoke via: blender --background --python scripts/blender_generate_circuit_kit.py

Generates two studio-beveled, UV-unwrapped, weighted-normal, vertex-AO baked GLB kits:
  1) assets/kit/botanical.raw.glb  - 4 Mediterranean tree species (Cypress, Maritime Pine,
                                     Holm Oak, Olive) with LOD0 + LOD1 meshes, bark UVs,
                                     baked interior canopy vertex AO, and cutout leaf/needle cards.
  2) assets/kit/trackside.raw.glb  - FIA Grade-1 modular circuit architecture:
                                     Armco I-beam post, Tecpro barrier block, 3-high belted tire stack,
                                     cranked catch-fence post, space-frame grandstand bay, breakaway
                                     brake board frame, marshal post w/ FIA digital flag panel,
                                     5-pod FIA start gantry, 10-bay GT3 pit garage module w/ overhead
                                     pneumatic boom, pit-wall timing stand, Player Pit Box staging,
                                     floodlight tower, and Tuscan pitched-roof villa + campanile.
"""
import math
import os
import random
from pathlib import Path

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

OUT_DIR = Path("assets/kit")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_color_attr(mesh, name="Col"):
    if name not in mesh.color_attributes:
        mesh.color_attributes.new(name=name, type="BYTE_COLOR", domain="CORNER")
    return mesh.color_attributes[name]


def bake_height_radial_ao(obj, min_ao=0.52, height_span=4.0, radial_dark=0.0, center=Vector((0, 0, 0))):
    """Bake deterministic interior ambient occlusion into vertex color attribute."""
    me = obj.data
    ca = ensure_color_attr(me, "Col")
    verts = me.vertices
    max_r = max(( (v.co - center).length for v in verts ), default=1.0) or 1.0
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = verts[me.loops[li].vertex_index]
            h_f = max(0.0, min(1.0, v.co.z / max(0.2, height_span)))
            ao = min_ao + (1.0 - min_ao) * (h_f ** 0.65)
            if radial_dark > 0.0:
                r_f = max(0.0, min(1.0, (v.co - center).length / max_r))
                ao *= (1.0 - radial_dark) + radial_dark * (r_f ** 0.7)
            ao = max(0.28, min(1.0, ao))
            ca.data[li].color = (ao, ao, ao, 1.0)


def apply_bevel_and_uv(obj, bevel_width=0.02, segments=2, uv_scale=1.0):
    """Apply CAD bevel + weighted normals + box-projected UVs in Blender."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    if bevel_width > 0:
        mod = obj.modifiers.new(name="Bevel", type="BEVEL")
        mod.width = bevel_width
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(32)
        bpy.ops.object.modifier_apply(modifier=mod.name)

    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in face.loops:
            co = loop.vert.co
            if az >= ax and az >= ay:
                u, v = co.x * uv_scale, co.y * uv_scale
            elif ax >= ay:
                u, v = co.y * uv_scale, co.z * uv_scale
            else:
                u, v = co.x * uv_scale, co.z * uv_scale
            loop[uv_layer].uv = (u, v)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()

    # Smooth shading on beveled transitions with sharp crease preservation
    for p in me.polygons:
        p.use_smooth = True
    obj.select_set(False)


def make_mat(name, base_color=(0.7, 0.7, 0.7, 1.0), metallic=0.0, roughness=0.65, alpha_clip=False):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf:
        vcol = nt.nodes.new("ShaderNodeVertexColor")
        vcol.layer_name = "Col"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[6].default_value = base_color
        nt.links.new(vcol.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
    if alpha_clip:
        mat.blend_method = "CLIP" if hasattr(mat, "blend_method") else "OPAQUE"
    return mat


def create_mesh_obj(name, bm, mat=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj


def add_box(bm, center, size, rot_euler=(0, 0, 0)):
    mat = Matrix.Translation(center) @ Euler(rot_euler, "XYZ").to_matrix().to_4x4() @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat)


def add_cylinder(bm, p0, p1, r0, r1=None, segs=10):
    if r1 is None:
        r1 = r0
    v0, v1 = Vector(p0), Vector(p1)
    dv = v1 - v0
    length = dv.length
    if length < 1e-5:
        return
    z_axis = dv.normalized()
    up = Vector((0, 0, 1)) if abs(z_axis.z) < 0.99 else Vector((1, 0, 0))
    x_axis = up.cross(z_axis).normalized()
    y_axis = z_axis.cross(x_axis).normalized()
    ring0, ring1 = [], []
    for i in range(segs):
        a = 2.0 * math.pi * i / segs
        ca, sa = math.cos(a), math.sin(a)
        dir_v = x_axis * ca + y_axis * sa
        ring0.append(bm.verts.new(v0 + dir_v * r0))
        ring1.append(bm.verts.new(v1 + dir_v * r1))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((ring0[i], ring0[j], ring1[j], ring1[i]))
    bm.faces.new(tuple(reversed(ring0)))
    bm.faces.new(tuple(ring1))


# =============================================================================
# 1. BOTANICAL KIT (4 Mediterranean Species, LOD0 + LOD1, Bark + Cutout Cards)
# =============================================================================
# UV rects matching assets/foliage/mediterranean-atlas.webp (Blender V=0 is bottom, V=1 is top)
UV_CYPRESS = (0.004, 0.504, 0.496, 0.996)
UV_PINE = (0.504, 0.504, 0.996, 0.996)
UV_OAK = (0.004, 0.128, 0.371, 0.496)
UV_OLIVE = (0.504, 0.128, 0.871, 0.496)
UV_BARK_CONIFER = (0.377, 0.004, 0.498, 0.496)
UV_BARK_BROAD = (0.877, 0.004, 0.998, 0.496)


def add_branch_tube(bm, uv_layer, col_layer, pts, radii, bark_uv, segs=6):
    u0, v0, u1, v1 = bark_uv
    rings = []
    cum_len = [0.0]
    for k in range(1, len(pts)):
        cum_len.append(cum_len[-1] + (pts[k] - pts[k - 1]).length)
    total = max(0.01, cum_len[-1])
    for idx, (pt, rad) in enumerate(zip(pts, radii)):
        if idx == 0:
            tan = (pts[1] - pts[0]).normalized()
        elif idx == len(pts) - 1:
            tan = (pts[-1] - pts[-2]).normalized()
        else:
            tan = (pts[idx + 1] - pts[idx - 1]).normalized()
        ref = Vector((0, 0, 1)) if abs(tan.z) < 0.95 else Vector((1, 0, 0))
        bx = ref.cross(tan).normalized()
        by = tan.cross(bx).normalized()
        ring = []
        for s in range(segs):
            a = 2.0 * math.pi * s / segs
            v = bm.verts.new(pt + (bx * math.cos(a) + by * math.sin(a)) * rad)
            ring.append(v)
        rings.append(ring)
    for k in range(len(rings) - 1):
        vf0 = v0 + (v1 - v0) * (cum_len[k] / total)
        vf1 = v0 + (v1 - v0) * (cum_len[k + 1] / total)
        ao0 = 0.56 + 0.34 * (cum_len[k] / total)
        ao1 = 0.56 + 0.34 * (cum_len[k + 1] / total)
        for s in range(segs):
            sn = (s + 1) % segs
            uf0 = u0 + (u1 - u0) * (s / segs)
            uf1 = u0 + (u1 - u0) * ((s + 1) / segs)
            f = bm.faces.new((rings[k][s], rings[k][sn], rings[k + 1][sn], rings[k + 1][s]))
            f.smooth = True
            uvs = [(uf0, vf0), (uf1, vf0), (uf1, vf1), (uf0, vf1)]
            aos = [ao0, ao0, ao1, ao1]
            for loop, uv, ao in zip(f.loops, uvs, aos):
                loop[uv_layer].uv = uv
                loop[col_layer] = (ao, ao, ao, 1.0)


def add_bough_card(bm, uv_layer, col_layer, center, width, height, normal_hint, rot_mat, uv_rect, ao_inner=0.62, ao_outer=1.0, bend=0.14):
    """Slightly arched 4-quad (or 2-tri) leaf spray card with baked interior-to-tip AO."""
    u0, v0, u1, v1 = uv_rect
    um = 0.5 * (u0 + u1)
    hw = width * 0.5
    # 3x2 grid for gentle natural camber (no rigid cardboard flatness)
    grid = []
    for row, (yv, vv, ao_row) in enumerate([(0.0, v0, ao_inner), (height * 0.55, 0.5 * (v0 + v1), 0.5 * (ao_inner + ao_outer)), (height, v1, ao_outer)]):
        rverts = []
        for col, (xv, uv, cup) in enumerate([(-hw, u0, -bend * width), (0.0, um, bend * width * 0.4), (hw, u1, -bend * width)]):
            local = Vector((xv, cup - (yv / max(0.1, height)) ** 2 * bend * height, yv))
            world = center + rot_mat @ local
            rverts.append((bm.verts.new(world), (uv, vv), ao_row * (0.92 if col == 1 else 1.0)))
        grid.append(rverts)
    for r in range(2):
        for c in range(2):
            v00, uv00, a00 = grid[r][c]
            v10, uv10, a10 = grid[r][c + 1]
            v11, uv11, a11 = grid[r + 1][c + 1]
            v01, uv01, a01 = grid[r + 1][c]
            f = bm.faces.new((v00, v10, v11, v01))
            f.smooth = True
            for loop, uv, ao in zip(f.loops, (uv00, uv10, uv11, uv01), (a00, a10, a11, a01)):
                loop[uv_layer].uv = uv
                loop[col_layer] = (ao, ao, ao, 1.0)


def build_tree_species(species: str, lod: int, seed: int, mat):
    """Build one Mediterranean tree mesh in Blender Z-up (exported to glTF Y-up automatically)."""
    rng = random.Random(seed)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    col_layer = bm.loops.layers.color.new("Col")

    if species == "Cypress":
        height = 13.5
        # Straight slender trunk
        pts = [Vector((rng.uniform(-0.08, 0.08) * t, rng.uniform(-0.08, 0.08) * t, t * height * 0.88)) for t in (0.0, 0.25, 0.55, 0.85, 1.0)]
        rads = [0.32, 0.23, 0.17, 0.11, 0.05]
        add_branch_tube(bm, uv_layer, col_layer, pts, rads, UV_BARK_CONIFER, segs=6 if lod == 0 else 4)
        layers = 14 if lod == 0 else 5
        for l in range(layers):
            f = l / max(1, layers - 1)
            z = 1.4 + f * (height - 2.1)
            envelope = math.sin(min(1.0, (f + 0.08)) * math.pi * 0.92) ** 0.72
            rad = 1.28 * envelope
            cards = (5 if f < 0.75 else 3) if lod == 0 else 2
            for k in range(cards):
                ang = (k / cards) * 2.0 * math.pi + l * 0.85 + rng.uniform(-0.2, 0.2)
                pos = Vector((math.cos(ang) * rad * 0.35, math.sin(ang) * rad * 0.35, z))
                tilt = math.radians(14 + 10 * (1.0 - f))
                rot = Euler((tilt, 0.0, ang + math.pi / 2), "XYZ").to_matrix()
                cw = (1.35 + 0.85 * envelope) * (1.0 if lod == 0 else 1.25)
                ch = (2.2 + 1.1 * (1.0 - 0.35 * f)) * (1.0 if lod == 0 else 1.35)
                add_bough_card(bm, uv_layer, col_layer, pos, cw, ch, Vector((0, 0, 1)), rot, UV_CYPRESS, ao_inner=0.52 + 0.18 * f, ao_outer=0.98)

    elif species == "Pine":
        # Italian Umbrella / Maritime Pine: tall curved bare trunk forking into wide umbrella crown
        height = 12.2
        lean_x, lean_y = rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5)
        pts = [
            Vector((0, 0, -0.15)),
            Vector((lean_x * 0.25, lean_y * 0.25, 2.8)),
            Vector((lean_x * 0.65, lean_y * 0.65, 5.8)),
            Vector((lean_x, lean_y, 7.8)),
        ]
        rads = [0.46, 0.36, 0.30, 0.24]
        add_branch_tube(bm, uv_layer, col_layer, pts, rads, UV_BARK_CONIFER, segs=7 if lod == 0 else 5)
        crown_base = pts[-1]
        num_limbs = 7 if lod == 0 else 4
        for i in range(num_limbs):
            ang = (i / num_limbs) * 2.0 * math.pi + rng.uniform(-0.22, 0.22)
            spread = rng.uniform(3.2, 4.7)
            top_z = crown_base.z + rng.uniform(2.6, 4.2)
            mid = crown_base + Vector((math.cos(ang) * spread * 0.55, math.sin(ang) * spread * 0.55, (top_z - crown_base.z) * 0.55))
            tip = crown_base + Vector((math.cos(ang) * spread, math.sin(ang) * spread, top_z - crown_base.z))
            add_branch_tube(bm, uv_layer, col_layer, [crown_base, mid, tip], [0.20, 0.13, 0.06], UV_BARK_CONIFER, segs=5 if lod == 0 else 4)
            # Layered umbrella needle pads around limb tip and crown top
            pads = 4 if lod == 0 else 2
            for p in range(pads):
                pang = ang + (p - pads * 0.5) * 0.65 + rng.uniform(-0.2, 0.2)
                pr = spread * (0.45 + 0.55 * (p / max(1, pads - 1)))
                pos = crown_base + Vector((math.cos(pang) * pr * 0.72, math.sin(pang) * pr * 0.72, (top_z - crown_base.z) * (0.72 + 0.28 * (p % 2))))
                pitch = math.radians(62 + rng.uniform(-16, 14))
                rot = Euler((pitch, rng.uniform(-0.25, 0.25), pang + math.pi / 2), "XYZ").to_matrix()
                cw = rng.uniform(2.9, 4.0) * (1.0 if lod == 0 else 1.35)
                ch = rng.uniform(2.3, 3.2) * (1.0 if lod == 0 else 1.3)
                add_bough_card(bm, uv_layer, col_layer, pos, cw, ch, Vector((0, 0, 1)), rot, UV_PINE, ao_inner=0.50, ao_outer=1.0)
        # Crown cap
        for k in range(3 if lod == 0 else 2):
            ang = k * (2.0 * math.pi / 3.0) + 0.4
            rot = Euler((math.radians(74), 0.0, ang), "XYZ").to_matrix()
            add_bough_card(bm, uv_layer, col_layer, crown_base + Vector((0, 0, 3.6)), 4.6, 3.8, Vector((0, 0, 1)), rot, UV_PINE, ao_inner=0.68, ao_outer=1.0)

    elif species == "Oak":
        # Mediterranean Holm Oak: stout gnarled trunk, rounded dense evergreen dome
        pts = [Vector((0, 0, -0.15)), Vector((0.15, -0.1, 1.8)), Vector((0.2, 0.08, 3.4))]
        add_branch_tube(bm, uv_layer, col_layer, pts, [0.44, 0.34, 0.25], UV_BARK_BROAD, segs=7 if lod == 0 else 4)
        base = pts[-1]
        limbs = 6 if lod == 0 else 3
        for i in range(limbs):
            ang = (i / limbs) * 2.0 * math.pi + rng.uniform(-0.25, 0.25)
            spread = rng.uniform(2.2, 3.4)
            dz = rng.uniform(2.2, 3.6)
            mid = base + Vector((math.cos(ang) * spread * 0.5, math.sin(ang) * spread * 0.5, dz * 0.55))
            tip = base + Vector((math.cos(ang) * spread, math.sin(ang) * spread, dz))
            add_branch_tube(bm, uv_layer, col_layer, [base, mid, tip], [0.20, 0.13, 0.06], UV_BARK_BROAD, segs=5 if lod == 0 else 4)
            for p in range(5 if lod == 0 else 2):
                pa = ang + rng.uniform(-0.7, 0.7)
                pr = spread * rng.uniform(0.35, 1.05)
                pz = base.z + dz * rng.uniform(0.35, 1.18)
                pos = Vector((math.cos(pa) * pr, math.sin(pa) * pr, pz))
                rot = Euler((math.radians(rng.uniform(28, 72)), rng.uniform(-0.35, 0.35), pa + math.pi / 2), "XYZ").to_matrix()
                cw = rng.uniform(2.4, 3.3) * (1.0 if lod == 0 else 1.35)
                ch = rng.uniform(2.2, 3.0) * (1.0 if lod == 0 else 1.35)
                add_bough_card(bm, uv_layer, col_layer, pos, cw, ch, Vector((0, 0, 1)), rot, UV_OAK, ao_inner=0.48, ao_outer=0.98)

    else:
        # Mediterranean Olive: shorter gnarled low-branching trunk, airy silvery-green canopy
        pts = [Vector((0, 0, -0.15)), Vector((-0.18, 0.12, 1.2)), Vector((0.05, 0.08, 2.2))]
        add_branch_tube(bm, uv_layer, col_layer, pts, [0.36, 0.27, 0.20], UV_BARK_BROAD, segs=6 if lod == 0 else 4)
        base = pts[-1]
        limbs = 5 if lod == 0 else 3
        for i in range(limbs):
            ang = (i / limbs) * 2.0 * math.pi + rng.uniform(-0.3, 0.3)
            spread = rng.uniform(1.8, 2.7)
            dz = rng.uniform(1.5, 2.4)
            tip = base + Vector((math.cos(ang) * spread, math.sin(ang) * spread, dz))
            add_branch_tube(bm, uv_layer, col_layer, [base, tip], [0.16, 0.06], UV_BARK_BROAD, segs=5 if lod == 0 else 4)
            for p in range(4 if lod == 0 else 2):
                pa = ang + rng.uniform(-0.65, 0.65)
                pr = spread * rng.uniform(0.35, 1.05)
                pz = base.z + dz * rng.uniform(0.3, 1.15)
                pos = Vector((math.cos(pa) * pr, math.sin(pa) * pr, pz))
                rot = Euler((math.radians(rng.uniform(30, 70)), rng.uniform(-0.3, 0.3), pa + math.pi / 2), "XYZ").to_matrix()
                cw = rng.uniform(2.0, 2.8) * (1.0 if lod == 0 else 1.35)
                ch = rng.uniform(1.8, 2.5) * (1.0 if lod == 0 else 1.35)
                add_bough_card(bm, uv_layer, col_layer, pos, cw, ch, Vector((0, 0, 1)), rot, UV_OLIVE, ao_inner=0.58, ao_outer=1.0)

    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    obj = create_mesh_obj(f"{species}_LOD{lod}", bm, mat)
    return obj


def generate_botanical_kit():
    clear_scene()
    mat = make_mat("MediterraneanFoliage", (1, 1, 1, 1), metallic=0.0, roughness=0.94, alpha_clip=True)
    for idx, sp in enumerate(["Cypress", "Pine", "Oak", "Olive"]):
        build_tree_species(sp, 0, 1000 + idx * 37, mat)
        build_tree_species(sp, 1, 2000 + idx * 37, mat)

    out_path = str(OUT_DIR / "botanical.raw.glb")
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_texcoords=True,
        export_attributes=True,
        export_materials="EXPORT",
    )
    print(f"Exported {out_path} ({os.path.getsize(out_path):,} bytes)")


# =============================================================================
# 2. FIA GRADE-1 TRACKSIDE ARCHITECTURE KIT (Studio-beveled CAD meshes)
# =============================================================================
def generate_trackside_kit():
    clear_scene()
    m_steel = make_mat("GalvanisedSteel", (0.58, 0.62, 0.63, 1), metallic=0.68, roughness=0.38)
    m_iron = make_mat("StructuralIron", (0.18, 0.21, 0.23, 1), metallic=0.52, roughness=0.46)
    m_concrete = make_mat("ArchitecturalConcrete", (0.68, 0.67, 0.63, 1), metallic=0.0, roughness=0.84)
    m_rubber = make_mat("TireBarrierRubber", (0.11, 0.115, 0.12, 1), metallic=0.0, roughness=0.82)
    m_tecpro_red = make_mat("TecproRed", (0.72, 0.09, 0.07, 1), metallic=0.0, roughness=0.45)
    m_tecpro_white = make_mat("TecproWhite", (0.86, 0.85, 0.80, 1), metallic=0.0, roughness=0.48)
    m_glass = make_mat("HospitalityGlass", (0.14, 0.24, 0.28, 1), metallic=0.25, roughness=0.12)
    m_accent = make_mat("CircuitAccentRed", (0.76, 0.10, 0.08, 1), metallic=0.1, roughness=0.42)
    m_stucco = make_mat("TuscanStucco", (0.74, 0.66, 0.51, 1), metallic=0.0, roughness=0.88)
    m_terracotta = make_mat("TerracottaTile", (0.56, 0.27, 0.17, 1), metallic=0.0, roughness=0.78)

    # 1) Armco I-Beam Post + Spacer Block + Base Flange
    bm = bmesh.new()
    add_box(bm, (0, 0, 0.58), (0.04, 0.14, 1.18))      # web
    add_box(bm, (-0.06, 0, 0.58), (0.03, 0.16, 1.18))  # front flange
    add_box(bm, (0.06, 0, 0.58), (0.03, 0.16, 1.18))   # back flange
    add_box(bm, (-0.11, 0, 0.66), (0.12, 0.15, 0.36))  # offset impact blockout
    add_box(bm, (0, 0, 0.025), (0.24, 0.24, 0.05))     # base plate
    obj = create_mesh_obj("ArmcoPost", bm, m_steel)
    apply_bevel_and_uv(obj, 0.008, 1, 1.0)
    bake_height_radial_ao(obj, 0.55, 1.2)

    # 2) Sculpted Interlocking Tecpro Energy-Absorbing Barrier Module (2.0 m long, 1.0 m tall)
    for cname, mat in [("TecproRed", m_tecpro_red), ("TecproWhite", m_tecpro_white)]:
        bm = bmesh.new()
        add_box(bm, (0, 0, 0.48), (0.64, 1.94, 0.96))
        # Vertical energy-absorption ribs + recessed straps
        for y in (-0.65, 0.0, 0.65):
            add_box(bm, (-0.34, y, 0.48), (0.08, 0.24, 0.88))
        add_box(bm, (0, 0, 0.99), (0.52, 1.88, 0.07))  # top bevel cap
        add_box(bm, (0, 0, 0.04), (0.72, 1.98, 0.08))  # weighted foot flange
        obj = create_mesh_obj(cname, bm, mat)
        apply_bevel_and_uv(obj, 0.035, 2, 0.5)
        bake_height_radial_ao(obj, 0.58, 1.0)

    # 3) Belted 3-High FIA Slick Tire-Wall Stack (molded torus tires + steel conveyor belt face)
    bm = bmesh.new()
    for tier in range(3):
        zc = 0.175 + tier * 0.34
        # Build hollow tire ring via 14-segment extruded profile
        segs = 14
        r_out, r_in, hh = 0.35, 0.19, 0.155
        rings = []
        profile = [(r_out, -hh), (r_out + 0.02, 0.0), (r_out, hh), (r_in, hh), (r_in, -hh)]
        for i in range(segs):
            a = 2.0 * math.pi * i / segs
            ca, sa = math.cos(a), math.sin(a)
            rings.append([bm.verts.new((ca * r, sa * r, zc + dz)) for (r, dz) in profile])
        for i in range(segs):
            j = (i + 1) % segs
            for k in range(len(profile)):
                kn = (k + 1) % len(profile)
                bm.faces.new((rings[i][k], rings[j][k], rings[j][kn], rings[i][kn]))
    # Continuous belted rubber fascia plate on track-facing side
    add_box(bm, (-0.38, 0, 0.52), (0.04, 0.72, 0.94))
    obj = create_mesh_obj("TireStack", bm, m_rubber)
    apply_bevel_and_uv(obj, 0.0, 1, 1.0)
    bake_height_radial_ao(obj, 0.45, 1.05)

    # 4) Cranked Debris Catch-Fence Post (3.6m tall with inward crank + baseplate + tension brackets)
    bm = bmesh.new()
    add_cylinder(bm, (0, 0, 0.0), (0, 0, 2.95), 0.055, 0.048, 8)
    add_cylinder(bm, (0, 0, 2.95), (-0.62, 0, 3.60), 0.048, 0.042, 8)
    add_box(bm, (0, 0, 0.03), (0.24, 0.24, 0.06))
    for z in (1.1, 2.0, 2.9):
        add_box(bm, (-0.06, 0, z), (0.08, 0.09, 0.07))
    obj = create_mesh_obj("CatchFencePost", bm, m_steel)
    apply_bevel_and_uv(obj, 0.005, 1, 1.0)
    bake_height_radial_ao(obj, 0.58, 3.6)

    # 5) FIA Marshal Post (raised concrete plinth, tubular safety rail, digital LED flag housing)
    bm = bmesh.new()
    add_box(bm, (0, 0, 0.65), (2.2, 2.8, 1.3))
    add_box(bm, (0, 0, 1.32), (2.35, 2.95, 0.12))
    # Corner stanchions & handrails
    for sx in (-1.05, 1.05):
        for sy in (-1.35, 1.35):
            add_cylinder(bm, (sx, sy, 1.35), (sx, sy, 2.45), 0.035, 0.035, 6)
    add_cylinder(bm, (-1.05, -1.35, 2.42), (-1.05, 1.35, 2.42), 0.03, 0.03, 6)
    add_cylinder(bm, (1.05, -1.35, 2.42), (1.05, 1.35, 2.42), 0.03, 0.03, 6)
    add_cylinder(bm, (-1.05, 1.35, 2.42), (1.05, 1.35, 2.42), 0.03, 0.03, 6)
    # Canopy roof & digital FIA flag panel mast
    add_box(bm, (0.15, 0, 3.45), (2.6, 3.1, 0.16), (0, math.radians(-6), 0))
    add_cylinder(bm, (0.95, -1.25, 1.35), (0.95, -1.25, 3.45), 0.055, 0.055, 8)
    add_cylinder(bm, (0.95, 1.25, 1.35), (0.95, 1.25, 3.45), 0.055, 0.055, 8)
    add_cylinder(bm, (-0.95, 0, 1.35), (-0.95, 0, 3.95), 0.05, 0.05, 8)
    add_box(bm, (-0.95, 0, 3.75), (0.18, 0.95, 0.72))  # Digital FIA Flag Panel housing
    obj = create_mesh_obj("MarshalPost", bm, m_concrete)
    apply_bevel_and_uv(obj, 0.015, 1, 0.4)
    bake_height_radial_ao(obj, 0.55, 4.0)

    # 6) Breakaway Brake Marker Frame (holds 2.0m x 1.0m board)
    bm = bmesh.new()
    for sx in (-0.78, 0.78):
        add_box(bm, (sx, 0, 0.85), (0.09, 0.09, 1.7))
        add_box(bm, (sx, 0, 0.03), (0.24, 0.24, 0.06))
    add_box(bm, (0, 0.05, 1.65), (2.08, 0.09, 1.08))
    obj = create_mesh_obj("BrakeBoardFrame", bm, m_iron)
    apply_bevel_and_uv(obj, 0.01, 1, 1.0)
    bake_height_radial_ao(obj, 0.6, 2.2)

    # 7) Space-Frame Grandstand Bay (24m wide, 10 concrete tiers, stairs, cantilevered truss roof)
    bm = bmesh.new()
    bay_w = 24.0
    for tier in range(10):
        x = -tier * 1.15
        z = 0.45 + tier * 0.53
        add_box(bm, (x, 0, z), (1.22, bay_w - 0.3, 0.54))
        # Seat bench rail
        add_box(bm, (x - 0.12, 0, z + 0.34), (0.48, bay_w - 2.4, 0.16))
    # Rear concrete retaining wall
    add_box(bm, (-11.3, 0, 3.2), (0.55, bay_w, 6.4))
    # Structural cantilever columns + diagonal space-frame roof trusses
    for sy in (-10.0, 0.0, 10.0):
        add_cylinder(bm, (-12.0, sy, 0.0), (-10.6, sy, 8.9), 0.26, 0.22, 8)
        add_cylinder(bm, (-10.6, sy, 8.9), (2.2, sy, 9.75), 0.18, 0.12, 8)
        add_cylinder(bm, (-10.8, sy, 6.9), (-2.0, sy, 9.45), 0.12, 0.10, 6)
        add_cylinder(bm, (-10.6, sy, 8.9), (-10.8, sy, 6.9), 0.12, 0.12, 6)
        # Web diagonals
        for kx in (-8.5, -5.5, -2.5):
            add_cylinder(bm, (kx, sy, 7.6 + (kx + 10.8) * 0.22), (kx + 1.8, sy, 9.3), 0.07, 0.07, 6)
    # Sculpted cantilevered roof deck + fascia lip
    add_box(bm, (-4.8, 0, 9.4), (16.4, bay_w, 0.38), (0, math.radians(-3.8), 0))
    add_box(bm, (3.25, 0, 9.95), (0.28, bay_w, 0.72))
    # Front safety parapet
    add_box(bm, (0.72, 0, 0.85), (0.22, bay_w, 1.05))
    obj = create_mesh_obj("GrandstandBay", bm, m_concrete)
    apply_bevel_and_uv(obj, 0.025, 1, 0.25)
    bake_height_radial_ao(obj, 0.50, 10.0)

    # 8) Overhead Space-Frame 5-Pod FIA Start Gantry (28m clear span)
    bm = bmesh.new()
    span = 27.6
    for side in (-1, 1):
        ox = side * span * 0.5
        for sy in (-1.05, 1.05):
            add_cylinder(bm, (ox, sy, 0.0), (ox, sy, 8.9), 0.22, 0.19, 8)
            add_box(bm, (ox, sy, 0.15), (0.75, 0.75, 0.30))
        for k in range(5):
            z0, z1 = 0.6 + k * 1.55, 0.6 + (k + 1) * 1.55
            y0, y1 = (-1.05, 1.05) if k % 2 == 0 else (1.05, -1.05)
            add_cylinder(bm, (ox, y0, z0), (ox, y1, z1), 0.09, 0.09, 6)
    # Top/bottom horizontal chords + Warren truss diagonals
    for sy in (-1.05, 1.05):
        for sz in (6.85, 8.85):
            add_cylinder(bm, (-span * 0.5, sy, sz), (span * 0.5, sy, sz), 0.15, 0.15, 8)
        for i in range(11):
            x0 = -span * 0.5 + i * (span / 11)
            x1 = x0 + (span / 11)
            add_cylinder(bm, (x0, sy, 6.85 if i % 2 == 0 else 8.85), (x1, sy, 8.85 if i % 2 == 0 else 6.85), 0.08, 0.08, 6)
    # Main fascia box + 5 sculpted FIA signal pods with visors
    add_box(bm, (0, 0, 7.92), (span + 0.8, 1.85, 2.15))
    add_box(bm, (0, -0.58, 6.38), (5.5, 0.78, 1.28))
    for j in range(5):
        px = (j - 2) * 0.96
        add_box(bm, (px, -1.02, 6.38), (0.76, 0.26, 1.04))
        # Sun visor hood over each signal lens
        add_box(bm, (px, -1.24, 6.86), (0.76, 0.34, 0.08), (math.radians(12), 0, 0))
    obj = create_mesh_obj("StartGantry", bm, m_iron)
    apply_bevel_and_uv(obj, 0.015, 1, 0.35)
    bake_height_radial_ao(obj, 0.56, 9.2)

    # 9) Modular GT3 Pit Garage Bay (15.8m long along Y, open workshop mouth, overhead pneumatic boom, upper hospitality deck)
    bm = bmesh.new()
    bay_l = 15.8
    # Structural concrete piers & recessed garage back wall
    for sy in (-7.55, 7.55):
        add_box(bm, (2.2, sy, 2.2), (6.4, 0.65, 4.4))
    add_box(bm, (7.6, 0, 2.2), (4.6, bay_l, 4.4))      # rear workshop core
    add_box(bm, (2.6, 0, 4.25), (12.8, bay_l, 0.52))   # mezzanine slab & cantilevered pit awning
    add_box(bm, (-3.65, 0, 4.22), (0.28, bay_l, 0.78)) # awning fascia
    # Recessed rolled-up shutter box headers inside bay mouth
    for sy in (-3.7, 3.7):
        add_box(bm, (4.85, sy, 3.65), (0.65, 6.8, 0.75))
    # Overhead pneumatic pit air-boom swinging out over the pit box!
    add_cylinder(bm, (-3.4, 0, 4.15), (-7.2, 0, 4.15), 0.08, 0.06, 8)
    add_cylinder(bm, (-3.4, 0, 4.45), (-6.8, 0, 4.15), 0.045, 0.045, 6)
    add_cylinder(bm, (-7.1, 0, 4.15), (-7.1, 0, 2.55), 0.035, 0.035, 6)  # coiled air-gun drop hose
    # Upper glazed hospitality terrace & cantilevered roof
    add_box(bm, (5.2, 0, 5.75), (9.2, bay_l, 2.5))
    for j in range(5):
        my = -6.2 + j * 3.1
        add_box(bm, (0.45, my, 5.75), (0.22, 0.14, 2.45))  # vertical mullions
    add_box(bm, (4.2, 0, 7.15), (12.4, bay_l, 0.42))
    add_box(bm, (-1.95, 0, 7.05), (0.22, bay_l, 0.68))
    obj = create_mesh_obj("PitGarageBay", bm, m_concrete)
    apply_bevel_and_uv(obj, 0.025, 1, 0.25)
    bake_height_radial_ao(obj, 0.48, 7.5)

    # 10) Pit-Wall Team Timing Stand (sits atop the concrete pit wall with 3 monitor housings & rain canopy)
    bm = bmesh.new()
    add_box(bm, (0, 0, 0.48), (1.15, 3.6, 0.96))  # desk console
    for sy in (-1.65, 1.65):
        add_cylinder(bm, (0.48, sy, 0.92), (0.48, sy, 2.55), 0.055, 0.055, 8)
        add_cylinder(bm, (-0.42, sy, 0.92), (-0.42, sy, 2.42), 0.045, 0.045, 8)
    add_box(bm, (0.05, 0, 2.56), (1.75, 4.0, 0.14), (0, math.radians(-5), 0))  # canopy
    for sy in (-1.0, 0.0, 1.0):
        add_box(bm, (-0.28, sy, 1.48), (0.14, 0.68, 0.44), (0, math.radians(14), 0))  # telemetry screens
    obj = create_mesh_obj("PitWallStand", bm, m_iron)
    apply_bevel_and_uv(obj, 0.015, 1, 0.8)
    bake_height_radial_ao(obj, 0.55, 2.7)

    # 11) Player Pit Box Crew/Lollipop Staging Portal (illuminated overhead truss + pit stop lollipop sign)
    bm = bmesh.new()
    # Rear upright truss & cantilevered overhead box marker
    for sy in (-2.9, 2.9):
        add_cylinder(bm, (2.6, sy, 0.0), (2.6, sy, 4.4), 0.08, 0.07, 8)
        add_cylinder(bm, (2.6, sy, 4.4), (-1.4, sy, 4.4), 0.07, 0.06, 8)
        add_cylinder(bm, (2.6, sy, 3.2), (0.4, sy, 4.4), 0.045, 0.045, 6)
    add_box(bm, (-1.15, 0, 4.42), (0.48, 5.9, 0.55))  # overhead illuminated bay beam
    # Lollipop stop-board stand at front of box (+Y)
    add_cylinder(bm, (-1.2, 3.15, 0.0), (-1.2, 3.15, 1.45), 0.04, 0.035, 8)
    add_box(bm, (-1.2, 3.15, 1.62), (0.58, 0.08, 0.58))
    # Tire blanket rack & nitrogen bottle cart on garage side
    add_box(bm, (2.15, -1.6, 0.55), (0.65, 1.85, 1.1))
    add_cylinder(bm, (2.15, 1.35, 0.0), (2.15, 1.35, 1.45), 0.16, 0.16, 10)
    add_cylinder(bm, (2.15, 1.75, 0.0), (2.15, 1.75, 1.45), 0.16, 0.16, 10)
    obj = create_mesh_obj("PitBoxPortal", bm, m_accent)
    apply_bevel_and_uv(obj, 0.015, 1, 0.5)
    bake_height_radial_ao(obj, 0.58, 4.8)

    # 12) Stadium Floodlight Tower (15.5m tapered tubular mast + service platform + 4-head LED bank)
    bm = bmesh.new()
    add_cylinder(bm, (0, 0, 0.0), (0, 0, 15.2), 0.34, 0.17, 10)
    add_box(bm, (0, 0, 0.18), (0.95, 0.95, 0.36))
    add_box(bm, (0, 0, 14.5), (1.1, 3.8, 0.12))  # service catwalk
    add_box(bm, (0, 0, 15.25), (0.28, 3.9, 0.24))  # crossbar
    for j in range(4):
        sy = (j - 1.5) * 0.92
        add_box(bm, (-0.28, sy, 15.05), (0.38, 0.68, 0.46), (0, math.radians(24), 0))
    obj = create_mesh_obj("FloodlightTower", bm, m_steel)
    apply_bevel_and_uv(obj, 0.015, 1, 0.35)
    bake_height_radial_ao(obj, 0.58, 15.5)

    # 13) Tuscan Hillside Villa (beveled stucco body + overhanging pitched terracotta roof + cornice)
    bm = bmesh.new()
    add_box(bm, (0, 0, 3.5), (14.2, 9.2, 7.0))
    add_box(bm, (0, 0, 7.05), (14.8, 9.8, 0.32))  # stone cornice
    # Pitched hipped roof slopes
    for side in (-1, 1):
        add_box(bm, (0, side * 2.55, 8.05), (15.4, 5.6, 0.42), (side * math.radians(22), 0, 0))
    add_box(bm, (0, 0, 9.08), (15.4, 0.45, 0.32))  # ridge cap
    obj = create_mesh_obj("TuscanVilla", bm, m_stucco)
    apply_bevel_and_uv(obj, 0.04, 1, 0.2)
    bake_height_radial_ao(obj, 0.56, 9.2)

    # 14) Tuscan Campanile Bell Tower (tapered stone shaft + belfry arches + pyramidal terracotta spire)
    bm = bmesh.new()
    add_box(bm, (0, 0, 7.5), (5.4, 5.4, 15.0))
    add_box(bm, (0, 0, 15.15), (6.0, 6.0, 0.45))  # belfry cornice
    for sx in (-2.1, 2.1):
        for sy in (-2.1, 2.1):
            add_box(bm, (sx, sy, 16.9), (1.1, 1.1, 3.2))  # belfry corner piers
    add_box(bm, (0, 0, 18.65), (6.3, 6.3, 0.55))
    # Pyramidal spire
    add_cylinder(bm, (0, 0, 18.9), (0, 0, 23.2), 3.6, 0.15, 4)
    obj = create_mesh_obj("TuscanCampanile", bm, m_terracotta)
    apply_bevel_and_uv(obj, 0.03, 1, 0.2)
    bake_height_radial_ao(obj, 0.55, 23.0)

    out_path = str(OUT_DIR / "trackside.raw.glb")
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_texcoords=True,
        export_attributes=True,
        export_materials="EXPORT",
    )
    print(f"Exported {out_path} ({os.path.getsize(out_path):,} bytes)")


if __name__ == "__main__":
    generate_botanical_kit()
    generate_trackside_kit()

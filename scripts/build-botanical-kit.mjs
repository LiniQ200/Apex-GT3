#!/usr/bin/env node
/**
 * Build high-detail Mediterranean branching 3D trees (`assets/kit/botanical.glb`)
 * with separate Bark (for real Poly Haven scanned bark PBR) and Canopy (for our
 * 2048x2048 photorealistic botanical foliage atlas + tangent-space normal map).
 *
 * Features:
 *  - Organic curving tapered trunks with flared root buttresses seated to y = -0.55 m
 *  - Primary & secondary woody limbs splitting naturally into each species' crown
 *  - Folded 3D volumetric foliage frond clusters (never flat planar X-cards)
 *  - Spherical crown-lobe normals + baked interior-to-crown vertex AO
 *  - LOD0 (near trackside) & LOD1 (mid/ridge) for fast WebGPU & WebGL2 rendering
 */
import { mkdir, stat } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, prune, weld } from '@gltf-transform/functions';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function makeBuf() {
  return { pos: [], nor: [], uv: [], col: [], idx: [] };
}

const norm3 = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Add a curved, tapered cylindrical branch/trunk tube with optional root-buttress flutes. */
function addTube(buf, pts, radii, sides = 8, vScale = 0.55, rootFlare = false) {
  const base = buf.pos.length / 3;
  let vAccum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) {
      const prev = pts[i - 1];
      vAccum += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) * vScale;
    }
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const t = norm3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    const ref = Math.abs(t[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    const sideA = norm3(...cross3(t, ref));
    const sideB = norm3(...cross3(sideA, t));
    const r0 = radii[i];
    const ao = Math.min(1, 0.52 + 0.48 * (i / Math.max(1, pts.length - 1)));
    for (let j = 0; j <= sides; j++) {
      const u = j / sides;
      const a = u * Math.PI * 2;
      const flute = rootFlare && i <= 1 ? 1 + (1 - i * 0.55) * 0.28 * Math.cos(a * 5) : 1;
      const r = r0 * flute;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = sideA[0] * ca + sideB[0] * sa;
      const ny = sideA[1] * ca + sideB[1] * sa;
      const nz = sideA[2] * ca + sideB[2] * sa;
      buf.pos.push(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r);
      buf.nor.push(nx, ny, nz);
      buf.uv.push(u * 2.0, vAccum);
      buf.col.push(ao, ao * 0.98, ao * 0.95, 1);
    }
  }
  const stride = sides + 1;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * stride + j;
      const b = a + stride;
      buf.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
}

/**
 * Add a folded 3D botanical frond card (2 angled half-wings meeting along a central spine)
 * with spherical crown normals pointing outward from `lobeCenter` and vertex AO.
 */
function addFoldedFrond(buf, center, dir, upHint, width, height, uvRect, lobeCenter, lobeRadius, aoScale = 1, fold = 0.24) {
  const f = norm3(...dir);
  let r = cross3(upHint, f);
  if (Math.hypot(...r) < 1e-4) r = cross3([1, 0, 0], f);
  r = norm3(...r);
  const u = norm3(...cross3(f, r));

  const [u0, v0, u1, v1] = uvRect;
  const um = (u0 + u1) * 0.5;
  const hw = width * 0.5;
  const bend = height * fold;
  const base = buf.pos.length / 3;

  // 6 vertices: bottom-left, bottom-mid, bottom-right, top-left, top-mid, top-right
  const verts = [
    [-hw, 0, -bend * 0.35, u0, v1],
    [0, 0, 0, um, v1],
    [hw, 0, -bend * 0.35, u1, v1],
    [-hw * 0.96, height, -bend, u0, v0],
    [0, height * 1.03, bend * 0.28, um, v0],
    [hw * 0.96, height, -bend, u1, v0],
  ];
  for (const [lx, ly, lz, tu, tv] of verts) {
    const px = center[0] + r[0] * lx + f[0] * ly + u[0] * lz;
    const py = center[1] + r[1] * lx + f[1] * ly + u[1] * lz;
    const pz = center[2] + r[2] * lx + f[2] * ly + u[2] * lz;
    buf.pos.push(px, py, pz);
    // Volumetric spherical crown normal (lifts upper crown toward sky for rich sunlit depth)
    const dx = px - lobeCenter[0];
    const dy = (py - lobeCenter[1]) * 0.85 + lobeRadius * 0.38;
    const dz = pz - lobeCenter[2];
    const n = norm3(dx, dy, dz);
    buf.nor.push(n[0], n[1], n[2]);
    buf.uv.push(tu, tv);
    const dist = Math.hypot(px - lobeCenter[0], py - lobeCenter[1], pz - lobeCenter[2]);
    const shell = Math.min(1, dist / Math.max(0.5, lobeRadius));
    const ao = Math.min(1, Math.max(0.36, (0.42 + 0.58 * shell) * aoScale));
    buf.col.push(ao, ao, ao, 1);
  }
  // 4 triangles (2 angled wing halves)
  buf.idx.push(
    base + 0, base + 1, base + 4,
    base + 0, base + 4, base + 3,
    base + 1, base + 2, base + 5,
    base + 1, base + 5, base + 4,
  );
}

/** Add a lush volumetric bouquet of 3–4 folded fronds around a branch tip / canopy lobe. */
function addBouquet(buf, pos, lobeCenter, lobeRadius, radius, uvRect, rand, count = 4, upright = false) {
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + rand() * 0.85;
    const tilt = upright ? 0.25 + rand() * 0.35 : 0.45 + rand() * 0.65;
    const dir = upright
      ? [Math.cos(a) * tilt, 0.92, Math.sin(a) * tilt]
      : [Math.cos(a) * Math.cos(tilt), Math.sin(tilt) * 0.55 + 0.2, Math.sin(a) * Math.cos(tilt)];
    const off = [
      pos[0] + Math.cos(a) * radius * 0.22 * (rand() - 0.3),
      pos[1] + (rand() - 0.4) * radius * 0.28,
      pos[2] + Math.sin(a) * radius * 0.22 * (rand() - 0.3),
    ];
    const w = radius * (1.28 + rand() * 0.45);
    const h = radius * (upright ? 1.75 + rand() * 0.45 : 1.25 + rand() * 0.4);
    addFoldedFrond(buf, off, dir, [0, 1, 0], w, h, uvRect, lobeCenter, lobeRadius, 0.88 + rand() * 0.16, 0.22);
  }
}

// Quadrant UV rects in 2048x2048 atlas (tiny 0.008 inset avoids bleed across quadrant borders)
const UV_CYPRESS = [0.008, 0.008, 0.492, 0.492];
const UV_PINE    = [0.508, 0.008, 0.992, 0.492];
const UV_OAK     = [0.008, 0.508, 0.492, 0.992];
const UV_OLIVE   = [0.508, 0.508, 0.992, 0.992];

function buildCypress(lod) {
  const bark = makeBuf(), canopy = makeBuf(), rand = rng(1001 + lod * 77);
  const H = 15.8;
  // Tapered vertical trunk seated deep below y=0
  const trunkPts = [], trunkR = [];
  const segs = lod === 0 ? 7 : 4;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = -0.55 + t * (H * 0.82);
    const sway = Math.sin(t * 2.5) * 0.14;
    trunkPts.push([sway, y, Math.cos(t * 2.1) * 0.08 - 0.08]);
    trunkR.push(0.32 * (1 - t * 0.78) + (i === 0 ? 0.12 : 0));
  }
  addTube(bark, trunkPts, trunkR, lod === 0 ? 7 : 5, 0.5, true);

  // Flame-shaped columnar Italian Cypress foliage from y=1.3m to 16.0m
  const tiers = lod === 0 ? 15 : 7;
  const lobeCenter = [0, H * 0.54, 0];
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = 1.2 + t * (H - 2.4);
    // Classic slender flame profile: widest around t=0.22..0.45, tapering cleanly to spire tip
    const profile = Math.sin(Math.pow(t, 0.72) * Math.PI) * 1.48 + (1 - t) * 0.35;
    const fronds = lod === 0 ? (t > 0.82 ? 3 : 5) : 3;
    for (let k = 0; k < fronds; k++) {
      const a = (k / fronds) * Math.PI * 2 + i * 1.15 + rand() * 0.35;
      const r = profile * (0.38 + rand() * 0.32);
      const pos = [Math.cos(a) * r, y + (rand() - 0.5) * 0.35, Math.sin(a) * r];
      const out = 0.28 + 0.18 * (1 - t);
      const dir = [Math.cos(a) * out, 0.94, Math.sin(a) * out];
      const w = (1.55 + profile * 0.85) * (lod === 0 ? 1.0 : 1.35);
      const h = (2.15 + profile * 0.78) * (lod === 0 ? 1.0 : 1.35);
      addFoldedFrond(canopy, pos, dir, [0, 1, 0], w, h, UV_CYPRESS, lobeCenter, H * 0.48, 0.82 + 0.22 * t, 0.25);
    }
  }
  // Spire tip cap
  addBouquet(canopy, [0, H - 1.3, 0], lobeCenter, H * 0.48, 0.95, UV_CYPRESS, rand, lod === 0 ? 3 : 2, true);
  return { bark, canopy };
}

function buildPine(lod) {
  const bark = makeBuf(), canopy = makeBuf(), rand = rng(2002 + lod * 77);
  const H = 13.6;
  // Iconic Italian Stone Pine (Pinus pinea): tall curved reddish-bark trunk splitting at ~7.5m into umbrella limbs
  const trunkPts = [
    [0, -0.55, 0],
    [0.08, 1.4, -0.05],
    [0.24, 3.8, 0.08],
    [0.16, 6.4, 0.14],
    [0.02, 8.6, 0.05],
  ];
  addTube(bark, trunkPts, [0.54, 0.38, 0.33, 0.28, 0.22], lod === 0 ? 8 : 5, 0.45, true);

  // 5 spreading upper boughs supporting broad flat-domed Mediterranean umbrella crown
  const boughCount = lod === 0 ? 6 : 4;
  const crownCenter = [0, 11.4, 0];
  for (let b = 0; b < boughCount; b++) {
    const a = (b / boughCount) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    const reach = 3.1 + rand() * 1.7;
    const tipY = 10.6 + rand() * 1.5;
    const mid = [Math.cos(a) * reach * 0.52, 9.6 + rand() * 0.6, Math.sin(a) * reach * 0.52];
    const tip = [Math.cos(a) * reach, tipY, Math.sin(a) * reach];
    addTube(bark, [[0.04, 8.2, 0.06], mid, tip], [0.19, 0.13, 0.07], lod === 0 ? 5 : 4, 0.55, false);

    // Dense overlapping needle cushions around each bough tip
    addBouquet(canopy, tip, crownCenter, 5.4, lod === 0 ? 2.45 : 3.0, UV_PINE, rand, lod === 0 ? 5 : 3, false);
    if (lod === 0) {
      // Mid-bough sub-cluster fills the umbrella underside seamlessly
      addBouquet(canopy, [mid[0] * 1.15, tipY - 0.55, mid[2] * 1.15], crownCenter, 5.4, 2.05, UV_PINE, rand, 3, false);
    }
  }
  // Central umbrella crown dome
  addBouquet(canopy, [0, 12.1, 0], crownCenter, 5.4, lod === 0 ? 2.9 : 3.5, UV_PINE, rand, lod === 0 ? 6 : 3, false);
  return { bark, canopy };
}

function buildOak(lod) {
  const bark = makeBuf(), canopy = makeBuf(), rand = rng(3003 + lod * 77);
  // Broad spreading Mediterranean Holm Oak (Quercus ilex): sturdy trunk forking at 2.6m into lush wide dome
  const trunkPts = [
    [0, -0.55, 0],
    [0.06, 0.9, -0.04],
    [-0.08, 2.5, 0.06],
    [0.04, 4.1, -0.02],
  ];
  addTube(bark, trunkPts, [0.52, 0.37, 0.31, 0.22], lod === 0 ? 8 : 5, 0.5, true);

  const crownCenter = [0, 5.8, 0];
  const limbCount = lod === 0 ? 6 : 4;
  for (let i = 0; i < limbCount; i++) {
    const a = (i / limbCount) * Math.PI * 2 + rand() * 0.45;
    const reach = 2.6 + rand() * 1.5;
    const yEnd = 4.6 + rand() * 2.2;
    const mid = [Math.cos(a) * reach * 0.55, 3.8 + rand() * 0.8, Math.sin(a) * reach * 0.55];
    const tip = [Math.cos(a) * reach, yEnd, Math.sin(a) * reach];
    addTube(bark, [[-0.04, 2.7, 0.04], mid, tip], [0.20, 0.13, 0.06], lod === 0 ? 5 : 4, 0.55, false);
    addBouquet(canopy, tip, crownCenter, 4.6, lod === 0 ? 2.25 : 2.8, UV_OAK, rand, lod === 0 ? 5 : 3, false);
    if (lod === 0) {
      addBouquet(canopy, [mid[0] * 1.25, yEnd + 0.75, mid[2] * 1.25], crownCenter, 4.6, 1.95, UV_OAK, rand, 3, false);
    }
  }
  addBouquet(canopy, [0, 7.2, 0], crownCenter, 4.6, lod === 0 ? 2.65 : 3.2, UV_OAK, rand, lod === 0 ? 5 : 3, false);
  return { bark, canopy };
}

function buildOlive(lod) {
  const bark = makeBuf(), canopy = makeBuf(), rand = rng(4004 + lod * 77);
  // Gnarled, twisted Mediterranean Olive (Olea europaea) with multi-stem fork & silvery crown
  const trunkPts = [
    [0, -0.55, 0],
    [0.14, 0.65, -0.09],
    [-0.12, 1.65, 0.11],
    [0.05, 2.45, -0.04],
  ];
  addTube(bark, trunkPts, [0.46, 0.34, 0.27, 0.20], lod === 0 ? 7 : 5, 0.6, true);

  const crownCenter = [0, 3.85, 0];
  const limbCount = lod === 0 ? 5 : 3;
  for (let i = 0; i < limbCount; i++) {
    const a = (i / limbCount) * Math.PI * 2 + rand() * 0.55;
    const reach = 1.9 + rand() * 1.1;
    const tip = [Math.cos(a) * reach, 3.2 + rand() * 1.4, Math.sin(a) * reach];
    const mid = [tip[0] * 0.5 + (rand() - 0.5) * 0.3, 2.6 + rand() * 0.4, tip[2] * 0.5 + (rand() - 0.5) * 0.3];
    addTube(bark, [[0.02, 1.8, 0.04], mid, tip], [0.16, 0.11, 0.05], lod === 0 ? 5 : 4, 0.65, false);
    addBouquet(canopy, tip, crownCenter, 3.4, lod === 0 ? 1.8 : 2.25, UV_OLIVE, rand, lod === 0 ? 4 : 3, false);
  }
  addBouquet(canopy, [0, 4.5, 0], crownCenter, 3.4, lod === 0 ? 2.05 : 2.5, UV_OLIVE, rand, lod === 0 ? 4 : 2, false);
  return { bark, canopy };
}

function addMeshToDoc(doc, scene, buffer, name, buf) {
  const mesh = doc.createMesh(name);
  const prim = doc.createPrimitive();
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(buf.pos)).setBuffer(buffer));
  prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(buf.nor)).setBuffer(buffer));
  prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(buf.uv)).setBuffer(buffer));
  prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(buf.col)).setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(buf.idx)).setBuffer(buffer));
  mesh.addPrimitive(prim);
  scene.addChild(doc.createNode(name).setMesh(mesh));
  return buf.idx.length / 3;
}

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('BotanicalKit');

const builders = [
  ['Cypress', buildCypress],
  ['Pine', buildPine],
  ['Oak', buildOak],
  ['Olive', buildOlive],
];

for (const [species, fn] of builders) {
  for (const lod of [0, 1]) {
    const { bark, canopy } = fn(lod);
    const bt = addMeshToDoc(doc, scene, buffer, `${species}_Bark_LOD${lod}`, bark);
    const ct = addMeshToDoc(doc, scene, buffer, `${species}_Canopy_LOD${lod}`, canopy);
    console.log(`${species}_LOD${lod}: bark=${bt} tris, canopy=${ct} tris (total=${bt + ct})`);
  }
}

await doc.transform(dedup(), weld({ tolerance: 1e-4 }), prune({ keepAttributes: true }));
await mkdir('assets/kit', { recursive: true });
const io = new NodeIO();
await io.write('assets/kit/botanical.glb', doc);
const s = await stat('assets/kit/botanical.glb');
console.log(`Wrote assets/kit/botanical.glb (${(s.size / 1024).toFixed(1)} KiB)`);

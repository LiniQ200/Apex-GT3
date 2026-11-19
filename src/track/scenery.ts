import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Circuit } from '../types';
import { wallOffset, trapSide } from './circuit';
import { geometry, vertex, quad, point, type Geometry, type Vec } from './road';
import { plain, signage, randomSource, type roadMaterials } from './materials';

export function publish(scene: Scene, name: string, g: Geometry, mat: Material, casts = false) {
  const vd = new VertexData();
  vd.positions = g.positions;
  vd.indices = g.indices.slice();
  // Babylon builders author clockwise faces; never change the source Jolt indices.
  for (let i = 0; i < vd.indices.length; i += 3) {
    const t = vd.indices[i + 1];
    vd.indices[i + 1] = vd.indices[i + 2];
    vd.indices[i + 2] = t;
  }
  VertexData.ComputeNormals(vd.positions, vd.indices, (vd.normals = []));
  vd.uvs = g.uvs;
  if (g.uv2.length) vd.uvs2 = g.uv2;
  vd.colors = g.colors;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
  mesh.freezeWorldMatrix();
  return mesh;
}

// A single rigid 2 m kerbstone cannot exactly follow both verges in a tight bend.
// Instance its bevel faces instead: each affine basis sends the unit facet to the
// three ACTUAL collider vertices. This preserves the tapered plan and the tooth
// profile and avoids gaps/overlaps from rotating thousands of rectangular blocks.
export function publishKerbs(scene: Scene, g: Geometry, mat: Material) {
  const groups = new Map<number, { matrices: number[]; colors: number[] }>(),
    p = g.positions;
  for (let i = 0; i < g.indices.length; i += 3) {
    const ai = g.indices[i],
      a = ai * 3,
      b = g.indices[i + 1] * 3,
      c = g.indices[i + 2] * 3;
    const x0 = p[c] - p[a],
      x1 = p[c + 1] - p[a + 1],
      x2 = p[c + 2] - p[a + 2],
      z0 = p[b] - p[a],
      z1 = p[b + 1] - p[a + 1],
      z2 = p[b + 2] - p[a + 2];
    const n0 = z1 * x2 - z2 * x1,
      n1 = z2 * x0 - z0 * x2,
      n2 = z0 * x1 - z1 * x0,
      len = Math.hypot(n0, n1, n2);
    const key = Math.floor(p[a] / 256) * 128 + Math.floor(p[a + 2] / 256);
    let group = groups.get(key);
    if (!group) {
      group = { matrices: [], colors: [] };
      groups.set(key, group);
    }
    group.matrices.push(
      x0,
      x1,
      x2,
      0,
      n0 / len,
      n1 / len,
      n2 / len,
      0,
      z0,
      z1,
      z2,
      0,
      p[a],
      p[a + 1],
      p[a + 2],
      1,
    );
    group.colors.push(g.colors[ai * 4], g.colors[ai * 4 + 1], g.colors[ai * 4 + 2], 1);
  }
  const data = new VertexData();
  data.positions = [0, 0, 0, 0, 0, 1, 1, 0, 0];
  data.indices = [0, 2, 1];
  data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0];
  data.uvs = [0, 0, 0, 0.92, 0.42, 0];
  for (const [key, group] of groups) {
    const mesh = new Mesh('circuit.painted kerb ' + key, scene);
    data.applyToMesh(mesh);
    mesh.material = mat;
    mesh.thinInstanceSetBuffer('matrix', new Float32Array(group.matrices), 16, true);
    mesh.thinInstanceSetBuffer('color', new Float32Array(group.colors), 4, true);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.metadata = { trackShadowCaster: false, shadowCaster: false };
    mesh.freezeWorldMatrix();
  }
}

function floor(x: number, z: number) {
  const edge = Math.max(0, Math.abs(x - 620) - 729, Math.abs(z - 160) - 605);
  const gain = 1 - Math.exp((-edge * edge) / 55000);
  const wide =
    64 +
    31 * Math.sin(x * 0.0058 + z * 0.0032) +
    24 * Math.sin(x * 0.0091 - z * 0.0075) +
    12 * Math.cos(z * 0.017 + x * 0.008) +
    5 * Math.sin(x * 0.032 + z * 0.019);
  return -2.36 + gain * wide;
}
function hills(scene: Scene, mat: Material) {
  const g = geometry(),
    w = 93,
    h = 83;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = -1340 + i * 43,
        z = -1460 + j * 43,
        y = floor(x, z),
        tone = 0.62 + 0.1 * Math.cos(z * 0.013 + x * 0.019) + 0.04 * Math.sin(z * 0.038 - x * 0.022);
      vertex(g, [x, y, z], [x / 17, z / 17], [tone * 1.12, tone, tone * 0.87]);
      if (i && j) {
        const a = j * w + i;
        quad(g, a - w - 1, a - 1, a, a - w);
      }
    }
  publish(scene, 'terrain.rolling Apennine foothills', g, mat);
}

// Batches are spatially partitioned so a view down the pit straight doesn't submit
// every pine and rail support on the back of the circuit to the GPU or shadow pass.
function batches(scene: Scene, base: Material, glass: Material, crowd: Material) {
  type Group = { matrix: number[]; color: number[]; kind: string };
  const groups = new Map<string, Group>();
  const palette = new Map<string, Color3>();
  function place(kind: string, pos: Vec, size: Vec, color: string, yaw = 0, pitch = 0, roll = 0) {
    const region = Math.floor((pos[0] + 160) / 340) + ':' + Math.floor((pos[2] + 100) / 340),
      key = kind + '@' + region;
    let group = groups.get(key);
    if (!group) {
      group = { matrix: [], color: [], kind };
      groups.set(key, group);
    }
    const m = Matrix.Compose(
      Vector3.FromArray(size),
      Quaternion.RotationYawPitchRoll(yaw, pitch, roll),
      Vector3.FromArray(pos),
    );
    group.matrix.push(...m.m);
    let c = palette.get(color);
    if (!c) {
      c = Color3.FromHexString(color).toLinearSpace();
      palette.set(color, c);
    }
    group.color.push(c.r, c.g, c.b, 1);
  }
  function rod(a: Vec, b: Vec, r: number, color: string, kind = 'box') {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    place(
      kind,
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      [r, r, Math.hypot(dx, dy, dz)],
      color,
      Math.atan2(dx, dz),
      -Math.atan2(dy, Math.hypot(dx, dz)),
    );
  }
  function finish() {
    for (const [key, g] of groups) {
      const name = 'venue.' + key;
      let m: Mesh;
      if (g.kind === 'cypress' || g.kind === 'pine') m = tree(scene, name, g.kind === 'cypress', base);
      else if (g.kind === 'crowd') m = CreatePlane(name, { size: 1 }, scene);
      else if (g.kind === 'mast')
        m = CreateCylinder(name, { height: 1, diameterTop: 0.76, diameterBottom: 1, tessellation: 8 }, scene);
      else m = CreateBox(name, { size: 1 }, scene);
      m.material = g.kind === 'glass' ? glass : g.kind === 'crowd' ? crowd : base;
      m.isPickable = false;
      m.receiveShadows = true;
      m.thinInstanceSetBuffer('matrix', Float32Array.from(g.matrix), 16, true);
      m.thinInstanceSetBuffer('color', Float32Array.from(g.color), 4, true);
      m.metadata = { trackShadowCaster: g.kind !== 'crowd', shadowCaster: g.kind !== 'crowd' };
      m.freezeWorldMatrix();
    }
  }
  return { place, rod, finish };
}

// Irregular, layered broad crowns and narrow Lombardy cypresses, with the trunk and
// foliage sharing a single vertex-colour batch. Not camera-facing tree billboards.
function tree(scene: Scene, name: string, cypress: boolean, mat: Material) {
  const g = geometry(),
    rand = randomSource(cypress ? 74 : 268),
    n = 10;
  function shape(cx: number, cz: number, profile: number[][], leaf: boolean) {
    let prev: number[] = [];
    for (let i = 0; i < profile.length; i++) {
      const [h, r] = profile[i],
        row: number[] = [];
      for (let j = 0; j < n; j++) {
        const a = (j / n) * 2 * Math.PI,
          rr = r * (0.87 + rand() * 0.22),
          k = 0.85 + rand() * 0.31;
        const col: Vec = leaf
          ? [k * (0.14 + h * 0.12), k * (0.23 + h * 0.17), k * (0.095 + h * 0.09)]
          : [0.21, 0.139, 0.071];
        row.push(
          vertex(
            g,
            [cx + Math.sin(a) * rr, h + (leaf ? (rand() - 0.5) * 0.015 : 0), cz + Math.cos(a) * rr],
            [j / n, h],
            col,
          ),
        );
      }
      if (prev.length)
        for (let j = 0; j < n; j++) {
          const k = (j + 1) % n;
          quad(g, prev[j], prev[k], row[k], row[j]);
        }
      prev = row;
    }
  }
  shape(
    0,
    0,
    [
      [0, 0.042],
      [0.48, 0.032],
      [0.72, 0.009],
    ],
    false,
  );
  if (cypress)
    shape(
      0,
      0,
      [
        [0.055, 0.012],
        [0.13, 0.274],
        [0.32, 0.43],
        [0.51, 0.46],
        [0.67, 0.37],
        [0.85, 0.22],
        [0.998, 0.014],
      ],
      true,
    );
  else {
    shape(
      0,
      0,
      [
        [0.43, 0.012],
        [0.55, 0.28],
        [0.69, 0.43],
        [0.83, 0.47],
        [0.95, 0.34],
        [1, 0.045],
      ],
      true,
    );
    for (let j = 0; j < 4; j++) {
      const a = j * 1.57 + 0.35;
      shape(
        Math.sin(a) * 0.23,
        Math.cos(a) * 0.23,
        [
          [0.5, 0.012],
          [0.6, 0.22],
          [0.73, 0.32],
          [0.82, 0.3],
          [0.9, 0.08],
        ],
        true,
      );
    }
  }
  return publish(scene, name, g, mat, true);
}

function spectators(scene: Scene) {
  const t = new DynamicTexture(
      'terrace spectators',
      { width: 1024, height: 128 },
      scene,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
    ),
    c = t.getContext() as CanvasRenderingContext2D;
  const r = randomSource(51),
    shirts = [
      '#b13c30',
      '#24495a',
      '#b6aa87',
      '#3f5253',
      '#ce9a38',
      '#403c46',
      '#4e6556',
      '#eee1c9',
      '#706857',
    ],
    skin = ['#cc9d78', '#8d634b', '#c49779', '#b08a6a'];
  const ell = (x: number, y: number, rx: number, ry: number, col: string) => {
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
    c.fill();
  };
  for (let j = 0; j < 38; j++) {
    if (r() < 0.08) continue;
    const x = 12 + j * 27 + r() * 3,
      h = 16 + r() * 20,
      col = shirts[Math.floor(r() * shirts.length)],
      face = skin[Math.floor(r() * skin.length)];
    ell(x + 1, 113, 10, 37, '#252a2c');
    ell(x, h + 48, 12 + r() * 2, 24, col);
    ell(x, h + 21, 8, 11, face);
    ell(x, h + 12, 8, 4, r() < 0.28 ? col : '#413730');
    if (r() < 0.7) {
      c.strokeStyle = face;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(x - 9, h + 43);
      c.lineTo(x - 11, h + 60);
      c.lineTo(x - 3, h + 64);
      c.stroke();
    }
  }
  t.hasAlpha = true;
  t.update(true);
  const m = plain(scene, 'terraces', 0.99);
  m.albedoTexture = t;
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  m.alphaCutOff = 0.42;
  m.backFaceCulling = false;
  return m;
}

export function buildScenery(scene: Scene, c: Circuit, mats: ReturnType<typeof roadMaterials>) {
  hills(scene, mats.grass);
  const atlas = signage(scene),
    signs = geometry(),
    cloth = geometry(),
    fence = geometry();
  const base = plain(scene, 'painted architecture', 0.72, 0.09),
    glass = plain(scene, 'smoked glazing', 0.2, 0.42),
    people = spectators(scene);
  const { place, rod, finish } = batches(scene, base, glass, people),
    rnd = randomSource(270889);
  const steel = '#687473',
    iron = '#334144',
    charcoal = '#243034',
    chalk = '#dbd8cc',
    slate = '#455359',
    scarlet = '#dd392d',
    brass = '#efae42';
  function box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    dep: number,
    color: string,
    yaw = 0,
    pitch = 0,
    roll = 0,
    kind = 'box',
  ) {
    place(kind, [x, y, z], [w, h, dep], color, yaw, pitch, roll);
  }
  // A panel's yaw is that of a Babylon plane: at yaw=0 its front faces a grid
  // approaching in +Z. Every inscription has explicit orientation and atlas UVs.
  function panel(id: string, v: Vec, width: number, height: number, yaw: number) {
    const [u0, v0, u1, v1] = atlas.uv(id),
      w = width / 2,
      h = height / 2,
      b = signs.positions.length / 3;
    for (const [x, y, u, vt] of [
      [-w, -h, u0, v0],
      [w, -h, u1, v0],
      [w, h, u1, v1],
      [-w, h, u0, v1],
    ])
      vertex(signs, [v[0] + x * Math.cos(yaw), v[1] + y, v[2] - x * Math.sin(yaw)], [u, vt]);
    quad(signs, b, b + 3, b + 2, b + 1);
  }
  function flag(x: number, y: number, z: number, height: number) {
    box(x, y + height / 2, z, 0.1, height, 0.1, steel, 0, 0, 0, 'mast');
    const colors: Vec[] = [
      [0.025, 0.35, 0.17],
      [0.91, 0.89, 0.78],
      [0.69, 0.039, 0.029],
    ];
    for (let j = 0; j < 12; j++) {
      const start = cloth.positions.length / 3;
      for (const [u, v] of [
        [j / 12, 0],
        [j / 12, 1],
        [(j + 1) / 12, 1],
        [(j + 1) / 12, 0],
      ]) {
        vertex(
          cloth,
          [
            x + u * 2.07,
            y + height - 0.18 - v * 1.08 - u * 0.21 + 0.06 * Math.sin(u * 8),
            z + u * 0.65 + 0.23 * Math.sin(u * 8 + z * 0.1),
          ],
          [u, v],
          colors[Math.floor(j / 4)],
        );
      }
      quad(cloth, start, start + 1, start + 2, start + 3);
    }
  }
  function strip(s: number, d: number, ww: number, len: number, col: string, h = 0.018) {
    const p = c.at(s, d);
    box(p.x, p.y + h, p.z, ww, 0.012, len, col, p.yaw, -p.slope, p.bank);
  }
  // Ten staggered two-sided start boxes, yellow timing dashes, chessboard and line.
  for (let i = -6; i < 12; i++) {
    const s = 6 * i,
      d = i % 2 === 0 ? -2.8 : 2.8;
    strip(s + 2.56, d, 2.68, 0.14, chalk);
    for (const dx of [-1.29, 1.29]) strip(s + 1.75, d + dx, 0.1, 1.63, chalk);
    strip(s + 2.73, d, 1.14, 0.12, brass);
  }
  strip(60.0, 0, 15.7, 0.21, chalk);
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 32; i++)
      strip(60.47 + j * 0.43, -7.75 + i * 0.5, 0.5, 0.44, (i + j) % 2 ? '#e9e8dc' : '#303436');

  // Main tribuna. The underside of the projecting canopy, roof lattice, terrace
  // risers, aisle breaks and spectators each read at a different chase-camera range.
  for (let seg = 0; seg < 9; seg++) {
    const z = -56 + seg * 25.4;
    for (let i = 0; i < 10; i++) {
      const x = -19.5 - i * 1.15,
        y = 0.85 + i * 0.53;
      box(x, y - 0.28, z, 1.23, 0.56, 24.9, i % 3 === 0 ? '#929389' : '#aaaba0');
      box(x - 0.12, y + 0.12, z, 0.64, 0.21, 22.9, seg % 3 === 0 ? '#9d392f' : '#576269');
      place(
        'crowd',
        [x - 0.09, y + 0.72, z + (i % 2 ? 0.4 : -0.25)],
        [22.25, 1.38, 1],
        i % 3 === 0 ? '#ebe3d4' : '#ffffff',
        -Math.PI / 2,
      );
    }
    box(-26.2, 9.15, z, 18.3, 0.42, 25.22, '#d5d5c7', 0, 0, 0.059);
    box(-17.15, 9.59, z, 0.2, 0.62, 25.3, '#626a69');
    box(-34.5, 8.64, z, 0.25, 0.63, 25.3, scarlet);
    for (const dz of [-10.3, 10.3]) {
      rod([-33, 0, z + dz], [-30.5, 8.65, z + dz], 0.32, iron);
      rod([-30.6, 7.5, z + dz], [-17.5, 9.4, z + dz], 0.2, slate);
      rod([-30.6, 7.5, z + dz], [-22.5, 9.25, z + dz], 0.13, steel);
      rod([-29.8, 3.95, z + dz], [-20.1, 0.75, z + dz], 0.3, steel);
    }
    if (seg % 2 === 0) panel('tribuna', [-17.015, 9.55, z], 18.0, 0.91, -Math.PI / 2);
    if (seg % 2 === 1) flag(-31, 8.78, z, 4.5);
  }

  // Pit apron with a 16-bay pit building: open, dark workshop mouths below a
  // continuous glazed hospitality storey. Color-coded garage numbers face the road.
  box(25, -0.18, 63, 30, 0.34, 276, '#666a66');
  box(11.3, 0.02, 63, 0.16, 0.03, 275, chalk);
  box(18.8, 0.022, 63, 0.16, 0.03, 275, brass);
  const bays = ['#d74637', '#d3b565', '#36756b', '#a7b2aa'];
  for (let i = 0; i < 16; i++) {
    const z = -58 + i * 15.8;
    box(32.7, 2.03, z, 11.8, 4.12, 15.72, '#535b59');
    box(27.13, 2.04, z, 0.78, 4.1, 14.9, '#303739');
    box(27.05, 2.15, z, 1.38, 3.95, 0.32, '#98a09a');
    for (const dz of [-7.45, 7.45]) box(24.28, 2.08, z + dz, 6.65, 4.16, 0.54, '#c6c5b7');
    for (const dz of [-3.7, 3.7]) {
      box(26.68, 2.96, z + dz, 0.12, 1.92, 6.55, '#727d7b');
      for (let j = 0; j < 5; j++) box(26.59, 2.14 + j * 0.36, z + dz, 0.07, 0.053, 6.55, '#424a4b');
    }
    box(29.45, 4.16, z, 17.5, 0.49, 15.8, chalk);
    box(20.74, 4.11, z, 0.14, 0.65, 15.8, bays[i % 4]);
    box(31.9, 5.53, z, 12.8, 2.3, 15.75, '#b2b6ac');
    box(25.25, 5.62, z, 0.4, 1.85, 15.6, '#708e95', 0, 0, 0, 'glass');
    for (let j = 0; j < 5; j++) box(25.01, 5.63, z - 6.25 + j * 3.11, 0.19, 2.04, 0.115, iron);
    box(30.65, 6.91, z, 15.45, 0.35, 15.8, '#dadbcf');
    box(22.92, 6.76, z, 0.16, 0.64, 15.8, '#aeb4ad');
    panel('bay' + i, [20.62, 4.12, z - 4.8], 1.55, 0.63, Math.PI / 2);
    if (i % 3 !== 1) panel(i % 2 ? 'off' : 'pits', [22.82, 6.78, z], 9.8, 0.69, Math.PI / 2);
    strip(z - 6.7, 20, 3.2, 0.12, chalk);
  }
  // Projecting race-control box and freestanding two-faced timing monolith.
  box(28.5, 8.15, 75, 15.6, 2.52, 31, '#59737a', 0, 0, 0, 'glass');
  box(28, 9.67, 75, 18.3, 0.49, 34.2, chalk);
  box(28, 7.02, 75, 17.3, 0.32, 33.5, '#aab2ab');
  for (let j = 0; j < 11; j++) box(20.55, 8.15, 60.4 + j * 2.9, 0.2, 2.44, 0.111, iron);
  for (let z = 64; z < 89; z += 6) flag(30, 9.9, z, 4.1);
  box(16.8, 8.1, 98, 3.65, 16.2, 2.35, iron);
  box(16.8, 16.35, 98, 4.08, 0.35, 2.7, scarlet);
  panel('tower', [16.8, 10.9, 96.79], 3.39, 10.35, 0);
  panel('tower', [14.95, 10.9, 98], 2.14, 10.35, Math.PI / 2);
  for (let j = 0; j < 4; j++) box(16.8, 2.96 + j * 0.56, 96.78, 3, 0.105, 0.07, brass);

  function bridge(s: number, id: string, start = false) {
    const p = c.at(s),
      yaw = p.yaw,
      span = start ? 27 : 28.5;
    const loc = (d: number, h: number, z = 0): Vec => {
      const v = point(p, d, h);
      v[0] += Math.sin(yaw) * z;
      v[2] += Math.cos(yaw) * z;
      return v;
    };
    for (const side of [-1, 1]) {
      const off = (side * span) / 2;
      for (const z of [-1.08, 1.08]) rod(loc(off, -0.1, z), loc(off, 7.86, z), 0.32, steel);
      for (let i = 0; i < 5; i++)
        rod(
          loc(off, i * 1.47, i % 2 ? -1.08 : 1.08),
          loc(off, (i + 1) * 1.47, i % 2 ? 1.08 : -1.08),
          0.16,
          slate,
        );
    }
    for (const z of [-1, 1])
      for (const y of [6.84, 8.88]) rod(loc(-span / 2, y, z), loc(span / 2, y, z), 0.19, steel);
    for (let x = -span / 2; x < span / 2 - 0.6; x += 2.5)
      rod(loc(x, 6.86, 1), loc(Math.min(span / 2, x + 2.5), 8.86, 1), 0.16, slate);
    place('box', loc(0, 8.03), [span + 1, 2.24, 1.93], charcoal, yaw);
    panel(id, loc(0, 8.03, -0.99), span + 0.95, 2.23, yaw);
    panel('apex', loc(0, 8.03, 1.0), span + 0.96, 2.23, yaw + Math.PI);
    if (start) {
      place('box', loc(0, 6.43, -0.63), [5.3, 1.33, 0.78], charcoal, yaw);
      for (let j = 0; j < 5; j++)
        place('box', loc((j - 2) * 0.94, 6.47, -1.02), [0.79, 1.06, 0.28], '#162025', yaw);
    }
  }
  bridge(64, 'hero', true);
  bridge(528, 'turn1');
  bridge(2310, 'chicane');
  const darkLight = plain(scene, 'start signal unlit', 0.38, 0.25);
  darkLight.albedoColor = Color3.FromHexString('#421f1b').toLinearSpace();
  const liveLight = plain(scene, 'FIA signal red', 0.33);
  liveLight.emissiveColor = new Color3(2.15, 0.017, 0.008);
  liveLight.albedoColor = new Color3(0.41, 0.005, 0.002);
  const lights: Mesh[] = [];
  for (let j = 0; j < 5; j++) {
    const m = CreateCylinder(
      'start gantry.signal ' + (j + 1),
      { height: 0.1, diameter: 0.56, tessellation: 16 },
      scene,
    );
    m.rotation.x = Math.PI / 2;
    m.position.set((j - 2) * 0.94, 6.48, 62.77);
    m.material = darkLight;
    m.isPickable = false;
    m.freezeWorldMatrix();
    lights.push(m);
  }

  // Number boards, sponsored short hoardings, pressed-rail pillars, Tecpro blocks,
  // cranked catch fence and floodlight banks continue through all three sectors.
  for (const [apex, side] of [
    [665, -1],
    [1640, 1],
    [2460, -1],
    [3970, -1],
  ])
    for (const n of [150, 100, 50]) {
      const p = c.at(apex - n),
        d = side * (wallOffset(p, side, c.length) - 0.14),
        v = point(p, d, 1.65);
      place('box', v, [2.03, 1.03, 0.115], chalk, p.yaw);
      const v2: Vec = [v[0] - 0.07 * Math.sin(p.yaw), v[1], v[2] - 0.07 * Math.cos(p.yaw)];
      panel('board' + n, v2, 2.0, 1.01, p.yaw);
      const leg = point(p, d, 0.63);
      place('box', leg, [0.13, 1.35, 0.13], steel, p.yaw);
    }
  const sponsors = ['vet', 'apex', 'oro', 'off'];
  for (let s = 0; s < c.length; s += 12) {
    const p = c.at(s);
    for (const side of [-1, 1]) {
      const d = wallOffset(p, side, c.length),
        post = (s < 460 || s > c.length - 82) && side === 1,
        fc = s < 305 || s > c.length - 72 || trapSide(s) === side;
      if (!post) place('box', point(p, side * (d + 0.19), 0.56), [0.16, 1.2, 0.21], steel, p.yaw);
      if (fc) {
        const o = side * (d + 0.35);
        rod(point(p, o, 0.05), point(p, o, 2.9), 0.074, slate);
        rod(point(p, o, 2.9), point(p, o - side * 0.58, 3.54), 0.075, steel);
        const q = c.at(Math.min(c.length, s + 12)),
          oo = side * (wallOffset(q, side, c.length) + 0.35),
          u = s / 1.32,
          v = (s + 12) / 1.32,
          b = fence.positions.length / 3;
        vertex(fence, point(p, o, 0.91), [u, 0]);
        vertex(fence, point(q, oo, 0.91), [v, 0]);
        vertex(fence, point(q, oo, 2.9), [v, 1.5]);
        vertex(fence, point(p, o, 2.9), [u, 1.5]);
        quad(fence, b, b + 1, b + 2, b + 3);
        rod(point(p, o, 2.85), point(q, oo, 2.85), 0.04, '#77807a');
      }
      if (s % 24 === 0 && (s < 165 || s > c.length - 52 || (Math.floor(s / 85) % 4 === 1 && !post))) {
        const len = s < 166 ? 9.8 : 8.2,
          dst = side * (d - 0.13),
          v = point(p, dst, 0.69);
        place('box', v, [0.12, 0.73, len], charcoal, p.yaw);
        panel(
          sponsors[(Math.floor(s / 24) + (side < 0 ? 0 : 1)) % 4],
          point(p, dst - side * 0.076, 0.69),
          len,
          0.73,
          p.yaw + (side * Math.PI) / 2,
        );
      }
    }
  }
  for (let i = 0; i < 30; i++) {
    const s = i < 8 ? -50 + i * 47 : 350 + (i - 8) * 180,
      side = i % 2 ? -1 : 1,
      p = c.at(s),
      off = side * (s < 310 ? (side > 0 ? 41 : 38) : wallOffset(p, side, c.length) + 4);
    const v = point(p, off),
      y = Math.max(v[1], floor(v[0], v[2])),
      h = 14.5 + (i % 4) * 1.1;
    box(v[0], y + h / 2, v[2], 0.42, h, 0.42, steel, p.yaw, 0, 0, 'mast');
    box(v[0], y + h, v[2], 3.6, 0.18, 0.54, iron, p.yaw);
    for (let j = 0; j < 4; j++) {
      const k = (j - 1.5) * 0.83;
      box(
        v[0] + Math.cos(p.yaw) * k,
        y + h - 0.18,
        v[2] - Math.sin(p.yaw) * k,
        0.65,
        0.47,
        0.38,
        '#c4c6af',
        p.yaw,
        0.3,
      );
    }
  }
  // Stands at other points give a moving TV camera a meaningful foreground and
  // make the returning straight distinct from the pit complex.
  for (const s of [734, 1668, 2488, 2900, 3970]) {
    const p = c.at(s),
      side = trapSide(s) || -1,
      edge = wallOffset(p, side, c.length) + 5;
    for (let j = 0; j < 6; j++) {
      const v = point(p, side * (edge + j * 1.2), 0.75 + j * 0.45);
      place('box', v, [1.3, 0.51, 28], chalk, p.yaw);
      place('crowd', [v[0], v[1] + 0.87, v[2]], [26.5, 1.23, 1], chalk, p.yaw + (side * Math.PI) / 2);
    }
    const y = point(p, side * (edge + 3.3), 5.55);
    place('box', y, [10.2, 0.38, 29.6], scarlet, p.yaw, 0, -side * 0.085);
    for (const z of [-12, 12]) {
      const v = point(p, side * (edge + 6), 2.6);
      place(
        'box',
        [v[0] + z * Math.sin(p.yaw), v[1], v[2] + z * Math.cos(p.yaw)],
        [0.28, 5.6, 0.28],
        iron,
        p.yaw,
      );
    }
  }

  // Mixed, slightly irregular plantations. Reject neighbouring pieces of circuit,
  // and leave the occupied paddock clear, including the outside of the hairpin.
  for (let i = 0; i < 690; i++) {
    const s = rnd() * c.length,
      p = c.at(s),
      side = rnd() < 0.5 ? -1 : 1,
      d = side * (23 + rnd() * 94),
      v = point(p, d);
    if (v[0] > -44 && v[0] < 52 && v[2] > -100 && v[2] < 240) continue;
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 9) continue;
    const tall = rnd() < 0.56,
      h = (tall ? 8.5 : 6) + rnd() * 7.3,
      w = tall ? 1.75 + rnd() * 1.15 : 5.65 + rnd() * 3.9;
    place(
      tall ? 'cypress' : 'pine',
      [v[0], floor(v[0], v[2]), v[2]],
      [w, h, w * (0.82 + rnd() * 0.27)],
      ['#a5ac8b', '#b8bb95', '#859b85', '#c1bc8a'][i % 4],
      rnd() * 6.28,
    );
  }
  for (let i = 0; i < 310; i++) {
    const x = -470 + rnd() * 2240,
      z = i % 2 ? -630 - rnd() * 210 : 820 + rnd() * 230,
      h = 8 + rnd() * 8,
      w = 4 + rnd() * 6;
    place(
      i % 4 === 0 ? 'cypress' : 'pine',
      [x, floor(x, z) - 0.4, z],
      [i % 4 === 0 ? w * 0.26 : w, h, i % 4 === 0 ? w * 0.29 : w],
      '#abb8a1',
      rnd() * 6.28,
    );
  }
  // Terracotta farmsteads and a campanile near the northern ridge: a distinctly
  // Italian horizon even when the player is away from motorsport architecture.
  for (const [x, z] of [
    [-83, 778],
    [26, 823],
    [127, 866],
    [321, 808],
    [464, 739],
    [794, 853],
    [-213, 496],
    [1150, -540],
  ]) {
    const y = floor(x, z);
    box(x, y + 3.5, z, 14, 7, 9, '#c9b794');
    for (const side of [-1, 1]) box(x, y + 7.67, z + side * 2.42, 15.2, 0.48, 5.24, '#a46041', 0, side * 0.3);
    for (const dx of [-4.9, -1.7, 1.7, 4.9])
      for (const dy of [2.2, 5.1]) box(x + dx, y + dy, z - 4.53, 1.13, 1.55, 0.1, '#4c5349');
  }
  {
    const x = 26,
      z = 839,
      y = floor(x, z);
    box(x, y + 9, z, 5.5, 18, 5.5, '#d6c29d');
    box(x, y + 16, z - 2.81, 2.5, 2.68, 0.12, '#615a4e');
    box(x, y + 18.3, z, 6.6, 0.72, 6.6, '#b69b75');
    place('mast', [x, y + 20.2, z], [4.98, 3.4, 4.98], '#8d593d', Math.PI / 4);
    box(x, y + 22.8, z, 0.19, 2.9, 0.19, iron);
  }

  const link = new DynamicTexture('galvanised catch mesh', 128, scene, true, Texture.TRILINEAR_SAMPLINGMODE),
    ctx = link.getContext() as CanvasRenderingContext2D;
  ctx.strokeStyle = '#90968a';
  ctx.lineWidth = 1.7;
  for (let i = -128; i < 256; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 64, 128);
    ctx.moveTo(i, 0);
    ctx.lineTo(i - 64, 128);
    ctx.stroke();
  }
  link.hasAlpha = true;
  link.wrapU = link.wrapV = Texture.WRAP_ADDRESSMODE;
  link.update(true);
  const chain = plain(scene, 'catch fencing', 0.68, 0.24);
  chain.albedoTexture = link;
  chain.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  chain.alphaCutOff = 0.21;
  chain.backFaceCulling = false;
  const flagMat = plain(scene, 'tricolore', 0.92);
  flagMat.backFaceCulling = false;
  flagMat.twoSidedLighting = true;
  publish(scene, 'venue.catch fencing', fence, chain);
  publish(scene, 'venue.trackside lettering', signs, atlas.mat);
  publish(scene, 'venue.tricolori', cloth, flagMat);
  finish();
  let last = -1;
  return (n: number) => {
    n = Math.max(0, Math.min(5, Math.floor(n)));
    if (n === last) return;
    for (let j = 0; j < 5; j++) lights[j].material = j < n ? liveLight : darkLight;
    last = n;
  };
}

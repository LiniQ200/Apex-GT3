import type { Scene } from '@babylonjs/core/scene';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { Material } from '@babylonjs/core/Materials/material';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Circuit, Weather } from '../types';
import {
  PIT_BOX_D,
  PIT_WALL_D,
  PIT_WALL_END_S,
  PIT_WALL_START_BACK,
  pitBoxStation,
  sprintGrid,
  trapSide,
  wallOffset,
} from './circuit';
import { geometry, vertex, quad, point, type Geometry as RawGeom, type Vec } from './road';
import { plain, signage, randomSource, type roadMaterials } from './materials';
import { bakeGltfVertexData, createBotanicalForest, type Species } from './foliage';

const assetUrl = (rel: string) =>
  new URL(`${import.meta.env.BASE_URL}assets/${rel}`, window.location.href).href;

function meshData(g: RawGeom) {
  const vd = new VertexData();
  vd.positions = g.positions;
  vd.indices = g.indices.slice();
  for (let i = 0; i < vd.indices.length; i += 3) {
    const t = vd.indices[i + 1];
    vd.indices[i + 1] = vd.indices[i + 2];
    vd.indices[i + 2] = t;
  }
  VertexData.ComputeNormals(vd.positions, vd.indices, (vd.normals = []));
  vd.uvs = g.uvs;
  if (g.uv2.length) vd.uvs2 = g.uv2;
  vd.colors = g.colors;
  return vd;
}

export function publish(scene: Scene, name: string, g: RawGeom, mat: Material, casts = false, sectorMetres = 0) {
  const first = new Mesh(name, scene);
  meshData(g).applyToMesh(first);
  for (let start = 0, sector = 0; start < g.indices.length; sector++) {
    let end = g.indices.length;
    if (sectorMetres) {
      const origin = 3 * g.indices[start];
      for (let i = start + 3; i < end; i += 3) {
        const p = 3 * g.indices[i];
        if ((g.positions[p] - g.positions[origin]) ** 2 + (g.positions[p + 2] - g.positions[origin + 2]) ** 2 > sectorMetres ** 2) {
          end = i;
          break;
        }
      }
    }
    const mesh = start ? new Mesh(`${name}.${sector}`, scene) : first;
    if (start) first.geometry!.applyToMesh(mesh);
    if (end - start < g.indices.length) {
      mesh.releaseSubMeshes();
      const range = SubMesh.CreateFromIndices(0, start, end - start, mesh);
      mesh.setBoundingInfo(range.getBoundingInfo());
    }
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
    mesh.freezeWorldMatrix();
    start = end;
  }
  return first;
}

export function publishKerbs(scene: Scene, g: RawGeom, mat: Material) {
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
      x0, x1, x2, 0,
      n0 / len, n1 / len, n2 / len, 0,
      z0, z1, z2, 0,
      p[a], p[a + 1], p[a + 2], 1,
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

const hillsX = -1340,
  hillsZ = -1460,
  hillStep = 43;
function hillSample(x: number, z: number) {
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
function floor(x: number, z: number) {
  const x0 = hillsX + Math.floor((x - hillsX) / hillStep) * hillStep;
  const z0 = hillsZ + Math.floor((z - hillsZ) / hillStep) * hillStep;
  const u = (x - x0) / hillStep,
    v = (z - z0) / hillStep;
  const diagonal =
    (1 - Math.max(u, v)) * hillSample(x0, z0) +
    Math.min(u, v) * hillSample(x0 + hillStep, z0 + hillStep);
  return diagonal + (u > v ? (u - v) * hillSample(x0 + hillStep, z0) : (v - u) * hillSample(x0, z0 + hillStep));
}
function hills(scene: Scene, grass: PBRMaterial) {
  const g = geometry(),
    w = 93,
    h = 83;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = hillsX + i * hillStep,
        z = hillsZ + j * hillStep,
        y = hillSample(x, z),
        tone = 0.62 + 0.1 * Math.cos(z * 0.013 + x * 0.019) + 0.04 * Math.sin(z * 0.038 - x * 0.022);
      vertex(g, [x, y, z], [x / 17, z / 17], [tone * 1.12, tone, tone * 0.87]);
    }
  for (let z = 0; z < h - 1; z += 41)
    for (let x = 0; x < w - 1; x += 46)
      for (let j = z + 1; j <= z + 41; j++)
        for (let i = x + 1; i <= x + 46; i++) {
          const a = j * w + i;
          quad(g, a - w - 1, a - 1, a, a - w);
        }
  const mat = plain(scene, 'distant pasture', 0.96);
  mat.albedoTexture = grass.albedoTexture;
  mat.albedoColor = grass.albedoColor;
  publish(scene, 'terrain.rolling Apennine foothills', g, mat).subdivide(4);
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
    shirts = ['#b13c30', '#24495a', '#b6aa87', '#3f5253', '#ce9a38', '#403c46', '#4e6556', '#eee1c9', '#706857'],
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
  }
  t.hasAlpha = true;
  t.anisotropicFilteringLevel = 16;
  t.update(true);
  const m = plain(scene, 'terraces', 0.99);
  m.albedoTexture = t;
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  m.alphaCutOff = 0.42;
  m.backFaceCulling = false;
  return m;
}

/**
 * Load the Blender 4.3 studio-beveled FIA Grade-1 modular trackside kit
 * (`assets/kit/trackside.glb`) — zero primitive CreateBox/CreateCylinder stacking!
 */
async function loadTracksideKit(scene: Scene, mats: ReturnType<typeof roadMaterials>) {
  const res = await fetch(assetUrl('kit/trackside.glb'));
  if (!res.ok) throw Error(`Failed to load kit/trackside.glb: HTTP ${res.status}`);
  const container = await LoadAssetContainerAsync(new Uint8Array(await res.arrayBuffer()), scene, {
    name: 'trackside.glb',
    pluginExtension: '.glb',
    pluginOptions: { gltf: { skipMaterials: true, createInstances: false } },
  });
  const geoms = new Map<string, VertexData>();
  for (const m of container.meshes) {
    if (m instanceof Mesh && m.geometry) {
      const clean = m.name.replace(/_primitive\d+$/, '');
      geoms.set(clean, bakeGltfVertexData(m));
    }
  }
  container.dispose();

  // Assign calibrated scanned PBR materials to each architectural class
  const steelMat = mats.wall;
  const ironMat = plain(scene, 'kit.structuralIron', 0.44, 0.56);
  ironMat.albedoColor = Color3.FromHexString('#293237').toLinearSpace();
  ironMat.bumpTexture = mats.wall.bumpTexture;
  const concreteMat = mats.concrete;
  const rubberMat = plain(scene, 'kit.tireWallRubber', 0.84, 0.02);
  rubberMat.albedoColor = Color3.FromHexString('#1e2022').toLinearSpace();
  const tecproRedMat = plain(scene, 'kit.tecproRed', 0.46, 0.04);
  tecproRedMat.albedoColor = Color3.FromHexString('#c4231b').toLinearSpace();
  const tecproWhiteMat = plain(scene, 'kit.tecproWhite', 0.52, 0.02);
  tecproWhiteMat.albedoColor = Color3.FromHexString('#e5e3d8').toLinearSpace();
  const accentMat = plain(scene, 'kit.pitBoxPortal', 0.36, 0.25);
  accentMat.albedoColor = Color3.FromHexString('#dc3926').toLinearSpace();
  accentMat.emissiveColor = new Color3(0.28, 0.06, 0.02);
  const villaMat = plain(scene, 'kit.tuscanStucco', 0.86, 0.0);
  villaMat.albedoColor = Color3.FromHexString('#c8b693').toLinearSpace();
  villaMat.bumpTexture = mats.concrete.bumpTexture;
  const terraMat = plain(scene, 'kit.terracotta', 0.78, 0.0);
  terraMat.albedoColor = Color3.FromHexString('#9c563a').toLinearSpace();

  const matMap: Record<string, Material> = {
    ArmcoPost: steelMat,
    TecproRed: tecproRedMat,
    TecproWhite: tecproWhiteMat,
    TireStack: rubberMat,
    CatchFencePost: steelMat,
    MarshalPost: concreteMat,
    BrakeBoardFrame: ironMat,
    GrandstandBay: concreteMat,
    StartGantry: ironMat,
    PitGarageBay: concreteMat,
    PitWallStand: ironMat,
    PitBoxPortal: accentMat,
    FloodlightTower: steelMat,
    TuscanVilla: villaMat,
    TuscanCampanile: terraMat,
  };

  type KitCell = { part: string; matrices: number[] };
  const cells = new Map<string, KitCell>();

  function placeKit(part: string, pos: Vec, yaw = 0, scale: Vec = [1, 1, 1], pitch = 0, roll = 0) {
    if (!geoms.has(part)) return;
    const cellSz = part === 'ArmcoPost' || part === 'CatchFencePost' || part === 'TireStack' ? 280 : 420;
    const key = `${part}@${Math.floor((pos[0] + 160) / cellSz)}:${Math.floor((pos[2] + 100) / cellSz)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { part, matrices: [] };
      cells.set(key, cell);
    }
    const m = Matrix.Compose(
      Vector3.FromArray(scale),
      Quaternion.RotationYawPitchRoll(yaw, pitch, roll),
      Vector3.FromArray(pos),
    );
    cell.matrices.push(...m.m);
  }

  function finishKit() {
    for (const [key, cell] of cells) {
      const g = geoms.get(cell.part);
      if (!g) continue;
      const mesh = new Mesh('venue.kit.' + key, scene);
      g.applyToMesh(mesh);
      mesh.material = matMap[cell.part] ?? concreteMat;
      mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.thinInstanceSetBuffer('matrix', Float32Array.from(cell.matrices), 16, true);
      const casts = cell.part !== 'ArmcoPost' && cell.part !== 'CatchFencePost';
      mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
      mesh.freezeWorldMatrix();
    }
  }

  return { placeKit, finishKit };
}

export async function buildScenery(scene: Scene, c: Circuit, mats: ReturnType<typeof roadMaterials>) {
  hills(scene, mats.grass);
  const [kit, forest] = await Promise.all([loadTracksideKit(scene, mats), createBotanicalForest(scene)]);

  const atlas = signage(scene),
    signs = geometry(),
    crowdGeom = geometry(),
    gridPaint = geometry(),
    fence = geometry(),
    flagPanels = geometry();
  const peopleMat = spectators(scene);
  const rnd = randomSource(270889);

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

  function addPaintQuad(s: number, d: number, ww: number, len: number, col: Vec, h = 0.017) {
    const p0 = c.at(s - len * 0.5), p1 = c.at(s + len * 0.5);
    const a = vertex(gridPaint, point(p0, d - ww * 0.5, h), [0, 0], col);
    const b = vertex(gridPaint, point(p1, d - ww * 0.5, h), [0, 1], col);
    const cc = vertex(gridPaint, point(p1, d + ww * 0.5, h), [1, 1], col);
    const dd = vertex(gridPaint, point(p0, d + ww * 0.5, h), [1, 0], col);
    quad(gridPaint, a, b, cc, dd);
  }

  // Starting grid boxes & checkered timing line (flat road-hugging decals, zero boxes)
  const chalk: Vec = [0.89, 0.88, 0.82],
    brass: Vec = [0.95, 0.72, 0.25];
  for (const { s, d } of sprintGrid) {
    addPaintQuad(s + 2.56, d, 2.68, 0.14, chalk);
    for (const dx of [-1.29, 1.29]) addPaintQuad(s + 1.75, d + dx, 0.1, 1.63, chalk);
    addPaintQuad(s + 2.73, d, 1.14, 0.12, brass);
  }
  addPaintQuad(0, 0, 15.7, 0.21, chalk);
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 32; i++)
      addPaintQuad(
        0.47 + j * 0.43,
        -7.75 + i * 0.5,
        0.5,
        0.44,
        (i + j) % 2 ? [0.91, 0.91, 0.86] : [0.18, 0.2, 0.22],
      );

  // Main Grandstands (Blender space-frame cantilevered bays + terraced spectators)
  for (let seg = 0; seg < 8; seg++) {
    const z = -42 + seg * 25.5;
    kit.placeKit('GrandstandBay', [-19.5, 0, z], 0);
    for (let tier = 0; tier < 10; tier++) {
      const x = -19.6 - tier * 1.15,
        y = 1.48 + tier * 0.53;
      const b = crowdGeom.positions.length / 3;
      const hw = 10.6,
        hh = 0.68;
      vertex(crowdGeom, [x, y - hh, z - hw], [0, 0]);
      vertex(crowdGeom, [x, y - hh, z + hw], [1, 0]);
      vertex(crowdGeom, [x, y + hh, z + hw], [1, 1]);
      vertex(crowdGeom, [x, y + hh, z - hw], [0, 1]);
      quad(crowdGeom, b, b + 1, b + 2, b + 3);
    }
    if (seg % 2 === 0) panel('tribuna', [-16.1, 9.95, z], 18.0, 0.91, -Math.PI / 2);
  }

  // 10-Bay GT3 Pit Garage Complex along the drivable pit lane (+X = 22.8 m)
  // Plus Pit-Wall Team Timing Stands atop the concrete pit wall (d = 9.74 m)
  // Plus illuminated Player Pit Box Portal & Lollipop at Bay 01 (s = 70, d = 17.2 m)
  for (let i = 0; i < 16; i++) {
    const z = -42 + i * 16.0;
    kit.placeKit('PitGarageBay', [26.2, 0, z], 0);
    panel('bay' + i, [22.4, 4.22, z - 4.8], 1.55, 0.63, Math.PI / 2);
    if (i % 3 !== 1) panel(i % 2 ? 'off' : 'pits', [24.1, 7.05, z], 9.8, 0.69, Math.PI / 2);
  }
  // Pit-wall team timing stands spaced along the separating concrete pit wall
  for (let s = 18; s <= 230; s += 26) {
    const p = c.at(s, PIT_WALL_D + 0.34);
    kit.placeKit('PitWallStand', [p.x, p.y + 1.02, p.z], p.yaw);
  }
  // Player Pit Box (Bay 01 at s = 70, d = 17.2 m) — illuminated overhead portal & lollipop stop board!
  {
    const pb = c.at(pitBoxStation(0), PIT_BOX_D);
    kit.placeKit('PitBoxPortal', [pb.x, pb.y, pb.z], pb.yaw);
  }

  // Overhead Space-Frame Start Gantry + Turn 1 & Chicane Bridges
  for (const [s, id, isStart] of [
    [64, 'hero', true],
    [528, 'turn1', false],
    [2310, 'chicane', false],
  ] as const) {
    const p = c.at(s);
    kit.placeKit('StartGantry', [p.x, p.y, p.z], p.yaw);
    const sn = Math.sin(p.yaw),
      cs = Math.cos(p.yaw);
    const loc = (zOff: number): Vec => [p.x + sn * zOff, p.y + 7.92, p.z + cs * zOff];
    panel(id, loc(-0.98), 27.6, 2.1, p.yaw);
    panel('apex', loc(0.98), 27.6, 2.1, p.yaw + Math.PI);
    if (isStart) {
      // Pit-entry overhead advisory banner
      const pe = c.at(c.length - PIT_WALL_START_BACK - 10, PIT_WALL_D + 5.5);
      panel('pitexit', [pe.x, pe.y + 4.8, pe.z], 9.2, 1.35, pe.yaw);
    }
  }

  // 5 FIA Start Signal Discs seated inside StartGantry's sculpted 5-pod visors (custom disc geometry, no CreateCylinder)
  const darkLight = plain(scene, 'start signal unlit', 0.38, 0.25);
  darkLight.albedoColor = Color3.FromHexString('#421f1b').toLinearSpace();
  const liveLight = plain(scene, 'FIA signal red', 0.33);
  liveLight.emissiveColor = new Color3(2.25, 0.017, 0.008);
  liveLight.albedoColor = new Color3(0.41, 0.005, 0.002);
  const discVd = new VertexData();
  const dp: number[] = [0, 0, 0],
    dn: number[] = [0, 0, -1],
    du: number[] = [0.5, 0.5],
    di: number[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    dp.push(Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0);
    dn.push(0, 0, -1);
    du.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    di.push(0, 1 + ((k + 1) % 16), 1 + k);
  }
  discVd.positions = dp;
  discVd.normals = dn;
  discVd.uvs = du;
  discVd.indices = di;
  const lights: Mesh[] = [];
  for (let j = 0; j < 5; j++) {
    const m = new Mesh('start gantry.signal ' + (j + 1), scene);
    discVd.applyToMesh(m);
    m.position.set((j - 2) * 0.96, 6.38, 62.82);
    m.material = darkLight;
    m.isPickable = false;
    m.freezeWorldMatrix();
    lights.push(m);
  }

  // Breakaway 150/100/50m Brake Boards + 60 km/h FIA Pit Entry Speed Board
  for (const [apex, side] of [
    [665, -1],
    [1640, 1],
    [2460, -1],
    [3970, -1],
  ]) {
    for (const n of [150, 100, 50]) {
      const p = c.at(apex - n),
        d = side * (wallOffset(p, side, c.length) - 0.22),
        v = point(p, d, 0);
      kit.placeKit('BrakeBoardFrame', v, p.yaw);
      const pv: Vec = [v[0] - 0.04 * Math.sin(p.yaw), v[1] + 1.65, v[2] - 0.04 * Math.cos(p.yaw)];
      panel('board' + n, pv, 2.0, 1.01, p.yaw);
    }
  }
  // 60 km/h Pit-entry limiter marker board at pit entry line
  {
    const pe = c.at(c.length - PIT_WALL_START_BACK - 3, PIT_WALL_D + 0.35);
    kit.placeKit('BrakeBoardFrame', [pe.x, pe.y, pe.z], pe.yaw);
    panel('board60', [pe.x - 0.05 * Math.sin(pe.yaw), pe.y + 1.65, pe.z - 0.05 * Math.cos(pe.yaw)], 2.0, 1.01, pe.yaw);
  }

  // FIA Marshal Posts with Digital Flag LED Panels around all major corners
  for (const [s, side] of [
    [640, -1],
    [980, 1],
    [1420, -1],
    [1720, 1],
    [2440, -1],
    [2820, -1],
    [3520, 1],
    [4010, -1],
  ]) {
    const p = c.at(s),
      d = side * (wallOffset(p, side, c.length) + 2.8),
      v = point(p, d, 0);
    kit.placeKit('MarshalPost', v, p.yaw + (side < 0 ? 0 : Math.PI));
    // Digital FIA LED flag panel face
    const b = flagPanels.positions.length / 3;
    const fx = v[0] - side * 0.9 * Math.cos(p.yaw),
      fz = v[2] + side * 0.9 * Math.sin(p.yaw),
      fy = v[1] + 3.75;
    const sn = Math.sin(p.yaw),
      cs = Math.cos(p.yaw);
    for (const [lx, ly] of [
      [-0.44, -0.32],
      [0.44, -0.32],
      [0.44, 0.32],
      [-0.44, 0.32],
    ])
      vertex(flagPanels, [fx + lx * sn, fy + ly, fz + lx * cs], [0.5, 0.5]);
    quad(flagPanels, b, b + 1, b + 2, b + 3);
  }
  const flagLedMat = plain(scene, 'FIA digital flag panel', 0.25);
  flagLedMat.emissiveColor = new Color3(0.08, 1.45, 0.28); // Green clear track (shifts to amber/blue in rain)
  flagLedMat.backFaceCulling = false;
  publish(scene, 'venue.marshalFlagPanels', flagPanels, flagLedMat);

  // Guardrail I-Beam Posts, Sculpted Tecpro Blocks, Belted Tire Stacks, Catch-Fence & Hoardings
  const sponsors = ['vet', 'apex', 'oro', 'off'];
  for (let s = 0; s < c.length; s += 12) {
    const p = c.at(s);
    for (const side of [-1, 1]) {
      const d = wallOffset(p, side, c.length);
      const isPitSide = side === 1 && (s < PIT_WALL_END_S + 8 || s > c.length - PIT_WALL_START_BACK - 8);
      const isTrap = trapSide(s) === side;
      const needsFence = s < 305 || s > c.length - 72 || isTrap;

      if (!isPitSide && !isTrap) {
        kit.placeKit('ArmcoPost', point(p, side * (d + 0.16), 0), p.yaw + (side < 0 ? Math.PI : 0));
      }
      if (isTrap) {
        // Interlocking Tecpro blocks & belted tire stacks along high-energy gravel runoff zones
        const block = Math.floor(s / 12) % 2 === 0 ? 'TecproRed' : 'TecproWhite';
        kit.placeKit(block, point(p, side * (d + 0.35), 0), p.yaw + (side < 0 ? Math.PI : 0));
        if (s % 24 === 0) {
          kit.placeKit('TireStack', point(p, side * (d + 1.05), 0), p.yaw + (side < 0 ? Math.PI : 0));
        }
      }
      if (needsFence && !isPitSide) {
        const o = side * (d + 0.42);
        kit.placeKit('CatchFencePost', point(p, o, 0), p.yaw + (side < 0 ? Math.PI : 0));
        const q = c.at(Math.min(c.length, s + 12)),
          oo = side * (wallOffset(q, side, c.length) + 0.42),
          u = s / 1.32,
          v = (s + 12) / 1.32,
          b = fence.positions.length / 3;
        vertex(fence, point(p, o, 0.91), [u, 0]);
        vertex(fence, point(q, oo, 0.91), [v, 0]);
        vertex(fence, point(q, oo, 2.95), [v, 1.5]);
        vertex(fence, point(p, o, 2.95), [u, 1.5]);
        quad(fence, b, b + 1, b + 2, b + 3);
      }
      if (s % 24 === 0 && !isPitSide && (s < 165 || s > c.length - 52 || Math.floor(s / 85) % 4 === 1)) {
        const len = s < 166 ? 9.8 : 8.2,
          dst = side * (d - 0.14);
        panel(
          sponsors[(Math.floor(s / 24) + (side < 0 ? 0 : 1)) % 4],
          point(p, dst, 0.69),
          len,
          0.73,
          p.yaw + (side * Math.PI) / 2,
        );
      }
    }
  }

  // Stadium Floodlight Towers (Blender tapered tubular masts + 4-head LED banks)
  for (let i = 0; i < 26; i++) {
    const s = i < 7 ? -42 + i * 48 : 350 + (i - 7) * 205,
      side = i % 2 ? -1 : 1,
      p = c.at(s),
      off = side * (s < 310 ? (side > 0 ? 39 : 36) : wallOffset(p, side, c.length) + 4.5);
    const v = point(p, off),
      y = Math.max(v[1], floor(v[0], v[2]));
    kit.placeKit('FloodlightTower', [v[0], y, v[2]], p.yaw + (side < 0 ? Math.PI : 0));
  }

  // Trackside Corner Grandstands (Blender space-frame bays)
  for (const s of [734, 1668, 2488, 2900, 3970]) {
    const p = c.at(s),
      side = trapSide(s) || -1,
      edge = wallOffset(p, side, c.length) + 6;
    const v = point(p, side * edge, 0);
    kit.placeKit('GrandstandBay', v, p.yaw + (side > 0 ? Math.PI : 0), [0.85, 0.85, 0.85]);
  }

  // Dense Static Multi-Species Botanical Forest (Cypress, Maritime Pine, Holm Oak, Olive)
  // + Real Poly Haven Photogrammetry Mossy Rocks, Ferns, Shrubs & Grass Clumps!
  const speciesPool: Species[] = ['Cypress', 'Pine', 'Oak', 'Olive'];
  for (let i = 0; i < 1050; i++) {
    const s = rnd() * c.length,
      p = c.at(s),
      side = rnd() < 0.5 ? -1 : 1,
      d = side * (wallOffset(p, side, c.length) + 9.5 + rnd() * 115),
      v = point(p, d);
    if (v[0] > -38 && v[0] < 44 && v[2] > -105 && v[2] < 275) continue;
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 8.0) continue;
    const rChoice = rnd();
    const sp: Species = rChoice < 0.34 ? 'Cypress' : rChoice < 0.66 ? 'Pine' : rChoice < 0.85 ? 'Oak' : 'Olive';
    const h = 0.82 + rnd() * 0.62,
      w = 0.84 + rnd() * 0.52;
    forest.plantTree(sp, [v[0], floor(v[0], v[2]) - 0.12, v[2]], [w, h, w * (0.88 + rnd() * 0.24)], rnd() * 6.28, i % 4, false);
  }
  // Lush hillside groves framing the main straight & Turn 1 Apennine skyline!
  for (let i = 0; i < 240; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side < 0 ? -42 - rnd() * 145 : 46 + rnd() * 145;
    const z = -90 + rnd() * 820;
    const near = c.nearest(x, z),
      np = c.at(near.s);
    if (Math.hypot(np.x - x, np.z - z) < wallOffset(np, Math.sign(near.d), c.length) + 9) continue;
    const sp: Species = i % 3 === 0 ? 'Cypress' : i % 3 === 1 ? 'Pine' : 'Oak';
    const h = 0.9 + rnd() * 0.65,
      w = 0.88 + rnd() * 0.52;
    forest.plantTree(sp, [x, floor(x, z) - 0.15, z], [w, h, w], rnd() * 6.28, i % 4, false);
  }
  // Distant ridge forest (LOD1 silhouettes, zero shadow cost)
  for (let i = 0; i < 360; i++) {
    const x = -470 + rnd() * 2240,
      z = i % 2 ? -630 - rnd() * 210 : 820 + rnd() * 230,
      h = 0.85 + rnd() * 0.72,
      w = 0.78 + rnd() * 0.58;
    forest.plantTree(speciesPool[i % 4], [x, floor(x, z) - 0.15, z], [w, h, w], rnd() * 6.28, i % 4, true);
  }

  // Layer genuine Poly Haven photogrammetry rocks, shrubs, ferns & grass clumps along corners & banks!
  for (let i = 0; i < 420; i++) {
    const s = rnd() * c.length,
      p = c.at(s),
      side = rnd() < 0.5 ? -1 : 1,
      wallD = wallOffset(p, side, c.length),
      d = side * (wallD + 2.2 + rnd() * 26),
      v = point(p, d);
    if (v[0] > -44 && v[0] < 54 && v[2] > -100 && v[2] < 275) continue;
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 1.8) continue;
    const y = Math.min(v[1], floor(v[0], v[2])) + 0.05;
    const roll = rnd();
    if (roll < 0.28) {
      const sc = 0.85 + rnd() * 1.45;
      forest.plantBiome('rock_moss', [v[0], y - 0.15, v[2]], [sc, sc * (0.75 + rnd() * 0.4), sc], rnd() * 6.28, i);
    } else if (roll < 0.54) {
      const sc = 1.2 + rnd() * 1.2;
      forest.plantBiome('shrub', [v[0], y, v[2]], [sc, sc, sc], rnd() * 6.28, i);
    } else if (roll < 0.76) {
      const sc = 1.1 + rnd() * 1.1;
      forest.plantBiome('fern', [v[0], y, v[2]], [sc, sc, sc], rnd() * 6.28, i);
    } else {
      const sc = 1.3 + rnd() * 1.3;
      forest.plantBiome('grass_clump', [v[0], y, v[2]], [sc, sc, sc], rnd() * 6.28, i);
    }
  }

  // Tuscan Hillside Villas & Campanile (Blender pitched-roof stone & terracotta architecture)
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
    kit.placeKit('TuscanVilla', [x, floor(x, z) - 0.2, z], rnd() * 0.6);
  }
  kit.placeKit('TuscanCampanile', [26, floor(26, 839) - 0.2, 839], 0);

  // Catch-fence woven mesh
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
  link.anisotropicFilteringLevel = 16;
  link.wrapU = link.wrapV = Texture.WRAP_ADDRESSMODE;
  link.update(true);
  const chain = plain(scene, 'catch fencing', 0.68, 0.24);
  chain.albedoTexture = link;
  chain.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  chain.alphaCutOff = 0.21;
  chain.backFaceCulling = false;

  publish(scene, 'venue.catch fencing', fence, chain);
  publish(scene, 'venue.trackside lettering', signs, atlas.mat);
  publish(scene, 'venue.terrace crowds', crowdGeom, peopleMat);
  publish(scene, 'venue.grid markings', gridPaint, mats.paint);
  kit.finishKit();
  forest.finish();

  let last = -1;
  return {
    setLights(n: number) {
      n = Math.max(0, Math.min(5, Math.floor(n)));
      if (n === last) return;
      for (let j = 0; j < 5; j++) lights[j].material = j < n ? liveLight : darkLight;
      last = n;
    },
    setFlagWeather(w: Weather) {
      // Digital FIA marshal flag panels switch to wet/slippery amber in Heavy Rain
      if (w === 'rain') flagLedMat.emissiveColor.set(1.65, 0.92, 0.06);
      else if (w === 'damp') flagLedMat.emissiveColor.set(0.75, 1.25, 0.14);
      else flagLedMat.emissiveColor.set(0.08, 1.45, 0.28);
    },
  };
}

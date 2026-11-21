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
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
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
import { ClothFlagShaderPlugin } from './flagShader';

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
function hills(scene: Scene, mats: ReturnType<typeof roadMaterials>) {
  const grass = mats.grass;
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
  const mat = plain(scene, 'distant pasture', 0.94);
  mat.albedoTexture = grass.albedoTexture;
  mat.bumpTexture = grass.bumpTexture;
  mat.albedoColor = grass.albedoColor;
  mats.attachTerrainShader(mat);
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
    const cellSz = 680;
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

  const shadowKitParts = new Set(['StartGantry', 'GrandstandBay', 'PitGarageBay', 'PitBoxPortal']);
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
      const casts = shadowKitParts.has(cell.part);
      mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
      mesh.freezeWorldMatrix();
    }
  }

  return { placeKit, finishKit };
}

type ScannedProp =
  | 'tool_cart'
  | 'tool_chest'
  | 'fuel_drum'
  | 'air_rig'
  | 'jersey_barrier'
  | 'parts_cart'
  | 'toolbox'
  | 'pit_crate';

async function loadScannedProps(scene: Scene) {
  const names: ScannedProp[] = [
    'tool_cart',
    'tool_chest',
    'fuel_drum',
    'air_rig',
    'jersey_barrier',
    'parts_cart',
    'toolbox',
    'pit_crate',
  ];
  const templates = new Map<ScannedProp, { vd: VertexData; material: PBRMaterial | null }[]>();
  await Promise.all(
    names.map(async (name) => {
      const res = await fetch(assetUrl(`props/${name}.glb`));
      if (!res.ok) throw Error(`Failed to load props/${name}.glb: HTTP ${res.status}`);
      const container = await LoadAssetContainerAsync(new Uint8Array(await res.arrayBuffer()), scene, {
        name: `${name}.glb`,
        pluginExtension: '.glb',
        pluginOptions: { gltf: { createInstances: false } },
      });
      const parts: { vd: VertexData; material: PBRMaterial | null }[] = [];
      for (const m of container.meshes) {
        if (!(m instanceof Mesh) || !m.geometry) continue;
        const vd = bakeGltfVertexData(m);
        let mat: PBRMaterial | null = null;
        if (m.material instanceof PBRMaterial) {
          mat = m.material.clone(`venue.prop.${name}.${parts.length}`);
          mat.maxSimultaneousLights = 2;
          for (const t of mat.getActiveTextures()) {
            if (t instanceof Texture) {
              t.anisotropicFilteringLevel = 8;
              t.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
            }
          }
          scene.addMaterial(mat);
        }
        parts.push({ vd, material: mat });
      }
      templates.set(name, parts);
      container.dispose();
    }),
  );

  const placements = new Map<ScannedProp, number[]>();
  function placeProp(name: ScannedProp, pos: Vec, yaw = 0, scale: Vec = [1, 1, 1]) {
    let list = placements.get(name);
    if (!list) {
      list = [];
      placements.set(name, list);
    }
    const m = Matrix.Compose(
      Vector3.FromArray(scale),
      Quaternion.RotationAxis(Vector3.UpReadOnly, yaw),
      Vector3.FromArray(pos),
    );
    list.push(...m.m);
  }

  function finishProps() {
    for (const [name, mats] of placements) {
      const parts = templates.get(name);
      if (!parts?.length || !mats.length) continue;
      const buf = Float32Array.from(mats);
      parts.forEach((p, idx) => {
        const mesh = new Mesh(`venue.prop.${name}.${idx}`, scene);
        p.vd.applyToMesh(mesh);
        if (p.material) mesh.material = p.material;
        mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.thinInstanceSetBuffer('matrix', buf, 16, true);
        const casts = name === 'jersey_barrier' || name === 'tool_cart' || name === 'parts_cart';
        mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts, nearTreeShadow: casts };
        mesh.freezeWorldMatrix();
      });
    }
  }

  return { placeProp, finishProps };
}

export async function buildScenery(scene: Scene, c: Circuit, mats: ReturnType<typeof roadMaterials>) {
  hills(scene, mats);
  const [kit, forest, props] = await Promise.all([
    loadTracksideKit(scene, mats),
    createBotanicalForest(scene),
    loadScannedProps(scene),
  ]);

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
  // Plus real Poly Haven photogrammetry paddock tools, chests, drums & pneumatic rigs!
  for (let i = 0; i < 16; i++) {
    const z = -42 + i * 16.0;
    kit.placeKit('PitGarageBay', [26.2, 0, z], 0);
    panel('bay' + i, [22.4, 4.22, z - 4.8], 1.55, 0.63, Math.PI / 2);
    if (i % 3 !== 1) panel(i % 2 ? 'off' : 'pits', [24.1, 7.05, z], 9.8, 0.69, Math.PI / 2);
    // Grounded paddock bay hardware safely tucked beside garage aprons (well clear of pit box d=17.2)
    if (i % 2 === 0) props.placeProp('tool_cart', [21.3, 0, z + 3.4], -Math.PI * 0.5 + (i % 3 - 1) * 0.14);
    if (i % 3 === 0) props.placeProp('tool_chest', [21.6, 0, z - 3.6], -Math.PI * 0.5);
    if (i % 2 === 1) props.placeProp('fuel_drum', [21.5, 0, z + 4.2], i * 0.8);
    if (i % 4 === 1) props.placeProp('air_rig', [21.2, 0, z - 2.6], -Math.PI * 0.45);
    if (i % 3 === 1) props.placeProp('parts_cart', [21.4, 0, z + 2.4], -Math.PI * 0.5);
    if (i % 2 === 0) props.placeProp('pit_crate', [21.5, 0, z - 2.2], i * 0.5);
    if (i % 4 === 2) props.placeProp('toolbox', [21.1, 0, z + 5.1], -Math.PI * 0.4);
  }
  const pitGlowGeom = geometry();
  for (let i = 0; i < 16; i++) {
    const z = -42 + i * 16.0;
    const b = pitGlowGeom.positions.length / 3;
    // Recessed warm halogen garage ceiling strip visible through each open pit bay
    vertex(pitGlowGeom, [22.65, 3.35, z - 4.4], [0, 0]);
    vertex(pitGlowGeom, [22.65, 3.35, z + 4.4], [1, 0]);
    vertex(pitGlowGeom, [22.65, 3.85, z + 4.4], [1, 1]);
    vertex(pitGlowGeom, [22.65, 3.85, z - 4.4], [0, 1]);
    quad(pitGlowGeom, b, b + 1, b + 2, b + 3);
  }
  const pitGlowMat = new StandardMaterial('venue.pitGlow', scene);
  pitGlowMat.disableLighting = true;
  pitGlowMat.diffuseColor = Color3.Black();
  pitGlowMat.specularColor = Color3.Black();
  pitGlowMat.emissiveColor = new Color3(0.22, 0.17, 0.11);
  pitGlowMat.backFaceCulling = false;
  publish(scene, 'venue.pitGarageGlow', pitGlowGeom, pitGlowMat, false).receiveShadows = false;

  // FIA Glass-Fronted Race Control & Timing Tower at Pit Exit (s=224, d=24.2)
  const glassMat = plain(scene, 'raceControlGlass', 0.08, 0.78);
  glassMat.albedoColor = Color3.FromHexString('#182a34').toLinearSpace();
  glassMat.clearCoat.isEnabled = true;
  glassMat.clearCoat.intensity = 1.0;
  glassMat.clearCoat.roughness = 0.04;
  {
    const tcPos = c.at(224, 24.4);
    const towerConcrete = geometry();
    const towerGlass = geometry();
    const addBoxGeom = (geom: RawGeom, cx: number, cy: number, cz: number, wx: number, wy: number, wz: number) => {
      const hx = wx / 2, hy = wy / 2, hz = wz / 2;
      const faces: [Vec[], [number, number][]][] = [
        [[[cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]], [[0, 0], [1, 0], [1, 1], [0, 1]]],
        [[[cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz]], [[0, 0], [1, 0], [1, 1], [0, 1]]],
        [[[cx - hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz - hz]], [[0, 0], [1, 0], [1, 1], [0, 1]]],
        [[[cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz]], [[0, 0], [1, 0], [1, 1], [0, 1]]],
        [[[cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz]], [[0, 0], [1, 0], [1, 1], [0, 1]]],
      ];
      for (const [verts, uvs] of faces) {
        const b = geom.positions.length / 3;
        for (let i = 0; i < 4; i++) vertex(geom, verts[i], uvs[i]);
        quad(geom, b, b + 1, b + 2, b + 3);
      }
    };
    // Base podium + core tower + cantilevered control-deck roof + timing pylon
    addBoxGeom(towerConcrete, tcPos.x, 4.2, tcPos.z, 7.6, 8.4, 9.2);
    addBoxGeom(towerConcrete, tcPos.x - 1.1, 8.9, tcPos.z, 10.4, 0.9, 11.4);
    addBoxGeom(towerConcrete, tcPos.x - 1.1, 13.5, tcPos.z, 10.8, 0.75, 11.8);
    // Tinted panoramic architectural glass around the race-control observation deck
    addBoxGeom(towerGlass, tcPos.x - 1.0, 11.2, tcPos.z, 9.8, 3.8, 10.8);
    publish(scene, 'venue.raceControlTower', towerConcrete, mats.concrete, true);
    publish(scene, 'venue.raceControlGlass', towerGlass, glassMat, false);
    // Illuminated VDO lap-record timing pylon facing oncoming straight traffic!
    panel('tower', [tcPos.x - 4.05, 8.8, tcPos.z - 5.2], 3.4, 7.2, 0);
  }
  // Animated GPU-cloth circuit flags flying over Main Grandstand, Pit Complex & Race Control Tower!
  const flagTex = new DynamicTexture('venue.circuitFlagsTex', { width: 512, height: 256 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  {
    const fc = flagTex.getContext() as CanvasRenderingContext2D;
    // Left half: Italian Tricolore; Right half: APEX GT3 Racing Banner
    fc.fillStyle = '#0f8c54'; fc.fillRect(0, 0, 170, 128);
    fc.fillStyle = '#f5f2e6'; fc.fillRect(170, 0, 172, 128);
    fc.fillStyle = '#d62828'; fc.fillRect(342, 0, 170, 128);
    fc.fillStyle = '#121921'; fc.fillRect(0, 128, 512, 128);
    fc.fillStyle = '#ff5733'; fc.fillRect(0, 128, 180, 128);
    fc.fillStyle = '#f5f2e6';
    for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 8; cx++) if ((cx + cy) % 2 === 0) fc.fillRect(352 + cx * 20, 128 + cy * 32, 20, 32);
    flagTex.anisotropicFilteringLevel = 8;
    flagTex.update(true);
  }
  const flagMat = plain(scene, 'circuitFlags', 0.68, 0.04);
  flagMat.albedoTexture = flagTex;
  flagMat.backFaceCulling = false;
  flagMat.twoSidedLighting = true;
  const flagPlugin = new ClothFlagShaderPlugin(flagMat);
  const flagGeom = geometry();
  const poleGeom = geometry();
  const addFlag = (x: number, y: number, z: number, tricolore: boolean) => {
    const segX = 8, fw = 2.65, fh = 1.45;
    const v0 = tricolore ? 0.52 : 0.02, v1 = tricolore ? 0.98 : 0.48;
    const b = flagGeom.positions.length / 3;
    for (let i = 0; i <= segX; i++) {
      const u = i / segX;
      vertex(flagGeom, [x + u * fw, y, z], [u, v0]);
      vertex(flagGeom, [x + u * fw, y + fh, z], [u, v1]);
    }
    for (let i = 0; i < segX; i++) quad(flagGeom, b + i * 2, b + i * 2 + 2, b + i * 2 + 3, b + i * 2 + 1);
    // Visible structural steel flagpole mast seated deep into the roofline
    const pb = poleGeom.positions.length / 3;
    const r = 0.095;
    for (const [dx, dz] of [[-r, 0], [r, 0], [0, -r], [0, r]]) {
      vertex(poleGeom, [x + dx, y - 3.6, z + dz], [0, 0]);
      vertex(poleGeom, [x + dx, y + fh + 0.18, z + dz], [0, 1]);
    }
    quad(poleGeom, pb, pb + 2, pb + 3, pb + 1);
    quad(poleGeom, pb + 4, pb + 6, pb + 7, pb + 5);
  };
  for (let k = 0; k < 8; k++) addFlag(-18.2, 10.65, -30 + k * 25.5, k % 2 === 0);
  for (let k = 0; k < 6; k++) addFlag(23.2, 8.25, -24 + k * 36, k % 2 === 1);
  addFlag(22.2, 14.55, 224, true);
  publish(scene, 'venue.circuitFlags', flagGeom, flagMat, false);
  publish(scene, 'venue.flagPoles', poleGeom, mats.wall, false);
  // Real photogrammetry concrete Jersey barriers protecting paddock service entries at pit entry & exit
  for (let k = 0; k < 5; k++) {
    const pe = c.at(c.length - PIT_WALL_START_BACK - 18 + k * 2.6, PIT_WALL_D + 13.5);
    props.placeProp('jersey_barrier', [pe.x, pe.y, pe.z], pe.yaw + Math.PI * 0.5, [1.1, 1.05, 1.1]);
    const px = c.at(PIT_WALL_END_S + 14 + k * 2.6, PIT_WALL_D + 11.2);
    props.placeProp('jersey_barrier', [px.x, px.y, px.z], px.yaw + Math.PI * 0.5, [1.1, 1.05, 1.1]);
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
  const floodLamps = geometry();
  for (let i = 0; i < 26; i++) {
    const s = i < 7 ? -42 + i * 48 : 350 + (i - 7) * 205,
      side = i % 2 ? -1 : 1,
      p = c.at(s),
      off = side * (s < 310 ? (side > 0 ? 39 : 36) : wallOffset(p, side, c.length) + 4.5);
    const v = point(p, off),
      y = Math.max(v[1], floor(v[0], v[2]));
    const yaw = p.yaw + (side < 0 ? Math.PI : 0);
    kit.placeKit('FloodlightTower', [v[0], y, v[2]], yaw);
    // Add glowing LED lens bank facing the circuit at the 15.05m masthead
    const sn = Math.sin(yaw),
      cs = Math.cos(yaw);
    const b = floodLamps.positions.length / 3;
    const lx = -0.52;
    const hw = 1.72,
      hh = 0.28;
    for (const [lz, ly] of [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]) {
      vertex(
        floodLamps,
        [v[0] + lx * cs + lz * sn, y + 15.05 + ly, v[2] - lx * sn + lz * cs],
        [0.5, 0.5],
      );
    }
    quad(floodLamps, b, b + 1, b + 2, b + 3);
  }
  const floodLampMat = new StandardMaterial('venue.floodlightLamps', scene);
  floodLampMat.disableLighting = true;
  floodLampMat.diffuseColor = Color3.Black();
  floodLampMat.specularColor = Color3.Black();
  floodLampMat.emissiveColor = new Color3(0.14, 0.16, 0.19);
  floodLampMat.backFaceCulling = false;
  publish(scene, 'venue.floodlightLamps', floodLamps, floodLampMat, false).receiveShadows = false;

  // Trackside Corner Grandstands (Blender space-frame bays)
  for (const s of [734, 1668, 2488, 2900, 3970]) {
    const p = c.at(s),
      side = trapSide(s) || -1,
      edge = wallOffset(p, side, c.length) + 6;
    const v = point(p, side * edge, 0);
    kit.placeKit('GrandstandBay', v, p.yaw + (side > 0 ? Math.PI : 0), [0.85, 0.85, 0.85]);
  }

  // Curated Multi-Species Mediterranean Botanical Forest (Photorealistic Cypress, Pine, Oak, Olive)
  // + 7 Real Poly Haven Photogrammetry Biome Models (Limestone Cliffs, Boulders, Scrub, Ferns, Grass)!
  const speciesPool: Species[] = ['Cypress', 'Pine', 'Oak', 'Olive'];
  const groundY = (x: number, z: number, refY: number) => Math.max(floor(x, z), Math.min(refY, floor(x, z) + 0.6));

  // Helper: dress near-track tree bases with natural undergrowth skirts so zero trunks look bare
  function dressTreeBase(x: number, y: number, z: number, seedIdx: number) {
    const skirtCount = 2 + (seedIdx % 2);
    for (let k = 0; k < skirtCount; k++) {
      const a = seedIdx * 2.1 + k * 2.3 + rnd() * 0.6;
      const r = 1.2 + rnd() * 2.1;
      const bx = x + Math.cos(a) * r;
      const bz = z + Math.sin(a) * r;
      const by = floor(bx, bz) - 0.05;
      const pick = (seedIdx + k) % 4;
      if (pick === 0) forest.plantBiome('med_bush', [bx, by, bz], [1.1 + rnd() * 0.8, 1.0 + rnd() * 0.7, 1.1 + rnd() * 0.8], rnd() * 6.28, seedIdx + k);
      else if (pick === 1) forest.plantBiome('fern', [bx, by, bz], [1.2 + rnd() * 0.9, 1.1 + rnd() * 0.8, 1.2 + rnd() * 0.9], rnd() * 6.28, seedIdx + k);
      else if (pick === 2) forest.plantBiome('grass_clump', [bx, by, bz], [1.3 + rnd() * 1.1, 1.2 + rnd() * 0.9, 1.3 + rnd() * 1.1], rnd() * 6.28, seedIdx + k);
      else forest.plantBiome('boulder', [bx, by - 0.12, bz], [0.7 + rnd() * 0.9, 0.6 + rnd() * 0.6, 0.7 + rnd() * 0.9], rnd() * 6.28, seedIdx + k);
    }
  }

  // 1. Iconic Tuscan Cypress Avenues framing Turn 1 approach, Esses hillside & Villa ridges
  for (const [sStart, sEnd, step, side, offset] of [
    [320, 620, 16, -1, 15.5],
    [340, 600, 20, 1, 18.0],
    [1220, 1560, 18, -1, 16.0],
    [2140, 2400, 17, 1, 16.5],
    [3420, 3820, 19, -1, 17.5],
  ] as const) {
    for (let s = sStart; s <= sEnd; s += step) {
      const p = c.at(s);
      const d = side * (wallOffset(p, side, c.length) + offset + (rnd() - 0.5) * 3.5);
      const v = point(p, d);
      const near = c.nearest(v[0], v[2]),
        np = c.at(near.s);
      if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 8.5) continue;
      const y = groundY(v[0], v[2], v[1]) - 0.12;
      const h = 0.88 + rnd() * 0.34,
        w = 0.86 + rnd() * 0.24;
      forest.plantTree('Cypress', [v[0], y, v[2]], [w, h, w], rnd() * 6.28, Math.floor(s) % 5, false, true);
      if (rnd() < 0.7) dressTreeBase(v[0], y, v[2], Math.floor(s));
    }
  }

  // 2. Sculpted Apennine Limestone Cliff Outcrops along dramatic hillside cuts (Turn 1, Esses, Hairpin)
  for (const [sStart, sEnd, step, side, extra] of [
    [600, 880, 26, -1, 11.5],
    [1420, 1780, 28, 1, 12.5],
    [2420, 2760, 28, -1, 12.0],
    [2920, 3240, 32, 1, 14.0],
  ] as const) {
    for (let s = sStart; s <= sEnd; s += step) {
      const p = c.at(s);
      const d = side * (wallOffset(p, side, c.length) + extra + rnd() * 8);
      const v = point(p, d);
      const near = c.nearest(v[0], v[2]),
        np = c.at(near.s);
      if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 7.5) continue;
      const y = floor(v[0], v[2]) - 0.55;
      const sx = 2.6 + rnd() * 2.2,
        sy = 2.0 + rnd() * 1.9,
        sz = 2.4 + rnd() * 2.1;
      forest.plantBiome('cliff_rock', [v[0], y, v[2]], [sx, sy, sz], p.yaw + (side > 0 ? Math.PI : 0) + (rnd() - 0.5) * 0.6, Math.floor(s), true);
      // Tuck scrub bushes & mossy rocks along cliff base
      forest.plantBiome('med_bush', [v[0] - side * 2.2, y + 0.45, v[2] + 1.5], [1.5, 1.3, 1.5], rnd() * 6.28, Math.floor(s));
    }
  }

  // 2b. Hero Poly Haven Photogrammetry 3D Coastal Trees (island_tree_02) + Twisted Mediterranean Scrub (searsia_lucida)
  // + Mossy Woodland Stumps at iconic trackside landmarks!
  for (const [s, side, distOut, sc] of [
    [590, -1, 14.5, 1.45],
    [715, 1, 16.0, 1.35],
    [1360, -1, 15.0, 1.5],
    [1685, 1, 14.5, 1.4],
    [2435, -1, 15.5, 1.45],
    [2890, 1, 15.0, 1.35],
    [3560, -1, 16.0, 1.5],
    [3960, -1, 14.5, 1.4],
  ] as const) {
    const p = c.at(s);
    const v = point(p, side * (wallOffset(p, side, c.length) + distOut));
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 8.5) continue;
    const y = floor(v[0], v[2]) - 0.25;
    forest.plantBiome('coastal_tree', [v[0], y, v[2]], [sc, sc, sc], rnd() * 6.28, 0, true);
    forest.plantBiome('scrub_tree', [v[0] + 3.2, floor(v[0] + 3.2, v[2] - 2.1) - 0.1, v[2] - 2.1], [1.4, 1.35, 1.4], rnd() * 6.28, 0, false);
    forest.plantBiome('stump', [v[0] - 2.6, floor(v[0] - 2.6, v[2] + 1.8) - 0.08, v[2] + 1.8], [1.1, 1.1, 1.1], rnd() * 6.28, 0, false);
  }
  for (let i = 0; i < 65; i++) {
    const s = rnd() * c.length,
      p = c.at(s),
      side = rnd() < 0.5 ? -1 : 1,
      v = point(p, side * (wallOffset(p, side, c.length) + 7.5 + rnd() * 28));
    if (v[0] > -44 && v[0] < 54 && v[2] > -100 && v[2] < 275) continue;
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 5.5) continue;
    const y = floor(v[0], v[2]) - 0.12;
    const sc = 1.1 + rnd() * 0.9;
    forest.plantBiome('scrub_tree', [v[0], y, v[2]], [sc, sc * 0.95, sc], rnd() * 6.28, i, false);
    if (i % 3 === 0) forest.plantBiome('stump', [v[0] + 1.8, y, v[2] - 1.4], [0.95 + rnd() * 0.5, 0.95, 0.95 + rnd() * 0.5], rnd() * 6.28, i, false);
  }

  // 3. Natural Multi-Species Mediterranean Woodland Groves around the circuit
  for (let i = 0; i < 980; i++) {
    const s = rnd() * c.length,
      p = c.at(s),
      side = rnd() < 0.5 ? -1 : 1,
      distOut = 10.5 + Math.pow(rnd(), 1.15) * 112,
      d = side * (wallOffset(p, side, c.length) + distOut),
      v = point(p, d);
    if (v[0] > -40 && v[0] < 48 && v[2] > -108 && v[2] < 278) continue;
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 8.5) continue;
    const rChoice = rnd();
    const sp: Species = rChoice < 0.30 ? 'Cypress' : rChoice < 0.62 ? 'Pine' : rChoice < 0.84 ? 'Oak' : 'Olive';
    const h = 0.80 + rnd() * 0.58,
      w = 0.82 + rnd() * 0.48;
    const y = floor(v[0], v[2]) - 0.18;
    const casts = distOut < 28;
    forest.plantTree(sp, [v[0], y, v[2]], [w, h, w * (0.88 + rnd() * 0.24)], rnd() * 6.28, i % 5, false, casts);
    if (casts && i % 2 === 0) dressTreeBase(v[0], y, v[2], i);
  }
  // Lush hillside groves framing the main straight & Turn 1 Apennine skyline!
  for (let i = 0; i < 220; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side < 0 ? -44 - rnd() * 145 : 48 + rnd() * 145;
    const z = -90 + rnd() * 820;
    const near = c.nearest(x, z),
      np = c.at(near.s);
    if (Math.hypot(np.x - x, np.z - z) < wallOffset(np, Math.sign(near.d), c.length) + 9.5) continue;
    const sp: Species = i % 3 === 0 ? 'Cypress' : i % 3 === 1 ? 'Pine' : 'Oak';
    const h = 0.88 + rnd() * 0.62,
      w = 0.86 + rnd() * 0.48;
    const y = floor(x, z) - 0.18;
    const casts = Math.abs(x) < 76;
    forest.plantTree(sp, [x, y, z], [w, h, w], rnd() * 6.28, i % 5, false, casts);
  }
  // Distant ridge forest (LOD1 silhouettes, zero shadow cost)
  for (let i = 0; i < 360; i++) {
    const x = -470 + rnd() * 2240,
      z = i % 2 ? -630 - rnd() * 210 : 820 + rnd() * 230,
      h = 0.85 + rnd() * 0.72,
      w = 0.78 + rnd() * 0.58;
    forest.plantTree(speciesPool[i % 4], [x, floor(x, z) - 0.18, z], [w, h, w], rnd() * 6.28, i % 5, true, false);
  }

  // 4. Layered Poly Haven Photogrammetry Undergrowth, Boulders, Ferns & Scrub along track banks!
  for (let i = 0; i < 480; i++) {
    const s = rnd() * c.length,
      p = c.at(s),
      side = rnd() < 0.5 ? -1 : 1,
      wallD = wallOffset(p, side, c.length),
      d = side * (wallD + 2.4 + rnd() * 26),
      v = point(p, d);
    if (v[0] > -44 && v[0] < 54 && v[2] > -100 && v[2] < 275) continue;
    const near = c.nearest(v[0], v[2]),
      np = c.at(near.s);
    if (Math.hypot(np.x - v[0], np.z - v[2]) < wallOffset(np, Math.sign(near.d), c.length) + 2.0) continue;
    const y = Math.min(v[1], floor(v[0], v[2])) + 0.02;
    const roll = rnd();
    if (roll < 0.18) {
      const sc = 0.85 + rnd() * 1.35;
      forest.plantBiome('rock_moss', [v[0], y - 0.14, v[2]], [sc, sc * (0.75 + rnd() * 0.4), sc], rnd() * 6.28, i);
    } else if (roll < 0.34) {
      const sc = 0.75 + rnd() * 1.15;
      forest.plantBiome('boulder', [v[0], y - 0.14, v[2]], [sc, sc * 0.82, sc], rnd() * 6.28, i);
    } else if (roll < 0.54) {
      const sc = 1.15 + rnd() * 1.25;
      forest.plantBiome('med_bush', [v[0], y, v[2]], [sc, sc * 0.92, sc], rnd() * 6.28, i);
    } else if (roll < 0.72) {
      const sc = 1.2 + rnd() * 1.1;
      forest.plantBiome('shrub', [v[0], y, v[2]], [sc, sc, sc], rnd() * 6.28, i);
    } else if (roll < 0.86) {
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
  props.finishProps();
  forest.finish();

  let last = -1;
  return {
    setLights(n: number) {
      n = Math.max(0, Math.min(5, Math.floor(n)));
      if (n === last) return;
      for (let j = 0; j < 5; j++) lights[j].material = j < n ? liveLight : darkLight;
      last = n;
    },
    setWeather(w: Weather) {
      // Digital FIA marshal flag panels switch to wet/slippery amber in Heavy Rain
      if (w === 'rain') flagLedMat.emissiveColor.set(1.65, 0.92, 0.06);
      else if (w === 'damp') flagLedMat.emissiveColor.set(0.75, 1.25, 0.14);
      else flagLedMat.emissiveColor.set(0.08, 1.45, 0.28);
      // Stadium floodlight LED arrays, pit garage halogen bays & Race Control glass glow in low light
      if (w === 'dusk') {
        floodLampMat.emissiveColor.set(3.8, 3.55, 3.1);
        pitGlowMat.emissiveColor.set(2.4, 1.85, 1.15);
        glassMat.emissiveColor.set(0.42, 0.34, 0.22);
      } else if (w === 'rain') {
        floodLampMat.emissiveColor.set(2.9, 3.15, 3.5);
        pitGlowMat.emissiveColor.set(1.9, 1.65, 1.25);
        glassMat.emissiveColor.set(0.28, 0.30, 0.34);
      } else if (w === 'damp') {
        floodLampMat.emissiveColor.set(1.35, 1.45, 1.6);
        pitGlowMat.emissiveColor.set(0.85, 0.72, 0.52);
        glassMat.emissiveColor.set(0.12, 0.14, 0.16);
      } else {
        floodLampMat.emissiveColor.set(0.06, 0.07, 0.08);
        pitGlowMat.emissiveColor.set(0.16, 0.13, 0.08);
        glassMat.emissiveColor.set(0, 0, 0);
      }
      flagPlugin.amplitude = w === 'rain' ? 0.36 : w === 'damp' ? 0.26 : w === 'dusk' ? 0.20 : 0.18;
      flagPlugin.speed = w === 'rain' ? 9.2 : w === 'damp' ? 6.8 : w === 'dusk' ? 5.2 : 4.8;
      forest.setWeather(w);
    },
    update(dt: number) {
      flagPlugin.time += Math.max(0, Math.min(0.1, dt));
      forest.update(dt);
    },
  };
}

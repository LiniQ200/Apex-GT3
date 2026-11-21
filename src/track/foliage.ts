import type { Scene } from '@babylonjs/core/scene';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Weather } from '../types';
import type { Vec } from './road';
import { FoliageAtmosphericPlugin } from './foliageShader';

export type Species = 'Cypress' | 'Pine' | 'Oak' | 'Olive';
export type BiomeProp =
  | 'rock_moss'
  | 'fern'
  | 'shrub'
  | 'grass_clump'
  | 'cliff_rock'
  | 'boulder'
  | 'med_bush'
  | 'coastal_tree'
  | 'scrub_tree'
  | 'stump';

interface LoadedTemplate {
  vd: VertexData;
  material: PBRMaterial | null;
}

const assetUrl = (rel: string) =>
  new URL(`${import.meta.env.BASE_URL}assets/${rel}`, window.location.href).href;

/** Bake Babylon's glTF __root__ RH->LH mirror & node transform into reusable VertexData.
 * Returning VertexData (not a shared Geometry) ensures each thin-instanced spatial cell
 * owns its own matrix/color instance buffers on WebGPU and WebGL2. */
export function bakeGltfVertexData(m: Mesh): VertexData {
  m.computeWorldMatrix(true);
  // Babylon's glTF __root__ applies (-X, Y, Z) with det=-1; adding RotationY(PI)
  // yields (+X, Y, -Z) with det=-1: outward CW winding AND preserved Blender +X orientation!
  const wm = m.getWorldMatrix().multiply(Matrix.RotationY(Math.PI));
  const nm = Matrix.Transpose(Matrix.Invert(wm));
  const rawPos = m.getVerticesData('position')!;
  const rawNor = m.getVerticesData('normal');
  const rawUv = m.getVerticesData('uv');
  const rawCol = m.getVerticesData('color');
  const rawIdx = m.getIndices()!;

  const pos = new Float32Array(rawPos.length);
  const nor = rawNor ? new Float32Array(rawNor.length) : undefined;
  const v = new Vector3();
  for (let i = 0; i < rawPos.length; i += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(rawPos[i], rawPos[i + 1], rawPos[i + 2], wm, v);
    pos[i] = v.x;
    pos[i + 1] = v.y;
    pos[i + 2] = v.z;
    if (nor && rawNor) {
      Vector3.TransformNormalFromFloatsToRef(rawNor[i], rawNor[i + 1], rawNor[i + 2], nm, v);
      v.normalize();
      nor[i] = v.x;
      nor[i + 1] = v.y;
      nor[i + 2] = v.z;
    }
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = rawIdx instanceof Uint32Array ? new Uint32Array(rawIdx) : new Uint16Array(rawIdx);
  if (nor) vd.normals = nor;
  else {
    const computed: number[] = [];
    VertexData.ComputeNormals(pos, vd.indices, computed);
    vd.normals = new Float32Array(computed);
  }
  if (rawUv) vd.uvs = new Float32Array(rawUv);
  if (rawCol) vd.colors = new Float32Array(rawCol);
  return vd;
}

/**
 * Load the upgraded 2-material Mediterranean 4-species botanical kit (separate scanned PBR
 * bark + 2048x2048 photorealistic botanical canopy with normal map, GPU wind sway & backlit SSS)
 * plus 7 genuine Poly Haven CC0 photogrammetry biome GLBs (limestone cliffs, boulders,
 * mossy rocks, Mediterranean scrub bushes, ferns, shrubs, and grass clumps).
 */
export async function createBotanicalForest(scene: Scene) {
  const plugins: FoliageAtmosphericPlugin[] = [];

  // 1. Real Poly Haven scanned PBR bark material for all tree trunks & branches
  const barkAlbedo = new Texture(assetUrl('bark/albedo.jpg'), scene, {
    noMipmap: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: true,
    useSRGBBuffer: true,
  });
  barkAlbedo.anisotropicFilteringLevel = 16;
  const barkNormal = new Texture(assetUrl('bark/normal.jpg'), scene, {
    noMipmap: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: false,
    useSRGBBuffer: false,
  });
  barkNormal.anisotropicFilteringLevel = 16;
  const barkOrm = new Texture(assetUrl('bark/orm.jpg'), scene, {
    noMipmap: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: false,
    useSRGBBuffer: false,
  });
  barkOrm.anisotropicFilteringLevel = 8;

  const barkMat = new PBRMaterial('venue.Mediterranean bark', scene);
  barkMat.albedoTexture = barkAlbedo;
  barkMat.albedoColor = new Color3(0.86, 0.80, 0.72);
  barkMat.bumpTexture = barkNormal;
  barkMat.bumpTexture.level = 0.85;
  barkMat.metallicTexture = barkOrm;
  barkMat.useAmbientOcclusionFromMetallicTextureRed = true;
  barkMat.useRoughnessFromMetallicTextureAlpha = false;
  barkMat.useRoughnessFromMetallicTextureGreen = true;
  barkMat.useMetallnessFromMetallicTextureBlue = true;
  barkMat.ambientTextureStrength = 0.72;
  barkMat.roughness = 1.0;
  barkMat.maxSimultaneousLights = 2;
  // Subtle trunk sway synced to canopy height
  const barkWind = new FoliageAtmosphericPlugin(barkMat, { wind: true, invHeight: 0.065, sssIntensity: 0.0 });
  plugins.push(barkWind);

  // 2. Photorealistic 2048x2048 Mediterranean botanical canopy material with normal map + GPU wind + backlit SSS
  const atlas = new Texture(assetUrl('foliage/mediterranean-atlas.webp'), scene, {
    noMipmap: false,
    invertY: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: true,
    useSRGBBuffer: true,
  });
  atlas.hasAlpha = true;
  atlas.wrapU = atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
  atlas.anisotropicFilteringLevel = 16;

  const canopyNormal = new Texture(assetUrl('foliage/mediterranean-normal.webp'), scene, {
    noMipmap: false,
    invertY: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: false,
    useSRGBBuffer: false,
  });
  canopyNormal.wrapU = canopyNormal.wrapV = Texture.CLAMP_ADDRESSMODE;
  canopyNormal.anisotropicFilteringLevel = 16;

  const canopyMat = new PBRMaterial('venue.Mediterranean canopy', scene);
  canopyMat.albedoTexture = atlas;
  canopyMat.bumpTexture = canopyNormal;
  canopyMat.bumpTexture.level = 0.62;
  canopyMat.metallic = 0;
  canopyMat.metallicF0Factor = 0.22;
  canopyMat.roughness = 0.86;
  canopyMat.maxSimultaneousLights = 2;
  canopyMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  canopyMat.alphaCutOff = 0.42;
  canopyMat.backFaceCulling = false;
  canopyMat.twoSidedLighting = true;
  const canopyPlugin = new FoliageAtmosphericPlugin(canopyMat, { wind: true, invHeight: 0.072, sssIntensity: 0.72 });
  plugins.push(canopyPlugin);

  // Load upgraded branching botanical kit (Bark + Canopy LOD0/LOD1 for Cypress, Pine, Oak, Olive)
  const treeGeoms = new Map<string, VertexData>();
  const botRes = await fetch(assetUrl('kit/botanical.glb'));
  if (!botRes.ok) throw Error(`Failed to load kit/botanical.glb: HTTP ${botRes.status}`);
  const botContainer = await LoadAssetContainerAsync(new Uint8Array(await botRes.arrayBuffer()), scene, {
    name: 'botanical.glb',
    pluginExtension: '.glb',
    pluginOptions: { gltf: { skipMaterials: true, createInstances: false } },
  });
  for (const m of botContainer.meshes) {
    if (m instanceof Mesh && m.geometry) {
      const cleanName = m.name.replace(/_primitive\d+$/, '');
      treeGeoms.set(cleanName, bakeGltfVertexData(m));
    }
  }
  botContainer.dispose();

  // Load all 10 genuine Poly Haven CC0 photogrammetry biome GLBs (keep their scanned PBR materials!)
  const biomeTemplates = new Map<BiomeProp, LoadedTemplate[]>();
  const biomeNames: BiomeProp[] = [
    'rock_moss',
    'fern',
    'shrub',
    'grass_clump',
    'cliff_rock',
    'boulder',
    'med_bush',
    'coastal_tree',
    'scrub_tree',
    'stump',
  ];
  const staticSolidProps = new Set<BiomeProp>(['rock_moss', 'cliff_rock', 'boulder', 'stump']);
  await Promise.all(
    biomeNames.map(async (prop) => {
      const res = await fetch(assetUrl(`biome/${prop}.glb`));
      if (!res.ok) throw Error(`Failed to load biome/${prop}.glb: HTTP ${res.status}`);
      const container = await LoadAssetContainerAsync(new Uint8Array(await res.arrayBuffer()), scene, {
        name: `${prop}.glb`,
        pluginExtension: '.glb',
        pluginOptions: { gltf: { createInstances: false } },
      });
      const list: LoadedTemplate[] = [];
      for (const m of container.meshes) {
        if (!(m instanceof Mesh) || !m.geometry) continue;
        const vd = bakeGltfVertexData(m);
        let mat: PBRMaterial | null = null;
        if (m.material instanceof PBRMaterial) {
          mat = m.material.clone(`venue.biome.${prop}.${list.length}`);
          mat.maxSimultaneousLights = 2;
          for (const t of mat.getActiveTextures()) {
            if (t instanceof Texture) {
              t.anisotropicFilteringLevel = 8;
              t.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
            }
          }
          if (!staticSolidProps.has(prop)) {
            mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
            mat.alphaCutOff = 0.42;
            mat.backFaceCulling = false;
            mat.twoSidedLighting = true;
            mat.roughness = Math.max(0.80, mat.roughness ?? 0.88);
            const invH = prop === 'coastal_tree' ? 0.14 : prop === 'scrub_tree' ? 0.32 : 0.72;
            const p = new FoliageAtmosphericPlugin(mat, { wind: true, invHeight: invH, sssIntensity: 0.48 });
            plugins.push(p);
          } else {
            mat.roughness = Math.max(0.84, mat.roughness ?? 0.9);
          }
          scene.addMaterial(mat);
        }
        list.push({ vd, material: mat });
      }
      biomeTemplates.set(prop, prop === 'coastal_tree' || prop === 'scrub_tree' ? list : list.slice(0, 3));
      container.dispose();
    }),
  );

  // Spatial-hashed thin-instance accumulators for trees
  type TreeCell = { species: Species; ridge: boolean; casts: boolean; matrices: number[]; colors: number[] };
  const treeCells = new Map<string, TreeCell>();
  const tints = ['#faf7ed', '#fffce8', '#e5f0e4', '#ece5cc', '#dfe9d8'].map((c) =>
    Color3.FromHexString(c).toLinearSpace(),
  );
  const trackCell = 320;

  function plantTree(
    species: Species,
    pos: Vec,
    scale: Vec,
    yaw: number,
    tint: number,
    ridge = false,
    castsShadow = false,
  ) {
    const x = Math.floor((pos[0] + 160) / (ridge ? 520 : trackCell));
    const z = ridge ? Math.sign(pos[2]) : Math.floor((pos[2] + 100) / trackCell);
    const key = `venue.${ridge ? 'ridge.' : castsShadow ? 'near.' : ''}${species}@${x}:${z}`;
    let cell = treeCells.get(key);
    if (!cell) {
      cell = { species, ridge, casts: castsShadow && !ridge, matrices: [], colors: [] };
      treeCells.set(key, cell);
    }
    const m = Matrix.Compose(
      Vector3.FromArray(scale),
      Quaternion.RotationAxis(Vector3.UpReadOnly, yaw),
      Vector3.FromArray(pos),
    );
    const { r, g, b } = tints[tint % tints.length];
    cell.matrices.push(...m.m);
    cell.colors.push(r, g, b, 1);
  }

  // Spatial-hashed thin-instance accumulators for Poly Haven photogrammetry biome props
  type PropCell = { prop: BiomeProp; variant: number; casts: boolean; matrices: number[] };
  const propCells = new Map<string, PropCell>();

  function plantBiome(prop: BiomeProp, pos: Vec, scale: Vec, yaw: number, variant = 0, casts = false) {
    const templates = biomeTemplates.get(prop);
    if (!templates?.length) return;
    // Multi-part scanned trees (coastal_tree, scrub_tree) must emit ALL sub-primitives together
    const multiPart = prop === 'coastal_tree' || prop === 'scrub_tree';
    const indices = multiPart ? templates.map((_, idx) => idx) : [Math.abs(variant) % templates.length];
    const x = Math.floor((pos[0] + 160) / 420);
    const z = Math.floor((pos[2] + 100) / 420);
    const m = Matrix.Compose(
      Vector3.FromArray(scale),
      Quaternion.RotationAxis(Vector3.UpReadOnly, yaw),
      Vector3.FromArray(pos),
    );
    for (const vIdx of indices) {
      const key = `venue.biome.${prop}.${vIdx}@${x}:${z}`;
      let cell = propCells.get(key);
      if (!cell) {
        cell = { prop, variant: vIdx, casts, matrices: [] };
        propCells.set(key, cell);
      }
      cell.matrices.push(...m.m);
    }
  }

  function finish() {
    for (const [name, cell] of treeCells) {
      const transforms = Float32Array.from(cell.matrices),
        colors = Float32Array.from(cell.colors);
      const makeBatch = (geomKey: string, label: string, mat: PBRMaterial, casts: boolean, useColors: boolean) => {
        const g = treeGeoms.get(geomKey);
        if (!g) return null;
        const mesh = new Mesh(label, scene);
        g.applyToMesh(mesh);
        mesh.material = mat;
        mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.thinInstanceSetBuffer('matrix', transforms, 16, true);
        if (useColors) mesh.thinInstanceSetBuffer('color', colors, 4, true);
        mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts, nearTreeShadow: casts };
        mesh.freezeWorldMatrix();
        return mesh;
      };

      for (const part of ['Bark', 'Canopy'] as const) {
        const mat = part === 'Bark' ? barkMat : canopyMat;
        const useCol = part === 'Canopy';
        // Near-track trees cast crisp sun shadows onto grass, kerbs, and track edges!
        const casts = cell.casts;
        if (cell.ridge) {
          makeBatch(`${cell.species}_${part}_LOD1`, `${name}.${part}`, mat, false, useCol);
        } else {
          const near = makeBatch(`${cell.species}_${part}_LOD0`, `${name}.${part}`, mat, casts, useCol);
          const far = makeBatch(`${cell.species}_${part}_LOD1`, `${name}.${part}.lod1`, mat, false, useCol);
          if (near && far) {
            const radius = near.getBoundingInfo().boundingSphere.radiusWorld;
            near.addLODLevel(radius + 95, far);
            far.setEnabled(false);
          }
        }
      }
    }

    for (const [name, cell] of propCells) {
      const tpl = biomeTemplates.get(cell.prop)?.[cell.variant];
      if (!tpl) continue;
      const mesh = new Mesh(name, scene);
      tpl.vd.applyToMesh(mesh);
      if (tpl.material) mesh.material = tpl.material;
      mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.thinInstanceSetBuffer('matrix', Float32Array.from(cell.matrices), 16, true);
      mesh.metadata = { trackShadowCaster: cell.casts, shadowCaster: cell.casts, nearTreeShadow: cell.casts };
      mesh.freezeWorldMatrix();
    }
  }

  let clock = 0;
  function setWeather(w: Weather) {
    const wind = w === 'rain' ? 0.42 : w === 'damp' ? 0.28 : w === 'dusk' ? 0.17 : w === 'golden' ? 0.16 : 0.13;
    const wet = w === 'rain' ? 0.92 : w === 'damp' ? 0.48 : 0.0;
    const sss = w === 'golden' ? 0.85 : w === 'dusk' ? 0.72 : w === 'clear' ? 0.65 : w === 'damp' ? 0.10 : 0.04;
    const col: [number, number, number] =
      w === 'dusk'
        ? [1.05, 0.50, 0.22]
        : w === 'golden'
          ? [1.0, 0.76, 0.28]
          : w === 'clear'
            ? [0.76, 0.96, 0.36]
            : [0.52, 0.68, 0.48];
    const sunDir = scene.metadata?.sunDir as Vector3 | undefined;
    for (const p of plugins) {
      p.windStrength = wind;
      p.wetness = wet;
      if (sunDir) p.sunDir = [sunDir.x, sunDir.y, sunDir.z];
      if (p !== barkWind) {
        p.sssIntensity = sss;
        p.sssColor = col;
      }
    }
  }

  function update(dt: number) {
    clock += Math.max(0, Math.min(0.1, dt));
    const sunDir = scene.metadata?.sunDir as Vector3 | undefined;
    for (const p of plugins) {
      p.time = clock;
      if (sunDir) p.sunDir = [sunDir.x, sunDir.y, sunDir.z];
    }
  }

  setWeather('golden');
  return { plantTree, plantBiome, finish, setWeather, update };
}

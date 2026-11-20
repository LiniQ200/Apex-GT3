import type { Scene } from '@babylonjs/core/scene';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Vec } from './road';

export type Species = 'Cypress' | 'Pine' | 'Oak' | 'Olive';
export type BiomeProp = 'rock_moss' | 'fern' | 'shrub' | 'grass_clump';

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
 * Load the Blender 4.3 Mediterranean 4-species botanical kit (LOD0 + LOD1)
 * and the 4 genuine Poly Haven photogrammetry biome GLBs (mossy rocks, ferns,
 * shrubs, grass clumps). Every instance is static (zero wind-sway overhead),
 * rendered with crisp ALPHATEST, 16x anisotropy, scanned bark normals, and
 * spatial-hashed ThinInstance buffers with frozen world matrices.
 */
export async function createBotanicalForest(scene: Scene) {
  // 1. Shared Mediterranean 4-species foliage + bark PBR material
  // invertY: false matches glTF TEXCOORD_0 origin (V=0 at top of atlas)
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

  const barkNormal = new Texture(assetUrl('bark/normal.jpg'), scene, {
    noMipmap: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: false,
    useSRGBBuffer: false,
  });
  barkNormal.anisotropicFilteringLevel = 16;

  const treeMat = new PBRMaterial('venue.Mediterranean forest', scene);
  treeMat.albedoTexture = atlas;
  treeMat.bumpTexture = barkNormal;
  treeMat.bumpTexture.level = 0.28;
  treeMat.metallic = 0;
  treeMat.metallicF0Factor = 0.25;
  treeMat.roughness = 0.92;
  treeMat.maxSimultaneousLights = 2;
  treeMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  treeMat.alphaCutOff = 0.42;
  treeMat.backFaceCulling = false;
  treeMat.twoSidedLighting = false;
  // Warm subtle leaf bounce without expensive multi-pass subsurface scattering
  treeMat.emissiveColor = new Color3(0.035, 0.052, 0.02);

  // Load Blender 4.3 botanical kit (Cypress, Pine, Oak, Olive LOD0/LOD1)
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

  // Load 4 genuine Poly Haven photogrammetry biome GLBs (keep their scanned PBR materials!)
  const biomeTemplates = new Map<BiomeProp, LoadedTemplate[]>();
  const biomeNames: BiomeProp[] = ['rock_moss', 'fern', 'shrub', 'grass_clump'];
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
          // Upgrade every texture on the photogrammetry model to 16x anisotropic trilinear + crisp ALPHATEST
          for (const t of mat.getActiveTextures()) {
            if (t instanceof Texture) {
              t.anisotropicFilteringLevel = 16;
              t.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
            }
          }
          if (prop !== 'rock_moss') {
            mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
            mat.alphaCutOff = 0.42;
            mat.backFaceCulling = false;
            mat.twoSidedLighting = false;
            mat.roughness = Math.max(0.82, mat.roughness ?? 0.9);
          } else {
            mat.roughness = Math.max(0.84, mat.roughness ?? 0.9);
          }
          scene.addMaterial(mat);
        }
        list.push({ vd, material: mat });
      }
      biomeTemplates.set(prop, list.slice(0, 2));
      container.dispose();
    }),
  );

  // Spatial-hashed thin-instance accumulators for trees
  type TreeCell = { species: Species; ridge: boolean; matrices: number[]; colors: number[] };
  const treeCells = new Map<string, TreeCell>();
  const tints = ['#f7f4e9', '#fffbe8', '#e5efe7', '#ebe4cb'].map((c) =>
    Color3.FromHexString(c).toLinearSpace(),
  );
  const trackCell = 210;

  function plantTree(species: Species, pos: Vec, scale: Vec, yaw: number, tint: number, ridge = false) {
    const x = Math.floor((pos[0] + 160) / (ridge ? 520 : trackCell));
    const z = ridge ? Math.sign(pos[2]) : Math.floor((pos[2] + 100) / trackCell);
    const key = `venue.${ridge ? 'ridge.' : ''}${species}@${x}:${z}`;
    let cell = treeCells.get(key);
    if (!cell) {
      cell = { species, ridge, matrices: [], colors: [] };
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
  type PropCell = { prop: BiomeProp; variant: number; matrices: number[] };
  const propCells = new Map<string, PropCell>();

  function plantBiome(prop: BiomeProp, pos: Vec, scale: Vec, yaw: number, variant = 0) {
    const templates = biomeTemplates.get(prop);
    if (!templates?.length) return;
    const vIdx = Math.abs(variant) % templates.length;
    const x = Math.floor((pos[0] + 160) / 240);
    const z = Math.floor((pos[2] + 100) / 240);
    const key = `venue.biome.${prop}.${vIdx}@${x}:${z}`;
    let cell = propCells.get(key);
    if (!cell) {
      cell = { prop, variant: vIdx, matrices: [] };
      propCells.set(key, cell);
    }
    const m = Matrix.Compose(
      Vector3.FromArray(scale),
      Quaternion.RotationAxis(Vector3.UpReadOnly, yaw),
      Vector3.FromArray(pos),
    );
    cell.matrices.push(...m.m);
  }

  function finish() {
    for (const [name, cell] of treeCells) {
      const transforms = Float32Array.from(cell.matrices),
        colors = Float32Array.from(cell.colors);
      const makeBatch = (geomKey: string, label: string, casts: boolean) => {
        const g = treeGeoms.get(geomKey);
        if (!g) return null;
        const mesh = new Mesh(label, scene);
        g.applyToMesh(mesh);
        mesh.material = treeMat;
        mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.thinInstanceSetBuffer('matrix', transforms, 16, true);
        mesh.thinInstanceSetBuffer('color', colors, 4, true);
        mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
        mesh.freezeWorldMatrix();
        return mesh;
      };
      if (cell.ridge) {
        makeBatch(`${cell.species}_LOD1`, name, false);
      } else {
        const near = makeBatch(`${cell.species}_LOD0`, name, true);
        const far = makeBatch(`${cell.species}_LOD1`, `${name}.lod1`, false);
        if (near && far) {
          const radius = near.getBoundingInfo().boundingSphere.radiusWorld;
          near.addLODLevel(radius + 115, far);
          far.setEnabled(false);
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
      const casts = cell.prop === 'rock_moss';
      mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
      mesh.freezeWorldMatrix();
    }
  }

  return { plantTree, plantBiome, finish };
}

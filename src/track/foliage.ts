import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import shapes from './foliage-shapes.json';
import type { Vec } from './road';

type Species = 'pine' | 'cypress';
type Template = keyof typeof shapes;

// Meshes are authored in metres with the root flare at ground level; Y up.
// This small quantised art library ships in the lazy Drive chunk. Decode each
// template only once, not per planting or per frame. See scripts/bake-foliage.py.
const templates = new Map<Template, VertexData>();
function template(key: Template) {
  const cached = templates.get(key);
  if (cached) return cached;
  const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
  const [packed, triangles] = shapes[key];
  const v = new Int16Array(bytes(packed)), n = v.length / 8, d = new VertexData();
  d.positions = new Float32Array(3 * n);
  d.normals = new Float32Array(3 * n);
  d.uvs = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) {
      d.positions[3 * i + j] = v[8 * i + j] * 0.001;
      d.normals[3 * i + j] = v[8 * i + 3 + j] / 32767;
    }
    d.uvs[2 * i] = v[8 * i + 6] / 32767;
    d.uvs[2 * i + 1] = v[8 * i + 7] / 32767;
  }
  d.indices = new Uint16Array(bytes(triangles));
  templates.set(key, d);
  return d;
}

export function grove(scene: Scene) {
  const atlas = new Texture(`${import.meta.env.BASE_URL}assets/foliage/italian-conifers.webp`, scene, {
    noMipmap: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: true,
    useSRGBBuffer: true,
  });
  atlas.hasAlpha = true;
  atlas.wrapU = atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
  atlas.anisotropicFilteringLevel = 2;
  const mat = new PBRMaterial('venue.Italian conifers', scene);
  mat.albedoTexture = atlas;
  mat.metallic = 0;
  mat.metallicF0Factor = 0.29;
  mat.roughness = 0.97;
  mat.maxSimultaneousLights = 2; // the key and sky; no clustered projector lookup on distant needles
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  mat.alphaCutOff = 0.42;
  mat.backFaceCulling = false;
  // Authored crown normals represent the foliage volume; never flip them with
  // the back of a card. Fragment/alpha-shadow passes use the same cutout.
  mat.twoSidedLighting = false;

  type Cell = { shape: `${Species}${0 | 1}`; ridge: boolean; matrices: number[]; colors: number[] };
  const cells = new Map<string, Cell>();
  const tints = ['#f7f4e9', '#fffae9', '#e4ede6', '#eae5cb'].map(c => Color3.FromHexString(c).toLinearSpace());
  // Tighter cells keep whole stands outside the sun cascades. The two bands
  // on the remote ridges need only camera culling and can share larger cells.
  const trackCell = 208;
  function plant(species: Species, pos: Vec, scale: Vec, yaw: number, tint: number, ridge = false) {
    const x = Math.floor((pos[0] + 160) / (ridge ? 512 : trackCell));
    const z = ridge ? Math.sign(pos[2]) : Math.floor((pos[2] + 100) / trackCell);
    const name = `venue.${ridge ? 'ridge ' : ''}${species}@${x}:${z}`;
    let cell = cells.get(name);
    if (!cell) {
      const variant = (x + z) & 1 ? 1 : 0;
      cell = { shape: `${species}${variant}`, ridge, matrices: [], colors: [] };
      cells.set(name, cell);
    }
    const m = Matrix.Compose(
      Vector3.FromArray(scale), Quaternion.RotationAxis(Vector3.UpReadOnly, yaw), Vector3.FromArray(pos),
    );
    const { r, g, b } = tints[tint];
    cell.matrices.push(...m.m);
    cell.colors.push(r, g, b, 1);
  }
  function finish() {
    for (const [name, cell] of cells) {
      const transforms = Float32Array.from(cell.matrices), colors = Float32Array.from(cell.colors);
      const batch = (key: Template, label: string, casts: boolean) => {
        const mesh = new Mesh(label, scene);
        template(key).applyToMesh(mesh);
        mesh.material = mat;
        // A long verge cell's sphere overhangs the view. Accept visible centres
        // cheaply but check the actual box at the frustum edges.
        mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.thinInstanceSetBuffer('matrix', transforms, 16, true);
        mesh.thinInstanceSetBuffer('color', colors, 4, true);
        mesh.metadata = { trackShadowCaster: casts, shadowCaster: casts };
        mesh.freezeWorldMatrix();
        return mesh;
      };
      // The horizon is outside the race shadow volume and never needs near LOD.
      if (cell.ridge) batch(`${cell.shape}Far`, name, false);
      else {
        const near = batch(cell.shape, name, true);
        const far = batch(`${cell.shape}Far`, `${name}.silhouette`, false);
        // Switch only after the nearest *edge* has cleared the detailed range.
        // The three orthogonal, tightly clipped views include a canopy roof
        // for TV/aerial cameras; no camera-facing updates or blended sorting.
        near.addLODLevel(66 + near.getBoundingInfo().boundingSphere.radiusWorld, far);
      }
    }
  }
  return { plant, finish };
}

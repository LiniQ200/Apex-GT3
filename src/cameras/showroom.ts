import type { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreateLathe } from '@babylonjs/core/Meshes/Builders/latheBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { PointLight } from '@babylonjs/core/Lights/pointLight';

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

// Black satin resin: very fine aggregate, expansion joints and a soft pool of light
// under the inspection rig. The contact patch is baked in reception space so it
// remains soft even when the racing sun's cascade map is far from this building.
const floorPaint: Painter = (c, w, h) => {
  let seed = 32616816;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
  const image = c.createImageData(w, h),
    px = image.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = (x - w / 2) / w,
        ny = (y - h / 2) / h;
      const light = 20 * Math.exp(-18 * (nx * nx + ny * ny));
      const tone = 47 + light + random() * 9 + 2 * Math.sin(x * 0.025 + y * 0.056) + 0.9 * Math.sin(y * 0.11);
      const i = 4 * (y * w + x);
      px[i] = tone;
      px[i + 1] = tone + 3;
      px[i + 2] = tone + 2;
      px[i + 3] = 255;
    }
  c.putImageData(image, 0, 0);
  for (let i = 0; i <= 8; i++) {
    const p = (i * w) / 8 + w * 0.035;
    c.fillStyle = '#181e1e93';
    c.fillRect(p, 0, 1.3, h);
    c.fillRect(0, p, w, 1.3);
    c.fillStyle = '#a1a7a635';
    c.fillRect(p + 1.5, 0, 1, h);
    c.fillRect(0, p + 1.5, w, 1);
  }
  const m = w / 24;
  c.save();
  c.translate(w / 2, h / 2);
  c.scale(m, m);
  c.strokeStyle = 'rgba(205,207,187,.65)';
  c.lineWidth = 0.032;
  for (const side of [-1, 1])
    for (const end of [-1, 1]) {
      c.beginPath();
      c.moveTo(side * 1.59, end * 2.25);
      c.lineTo(side * 1.59, end * 2.93);
      c.lineTo(side * 1.12, end * 2.93);
      c.stroke();
    }
  c.strokeStyle = 'rgba(237,110,67,.7)';
  c.lineWidth = 0.048;
  for (const side of [-1, 1]) {
    c.beginPath();
    c.moveTo(side * 1.65, -2.93);
    c.lineTo(side * 1.65, -2.38);
    c.stroke();
  }
  // Ambient occlusion underneath the floorpan: rounded rectangular, not a disc.
  c.save();
  c.scale(1.38, 2.55);
  const ao = c.createRadialGradient(0, 0, 0.26, 0, 0, 1);
  ao.addColorStop(0, '#090b0af2');
  ao.addColorStop(0.65, '#0c100ee0');
  ao.addColorStop(0.85, '#12171483');
  ao.addColorStop(1, '#19201c00');
  c.fillStyle = ao;
  c.fillRect(-1, -1, 2, 2);
  c.restore();
  c.restore();
};

const wallPaint: Painter = (c, w, h) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#323a3a');
  g.addColorStop(0.58, '#48504c');
  g.addColorStop(1, '#272e2c');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  for (let j = 0; j < 4; j++) {
    const x = w * (0.05 + j * 0.24);
    const pool = c.createRadialGradient(x + 55, 12, 7, x + 50, 50, 240);
    pool.addColorStop(0, '#d6d7bd3a');
    pool.addColorStop(1, '#d6d7bd00');
    c.fillStyle = pool;
    c.fillRect(x - 190, 0, 485, 320);
  }
  for (let n = 0; n < 9; n++) {
    const x = w * (0.16 + 0.044 * n);
    c.fillStyle = n === 2 ? '#9e5441' : '#657269';
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x + 14, 0);
    c.lineTo(x - 155, h);
    c.lineTo(x - 170, h);
    c.closePath();
    c.fill();
  }
  c.fillStyle = '#a3afa0';
  c.font = 'italic 900 200px sans-serif';
  c.fillText('01', w * 0.64, h * 0.68);
  c.fillStyle = '#aeb8aa';
  c.font = 'bold 20px monospace';
  c.fillText('COMPETITION  /  BAY', w * 0.655, h * 0.78);
  c.fillStyle = '#b8694f';
  c.fillRect(w * 0.656, h * 0.83, 88, 5);
  for (let i = 0; i <= 12; i++) {
    const x = (i * w) / 12;
    c.fillStyle = '#192322';
    c.fillRect(x, 0, 2, h);
    c.fillStyle = '#acb6a338';
    c.fillRect(x + 2, 0, 1, h);
    for (let y = 16; y < h; y += 112) {
      c.fillStyle = '#89948b';
      c.fillRect(x + 6, y, 3, 3);
      c.fillStyle = '#1a211f';
      c.fillRect(x + 7, y + 1, 2, 2);
    }
  }
};

const screenPaint: Painter = (c, w, h) => {
  c.fillStyle = '#132323';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#cbdfca';
  c.font = 'bold 18px monospace';
  c.fillText('AX   /   TELEMETRY', 18, 28);
  c.lineWidth = 1;
  c.strokeStyle = '#344844';
  c.beginPath();
  for (let i = 0; i < 12; i++) {
    c.moveTo(i * 24, 49);
    c.lineTo(i * 24, h - 12);
  }
  for (let i = 0; i < 5; i++) {
    c.moveTo(8, i * 19 + 50);
    c.lineTo(w - 6, i * 19 + 50);
  }
  c.stroke();
  for (let t = 0; t < 3; t++) {
    c.beginPath();
    c.strokeStyle = ['#c2664c', '#9ec0ae', '#c8b88c'][t];
    c.lineWidth = 2;
    for (let x = 11; x < w - 11; x += 2) {
      const y = 70 + t * 19 + 7 * Math.sin(x * 0.075 + t) + 5 * Math.cos(x * 0.162 + t * 0.4);
      if (x === 11) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
};

/** Pit in metres. Garage and circuit are mutually exclusive. Keep the parked
 * car at the origin so millimetre-deep markings retain their depth precision. */
export function buildShowroom(scene: Scene): TransformNode {
  const root = new TransformNode('garage.bay01', scene),
    batches = new Map<PBRMaterial, Mesh[]>();
  const material = (name: string, color: string, roughness: number, metallic: number, emission = 0) => {
    const m = new PBRMaterial('garage.' + name, scene);
    m.albedoColor = Color3.FromHexString(color).toLinearSpace();
    m.roughness = roughness;
    m.metallic = metallic;
    if (emission) m.emissiveColor = Color3.FromHexString(color).toLinearSpace().scale(emission);
    return m;
  };
  const wall = material('powder-coated shell', '#454e49', 0.7, 0.18),
    rail = material('galvanized rail', '#87918c', 0.34, 0.72),
    graphite = material('carbon frame', '#262d2c', 0.53, 0.48),
    rubber = material('slick rubber', '#232625', 0.81, 0.04),
    lip = material('signal enamel', '#e76640', 0.44, 0.26),
    soft = material('warm strip', '#fff1d3', 0.27, 0.02, 2.7);
  function texture(
    name: string,
    w: number,
    h: number,
    paint: Painter,
    roughness: number,
    metallic: number,
    emissive = 0,
  ) {
    const tex = new DynamicTexture('garage.' + name, { width: w, height: h }, scene, true);
    paint(tex.getContext() as unknown as CanvasRenderingContext2D, w, h);
    tex.update(true);
    tex.anisotropicFilteringLevel = 4;
    const m = material(name, '#ffffff', roughness, metallic);
    m.albedoTexture = tex;
    if (emissive) {
      m.emissiveTexture = tex;
      m.emissiveColor = new Color3(emissive, emissive, emissive);
    }
    return m;
  }
  function part(mesh: Mesh, m: PBRMaterial, x: number, y: number, z: number) {
    mesh.material = m;
    mesh.position.set(x, y, z);
    mesh.isPickable = false;
    let group = batches.get(m);
    if (!group) batches.set(m, (group = []));
    group.push(mesh);
    return mesh;
  }
  function box(n: string, x: number, y: number, z: number, w: number, h: number, d: number, m: PBRMaterial) {
    return part(CreateBox('garage.' + n, { width: w, height: h, depth: d }, scene), m, x, y, z);
  }
  function face(n: string, x: number, y: number, z: number, w: number, h: number, m: PBRMaterial) {
    const p = part(CreatePlane('garage.' + n, { width: w, height: h }, scene), m, x, y, z);
    p.rotation.y = Math.PI;
    return p;
  }
  const slab = texture('resin inspection floor', 1024, 1024, floorPaint, 0.44, 0.14);
  // Polished factory paddock epoxy clearcoat reflection on the Bay 01 floor
  slab.clearCoat.isEnabled = true;
  slab.clearCoat.intensity = 0.48;
  slab.clearCoat.roughness = 0.14;
  part(CreateGround('garage.floor', { width: 24, height: 24 }, scene), slab, 0, -0.006, 0);
  const facade = texture('anodised wall mural', 2048, 512, wallPaint, 0.66, 0.23);
  face('rear wall cladding', 0, 3.2, -6.8, 25.6, 6.4, facade);
  box('service wall', 9.8, 3.2, 0, 0.21, 6.4, 15, wall);
  face('service wall cladding', 9.68, 3.2, 0, 15, 6.4, facade).rotation.y = Math.PI / 2;
  box('service wall skirting', 9.65, 0.2, 0, 0.16, 0.4, 15, graphite);
  box('service wall rub rail', 9.63, 0.86, 0, 0.12, 0.047, 15, rail);
  box('ceiling', 0, 6.54, -0.3, 25, 0.22, 18, graphite);
  box('kickplate', 0, 0.21, -6.68, 25.4, 0.42, 0.14, graphite);
  box('wall joint', 0, 2.02, -6.68, 25.4, 0.045, 0.16, rail);
  for (const x of [-11.4, -6.4, -1.4, 3.6, 8.6]) {
    box('portal web', x, 3.17, -6.58, 0.18, 6.34, 0.31, graphite);
    box('portal flange', x, 3.17, -6.36, 0.34, 6.34, 0.09, rail);
    box('truss chord', x, 6.21, -0.6, 0.22, 0.36, 12.2, graphite);
    box('fixture housing', x + 2.35, 5.74, -6.41, 3.45, 0.17, 0.37, graphite);
    box('wall washer', x + 2.35, 5.68, -6.19, 3.26, 0.062, 0.05, soft);
  }
  for (const z of [-4.8, 0.8, 4.3]) {
    box('overhead extrusion', 0, 5.84, z, 15.5, 0.11, 0.28, rail);
    box('overhead diffuser', 0, 5.77, z, 15.24, 0.05, 0.2, soft);
  }
  // A ribbed shutter and high clerestory live across the adjacent bay.
  box('shutter surround', 7.05, 2.21, -6.49, 5.25, 4.42, 0.3, graphite);
  for (let i = 0; i < 25; i++) box('shutter slat', 7.05, 0.105 + i * 0.157, -6.28, 4.92, 0.138, 0.11, wall);
  box('shutter lintel', 7.05, 4.16, -6.2, 5.32, 0.29, 0.42, rail);
  for (let i = 0; i < 5; i++) {
    box('clerestory mullion', 9.61, 4.17, -5.6 + i * 2.7, 0.23, 2.2, 0.13, rail);
    box('clerestory glazing', 9.64, 4.35, -4.3 + i * 2.7, 0.095, 1.16, 2.52, graphite);
    box('clerestory light', 9.54, 4.76, -4.3 + i * 2.7, 0.045, 0.055, 2.39, soft);
  }
  // Pit equipment: a roll cab, laminate workbench, monitor and mounted tyres.
  const stationX = -0.02;
  for (const x of [-1.7, 0.02, 1.74]) {
    box('tool cab', stationX + x, 0.58, -5.96, 1.64, 0.94, 0.72, graphite);
    for (let i = 0; i < 5; i++) {
      box('drawer', stationX + x, 0.225 + i * 0.165, -5.56, 1.54, 0.143, 0.065, wall);
      box('drawer handle', stationX + x, 0.259 + i * 0.165, -5.51, 1.28, 0.026, 0.048, rail);
    }
    for (const sx of [-0.59, 0.59]) box('caster', stationX + x + sx, 0.083, -5.67, 0.13, 0.16, 0.13, rubber);
  }
  box('worktop', stationX, 1.092, -5.96, 5.28, 0.085, 0.91, rail);
  box('rear tool rail', stationX, 1.56, -6.55, 5.38, 0.055, 0.1, lip);
  const display = texture('live diagnostic monitors', 256, 128, screenPaint, 0.36, 0.08, 0.4);
  for (const x of [-0.8, 0.69]) {
    box('monitor arm', x, 1.38, -6.11, 0.095, 0.52, 0.07, rail);
    box('monitor frame', x, 1.68, -6.06, 1.38, 0.73, 0.09, graphite);
    face('monitor face', x, 1.68, -6.004, 1.3, 0.65, display);
  }
  const rackX = 8.1,
    rackZ = -4.67;
  for (const x of [-1.17, 1.17])
    for (const z of [-0.36, 0.36])
      box('tyre rack upright', rackX + x, 0.59, rackZ + z, 0.05, 1.18, 0.05, rail);
  for (const z of [-0.24, 0.24]) box('cradle rail', rackX, 0.27, rackZ + z, 2.44, 0.07, 0.07, graphite);
  const section = [
    [0.239, -0.132],
    [0.262, -0.166],
    [0.327, -0.165],
    [0.349, -0.128],
    [0.354, -0.1],
    [0.354, 0.1],
    [0.348, 0.13],
    [0.327, 0.163],
    [0.264, 0.165],
    [0.239, 0.13],
    [0.239, -0.132],
  ].map(([x, y]) => new Vector3(x, y, 0));
  for (let i = 0; i < 5; i++) {
    const slick = part(
      CreateLathe(
        'garage.racing slick',
        { shape: section, tessellation: 36, sideOrientation: Mesh.DOUBLESIDE },
        scene,
      ),
      rubber,
      rackX - 0.87 + i * 0.39,
      0.57,
      rackZ,
    );
    slick.rotation.z = Math.PI / 2;
  }
  // Overhead steel vent and conduits run along the back of the building.
  for (const [y, diam] of [
    [4.96, 0.36],
    [4.54, 0.09],
  ]) {
    const pipe = part(
      CreateCylinder('garage.service duct', { height: 24, diameter: diam, tessellation: 18 }, scene),
      rail,
      0,
      y,
      -6.09,
    );
    pipe.rotation.z = Math.PI / 2;
    for (let x = -10; x <= 10; x += 2.5) {
      const ring = part(
        CreateCylinder(
          'garage.duct band',
          { height: 0.045, diameter: diam + 0.025, tessellation: 18 },
          scene,
        ),
        graphite,
        x,
        y,
        -6.09,
      );
      ring.rotation.z = Math.PI / 2;
    }
  }
  for (const [m, pieces] of batches) {
    const mesh = pieces.length === 1 ? pieces[0] : Mesh.MergeMeshes(pieces, true, true)!;
    mesh.parent = root;
    mesh.name = m.name;
    mesh.isPickable = false;
    mesh.receiveShadows = m === slab;
  }
  // Hydrate real Poly Haven CC0 photogrammetry workshop hardware into Bay 01 cleanly
  // Framed cleanly along the bay perimeter so the GT3 rear wing & cabin silhouette stay unobstructed
  const propSpecs: readonly [string, [number, number, number], number, number][] = [
    ['tool_cart', [4.2, 0, -5.55], -0.25, 0.95],
    ['tool_chest', [-4.65, 0, -5.35], 0.18, 1.0],
    ['parts_cart', [5.95, 0, -5.35], -0.15, 0.92],
    ['toolbox', [-2.25, 0, -5.25], 0.35, 1.0],
    ['fuel_drum', [8.45, 0, -3.25], 0.9, 0.95],
    ['fuel_drum', [8.65, 0, -2.35], 2.1, 0.95],
    ['air_rig', [-3.35, 0, -4.85], 0.52, 1.05],
  ];
  const baseAsset = (rel: string) =>
    new URL(`${import.meta.env.BASE_URL}assets/${rel}`, window.location.href).href;
  void Promise.all(
    propSpecs.map(async ([name, pos, yaw, sc], idx) => {
      try {
        const res = await fetch(baseAsset(`props/${name}.glb`));
        if (!res.ok || root.isDisposed() || scene.isDisposed) return;
        const container = await LoadAssetContainerAsync(new Uint8Array(await res.arrayBuffer()), scene, {
          name: `garage.${name}.${idx}.glb`,
          pluginExtension: '.glb',
        });
        if (root.isDisposed() || scene.isDisposed) {
          container.dispose();
          return;
        }
        const holder = new TransformNode(`garage.prop.${name}.${idx}`, scene);
        holder.parent = root;
        holder.position.set(pos[0], pos[1], pos[2]);
        holder.rotation.y = yaw;
        holder.scaling.setAll(sc);
        container.addAllToScene();
        for (const n of container.rootNodes) n.parent = holder;
        for (const m of container.meshes) {
          m.name = `garage.prop.${name}.${idx}.${m.name}`;
          m.isPickable = false;
          m.receiveShadows = true;
          m.metadata = { noShadowCaster: true };
          if (m.material instanceof PBRMaterial) {
            m.material.maxSimultaneousLights = 3;
            for (const t of m.material.getActiveTextures()) {
              if (t instanceof Texture) t.anisotropicFilteringLevel = 8;
            }
          }
        }
      } catch {
        // Non-blocking decorative workshop props
      }
    }),
  );

  // Only these very short-range practicals belong to the set; the scene's sky,
  // IBL, sun, exposure, and post chain remain the engine's responsibility.
  for (const [n, x, y, z, power, color] of [
    ['key', -3.4, 4.25, 2.6, 42, '#ffe9d3'],
    ['rim', 2.65, 3.4, -2.6, 34, '#dde9ff'],
  ] as const) {
    const light = new PointLight(`garage.softbox.${n}`, new Vector3(x, y, z), scene);
    light.parent = root;
    light.range = 14;
    light.radius = 0.85;
    light.diffuse = Color3.FromHexString(color);
    light.intensity = power;
  }
  return root;
}

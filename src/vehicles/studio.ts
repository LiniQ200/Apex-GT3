import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Node } from '@babylonjs/core/node';
import type { Settings } from '../types';
import '@babylonjs/loaders/glTF/glTFFileLoader';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_draco_mesh_compression';

export const corners = ['FL', 'FR', 'RL', 'RR'] as const;
export type Slot =
  | 'paint'
  | 'trim'
  | 'metal'
  | 'glass'
  | 'headlight'
  | 'taillight'
  | 'tire'
  | 'rim'
  | 'rotor'
  | 'caliper'
  | 'badge'
  | 'panel';
type Chassis = Settings['chassis'];
type Joint = 'body' | 'column' | 'spin' | 'steer';
interface Part {
  joint: Joint;
  slot: Slot;
  wheel: number;
}
interface Source extends Part {
  name: string;
  pos: Float32Array;
  normal: Float32Array;
  ids: ArrayLike<number>;
}
interface TemplatePart extends Part {
  mesh: Mesh;
  far: Mesh;
}
export interface Studio {
  source: Chassis;
  hubs: Vector3[];
  radii: number[];
  column: Vector3;
  columnAxis: Vector3;
  deck: number;
  flank: number;
  parts: TemplatePart[];
}

// These are node / parent names from the GLB JSON rig report. In particular,
// Ferrari's *brakes* are tail lamps, whereas its four *brake* children are discs.
// The Concept's tires have unnamed nodes and its brake pads share wheel parents.
function classify(mesh: Mesh, concept: boolean): Part {
  const n = mesh.name.replace(/_primitive\d+$/, '');
  let wheel = -1,
    column = false;
  for (let p: Node | null = mesh; p; p = p.parent) {
    const w = concept
      ? ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR']
      : ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
    const k = w.indexOf(p.name);
    if (k !== -1) wheel = k;
    if (p.name === (concept ? 'InteriorSteeringCylinder' : 'steering_wheel')) column = true;
  }
  if (wheel !== -1) {
    const slot: Slot = /BrakePad/.test(n)
      ? 'caliper'
      : /BrakeDisc|^brake$/.test(n)
        ? 'rotor'
        : /^(node\d+|tire)$/.test(n)
          ? 'tire'
          : 'rim';
    return { wheel, slot, joint: slot === 'caliper' ? 'steer' : 'spin' };
  }
  const joint = column ? 'column' : 'body';
  let slot: Slot = 'trim';
  if (concept) {
    if (
      /^(BodyRoofPanel|BodyRearPanelsColor1|BodyHood|BodyPillars|BodyPanelsColor2|BodyDoor[LR](Color[12]|MirrorColor[12]))$/.test(
        n,
      )
    )
      slot = 'paint';
    else if (/^(BodyWindshield|BodyRearwindow|BodyWindowsRearSides|BodyDoor[LR]Window)$/.test(n))
      slot = 'glass';
    else if (n === 'BodyHeadlights') slot = 'headlight';
    else if (/^(BodyTaillights|BodyTurnsignalsRear)$/.test(n)) slot = 'taillight';
    else if (/Door[LR]Mirror$|InteriorCage|SteeringWheel02|Door[LR]Handle02|^Axles$/.test(n)) slot = 'metal';
  } else {
    if (n === 'body') slot = 'paint';
    else if (n === 'glass') slot = 'glass';
    else if (/^(metal|chrome|steering_metal)$/.test(n)) slot = 'metal';
    else if (/^(lights_red|brakes|steering_red_lights)$/.test(n)) slot = 'taillight';
    else if (/^(lights|leds)$/.test(n)) slot = 'headlight';
    else if (n === 'yellow_trim' || n === 'steering_centre') slot = 'badge';
  }
  return { wheel, joint, slot };
}

class Bounds {
  min = new Vector3(Infinity, Infinity, Infinity);
  max = new Vector3(-Infinity, -Infinity, -Infinity);
  add(x: number, y: number, z: number) {
    this.min.minimizeInPlaceFromFloats(x, y, z);
    this.max.maximizeInPlaceFromFloats(x, y, z);
  }
  center() {
    return this.min.add(this.max).scaleInPlace(0.5);
  }
}

// Read referenced decoded vertices (not accessor AABBs). Apply complete import
// matrices including the LH loader root; actual L/R and front/rear are certified below.
function readSource(mesh: Mesh, part: Part, concept: boolean): Source {
  const p = mesh.getVerticesData('position')!,
    n = mesh.getVerticesData('normal')!,
    ids = mesh.getIndices()!;
  const world = mesh.computeWorldMatrix(true);
  const rot = concept ? Matrix.Identity() : Matrix.RotationY(Math.PI);
  const m = world.multiply(rot),
    nm = Matrix.Transpose(Matrix.Invert(m));
  const pos = new Float32Array(p.length),
    normal = new Float32Array(p.length),
    v = new Vector3();
  for (let i = 0; i < p.length; i += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(p[i], p[i + 1], p[i + 2], m, v);
    v.toArray(pos, i);
    Vector3.TransformNormalFromFloatsToRef(n[i], n[i + 1], n[i + 2], nm, v);
    v.normalize().toArray(normal, i);
  }
  return { ...part, name: mesh.name, pos, normal, ids };
}

function bounds(parts: Source[], test: (p: Source) => boolean) {
  const b = new Bounds();
  for (const p of parts)
    if (test(p))
      for (let i = 0; i < p.ids.length; i++) {
        const j = p.ids[i] * 3;
        b.add(p.pos[j], p.pos[j + 1], p.pos[j + 2]);
      }
  if (!Number.isFinite(b.min.x)) throw Error('Studio asset did not match the inspected rig');
  return b;
}

interface Batch extends Part {
  positions: number[];
  normals: number[];
  indices: number[];
  uvs: number[];
}
function batch(part: Part): Batch {
  return {
    joint: part.joint,
    slot: part.slot,
    wheel: part.wheel,
    positions: [],
    normals: [],
    indices: [],
    uvs: [],
  };
}

// A spatial cluster decimator runs ONCE per source, not per driver or per frame.
// Keep hard edges / UV charts separate, remove collapsed triangles, and combine
// only primitives sharing their material and independent joint. Both resulting
// LOD geometries are shared across every car using this studio chassis.
function appendLOD(b: Batch, s: Source, cell: number, distant = false) {
  const map = new Map<number, number>(),
    counts: number[] = [];
  const keepCreases = !distant || s.slot === 'paint' || s.slot === 'glass' || s.slot === 'tire';
  const base = b.positions.length / 3,
    P = s.pos,
    N = s.normal,
    extrema = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    pins = [0, 0, 0, 0, 0, 0],
    charts: number[] = [];
  const remap = new Int32Array(P.length);
  remap.fill(-1); // three chart IDs per vertex
  const add = (id: number, chart: number) => {
    const i = id * 3,
      r = i + chart;
    if (remap[r] >= 0) return remap[r];
    const x = P[i],
      y = P[i + 1],
      z = P[i + 2],
      nx = N[i],
      ny = N[i + 1],
      nz = N[i + 2];
    // Keep opposite faces of thin outer panels apart. On distant mechanical
    // details, subpixel bevels can collapse into the same vertex.
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    const face = !keepCreases
      ? 0
      : ax > ay && ax > az
        ? nx > 0
          ? 0
          : 1
        : ay > az
          ? ny > 0
            ? 2
            : 3
          : nz > 0
            ? 4
            : 5;
    const key =
      (((Math.round(x / cell) + 320) * 641 + Math.round(y / cell) + 320) * 641 + Math.round(z / cell) + 320) *
        18 +
      chart * 6 +
      face;
    let j = map.get(key);
    if (j === undefined) {
      j = b.positions.length / 3;
      map.set(key, j);
      counts.push(1);
      charts.push(chart);
      b.positions.push(x, y, z);
      b.normals.push(nx, ny, nz);
    } else {
      const k = j * 3,
        c = ++counts[j - base]; // online average for positions; normals normalized at finish
      b.positions[k] += (x - b.positions[k]) / c;
      b.positions[k + 1] += (y - b.positions[k + 1]) / c;
      b.positions[k + 2] += (z - b.positions[k + 2]) / c;
      b.normals[k] += nx;
      b.normals[k + 1] += ny;
      b.normals[k + 2] += nz;
    }
    for (let k = 0; k < 3; k++) {
      if (P[i + k] < extrema[k]) {
        extrema[k] = P[i + k];
        pins[k] = j * 3 + k;
      }
      if (P[i + k] > extrema[3 + k]) {
        extrema[3 + k] = P[i + k];
        pins[3 + k] = j * 3 + k;
      }
    }
    remap[r] = j;
    return j;
  };
  for (let i = 0; i < s.ids.length; i += 3) {
    const a = s.ids[i],
      c = s.ids[i + 1],
      d = s.ids[i + 2];
    let chart = 0;
    if (s.slot === 'paint') {
      const x = (P[a * 3] + P[c * 3] + P[d * 3]) / 3,
        y = (P[a * 3 + 1] + P[c * 3 + 1] + P[d * 3 + 1]) / 3;
      if (Math.abs(x) > 0.57 && y < 0.88 && Math.abs(N[a * 3] + N[c * 3] + N[d * 3]) > 0.95)
        chart = x > 0 ? 1 : 2;
    }
    const ai = add(a, chart),
      ci = add(c, chart),
      di = add(d, chart);
    if (ai !== ci && ci !== di && di !== ai) b.indices.push(ai, ci, di);
  }
  // The six extreme support planes (including each tire contact patch) and
  // therefore the measured hub centers survive reduction in both LODs.
  for (let k = 0; k < 6; k++) if (Number.isFinite(extrema[k])) b.positions[pins[k]] = extrema[k];
  for (let j = base; j < b.positions.length / 3; j++) {
    const i = j * 3,
      x = b.positions[i],
      y = b.positions[i + 1],
      z = b.positions[i + 2],
      chart = charts[j - base];
    if (s.slot === 'paint') {
      // Project AFTER reduction so the stripe and each right-reading door
      // chart stay straight even when distant vertices have been averaged.
      if (chart === 0) b.uvs.push(0.015 + 0.47 * (0.5 + x / 2.1), 0.02 + 0.96 * (0.5 - z / 4.63));
      else b.uvs.push(0.51 + 0.48 * (0.5 + (chart === 1 ? z : -z) / 4.63), 0.04 + 0.92 * (1 - y / 1.45));
    } else if (s.slot === 'rotor') b.uvs.push(0.5 + z / 0.48, 0.5 + y / 0.48);
    else b.uvs.push((z + 0.35 * y) * 2, (y + x * 0.34) * 2);
  }
}

// Clip a physical light box to the actual door skin at each LOD. Local UVs
// are independent of the paint atlas, so #28 need not duplicate a 2k #88 skin.
function doorPanels(src: Batch) {
  const out = batch({ slot: 'panel', joint: 'body', wheel: -1 }),
    p = src.positions,
    n = src.normals;
  const zl = -0.305,
    zh = 0.37,
    yl = 0.285,
    yh = 0.745;
  for (let i = 0; i < src.indices.length; i += 3) {
    const a = src.indices[i] * 3,
      b = src.indices[i + 1] * 3,
      c = src.indices[i + 2] * 3;
    const x = (p[a] + p[b] + p[c]) / 3;
    if (Math.abs(x) < 0.7) continue;
    if (
      Math.min(p[a + 2], p[b + 2], p[c + 2]) > zh ||
      Math.max(p[a + 2], p[b + 2], p[c + 2]) < zl ||
      Math.min(p[a + 1], p[b + 1], p[c + 1]) > yh ||
      Math.max(p[a + 1], p[b + 1], p[c + 1]) < yl
    )
      continue;
    let poly = [a, b, c].map((j) => {
      const l = Math.hypot(n[j], n[j + 1], n[j + 2]) || 1;
      return [p[j], p[j + 1], p[j + 2], n[j] / l, n[j + 1] / l, n[j + 2] / l];
    });
    if ((poly[0][3] + poly[1][3] + poly[2][3]) * Math.sign(x) < 0.8) continue;
    for (const [axis, limit, sign] of [
      [2, zl, 1],
      [2, zh, -1],
      [1, yl, 1],
      [1, yh, -1],
    ]) {
      const next: number[][] = [];
      for (let k = 0; k < poly.length; k++) {
        const v = poly[k],
          u = poly[(k + 1) % poly.length],
          vIn = (v[axis] - limit) * sign >= 0,
          uIn = (u[axis] - limit) * sign >= 0;
        if (vIn) next.push(v);
        if (vIn !== uIn) {
          const t = (limit - v[axis]) / (u[axis] - v[axis]);
          next.push(v.map((value, idx) => value + (u[idx] - value) * t));
        }
      }
      poly = next;
    }
    const base = out.positions.length / 3;
    for (const v of poly) {
      out.positions.push(v[0] + v[3] * 0.0025, v[1] + v[4] * 0.0025, v[2] + v[5] * 0.0025);
      out.normals.push(v[3], v[4], v[5]);
      const u = (v[2] - zl) / (zh - zl);
      out.uvs.push(x > 0 ? u : 1 - u, 1 - (v[1] - yl) / (yh - yl));
    }
    for (let k = 1; k < poly.length - 1; k++) out.indices.push(base, base + k, base + k + 1);
  }
  return out;
}

function templateMesh(scene: Scene, name: string, b: Batch) {
  const mesh = new Mesh(name, scene),
    data = new VertexData();
  for (let i = 0; i < b.normals.length; i += 3) {
    const l = Math.hypot(b.normals[i], b.normals[i + 1], b.normals[i + 2]) || 1;
    for (let k = i; k < i + 3; k++) b.normals[k] /= l;
  }
  data.positions = new Float32Array(b.positions);
  data.normals = new Float32Array(b.normals);
  data.uvs = new Float32Array(b.uvs);
  data.indices = b.positions.length / 3 > 65535 ? new Uint32Array(b.indices) : new Uint16Array(b.indices);
  data.applyToMesh(mesh);
  mesh.setEnabled(false);
  mesh.isPickable = false;
  return mesh;
}

const cache = new WeakMap<Scene, Map<Chassis, Promise<Studio>>>();
export function studio(scene: Scene, chassis: Chassis): Promise<Studio> {
  let models = cache.get(scene);
  if (!models) {
    models = new Map();
    cache.set(scene, models);
  }
  let value = models.get(chassis);
  if (!value) {
    value = load(scene, chassis).catch((e) => {
      models!.delete(chassis);
      throw e;
    });
    models.set(chassis, value);
  }
  return value;
}

async function load(scene: Scene, chassis: Chassis): Promise<Studio> {
  const name = chassis === '458' ? 'ferrari_base' : 'car_concept_base';
  const response = await fetch(`/assets/models/${name}.glb`);
  if (!response.ok) throw Error(`Studio chassis ${name} could not be loaded (HTTP ${response.status})`);
  const container = await LoadAssetContainerAsync(new Uint8Array(await response.arrayBuffer()), scene, {
    name: name + '.glb',
    pluginExtension: '.glb',
    pluginOptions: { gltf: { skipMaterials: true, createInstances: false } },
  });
  try {
    const meshes = container.meshes.filter((m): m is Mesh => m instanceof Mesh && !!m.geometry);
    const concept = meshes.some((m) => m.name === 'BodyUnderside');
    if (!concept && !meshes.some((m) => m.name === 'body')) throw Error(`Unknown studio chassis in ${name}`);
    if (chassis === 'concept' && !concept)
      console.warn(
        'CarConcept was unavailable during asset setup. Using the documented endurance conversion.',
      );
    const parts = meshes.map((m) => readSource(m, classify(m, concept), concept));
    // CarConcept is authored with its front tires turned 30 degrees. Undo only
    // this static steer about each measured axle; retain authored rim clocking.
    if (concept)
      for (let w = 0; w < 2; w++) {
        const pivot = container.transformNodes.find((n) => n.name === ['WheelFrontL', 'WheelFrontR'][w])!;
        const wm = pivot.computeWorldMatrix(true),
          e = wm.m;
        const a = Math.atan2(e[2] * Math.sign(e[0]), Math.abs(e[0])),
          si = Math.sin(a),
          co = Math.cos(a);
        const c = bounds(parts, (p) => p.wheel === w && p.joint === 'spin').center();
        for (const p of parts)
          if (p.wheel === w)
            for (let i = 0; i < p.pos.length; i += 3) {
              const x = p.pos[i] - c.x,
                z = p.pos[i + 2] - c.z,
                nx = p.normal[i],
                nz = p.normal[i + 2];
              p.pos[i] = c.x + x * co + z * si;
              p.pos[i + 2] = c.z + z * co - x * si;
              p.normal[i] = nx * co + nz * si;
              p.normal[i + 2] = nz * co - nx * si;
            }
      }
    const whole = bounds(parts, () => true),
      body = bounds(parts, (p) => p.joint === 'body'),
      center = whole.center();
    const sx = 2.04 / (whole.max.x - whole.min.x),
      sz = 4.63 / (whole.max.z - whole.min.z),
      sy = sz;
    const rawHubs = corners.map((_, k) => bounds(parts, (p) => p.wheel === k && p.joint === 'spin').center());
    const wheels = corners.map((_, k) => bounds(parts, (p) => p.wheel === k && p.slot === 'tire'));
    const radii = wheels.map((b) => (b.max.y - b.min.y) * sy * 0.5);
    const hubs = rawHubs.map(
      (v, k) => new Vector3((v.x - center.x) * sx, (v.y - wheels[k].min.y) * sy, (v.z - center.z) * sz),
    );
    const bodyY = 0.075 - body.min.y * sy;
    const pivot = [...container.transformNodes, ...meshes].find(
      (n) => n.name === (concept ? 'InteriorSteeringCylinder' : 'steering_wheel'),
    )!;
    const columnMatrix = pivot
      .computeWorldMatrix(true)
      .multiply(concept ? Matrix.Identity() : Matrix.RotationY(Math.PI));
    const col = Vector3.TransformCoordinates(Vector3.Zero(), columnMatrix),
      columnAxis = Vector3.TransformNormal(Vector3.Up(), columnMatrix);
    columnAxis.multiplyInPlace(new Vector3(sx, sy, sz)).normalize();
    if (columnAxis.z < 0) columnAxis.scaleInPlace(-1);
    const column = new Vector3((col.x - center.x) * sx, col.y * sy + bodyY, (col.z - center.z) * sz);
    let deck = 0.43,
      flank = 0.68;
    for (const p of parts)
      for (let i = 0; i < p.pos.length; i += 3) {
        const x = (p.pos[i] - center.x) * sx,
          z = (p.pos[i + 2] - center.z) * sz;
        const y = p.pos[i + 1] * sy + (p.wheel < 0 ? bodyY : -wheels[p.wheel].min.y * sy);
        if (p.slot === 'paint' && Math.abs(x) < 0.67 && Math.abs(z + 1.8) < 0.13) deck = Math.max(deck, y);
        if (p.slot === 'paint' && Math.abs(z) < 0.8 && y > 0.1 && y < 0.4)
          flank = Math.max(flank, Math.abs(x));
        const o = p.wheel >= 0 ? hubs[p.wheel] : p.joint === 'column' ? column : null;
        p.pos[i] = x - (o?.x ?? 0);
        p.pos[i + 1] = y - (o?.y ?? 0);
        p.pos[i + 2] = z - (o?.z ?? 0);
        const n = p.normal,
          nx = n[i] / sx,
          ny = n[i + 1] / sy,
          nz = n[i + 2] / sz,
          f = 1 / (Math.hypot(nx, ny, nz) || 1);
        n[i] = nx * f;
        n[i + 1] = ny * f;
        n[i + 2] = nz * f;
      }
    if (!(hubs[0].x < 0 && hubs[1].x > 0 && hubs[0].z > hubs[2].z))
      throw Error(`Wheel orientation mismatch in ${name}`);
    const groups = new Map<string, { near: Batch; far: Batch }>();
    for (const p of parts) {
      const key = `${p.joint}.${p.wheel}.${p.slot}`;
      let g = groups.get(key);
      if (!g) {
        g = { near: batch(p), far: batch(p) };
        groups.set(key, g);
      }
      const cell = p.joint === 'column' ? 0.012 : p.wheel >= 0 ? 0.024 : p.slot === 'paint' ? 0.036 : 0.037;
      appendLOD(g.near, p, cell * 0.38);
      appendLOD(g.far, p, cell * 2, true);
    }
    const paint = groups.get('body.-1.paint')!;
    groups.set('body.-1.panel', { near: doorPanels(paint.near), far: doorPanels(paint.far) });
    const built: TemplatePart[] = [];
    for (const [key, { near, far }] of groups)
      if (near.indices.length) {
        built.push({
          joint: near.joint,
          wheel: near.wheel,
          slot: near.slot,
          mesh: templateMesh(scene, name + '.' + key, near),
          far: templateMesh(scene, name + '.LOD.' + key, far),
        });
      }
    return {
      source: concept ? 'concept' : '458',
      hubs,
      radii,
      deck,
      flank,
      column,
      columnAxis,
      parts: built,
    };
  } finally {
    container.dispose();
  }
}

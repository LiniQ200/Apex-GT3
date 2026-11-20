import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Geometry } from '@babylonjs/core/Meshes/geometry';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Node } from '@babylonjs/core/node';
import { hardwareSlots } from '../materials/carFinish';
import type { Settings } from '../types';
import { aero } from './aero';
import { KitFit } from './kitFit';
import { shadowHull } from './shadowHull';
import '@babylonjs/loaders/glTF/glTFFileLoader';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_draco_mesh_compression';

export const corners = ['FL', 'FR', 'RL', 'RR'] as const;
// Pixels/metre. The close race skin keeps the original panels without the
// inspection interior. Batch wheel assemblies below ~30 pixels per tyre.
// The last two transitions widen only the emissive sample, not the chassis.
export const detailBands = [360, 72, 18, 7, 3.2] as const;
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
  | 'panel'
  | 'hardware'
  | 'carbon'
  | 'foil'
  | 'rain'
  | 'flame'
  | 'core';
type Chassis = Settings['chassis'];
type Joint = 'body' | 'column' | 'spin' | 'steer';
export interface Part {
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
  label?: string;
  levels: (Geometry | undefined)[];
}
export interface Studio {
  source: Chassis;
  fit: KitFit;
  hubs: Vector3[];
  radii: number[];
  tireWidths: number[];
  column: Vector3;
  columnAxis: Vector3;
  deck: number;
  flank: number;
  parts: TemplatePart[];
  shadow: Geometry;
  exhaustPort: Vector3;
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
// only primitives sharing a draw and joint at this detail. Reproject UVs in
// the original local frame *before* baking a wheel/column into a coarser batch.
function appendLOD(
  b: Batch,
  s: Source,
  fit: KitFit,
  cell: number,
  distant: boolean,
  offset: Vector3 | undefined,
  swatch: number,
  skinCell = 0,
) {
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
    // A near clear-coated panel exposes even a small weld across a bonnet
    // seam or fender crease. Preserve the donor's positions and split normals
    // on this skin; the two distant body tiers still use spatial reduction.
    if (s.slot === 'paint' && !distant) {
      const j = b.positions.length / 3;
      b.positions.push(x, y, z);
      b.normals.push(nx, ny, nz);
      charts.push(chart);
      remap[r] = j;
      return j;
    }
    // Keep opposite faces of thin outer panels apart. On distant mechanical
    // details, subpixel bevels can collapse into the same vertex.
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    // Some nominally interior donor meshes extend all the way to the outer
    // lamp surround. Only simplify the enclosed portion on a close car.
    const exposed =
      skinCell > 0 && (Math.abs(x) > 0.62 * fit.across || z < -0.95 * fit.along || z > 0.85 * fit.along);
    const size = exposed ? skinCell : cell;
    const face =
      !keepCreases && !exposed
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
    const voxel =
      ((Math.round(x / size) + 320) * 641 + Math.round(y / size) + 320) * 641 + Math.round(z / size) + 320;
    const key = (voxel * 18 + chart * 6 + face) * 2 + Number(exposed);
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
      if (
        Math.abs(x) > 0.57 * fit.across &&
        y < fit.height(0.88) &&
        Math.abs(N[a * 3] + N[c * 3] + N[d * 3]) > 0.95
      )
        chart = x > 0 ? 1 : 2;
    }
    const ai = add(a, chart),
      ci = add(c, chart),
      di = add(d, chart);
    if (ai !== ci && ci !== di && di !== ai) b.indices.push(ai, ci, di);
  }
  // The six extreme support planes (including each tire contact patch) and
  // therefore the measured hub centers survive reduction.
  for (let k = 0; k < 6; k++) if (Number.isFinite(extrema[k])) b.positions[pins[k]] = extrema[k];
  for (let j = base; j < b.positions.length / 3; j++) {
    const i = j * 3,
      x = b.positions[i],
      y = b.positions[i + 1],
      z = b.positions[i + 2],
      chart = charts[j - base];
    if (swatch >= 0) b.uvs.push((swatch + 0.5) / hardwareSlots.length, 0.5);
    else if (s.slot === 'paint') {
      // Project AFTER reduction so the stripe and each right-reading door
      // chart stay straight even when distant vertices have been averaged.
      if (chart === 0)
        b.uvs.push(0.015 + 0.47 * (0.5 + x / (2.1 * fit.across)), 0.02 + 0.96 * (0.5 - z / fit.length));
      else
        b.uvs.push(
          0.51 + 0.48 * (0.5 + (chart === 1 ? z : -z) / fit.length),
          0.04 + 0.92 * (1 - (y - fit.sillOffset) / (1.45 * fit.along)),
        );
    } else if (s.slot === 'rotor') b.uvs.push(0.5 + z / 0.48, 0.5 + y / 0.48);
    else b.uvs.push((z + 0.35 * y) * 2, (y + x * 0.34) * 2);
    if (offset) {
      b.positions[i] += offset.x;
      b.positions[i + 1] += offset.y;
      b.positions[i + 2] += offset.z;
    }
  }
}

// Clip a physical light box to the actual door skin at each LOD. Local UVs
// are independent of the paint atlas, so #28 need not duplicate a 2k #88 skin.
function doorPanels(src: Batch, fit: KitFit) {
  const out = batch({ slot: 'panel', joint: 'body', wheel: -1 }),
    p = src.positions,
    n = src.normals;
  const zl = -0.305 * fit.along,
    zh = 0.37 * fit.along,
    yl = fit.height(0.285),
    yh = fit.height(0.745);
  for (let i = 0; i < src.indices.length; i += 3) {
    const a = src.indices[i] * 3,
      b = src.indices[i + 1] * 3,
      c = src.indices[i + 2] * 3;
    const x = (p[a] + p[b] + p[c]) / 3;
    if (Math.abs(x) < 0.7 * fit.across) continue;
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

function geometry(scene: Scene, name: string, b: Batch) {
  const data = new VertexData();
  for (let i = 0; i < b.normals.length; i += 3) {
    const l = Math.hypot(b.normals[i], b.normals[i + 1], b.normals[i + 2]) || 1;
    for (let k = i; k < i + 3; k++) b.normals[k] /= l;
  }
  data.positions = new Float32Array(b.positions);
  data.normals = new Float32Array(b.normals);
  data.uvs = new Float32Array(b.uvs);
  data.indices = b.positions.length / 3 > 65535 ? new Uint32Array(b.indices) : new Uint16Array(b.indices);
  // No disabled template meshes in the scene's per-frame traversal. The scene
  // owns these buffers even between races, when the last rig has detached.
  const g = new Geometry(name, scene, data);
  scene.pushGeometry(g);
  return g;
}

// At long range a real LED can fall entirely between samples even when its
// car still occupies several pixels. Integrate a small rear-facing footprint
// at each donor's measured outer lens, in the *existing* brake-material draw.
// It obeys depth, backface culling, exposure and this driver's brake input.
function sampledLenses(src: Batch, source: Chassis, fit: KitFit, size: number) {
  const b = {
    ...src,
    positions: src.positions.slice(),
    normals: src.normals.slice(),
    indices: src.indices.slice(),
    uvs: src.uvs.slice(),
  };
  const [x, y, z] = source === '458' ? [0.692, 0.85, -2.099] : [0.412, 1.004, -1.971];
  const r = size * 0.5;
  for (const side of [-1, 1]) {
    const base = b.positions.length / 3;
    for (const [dx, dy] of [
      [-r, -r],
      [r, -r],
      [r, r],
      [-r, r],
    ]) {
      b.positions.push(side * x * fit.across + dx, fit.height(y) + dy, z * fit.along);
      b.normals.push(0, 0, -1);
      b.uvs.push(0.5, 0.5);
    }
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return b;
}

function buildLevels(
  scene: Scene,
  name: string,
  source: Chassis,
  fit: KitFit,
  sources: Source[],
  kit: ReturnType<typeof aero>,
  hubs: Vector3[],
  column: Vector3,
) {
  const built = new Map<string, TemplatePart>();
  // These adjoining skins must meet at precisely the same seams even at a
  // reduced render resolution. Reuse the inspection buffers on the moving
  // close car; reduce the mechanical/interior work rather than its bodywork.
  const outerSkin = (p: Part) =>
    p.joint === 'body' && ['paint', 'glass', 'panel', 'headlight', 'taillight'].includes(p.slot);
  for (let level = 0; level < 4; level++) {
    const groups = new Map<string, Batch>();
    if (level === 1) for (const part of built.values()) if (outerSkin(part)) part.levels[1] = part.levels[0];
    function destination(p: Part, label?: string) {
      const swatch =
        level === 0 || (p.slot === 'foil' && level < 3)
          ? -1
          : (hardwareSlots as readonly Slot[]).indexOf(p.slot);
      const slot = swatch < 0 ? p.slot : 'hardware';
      const bake = (level > 0 && p.joint === 'column') || (level >= 2 && p.wheel >= 0);
      const joint = bake ? 'body' : p.joint,
        wheel = bake ? -1 : p.wheel;
      const key = `${joint}.${wheel}.${slot}${label ? '.' + label : ''}`;
      let b = groups.get(key);
      if (!b) {
        b = batch({ joint, wheel, slot });
        groups.set(key, b);
        if (!built.has(key)) built.set(key, { joint, wheel, slot, label, levels: [] });
      }
      return { b, swatch, offset: bake ? (p.wheel >= 0 ? hubs[p.wheel] : column) : undefined };
    }
    for (const p of sources) {
      if (level === 1 && (outerSkin(p) || (p.joint === 'column' && p.slot === 'taillight'))) continue;
      if (
        level >= 2 &&
        (p.joint === 'column' || /Interior(Pedal|Floormat|Door|Steering)|BodyHoodInterior/.test(p.name))
      )
        continue;
      const { b, swatch, offset } = destination(p);
      const scale = p.joint === 'column' ? 0.012 : p.wheel >= 0 ? 0.024 : p.slot === 'paint' ? 0.036 : 0.037;
      const panelEdge =
        level === 1 && p.joint === 'body' && !/interior|leather|carpet|wiper|engine|axles/i.test(p.name);
      const spoke = level === 1 && p.slot === 'rim';
      const cell = scale * (panelEdge ? 0.38 : spoke ? 0.63 : [0.38, 1.55, 3.7, 8.5][level]);
      // A tail lens is much thinner than the panel it sits on. Keep luminous
      // coverage rather than letting the distant bodywork's grid collapse it.
      const lens = p.slot === 'taillight' || p.slot === 'headlight';
      const skinCell = level === 1 && !panelEdge && p.joint === 'body' ? scale * 0.38 : 0;
      appendLOD(
        b,
        p,
        fit,
        lens ? Math.min(cell, 0.04) : cell,
        level > 0 && !panelEdge && !spoke,
        offset,
        swatch,
        skinCell,
      );
    }
    const paint = groups.get('body.-1.paint');
    if (paint) {
      groups.set('body.-1.panel', doorPanels(paint, fit));
      if (!built.has('body.-1.panel'))
        built.set('body.-1.panel', { joint: 'body', wheel: -1, slot: 'panel', levels: [] });
    }
    for (const p of kit.parts) {
      if (level === 1 && outerSkin(p)) continue;
      // Keep inspection geometry (including its original transparent sort
      // units) untouched. In race LODs kit pieces join matching finish/joint draws.
      const label =
        !level || (['rain', 'foil', 'flame', 'core'].includes(p.slot) && !(level === 3 && p.slot === 'foil'))
          ? p.name
          : undefined;
      const { b, offset, swatch } = destination(p, label);
      const shape = level >= 2 && p.slot === 'rain' ? kit.rainBars : p.shape;
      const base = b.positions.length / 3;
      for (let i = 0; i < shape.p.length; i += 3) {
        b.positions.push(
          shape.p[i] + (offset?.x ?? 0),
          shape.p[i + 1] + (offset?.y ?? 0),
          shape.p[i + 2] + (offset?.z ?? 0),
        );
        b.normals.push(shape.n[i], shape.n[i + 1], shape.n[i + 2]);
        const uv = (i / 3) * 2;
        b.uvs.push(
          swatch >= 0 ? (swatch + 0.5) / hardwareSlots.length : shape.uv[uv],
          swatch >= 0 ? 0.5 : shape.uv[uv + 1],
        );
      }
      for (const index of shape.idx) b.indices.push(base + index);
      if (swatch >= 0 && (p.slot === 'carbon' || p.slot === 'foil'))
        for (let i = 0; i < shape.idx.length; i += 3)
          b.indices.push(base + shape.idx[i], base + shape.idx[i + 2], base + shape.idx[i + 1]);
    }
    for (const [key, b] of groups)
      if (b.indices.length) {
        const part = built.get(key)!;
        if (b.slot === 'taillight' && level >= 2) {
          const sizes = level === 2 ? [0.102] : [0.2, 0.39, 0.72];
          sizes.forEach((size, i) => {
            part.levels[level + i] = geometry(
              scene,
              `${name}.${level + i}.${key}`,
              sampledLenses(b, source, fit, size),
            );
          });
          continue;
        }
        // The exhaust, stencil and rain array can be identical between tiers.
        const same =
          part.label &&
          level > 0 &&
          (b.slot === 'foil' ||
            b.slot === 'flame' ||
            b.slot === 'core' ||
            (b.slot === 'rain' && level !== 2));
        part.levels[level] = same ? part.levels[level - 1] : geometry(scene, `${name}.${level}.${key}`, b);
      }
  }
  return [...built.values()];
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
    const rawHubs = corners.map((_, k) => bounds(parts, (p) => p.wheel === k && p.joint === 'spin').center());
    const wheels = corners.map((_, k) => bounds(parts, (p) => p.wheel === k && p.slot === 'tire'));
    // Both decoded GLBs are already metric. One glTF metre = one road metre
    // on every axis. Translate the whole rest pose from ONE tire tangent
    // plane: moving the body or four tires separately changes arch/seat gaps.
    const road = Math.min(...wheels.map((w) => w.min.y));
    const origin = new Vector3(center.x, road, center.z);
    const hubs = rawHubs.map((h) => h.subtract(origin));
    const radii = wheels.map((w) => (w.max.y - w.min.y) * 0.5);
    const tireWidths = wheels.map((w) => w.max.x - w.min.x);
    const fit = new KitFit(whole.max.x - whole.min.x, whole.max.z - whole.min.z, body.min.y - road);
    const pivot = [...container.transformNodes, ...meshes].find(
      (n) => n.name === (concept ? 'InteriorSteeringCylinder' : 'steering_wheel'),
    )!;
    const columnMatrix = pivot
      .computeWorldMatrix(true)
      .multiply(concept ? Matrix.Identity() : Matrix.RotationY(Math.PI));
    const column = Vector3.TransformCoordinates(Vector3.Zero(), columnMatrix).subtractInPlace(origin),
      columnAxis = Vector3.TransformNormal(Vector3.Up(), columnMatrix).normalize();
    if (columnAxis.z < 0) columnAxis.scaleInPlace(-1);
    let deck = fit.height(0.43),
      flank = 0.68 * fit.across;
    for (const p of parts)
      for (let i = 0; i < p.pos.length; i += 3) {
        const x = p.pos[i] - origin.x,
          y = p.pos[i + 1] - origin.y,
          z = p.pos[i + 2] - origin.z;
        if (
          p.slot === 'paint' &&
          Math.abs(x) < 0.67 * fit.across &&
          Math.abs(z + 1.8 * fit.along) < 0.13 * fit.along
        )
          deck = Math.max(deck, y);
        if (p.slot === 'paint' && Math.abs(z) < 0.8 * fit.along && y > fit.height(0.1) && y < fit.height(0.4))
          flank = Math.max(flank, Math.abs(x));
        const o = p.wheel >= 0 ? hubs[p.wheel] : p.joint === 'column' ? column : null;
        p.pos[i] = x - (o?.x ?? 0);
        p.pos[i + 1] = y - (o?.y ?? 0);
        p.pos[i + 2] = z - (o?.z ?? 0);
      }
    if (!(hubs[0].x < 0 && hubs[1].x > 0 && hubs[0].z > hubs[2].z))
      throw Error(`Wheel orientation mismatch in ${name}`);
    const source = concept ? 'concept' : '458',
      kit = aero({ source, fit, hubs, radii, deck, flank }, chassis === 'concept');
    const skin: ArrayLike<number>[] = parts
      .filter((p) => p.joint === 'body' && (p.slot === 'paint' || p.slot === 'glass' || p.slot === 'trim'))
      .map((p) => p.pos);
    skin.push(...kit.parts.filter((p) => p.slot === 'glass' || p.slot === 'paint').map((p) => p.shape.p));
    return {
      source,
      fit,
      hubs,
      radii,
      tireWidths,
      deck,
      flank,
      column,
      columnAxis,
      parts: buildLevels(scene, name, source, fit, parts, kit, hubs, column),
      exhaustPort: kit.exhaustPort,
      shadow: shadowHull(
        scene,
        name,
        skin,
        fit.length,
        hubs,
        radii,
        tireWidths,
        kit.parts.filter((p) => p.slot === 'carbon' || p.slot === 'foil').map((p) => p.shape),
      ),
    };
  } finally {
    container.dispose();
  }
}

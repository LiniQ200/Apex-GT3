import type { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Material } from '@babylonjs/core/Materials/material';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { carFinish } from '../materials/carFinish';
import type { Studio } from './studio';

type Point = [number, number, number];
type Pair = [number, number];
const vec = (p: Point) => new Vector3(...p);

// Loft cross sections instead of stacking boxes: every pennant, strake and
// wing support has thickness, a closed edge and a purposeful profile. Batch
// into one draw per finish; do not merge across an animated joint.
class Shell {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  face(points: Point[], inside: Vector3, uv?: Pair[]) {
    const a = vec(points[0]),
      b = vec(points[1]),
      c = vec(points[2]);
    const n = Vector3.Cross(a.subtract(b), c.subtract(b)).normalize();
    const reversed = Vector3.Dot(n, a.subtract(inside)) < 0;
    if (reversed) n.scaleInPlace(-1);
    const base = this.p.length / 3;
    for (let j = 0; j < points.length; j++) {
      const [x, y, z] = points[j];
      this.p.push(x, y, z);
      this.n.push(n.x, n.y, n.z);
      if (uv) this.uv.push(...uv[j]);
      else this.uv.push(2.3 * (x + 0.7 * z), 2.3 * (y + 0.34 * z));
    }
    // Cross(A - B, C - B) follows Babylon's left-handed vertex-normal convention.
    for (let i = 1; i < points.length - 1; i++)
      if (reversed) this.idx.push(base, base + i + 1, base + i);
      else this.idx.push(base, base + i, base + i + 1);
  }
  loft(a: Point[], b: Point[]) {
    const center = Vector3.Zero();
    for (const p of [...a, ...b]) center.addInPlaceFromFloats(...p);
    center.scaleInPlace(0.5 / a.length);
    this.face(a, center);
    this.face(b, center);
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      this.face([a[i], a[j], b[j], b[i]], center);
    }
  }
  side(x: number, thick: number, yz: Pair[]) {
    this.loft(
      yz.map(([y, z]) => [x - thick / 2, y, z]),
      yz.map(([y, z]) => [x + thick / 2, y, z]),
    );
  }
  plate(y: number, thick: number, xz: Pair[]) {
    this.loft(
      xz.map(([x, z]) => [x, y, z]),
      xz.map(([x, z]) => [x, y + thick, z]),
    );
  }
  rod(a: Point, b: Point, r: number, r2 = r, segments = 8) {
    const axis = vec(b).subtract(vec(a)).normalize(),
      up = Math.abs(axis.y) > 0.9 ? Vector3.Right() : Vector3.Up();
    const u = Vector3.Cross(axis, up).normalize(),
      v = Vector3.Cross(axis, u);
    const rings: Point[][] = [[], []];
    for (let i = 0; i < segments; i++) {
      const t = (i * 2 * Math.PI) / segments,
        dir = u.scale(Math.cos(t)).addInPlace(v.scale(Math.sin(t)));
      rings[0].push([a[0] + dir.x * r, a[1] + dir.y * r, a[2] + dir.z * r]);
      rings[1].push([b[0] + dir.x * r2, b[1] + dir.y * r2, b[2] + dir.z * r2]);
    }
    this.loft(rings[0], rings[1]);
  }
  build(scene: Scene, name: string, parent: TransformNode, mat: Material) {
    const m = new Mesh(name, scene),
      d = new VertexData();
    d.positions = this.p;
    d.indices = this.idx;
    d.uvs = this.uv;
    d.normals = this.n;
    d.applyToMesh(m);
    m.parent = parent;
    m.material = mat;
    m.isPickable = false;
    m.receiveShadows = true;
    return m;
  }
}

// The inspected Ferrari donor is an open 458 Spider. Close its cockpit at
// the actual windshield header and rear buttresses, without replacing its
// silhouette with the Concept or covering the driver's sight line.
function fixedRoof(scene: Scene, body: TransformNode, f: ReturnType<typeof carFinish>) {
  const shell = new Shell(),
    glazing = new Shell(),
    gasket = new Shell();
  // z, half-span, crown y, side drop, bow of header across the screen
  const ribs = [
    [0.225, 0.536, 1.218, 0.08, 0.033],
    [0.125, 0.55, 1.235, 0.073, 0.018],
    [-0.04, 0.561, 1.251, 0.071, 0.012],
    [-0.27, 0.568, 1.254, 0.075, 0.01],
    [-0.47, 0.558, 1.242, 0.075, 0.008],
    [-0.59, 0.547, 1.216, 0.067, 0.012],
  ];
  const sections = ribs.map(([z, w, y, drop, bow]) =>
    Array.from({ length: 17 }, (_, i): Point => {
      const t = (i - 8) / 8;
      return [w * t, y - drop * t * t, z + bow * (1 - t * t)];
    }),
  );
  const inside = new Vector3(0, 0.91, -0.17),
    atlas = (p: Point): Pair => [0.015 + 0.47 * (0.5 + p[0] / 2.1), 0.02 + 0.96 * (0.5 - p[2] / 4.63)];
  const skin = (verts: Point[]) => shell.face(verts, inside, verts.map(atlas));
  for (let k = 1; k < sections.length; k++)
    for (let j = 0; j < 16; j++)
      skin([sections[k - 1][j], sections[k - 1][j + 1], sections[k][j + 1], sections[k][j]]);
  for (const sign of [-1, 1]) {
    const j = sign < 0 ? 0 : 16;
    for (let k = 1; k < sections.length; k++) {
      const a = sections[k - 1][j],
        b = sections[k][j];
      gasket.face([a, b, [b[0], b[1] - 0.02, b[2]], [a[0], a[1] - 0.02, a[2]]], inside);
    }
    const glassTop = sections.map((row) => [row[j][0], row[j][1] - 0.016, row[j][2]] as Point);
    const sills = glassTop.map(([x, , z]): Point => [sign * (0.757 + 0.018 * z), 0.842 - 0.06 * z, z]);
    for (let k = 1; k < glassTop.length; k++)
      glazing.face([glassTop[k - 1], glassTop[k], sills[k], sills[k - 1]], inside);
    glazing.face([glassTop[0], [sign * 0.701, 0.856, 0.714], sills[0]], inside);
    skin([
      glassTop.at(-1)!,
      [sign * 0.704, 0.905, -0.57],
      [sign * 0.652, 0.934, -1.06],
      [sign * 0.543, 1.038, -1.12],
    ]);
    // A dark structural B-pillar silhouettes the shape of the race window.
    gasket.rod([sign * 0.557, 1.146, -0.485], [sign * 0.727, 0.873, -0.493], 0.016);
  }
  const rear = sections.at(-1)!;
  for (let i = 0; i < 16; i++) {
    const foot = (j: number): Point => {
      const t = (j - 8) / 8;
      return [t * 0.541, 0.957 + 0.056 * t * t, -1.26 + 0.09 * t * t];
    };
    const a = rear[i],
      b = rear[i + 1],
      c = foot(i + 1),
      d = foot(i);
    if (i < 2 || i > 13) skin([a, b, c, d]);
    else glazing.face([a, b, c, d], inside);
  }
  shell.build(scene, 'homologated fixed roof', body, f.paint);
  glazing.build(scene, 'GT3 polycarbonate side and rear glazing', body, f.glass);
  gasket.build(scene, 'roof rails and seals', body, f.trim);
}

export function aero(
  scene: Scene,
  body: TransformNode,
  s: Studio,
  f: ReturnType<typeof carFinish>,
  rainMat: Material,
  prototype: boolean,
) {
  if (s.source === '458') fixedRoof(scene, body, f);
  const carbon = new Shell(),
    metal = new Shell(),
    soot = new Shell(),
    rain = new Shell(),
    flame = new Shell(),
    core = new Shell(),
    foil = new Shell();
  const flank = Math.min(1.03, s.flank + 0.04),
    w = prototype ? 1.047 : 1.018;
  const deck = s.deck,
    wingY = deck + (prototype ? 0.365 : 0.33),
    wingZ = -1.93;
  const rear = s.hubs[2].z + s.radii[2] + 0.16,
    front = s.hubs[0].z - s.radii[0] - 0.04;
  // The 458 bumper tapers in sooner. Extend only the canards' mounting edges into its skin.
  const canardInset = s.source === '458' ? 0.09 : 0;
  // Splitter planform recedes at the corners of the rounded nose. Keep these
  // panels at homologated 75 mm clearance, above the ground shadow.
  carbon.plate(0.075, 0.035, [
    [-0.8, 1.82],
    [-0.91, 1.97],
    [-0.86, 2.13],
    [-0.62, 2.28],
    [-0.31, 2.34],
    [0.31, 2.34],
    [0.62, 2.28],
    [0.86, 2.13],
    [0.91, 1.97],
    [0.8, 1.82],
  ]);
  const profile: Pair[] = [
    [0.185, -0.015],
    [0.15, 0.004],
    [0.048, 0.012],
    [-0.111, 0.036],
    [-0.184, 0.05],
    [-0.191, 0.043],
    [-0.09, 0.008],
    [0.07, -0.019],
  ];
  const xs = [-w, -w * 0.72, 0, w * 0.72, w];
  const ring = (x: number): Point[] =>
    profile.map(([chord, dy]) => [
      x,
      wingY + dy + 0.028 * (Math.abs(x) / w) ** 2,
      wingZ + chord - 0.055 * (Math.abs(x) / w) ** 2,
    ]);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = ring(xs[i]),
      b = ring(xs[i + 1]),
      inside = new Vector3((xs[i] + xs[i + 1]) / 2, wingY, wingZ);
    for (let j = 0; j < a.length; j++) {
      const k = (j + 1) % a.length,
        points = [a[j], b[j], b[k], a[k]];
      if (j <= 3)
        foil.face(
          points,
          inside,
          points.map((p) => [
            (p[0] + w) / (2 * w),
            0.5 - (p[2] - wingZ + 0.055 * (Math.abs(p[0]) / w) ** 2) / 0.39,
          ]),
        );
      else carbon.face(points, inside);
    }
  }
  for (const side of [-1, 1]) {
    // Cranked swan neck stays wrap over the forward edge of the foil.
    carbon.side(side * 0.49, 0.046, [
      [deck - 0.1, -1.71],
      [deck + 0.01, -1.85],
      [wingY + 0.07, -1.77],
      [wingY + 0.085, -1.88],
      [wingY + 0.036, -1.99],
      [wingY + 0.015, -1.96],
      [wingY + 0.04, -1.87],
      [wingY + 0.02, -1.82],
      [deck + 0.02, -1.65],
    ]);
    carbon.side(side * w, 0.023, [
      [wingY - 0.073, wingZ + 0.12],
      [wingY + 0.083, wingZ + 0.16],
      [wingY + 0.108, wingZ + 0.06],
      [wingY + 0.112, wingZ - 0.24],
      [wingY + 0.034, wingZ - 0.27],
      [wingY - 0.04, wingZ - 0.18],
    ]);
    for (let i = 0; i < 2; i++) {
      const z = 2.0 - i * 0.09,
        y = 0.235 + i * 0.093;
      const a: Point[] = [
        [side * (0.8 - canardInset), y, z + 0.13],
        [side * 0.91, y + 0.012, z + 0.04],
        [side * 0.99, y + 0.025, z - 0.09],
        [side * 0.934, y + 0.029, z - 0.16],
        [side * (0.82 - canardInset), y + 0.012, z - 0.062],
      ];
      carbon.loft(
        a,
        a.map(([x, h, d]) => [x, h + 0.014, d]),
      );
    }
    metal.rod([side * 0.54, 0.112, 2.224], [side * 0.46, 0.283, 2.155], 0.009);
    carbon.plate(0.079, 0.046, [
      [side * (flank - 0.12), rear - 0.12],
      [side * flank, rear - 0.1],
      [side * (flank + 0.02), rear + 0.09],
      [side * (flank + 0.013), front - 0.06],
      [side * (flank - 0.036), front + 0.095],
      [side * (flank - 0.16), front],
    ]);
    const pipe: Point = [side * (flank + 0.022), 0.163, rear + 0.13],
      base: Point = [side * (flank - 0.075), 0.173, rear + 0.22];
    metal.rod(base, pipe, 0.068, 0.06, 14);
    const tip: Point = [pipe[0] + side * 0.002, pipe[1], pipe[2] - 0.002];
    soot.rod(pipe, tip, 0.047, 0.047, 14);
    const end: Point = [pipe[0] + side * 0.19, 0.145, pipe[2] - 0.19];
    flame.rod(pipe, end, 0.04, 0.002, 10);
    core.rod(
      [pipe[0] + side * 0.041, 0.162, pipe[2] - 0.033],
      [end[0] + side * 0.025, 0.146, end[2] - 0.037],
      0.03,
      0.001,
      10,
    );
  }
  for (let i = -2; i <= 2; i++)
    carbon.side(i * 0.261, 0.02, [
      [0.079, -1.67],
      [0.21, -2.27],
      [0.158, -2.33],
      [0.084, -2.22],
    ]);
  carbon.loft(
    [
      [-0.75, 0.094, -1.71],
      [0.75, 0.094, -1.71],
      [0.67, 0.232, -2.29],
      [-0.67, 0.232, -2.29],
    ],
    [
      [-0.75, 0.115, -1.71],
      [0.75, 0.115, -1.71],
      [0.67, 0.25, -2.29],
      [-0.67, 0.25, -2.29],
    ],
  );
  soot.plate(0.231, 0.078, [
    [-0.09, -2.29],
    [0.09, -2.29],
    [0.09, -2.332],
    [-0.09, -2.332],
  ]);
  for (let r = 0; r < 2; r++)
    for (let j = 0; j < 6; j++)
      rain.rod(
        [-0.067 + j * 0.027, 0.252 + r * 0.03, -2.332],
        [-0.067 + j * 0.027, 0.252 + r * 0.03, -2.339],
        0.011,
        0.011,
        8,
      );
  carbon.build(scene, 'carbon homologation kit', body, f.carbon);
  foil.build(scene, 'mainplane wordmark', body, f.foil);
  metal.build(scene, 'tie rods and side exhausts', body, f.metal);
  soot.build(scene, 'diffuser and heat shields', body, f.trim);
  rain.build(scene, 'FIA rain array', body, rainMat);
  const exhaust = [
    flame.build(scene, 'overrun flame', body, f.flame),
    core.build(scene, 'ionized core', body, f.core),
  ];
  for (const m of exhaust) m.setEnabled(false);
  return { exhaust, exhaustPort: new Vector3(flank, 0.18, rear + 0.13) };
}

export function caliper(scene: Scene, parent: TransformNode, side: number, r: number, mat: Material) {
  const shell = new Shell();
  shell.side(side * r * 0.12, 0.062, [
    [r * 0.34, -r * 0.49],
    [r * 0.41, -r * 0.39],
    [r * 0.29, -r * 0.27],
    [-r * 0.04, -r * 0.31],
    [-r * 0.13, -r * 0.53],
    [-r * 0.03, -r * 0.63],
    [r * 0.23, -r * 0.57],
  ]);
  return shell.build(scene, 'monobloc six-piston caliper', parent, mat);
}

import type { Circuit, SurfaceId, TrackPoint } from '../types';

// Back to front: the player occupies the last box, at the lap-timing seam.
export const sprintGrid = Array.from({ length: 10 }, (_, i) => ({ s: 6 * i, d: i % 2 ? 2.8 : -2.8 }));

// Pit lane geometry constants along the main straight (+d right side).
// Pit entry branches off cleanly at L-120..L-52; concrete pit wall separates
// track from pit apron at s in [L-52..L) U [0..250]; pit exit merges at 250..365.
export const PIT_WALL_D = 9.4;
export const PIT_FAST_LANE_D = 13.6;
export const PIT_BOX_D = 17.2;
export const PIT_OUTER_WALL_D = 22.0;
export const PIT_ENTRY_START_BACK = 128; // metres before lap line
export const PIT_WALL_START_BACK = 52;   // metres before lap line
export const PIT_WALL_END_S = 250;       // metres after lap line
export const PIT_EXIT_END_S = 368;       // metres after lap line
export const PIT_SPEED_LIMIT_MS = 60 / 3.6; // 60 km/h FIA pit speed limit
export const pitBoxStation = (driverId: number) => 70 + driverId * 16;

export function isInPitCorridor(s: number, d: number, length: number) {
  const inLon = s >= length - PIT_WALL_START_BACK - 8 || s <= PIT_WALL_END_S + 2;
  return inLon && d > PIT_WALL_D + 0.2;
}

export function isInPitBranch(s: number, length: number) {
  return s >= length - PIT_ENTRY_START_BACK || s <= PIT_EXIT_END_S;
}

// Survey coordinates in metres. North (+Z) is the direction of the start straight.
const survey = [
  [0, 0],
  [0, 200],
  [0, 480],
  [0, 590],
  [0, 635],
  [9, 666],
  [36, 690],
  [68, 690],
  [96, 671],
  [109, 639],
  [118, 580],
  [144, 530],
  [204, 505],
  [271, 502],
  [319, 480],
  [346, 428],
  [349, 373],
  [380, 335],
  [441, 319],
  [488, 283],
  [497, 229],
  [478, 178],
  [434, 105],
  [422, 60],
  [434, 16],
  [458, -17],
  [488, -40],
  [522, -54],
  [554, -60],
  [590, -60],
  [810, -60],
  [1010, -60],
  [1140, -60],
  [1158, -60],
  [1179, -52],
  [1209, -21],
  [1240, -15],
  [1265, -32],
  [1284, -71],
  [1309, -138],
  [1302, -219],
  [1256, -302],
  [1173, -351],
  [1070, -370],
  [874, -357],
  [535, -317],
  [263, -285],
  [130, -264],
  [65, -229],
  [23, -168],
  [3, -111],
  [0, -72],
  [0, -35],
];

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * t * (10 + t * (-15 + 6 * t));
};
const wrapped = (x: number, l: number) => (x >= 0 && x < l ? x : ((x % l) + l) % l);
const elevation = (s: number) =>
  18 * (smooth(720, 1240, s) - smooth(1400, 1990, s)) + 4.2 * (smooth(2050, 2450, s) - smooth(2720, 3220, s));
const pitWeight = (s: number, length: number) =>
  1 - smooth(450, 650, s) + smooth(length - 130, length - 85, s);

// The quintic (second-order) Catmull–Rom extension interpolates the survey and shares
// both divided-difference derivatives at each knot. Ordinary cubic Catmull–Rom only
// matches the first derivative; a discontinuity in curvature disturbs tire loads.
function spline() {
  const n = survey.length,
    chords = survey.map((p, i) => Math.hypot(p[0] - survey[(i + 1) % n][0], p[1] - survey[(i + 1) % n][1]));
  const jets = survey.map((p, i) =>
    p.map((v, j) => {
      const b = (i + n - 1) % n,
        f = (i + 1) % n,
        h = chords[b],
        k = chords[i];
      const l = (v - survey[b][j]) / h,
        r = (survey[f][j] - v) / k;
      return [(k * l + h * r) / (h + k), (2 * (r - l)) / (h + k)];
    }),
  );
  const co = survey.map((p, i) =>
    p.map((a, j) => {
      const f = (i + 1) % n,
        h = chords[i],
        b = jets[i][j][0] * h,
        c = (jets[i][j][1] * h * h) / 2;
      const q = survey[f][j] - a - b - c,
        r = jets[f][j][0] * h - b - 2 * c,
        t = jets[f][j][1] * h * h - 2 * c;
      return [a, b, c, 10 * q - 4 * r + t / 2, -15 * q + 7 * r - t, 6 * q - 3 * r + t / 2];
    }),
  );
  const val = (c: number[], t: number) => c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
  const der = (c: number[], t: number) =>
    c[1] + t * (2 * c[2] + t * (3 * c[3] + t * (4 * c[4] + t * 5 * c[5])));
  const der2 = (c: number[], t: number) => 2 * c[2] + t * (6 * c[3] + t * (12 * c[4] + t * 20 * c[5]));
  const arc = [0],
    spans: number[] = [],
    ts: number[] = [],
    dts: number[] = [];
  let length = 0;
  for (let i = 0; i < n; i++) {
    const count = Math.ceil(chords[i] * 2);
    let [x, z] = survey[i];
    for (let j = 0; j < count; j++) {
      const t = (j + 1) / count,
        nx = val(co[i][0], t),
        nz = val(co[i][1], t);
      length += Math.hypot(nx - x, nz - z);
      arc.push(length);
      spans.push(i);
      ts.push(j / count);
      dts.push(1 / count);
      x = nx;
      z = nz;
    }
  }
  const lookup = new Uint16Array(Math.ceil(length));
  let j = 0;
  for (let i = 0; i < lookup.length; i++) {
    while (arc[j + 1] <= i) j++;
    lookup[i] = j;
  }
  function index(s: number) {
    let i = lookup[Math.floor(s)];
    while (arc[i + 1] <= s && i + 1 < spans.length) i++;
    return i;
  }
  function heading(s: number) {
    s = wrapped(s, length);
    const i = index(s),
      [cx, cz] = co[spans[i]],
      t = ts[i] + (dts[i] * (s - arc[i])) / (arc[i + 1] - arc[i]);
    return Math.atan2(der(cx, t), der(cz, t));
  }
  // Superelevation transitions are engineered over a finite distance; following
  // the instantaneous curvature would put large crossfall changes under one axle.
  const banks = new Float32Array(Math.ceil(length));
  for (let i = 0; i < banks.length; i++) {
    const s = (i * length) / banks.length;
    // Blend neighbouring crossfalls over the entry ramp. A single box filter
    // still produces a sharp change of roll acceleration at its endpoints.
    for (let k = -20; k <= 20; k += 5) {
      const a = heading(s + k + 15) - heading(s + k - 15);
      banks[i] -= (0.068 / 9) * Math.tanh((68 / 30) * Math.atan2(Math.sin(a), Math.cos(a)));
    }
  }
  function at(s: number, d = 0): TrackPoint {
    s = wrapped(s, length);
    const i = index(s);
    const [cx, cz] = co[spans[i]],
      t = ts[i] + (dts[i] * (s - arc[i])) / (arc[i + 1] - arc[i]);
    const dx = der(cx, t),
      dz = der(cz, t),
      speed = Math.hypot(dx, dz);
    const kappa = (dz * der2(cx, t) - dx * der2(cz, t)) / (speed * speed * speed);
    const u = (s * banks.length) / length,
      j = Math.floor(u),
      f = u - j,
      bank = banks[j] * (1 - f) + banks[(j + 1) % banks.length] * f,
      yaw = Math.atan2(dx, dz);
    const halfWidth = 6.5 + 1.5 * pitWeight(s, length);
    return {
      s,
      x: val(cx, t) + (dz / speed) * d,
      y: elevation(s) + Math.tan(bank) * d,
      z: val(cz, t) - (dx / speed) * d,
      yaw,
      slope: (elevation(s + 0.02) - elevation(s - 0.02)) / 0.04,
      bank,
      kappa,
      halfWidth,
    };
  }
  return { length, at };
}

// Defines continuous kerb/runoff bands for *both* the road meshes and the tire model.
// Segments are long enough to carry each entry/apex/exit, not just peak curvature.
const kerbZones = [
  [600, 855],
  [860, 1540],
  [1560, 1960],
  [2350, 2730],
  [2740, 3265],
  [3970, 4245],
];
export const hasKerb = (s: number) => kerbZones.some(([a, b]) => s >= a && s < b);
export const kerbRamp = (s: number) => {
  const zone = kerbZones.find(([a, b]) => s >= a && s <= b);
  return zone ? smooth(0, 4, Math.min(s - zone[0], zone[1] - s)) : 0;
};
export const trapSide = (s: number) =>
  s >= 590 && s < 855
    ? -1
    : s >= 1595 && s < 1810
      ? 1
      : s >= 2360 && s < 2560
        ? 1
        : s >= 2650 && s < 3150
          ? -1
          : 0;
export const kerbWidth = 1.35;
export const groove = (p: TrackPoint) =>
  3.8 * Math.tanh(78 * p.kappa) + 0.56 * Math.sin(p.s * 0.0044) * Math.sin((Math.PI * p.s) / 4320) ** 2;
export function wallOffset(p: TrackPoint, side: number, length: number) {
  const pit = pitWeight(p.s, length);
  const flare = (a: number, b: number) => smooth(a - 65, a, p.s) - smooth(b, b + 65, p.s);
  // The chicane's right-hand trap is outside the first bend but inside the
  // second. Finish tapering its wall before the tight return apex.
  const outside = side === -1 ? flare(585, 825) + flare(2670, 3100) : flare(1595, 1810) + flare(2390, 2415);
  if (side === 1) {
    // Right side opens smoothly into the drivable FIA pit lane complex along the main straight.
    const pitOpen =
      smooth(length - PIT_ENTRY_START_BACK - 25, length - PIT_WALL_START_BACK - 6, p.s) +
      (1 - smooth(PIT_WALL_END_S + 8, PIT_EXIT_END_S + 16, p.s));
    const base = p.halfWidth + 8.6 + outside * 8.5 - 6.9 * pit;
    const openFrac = clamp(pitOpen);
    return base + (PIT_OUTER_WALL_D - base) * openFrac;
  }
  return p.halfWidth + 8.6 + outside * 8.5 - 2.5 * pit;
}
function surface(p: TrackPoint, d: number, length: number): SurfaceId {
  if (d > PIT_WALL_D + 0.2 && isInPitBranch(p.s, length)) return 'pit';
  const edge = Math.abs(d) - p.halfWidth;
  if (edge <= 0) {
    const distG = Math.abs(d - groove(p));
    if (distG < 1.45) return 'groove';
    if (distG > 3.6 && Math.abs(p.kappa) > 0.0025) return 'marbles';
    return 'asphalt';
  }
  if (hasKerb(p.s) && edge < kerbWidth) return 'kerb';
  return trapSide(p.s) === Math.sign(d) && edge > 2.65 ? 'gravel' : 'grass';
}

const cell = 28,
  key = (x: number, z: number) => x * 16384 + z;
function spatialIndex(samples: TrackPoint[]) {
  const bins = new Map<number, number[]>();
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i],
      b = samples[(i + 1) % samples.length];
    for (let x = Math.floor(Math.min(a.x, b.x) / cell); x <= Math.floor(Math.max(a.x, b.x) / cell); x++)
      for (let z = Math.floor(Math.min(a.z, b.z) / cell); z <= Math.floor(Math.max(a.z, b.z) / cell); z++) {
        const k = key(x, z);
        if (!bins.has(k)) bins.set(k, []);
        bins.get(k)!.push(i);
      }
  }
  return bins;
}
const orient = (a: TrackPoint, b: TrackPoint, c: TrackPoint) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
function segmentDist2(p: TrackPoint, a: TrackPoint, b: TrackPoint) {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    u = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz));
  return (p.x - a.x - u * dx) ** 2 + (p.z - a.z - u * dz) ** 2;
}
function validate(samples: TrackPoint[], bins: Map<number, number[]>, step: number) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const a = samples[i],
      b = samples[(i + 1) % n];
    if (!Number.isFinite(a.kappa) || Math.abs(a.slope) > 0.09) throw Error(`Invalid circuit grade at ${a.s}`);
    const x0 = Math.floor(a.x / cell),
      z0 = Math.floor(a.z / cell);
    for (let x = x0 - 2; x <= x0 + 2; x++)
      for (let z = z0 - 2; z <= z0 + 2; z++)
        for (const j of bins.get(key(x, z)) ?? []) {
          if (j <= i) continue;
          const gap = Math.min(j - i, n - j + i);
          if (gap <= 1) continue;
          const c = samples[j],
            d = samples[(j + 1) % n];
          if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0)
            throw Error(`Crossing at stations ${i}/${j}`);
          // A 38 m separation rule cannot apply to consecutive metres along the same
          // corner. Exclude the local +/-60 m of centreline (including at lap wrap).
          if (
            gap * step > 60 &&
            Math.min(
              segmentDist2(a, c, d),
              segmentDist2(b, c, d),
              segmentDist2(c, a, b),
              segmentDist2(d, a, b),
            ) <
              38 ** 2
          )
            throw Error(`Insufficient circuit clearance at ${i}/${j}`);
        }
  }
}

export function createCircuit(): Circuit {
  const { length, at } = spline(),
    n = Math.round(length),
    step = length / n;
  const samples = Array.from({ length: n }, (_, i) => at(i * step));
  const bins = spatialIndex(samples);
  validate(samples, bins, step);
  function nearest(x: number, z: number) {
    let best = Infinity,
      bestS = 0;
    const visit = (i: number) => {
      const a = samples[i],
        b = samples[(i + 1) % n],
        dx = b.x - a.x,
        dz = b.z - a.z,
        u = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz));
      const sq = (x - a.x - u * dx) ** 2 + (z - a.z - u * dz) ** 2;
      if (sq < best) {
        best = sq;
        bestS = (i + u) * step;
      }
    };
    const cx = Math.floor(x / cell),
      cz = Math.floor(z / cell);
    for (let a = cx - 1; a <= cx + 1; a++)
      for (let b = cz - 1; b <= cz + 1; b++) bins.get(key(a, b))?.forEach(visit);
    // Only arbitrary queries far outside the physical barriers need a global search.
    if (best > cell * cell) for (let i = 0; i < n; i++) visit(i);
    let p = at(bestS);
    // Project the 1 m chord estimate back onto the analytic spline. A second
    // Newton step matters at a tightly curved apex on the far edge of the runoff.
    for (let j = 0; j < 2; j++) {
      const rx = x - p.x,
        rz = z - p.z,
        sn = Math.sin(p.yaw),
        cs = Math.cos(p.yaw),
        lat = rx * cs - rz * sn,
        correction = (rx * sn + rz * cs) / (1 - lat * p.kappa);
      if (!Number.isFinite(correction) || Math.abs(correction) < 1e-6) break;
      p = at(p.s + Math.max(-step, Math.min(step, correction)));
    }
    const d = (x - p.x) * Math.cos(p.yaw) - (z - p.z) * Math.sin(p.yaw);
    return { s: p.s, d, surface: surface(p, d, length) };
  }
  return { length, samples, at, nearest };
}

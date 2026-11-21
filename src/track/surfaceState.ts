import type { Circuit, Driver, Weather } from '../types';
import { groove } from './circuit';

export const STATE_SECTORS = 256;
export const STATE_LANES = 16;

export interface SurfaceSample {
  wetness: number;        // 0..1 standing/pore moisture
  rubberGrip: number;     // 0..1 vulcanized rubber buildup
  dryingGroove: number;   // 0..1 displaced water along active wheel tracks
  marbles: number;        // 0..1 off-line rubber debris
}

export const weatherSurfaceTempC: Record<Weather, number> = {
  clear: 38,
  golden: 27,
  dusk: 21,
  damp: 17,
  rain: 12,
};

export const weatherBaseWetness: Record<Weather, number> = {
  clear: 0.0,
  golden: 0.0,
  dusk: 0.0,
  damp: 0.46,
  rain: 0.88,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Live per-sector x lateral-lane Track Surface State Grid shared by BOTH
 * the 120 Hz Jolt/Pacejka physics solver and the GPU porous asphalt shader.
 *
 * Texture layout: width = STATE_LANES (u across road width), height = STATE_SECTORS (v along lap).
 * RGBA bytes:
 *   R = wetness (0..255)
 *   G = rubberGrip (0..255)
 *   B = dryingGroove (0..255)
 *   A = offLineMarbles (0..255)
 */
export class TrackSurfaceGrid {
  readonly width = STATE_LANES;
  readonly height = STATE_SECTORS;
  readonly wetness = new Float32Array(STATE_SECTORS * STATE_LANES);
  readonly rubber = new Float32Array(STATE_SECTORS * STATE_LANES);
  readonly drying = new Float32Array(STATE_SECTORS * STATE_LANES);
  readonly marbles = new Float32Array(STATE_SECTORS * STATE_LANES);
  readonly rgba = new Uint8Array(STATE_SECTORS * STATE_LANES * 4);
  private readonly camberLow = new Float32Array(STATE_SECTORS * STATE_LANES);
  private readonly circuit: Circuit;
  private weather: Weather = 'golden';
  private dirty = true;
  private meanWetness = 0;

  constructor(circuit: Circuit) {
    this.circuit = circuit;
    this.seedBaseline();
  }

  private idx(sec: number, lane: number) {
    const s = ((sec % STATE_SECTORS) + STATE_SECTORS) % STATE_SECTORS;
    const l = lane < 0 ? 0 : lane >= STATE_LANES ? STATE_LANES - 1 : lane;
    return s * STATE_LANES + l;
  }

  private seedBaseline() {
    for (let s = 0; s < STATE_SECTORS; s++) {
      const station = ((s + 0.5) / STATE_SECTORS) * this.circuit.length;
      const p = this.circuit.at(station);
      const g = groove(p);
      // Heavy braking zones receive extra baseline rubber buildup
      const braking = [665, 1640, 2450, 2810].some((b) => Math.abs(station - b) < 95) ? 0.22 : 0;
      for (let l = 0; l < STATE_LANES; l++) {
        const u = (l + 0.5) / STATE_LANES;
        const d = (2 * u - 1) * p.halfWidth;
        const distG = Math.abs(d - g);
        const onLine = Math.exp(-(distG * distG) / 3.8);
        const offLine = clamp01((distG - 2.3) / 3.2);
        const i = s * STATE_LANES + l;
        this.rubber[i] = clamp01(0.18 + 0.54 * onLine + braking * onLine);
        this.marbles[i] = clamp01(0.08 + 0.34 * offLine);
        // Low-lying camber side holds extra standing water during rain
        this.camberLow[i] = clamp01(0.5 - p.bank * d * 0.65);
        this.wetness[i] = 0;
        this.drying[i] = 0;
      }
    }
    this.syncBytes();
  }

  setWeather(w: Weather) {
    this.weather = w;
    const target = weatherBaseWetness[w];
    let sum = 0;
    for (let i = 0; i < this.wetness.length; i++) {
      // Standing water pools slightly deeper on the low camber side and edges
      const lowBonus = target > 0 ? (this.camberLow[i] - 0.5) * 0.16 : 0;
      const grooveClear = target > 0 ? this.rubber[i] * (w === 'damp' ? 0.16 : 0.08) : 0;
      const val = clamp01(target + lowBonus - grooveClear);
      this.wetness[i] = val;
      this.drying[i] = w === 'damp' ? clamp01(this.rubber[i] * 0.45) : w === 'rain' ? clamp01(this.rubber[i] * 0.22) : 0;
      sum += val;
    }
    this.meanWetness = sum / this.wetness.length;
    this.dirty = true;
  }

  reset(w: Weather) {
    this.seedBaseline();
    this.setWeather(w);
  }

  getMeanWetness() {
    return this.meanWetness;
  }

  getSurfaceTempC() {
    return weatherSurfaceTempC[this.weather];
  }

  /** Zero-allocation O(1) bilinear lookup for 120 Hz physics per wheel. */
  sampleToRef(s: number, d: number, halfWidth: number, out: SurfaceSample): SurfaceSample {
    const v = (((s % this.circuit.length) + this.circuit.length) % this.circuit.length) / this.circuit.length;
    const u = clamp01(0.5 + d / (2 * Math.max(4, halfWidth)));
    const sf = v * STATE_SECTORS - 0.5;
    const lf = u * STATE_LANES - 0.5;
    const s0 = Math.floor(sf);
    const l0 = Math.floor(lf);
    const fs = sf - s0;
    const fl = lf - l0;
    const i00 = this.idx(s0, l0);
    const i10 = this.idx(s0, l0 + 1);
    const i01 = this.idx(s0 + 1, l0);
    const i11 = this.idx(s0 + 1, l0 + 1);
    const w00 = (1 - fl) * (1 - fs),
      w10 = fl * (1 - fs),
      w01 = (1 - fl) * fs,
      w11 = fl * fs;
    out.wetness = this.wetness[i00] * w00 + this.wetness[i10] * w10 + this.wetness[i01] * w01 + this.wetness[i11] * w11;
    out.rubberGrip = this.rubber[i00] * w00 + this.rubber[i10] * w10 + this.rubber[i01] * w01 + this.rubber[i11] * w11;
    out.dryingGroove = this.drying[i00] * w00 + this.drying[i10] * w10 + this.drying[i01] * w01 + this.drying[i11] * w11;
    out.marbles = this.marbles[i00] * w00 + this.marbles[i10] * w10 + this.marbles[i01] * w01 + this.marbles[i11] * w11;
    return out;
  }

  sample(s: number, d: number, halfWidth: number): SurfaceSample {
    return this.sampleToRef(s, d, halfWidth, { wetness: 0, rubberGrip: 0, dryingGroove: 0, marbles: 0 });
  }

  /**
   * Called each physics tick for all active cars to evolve rubbering-in,
   * off-line marble shedding, and dynamic drying wheel tracks in real time.
   */
  evolve(drivers: readonly Driver[], dt: number) {
    const wetMode = this.weather === 'damp' || this.weather === 'rain';
    const targetWet = weatherBaseWetness[this.weather];

    for (const d of drivers) {
      if (d.speed < 2.5 || d.pitState !== 'track') continue;
      const p = this.circuit.at(d.s);
      if (Math.abs(d.d) > p.halfWidth + 0.5) continue;
      const sec = Math.floor((((d.s % this.circuit.length) + this.circuit.length) % this.circuit.length) / this.circuit.length * STATE_SECTORS) % STATE_SECTORS;
      const speedFactor = Math.min(1, d.speed / 65);
      // Left and right tire tracks (~ +/- 0.88 m from chassis centerline)
      for (const trackOffset of [-0.88, 0.88]) {
        const u = clamp01(0.5 + (d.d + trackOffset) / (2 * p.halfWidth));
        const lane = Math.min(STATE_LANES - 1, Math.floor(u * STATE_LANES));
        const i = sec * STATE_LANES + lane;
        if (wetMode) {
          // Tires evacuate standing water along their tracks, carving a visibly lighter drying groove
          const pump = dt * (0.28 + 0.45 * speedFactor) * (d.compound === 'wet' ? 1.35 : 0.85);
          this.drying[i] = clamp01(this.drying[i] + pump);
          this.wetness[i] = clamp01(this.wetness[i] - pump * (this.weather === 'damp' ? 0.55 : 0.30));
          // Slight rubber wash-off in heavy rain
          if (this.weather === 'rain') this.rubber[i] = clamp01(this.rubber[i] - dt * 0.012);
        } else {
          // Dry/Golden: lay down vulcanized rubber along the driven line & shed marbles outside
          const load = 0.035 + 0.12 * (Math.abs(d.slip) + d.brake * 0.6);
          this.rubber[i] = clamp01(this.rubber[i] + dt * load * speedFactor);
          this.marbles[i] = clamp01(this.marbles[i] - dt * 0.08 * speedFactor);
          // Shed marbles to adjacent outer lanes
          const outer = lane + (trackOffset > 0 ? 2 : -2);
          if (outer >= 0 && outer < STATE_LANES) {
            const j = sec * STATE_LANES + outer;
            this.marbles[j] = clamp01(this.marbles[j] + dt * 0.015 * speedFactor);
          }
        }
      }
    }

    // Ambient rainfall replenishment / solar evaporation
    let sum = 0;
    const rate = this.weather === 'rain' ? 0.045 : this.weather === 'damp' ? 0.012 : 0.06;
    for (let i = 0; i < this.wetness.length; i++) {
      const cellTarget = clamp01(targetWet + (targetWet > 0 ? (this.camberLow[i] - 0.5) * 0.14 : 0));
      if (this.weather === 'rain') {
        // Rain slowly refills drying tracks if traffic stops
        this.wetness[i] += (cellTarget - this.wetness[i]) * dt * rate;
        this.drying[i] = Math.max(0, this.drying[i] - dt * 0.032);
      } else if (this.weather === 'damp') {
        // Damp track gradually dries along driven lines and holds moisture off-line
        this.wetness[i] += (cellTarget * (1 - 0.55 * this.drying[i]) - this.wetness[i]) * dt * rate;
      } else {
        // Dry sun evaporates remaining moisture quickly
        this.wetness[i] = Math.max(0, this.wetness[i] - dt * 0.12);
        this.drying[i] = Math.max(0, this.drying[i] - dt * 0.12);
      }
      sum += this.wetness[i];
    }
    this.meanWetness = sum / this.wetness.length;
    this.dirty = true;
  }

  /** Pack float channels into RGBA8 buffer for GPU upload when dirty. */
  syncBytes(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const n = this.wetness.length;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      this.rgba[k] = Math.round(clamp01(this.wetness[i]) * 255);
      this.rgba[k + 1] = Math.round(clamp01(this.rubber[i]) * 255);
      this.rgba[k + 2] = Math.round(clamp01(this.drying[i]) * 255);
      this.rgba[k + 3] = Math.round(clamp01(this.marbles[i]) * 255);
    }
    return true;
  }
}
